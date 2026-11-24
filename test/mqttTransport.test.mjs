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
test('construction is inert and exposes only the guarded playback publishing API', t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.transport).sort(), ['close', 'connect', 'getStatus', 'publishPlayback']);
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

function realFixture(t, response, extras = {}) {
  const socket = new SyntheticSocket();
  const raw = createWebSocketStream(socket);
  const messages = [];
  const controller = new AbortController();
  let builtClient;
  const adapter = createMqttTransport({
    ...extras,
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
    start: (options = {}) => adapter.connect(credentials, routes, { signal: controller.signal, ...options }),
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

// Playback tests use explicit transport permission; existing connection callers remain receive-only.
async function playbackFixture(t, permission = [routes[0].routeId], extras = {}) {
  const f = fixture(t, extras);
  const starting = f.transport.connect(credentials, routes, { playbackRouteIds: permission });
  f.connected(); f.client.connected = true; f.ack(); assert.equal((await starting).ok, true);
  const sent = [], removed = [];
  let id = 100;
  f.client.publish = (name, payload, options, callback) => {
    const packet = { cmd: 'publish', topic: name, payload, ...options, messageId: id++ };
    const operation = { packet, callback }; sent.push(operation);
    f.client.emit('packetsend', packet);
    return f.client;
  };
  f.client.removeOutgoingMessage = messageId => {
    removed.push(messageId);
    sent.find(o => o.packet.messageId === messageId)?.callback(new Error('SYNTHETIC_PRIVATE'));
    return f.client;
  };
  t.after(() => {
    for (const event of ['packetsend', 'packetreceive']) {
      assert.equal(f.client.listenerCount(event), 0);
    }
  });
  return { ...f, client: f.client, sent, removed,
    publish: (action = 'play', options) => f.transport.publishPlayback(routes[0].routeId, action, options),
    ackPublish(code = 0, index = sent.length - 1) {
      const o = sent[index];
      f.client.emit('packetreceive', { cmd: 'puback', messageId: o.packet.messageId, reasonCode: code });
      o.callback(code > 0 && code !== 16 ? new Error('SYNTHETIC_PRIVATE') : null, o.packet);
    },
  };
}
const publishFailed = (reason, delivery = 'not-dispatched') => ({ ok: false, reason, delivery });
const brokerAccepted = { ok: true, acknowledgement: 'broker' };

test('playback disabled by default; authorised subscription is not command permission', async t => {
  const g = await playbackFixture(t, []);
  assert.deepEqual(await g.publish(), publishFailed('not-authorised'));
  assert.equal(g.sent.length, 0);
  const h = fixture(t); const start = h.start(); h.connected(); h.client.connected = true; h.ack(); await start;
  assert.deepEqual(await h.transport.publishPlayback(routes[0].routeId, 'play'), publishFailed('not-authorised'));
});
for (const permission of [null, {}, 'SYNTHETIC_ROUTE', ['UNKNOWN'], ['SYNTHETIC_ROUTE', 'SYNTHETIC_ROUTE'], [3], ['']]) {
  test('invalid playback permission fails before creating a client: ' + JSON.stringify(permission), async t => {
    const f = fixture(t);
    assert.equal((await f.transport.connect(credentials, routes, { playbackRouteIds: permission })).error.kind, 'invalid-input');
    assert.equal(f.client, undefined);
  });
}
test('throwing permission and request properties are contained without private errors', async t => {
  const f = fixture(t);
  assert.equal((await f.transport.connect(credentials, routes, { get playbackRouteIds() {
    throw new Error('SYNTHETIC_PRIVATE');
  } })).ok, false);
  const g = await playbackFixture(t);
  assert.deepEqual(await g.publish('play', { get signal() {
    throw new Error('SYNTHETIC_PRIVATE');
  } }), publishFailed('invalid-input'));
  assert.equal(g.sent.length, 0);
});
test('invalid playback actions, routes and signals cannot publish', async t => {
  const f = await playbackFixture(t);
  for (const action of ['stop', '', 0, true, null, {}, 'SYNTHETIC_PRIVATE']) {
    assert.deepEqual(await f.publish(action), publishFailed('invalid-input'));
  }
  for (const options of [null, [], false, { signal: {} }, { signal: false }]) {
    assert.deepEqual(await f.publish('play', options), publishFailed('invalid-input'));
  }
  assert.deepEqual(await f.transport.publishPlayback('UNKNOWN', 'play'), publishFailed('not-authorised'));
  assert.equal(f.sent.length, 0);
});
test('idle, connecting, disconnected-client and closed publishing reject', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.transport.publishPlayback(routes[0].routeId, 'play'), publishFailed('not-ready'));
  const start = f.start();
  assert.deepEqual(await f.transport.publishPlayback(routes[0].routeId, 'play'), publishFailed('not-ready'));
  f.transport.close(); await start;
  assert.deepEqual(await f.transport.publishPlayback(routes[0].routeId, 'play'), publishFailed('closed'));
  const g = await playbackFixture(t); g.client.connected = false;
  assert.deepEqual(await g.publish(), publishFailed('not-ready')); assert.equal(g.sent.length, 0);
});
for (const action of ['play', 'pause']) {
  test('exact guarded wire request: ' + action, async t => {
    const f = await playbackFixture(t); const result = f.publish(action);
    assert.deepEqual(f.sent[0].packet, { cmd: 'publish', topic: 'external/toniebox/SYNTHETIC-MAC/app-control/playback',
      payload: action === 'play' ? '{"action":"start"}' : '{"action":"pause"}', qos: 1, retain: false, messageId: 100 });
    assert.equal(Object.keys(f.client.request).length, 7);
    f.ackPublish(); assert.deepEqual(await result, brokerAccepted); assert.equal(f.jobs.size, 0);
  });
}
test('connection inputs and permission arrays are detached before asynchronous admission', async t => {
  const f = fixture(t), r = [{ ...routes[0] }], permissions = [r[0].routeId];
  const start = f.transport.connect(credentials, r, { playbackRouteIds: permissions });
  r[0].macAddress = 'OTHER'; r[0].routeId = 'OTHER'; permissions[0] = 'OTHER';
  f.connected(); f.client.connected = true; f.ack(); await start;
  let sent;
  f.client.publish = (name, payload, options, cb) => {
    sent = name; f.client.emit('packetsend', { cmd: 'publish', topic: name, payload, ...options, messageId: 20 });
    f.client.emit('packetreceive', { cmd: 'puback', messageId: 20 }); cb(null); return f.client;
  };
  assert.deepEqual(await f.transport.publishPlayback(routes[0].routeId, 'play'), brokerAccepted);
  assert.equal(sent, 'external/toniebox/SYNTHETIC-MAC/app-control/playback');
  assert.deepEqual(await f.transport.publishPlayback('OTHER', 'play'), publishFailed('not-authorised'));
});
for (const [code, reason] of [[0, undefined], [16, 'no-subscribers'], [135, 'broker-refused'], [151, 'broker-refused']]) {
  test('PUBACK classification ' + code, async t => {
    const f = await playbackFixture(t), p = f.publish(); f.ackPublish(code);
    assert.deepEqual(await p, reason ? publishFailed(reason, 'uncertain') : brokerAccepted);
    assert.equal(f.transport.getStatus().phase, 'ready');
  });
}
for (const reasonCode of [1, 255, -1, NaN, 0.5, '0', null]) {
  test('malformed PUBACK reason rejected: ' + String(reasonCode), async t => {
    const f = await playbackFixture(t), p = f.publish();
    f.client.emit('packetreceive', { cmd: 'puback', messageId: 100, reasonCode });
    assert.deepEqual(await p, publishFailed('invalid-acknowledgement', 'uncertain'));
    assert.equal(f.jobs.size, 0);
  });
}
test('callback alone and wrong-id ACK cannot claim acceptance; missing ACK times out', async t => {
  const f = await playbackFixture(t), p = f.publish(); let settled = false; void p.then(() => {
    settled = true;
  });
  f.sent[0].callback(null); f.client.emit('packetreceive', { cmd: 'puback', messageId: 101, reasonCode: 0 });
  await nextTurn(); assert.equal(settled, false); f.advance(2999); await nextTurn(); assert.equal(settled, false);
  f.advance(1); assert.deepEqual(await p, publishFailed('timeout', 'uncertain')); assert.deepEqual(f.removed, [100]);
});
test('callback before matching ACK waits; duplicate ACK/callback cannot settle twice', async t => {
  const f = await playbackFixture(t), p = f.publish(); let count = 0; void p.then(() => {
    count++;
  });
  f.sent[0].callback(null); f.ackPublish(); f.ackPublish(135); f.sent[0].callback(new Error('PRIVATE'));
  assert.deepEqual(await p, brokerAccepted); await nextTurn(); assert.equal(count, 1);
});
test('PUBACK without callback is bounded, and callback errors are sanitised', async t => {
  const f = await playbackFixture(t), p = f.publish();
  f.client.emit('packetreceive', { cmd: 'puback', messageId: 100, reasonCode: 0 });
  f.advance(3000); assert.deepEqual(await p, publishFailed('timeout', 'uncertain'));
  const q = f.publish(); f.sent[1].callback(new Error('SYNTHETIC_PRIVATE'));
  assert.deepEqual(await q, publishFailed('publish-error', 'uncertain'));
});
test('pre-abort prevents publishing; post-dispatch abort removes waiting and suppresses late results', async t => {
  const f = await playbackFixture(t), a = new AbortController(); a.abort();
  assert.deepEqual(await f.publish('play', { signal: a.signal }), publishFailed('cancelled')); assert.equal(f.sent.length, 0);
  const b = new AbortController(), p = f.publish('pause', { signal: b.signal }); b.abort();
  assert.deepEqual(await p, publishFailed('cancelled', 'uncertain'));
  assert.equal(getEventListeners(b.signal, 'abort').length, 0); assert.deepEqual(f.removed, [100]);
  f.ackPublish(); assert.equal(f.jobs.size, 0); assert.equal(f.sent.length, 1);
});
for (const mode of ['close', 'disconnect', 'error']) {
  test('pending publish settles on ' + mode, async t => {
    const f = await playbackFixture(t), p = f.publish();
    if (mode === 'close') {
      f.transport.close();
    } else {
      f.client.emit(mode, { reasonCode: 135 });
    }
    assert.deepEqual(await p, publishFailed(mode === 'close' ? 'closed' : 'interrupted', 'uncertain'));
    f.ackPublish(); f.advance(3000); assert.equal(f.jobs.size, 0); assert.equal(f.sent.length, 1);
    assert.equal(f.client.connects, 1);
  });
}
test('one pending publication bounds capacity without queuing another request', async t => {
  const f = await playbackFixture(t), p = f.publish();
  assert.deepEqual(await f.publish('pause'), publishFailed('capacity')); assert.equal(f.sent.length, 1);
  f.ackPublish(); await p; const q = f.publish('pause'); f.ackPublish(); assert.deepEqual(await q, brokerAccepted);
});
test('late expired ACK cannot finish the next operation, and packet IDs cannot be reused', async t => {
  const f = await playbackFixture(t), p = f.publish(); f.advance(3000); await p;
  const q = f.publish(); f.ackPublish(0, 0); let settled = false; void q.then(() => {
    settled = true;
  });
  await nextTurn(); assert.equal(settled, false); f.ackPublish(); await q;
  f.client.publish = (name, payload, options) => {
    f.client.emit('packetsend', { cmd: 'publish', topic: name, payload, ...options, messageId: 100 }); return f.client;
  };
  assert.deepEqual(await f.publish(), publishFailed('dependency', 'uncertain'));
  assert.equal(f.transport.getStatus().phase, 'closed');
});
test('reentrant closure inside publish revokes authority before callbacks', async t => {
  const f = await playbackFixture(t); const original = f.client.publish;
  f.client.publish = (...args) => {
    original(...args); f.transport.close(); f.ackPublish(); return f.client;
  };
  assert.deepEqual(await f.publish(), publishFailed('closed', 'uncertain')); assert.equal(f.jobs.size, 0);
});
test('publish throw or library queue is uncertain and cannot become a later dispatch', async t => {
  for (const throwing of [true, false]) {
    const f = await playbackFixture(t);
    f.client.publish = () => {
      if (throwing) {
        throw new Error('SYNTHETIC_PRIVATE');
      } return f.client;
    };
    assert.deepEqual(await f.publish(), publishFailed('dependency', 'uncertain'));
    assert.equal(f.transport.getStatus().phase, 'closed');
  }
});
test('scheduler throw and synchronous callback fail before publishing', async t => {
  for (const synchronous of [false, true]) {
    let command = false;
    const f = await playbackFixture(t, [routes[0].routeId], { scheduler: { schedule(cb) {
      if (command) {
        if (synchronous) {
          cb(); return () => {};
        } throw new Error('SYNTHETIC_PRIVATE');
      }
      return () => {};
    } } }); command = true;
    assert.deepEqual(await f.publish(), publishFailed('dependency')); assert.equal(f.sent.length, 0);
  }
});
test('unsafe packet tracing blocks command dispatch and exposes no command data', async t => {
  const f = await playbackFixture(t), saved = debug.disable();
  try {
    debug.enable('mqtt-packet:writeToStream');
    assert.deepEqual(await f.publish(), publishFailed('unsafe-tracing')); assert.equal(f.sent.length, 0);
  } finally {
    debug.enable(saved);
  }
});

async function realPlaybackFixture(t) {
  let now = 0;
  const jobs = new Set();
  const f = realFixture(t, acceptSubscriptions, {
    clock: { now: () => ({ monotonicMs: now, wallMs: 1800000000000 + now }) },
    scheduler: { schedule(callback, delay) {
      const j = { callback, deadline: now + delay }; jobs.add(j); return () => jobs.delete(j);
    } },
  });
  assert.equal((await f.start({ playbackRouteIds: [routes[0].routeId] })).ok, true);
  const removed = [], remove = f.client.removeOutgoingMessage.bind(f.client);
  f.client.removeOutgoingMessage = id => {
    removed.push(id); return remove(id);
  };
  t.after(() => {
    assert.equal(jobs.size, 0);
    assert.equal(f.client.listenerCount('packetsend'), 0);
    assert.equal(f.client.listenerCount('packetreceive'), 0);
  });
  return { ...f, client: f.client, jobs, removed,
    publish: (action = 'play', signal) => f.adapter.publishPlayback(routes[0].routeId, action, { signal }),
    commands: () => f.socket.sent.filter(p => p.cmd === 'publish'),
    advance(ms) {
      now += ms;
      for (const j of [...jobs]) {
        if (j.deadline <= now && jobs.delete(j)) {
          j.callback();
        }
      }
    },
  };
}
for (const [code, reason] of [[0, undefined], [16, 'no-subscribers'], [128, 'broker-refused'], [135, 'broker-refused'], [151, 'broker-refused']]) {
  test('real MQTT.js outgoing QoS-1 PUBACK classification ' + code, async t => {
    const f = await realPlaybackFixture(t);
    const respond = f.socket.respond;
    f.socket.respond = p => {
      respond(p);
      if (p.cmd === 'publish') {
        queueMicrotask(() => f.socket.receive({ cmd: 'puback', messageId: p.messageId, reasonCode: code }));
      }
    };
    const result = await f.publish();
    assert.deepEqual(result, reason ? publishFailed(reason, 'uncertain') : brokerAccepted);
    const [p] = f.commands();
    assert.equal(p.topic, 'external/toniebox/SYNTHETIC-MAC/app-control/playback');
    assert.equal(p.payload.toString(), '{"action":"start"}'); assert.equal(p.qos, 1); assert.equal(p.retain, false);
    assert.equal(p.dup, false); assert.equal(f.socket.sent.filter(p => p.cmd === 'subscribe').length, 1);
    assert.equal(f.client.options.reconnectPeriod, 0); assert.equal(f.client.options.resubscribe, false);
    assert.equal(f.client.options.clean, true); assert.equal(f.client.options.properties.sessionExpiryInterval, 0);
    assert.equal(f.adapter.getStatus().phase, 'ready'); assert.equal(f.jobs.size, 0);
    f.socket.receive({ cmd: 'publish', topic, payload: Buffer.from('still receiving'), qos: 1, messageId: 500, retain: false, dup: false });
    await flush(); assert.equal(f.messages.at(-1).payload.length, 15);
    assert.ok(f.socket.sent.some(p => p.cmd === 'puback' && p.messageId === 500));
  });
}
for (const mode of ['timeout', 'abort', 'close', 'disconnect']) {
  test('real pending publish ' + mode + ' removes authority and never replays', async t => {
    const f = await realPlaybackFixture(t), controller = new AbortController();
    const p = f.publish('pause', controller.signal); await flush(); const id = f.commands()[0].messageId;
    if (mode === 'timeout') {
      f.advance(3000);
    }
    if (mode === 'abort') {
      controller.abort();
    }
    if (mode === 'close') {
      f.adapter.close();
    }
    if (mode === 'disconnect') {
      f.socket.receive({ cmd: 'disconnect', reasonCode: 0 });
    }
    const result = await p;
    const reason = mode === 'abort' ? 'cancelled' : mode === 'disconnect' ? 'interrupted' : mode === 'close' ? 'closed' : mode;
    assert.deepEqual(result, publishFailed(reason, 'uncertain'));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.deepEqual(f.removed, [id]);
    if (mode === 'timeout' || mode === 'abort') {
      f.socket.receive({ cmd: 'puback', messageId: id, reasonCode: 0 }); await flush();
      const q = f.publish('play'); await flush(); const next = f.commands().at(-1).messageId;
      assert.notEqual(next, id);
      f.socket.receive({ cmd: 'puback', messageId: id, reasonCode: 0 });
      f.socket.receive({ cmd: 'puback', messageId: next, reasonCode: 0 });
      assert.deepEqual(await q, brokerAccepted); assert.equal(f.commands().length, 2);
    } else {
      assert.deepEqual(await f.publish(), publishFailed('closed')); assert.equal(f.commands().length, 1);
    }
    assert.equal(f.socket.sent.filter(p => p.cmd === 'connect').length, 1);
    assert.equal(f.socket.sent.filter(p => p.cmd === 'subscribe').length, 1);
  });
}
test('real wrong-id and duplicate PUBACK cannot establish a different publication', async t => {
  const f = await realPlaybackFixture(t), p = f.publish(); await flush(); const id = f.commands()[0].messageId;
  let done = false; void p.then(() => {
    done = true;
  });
  f.socket.receive({ cmd: 'puback', messageId: id + 1, reasonCode: 0 }); await flush(); assert.equal(done, false);
  f.socket.receive({ cmd: 'puback', messageId: id, reasonCode: 0 }); assert.deepEqual(await p, brokerAccepted);
  f.socket.receive({ cmd: 'puback', messageId: id, reasonCode: 135 }); await flush();
  assert.equal(f.adapter.getStatus().phase, 'ready'); assert.equal(f.commands().length, 1);
});
test('real parser rejects malformed PUBACK before packetreceive and interrupts the command', async t => {
  const f = await realPlaybackFixture(t), p = f.publish(); await flush(); const id = f.commands()[0].messageId;
  f.socket.receive({ cmd: 'puback', messageId: id, reasonCode: 1 });
  assert.deepEqual(await p, publishFailed('interrupted', 'uncertain'));
  assert.equal(f.adapter.getStatus().phase, 'closed');
});
test('real cancellation at packetsend remains uncertain and never retries transmitted command', async t => {
  const f = await realPlaybackFixture(t), controller = new AbortController();
  f.client.once('packetsend', packet => {
    if (packet.cmd === 'publish') {
      controller.abort();
    }
  });
  assert.deepEqual(await f.publish('play', controller.signal), publishFailed('cancelled', 'uncertain'));
  await flush(); assert.equal(f.commands().length, 1); // Cancellation cannot retract a library write already entered.
  f.advance(5000); assert.equal(f.commands().length, 1); assert.equal(f.jobs.size, 0);
});
test('real lost connection before library dispatch never queues a command for reconnection', async t => {
  const f = await realPlaybackFixture(t); const publish = f.client.publish.bind(f.client);
  f.client.publish = (...args) => {
    f.client.connected = false; return publish(...args);
  };
  assert.deepEqual(await f.publish(), publishFailed('dependency', 'uncertain'));
  await flush(); assert.equal(f.commands().length, 0); assert.equal(f.adapter.getStatus().phase, 'closed');
});
test('early, repeated and cancellation-failed deadline callbacks cannot extend or duplicate command ownership', async t => {
  let mono = 0; const callbacks = []; let command = false;
  const f = await playbackFixture(t, [routes[0].routeId], {
    clock: { now: () => ({ monotonicMs: mono, wallMs: 1800000000000 + mono }) },
    scheduler: { schedule(cb) {
      if (command) {
        callbacks.push(cb); return () => {
          throw new Error('PRIVATE');
        };
      }
      return () => {};
    } },
  }); command = true;
  const p = f.publish(); const first = callbacks[0]; mono = 1; first(); first(); assert.equal(callbacks.length, 2);
  mono = 3000; callbacks[1](); assert.deepEqual(await p, publishFailed('timeout', 'uncertain'));
  callbacks[1](); first(); assert.equal(callbacks.length, 2); assert.equal(f.sent.length, 1);
});
test('clock invalidation and scheduler reentrant shutdown settle without leaked command signals', async t => {
  for (const mode of ['clock', 'scheduler']) {
    let command = false, f;
    f = await playbackFixture(t, [routes[0].routeId], {
      clock: { now: () => {
        if (command && mode === 'clock') {
          f.transport.close();
        }
        return { monotonicMs: 0, wallMs: 1800000000000 };
      } },
      scheduler: { schedule() {
        if (command && mode === 'scheduler') {
          f.transport.close();
        }
        return () => {};
      } },
    }); command = true; const controller = new AbortController();
    assert.deepEqual(await f.publish('play', { signal: controller.signal }), publishFailed('closed'));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(f.sent.length, 0);
  }
});
test('ACK at an elapsed deadline fails even before the scheduled callback runs', async t => {
  const f = await playbackFixture(t), p = f.publish(); f.advance(3000, false); f.ackPublish();
  assert.deepEqual(await p, publishFailed('timeout', 'uncertain')); assert.equal(f.jobs.size, 0);
});

test('multiple approved routes require individual explicit permission and cannot redirect destinations', async t => {
  const f = fixture(t), r = [...routes, { routeId: 'SECOND', macAddress: 'SECOND-MAC' }];
  const start = f.transport.connect(credentials, r, { playbackRouteIds: ['SECOND'] });
  f.connected(); f.client.connected = true; f.ack(); await start;
  assert.equal(Object.keys(f.client.request).length, 14);
  assert.deepEqual(await f.transport.publishPlayback(routes[0].routeId, 'play'), publishFailed('not-authorised'));
  let sent;
  f.client.publish = (topic, payload, options, cb) => {
    sent = topic; f.client.emit('packetsend', { cmd: 'publish', topic, payload, ...options, messageId: 2 });
    f.client.emit('packetreceive', { cmd: 'puback', messageId: 2, reasonCode: 0 }); cb(null); return f.client;
  };
  assert.deepEqual(await f.transport.publishPlayback('SECOND', 'pause'), brokerAccepted);
  assert.equal(sent, 'external/toniebox/SECOND-MAC/app-control/playback');
});
test('permission getter reentrant close cannot resurrect a transport', async t => {
  const f = fixture(t);
  const result = await f.transport.connect(credentials, routes, { get playbackRouteIds() {
    f.transport.close(); return [routes[0].routeId];
  } });
  assert.equal(result.error.kind, 'closed'); assert.equal(f.client, undefined); assert.equal(f.transport.getStatus().phase, 'closed');
});
test('reentrant abort-listener installation is cleaned even when added after close', async t => {
  const f = await playbackFixture(t), controller = new AbortController();
  const add = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    f.transport.close(); return add(...args);
  };
  assert.deepEqual(await f.publish('play', { signal: controller.signal }), publishFailed('closed'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); assert.equal(f.sent.length, 0);
});
test('public packet observer exceptions are contained and results never expose private values', async t => {
  const f = await playbackFixture(t), p = f.publish();
  f.client.emit('packetreceive', { get cmd() {
    throw new Error('SYNTHETIC_PRIVATE');
  } });
  const result = await p;
  assert.deepEqual(result, publishFailed('invalid-acknowledgement', 'uncertain'));
  assert.doesNotMatch(JSON.stringify([result, f.transport.getStatus()]), /SYNTHETIC|external\/|action|token|password/i);
});
test('public outgoing cleanup failure closes safely without leaking a pending operation', async t => {
  const f = await playbackFixture(t), p = f.publish();
  f.client.removeOutgoingMessage = () => {
    throw new Error('SYNTHETIC_PRIVATE');
  };
  f.advance(3000); assert.deepEqual(await p, publishFailed('timeout', 'uncertain'));
  assert.equal(f.transport.getStatus().phase, 'closed'); assert.equal(f.jobs.size, 0);
});

test('reentrant permission getter cannot replace the admitted route plan or create a second connection', async t => {
  const f = fixture(t); let nested;
  const p = f.transport.connect(credentials, routes, { get playbackRouteIds() {
    nested = f.transport.connect(credentials, [{ routeId: 'OTHER', macAddress: 'OTHER-MAC' }], { playbackRouteIds: ['OTHER'] });
    return [routes[0].routeId];
  } });
  assert.equal((await nested).error.kind, 'closed');
  f.connected(); f.client.connected = true; f.ack(); assert.equal((await p).ok, true);
  assert.equal(f.client.connects, 1); assert.equal(Object.keys(f.client.request).length, 7);
  assert.ok(Object.keys(f.client.request).every(topic => topic.startsWith('external/toniebox/SYNTHETIC-MAC/')));
  assert.deepEqual(await f.transport.publishPlayback('OTHER', 'play'), publishFailed('not-authorised'));
});
test('duplicate permissions fail even within the approved route-count bound', async t => {
  const f = fixture(t);
  const result = await f.transport.connect(credentials, [...routes, { routeId: 'SECOND', macAddress: 'SECOND-MAC' }],
    { playbackRouteIds: [routes[0].routeId, routes[0].routeId] });
  assert.equal(result.error.kind, 'invalid-input'); assert.equal(f.client, undefined);
});
