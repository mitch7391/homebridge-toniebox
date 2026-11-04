import assert from 'node:assert/strict';
import net from 'node:net';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

const { AbortController, TextEncoder, structuredClone } = globalThis;
let createBackendState, nextStateSession, approveRoutes, createMqttLifecycle, createMqttTransport;
let forbidden = 0, perTest = 0;
before(async () => {
  const deny = () => {
    forbidden++; perTest++; throw new Error('Forbidden network or timer');
  };
  mock.method(globalThis, 'fetch', deny);
  mock.method(net.Socket.prototype, 'connect', deny);
  mock.method(globalThis, 'setTimeout', deny);
  mock.method(globalThis, 'setInterval', deny);
  ({ createBackendState, nextStateSession } = await import('../dist/toniebox/backendState.js'));
  ({ approveRoutes } = await import('../dist/toniebox/routingPolicy.js'));
  ({ createMqttLifecycle } = await import('../dist/toniebox/mqttLifecycle.js'));
  ({ createMqttTransport } = await import('../dist/toniebox/mqttTransport.js'));
});
beforeEach(() => {
  perTest = 0;
});
afterEach(async () => {
  await nextTurn(); assert.equal(perTest, 0);
});
after(async () => {
  try {
    await nextTurn(); assert.equal(forbidden, 0);
  } finally {
    mock.restoreAll();
  }
});
const context = Symbol('synthetic-context');
const diag = { rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false };
function plan(extra = {}, ids = ['SYNTHETIC_A']) {
  const snapshot = {
    account: { id: 'SYNTHETIC_ACCOUNT', identitySource: 'uuid' }, accountDiagnostics: diag, householdsDiagnostics: diag,
    households: [{ identity: { id: 'SYNTHETIC_HOUSE' }, outcome: 'received', diagnostics: diag }],
    devices: ids.map(id => ({
      requestedHouseholdId: 'SYNTHETIC_HOUSE',
      device: { id, macAddress: id + '_MAC', product: 'tb2', generation: 'tng', features: ['playbackControls'] },
    })), enumeration: 'finished', routing: { evidence: 'observed-endpoints', conflicts: 'none-observed' },
  };
  return { ...approveRoutes({ ok: true, snapshot, diagnostics: {} }, context).production, ...extra };
}
const ready = session => ({ phase: 'ready', connected: true, session });
const message = (topic = 'volume/state', value = { level: 4 }, extra = {}) => ({
  routeId: 'SYNTHETIC_A', topic: 'external/toniebox/SYNTHETIC_A_MAC/' + topic,
  payload: new TextEncoder().encode(JSON.stringify(value)), session: 1, retained: false, qos: 1, duplicate: false, receivedAtMs: 100000, ...extra,
});
const playing = { tonie: 'SYNTHETIC_CONTENT', paused: false, chapter: 1, chapterDuration: 441.566, chapterUntilMs: 200000 };
function fixture(options = {}, input = plan()) {
  const notices = [];
  const state = createBackendState({ context, onChange: notice => notices.push(notice), ...options });
  const bound = state.bind(input);
  assert.equal(bound.ok, true);
  return { state, binding: bound.binding, notices, get: () => state.getDevice('SYNTHETIC_A') };
}
function active(f) {
  f.binding.onStatus(ready(1));
  f.binding.onMessage(message('online-state', { onlineState: 'connected' }));
  f.binding.onMessage(message('playback/state', playing));
}

test('construction is inert and creates no routes, listeners, timers or network', () => {
  const adapter = createBackendState({ context });
  assert.deepEqual(adapter.getStatus(), { phase: 'idle', devices: 0 });
  assert.equal(adapter.getDevice('unknown'), undefined);
});
test('first readiness commits authority before synchronous observer/message reentrancy', () => {
  let state, binding;
  const notices = [];
  state = createBackendState({ context, onChange: notice => {
    notices.push(notice);
    if (notice.kind === 'transport') {
      assert.equal(state.getStatus().phase, 'connected');
      assert.equal(binding.onMessage(message()).accepted, true);
    }
  } });
  binding = state.bind(plan()).binding;
  assert.equal(binding.onStatus(ready(1)).accepted, true);
  assert.equal(state.getDevice('SYNTHETIC_A').state.topics['volume/state'].session, 1);
  assert.equal(notices.at(-1).kind, 'message');
});
test('duplicate ready callback allocates no extra state session or notification', () => {
  const f = fixture(); f.binding.onStatus(ready(1));
  const n = f.notices.length;
  assert.deepEqual(f.binding.onStatus(ready(1)), { accepted: true, changed: false });
  assert.equal(f.state.getStatus().stateSession, 1);
  assert.equal(f.notices.length, n);
});
test('reconnect maps new local session and leaves prior observations last-known', () => {
  const f = fixture(); active(f);
  f.binding.onStatus({ phase: 'waiting-retry', connected: false, retryAfterMs: 10000 });
  assert.equal(f.get().playback, 'unknown');
  assert.equal(f.get().freshness['playback/state'], 'last-known');
  f.binding.onStatus(ready(2));
  assert.equal(f.state.getStatus().stateSession, 2);
  assert.equal(f.binding.onMessage(message()).accepted, false);
  assert.equal(f.binding.onMessage(message('volume/state', { level: 5 }, { session: 2 })).accepted, true);
  assert.equal(f.get().freshness['playback/state'], 'last-known');
});
test('replacement lifecycle local session 1 cannot reactivate old state session 1', () => {
  const f = fixture(); active(f);
  const old = f.binding;
  const replacement = f.state.bind(plan()).binding;
  replacement.onStatus(ready(1));
  assert.equal(f.state.getStatus().stateSession, 2);
  assert.equal(f.get().playback, 'unknown');
  assert.equal(f.get().freshness['playback/state'], 'last-known');
  assert.equal(old.onMessage(message('volume/state', { level: 99 })).accepted, false);
  assert.equal(old.onStatus(ready(100)).accepted, false);
  assert.equal(f.state.getStatus().stateSession, 2);
});
test('late same-session readiness after disconnect cannot restore authority', () => {
  const f = fixture(); active(f);
  f.binding.onStatus({ phase: 'connecting', connected: false });
  assert.equal(f.binding.onStatus(ready(1)).accepted, false);
  assert.equal(f.binding.onMessage(message()).accepted, false);
  assert.equal(f.state.getStatus().phase, 'disconnected');
});
test('account invalidation clears namespace and blocks every old closure', () => {
  const f = fixture(); active(f); f.state.invalidate();
  assert.equal(f.get(), undefined);
  assert.equal(f.binding.onMessage(message()).accepted, false);
  assert.equal(f.binding.onStatus(ready(2)).accepted, false);
  assert.equal(f.state.bind(plan()).ok, false);
  assert.deepEqual(f.state.getStatus(), { phase: 'invalidated', devices: 0 });
  const next = createBackendState({ context: Symbol('next') });
  assert.equal(next.bind(plan()).ok, false);
});
test('same adapter cannot silently switch account UUID', () => {
  const f = fixture(); active(f);
  assert.equal(f.state.bind(plan({ accountUuid: 'SYNTHETIC_OTHER' })).ok, false);
  assert.equal(f.get().playback, 'playing');
});
for (const [label, overrides] of [
  ['incorrect route', { routeId: 'OTHER' }], ['incorrect MAC', { topic: 'external/toniebox/OTHER/volume/state' }],
  ['unknown topic', { topic: 'external/toniebox/SYNTHETIC_A_MAC/unknown' }],
  ['invalid topic', { topic: 'external/toniebox/SYNTHETIC_A_MAC/volume/+' }],
  ['malformed JSON', { payload: new TextEncoder().encode('{') }],
  ['invalid UTF8', { payload: new Uint8Array([255]) }],
  ['invalid shape', { payload: new TextEncoder().encode('[]') }],
  ['wrong local session', { session: 2 }], ['negative timestamp', { receivedAtMs: -1 }],
  ['fraction timestamp', { receivedAtMs: 0.5 }], ['nonboolean retain', { retained: 1 }],
  ['invalid QoS', { qos: 2 }], ['invalid duplicate flag', { duplicate: 'yes' }],
  ['oversized payload', { payload: new Uint8Array(65537) }],
]) {
  test(label + ' cannot mutate valid snapshots', () => {
    const f = fixture(); f.binding.onStatus(ready(1)); f.binding.onMessage(message());
    const prior = f.get();
    assert.equal(f.binding.onMessage(message('volume/state', { level: 99 }, overrides)).accepted, false);
    assert.deepEqual(f.get(), prior);
  });
}
test('messages before readiness cannot mutate initial state', () => {
  const f = fixture();
  assert.equal(f.binding.onMessage(message()).accepted, false);
  assert.deepEqual(f.get().state.topics, {});
});
test('retained online and playback alone never establish playing', () => {
  const f = fixture(); f.binding.onStatus(ready(1));
  f.binding.onMessage(message('online-state', { onlineState: 'connected' }, { retained: true }));
  f.binding.onMessage(message('playback/state', playing, { retained: true }));
  assert.equal(f.get().playback, 'unknown');
  assert.equal(f.get().freshness['playback/state'], 'retained');
  f.binding.onMessage(message('playback/state', playing));
  assert.equal(f.get().playback, 'playing');
});
test('same-session live online state outranks retained historical online', () => {
  const f = fixture(); active(f);
  const result = f.binding.onMessage(message('online-state', { onlineState: 'synthetic-offline' }, { retained: true }));
  assert.equal(result.accepted, false);
  assert.equal(f.get().playback, 'playing');
  assert.equal(f.get().state.topics['online-state'].value.onlineState, 'connected');
});
test('accepted semantic duplicate changes freshness and can revoke playing', () => {
  const f = fixture(); active(f);
  const result = f.binding.onMessage(message('playback/state', playing, { retained: true, duplicate: true, receivedAtMs: 100001 }));
  assert.deepEqual(result, { accepted: true, changed: false });
  assert.equal(f.get().state.topics['playback/state'].receivedAtMs, 100001);
  assert.equal(f.get().playback, 'unknown');
  assert.deepEqual(f.notices.at(-1), { kind: 'message', changed: false });
});
test('unknown online values remain observations, not fabricated offline enums', () => {
  const f = fixture(); active(f);
  f.binding.onMessage(message('online-state', { onlineState: 'synthetic-future-state' }));
  assert.equal(f.get().state.topics['online-state'].value.onlineState, 'synthetic-future-state');
  assert.equal(f.get().playback, 'unknown');
});
test('settings false is preserved as a transient event without persistent configuration', () => {
  const f = fixture(); f.binding.onStatus(ready(1));
  f.binding.onMessage(message('settings-applied', { settingsApplied: false }));
  assert.equal(f.get().state.settingsEvent.value.settingsApplied, false);
  assert.equal(f.get().state.topics['settings-applied'], undefined);
  assert.equal(f.get().settingsFreshness, 'observed');
});
test('position/countdown reuse actual Increment 2 units and explicit time', () => {
  const f = fixture(); active(f);
  f.binding.onMessage(message('app-reply/bedtime-state', { stl: { state: 'on', until: 150 } }));
  const result = f.state.getDevice('SYNTHETIC_A', 100000);
  assert.equal(result.playbackPositionMs, 341566);
  assert.equal(result.sleepRemainingMs, 50000);
  assert.equal(f.get().playbackPositionMs, undefined);
});
test('no elapsed time creates automatic offline/expiry state', () => {
  const f = fixture(); active(f);
  assert.equal(f.state.getDevice('SYNTHETIC_A', 999999999999).freshness['online-state'], 'observed');
});
test('topics/devices stay independent and partial payloads replace fields', () => {
  const f = fixture({}, plan({}, ['SYNTHETIC_A', 'SYNTHETIC_B'])); active(f);
  f.binding.onMessage(message('playback/state', { paused: true }));
  assert.deepEqual(f.get().state.topics['playback/state'].value, { paused: true });
  assert.equal(f.get().state.topics['online-state'].value.onlineState, 'connected');
  assert.deepEqual(f.state.getDevice('SYNTHETIC_B').state.topics, {});
});
test('route removal and later reappearance start fresh', () => {
  const f = fixture(); active(f);
  f.state.bind(plan({}, []));
  assert.equal(f.get(), undefined);
  const next = f.state.bind(plan()).binding; next.onStatus(ready(1));
  assert.deepEqual(f.get().state.topics, {});
  assert.equal(f.state.getStatus().stateSession, 2);
});
for (const field of ['macAddress', 'routeId', 'householdId']) {
  test('confirmed ' + field + ' replacement cannot inherit identity state', () => {
    const f = fixture(); active(f);
    const next = structuredClone({ ...plan(), context: undefined }); next.context = context;
    const route = next.routes[0];
    route[field] = 'SYNTHETIC_CHANGED';
    if (field === 'macAddress') {
      route.identity.macAddress = route.macAddress;
    }
    if (field === 'routeId') {
      route.identity.id = route.routeId;
    }
    const binding = f.state.bind(next).binding; binding.onStatus(ready(1));
    assert.deepEqual(f.state.getDevice(route.routeId).state.topics, {});
  });
}
test('display-name metadata changes preserve last-known state only for identical authority', () => {
  const f = fixture(); active(f);
  const next = { ...plan(), routes: plan().routes.map(r => ({ ...r, identity: { ...r.identity, name: 'SYNTHETIC_RENAME' } })) };
  const binding = f.state.bind(next).binding;
  assert.equal(f.get().state.identity.name, 'SYNTHETIC_RENAME');
  assert.equal(f.get().freshness['playback/state'], 'last-known');
  binding.onStatus(ready(1));
  assert.equal(f.get().playback, 'unknown');
});
test('experimental and production namespaces never share retained state', () => {
  const f = fixture(); active(f);
  const binding = f.state.bind(plan({ lane: 'experimental' })).binding;
  binding.onStatus(ready(1));
  assert.deepEqual(f.get().state.topics, {});
});
test('getters and inputs are detached from internal identity, state and transport', () => {
  const mutable = { ...plan(), routes: plan().routes.map(r => ({ ...r, identity: { ...r.identity, features: [...r.identity.features] } })) };
  const f = fixture({}, mutable); active(f);
  mutable.routes[0].identity.features.push('mutation');
  const view = f.get(); view.state.topics['playback/state'].value.paused = true; view.transport.session = 900;
  view.state.identity.features.push('another');
  const status = f.state.getStatus(); status.phase = 'invalidated';
  assert.equal(f.get().playback, 'playing');
  assert.deepEqual(f.get().state.identity.features, ['playbackControls']);
  assert.equal(f.state.getStatus().phase, 'connected');
});
test('state generation exhaustion fails closed without wrapping or replacement bypass', () => {
  const f = fixture({ sessionSeed: Number.MAX_SAFE_INTEGER - 1 });
  f.binding.onStatus(ready(1));
  assert.equal(f.state.getStatus().stateSession, Number.MAX_SAFE_INTEGER);
  f.binding.onStatus({ phase: 'waiting-retry', connected: false });
  assert.equal(f.binding.onStatus(ready(2)).reason, 'generation-exhausted');
  assert.equal(f.binding.onMessage(message('volume/state', { level: 9 }, { session: 2 })).accepted, false);
  assert.equal(f.state.bind(plan()).ok, false);
  assert.throws(() => nextStateSession(Number.MAX_SAFE_INTEGER), /State session exhausted/);
  f.state.invalidate(); assert.equal(f.get(), undefined);
});
for (const raw of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test('invalid state seed rejected: ' + raw, () => {
    assert.throws(() => createBackendState({ context, sessionSeed: raw }), /Invalid backend state options/);
  });
}
for (const status of [
  { phase: 'ready', connected: false, session: 1 }, { phase: 'ready', connected: true, session: 0 },
  { phase: 'ready', connected: true, session: 0.5 }, { phase: 'ready', connected: true },
  { phase: 'future', connected: false }, { phase: 'connecting', connected: false, session: 1 },
]) {
  test('invalid status fails current binding closed: ' + JSON.stringify(status), () => {
    const f = fixture(); active(f);
    assert.equal(f.binding.onStatus(status).reason, 'invalid-status');
    assert.equal(f.get().freshness['playback/state'], 'last-known');
    assert.equal(f.binding.onMessage(message()).accepted, false);
  });
}

test('observer reentrancy can replace authority during readiness without an outer write restoring it', () => {
  let state, nextBinding;
  state = createBackendState({ context, onChange: notice => {
    if (notice.kind === 'transport' && !nextBinding) {
      nextBinding = state.bind(plan()).binding;
    }
  } });
  const old = state.bind(plan()).binding;
  old.onStatus(ready(1));
  assert.equal(old.onMessage(message()).accepted, false);
  assert.equal(state.getStatus().phase, 'disconnected');
  nextBinding.onStatus(ready(1));
  assert.equal(state.getStatus().stateSession, 2);
});
test('state is committed before observer reads or invalidates the account', () => {
  let state;
  state = createBackendState({ context, onChange: notice => {
    if (notice.kind === 'message') {
      assert.equal(state.getDevice('SYNTHETIC_A').state.topics['volume/state'].value.level, 4);
      state.invalidate();
    }
  } });
  const binding = state.bind(plan()).binding;
  binding.onStatus(ready(1)); binding.onMessage(message());
  assert.equal(state.getDevice('SYNTHETIC_A'), undefined);
  assert.equal(binding.onMessage(message()).accepted, false);
});
for (const observer of [
  () => {
    throw new Error('SYNTHETIC_PRIVATE_EXCEPTION');
  },
  () => Promise.reject(new Error('SYNTHETIC_PRIVATE_REJECTION')),
]) {
  test('observer exception is contained without rollback or secret diagnostics: ' + observer.toString().includes('reject'), async () => {
    const f = fixture({ onChange: observer }); active(f); await nextTurn();
    assert.equal(f.get().playback, 'playing');
    assert.doesNotMatch(JSON.stringify(f.state.getStatus()), /SYNTHETIC/);
    f.state.invalidate(); f.state.invalidate(); await nextTurn();
    assert.equal(f.get(), undefined);
  });
}
test('public notices expose no account, route, device, payload or content values', () => {
  const f = fixture(); active(f);
  assert.doesNotMatch(JSON.stringify({ status: f.state.getStatus(), notices: f.notices }), /SYNTHETIC/);
  assert.ok(f.notices.every(notice => Object.keys(notice).every(key => ['kind', 'changed'].includes(key))));
});
test('invalid plans do not disturb a healthy binding', () => {
  const f = fixture(); active(f);
  const invalid = plan({ routes: [{ routeId: 'BAD', macAddress: 'BAD/ROUTE' }] });
  assert.equal(f.state.bind(invalid).ok, false);
  assert.equal(f.get().playback, 'playing');
  assert.equal(f.binding.onMessage(message()).accepted, true);
});
test('empty route plan cannot acquire readiness', () => {
  const f = fixture({}, plan({}, []));
  assert.equal(f.binding.onStatus(ready(1)).reason, 'invalid-status');
  assert.equal(f.state.getStatus().devices, 0);
});
test('terminal lifecycle statuses revoke binding but preserve detached last-known observations', () => {
  const f = fixture(); active(f);
  f.binding.onStatus({ phase: 'attention-required', connected: false, error: { kind: 'authentication-refused' } });
  assert.equal(f.get().freshness['playback/state'], 'last-known');
  assert.equal(f.binding.onStatus(ready(2)).accepted, false);
  const next = f.state.bind(plan()).binding;
  next.onStatus(ready(1));
  assert.equal(f.state.getStatus().stateSession, 2);
});
test('actual 5A + 5B deliver first buffered message into mapped state before connect settlement', async () => {
  const { EventEmitter, getEventListeners } = await import('node:events');
  const { Buffer } = await import('node:buffer');
  const controller = new AbortController();
  const f = fixture();
  const jobs = new Set();
  const scheduler = { schedule(fn) {
    jobs.add(fn); return () => jobs.delete(fn);
  } };
  let client;
  const lifecycle = createMqttLifecycle({
    accountUuid: 'SYNTHETIC_ACCOUNT', routes: plan().routes, contextSignal: controller.signal,
    tokenProvider: { getAccessToken: async () => ({ ok: true, tokenType: 'Bearer', accessToken: 'SYNTHETIC_ACCESS', remainingLifetimeMs: 300000 }) },
    onStatus: f.binding.onStatus, onMessage: f.binding.onMessage,
    clock: { now: () => 0 }, scheduler, jitter: () => 0.5,
    transportFactory: callbacks => createMqttTransport({
      ...callbacks, clock: { now: () => ({ monotonicMs: 0, wallMs: 100000 }) }, scheduler,
      clientFactory: (_builder, options) => {
        client = new EventEmitter(); client.options = options;
        client.connect = () => client; client.end = () => client;
        client.subscribe = (request, callback) => {
          client.request = request; client.ack = callback; return client;
        };
        return client;
      },
    }),
  });
  try {
    lifecycle.start();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    assert.equal(lifecycle.getStatus().phase, 'connecting');
    client.emit('connect', { reasonCode: 0, sessionPresent: false });
    client.emit('message', message().topic, Buffer.from('{"level":4}'), { retain: true, dup: false, qos: 1 });
    assert.deepEqual(f.get().state.topics, {});
    client.ack(null, Object.keys(client.request).map(topic => ({ topic, qos: 1 })));
    // No await: the retained message has already crossed both actual earlier components.
    assert.equal(f.get().state.topics['volume/state'].session, 1);
    assert.equal(f.get().freshness['volume/state'], 'retained');
    assert.equal(f.state.getStatus().stateSession, lifecycle.getStatus().session);
    assert.equal(client.options.reconnectPeriod, 0);
    controller.abort();
    assert.equal(f.get().freshness['volume/state'], 'last-known');
  } finally {
    lifecycle.stop(); f.state.invalidate(); controller.abort();
    assert.equal(jobs.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    for (const event of ['connect', 'close', 'disconnect', 'message']) {
      assert.equal(client?.listenerCount(event), 0);
    }
  }
});

test('ignored retained online history is distinct from malformed input', () => {
  const f = fixture(); active(f);
  const result = f.binding.onMessage(message('online-state', { onlineState: 'connected' }, { retained: true }));
  assert.equal(result.reason, 'ignored-history');
});
test('malformed features in a purported approved plan are rejected without throwing', () => {
  const f = fixture(); active(f);
  const malformed = { ...plan(), routes: plan().routes.map(r => ({ ...r, identity: { ...r.identity, features: 42 } })) };
  assert.deepEqual(f.state.bind(malformed), { ok: false, reason: 'invalid-plan' });
  assert.equal(f.get().playback, 'playing');
});
test('ready observer invalidation prevents immediately following buffered delivery', () => {
  let state;
  state = createBackendState({ context, onChange: event => {
    if (event.kind === 'transport') {
      state.invalidate();
    }
  } });
  const binding = state.bind(plan()).binding;
  binding.onStatus(ready(1));
  assert.equal(binding.onMessage(message()).accepted, false);
  assert.equal(state.getDevice('SYNTHETIC_A'), undefined);
});
test('message observer reentrancy commits nested updates without outer overwrite', () => {
  let state, binding, calls = 0;
  state = createBackendState({ context, onChange: event => {
    if (event.kind === 'message' && calls++ === 0) {
      binding.onMessage(message('volume/state', { level: 8 }, { receivedAtMs: 100001 }));
    }
  } });
  binding = state.bind(plan()).binding;
  binding.onStatus(ready(1)); binding.onMessage(message());
  assert.equal(state.getDevice('SYNTHETIC_A').state.topics['volume/state'].value.level, 8);
});

for (const connected of [false, true]) {
  test('lifecycle attention is observable even before initial readiness: ' + connected, () => {
    const f = fixture();
    if (connected) {
      active(f);
    }
    const before = f.notices.length;
    const outcome = f.binding.onStatus({ phase: 'attention-required', connected: false, error: { kind: 'authentication-refused' } });
    assert.deepEqual(outcome, { accepted: true, changed: true });
    assert.deepEqual(f.state.getStatus(), { phase: 'attention-required', devices: 1 });
    assert.equal(f.notices.length, before + 1);
    assert.deepEqual(f.notices.at(-1), { kind: 'transport' });
    assert.equal(f.binding.onStatus(ready(2)).accepted, false);
    assert.equal(f.binding.onMessage(message()).accepted, false);
    if (connected) {
      assert.equal(f.get().freshness['playback/state'], 'last-known');
    }
    const next = f.state.bind(plan()).binding;
    next.onStatus(ready(1));
    assert.equal(f.state.getStatus().phase, 'connected');
  });
}
