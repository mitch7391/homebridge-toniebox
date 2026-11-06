import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import net from 'node:net';
import https from 'node:https';
import { Duplex } from 'node:stream';
import { MqttClient } from 'mqtt';
import { createRequire } from 'node:module';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { formatWithOptions, inspect } from 'node:util';
import { createWebSocketStream, Receiver } from 'ws';
import mqttPacket from 'mqtt-packet';

const { Buffer, AbortController, queueMicrotask } = globalThis;
let createMqttTransport;
let createPacketGuard;
let totalAttempts = 0;
let testAttempts = 0;
const require = createRequire(import.meta.url);
const debug = require('debug');
const credentials = { uuid: 'SYNTHETIC_UUID', accessToken: 'SYNTHETIC_TOKEN' };
const routes = [{ routeId: 'SYNTHETIC_ROUTE', macAddress: 'SYNTHETIC-MAC' }];
const topic = 'external/toniebox/SYNTHETIC-MAC/volume/state';
const packet = { retain: true, qos: 1, dup: false };
before(async () => {
  const forbidden = () => {
    totalAttempts++; testAttempts++; throw new Error('Forbidden network');
  };
  mock.method(net.Socket.prototype, 'connect', forbidden);
  mock.method(globalThis, 'fetch', forbidden);
  ({ createMqttTransport, createPacketGuard } = await import('../dist/toniebox/mqttTransport.js'));
});
beforeEach(() => {
  testAttempts = 0;
});
afterEach(async () => {
  await nextTurn(); assert.equal(testAttempts, 0);
});
after(async () => {
  try {
    await nextTurn(); assert.equal(totalAttempts, 0);
  } finally {
    mock.restoreAll();
  }
});
function fixture(t, extras = {}) {
  let mono = 0;
  let client;
  const jobs = new Set();
  const messages = [];
  const statuses = [];
  const context = new AbortController();
  class Fake extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.connects = 0; this.ends = 0;
    }
    connect() {
      this.connects++; return this;
    }
    subscribe(request, callback) {
      this.request = request; this.ack = callback; return this;
    }
    end() {
      this.ends++; return this;
    }
  }
  const transport = createMqttTransport({
    onMessage: m => messages.push(m), onStatus: s => statuses.push(s),
    clock: { now: () => ({ monotonicMs: mono, wallMs: 1800000000000 + mono }) },
    scheduler: { schedule(callback, ms) {
      const j = { callback, at: mono + ms }; jobs.add(j); return () => jobs.delete(j);
    } },
    clientFactory: (_builder, options) => {
      client = new Fake(options); return client;
    },
    ...extras,
  });
  t.after(() => {
    transport.close();
    assert.equal(jobs.size, 0);
    assert.equal(getEventListeners(context.signal, 'abort').length, 0);
    if (client) {
      for (const name of ['connect', 'message', 'close', 'disconnect']) {
        assert.equal(client.listenerCount(name), 0);
      }
    }
  });
  return {
    transport, messages, statuses, jobs, context,
    get client() {
      return client;
    },
    start: (c = credentials, r = routes) => transport.connect(c, r, { signal: context.signal }),
    connected: () => client.emit('connect', { reasonCode: 0, sessionPresent: false }),
    ack: () => client.ack(null, Object.keys(client.request).map(topic => ({ topic, qos: 1 }))),
    emit: (body = 'x', meta = packet, name = topic) => client.emit('message', name, Buffer.from(body), meta),
    advance(ms, run = true) {
      mono += ms;
      if (run) {
        for (const j of [...jobs]) {
          if (j.at <= mono && jobs.delete(j)) {
            j.callback();
          }
        }
      }
    },
  };
}
test('construction is inert and exposes no publishing or session API', t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.transport).sort(), ['close', 'connect', 'getStatus']);
  assert.equal(f.client, undefined);
  assert.equal(f.jobs.size, 0);
});
test('explicit v5 options disable automatic recovery and use private non-identifying credentials', async t => {
  const f = fixture(t); const p = f.start();
  const o = f.client.options;
  assert.equal(o.protocolVersion, 5); assert.equal(o.reconnectPeriod, 0);
  assert.equal(o.resubscribe, false); assert.equal(o.queueQoSZero, false);
  assert.equal(o.reconnectOnConnackError, false); assert.equal(o.clean, true);
  assert.equal(o.properties.sessionExpiryInterval, 0); assert.equal(o.properties.maximumPacketSize, 131072);
  assert.equal(o.username, credentials.uuid); assert.equal(o.password, credentials.accessToken);
  assert.match(o.clientId, /^hb-[0-9a-f-]+$/); assert.equal(o.will, undefined);
  f.connected(); assert.equal(Object.keys(f.client.request).length, 7);
  for (const v of Object.values(f.client.request)) {
    assert.deepEqual(v, { qos: 1, rap: false, rh: 0 });
  }
  f.ack(); assert.deepEqual(await p, { ok: true });
});
const invalidRoutes = [
  [], null, [{ routeId: 'a' }], [{ routeId: 'a', macAddress: '' }],
  ...['a/b', 'a\\b', 'a+b', 'a#b', 'a b', 'a\n', '\0a'].map(macAddress => [{ routeId: 'a', macAddress }]),
  [{ routeId: 'a', macAddress: 'ONE' }, { routeId: 'a', macAddress: 'TWO' }],
  [{ routeId: 'a', macAddress: 'one' }, { routeId: 'b', macAddress: 'ONE' }],
  Array.from({ length: 101 }, (_, i) => ({ routeId: 'r' + i, macAddress: 'm' + i })),
  Array.from({ length: 100 }, (_, i) => ({ routeId: 'r' + i, macAddress: 'x'.repeat(250) + i })),
];
for (const [i, value] of invalidRoutes.entries()) {
  test('invalid route plan rejected before dispatch ' + i, async t => {
    const f = fixture(t); assert.equal((await f.start(credentials, value)).error.kind, 'invalid-input');
    assert.equal(f.client, undefined); assert.equal(f.jobs.size, 0);
  });
}
for (const value of [null, {}, { uuid: '', accessToken: 'x' }, { uuid: 'x', accessToken: 'bad token' }]) {
  test('invalid credentials are inert: ' + inspect(value), async t => {
    const f = fixture(t); assert.equal((await f.start(value)).error.kind, 'invalid-input'); assert.equal(f.client, undefined);
  });
}
test('two routes get fourteen exact subscriptions and unknown topics are ignored', async t => {
  const f = fixture(t); const p = f.start(credentials, [...routes, { routeId: 'second', macAddress: 'other' }]);
  f.connected(); assert.equal(Object.keys(f.client.request).length, 14); f.ack(); await p;
  f.emit('x', packet, 'external/toniebox/UNAPPROVED/volume/state'); assert.equal(f.messages.length, 0);
  f.emit('x', packet, 'external/toniebox/OTHER/volume/state'); assert.equal(f.messages[0].routeId, 'second');
});
test('early messages preserve FIFO, receipt time, flags and payload ownership', async t => {
  const f = fixture(t); const p = f.start(); f.connected();
  const body = Buffer.from('original');
  f.client.emit('message', topic, body, packet); body.fill(0);
  f.advance(20); f.emit('second', { retain: false, qos: 0, dup: true });
  assert.equal(f.messages.length, 0); f.ack(); assert.equal((await p).ok, true);
  assert.equal(Buffer.from(f.messages[0].payload).toString(), 'original');
  assert.equal(f.messages[0].receivedAtMs, 1800000000000);
  assert.equal(f.messages[1].receivedAtMs, 1800000000020);
  assert.equal(f.messages[1].duplicate, true); assert.equal(f.messages[1].retained, false);
  assert.equal(f.messages[1].qos, 0); assert.equal('session' in f.messages[0], false);
});
for (const mode of ['missing', 'downgrade', 'duplicate', 'refused', 'wrong-topic']) {
  test('invalid SUBACK: ' + mode, async t => {
    const f = fixture(t); const p = f.start(); f.connected(); f.emit();
    const grants = Object.keys(f.client.request).map(topic => ({ topic, qos: 1 }));
    if (mode === 'missing') {
      grants.pop();
    }
    if (mode === 'downgrade') {
      grants[0].qos = 0;
    }
    if (mode === 'duplicate') {
      grants[0] = grants[1];
    }
    if (mode === 'refused') {
      grants[0].qos = 128;
    }
    if (mode === 'wrong-topic') {
      grants[0].topic = 'unknown';
    }
    f.client.ack(null, grants);
    assert.equal((await p).error.kind, 'subscription-refused'); assert.equal(f.messages.length, 0);
  });
}
for (const phase of ['before', 'connect', 'subscribe', 'ready']) {
  test('cancellation and late events during ' + phase, async t => {
    const f = fixture(t);
    if (phase === 'before') {
      f.context.abort();
    }
    const p = f.start();
    if (phase === 'subscribe' || phase === 'ready') {
      f.connected();
    }
    if (phase === 'ready') {
      f.ack(); await p;
    }
    f.context.abort('SYNTHETIC_SECRET');
    if (phase !== 'ready') {
      assert.equal((await p).error.kind, 'cancelled');
    }
    if (f.client) {
      f.client.emit('error', new Error('SYNTHETIC_SECRET')); f.emit(); f.client.emit('connect', {});
    }
    assert.equal(f.transport.getStatus().phase, 'closed'); assert.equal(f.messages.length, 0);
    assert.equal(inspect(f.statuses).includes('SYNTHETIC_SECRET'), false);
  });
}
for (const phase of ['connect', 'subscribe', 'late']) {
  test('bounded deadline: ' + phase, async t => {
    const f = fixture(t); const p = f.start();
    if (phase === 'subscribe') {
      f.advance(19000); f.connected(); f.advance(10000);
    } else {
      f.advance(20000, phase !== 'late'); if (phase === 'late') {
        f.connected();
      }
    }
    assert.equal((await p).error.kind, 'timeout');
  });
}
test('duplicate connect closes safely and disposal is permanent', async t => {
  const f = fixture(t); const p = f.start(); f.connected(); f.connected();
  assert.equal((await p).error.kind, 'protocol'); f.transport.close(); f.transport.close();
  assert.equal((await f.start()).error.kind, 'closed'); assert.equal(f.client.connects, 1);
});
for (const code of [134, 135, 137, undefined]) {
  test('safe broker/transport failure ' + code, async t => {
    const f = fixture(t); const p = f.start();
    f.client.emit('error', { code, message: credentials.accessToken, cause: credentials });
    const r = await p; assert.equal(r.ok, false);
    assert.equal(inspect(r).includes(credentials.accessToken), false);
    assert.equal(r.error.kind, code === 134 || code === 135 ? 'authentication-refused' : 'transport');
  });
}
for (const mode of ['payload', 'bytes', 'count']) {
  test('resource bound: ' + mode, async t => {
    const f = fixture(t); const p = f.start(); f.connected();
    if (mode === 'payload') {
      f.emit(Buffer.alloc(65537));
    } else if (mode === 'bytes') {
      for (let i = 0; i < 17; i++) {
        f.emit(Buffer.alloc(65536));
      }
    } else {
      for (let i = 0; i < 1025; i++) {
        f.emit('');
      }
    }
    assert.equal((await p).error.kind, 'resource-limit'); assert.equal(f.messages.length, 0);
  });
}
test('exact application and early-buffer limits are accepted', async t => {
  const f = fixture(t); const p = f.start(); f.connected();
  for (let i = 0; i < 16; i++) {
    f.emit(Buffer.alloc(65536));
  }
  f.ack(); assert.equal((await p).ok, true); assert.equal(f.messages.length, 16);
});
test('callback cancellation while draining never publishes remaining buffered messages', async t => {
  let f;
  f = fixture(t, { onMessage: m => {
    f.messages.push(m); f.context.abort();
  } });
  const p = f.start(); f.connected(); f.emit('a'); f.emit('b'); f.ack();
  assert.equal((await p).error.kind, 'cancelled'); assert.equal(f.messages.length, 1);
});
test('reentrant message delivery during draining preserves FIFO', async t => {
  let f;
  f = fixture(t, { onMessage: m => {
    f.messages.push(m); if (f.messages.length === 1) {
      f.emit('c');
    }
  } });
  const p = f.start(); f.connected(); f.emit('a'); f.emit('b'); f.ack(); await p;
  assert.deepEqual(f.messages.map(m => Buffer.from(m.payload).toString()), ['a', 'b', 'c']);
});
async function guarded(chunks, end = true) {
  const g = createPacketGuard(); const output = []; const errors = [];
  g.on('data', b => output.push(Buffer.from(b))); g.on('error', e => errors.push(e.message));
  for (const b of chunks) {
    if (!g.destroyed) {
      g.write(b);
    }
  }
  if (end) {
    g.end();
  } else {
    g.destroy();
  }
  await nextTurn();
  assert.equal(g.destroyed, true);
  return { output: Buffer.concat(output), errors };
}
function publish(size) {
  return mqttPacket.generate({ cmd: 'publish', topic: 'x', payload: Buffer.alloc(size), qos: 0, retain: false }, { protocolVersion: 5 });
}
test('guard preserves consecutive valid packets and arbitrary fragmentation', async () => {
  const original = Buffer.concat([Buffer.from([0xd0, 0]), publish(400), Buffer.from([0xd0, 0])]);
  for (const width of [1, 2, 3, 16, original.length]) {
    const chunks = []; for (let i = 0; i < original.length; i += width) {
      chunks.push(original.subarray(i, i + width));
    }
    const r = await guarded(chunks); assert.deepEqual(r.output, original); assert.deepEqual(r.errors, []);
  }
});
test('guard accepts exactly 128 KiB and rejects one byte over before forwarding the header', async () => {
  const exact = publish(131064); assert.equal(exact.length, 131072);
  const a = await guarded([exact]); assert.deepEqual(a.output, exact); assert.deepEqual(a.errors, []);
  const b = await guarded([publish(131065)]); assert.equal(b.output.length, 0); assert.deepEqual(b.errors, ['resource-limit']);
});
for (const bytes of [[0x30,128,128,128,128], [0x30,128,0], [0x30,129,128,0]]) {
  test('guard rejects malformed/overlong length ' + bytes.join('-'), async () => {
    const r = await guarded(bytes.map(b => Buffer.from([b])));
    assert.deepEqual(r.errors, ['protocol']); assert.equal(r.output.length, 0);
  });
}
for (const bytes of [[0x30], [0x30,128], [0x30,3,0]]) {
  test('incomplete close ' + bytes.join('-'), async () => {
    assert.deepEqual((await guarded([Buffer.from(bytes)])).errors, ['protocol']);
    assert.deepEqual((await guarded([Buffer.from(bytes)], false)).errors, []);
  });
}
test('16 MiB declaration rejects before fragmented 2 MiB body is forwarded', async () => {
  const chunks = [Buffer.from([0x30,128,128,128,8]), ...Array.from({ length: 128 }, () => Buffer.alloc(16384))];
  const r = await guarded(chunks); assert.equal(r.output.length, 0); assert.deepEqual(r.errors, ['resource-limit']);
});
for (const type of [0x10, 0x20, 0x30, 0x90, 0xe0]) {
  test('all inbound packet types bounded: ' + type, async () => {
    assert.deepEqual((await guarded([Buffer.from([type,128,128,128,8])])).errors, ['resource-limit']);
  });
}
test('packet debug tracing is detected without altering shared settings', async t => {
  const saved = debug.disable();
  try {
    debug.enable('mqtt-packet:*');
    const f = fixture(t); const r = await f.start();
    assert.equal(r.error.kind, 'unsafe-tracing'); assert.equal(f.client, undefined);
    assert.equal(debug.enabled('mqtt-packet:parser'), true);
    const g = await guarded([Buffer.from([0xd0, 0])]);
    assert.deepEqual(g.errors, ['unsafe-tracing']); assert.equal(g.output.length, 0);
  } finally {
    debug.enable(saved);
  }
});
test('actual packet writer can trace synthetic secrets despite no MQTT client logger', () => {
  const saved = debug.disable(); const oldLog = debug.log; const lines = [];
  try {
    debug.log = (...args) => lines.push(formatWithOptions(debug.inspectOpts, ...args));
    debug.enable('mqtt-packet:writeToStream');
    mqttPacket.generate({ cmd: 'connect', protocolVersion: 5, protocolId: 'MQTT', clean: true,
      clientId: 'synthetic', keepalive: 0, username: credentials.uuid, password: credentials.accessToken });
    assert.equal(lines.some(s => s.includes(credentials.accessToken)), true);
  } finally {
    debug.log = oldLog; debug.enable(saved);
  }
});
class SyntheticSocket extends EventEmitter {
  constructor() {
    super(); this.CONNECTING = 0; this.OPEN = 1; this.CLOSED = 3; this.readyState = 1;
    this.isPaused = false; this.sent = []; this.parser = mqttPacket.parser({ protocolVersion: 5 });
    this.parser.on('error', () => assert.fail('Invalid outbound MQTT'));
    this.parser.on('packet', p => {
      this.sent.push(p); this.respond?.(p);
    });
  }
  send(bytes, done) {
    this.parser.parse(bytes); done?.();
  }
  pause() {
    this.isPaused = true;
  }
  resume() {
    this.isPaused = false;
  }
  terminate() {
    if (this.readyState !== 3) {
      this.readyState = 3; this.emit('close');
    }
  }
  receive(packet) {
    this.emit('message', mqttPacket.generate(packet, { protocolVersion: 5 }), true);
  }
}
async function flush() {
  for (let i = 0; i < 8; i++) {
    await nextTurn();
  }
}
test('real ws stream, guard and MQTT.js process CONNECT, early PUBLISH, SUBACK and PUBACK', async t => {
  const socket = new SyntheticSocket(); const messages = [];
  const stream = createWebSocketStream(socket);
  const transport = createMqttTransport({ streamFactory: () => stream, onMessage: m => messages.push(m) });
  t.after(() => transport.close());
  socket.respond = p => {
    if (p.cmd === 'connect') {
      queueMicrotask(() => socket.receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false }));
    }
    if (p.cmd === 'subscribe') {
      queueMicrotask(() => {
        socket.receive({ cmd: 'publish', topic, payload: Buffer.from('state'), qos: 1, messageId: 42, retain: true, dup: false });
        socket.receive({ cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 1) });
      });
    }
  };
  assert.equal((await transport.connect(credentials, routes)).ok, true);
  await flush();
  assert.equal(messages.length, 1); assert.equal(messages[0].retained, true);
  assert.equal(socket.sent.filter(p => p.cmd === 'subscribe').length, 1);
  assert.equal(socket.sent.some(p => p.cmd === 'puback' && p.messageId === 42), true);
  transport.close(); await flush(); assert.equal(stream.destroyed, true); assert.equal(socket.readyState, 3);
});
test('actual guarded ws-stream path rejects oversized declaration and cannot deliver later data', async t => {
  const socket = new SyntheticSocket(); const stream = createWebSocketStream(socket); const messages = [];
  const transport = createMqttTransport({ streamFactory: () => stream, onMessage: m => messages.push(m) });
  t.after(() => transport.close());
  const p = transport.connect(credentials, routes);
  socket.receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
  await flush();
  socket.emit('message', Buffer.from([0x30,128,128,128,8]), true);
  for (let i = 0; i < 128 && !stream.destroyed; i++) {
    socket.emit('message', Buffer.alloc(16384), true);
  }
  assert.equal((await p).error.kind, 'resource-limit');
  await flush(); assert.equal(messages.length, 0); assert.equal(stream.destroyed, true); assert.equal(socket.readyState, 3);
});
test('actual WebSocket receiver independently rejects a frame declaring more than 1 MiB', async () => {
  const receiver = new Receiver({ isServer: false, maxPayload: 1048576 });
  const errors = []; receiver.on('error', e => errors.push(e.code));
  const frame = Buffer.alloc(10); frame[0] = 0x82; frame[1] = 127; frame.writeBigUInt64BE(1048577n, 2);
  receiver.write(frame); await nextTurn();
  assert.deepEqual(errors, ['WS_ERR_UNSUPPORTED_MESSAGE_LENGTH']); receiver.destroy();
});
test('independent attempt counters detect assertions sanitised by the adapter', async t => {
  let forbidden = 0;
  const f = fixture(t, { clientFactory: () => {
    forbidden++; throw new Error('secret');
  } });
  assert.equal((await f.start()).error.kind, 'dependency'); assert.equal(forbidden, 1);
});

for (const timing of ['before-receive', 'after-receive']) {
  const title = timing === 'after-receive'
    ? 'KNOWN LIMITATION: runtime tracing exposes synthetic buffered payload'
    : 'runtime tracing before receive is rejected';
  test(title, async t => {
    const socket = new SyntheticSocket();
    const stream = createWebSocketStream(socket);
    const messages = [];
    const transport = createMqttTransport({ streamFactory: () => stream, onMessage: m => messages.push(m) });
    t.after(() => transport.close());
    socket.respond = p => {
      if (p.cmd === 'connect') {
        queueMicrotask(() => socket.receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false }));
      }
      if (p.cmd === 'subscribe') {
        queueMicrotask(() => socket.receive({ cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 1) }));
      }
    };
    assert.equal((await transport.connect(credentials, routes)).ok, true);
    await flush();
    const encoded = mqttPacket.generate({
      cmd: 'publish', topic, payload: Buffer.from('SYNTHETIC_PRIVATE_PAYLOAD'), qos: 0, retain: false,
    }, { protocolVersion: 5 });
    const saved = debug.disable();
    const oldLog = debug.log;
    const lines = [];
    try {
      debug.log = (...args) => lines.push(formatWithOptions(debug.inspectOpts, ...args));
      if (timing === 'before-receive') {
        debug.enable('mqtt-packet:*');
      }
      socket.emit('message', encoded, true);
      if (timing === 'after-receive') {
        debug.enable('mqtt-packet:*');
      }
      await flush();
      const payloadExposed = lines.some(line => line.includes('SYNTHETIC_PRIVATE_PAYLOAD'));
      const topicExposed = lines.some(line => line.includes(topic));
      // Characterisation, NOT a confidentiality guarantee. A dependency fix must change this result.
      assert.equal(payloadExposed, timing === 'after-receive', 'Review the accepted runtime-tracing limitation if this changes');
      assert.equal(topicExposed, timing === 'after-receive');
      if (timing === 'before-receive') {
        assert.equal(transport.getStatus().error.kind, 'unsafe-tracing');
        assert.equal(messages.length, 0);
      }
    } finally {
      try {
        transport.close();
        await flush();
      } finally {
        debug.log = oldLog;
        debug.enable(saved);
      }
    }
  });
}

test('invalid constructor dependencies fail with a fixed safe error', () => {
  for (const options of [null, {}, { onMessage() {}, clock: null }, { onMessage() {}, scheduler: null }]) {
    assert.throws(() => createMqttTransport(options), { name: 'TypeError', message: 'Invalid MQTT transport options' });
  }
});

test('route plans and public status snapshots are independently owned', async t => {
  const f = fixture(t);
  const plan = [{ ...routes[0] }];
  const p = f.start(credentials, plan);
  plan[0].macAddress = 'CHANGED';
  plan.push({ routeId: 'new', macAddress: 'NEW' });
  f.connected();
  assert.equal(Object.keys(f.client.request).length, 7);
  assert.ok(f.client.request[topic]);
  f.ack();
  await p;
  f.transport.getStatus().phase = 'closed';
  assert.equal(f.transport.getStatus().phase, 'ready');
  f.context.abort();
  f.transport.getStatus().error.kind = 'invalid-input';
  assert.equal(f.transport.getStatus().error.kind, 'cancelled');
  assert.equal(f.client.options.username, undefined);
  assert.equal(f.client.options.password, undefined);
});

test('a second connect cannot replace or cancel the first attempt', async t => {
  const f = fixture(t);
  const first = f.start();
  assert.equal((await f.start()).error.kind, 'closed');
  f.connected();
  f.ack();
  assert.equal((await first).ok, true);
  assert.equal(f.client.connects, 1);
});

for (const [index, connack] of [null, {}, { reasonCode: 0, sessionPresent: true }, { reasonCode: 1, sessionPresent: false }].entries()) {
  test('malformed or incompatible CONNACK ' + index, async t => {
    const f = fixture(t);
    const p = f.start();
    f.client.emit('connect', connack);
    assert.equal((await p).error.kind, 'protocol');
    assert.equal(f.client.request, undefined);
  });
}

for (const mode of ['error', 'null-grants', 'null-entry']) {
  test('malformed SUBACK callback ' + mode, async t => {
    const f = fixture(t);
    const p = f.start();
    f.connected();
    const grants = Object.keys(f.client.request).map(topic => ({ topic, qos: 1 }));
    if (mode === 'null-entry') {
      grants[0] = null;
    }
    f.client.ack(mode === 'error' ? new Error('SYNTHETIC_PRIVATE_ERROR') : null, mode === 'null-grants' ? null : grants);
    assert.equal((await p).error.kind, 'subscription-refused');
    assert.equal(inspect(f.statuses).includes('SYNTHETIC_PRIVATE_ERROR'), false);
  });
}

test('duplicate and abandoned SUBACK callbacks cannot redeliver data', async t => {
  const f = fixture(t);
  const p = f.start();
  f.connected();
  f.emit();
  f.ack();
  await p;
  f.ack();
  assert.equal(f.messages.length, 1);
  f.context.abort();
  f.ack();
  f.emit();
  assert.equal(f.messages.length, 1);
  assert.equal(f.jobs.size, 0);
});

test('cancelled deadline callbacks cannot terminate a ready connection or restart a closed one', async t => {
  const f = fixture(t);
  const p = f.start();
  const connectTimer = [...f.jobs][0];
  f.connected();
  const subscribeTimer = [...f.jobs][0];
  f.ack();
  await p;
  f.advance(60000);
  connectTimer.callback();
  subscribeTimer.callback();
  assert.equal(f.transport.getStatus().phase, 'ready');
  f.transport.close();
  connectTimer.callback();
  subscribeTimer.callback();
  assert.equal(f.jobs.size, 0);
  assert.equal(f.client.connects, 1);
});

test('client returned after reentrant cancellation is disposed without connecting', async t => {
  let f;
  let returned;
  f = fixture(t, { clientFactory: (_builder, options) => {
    returned = new EventEmitter();
    returned.options = options;
    returned.ends = 0;
    returned.connect = () => assert.fail('Cancelled client must not connect');
    returned.end = () => {
      returned.ends++;
    };
    f.context.abort();
    return returned;
  } });
  assert.equal((await f.start()).error.kind, 'cancelled');
  assert.equal(returned.ends, 1);
  assert.equal(returned.options.password, undefined);
  returned.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'));
  assert.equal(returned.listenerCount('connect'), 0);
});

test('stream returned after reentrant cancellation is destroyed', async t => {
  const controller = new AbortController();
  const raw = new Duplex({ read() {}, write(_chunk, _encoding, done) {
    done();
  } });
  const adapter = createMqttTransport({
    onMessage() {},
    streamFactory() {
      controller.abort(); return raw;
    },
  });
  t.after(() => adapter.close());
  const result = await adapter.connect(credentials, routes, { signal: controller.signal });
  assert.equal(result.error.kind, 'cancelled');
  await flush();
  assert.equal(raw.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  raw.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'));
});

test('an injected end exception does not prevent settlement or cleanup', async t => {
  const f = fixture(t);
  const p = f.start();
  f.client.end = () => {
    throw new Error('SYNTHETIC_PRIVATE_ERROR');
  };
  f.context.abort();
  assert.equal((await p).error.kind, 'cancelled');
  assert.equal(f.jobs.size, 0);
  assert.equal(inspect(f.statuses).includes('SYNTHETIC_PRIVATE_ERROR'), false);
});

for (const extras of [
  { clock: { now() {
    throw new Error('SYNTHETIC_PRIVATE_ERROR');
  } } },
  { clock: { now: () => ({ monotonicMs: NaN, wallMs: 0 }) } },
  { scheduler: { schedule() {
    throw new Error('SYNTHETIC_PRIVATE_ERROR');
  } } },
]) {
  test('invalid clock or scheduler settles safely', async t => {
    const f = fixture(t, extras);
    assert.equal((await f.start()).error.kind, 'dependency');
    assert.equal(inspect(f.statuses).includes('SYNTHETIC_PRIVATE_ERROR'), false);
  });
}

test('delivery callback exceptions are sanitised and stop further deliveries', async t => {
  const f = fixture(t, { onMessage() {
    throw new Error('SYNTHETIC_PRIVATE_ERROR');
  } });
  const p = f.start();
  f.connected();
  f.emit();
  f.emit();
  f.ack();
  assert.equal((await p).error.kind, 'dependency');
  assert.equal(inspect(f.statuses).includes('SYNTHETIC_PRIVATE_ERROR'), false);
});

test('production WebSocket configuration fixes origin, TLS, redirects and limits without dispatch', async t => {
  let captured;
  const requestMock = mock.method(https, 'request', options => {
    captured = options;
    throw new Error('SYNTHETIC_REQUEST_INTERCEPTED');
  });
  try {
    const adapter = createMqttTransport({ onMessage() {} });
    t.after(() => adapter.close());
    const result = await adapter.connect(credentials, routes);
    assert.equal(result.error.kind, 'dependency');
    assert.equal(requestMock.mock.calls.length, 1);
    assert.equal(captured.host, 'ici.tonie.cloud');
    assert.equal(captured.port, 443);
    assert.equal(captured.path, '/');
    assert.equal(captured.rejectUnauthorized, true);
    assert.equal(captured.followRedirects, false);
    assert.equal(captured.maxPayload, 1048576);
    assert.equal(captured.perMessageDeflate, false);
    assert.equal(captured.headers['Sec-WebSocket-Protocol'], 'mqtt');
    assert.equal(inspect(captured).includes(credentials.accessToken), false);
  } finally {
    requestMock.mock.restore();
  }
});

test('tracing enabled after construction but before connect is rejected without changing namespaces', async t => {
  const f = fixture(t);
  const saved = debug.disable();
  const previousLog = debug.log;
  const lines = [];
  try {
    debug.log = (...args) => lines.push(formatWithOptions(debug.inspectOpts, ...args));
    debug.enable('other-plugin:*,mqtt-packet:parser');
    assert.equal((await f.start()).error.kind, 'unsafe-tracing');
    assert.equal(f.client, undefined);
    assert.equal(debug.enabled('other-plugin:example'), true);
    assert.equal(lines.length, 0);
  } finally {
    debug.log = previousLog;
    debug.enable(saved);
  }
});

function realFixture(t, response) {
  const socket = new SyntheticSocket();
  const raw = createWebSocketStream(socket);
  const messages = [];
  const controller = new AbortController();
  let builtClient;
  const adapter = createMqttTransport({
    onMessage: m => messages.push(m),
    streamFactory: () => raw,
    clientFactory: (builder, options) => {
      builtClient = new MqttClient(builder, options);
      return builtClient;
    },
  });
  socket.respond = p => {
    if (p.cmd === 'connect') {
      queueMicrotask(() => socket.receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false }));
    }
    if (p.cmd === 'subscribe') {
      response?.(socket, p);
    }
  };
  t.after(async () => {
    adapter.close();
    await flush();
    assert.equal(raw.destroyed, true);
    assert.equal(socket.readyState, 3);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(raw.listeners('error').some(fn => fn.name === 'onError'), false);
    assert.equal(builtClient.listenerCount('message'), 0);
    assert.equal(builtClient.listenerCount('disconnect'), 0);
  });
  return { socket, raw, messages, adapter, controller,
    get client() {
      return builtClient;
    },
    start: () => adapter.connect(credentials, routes, { signal: controller.signal }),
  };
}
const acceptSubscriptions = (socket, p) => queueMicrotask(() => socket.receive({
  cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 1),
}));

test('real receive path preserves split headers, many chunks and consecutive packets', async t => {
  const f = realFixture(t, acceptSubscriptions);
  assert.equal((await f.start()).ok, true);
  const a = mqttPacket.generate({ cmd: 'publish', topic, payload: Buffer.alloc(200, 97), qos: 0, retain: false },
    { protocolVersion: 5 });
  for (const byte of a) {
    f.socket.emit('message', Buffer.from([byte]), true);
  }
  const b = mqttPacket.generate({ cmd: 'publish', topic, payload: Buffer.from('b'), qos: 0, retain: true },
    { protocolVersion: 5 });
  f.socket.emit('message', Buffer.concat([b, b]), true);
  await flush();
  assert.equal(f.messages.length, 3);
  assert.deepEqual(Buffer.from(f.messages[0].payload), Buffer.alloc(200, 97));
  assert.deepEqual(f.messages.slice(1).map(m => [Buffer.from(m.payload).toString(), m.retained]), [['b', true], ['b', true]]);
  assert.deepEqual(f.socket.sent.map(p => p.cmd), ['connect', 'subscribe']);
});

test('real parser sees a packet exactly at 128 KiB but never one byte over', async t => {
  const f = realFixture(t, acceptSubscriptions);
  await f.start();
  let received = 0;
  f.client.on('packetreceive', p => {
    if (p.cmd === 'publish') {
      received++;
    }
  });
  // Unapproved topic avoids the separate, smaller application-payload delivery limit.
  const exact = publish(131064);
  f.socket.emit('message', exact, true);
  await flush();
  assert.equal(received, 1);
  assert.equal(f.adapter.getStatus().phase, 'ready');
  f.socket.emit('message', publish(131065), true);
  await flush();
  assert.equal(received, 1);
  assert.equal(f.adapter.getStatus().error.kind, 'resource-limit');
  assert.equal(f.messages.length, 0);
});

for (const mode of ['abrupt-close', 'cancel', 'dispose']) {
  test('real incomplete packet cleanup: ' + mode, async t => {
    const f = realFixture(t);
    const p = f.start();
    await flush();
    f.socket.emit('message', Buffer.from([0x30, 127, 0]), true);
    await flush();
    if (mode === 'abrupt-close') {
      f.socket.terminate();
    } else if (mode === 'cancel') {
      f.controller.abort();
    } else {
      f.adapter.close();
    }
    const result = await p;
    assert.equal(result.ok, false);
    if (mode === 'cancel') {
      assert.equal(result.error.kind, 'cancelled');
    }
    if (mode === 'dispose') {
      assert.equal(result.error.kind, 'closed');
    }
    await flush();
    f.socket.emit('message', publish(10), true);
    f.client.emit('error', new Error('SYNTHETIC_PRIVATE_ERROR'));
    await flush();
    assert.equal(f.messages.length, 0);
    assert.equal(f.socket.sent.filter(p => p.cmd === 'connect').length, 1);
  });
}

for (const grants of [[1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1, 128], [1, 1]]) {
  test('actual MQTT.js subscription result fails all-or-nothing readiness: ' + grants.join(','), async t => {
    const f = realFixture(t, (socket, p) => queueMicrotask(() => {
      socket.receive({ cmd: 'suback', messageId: p.messageId, granted: grants });
    }));
    assert.equal((await f.start()).ok, false);
    assert.equal(f.adapter.getStatus().phase, 'closed');
    assert.equal(f.messages.length, 0);
  });
}

test('real guarded path forwards zero oversized packet bytes in the fragmented 16 MiB reproduction', async t => {
  const f = realFixture(t);
  const p = f.start();
  await flush();
  let forwarded = 0;
  const observe = chunk => {
    forwarded += chunk.length;
  };
  f.client.stream.on('data', observe);
  try {
    for (const byte of [0x30, 128, 128, 128, 8]) {
      f.socket.emit('message', Buffer.from([byte]), true);
    }
    for (let i = 0; i < 128; i++) {
      f.socket.emit('message', Buffer.alloc(16384), true);
    }
    assert.equal((await p).error.kind, 'resource-limit');
    await flush();
    assert.equal(forwarded, 0);
    assert.equal(f.messages.length, 0);
    assert.equal(f.raw.destroyed, true);
    assert.equal(f.client.stream.destroyed, true);
    assert.deepEqual(f.socket.sent.map(p => p.cmd), ['connect', 'subscribe']);
  } finally {
    f.client.stream.removeListener('data', observe);
  }
});

for (const reasonCode of [134, 135]) {
  test('real broker authentication refusal is terminal: ' + reasonCode, async t => {
    const f = realFixture(t);
    f.socket.respond = p => {
      if (p.cmd === 'connect') {
        queueMicrotask(() => f.socket.receive({ cmd: 'connack', reasonCode, sessionPresent: false }));
      }
    };
    const result = await f.start();
    assert.deepEqual(result, { ok: false, error: { kind: 'authentication-refused', reasonCode, origin: 'error' } });
    await flush();
    assert.deepEqual(f.socket.sent.map(p => p.cmd), ['connect']);
    assert.equal((await f.start()).error.kind, 'closed');
  });
}

test('default establishment timer is unreferenced and cancelled on disposal', async () => {
  const handles = new Set();
  let unrefCount = 0;
  const timerMock = mock.method(globalThis, 'setTimeout', () => {
    const handle = { unref() {
      unrefCount++;
    } };
    handles.add(handle);
    return handle;
  });
  const clearMock = mock.method(globalThis, 'clearTimeout', handle => handles.delete(handle));
  let adapter;
  try {
    adapter = createMqttTransport({
      onMessage() {},
      clientFactory: (_builder, options) => {
        const client = new EventEmitter();
        client.options = options;
        client.connect = () => client;
        client.end = () => client;
        return client;
      },
    });
    const p = adapter.connect(credentials, routes);
    assert.equal(handles.size, 1);
    assert.equal(unrefCount, 1);
    adapter.close();
    assert.equal((await p).error.kind, 'closed');
    assert.equal(handles.size, 0);
  } finally {
    adapter?.close();
    timerMock.mock.restore();
    clearMock.mock.restore();
  }
});


for (const reasonCode of [134, 135]) {
  test('real parser refusal provenance for DISCONNECT ' + reasonCode, async t => {
    const f = realFixture(t, acceptSubscriptions); assert.equal((await f.start()).ok, true);
    f.socket.receive({ cmd: 'disconnect', reasonCode }); await flush();
    // mqtt-packet rejects 134 as an invalid DISCONNECT reason before emitting a packet.
    assert.deepEqual(f.adapter.getStatus().error, reasonCode === 135
      ? { kind: 'authentication-refused', reasonCode, origin: 'disconnect' } : { kind: 'transport' });
    assert.deepEqual(f.socket.sent.map(p => p.cmd), ['connect', 'subscribe']);
  });
}

test('generic MQTT error 135 never claims broker DISCONNECT provenance', async t => {
  const f = fixture(t); const p = f.start(); f.connected(); f.ack(); await p;
  f.client.emit('error', { code: 135, message: 'SYNTHETIC_SECRET' });
  assert.deepEqual(f.transport.getStatus().error, { kind: 'authentication-refused', reasonCode: 135, origin: 'error' });
});


test('real manager + lifecycle + guarded MQTT.js/ws sustain rotation and bounded broker recovery', async t => {
  const { createTokenManager } = await import('../dist/toniebox/tokenManager.js');
  const { createMqttLifecycle } = await import('../dist/toniebox/mqttLifecycle.js');
  let mono = 0, logins = 0, refreshes = 0, serial = 0;
  const jobs = new Set(), sessions = [], messages = [];
  const scheduler = { schedule(callback, ms) {
    const job = { callback, at: mono + ms }; jobs.add(job); return () => jobs.delete(job);
  } };
  const clock = { now: () => ({ monotonicMs: mono, wallMs: 1800000000000 + mono }) };
  const grant = () => ({ ok: true, tokens: { accessToken: 'SYNTHETIC_ACCESS_' + (++serial),
    refreshToken: 'SYNTHETIC_REFRESH_' + serial, tokenType: 'Bearer', expiresInSeconds: 300 } });
  const manager = createTokenManager({ clock, scheduler, authClient: {
    login: async () => {
      logins++; return grant();
    }, refresh: async () => {
      refreshes++; return grant();
    },
  } });
  manager.setCredentials({ username: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' });
  const context = new AbortController();
  const lifecycle = createMqttLifecycle({ tokenProvider: manager, contextSignal: context.signal, accountUuid: credentials.uuid,
    routes, onMessage: m => messages.push(m), clock: { now: () => mono }, scheduler, jitter: () => 0.5,
    transportFactory: callbacks => {
      assert.ok(sessions.every(s => s.adapter.getStatus().phase === 'closed'), 'Close before constructing a replacement');
      const socket = new SyntheticSocket(), stream = createWebSocketStream(socket);
      const adapter = createMqttTransport({ ...callbacks, clock, scheduler, streamFactory: () => stream });
      socket.respond = p => {
        if (p.cmd === 'connect') {
          queueMicrotask(() => socket.receive({ cmd: 'connack', reasonCode: 0, sessionPresent: false }));
        }
        if (p.cmd === 'subscribe') {
          queueMicrotask(() => {
            socket.receive({ cmd: 'publish', topic: 'external/toniebox/SYNTHETIC-MAC/online-state',
              payload: Buffer.from('{"onlineState":"disconnected"}'), qos: 0, retain: true });
            socket.receive({ cmd: 'suback', messageId: p.messageId, granted: p.subscriptions.map(() => 1) });
          });
        }
      };
      sessions.push({ socket, stream, adapter }); return adapter;
    },
  });
  const advance = async ms => {
    mono += ms;
    for (const j of [...jobs]) {
      if (j.at <= mono && jobs.delete(j)) {
        j.callback();
      }
    }
    await flush();
  };
  t.after(async () => {
    lifecycle.stop(); manager.stop(); context.abort(); await flush();
    assert.equal(jobs.size, 0); assert.ok(sessions.every(s => s.stream.destroyed && s.socket.readyState === 3));
    assert.equal(getEventListeners(context.signal, 'abort').length, 0);
  });
  lifecycle.start(); await flush();
  for (let n = 2; n <= 4; n++) {
    await advance(240000); assert.equal(lifecycle.getStatus().session, n);
    assert.equal(messages.at(-1).session, n); assert.equal(messages.at(-1).retained, true);
  }
  sessions.at(-1).socket.receive({ cmd: 'disconnect', reasonCode: 135 }); await flush();
  await advance(10000); assert.equal(sessions.length, 4);
  await advance(230000); assert.equal(sessions.length, 5); assert.equal(lifecycle.getStatus().replacement, 'recovery');
  await advance(240000); assert.equal(sessions.length, 6); assert.equal(lifecycle.getStatus().replacement, 'proactive');
  assert.equal(logins, 1); assert.equal(refreshes, 5); assert.equal(messages.length, 6);
  assert.deepEqual(sessions.map(s => s.socket.sent.filter(p => p.cmd === 'connect').length), [1,1,1,1,1,1]);
  assert.equal(new Set(sessions.map(s => s.socket.sent.find(p => p.cmd === 'connect').password.toString())).size, 6);
  for (const s of sessions) {
    assert.equal(s.socket.sent.filter(p => p.cmd === 'subscribe').length, 1);
    assert.equal(s.socket.sent.find(p => p.cmd === 'subscribe').subscriptions.length, 7);
    assert.equal(s.socket.sent.some(p => p.cmd === 'publish'), false);
  }
});
