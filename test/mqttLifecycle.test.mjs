import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

let createMqttLifecycle;
let nextMqttSession;
let createMqttTransport;
let createTokenManager;
let forbiddenTotal = 0;
let forbiddenTest = 0;
const { AbortController } = globalThis;
const secret = 'SYNTHETIC_PRIVATE_VALUE';
const routePlan = [{ routeId: 'SYNTHETIC_ROUTE', macAddress: 'SYNTHETIC_MAC' }];
const access = (remainingLifetimeMs = 300000, accessToken = 'SYNTHETIC_TOKEN', revision = 1) =>
  ({ ok: true, tokenType: 'Bearer', remainingLifetimeMs, accessToken, revision });
const failure = kind => ({ ok: false, error: { kind } });
const message = {
  routeId: routePlan[0].routeId, topic: 'external/toniebox/SYNTHETIC_MAC/volume/state',
  payload: new Uint8Array([1, 2, 3]), retained: true, qos: 1, duplicate: true, receivedAtMs: 1800000000000,
};
before(async () => {
  const forbidden = () => {
    forbiddenTotal++; forbiddenTest++;
    throw new Error('Forbidden network or timer');
  };
  mock.method(net.Socket.prototype, 'connect', forbidden);
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(globalThis, 'setTimeout', forbidden);
  mock.method(globalThis, 'setInterval', forbidden);
  ({ createMqttLifecycle, nextMqttSession } = await import('../dist/toniebox/mqttLifecycle.js'));
  ({ createMqttTransport } = await import('../dist/toniebox/mqttTransport.js'));
  ({ createTokenManager } = await import('../dist/toniebox/tokenManager.js'));
});
beforeEach(() => {
  forbiddenTest = 0;
});
afterEach(async () => {
  await nextTurn();
  assert.equal(forbiddenTest, 0, 'Forbidden calls must fail even if their exception was sanitised');
});
after(async () => {
  try {
    await nextTurn();
    assert.equal(forbiddenTotal, 0, 'Includes late calls outside individual test hooks');
  } finally {
    mock.restoreAll();
  }
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes; reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
function fixture(t, overrides = {}) {
  let mono = 0;
  let maxTimers = 0;
  const context = new AbortController();
  const jobs = new Set();
  const history = [];
  const tokenCalls = [];
  const tokens = [];
  const transports = [];
  const statuses = [];
  const messages = [];
  const clock = { now: () => mono };
  const scheduler = { schedule(callback, ms) {
    const job = { callback, ms, at: mono + ms };
    jobs.add(job); history.push(job);
    maxTimers = Math.max(maxTimers, jobs.size);
    return () => jobs.delete(job);
  } };
  const observers = new Set();
  let credentialStatus = { renewal: 'ready', operation: 'idle', access: 'usable' };
  let credential = access();
  const provider = {
    getStatus: () => ({ ...credentialStatus }),
    observeCredentials(observer, { signal } = {}) {
      observers.add(observer);
      const remove = () => {
        observers.delete(observer); signal?.removeEventListener('abort', remove);
      };
      signal?.addEventListener('abort', remove, { once: true });
      void Promise.resolve().then(() => {
        if (observers.has(observer)) {
          observer({ revision: credential.revision, status: credentialStatus });
        }
      });
      return remove;
    },
    getAccessToken(request) {
      tokenCalls.push(request);
      const value = tokens.length ? tokens.shift() : credential;
      return typeof value === 'function' ? value(request) : Promise.resolve(value);
    } };
  const factory = callbacks => {
    assert.ok(transports.every(value => value.closes > 0), 'Previous transport must be closed first');
    const pending = deferred();
    const value = {
      callbacks, pending, calls: [], closes: 0, phase: 'idle',
      connect(credentials, routes, options) {
        this.calls.push({ credentials, routes, options });
        this.phase = 'connecting';
        callbacks.onStatus({ phase: 'connecting' });
        return pending.promise;
      },
      getStatus() {
        return { phase: this.phase };
      },
      close() {
        this.closes++;
        this.phase = 'closed';
        callbacks.onStatus({ phase: 'closed', error: { kind: 'closed' } });
      },
      ready() {
        this.phase = 'ready';
        callbacks.onStatus({ phase: 'ready' });
      },
      fail(kind = 'transport') {
        this.phase = 'closed';
        callbacks.onStatus({ phase: 'closed', error: { kind, private: secret } });
        pending.resolve(failure(kind));
      },
    };
    transports.push(value);
    return value;
  };
  const options = {
    tokenProvider: provider, accountUuid: 'SYNTHETIC_UUID', routes: routePlan, contextSignal: context.signal,
    onMessage: value => messages.push(value), onStatus: value => statuses.push(value),
    clock, scheduler, jitter: () => 0.5, transportFactory: factory, ...overrides,
  };
  const lifecycle = createMqttLifecycle(options);
  t.after(() => {
    lifecycle.stop();
    assert.equal(jobs.size, 0);
    assert.ok(maxTimers <= 1, 'Overlapping lifecycle timers');
    assert.equal(getEventListeners(options.contextSignal, 'abort').length, 0);
    assert.ok(tokenCalls.every(call => call.signal.aborted), 'Unreleased attempt cancellation authority');
    assert.ok(transports.every(value => value.closes > 0), 'Unclosed transport');
  });
  return {
    lifecycle, context, jobs, history, tokenCalls, tokens, transports, statuses, messages, options, scheduler, provider, factory,
    renew(revision, status = credentialStatus) {
      credential = access(300000, 'SYNTHETIC_TOKEN_' + revision, revision);
      credentialStatus = status;
      for (const observer of observers) {
        observer({ revision, status });
      }
    },
    observers,
    setTime(value) {
      mono = value;
    },
    get mono() {
      return mono;
    },
    async start() {
      assert.equal(lifecycle.start(), undefined);
      await flush();
    },
    async advance(ms) {
      mono += ms;
      for (const job of [...jobs]) {
        if (job.at <= mono && jobs.delete(job)) {
          job.callback();
        }
      }
      await flush();
    },
    get transport() {
      return transports.at(-1);
    },
  };
}
test('inert import/construction, copied status and non-blocking idempotent start', async t => {
  const f = fixture(t);
  assert.deepEqual(f.lifecycle.getStatus(), { phase: 'idle', connected: false });
  assert.deepEqual(Object.keys(Object.getPrototypeOf(f.lifecycle)), []);
  assert.equal(f.jobs.size, 0); assert.equal(f.tokenCalls.length, 0);
  const pending = deferred(); f.tokens.push(pending.promise);
  for (let i = 0; i < 100; i++) {
    f.lifecycle.start();
  }
  assert.equal(f.tokenCalls.length, 1); assert.equal(f.transports.length, 0);
  pending.resolve(access()); await flush();
  assert.equal(f.transports.length, 1);
});
test('token precedes connection; ready assigns first session before buffered delivery or promise settlement', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.tokenCalls.length, 1);
  assert.equal(f.lifecycle.getStatus().phase, 'connecting');
  f.transport.ready(); f.transport.callbacks.onMessage(message);
  assert.deepEqual(f.messages, [{ ...message, session: 1 }]);
  assert.deepEqual(f.lifecycle.getStatus(), { phase: 'ready', connected: true, session: 1 });
  f.transport.pending.resolve({ ok: true }); await flush();
  assert.equal(f.messages.length, 1);
});
test('ready notification can reenter ready without allocating another session', async t => {
  let f;
  let notifications = 0;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'ready') {
      notifications++; f.transport.ready();
    }
  } });
  await f.start(); f.transport.ready(); f.transport.ready();
  assert.equal(notifications, 1); assert.equal(f.lifecycle.getStatus().session, 1);
});
test('healthy connection has no token polling without a credential notification', async t => {
  const f = fixture(t); await f.start(); f.transport.ready(); f.transport.pending.resolve({ ok: true });
  f.tokens.push(access(300000, 'SYNTHETIC_REPLACEMENT'));
  await f.advance(86400000);
  assert.equal(f.tokenCalls.length, 1); assert.equal(f.jobs.size, 0); assert.equal(f.transport.closes, 0);
  f.transport.callbacks.onMessage(message); assert.equal(f.messages.length, 1);
});
test('reconnect closes old transport, reacquires token and reserves distinct ready generation', async t => {
  const f = fixture(t); await f.start(); const old = f.transport;
  old.ready(); old.pending.resolve({ ok: true }); await flush();
  old.fail(); assert.equal(old.closes, 1); assert.equal(f.lifecycle.getStatus().session, undefined);
  f.tokens.push(access(300000, 'SYNTHETIC_NEW_TOKEN'));
  await f.advance(10000);
  assert.equal(f.tokenCalls.length, 2);
  assert.equal(f.transport.calls[0].credentials.accessToken, 'SYNTHETIC_NEW_TOKEN');
  f.transport.ready(); f.transport.callbacks.onMessage(message);
  old.ready(); old.callbacks.onMessage({ ...message, payload: new Uint8Array([9]) }); old.fail();
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].session, 2);
});
test('backoff follows 10/20/40/60/120/300 seconds and stays capped across repeated attempts', async t => {
  const f = fixture(t); await f.start();
  for (const ms of [10000, 20000, 40000, 60000, 120000, 300000, 300000, 300000]) {
    f.transport.fail();
    assert.equal(f.lifecycle.getStatus().retryAfterMs, ms);
    const count = f.tokenCalls.length;
    for (let i = 0; i < 100; i++) {
      f.lifecycle.start();
    }
    await f.advance(ms - 1); assert.equal(f.tokenCalls.length, count);
    await f.advance(1); assert.equal(f.tokenCalls.length, count + 1);
  }
});
for (const [random, first, second, capped] of [[0, 10000, 16000, 240000], [0.5, 10000, 20000, 300000], [1, 12000, 24000, 300000]]) {
  test('jitter is bounded and deterministic at ' + random, async t => {
    const f = fixture(t, { jitter: () => random }); await f.start();
    for (let i = 0; i < 7; i++) {
      f.transport.fail(); const ms = f.lifecycle.getStatus().retryAfterMs;
      assert.ok(ms >= 10000 && ms <= 300000);
      if (i === 0) {
        assert.equal(ms, first);
      }
      if (i === 1) {
        assert.equal(ms, second);
      }
      if (i >= 5) {
        assert.equal(ms, capped);
      }
      await f.advance(ms);
    }
  });
}
for (const stable of [false, true]) {
  test('backoff resets only after five continuous ready minutes: ' + stable, async t => {
    const f = fixture(t); await f.start(); f.transport.fail(); await f.advance(10000);
    f.transport.ready(); await f.advance(stable ? 300000 : 299999);
    f.transport.fail();
    assert.equal(f.lifecycle.getStatus().retryAfterMs, stable ? 10000 : 20000);
  });
}
test('duplicate close/status and late promise failure cannot create parallel retries', async t => {
  const f = fixture(t); await f.start(); const old = f.transport;
  old.fail(); old.fail(); old.callbacks.onStatus({ phase: 'ready' });
  old.pending.reject(new Error(secret)); await flush();
  assert.equal(f.jobs.size, 1); assert.equal(f.history.length, 1);
  await f.advance(10000); assert.equal(f.transports.length, 2);
});
for (const ms of [1, 15000, 30000, 30999]) {
  test('short usable token waits without creating a transport or bypassing 3B: ' + ms, async t => {
    const f = fixture(t); f.tokens.push(access(ms)); await f.start();
    assert.equal(f.transports.length, 0);
    assert.equal(f.lifecycle.getStatus().error.kind, 'insufficient-lifetime');
    for (let i = 0; i < 200; i++) {
      f.lifecycle.start();
    }
    assert.equal(f.tokenCalls.length, 1);
    await f.advance(10000); assert.equal(f.tokenCalls.length, 2);
  });
}
test('31-second lifetime is accepted; acquisition duration is not subtracted twice', async t => {
  const f = fixture(t); const pending = deferred(); f.tokens.push(pending.promise); await f.start();
  f.setTime(200000); pending.resolve(access(31000)); await flush();
  assert.equal(f.transports.length, 1); assert.equal(f.transport.calls.length, 1);
});
test('owner callback latency is subtracted before CONNECT dispatch', async t => {
  let f;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'connecting') {
      f.setTime(2000);
    }
  } });
  f.tokens.push(access(32000)); await f.start();
  assert.equal(f.transport.calls.length, 0); assert.equal(f.transport.closes, 1);
  assert.equal(f.lifecycle.getStatus().error.kind, 'insufficient-lifetime');
});
test('backoff honours token-manager minimum delay; long delays clamp individual timers without early dispatch', async t => {
  const f = fixture(t); f.tokens.push({ ok: false, error: { kind: 'backoff', retryAfterMs: 2147484000 } });
  await f.start(); assert.equal(f.history[0].ms, 2147483647);
  await f.advance(2147483647); assert.equal(f.tokenCalls.length, 1); assert.equal(f.jobs.size, 1);
  await f.advance(353); assert.equal(f.tokenCalls.length, 2);
});
for (const kind of ['invalid-input', 'cancelled', 'stopped', 'credentials-required', 'reauthorization-required',
  'authentication-failed', 'rate-limited', 'refresh-recovery-exhausted', 'insufficient-lifetime', 'clock-invalid']) {
  test('token failure requires attention without login/refresh manipulation: ' + kind, async t => {
    const f = fixture(t); f.tokens.push({ ok: false, error: { kind, retryAfterMs: 3600000, raw: secret } });
    await f.start();
    assert.deepEqual(f.lifecycle.getStatus(), {
      phase: 'attention-required', connected: false, error: { kind: 'token', tokenFailure: kind },
    });
    await f.advance(86400000); f.lifecycle.start();
    assert.equal(f.tokenCalls.length, 1); assert.equal(f.jobs.size, 0);
  });
}
test('token invalidation terminally stops the immutable account context', async t => {
  const f = fixture(t); f.tokens.push(failure('invalidated')); await f.start();
  assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
for (const kind of ['invalid-input', 'closed', 'cancelled', 'protocol', 'subscription-refused',
  'authentication-refused', 'resource-limit', 'unsafe-tracing', 'dependency']) {
  test('terminal MQTT failure is not retried: ' + kind, async t => {
    const f = fixture(t); await f.start(); f.transport.fail(kind); await flush();
    assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
    assert.equal(f.lifecycle.getStatus().error.kind, kind);
    await f.advance(86400000); f.lifecycle.start(); assert.equal(f.tokenCalls.length, 1);
  });
}
test('connection timeout is recoverable', async t => {
  const f = fixture(t); await f.start(); f.transport.fail('timeout');
  assert.equal(f.lifecycle.getStatus().retryAfterMs, 10000); await f.advance(10000);
  assert.equal(f.tokenCalls.length, 2);
});
for (const raw of [undefined, null, {}, { ok: 'yes' }, access(0), access(-1), access(Infinity), access(NaN),
  access(Number.MAX_SAFE_INTEGER + 1), access(300000, ''), access(300000, 'bad token'),
  { ...access(), tokenType: 'Other' }, failure('secret-kind'), { ok: false, error: { kind: 'backoff', retryAfterMs: -1 } }]) {
  test('invalid token-provider result is sanitised ' + JSON.stringify(raw), async t => {
    const f = fixture(t); f.tokens.push(raw); await f.start();
    assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
    assert.equal(f.transports.length, 0); assert.equal(f.jobs.size, 0);
  });
}
for (const action of ['stop', 'abort']) {
  for (const stage of ['idle', 'token', 'connecting', 'ready', 'retry']) {
    test(action + ' at ' + stage + ' promptly revokes all authority', async t => {
      const f = fixture(t); const pending = deferred();
      if (stage === 'token') {
        f.tokens.push(pending.promise);
      }
      if (stage !== 'idle') {
        await f.start();
      }
      if (stage === 'ready' || stage === 'retry') {
        f.transport.ready();
      }
      if (stage === 'retry') {
        f.transport.fail();
      }
      const jobs = [...f.jobs];
      if (action === 'stop') {
        f.lifecycle.stop();
      } else {
        f.context.abort();
      }
      const count = f.statuses.length;
      assert.equal(f.lifecycle.getStatus().phase, 'stopped'); assert.equal(f.jobs.size, 0);
      pending.resolve(access(300000, secret));
      for (const old of f.transports) {
        old.ready(); old.callbacks.onMessage(message); old.pending.resolve({ ok: true }); old.fail();
      }
      for (const job of jobs) {
        job.callback();
      }
      f.lifecycle.start(); f.lifecycle.stop(); await flush();
      assert.equal(f.messages.length, 0); assert.equal(f.statuses.length, count);
    });
  }
}
test('late rejection of abandoned token promise is observed and does not affect a new account instance', async t => {
  const a = fixture(t); const pending = deferred(); a.tokens.push(pending.promise); await a.start();
  a.context.abort();
  const b = fixture(t); b.tokens.push(access(300000, 'SYNTHETIC_ACCOUNT_B')); await b.start(); b.transport.ready();
  pending.reject(new Error(secret)); await flush();
  assert.equal(b.transport.calls[0].credentials.accessToken, 'SYNTHETIC_ACCOUNT_B');
  assert.equal(b.lifecycle.getStatus().phase, 'ready');
});
test('late transport rejection is consumed after terminal stop', async t => {
  const f = fixture(t); await f.start(); f.lifecycle.stop(); f.transport.pending.reject(new Error(secret)); await flush();
  assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
test('ready owner can stop before first buffered message', async t => {
  let f;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'ready') {
      f.lifecycle.stop();
    }
  } });
  await f.start(); f.transport.ready(); f.transport.callbacks.onMessage(message);
  assert.equal(f.messages.length, 0); assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
test('message owner exception fails closed without raw exception exposure', async t => {
  const f = fixture(t, { onMessage() {
    throw new Error(secret);
  } });
  await f.start(); f.transport.ready(); f.transport.callbacks.onMessage(message);
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
  assert.ok(!JSON.stringify(f.statuses).includes(secret));
});
test('throwing observational status callback is contained during startup and cleanup', async t => {
  const f = fixture(t, { onStatus() {
    throw new Error(secret);
  } });
  await f.start(); f.transport.ready(); f.lifecycle.stop();
  assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
test('status copies cannot mutate internal errors or publish secrets', async t => {
  const f = fixture(t); await f.start(); f.transport.fail('authentication-refused');
  const copy = f.lifecycle.getStatus(); copy.phase = 'ready'; copy.error.kind = secret;
  assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
  for (const privateValue of [secret, 'SYNTHETIC_UUID', 'SYNTHETIC_TOKEN', routePlan[0].macAddress, message.topic]) {
    assert.ok(!JSON.stringify(f.statuses).includes(privateValue));
  }
});
test('route authority and account inputs are snapshotted and frozen', async t => {
  const routes = [{ ...routePlan[0] }]; const f = fixture(t, { routes });
  routes[0].macAddress = 'OTHER'; routes.push({ routeId: 'x', macAddress: 'y' });
  f.options.accountUuid = 'OTHER_ACCOUNT';
  await f.start();
  const call = f.transport.calls[0];
  assert.deepEqual(call.routes, routePlan); assert.ok(Object.isFrozen(call.routes)); assert.ok(Object.isFrozen(call.routes[0]));
  assert.equal(call.credentials.uuid, 'SYNTHETIC_UUID');
});
for (const options of [
  { routes: [] }, { routes: null }, { routes: [{ routeId: 'a', macAddress: 'bad/route' }] },
  { routes: [{ routeId: 'a', macAddress: 'one' }, { routeId: 'b', macAddress: 'ONE' }] },
  { routes: [{ routeId: 'a', macAddress: 'one' }, { routeId: 'a', macAddress: 'two' }] },
  { accountUuid: '' }, { accountUuid: 'bad\nvalue' }, { contextSignal: null }, { tokenProvider: {} },
  { onMessage: null }, { transportFactory: 1 },
]) {
  test('invalid construction rejected safely ' + JSON.stringify(options), () => {
    assert.throws(() => createMqttLifecycle({
      tokenProvider: { getAccessToken: async () => access(), getStatus: () => ({ renewal: 'ready' }),
        observeCredentials: () => () => undefined }, routes: routePlan, accountUuid: 'SYNTHETIC',
      contextSignal: new AbortController().signal, onMessage() {}, ...options,
    }), { message: 'Invalid MQTT lifecycle options' });
  });
}
test('already-aborted context is terminal without any token or transport work', async t => {
  const context = new AbortController(); context.abort();
  const f = fixture(t, { contextSignal: context.signal }); await f.start();
  assert.equal(f.tokenCalls.length, 0); assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
test('synchronous provider throw is sanitised', async t => {
  const f = fixture(t); f.tokens.push(() => {
    throw new Error(secret);
  }); await f.start();
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
});
test('throwing result getter is sanitised; late getters are not evaluated', async t => {
  const value = { get ok() {
    throw new Error(secret);
  } };
  const f = fixture(t); f.tokens.push(value); await f.start();
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
  const g = fixture(t); const pending = deferred(); g.tokens.push(pending.promise); await g.start(); g.lifecycle.stop();
  pending.resolve(value); await flush(); assert.equal(g.lifecycle.getStatus().phase, 'stopped');
});
test('provider can synchronously invalidate context without creating a transport', async t => {
  const f = fixture(t); f.tokens.push(() => {
    f.context.abort(); return Promise.resolve(access());
  }); await f.start(); assert.equal(f.transports.length, 0);
});
test('transport constructed during reentrant cancellation is immediately closed', async t => {
  let f; let closes = 0;
  f = fixture(t, { transportFactory() {
    f.context.abort();
    return { close() {
      closes++;
    }, getStatus: () => ({ phase: 'idle' }), connect() {
      assert.fail('Must not connect');
    } };
  } });
  await f.start(); assert.equal(closes, 1); assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
for (const factory of [
  () => {
    throw new Error(secret);
  },
  () => null,
  () => ({ close() {}, connect() {}, getStatus: () => ({ phase: 'ready' }) }),
  () => ({ close() {}, connect() {
    throw new Error(secret);
  }, getStatus: () => ({ phase: 'idle' }) }),
  () => ({ close() {}, connect: () => Promise.reject(new Error(secret)), getStatus: () => ({ phase: 'idle' }) }),
]) {
  test('invalid or throwing factory/transport is terminal and sanitised ' + String(factory), async t => {
    const f = fixture(t, { transportFactory: factory }); await f.start();
    assert.equal(f.lifecycle.getStatus().error.kind, 'dependency'); assert.equal(f.jobs.size, 0);
  });
}
for (const result of [null, {}, { ok: 'yes' }, { ok: true }, failure(secret)]) {
  test('malformed completion or success without readiness is rejected ' + JSON.stringify(result), async t => {
    const f = fixture(t); await f.start(); f.transport.pending.resolve(result); await flush();
    assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
  });
}
test('message before ready is a terminal dependency contract failure', async t => {
  const f = fixture(t); await f.start(); f.transport.callbacks.onMessage(message);
  assert.equal(f.messages.length, 0); assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
});
test('phase regression after readiness is rejected', async t => {
  const f = fixture(t); await f.start(); f.transport.ready(); f.transport.callbacks.onStatus({ phase: 'subscribing' });
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
});
test('throwing close prevents reconnect because disposal cannot be confirmed', async t => {
  const f = fixture(t); await f.start();
  f.transport.close = () => {
    f.transport.closes++; throw new Error(secret);
  };
  f.transport.fail(); assert.equal(f.lifecycle.getStatus().error.kind, 'dependency'); assert.equal(f.jobs.size, 0);
});
for (const value of [NaN, Infinity, -1]) {
  test('invalid monotonic time fails closed: ' + value, async t => {
    const f = fixture(t, { clock: { now: () => value } }); await f.start();
    assert.equal(f.lifecycle.getStatus().error.kind, 'clock-invalid'); assert.equal(f.tokenCalls.length, 0);
  });
}
test('backward clock on disconnect fails closed; forward delay dispatches only once', async t => {
  const f = fixture(t); f.setTime(100); await f.start(); f.transport.ready(); f.setTime(99); f.transport.fail();
  assert.equal(f.lifecycle.getStatus().error.kind, 'clock-invalid');
  const g = fixture(t); await g.start(); g.transport.fail(); await g.advance(86400000);
  assert.equal(g.tokenCalls.length, 2);
});
test('throwing clock cannot leak its exception', async t => {
  const f = fixture(t, { clock: { now() {
    throw new Error(secret);
  } } }); await f.start(); assert.equal(f.lifecycle.getStatus().error.kind, 'clock-invalid');
});
for (const jitter of [() => -1, () => 2, () => NaN, () => {
  throw new Error(secret);
}]) {
  test('invalid jitter fails closed ' + String(jitter), async t => {
    const f = fixture(t, { jitter }); await f.start(); f.transport.fail();
    assert.equal(f.lifecycle.getStatus().error.kind, 'dependency'); assert.equal(f.jobs.size, 0);
  });
}
for (const schedule of [
  () => {
    throw new Error(secret);
  },
  () => undefined,
  callback => {
    callback(); return () => {};
  },
]) {
  test('scheduler contract failures cannot create synchronous retry loops ' + String(schedule), async t => {
    const f = fixture(t, { scheduler: { schedule } }); await f.start(); f.transport.fail();
    assert.equal(f.lifecycle.getStatus().error.kind, 'dependency'); assert.equal(f.tokenCalls.length, 1);
  });
}
test('early, duplicate and cancelled timer callbacks never advance retry eligibility', async t => {
  const f = fixture(t); await f.start(); f.transport.fail();
  const old = [...f.jobs][0]; f.jobs.delete(old); old.callback();
  const next = [...f.jobs][0];
  old.callback(); assert.equal(f.jobs.size, 1); assert.equal(f.tokenCalls.length, 1);
  await f.advance(10000); next.callback(); await flush(); assert.equal(f.tokenCalls.length, 2);
});
test('stop reentered from scheduler installation cleans returned timer handle', async t => {
  let f; let cancellations = 0;
  f = fixture(t, { scheduler: { schedule() {
    f.lifecycle.stop(); return () => {
      cancellations++;
    };
  } } }); await f.start(); f.transport.fail();
  assert.equal(cancellations, 1); assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});
test('default retry timer is unreferenced and cancelled', async t => {
  let unref = 0; const handles = new Set();
  const timerMock = mock.method(globalThis, 'setTimeout', () => {
    const handle = { unref() {
      unref++;
    } }; handles.add(handle); return handle;
  });
  const clearMock = mock.method(globalThis, 'clearTimeout', handle => handles.delete(handle));
  let f;
  try {
    f = fixture(t, { scheduler: undefined }); await f.start(); f.transport.fail();
    assert.equal(unref, 1); assert.equal(handles.size, 1); f.lifecycle.stop(); assert.equal(handles.size, 0);
  } finally {
    f?.lifecycle.stop(); timerMock.mock.restore(); clearMock.mock.restore();
  }
});
test('session allocation fails closed at the safe-integer boundary', () => {
  assert.equal(nextMqttSession(0), 1);
  assert.equal(nextMqttSession(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
  for (const v of [Number.MAX_SAFE_INTEGER, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => nextMqttSession(v), { message: 'MQTT session exhausted' });
  }
});
test('real 5A readiness drains retained messages with session before connect promise completion', async t => {
  let client;
  let f;
  const transportJobs = new Set();
  f = fixture(t, { transportFactory(callbacks) {
    return createMqttTransport({
      ...callbacks,
      clock: { now: () => ({ monotonicMs: f.mono, wallMs: 1800000000000 + f.mono }) },
      scheduler: { schedule(callback, ms) {
        const job = { callback, ms }; transportJobs.add(job); return () => transportJobs.delete(job);
      } },
      clientFactory: (_builder, options) => {
        client = new EventEmitter(); client.options = options;
        client.connect = () => client;
        client.end = () => client;
        client.subscribe = (request, callback) => {
          client.request = request; client.ack = callback; return client;
        };
        return client;
      },
    });
  } });
  await f.start();
  assert.equal(client.options.reconnectPeriod, 0); assert.equal(client.options.resubscribe, false);
  client.emit('connect', { reasonCode: 0, sessionPresent: false });
  client.emit('message', message.topic, Buffer.from([5]), { retain: true, dup: true, qos: 1 });
  assert.equal(f.messages.length, 0);
  client.ack(null, Object.keys(client.request).map(topic => ({ topic, qos: 1 })));
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].session, 1); assert.equal(f.messages[0].retained, true);
  assert.equal(f.messages[0].duplicate, true); assert.equal(f.messages[0].qos, 1);
  assert.equal(f.lifecycle.getStatus().phase, 'ready');
  await flush(); f.lifecycle.stop();
  assert.equal(transportJobs.size, 0);
  for (const name of ['connect', 'message', 'close', 'disconnect']) {
    assert.equal(client.listenerCount(name), 0);
  }
});
test('real 3B proactive refresh replaces the transport without an additional password grant', async t => {
  let mono = 0;
  const jobs = new Set(); let logins = 0; let refreshes = 0;
  const manager = createTokenManager({
    authClient: {
      async login() {
        logins++; return { ok: true, tokens: {
          accessToken: 'SYNTHETIC_FIRST', refreshToken: 'SYNTHETIC_REFRESH', tokenType: 'Bearer', expiresInSeconds: 300,
        } };
      },
      async refresh() {
        refreshes++; return { ok: true, tokens: {
          accessToken: 'SYNTHETIC_ROTATED', refreshToken: 'SYNTHETIC_REFRESH_NEW', tokenType: 'Bearer', expiresInSeconds: 300,
        } };
      },
    },
    clock: { now: () => ({ monotonicMs: mono, wallMs: 1800000000000 + mono }) },
    scheduler: { schedule(callback, ms) {
      const job = { callback, at: mono + ms }; jobs.add(job); return () => jobs.delete(job);
    } },
  });
  t.after(() => {
    manager.stop(); assert.equal(jobs.size, 0);
  });
  manager.setCredentials({ username: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' });
  const f = fixture(t, { tokenProvider: manager }); await f.start(); f.transport.ready(); f.transport.pending.resolve({ ok: true });
  mono = 240000; f.setTime(mono);
  for (const job of [...jobs]) {
    if (job.at <= mono && jobs.delete(job)) {
      job.callback();
    }
  }
  await flush(); assert.equal(logins, 1); assert.equal(refreshes, 1);
  assert.equal(f.lifecycle.getStatus().phase, 'connecting'); assert.equal(f.transports.length, 2);
  assert.equal(f.transports[0].closes, 1); f.transport.ready();
  f.transport.fail(); await f.advance(10000);
  assert.equal(f.transport.calls[0].credentials.accessToken, 'SYNTHETIC_ROTATED');
  f.lifecycle.stop(); assert.notEqual(manager.getStatus().renewal, 'stopped');
});


test('reentrant start during initial clock sampling cannot overlap token acquisition', async t => {
  let f;
  let samples = 0;
  f = fixture(t, { clock: { now() {
    samples++;
    f.lifecycle.start();
    return 0;
  } } });
  await f.start();
  assert.equal(f.tokenCalls.length, 1);
  assert.equal(f.transports.length, 1);
  assert.ok(samples < 10);
});

test('account invalidation while projecting a message prevents owner delivery', async t => {
  const f = fixture(t); await f.start(); f.transport.ready();
  f.transport.callbacks.onMessage({ ...message, get payload() {
    f.context.abort(); return message.payload;
  } });
  assert.equal(f.messages.length, 0);
  assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});

test('reentrant stop during terminal cleanup does not publish duplicate terminal statuses', async t => {
  const f = fixture(t); await f.start();
  const close = f.transport.close.bind(f.transport);
  f.transport.close = () => {
    f.lifecycle.stop(); close();
  };
  f.transport.fail('authentication-refused');
  assert.equal(f.lifecycle.getStatus().phase, 'stopped');
  assert.equal(f.statuses.filter(status => status.phase === 'stopped').length, 1);
  assert.equal(f.statuses.filter(status => status.phase === 'attention-required').length, 0);
});

test('stop from acquiring status prevents token dispatch', async t => {
  let f;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'acquiring-token') {
      f.lifecycle.stop();
    }
  } });
  await f.start(); assert.equal(f.tokenCalls.length, 0);
});

test('stop from connecting status prevents CONNECT', async t => {
  let f;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'connecting') {
      f.lifecycle.stop();
    }
  } });
  await f.start(); assert.equal(f.transport.calls.length, 0); assert.equal(f.transport.closes, 1);
});

test('stop from waiting status never schedules a retry', async t => {
  let f;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'waiting-retry') {
      f.lifecycle.stop();
    }
  } });
  await f.start(); f.transport.fail();
  assert.equal(f.jobs.size, 0); assert.equal(f.history.length, 0);
});

test('callback before factory returns violates inert factory contract and closes late resource', async t => {
  let closes = 0; let connects = 0;
  const f = fixture(t, { transportFactory(callbacks) {
    callbacks.onStatus({ phase: 'ready' });
    return {
      close() {
        closes++;
      }, getStatus: () => ({ phase: 'idle' }),
      connect() {
        connects++; return Promise.resolve({ ok: true });
      },
    };
  } });
  await f.start();
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
  assert.equal(closes, 1); assert.equal(connects, 0);
});

test('factory latency consumes remaining token lifetime before CONNECT', async t => {
  let f;
  f = fixture(t, { transportFactory(callbacks) {
    const transport = f.factory(callbacks); f.setTime(1001); return transport;
  } });
  f.tokens.push(access(32000)); await f.start();
  assert.equal(f.transport.calls.length, 0);
  assert.equal(f.lifecycle.getStatus().error.kind, 'insufficient-lifetime');
});

test('token backoff cannot be shortened by jitter or repeated explicit starts', async t => {
  const f = fixture(t, { jitter: () => 0 });
  f.tokens.push({ ok: false, error: { kind: 'backoff', retryAfterMs: 120000 } });
  await f.start();
  for (let i = 0; i < 200; i++) {
    f.lifecycle.start();
  }
  await f.advance(119999); assert.equal(f.tokenCalls.length, 1);
  await f.advance(1); assert.equal(f.tokenCalls.length, 2);
});

test('repeated short tokens remain bounded and terminal insufficient-lifetime cannot restart', async t => {
  const f = fixture(t);
  f.tokens.push(access(15000), access(5000), failure('insufficient-lifetime'));
  await f.start(); await f.advance(10000); await f.advance(20000);
  assert.equal(f.tokenCalls.length, 3); assert.equal(f.transports.length, 0);
  for (let i = 0; i < 200; i++) {
    f.lifecycle.start();
  }
  await f.advance(86400000);
  assert.equal(f.tokenCalls.length, 3); assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
});

test('many brief ready sessions do not reset progressive backoff', async t => {
  const f = fixture(t); await f.start();
  for (const ms of [10000, 20000, 40000, 60000, 120000, 300000]) {
    f.transport.ready(); await f.advance(1000); f.transport.fail();
    assert.equal(f.lifecycle.getStatus().retryAfterMs, ms);
    await f.advance(ms);
  }
});

test('late completion getters from an abandoned transport are never evaluated', async t => {
  const f = fixture(t); await f.start(); f.lifecycle.stop();
  let reads = 0;
  f.transport.pending.resolve({ get ok() {
    reads++; throw new Error('Late completion must not be inspected');
  } });
  await flush(); assert.equal(reads, 0); assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});

test('late connect rejection after a new ready connection cannot remove its authority', async t => {
  const f = fixture(t); await f.start(); const old = f.transport;
  old.callbacks.onStatus({ phase: 'closed', error: { kind: 'transport' } });
  await f.advance(10000); f.transport.ready();
  old.pending.reject(new Error(secret)); await flush();
  f.transport.callbacks.onMessage(message);
  assert.equal(f.messages.length, 1); assert.equal(f.messages[0].session, 1);
});

test('throwing timer cancellation still invalidates queued callbacks permanently', async t => {
  let job;
  const f = fixture(t, { scheduler: { schedule(callback) {
    job = callback; return () => {
      throw new Error(secret);
    };
  } } });
  await f.start(); f.transport.fail(); f.lifecycle.stop(); job(); await flush();
  assert.equal(f.tokenCalls.length, 1); assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});

test('independent attempt audit detects an exception hidden by dependency sanitisation', async t => {
  let attempts = 0;
  const f = fixture(t);
  f.tokens.push(() => {
    attempts++; throw new Error('Synthetic forbidden operation');
  });
  await f.start();
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
  // Audit outside lifecycle error handling still sees the forbidden invocation.
  assert.equal(attempts, 1);
});

test('status snapshot mutation during readiness cannot corrupt message session', async t => {
  const f = fixture(t); await f.start(); f.transport.ready();
  const status = f.lifecycle.getStatus(); status.session = 999; status.connected = false;
  f.transport.callbacks.onMessage(message);
  assert.equal(f.messages[0].session, 1);
  assert.equal(f.lifecycle.getStatus().connected, true);
});


test('failure revokes ready authority before jitter can reenter message or failure callbacks', async t => {
  let f; let jitterCalls = 0;
  f = fixture(t, { jitter() {
    jitterCalls++;
    f.transport.callbacks.onMessage(message);
    f.transport.callbacks.onStatus({ phase: 'closed', error: { kind: 'transport' } });
    return 0.5;
  } });
  await f.start(); f.transport.ready(); f.transport.fail();
  assert.equal(f.messages.length, 0); assert.equal(jitterCalls, 1); assert.equal(f.jobs.size, 1);
});

test('unexpected asynchronous message callback rejection is contained and fails closed', async t => {
  const f = fixture(t, { onMessage: async () => {
    throw new Error(secret);
  } });
  await f.start(); f.transport.ready(); f.transport.callbacks.onMessage(message); await flush();
  assert.equal(f.lifecycle.getStatus().error.kind, 'dependency');
});

test('unexpected asynchronous status callback rejection never becomes unhandled', async t => {
  const f = fixture(t, { onStatus: async () => {
    throw new Error(secret);
  } });
  await f.start(); f.transport.ready(); await flush(); f.lifecycle.stop(); await flush();
  assert.equal(f.lifecycle.getStatus().phase, 'stopped');
});

test('late owner callback rejection cannot terminate a replacement session', async t => {
  const pending = deferred();
  const f = fixture(t, { onMessage: () => pending.promise });
  await f.start(); f.transport.ready(); f.transport.callbacks.onMessage(message);
  f.transport.fail(); await f.advance(10000); f.transport.ready();
  pending.reject(new Error(secret)); await flush();
  assert.equal(f.lifecycle.getStatus().phase, 'ready'); assert.equal(f.lifecycle.getStatus().session, 2);
});


test('slow disposal does not turn a brief connection into a stable one', async t => {
  const f = fixture(t); await f.start(); f.transport.fail(); await f.advance(10000);
  f.transport.ready(); await f.advance(299999);
  const close = f.transport.close.bind(f.transport);
  f.transport.close = () => {
    f.setTime(f.mono + 2); close();
  };
  f.transport.fail(); assert.equal(f.lifecycle.getStatus().retryAfterMs, 20000);
});


function refusal(f, reasonCode = 135, origin = 'disconnect') {
  f.transport.callbacks.onStatus({ phase: 'closed', error: { kind: 'authentication-refused', reasonCode, origin } });
}
function established(f) {
  f.transport.ready(); f.transport.pending.resolve({ ok: true });
}

test('three proactive rotations preserve one transport and allocate sessions before first buffered messages', async t => {
  const f = fixture(t); await f.start(); established(f);
  for (let n = 2; n <= 4; n++) {
    const old = f.transport; await f.advance(240000); f.renew(n); f.renew(n); await flush();
    assert.equal(old.closes, 1); assert.equal(f.transports.length, n); assert.equal(f.tokenCalls.length, n);
    assert.equal(f.transport.calls[0].credentials.accessToken, 'SYNTHETIC_TOKEN_' + n);
    established(f); f.transport.callbacks.onMessage(message);
    old.callbacks.onMessage(message); old.callbacks.onStatus({ phase: 'ready' });
    assert.equal(f.messages.at(-1).session, n); assert.equal(f.messages.length, n - 1);
  }
  assert.equal(f.lifecycle.getStatus().session, 4);
});

test('same revision and failed/backoff renewal preserve a healthy transport without grants', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  f.renew(1); f.renew(1, { renewal: 'backoff', retryAfterMs: 30000 }); await flush();
  assert.equal(f.transports.length, 1); assert.equal(f.tokenCalls.length, 1); assert.equal(f.transport.closes, 0);
});

test('slow replacement acquisition preserves live delivery and coalesces newer notifications', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  const pending = deferred(); f.tokens.push(pending.promise); f.renew(2); await flush(); const old = f.transport;
  old.callbacks.onMessage(message); assert.equal(f.messages.length, 1); assert.equal(old.closes, 0);
  f.renew(3); f.renew(3); pending.resolve(access(300000, 'SYNTHETIC_TOKEN_3', 3)); await flush();
  established(f); await flush(); assert.equal(f.transports.length, 2); assert.equal(f.tokenCalls.length, 2);
});

test('renewal while connecting waits for readiness and enforces minimum CONNECT spacing', async t => {
  const f = fixture(t); await f.start(); f.renew(2); await flush(); assert.equal(f.transports.length, 1);
  established(f); f.transport.callbacks.onMessage(message); await flush();
  assert.equal(f.messages[0].session, 1); assert.equal(f.jobs.size, 1);
  await f.advance(9999); assert.equal(f.transports.length, 1);
  await f.advance(1); assert.equal(f.transports.length, 2);
});

test('renewal never shortens existing failure backoff', async t => {
  const f = fixture(t); await f.start(); f.transport.fail(); await f.advance(10000); f.transport.fail();
  f.renew(2); await flush(); await f.advance(19999); assert.equal(f.transports.length, 2);
  await f.advance(1); assert.equal(f.transports.length, 3);
  assert.equal(f.transport.calls[0].credentials.accessToken, 'SYNTHETIC_TOKEN_2');
});

for (const point of ['preparation', 'connecting', 'spacing', 'ready', 'recovery']) {
  for (const invalidation of [false, true]) {
    test('terminal cleanup during ' + point + (invalidation ? ' invalidation' : ' stop'), async t => {
      const f = fixture(t); await f.start(); established(f); const old = f.transport; const pending = deferred();
      if (point === 'recovery') {
        refusal(f);
      } else {
        if (point !== 'spacing') {
          await f.advance(240000);
        }
        if (point === 'preparation') {
          f.tokens.push(pending.promise);
        }
        f.renew(2); await flush();
        if (point === 'ready') {
          established(f);
        }
      }
      if (invalidation) {
        f.context.abort();
      } else {
        f.lifecycle.stop();
      }
      const count = f.transports.length; pending.resolve(access(300000, 'SYNTHETIC_LATE', 2));
      old.callbacks.onMessage(message); old.callbacks.onStatus({ phase: 'ready' });
      f.renew(3); await flush(); await f.advance(999999);
      assert.equal(f.transports.length, count); assert.equal(f.messages.length, 0);
      assert.equal(f.lifecycle.getStatus().phase, 'stopped'); assert.equal(f.observers.size, 0);
    });
  }
}

for (const origin of ['error', undefined, 'PRIVATE']) {
  test('post-ready authentication without proven DISCONNECT is terminal: ' + origin, async t => {
    const f = fixture(t); await f.start(); established(f);
    f.transport.callbacks.onStatus({ phase: 'closed', error: { kind: 'authentication-refused', reasonCode: 135, origin } });
    f.renew(2); await f.advance(300000); assert.equal(f.transports.length, 1);
    assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
    assert.doesNotMatch(JSON.stringify(f.lifecycle.getStatus()), /PRIVATE/);
  });
}
for (const code of [134, undefined, '135', 999]) {
  test('post-ready reason never implies expiry: ' + code, async t => {
    const f = fixture(t); await f.start(); established(f);
    f.transport.callbacks.onStatus({ phase: 'closed', error: { kind: 'authentication-refused', reasonCode: code, origin: 'disconnect' } });
    assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
  });
}

test('initial and proactively replaced pre-ready authentication refusal remain terminal', async t => {
  const a = fixture(t); await a.start(); refusal(a); assert.equal(a.lifecycle.getStatus().phase, 'attention-required');
  const f = fixture(t); await f.start(); established(f); await f.advance(240000); f.renew(2); await flush();
  refusal(f); f.renew(3); await f.advance(300000); assert.equal(f.transports.length, 2);
  assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
});

test('qualifying refusal waits without polling and never reuses rejected revision', async t => {
  const f = fixture(t); await f.start(); established(f); refusal(f); await f.advance(300000);
  assert.equal(f.transports.length, 1); assert.equal(f.tokenCalls.length, 1); assert.equal(f.jobs.size, 0);
  f.renew(1); await flush(); assert.equal(f.tokenCalls.length, 1);
  f.renew(2); await flush(); assert.equal(f.transports.length, 2);
  assert.equal(f.lifecycle.getStatus().replacement, 'recovery');
});

for (const readyFirst of [false, true]) {
  test('recovery credential rejection is terminal even after readiness: ' + readyFirst, async t => {
    const f = fixture(t); await f.start(); established(f); refusal(f);
    f.renew(2); await f.advance(10000); if (readyFirst) {
      established(f);
    }
    refusal(f); f.renew(3); await f.advance(300000);
    assert.equal(f.lifecycle.getStatus().phase, 'attention-required'); assert.equal(f.transports.length, 2);
  });
}

test('later ordinary rotation completes recovery and future independent incidents remain recoverable', async t => {
  const f = fixture(t); await f.start(); established(f);
  for (const [candidate, ordinary] of [[2,3], [4,5], [6,7]]) {
    refusal(f); f.renew(candidate); await f.advance(f.lifecycle.getStatus().retryAfterMs); established(f);
    assert.equal(f.lifecycle.getStatus().replacement, 'recovery');
    await f.advance(240000); f.renew(ordinary); await flush(); established(f);
    assert.equal(f.lifecycle.getStatus().replacement, 'proactive');
  }
  assert.equal(f.transports.length, 7); assert.equal(f.lifecycle.getStatus().session, 7);
});

test('pre-ready recovery transport failure consumes candidate and preserves backoff for newer revision', async t => {
  const f = fixture(t); await f.start(); established(f); refusal(f); f.renew(2); await f.advance(10000);
  f.transport.fail(); f.renew(2); await f.advance(20000);
  assert.equal(f.transports.length, 2); assert.equal(f.jobs.size, 0);
  f.renew(3); await flush(); assert.equal(f.transports.length, 3); assert.equal(f.lifecycle.getStatus().replacement, 'recovery');
});

test('concurrent proactive preparation and refusal coalesce into a single recovery', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  const pending = deferred(); f.tokens.push(pending.promise); f.renew(2); await flush();
  refusal(f); pending.resolve(access(300000, 'SYNTHETIC_TOKEN_2', 2)); await flush();
  assert.equal(f.transports.length, 1); await f.advance(10000);
  assert.equal(f.transports.length, 2); assert.equal(f.lifecycle.getStatus().replacement, 'recovery');
});

test('locally usable token under terminal manager attention cannot authorise replacement or recovery', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  f.renew(2, { renewal: 'attention-required', reason: 'authentication-failed' }); await flush();
  assert.equal(f.transports.length, 1); assert.equal(f.transport.closes, 0);
  refusal(f); await f.advance(10000); await flush();
  assert.equal(f.transports.length, 1); assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
});

for (const missing of ['revision', 'getStatus', 'observeCredentials']) {
  test('revision-aware dependency is mandatory: ' + missing, async t => {
    if (missing === 'revision') {
      const f = fixture(t); const raw = access(); delete raw.revision; f.tokens.push(raw); await f.start();
      assert.equal(f.lifecycle.getStatus().error.kind, 'dependency'); assert.equal(f.transports.length, 0);
    } else {
      const provider = { getAccessToken: async () => access(), getStatus: () => ({ renewal: 'ready' }), observeCredentials: () => () => {} };
      delete provider[missing];
      assert.throws(() => fixture(t, { tokenProvider: provider }), /Invalid MQTT lifecycle options/);
    }
  });
}


test('reentrant shutdown from preparation abort cannot revive the retired connection', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  f.tokens.push(({ signal }) => {
    signal.addEventListener('abort', () => f.lifecycle.stop(), { once: true });
    return Promise.resolve(access(300000, 'SYNTHETIC_NEW', 2));
  });
  f.renew(2); await flush();
  assert.equal(f.lifecycle.getStatus().phase, 'stopped'); assert.equal(f.transports.length, 1);
  assert.equal(f.transport.closes, 1);
});

test('reentrant shutdown on replacement transition closes retiring transport before callback returns', async t => {
  let f;
  f = fixture(t, { onStatus(status) {
    if (status.phase === 'connecting' && status.replacement === 'proactive') {
      f.lifecycle.stop(); assert.equal(f.transports[0].closes, 1);
    }
  } });
  await f.start(); established(f); await f.advance(240000); f.renew(2); await flush();
  assert.equal(f.lifecycle.getStatus().phase, 'stopped'); assert.equal(f.transports.length, 1);
});

test('late preparation rejection is absorbed after a qualifying refusal', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  const pending = deferred(); f.tokens.push(pending.promise); f.renew(2); await flush();
  refusal(f); pending.reject(new Error(secret)); await flush(); await f.advance(10000);
  assert.equal(f.transports.length, 2); assert.equal(f.lifecycle.getStatus().replacement, 'recovery');
});

for (const mode of ['throw', 'invalid-cleanup', 'reentrant-stop']) {
  test('credential subscription failure containment ' + mode, async t => {
    const f = fixture(t);
    f.provider.observeCredentials = () => {
      if (mode === 'throw') {
        throw new Error(secret);
      }
      if (mode === 'reentrant-stop') {
        f.lifecycle.stop(); return () => {};
      }
      return null;
    };
    await f.start(); assert.equal(f.tokenCalls.length, 0); assert.equal(f.transports.length, 0);
    assert.equal(f.lifecycle.getStatus().phase, mode === 'reentrant-stop' ? 'stopped' : 'attention-required');
  });
}

test('renewal status sampling cannot conceal candidate ageing before retiring a healthy transport', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  const getStatus = f.provider.getStatus; let sampled = false;
  f.tokens.push(() => {
    f.provider.getStatus = () => {
      if (sampled) {
        f.setTime(f.mono + 300000);
      } sampled = true; return getStatus();
    };
    return Promise.resolve(access(31000, 'SYNTHETIC_SHORT', 2));
  });
  f.renew(2); await flush(); assert.equal(f.transports.length, 1); assert.equal(f.transport.closes, 0);
});


test('a newer notification supersedes a pending candidate before any old-session disruption', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  const old = f.transport, pending = deferred(); f.tokens.push(pending.promise); f.renew(2); await flush();
  f.renew(3); pending.resolve(access(300000, 'SYNTHETIC_SUPERSEDED', 2)); await flush();
  assert.equal(old.closes, 1); assert.equal(f.transports.length, 2);
  assert.equal(f.transport.calls[0].credentials.accessToken, 'SYNTHETIC_TOKEN_3');
});

test('too-short renewal candidate retains healthy connection without repeated acquisition', async t => {
  const f = fixture(t); await f.start(); established(f); await f.advance(240000);
  f.tokens.push(access(30000, 'SYNTHETIC_SHORT', 2)); f.renew(2); await flush();
  assert.equal(f.transport.closes, 0); assert.equal(f.jobs.size, 0); assert.equal(f.tokenCalls.length, 2);
});

test('renewal spacing scheduler failure closes safely and cannot create a second transport', async t => {
  const f = fixture(t); await f.start(); established(f);
  f.scheduler.schedule = () => {
    throw new Error(secret);
  };
  f.renew(2); await flush(); assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
  assert.equal(f.transports.length, 1); assert.equal(f.transport.closes, 1);
});

for (const status of [401, 429, 503]) {
  test('real manager refresh failure ' + status + ' preserves grant ownership and MQTT safety', async t => {
    let f, mono = 0, logins = 0, refreshes = 0; const jobs = new Set();
    const pair = name => ({ ok: true, tokens: { accessToken: 'SYNTHETIC_' + name, refreshToken: 'SYNTHETIC_REFRESH_' + name,
      expiresInSeconds: 300, tokenType: 'Bearer' } });
    const manager = createTokenManager({ clock: { now: () => ({ monotonicMs: mono, wallMs: mono }) },
      scheduler: { schedule(fn, ms) {
        const job = { fn, at: mono + ms }; jobs.add(job); return () => jobs.delete(job);
      } },
      authClient: { login: async () => {
        logins++; return pair(logins);
      },
      refresh: async () => {
        refreshes++; return { ok: false, error: { kind: 'http', status, oauthError: 'invalid_client' } };
      } },
    });
    t.after(() => {
      manager.stop(); assert.equal(jobs.size, 0);
    });
    manager.setCredentials({ username: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' });
    f = fixture(t, { tokenProvider: manager }); await f.start(); established(f);
    mono = 240000; f.setTime(mono);
    for (const j of [...jobs]) {
      if (j.at <= mono && jobs.delete(j)) {
        j.fn();
      }
    } await flush();
    assert.equal(logins, 1); assert.equal(refreshes, 1); assert.equal(f.transport.closes, 0);
    assert.equal((await manager.getAccessToken()).ok, true);
    refusal(f); await f.advance(10000); assert.equal(f.transports.length, 1);
    if (status === 503) {
      mono += 30000; f.setTime(mono);
      for (const j of [...jobs]) {
        if (j.at <= mono && jobs.delete(j)) {
          j.fn();
        }
      } await flush();
      assert.equal(logins, 2); assert.equal(f.transports.length, 2); assert.equal(f.lifecycle.getStatus().replacement, 'recovery');
    } else {
      assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
      assert.equal(manager.getStatus().renewal, 'attention-required'); assert.equal(logins, 1);
    }
  });
}


test('authentication provenance reads changing getters once and cannot leak unvalidated fields', async t => {
  const f = fixture(t); await f.start(); established(f); let origins = 0, codes = 0;
  f.transport.callbacks.onStatus({ phase: 'closed', error: { kind: 'authentication-refused',
    get origin() {
      return ++origins === 1 ? 'error' : secret;
    },
    get reasonCode() {
      return ++codes === 1 ? 135 : secret;
    },
  } });
  assert.equal(origins, 1); assert.equal(codes, 1);
  assert.equal(f.lifecycle.getStatus().phase, 'attention-required');
  assert.deepEqual(f.lifecycle.getStatus().error, { kind: 'authentication-refused', origin: 'error', reasonCode: 135 });
});

test('terminal credential status projects a changing reason getter without private data', async t => {
  const f = fixture(t); let reads = 0;
  f.provider.getStatus = () => ({ renewal: 'attention-required',
    get reason() {
      return ++reads === 1 ? 'authentication-failed' : secret;
    },
  });
  await f.start(); assert.equal(f.tokenCalls.length, 0); assert.equal(reads, 1);
  assert.deepEqual(f.lifecycle.getStatus().error, { kind: 'token', tokenFailure: 'authentication-failed' });
});
