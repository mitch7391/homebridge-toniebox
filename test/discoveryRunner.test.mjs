import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import net from 'node:net';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { inspect } from 'node:util';

const { AbortController, Response, ReadableStream, TextEncoder } = globalThis;

let createDiscoveryRunner;
let createTokenManager;
let createDiscoveryClient;
let forbiddenTotal = 0;
let forbiddenTest = 0;
const secret = 'SYNTHETIC_PRIVATE_ERROR';
const token = 'SYNTHETIC_ACCESS';
const credentials = { username: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' };

before(async () => {
  const forbidden = () => {
    forbiddenTotal++;
    forbiddenTest++;
    assert.fail('Forbidden network or timer attempt');
  };
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(net.Socket.prototype, 'connect', forbidden);
  mock.method(globalThis, 'setTimeout', forbidden);
  mock.method(globalThis, 'setInterval', forbidden);
  ({ createDiscoveryRunner } = await import('../dist/toniebox/discoveryRunner.js'));
  ({ createTokenManager } = await import('../dist/toniebox/tokenManager.js'));
  ({ createDiscoveryClient } = await import('../dist/toniebox/discoveryClient.js'));
});
beforeEach(() => {
  forbiddenTest = 0;
});
afterEach(async () => {
  await nextTurn();
  assert.equal(forbiddenTest, 0, 'Sanitised forbidden attempts must still fail the audit');
});
after(async () => {
  try {
    await nextTurn();
    assert.equal(forbiddenTotal, 0, 'Includes attempts outside individual test hooks');
  } finally {
    mock.restoreAll();
  }
});

const diag = (overrides = {}) => ({
  rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false, ...overrides,
});
const ok = (value, diagnostics = diag()) => ({ ok: true, value, diagnostics });
const fail = (kind, status, extra = {}) => ({ ok: false, error: { kind, ...(status === undefined ? {} : { status }), ...extra } });
const access = (remainingLifetimeMs = 300000) => ({ ok: true, accessToken: token, tokenType: 'Bearer', remainingLifetimeMs });
const account = { id: 'SYNTHETIC_ACCOUNT', identitySource: 'uuid' };
const h1 = { id: 'SYNTHETIC_H1' };
const h2 = { id: 'SYNTHETIC_H2' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
}
function fixture(t, overrides = {}) {
  let mono = 0;
  let wall = 1800000000000;
  let maxTimers = 0;
  let activeGets = 0;
  let maxGets = 0;
  const jobs = new Set();
  const history = [];
  const calls = [];
  const queues = { token: [], account: [], households: [], boxes: [] };
  const defaults = { token: access(), account: ok(account), households: ok([h1]), boxes: ok([]) };
  const context = new AbortController();
  const clock = { now: () => ({ monotonicMs: mono, wallMs: wall }) };
  const scheduler = {
    schedule(callback, ms) {
      const job = { callback, at: mono + ms, ms };
      jobs.add(job);
      history.push(job);
      maxTimers = Math.max(maxTimers, jobs.size);
      return () => jobs.delete(job);
    },
  };
  const invoke = (kind, args) => {
    calls.push({ kind, args, at: mono });
    if (kind !== 'token') {
      activeGets++;
      maxGets = Math.max(maxGets, activeGets);
    }
    const entry = queues[kind].length ? queues[kind].shift() : defaults[kind];
    return Promise.resolve().then(() => typeof entry === 'function' ? entry(...args) : entry).finally(() => {
      if (kind !== 'token') {
        activeGets--;
      }
    });
  };
  const provider = { getAccessToken: options => invoke('token', [options]) };
  const client = {
    getAccount: (value, options) => invoke('account', [value, options]),
    getHouseholds: (value, options) => invoke('households', [value, options]),
    getTonieboxes: (value, household, options) => invoke('boxes', [value, household, options]),
  };
  const options = { tokenProvider: provider, discoveryClient: client, contextSignal: context.signal, clock, scheduler, ...overrides };
  const runner = createDiscoveryRunner(options);
  t.after(() => {
    runner.stop();
    assert.equal(jobs.size, 0, 'Runner timers leaked');
    assert.ok(maxTimers <= 2, 'More than one deadline and one retry alarm');
    assert.ok(maxGets <= 1, 'Overlapping discovery GETs');
    assert.equal(getEventListeners(context.signal, 'abort').length, 0);
  });
  return {
    runner, context, clock, scheduler, jobs, history, calls, queues, defaults, provider, client, options,
    get mono() {
      return mono;
    },
    setTime(m, w = wall) {
      mono = m;
      wall = w;
    },
    jump(ms, wallMs = ms) {
      mono += ms;
      wall += wallMs;
    },
    async advance(ms, wallMs = ms) {
      mono += ms;
      wall += wallMs;
      for (let turn = 0; turn < 100; turn++) {
        const due = [...jobs].filter(job => job.at <= mono);
        if (!due.length) {
          await flush();
          if (![...jobs].some(job => job.at <= mono)) {
            return;
          }
          continue;
        }
        for (const job of due) {
          if (jobs.delete(job)) {
            job.callback();
          }
        }
        await flush();
      }
      assert.fail('Unbounded scheduled work');
    },
  };
}
function failure(result, kind) {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, kind);
  assert.equal(inspect(result.error).includes(secret), false);
}
function noSnapshot(result) {
  assert.equal(Object.hasOwn(result, 'partial'), false);
  assert.equal(Object.hasOwn(result, 'snapshot'), false);
}

test('construction and invalid inputs are inert; stopped/context-invalidated runners remain terminal', async (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.runner), []);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.calls.length, 0);
  for (const options of [null, [], { signal: {} }]) {
    failure(await f.runner.discover(options), 'invalid-input');
  }
  assert.throws(() => createDiscoveryRunner({}), /Invalid discovery runner options/);
  f.runner.stop();
  f.runner.stop();
  failure(await f.runner.discover(), 'stopped');
  assert.equal(f.calls.length, 0);
  const g = fixture(t);
  g.context.abort(secret);
  failure(await g.runner.discover(), 'invalidated');
  assert.equal(g.calls.length, 0);
});

test('one token feeds sequential account, households and ordered box requests', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h2, h1]);
  f.queues.boxes.push(ok([{ id: 'SYNTHETIC_B' }]), ok([{ id: 'SYNTHETIC_A' }]));
  const result = await f.runner.discover();
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.enumeration, 'finished');
  assert.deepEqual(f.calls.map(c => c.kind), ['token', 'account', 'households', 'boxes', 'boxes']);
  assert.deepEqual(f.calls.filter(c => c.kind === 'boxes').map(c => c.args[1]), [h2.id, h1.id]);
  assert.ok(f.calls.slice(1).every(c => c.args[0] === token));
  assert.deepEqual(result.snapshot.devices.map(d => d.requestedHouseholdId), [h2.id, h1.id]);
  assert.deepEqual(result.snapshot.routing, { conflicts: 'none-observed', evidence: 'observed-endpoints' });
  assert.equal(result.diagnostics.requests, 4);
  assert.equal(result.diagnostics.missingMacEntries, 2);
});

test('valid empty households and empty devices are finished observations, never universal completeness claims', async (t) => {
  for (const households of [[], [h1]]) {
    const f = fixture(t);
    f.defaults.households = ok(households);
    const r = await f.runner.discover();
    assert.equal(r.snapshot.enumeration, 'finished');
    assert.deepEqual(r.snapshot.devices, []);
    assert.equal(r.diagnostics.failedHouseholds, 0);
    assert.equal(r.diagnostics.unattemptedHouseholds, 0);
    assert.equal(f.calls.length, households.length + 3);
  }
});

for (const [name, diagnostics, expected] of [
  ['rejected records', diag({ rejectedEntries: 2, duplicateEntries: 2 }), 'partial'],
  ['continuation', diag({ continuationDetected: true }), 'partial'],
  ['optional degradation', diag({ degradedEntries: 2 }), 'finished'],
]) {
  test(name + ' preserves 4A diagnostics and distinguishes coverage from metadata', async (t) => {
    const f = fixture(t);
    f.defaults.boxes = ok([{ id: 'SYNTHETIC_B', generation: 'future', features: [] }], diagnostics);
    const r = await f.runner.discover();
    assert.equal(r.snapshot.enumeration, expected);
    assert.deepEqual(r.snapshot.households[0].diagnostics, diagnostics);
    assert.equal(r.diagnostics.rejectedEntries, diagnostics.rejectedEntries);
    assert.equal(r.diagnostics.degradedEntries, diagnostics.degradedEntries);
    assert.equal(r.diagnostics.duplicateEntries, diagnostics.duplicateEntries);
    assert.equal(r.diagnostics.continuationDetected, diagnostics.continuationDetected);
    assert.deepEqual(r.snapshot.devices[0].device.features, []);
  });
}

test('missing MAC, unknown capabilities and returned versus requested household identity remain distinct', async (t) => {
  const f = fixture(t);
  f.defaults.boxes = ok([
    { id: 'SYNTHETIC_A', generation: 'unknown-generation' },
    { id: 'SYNTHETIC_B', householdId: h1.id, itemId: 'SYNTHETIC_ITEM', product: 'future', features: ['future-feature'] },
  ]);
  const r = await f.runner.discover();
  assert.equal(r.diagnostics.missingMacEntries, 2);
  assert.equal(Object.hasOwn(r.snapshot.devices[0].device, 'features'), false);
  assert.equal(Object.hasOwn(r.snapshot.devices[0].device, 'householdId'), false);
  assert.equal(r.snapshot.devices[0].requestedHouseholdId, h1.id);
  assert.equal(r.snapshot.devices[1].device.householdId, h1.id);
});

test('cross-household IDs and MACs flag every observation without winners or duplicate counting', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h1, h2]);
  f.queues.boxes.push(
    ok([{ id: 'SYNTHETIC_DUP', macAddress: 'synthetic-mac', routingAmbiguous: true }, { id: 'SYNTHETIC_UNIQUE' }],
      diag({ ambiguousRoutingEntries: 1 })),
    ok([{ id: 'SYNTHETIC_DUP', macAddress: 'SYNTHETIC-MAC' }, { id: 'SYNTHETIC_OTHER', macAddress: 'synthetic-mac' }]),
  );
  const r = await f.runner.discover();
  assert.equal(r.snapshot.devices.length, 4);
  assert.deepEqual(r.snapshot.devices.map(d => d.identityConflict === true), [true, false, true, false]);
  assert.deepEqual(r.snapshot.devices.map(d => d.device.routingAmbiguous === true), [true, false, true, true]);
  assert.equal(r.diagnostics.identityConflictEntries, 2);
  assert.equal(r.diagnostics.ambiguousRoutingEntries, 3);
  assert.equal(r.snapshot.routing.conflicts, 'observed');
});

test('identity conflict without shared MAC stays explicit and does not manufacture a MAC conflict', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h1, h2]);
  f.queues.boxes.push(ok([{ id: 'SYNTHETIC_DUP', macAddress: 'synthetic-a' }]), ok([{ id: 'SYNTHETIC_DUP' }]));
  const r = await f.runner.discover();
  assert.equal(r.diagnostics.identityConflictEntries, 2);
  assert.equal(r.diagnostics.ambiguousRoutingEntries, 0);
  assert.equal(r.snapshot.routing.conflicts, 'observed');
});

test('known MAC conflict and insufficient coverage coexist without claiming routes are safe', async (t) => {
  const f = fixture(t);
  f.defaults.boxes = ok([{ id: 'SYNTHETIC_A', macAddress: 'SYNTHETIC_MAC', routingAmbiguous: true }],
    diag({ rejectedEntries: 2, duplicateEntries: 2, ambiguousRoutingEntries: 1 }));
  const r = await f.runner.discover();
  assert.deepEqual(r.snapshot.routing, { conflicts: 'observed', evidence: 'insufficient' });
  assert.equal(r.diagnostics.ambiguousRoutingEntries, 1);
});

for (const e of [fail('forbidden', 403), fail('http', 404), fail('invalid-response', 200)]) {
  test('household-local ' + e.error.kind + '/' + e.error.status + ' preserves valid sibling observations', async (t) => {
    const f = fixture(t);
    f.defaults.households = ok([h1, h2]);
    f.queues.boxes.push(e, ok([{ id: 'SYNTHETIC_VALID' }]));
    const r = await f.runner.discover();
    assert.equal(r.ok, true);
    assert.equal(r.snapshot.enumeration, 'partial');
    assert.equal(r.snapshot.devices[0].device.id, 'SYNTHETIC_VALID');
    assert.equal(r.snapshot.households[0].outcome, 'failed');
    assert.equal(r.diagnostics.failedHouseholds, 1);
    assert.equal(r.diagnostics.retries, 0);
    assert.equal(f.calls.filter(c => c.kind === 'token').length, 1);
  });
}

for (const stage of ['account', 'households']) {
  for (const e of [fail('unauthorized', 401), fail('forbidden', 403), fail('http', 404), fail('invalid-response', 200)]) {
    test(stage + ' prerequisite ' + e.error.kind + '/' + e.error.status + ' cannot become successful empty discovery', async (t) => {
      const f = fixture(t);
      f.queues[stage].push(e);
      const r = await f.runner.discover();
      failure(r, 'request');
      assert.equal(r.error.stage, stage);
      assert.equal(f.calls.some(c => c.kind === 'boxes'), false);
      assert.equal(r.diagnostics.retries, 0);
      if (r.partial) {
        assert.equal(r.partial.enumeration, 'partial');
        assert.equal(r.partial.householdsDiagnostics, undefined);
      }
    });
  }
}

test('401 after valid devices stops immediately without credential intervention or same-token retry', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h1, h2, { id: 'SYNTHETIC_H3' }]);
  f.queues.boxes.push(ok([{ id: 'SYNTHETIC_VALID' }]), fail('unauthorized', 401));
  const r = await f.runner.discover();
  failure(r, 'request');
  assert.equal(r.partial.devices.length, 1);
  assert.equal(r.partial.enumeration, 'partial');
  assert.equal(r.diagnostics.failedHouseholds, 1);
  assert.equal(r.diagnostics.unattemptedHouseholds, 1);
  assert.equal(r.diagnostics.requests, 4);
  assert.equal(r.diagnostics.retries, 0);
});

for (const e of [fail('transport'), fail('timeout'), ...[408, 500, 502, 503, 504].map(code => fail('http', code))]) {
  test('eligible ' + e.error.kind + '/' + e.error.status + ' retries the same GET once after one second', async (t) => {
    const f = fixture(t);
    f.queues.account.push(e, ok(account));
    const pending = f.runner.discover();
    await flush();
    assert.equal(f.calls.length, 2);
    await f.advance(999);
    assert.equal(f.calls.length, 2);
    await f.advance(1);
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(r.diagnostics.retries, 1);
    assert.deepEqual(f.calls.map(c => c.kind), ['token', 'account', 'account', 'households', 'boxes']);
    assert.equal(f.calls[2].at - f.calls[1].at, 1000);
  });
}

test('retry allowance is shared across operations; exhausted transient failure stops further households', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h1, h2]);
  f.queues.account.push(fail('transport'));
  f.queues.boxes.push(fail('http', 500));
  const pending = f.runner.discover();
  await flush();
  await f.advance(1000);
  const r = await pending;
  failure(r, 'request');
  assert.equal(r.diagnostics.retries, 1);
  assert.equal(r.diagnostics.unattemptedHouseholds, 1);
  assert.equal(f.calls.filter(c => c.kind === 'boxes').length, 1);
});

test('two transient failures on one prerequisite stop at two attempts without background requests', async (t) => {
  const f = fixture(t);
  f.queues.account.push(fail('transport'), fail('transport'));
  const pending = f.runner.discover();
  await flush();
  await f.advance(1000);
  failure(await pending, 'request');
  await f.advance(3600000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.jobs.size, 0);
});

for (const code of [400, 501, 505]) {
  test('non-retryable HTTP ' + code + ' stops without another GET', async (t) => {
    const f = fixture(t);
    f.queues.account.push(fail('http', code));
    failure(await f.runner.discover(), 'request');
    assert.equal(f.calls.length, 2);
    assert.equal(f.jobs.size, 0);
  });
}

for (const [header, expected] of [[undefined, 60000], [-1, 60000], [NaN, 60000], ['120', 60000], [120000, 120000], [0, 0]]) {
  test('429 cooldown accepts only safe metadata: ' + String(header), async (t) => {
    const f = fixture(t);
    f.queues.account.push(fail('rate-limited', 429, { retryAfterMs: header }));
    failure(await f.runner.discover(), 'request');
    const count = f.calls.length;
    if (expected > 0) {
      for (let i = 0; i < 50; i++) {
        const r = await f.runner.discover();
        failure(r, 'cooldown');
        assert.equal(r.error.retryAfterMs, expected);
      }
      assert.equal(f.calls.length, count);
      assert.equal(f.jobs.size, 0);
      await f.advance(expected - 1);
      assert.equal((await f.runner.discover()).error.retryAfterMs, 1);
      await f.advance(1);
    }
    assert.equal((await f.runner.discover()).ok, true);
  });
}

test('429 mid-enumeration preserves previous results and blocks all later requests', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h1, h2]);
  f.queues.boxes.push(ok([{ id: 'SYNTHETIC_DEVICE' }]), fail('rate-limited', 429));
  const r = await f.runner.discover();
  assert.equal(r.partial.devices.length, 1);
  assert.equal(r.partial.enumeration, 'partial');
  assert.equal(r.diagnostics.retries, 0);
  failure(await f.runner.discover(), 'cooldown');
});

test('503 Retry-After delays the retry and cannot be bypassed by busy callers', async (t) => {
  const f = fixture(t);
  f.queues.account.push(fail('http', 503, { retryAfterMs: 5000 }));
  const pending = f.runner.discover();
  await flush();
  failure(await f.runner.discover(), 'busy');
  await f.advance(4999);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal((await pending).ok, true);
  assert.equal(f.calls[2].at, 5000);
});

test('503 guidance longer than run budget is not shortened and persists across explicit calls', async (t) => {
  const f = fixture(t);
  f.queues.account.push(fail('http', 503, { retryAfterMs: Number.MAX_SAFE_INTEGER }));
  const r = await f.runner.discover();
  failure(r, 'retry-deferred');
  assert.equal(r.error.retryAfterMs, Number.MAX_SAFE_INTEGER);
  assert.equal(r.diagnostics.retries, 0);
  failure(await f.runner.discover(), 'cooldown');
  assert.equal(f.calls.length, 2);
  assert.equal(f.jobs.size, 0);
});

test('503 after retry exhaustion still establishes a server cooldown', async (t) => {
  const f = fixture(t);
  f.queues.account.push(fail('transport'), fail('http', 503, { retryAfterMs: 90000 }));
  const p = f.runner.discover();
  await flush();
  await f.advance(1000);
  failure(await p, 'request');
  assert.equal((await f.runner.discover()).error.retryAfterMs, 90000);
});

for (const kind of [
  'invalid-input', 'cancelled', 'invalidated', 'stopped', 'credentials-required', 'reauthorization-required', 'backoff',
  'authentication-failed', 'rate-limited', 'refresh-recovery-exhausted', 'insufficient-lifetime', 'clock-invalid',
]) {
  test('token-manager ' + kind + ' is reported safely without authentication orchestration', async (t) => {
    const f = fixture(t);
    f.queues.token.push({ ok: false, error: { kind, retryAfterMs: 5000, detail: secret, authFailure: {
      kind: 'http', status: 503, oauthError: 'invalid_grant', body: secret,
    } } });
    const r = await f.runner.discover();
    failure(r, 'authentication');
    assert.deepEqual(r.error.tokenFailure, { kind, retryAfterMs: 5000, authFailure: {
      kind: 'http', status: 503, oauthError: 'invalid_grant',
    } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.jobs.size, 0);
  });
}

test('valid token acquisition does not depend on renewal status or require full-run lifetime', async (t) => {
  const f = fixture(t);
  f.defaults.token = access(1500);
  assert.equal((await f.runner.discover()).ok, true);
  assert.equal(f.calls.length, 4);
});

test('token acquisition duration is not subtracted twice from reported remaining lifetime', async (t) => {
  const f = fixture(t);
  const tokenPending = deferred();
  const bodyPending = deferred();
  f.queues.token.push(tokenPending.promise);
  f.queues.account.push(bodyPending.promise);
  const p = f.runner.discover();
  await flush();
  await f.advance(20000);
  tokenPending.resolve(access(10000));
  await flush();
  await f.advance(8999);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].args[1].signal.aborted, false);
  await f.advance(1);
  failure(await p, 'token-expired');
  bodyPending.resolve(ok(account));
  await flush();
  assert.equal(f.calls.length, 2);
});

for (const lifetime of [1000, 999]) {
  test('token lifetime ' + lifetime + ' cannot dispatch beyond the safety boundary', async (t) => {
    const f = fixture(t);
    f.defaults.token = access(lifetime);
    failure(await f.runner.discover(), 'token-expired');
    assert.equal(f.calls.length, 1);
  });
}

for (const value of [0, -1, NaN, Infinity, '1000', Number.MAX_SAFE_INTEGER + 1]) {
  test('invalid token lifetime ' + String(value) + ' fails the normalised dependency contract', async (t) => {
    const f = fixture(t);
    f.defaults.token = access(value);
    failure(await f.runner.discover(), 'dependency');
    assert.equal(f.calls.length, 1);
  });
}

test('overall deadline begins before token acquisition and settles an ignored abort', async (t) => {
  const f = fixture(t);
  const pending = deferred();
  f.queues.token.push(pending.promise);
  const p = f.runner.discover();
  await flush();
  await f.advance(59999);
  assert.equal(f.calls[0].args[0].signal.aborted, false);
  await f.advance(1);
  failure(await p, 'deadline');
  assert.equal(f.calls[0].args[0].signal.aborted, true);
  pending.resolve(access());
  await flush();
  assert.equal(f.calls.length, 1);
});

test('deadline during a household preserves received devices and distinguishes interrupted from unattempted', async (t) => {
  const f = fixture(t);
  const pending = deferred();
  f.defaults.households = ok([h1, h2, { id: 'SYNTHETIC_H3' }]);
  f.queues.boxes.push(ok([{ id: 'SYNTHETIC_A' }]), pending.promise);
  const p = f.runner.discover();
  await flush();
  await f.advance(60000);
  const r = await p;
  failure(r, 'deadline');
  assert.equal(r.partial.devices.length, 1);
  assert.equal(r.diagnostics.interruptedHouseholds, 1);
  assert.equal(r.diagnostics.unattemptedHouseholds, 1);
  assert.deepEqual(r.partial.households.map(h => h.outcome), ['received', 'interrupted', 'unattempted']);
  pending.reject(new Error(secret));
  await flush();
  assert.equal(f.calls.length, 5);
});

test('response processing at exact deadline cannot publish a successful snapshot', async (t) => {
  const f = fixture(t);
  f.queues.account.push(() => {
    f.jump(60000);
    return ok(account);
  });
  failure(await f.runner.discover(), 'deadline');
  assert.equal(f.calls.length, 2);
});

test('insufficient retry time stops without dispatching or disguising a pending household as empty', async (t) => {
  const f = fixture(t);
  f.queues.boxes.push(() => {
    f.jump(59500);
    return fail('transport');
  });
  const r = await f.runner.discover();
  failure(r, 'retry-deferred');
  assert.equal(r.partial.enumeration, 'partial');
  assert.equal(r.diagnostics.interruptedHouseholds, 1);
  assert.equal(r.diagnostics.retries, 0);
});

for (const action of ['caller', 'context', 'stop']) {
  for (const stage of ['token', 'account', 'boxes']) {
    test(action + ' during ' + stage + ' settles promptly and rejects stale data', async (t) => {
      const f = fixture(t);
      const caller = new AbortController();
      const pending = deferred();
      f.queues[stage].push(pending.promise);
      const p = f.runner.discover({ signal: caller.signal });
      await flush();
      if (action === 'caller') {
        caller.abort(secret);
      } else if (action === 'context') {
        f.context.abort(secret);
      } else {
        f.runner.stop();
      }
      const r = await p;
      failure(r, action === 'caller' ? 'cancelled' : action === 'context' ? 'invalidated' : 'stopped');
      noSnapshot(r);
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
      const count = f.calls.length;
      pending.resolve(stage === 'token' ? access() : stage === 'account' ? ok(account) : ok([{ id: 'SYNTHETIC_LATE' }]));
      await flush();
      assert.equal(f.calls.length, count);
      assert.equal(f.jobs.size, 0);
      if (action !== 'caller') {
        failure(await f.runner.discover(), action === 'context' ? 'invalidated' : 'stopped');
      } else {
        assert.equal((await f.runner.discover()).ok, true);
      }
    });
  }
}

test('pre-aborted caller starts no timer or token acquisition', async (t) => {
  const f = fixture(t);
  const caller = new AbortController();
  caller.abort(secret);
  failure(await f.runner.discover({ signal: caller.signal }), 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal(f.jobs.size, 0);
});

test('cancelled retry callbacks cannot dispatch into a newer run', async (t) => {
  const f = fixture(t);
  const caller = new AbortController();
  f.queues.account.push(fail('transport'));
  const old = f.runner.discover({ signal: caller.signal });
  await flush();
  const callbacks = [...f.jobs].map(j => j.callback);
  caller.abort();
  failure(await old, 'cancelled');
  const pending = deferred();
  f.queues.token.push(pending.promise);
  const newer = f.runner.discover();
  await flush();
  const count = f.calls.length;
  for (const callback of callbacks) {
    callback();
  }
  await flush();
  assert.equal(f.calls.length, count);
  pending.resolve(access());
  assert.equal((await newer).ok, true);
});

test('concurrent and reentrant consumers receive busy without duplicate acquisition', async (t) => {
  const f = fixture(t);
  const d = deferred();
  let reentrant;
  f.queues.token.push(() => {
    reentrant = f.runner.discover();
    return d.promise;
  });
  const p = f.runner.discover();
  await flush();
  failure(await reentrant, 'busy');
  for (let i = 0; i < 100; i++) {
    failure(await f.runner.discover(), 'busy');
  }
  d.resolve(access());
  assert.equal((await p).ok, true);
  assert.equal(f.calls.filter(c => c.kind === 'token').length, 1);
});

test('independent account runners do not share tokens, cooldowns or snapshots', async (t) => {
  const a = fixture(t);
  const b = fixture(t);
  b.defaults.token = { ...access(), accessToken: 'SYNTHETIC_TOKEN_B' };
  b.defaults.account = ok({ id: 'SYNTHETIC_ACCOUNT_B', identitySource: 'id' });
  a.queues.account.push(fail('rate-limited', 429));
  failure(await a.runner.discover(), 'request');
  const result = await b.runner.discover();
  assert.equal(result.snapshot.account.id, 'SYNTHETIC_ACCOUNT_B');
  assert.ok(b.calls.slice(1).every(c => c.args[0] === 'SYNTHETIC_TOKEN_B'));
  failure(await a.runner.discover(), 'cooldown');
});

test('snapshot and incoming feature mutations cannot change another result or earlier copied observations', async (t) => {
  const f = fixture(t);
  const raw = { id: 'SYNTHETIC_A', features: ['future'] };
  f.defaults.households = ok([h1, h2]);
  const pending = deferred();
  f.queues.boxes.push(ok([raw]), pending.promise);
  const p = f.runner.discover();
  await flush();
  raw.features.push('later');
  raw.id = 'SYNTHETIC_CHANGED';
  pending.resolve(ok([]));
  const first = await p;
  assert.equal(first.snapshot.devices[0].device.id, 'SYNTHETIC_A');
  assert.deepEqual(first.snapshot.devices[0].device.features, ['future']);
  first.snapshot.devices[0].device.features.push('caller-mutation');
  f.defaults.boxes = ok([{ id: 'SYNTHETIC_FRESH', features: ['fresh'] }]);
  const second = await f.runner.discover();
  assert.deepEqual(second.snapshot.devices[0].device.features, ['fresh']);
  assert.equal(first.snapshot.devices[0].device.id, 'SYNTHETIC_A');
});

test('forward wall changes shorten validity; backwards wall changes never extend it', async (t) => {
  const f = fixture(t);
  const pending = deferred();
  f.defaults.token = access(10000);
  f.queues.account.push(pending.promise);
  const p = f.runner.discover();
  await flush();
  await f.advance(1000, 8000);
  await f.advance(1000, -100000);
  pending.resolve(ok(account));
  await flush();
  assert.equal((await p).ok, true);
  const g = fixture(t);
  const d = deferred();
  g.defaults.token = access(10000);
  g.queues.account.push(d.promise);
  const q = g.runner.discover();
  await flush();
  g.jump(1, 9000);
  d.resolve(ok(account));
  failure(await q, 'token-expired');
  assert.equal(g.calls.length, 2);
});

for (const clockValue of [NaN, Infinity, -1]) {
  test('invalid monotonic clock ' + clockValue + ' fails closed without requests', async (t) => {
    const f = fixture(t);
    f.setTime(clockValue);
    failure(await f.runner.discover(), 'clock-invalid');
    assert.equal(f.calls.length, 0);
  });
}

test('regressing clock and non-finite wall time invalidate pending work without exposing partial data', async (t) => {
  for (const invalidWall of [false, true]) {
    const f = fixture(t);
    f.setTime(10);
    const d = deferred();
    f.queues.account.push(d.promise);
    const p = f.runner.discover();
    await flush();
    if (invalidWall) {
      f.setTime(11, NaN);
    } else {
      f.setTime(9);
    }
    d.resolve(ok(account));
    const r = await p;
    failure(r, 'clock-invalid');
    noSnapshot(r);
    failure(await f.runner.discover(), 'clock-invalid');
  }
});

test('wall-clock jumps cannot bypass a monotonic server cooldown', async (t) => {
  const f = fixture(t);
  f.queues.account.push(fail('rate-limited', 429, { retryAfterMs: 5000 }));
  await f.runner.discover();
  f.jump(1, 3600000);
  assert.equal((await f.runner.discover()).error.retryAfterMs, 4999);
});

test('early deadline callback rearms and delayed callbacks cannot extend the run', async (t) => {
  const f = fixture(t);
  const d = deferred();
  f.queues.token.push(d.promise);
  const p = f.runner.discover();
  await flush();
  const alarm = [...f.jobs][0];
  f.jobs.delete(alarm);
  alarm.callback();
  assert.equal(f.jobs.size, 1);
  await f.advance(70000);
  failure(await p, 'deadline');
  d.reject(new Error(secret));
  await flush();
});

test('unexpected throws, malformed dependency responses and unknown diagnostics are sanitised', async (t) => {
  for (const response of [
    () => {
      throw new Error(secret);
    }, () => Promise.reject(new Error(secret)),
    { ok: true, value: [], diagnostics: {} }, { ok: false, error: { kind: secret } },
  ]) {
    const f = fixture(t);
    f.queues.account.push(await response);
    const r = await f.runner.discover();
    failure(r, 'dependency');
    noSnapshot(r);
    assert.equal(f.calls.length, 2);
  }
});

test('privacy-safe summaries omit all identities and extra injected fields', async (t) => {
  const f = fixture(t);
  f.defaults.account = ok({ ...account, email: secret });
  f.defaults.boxes = ok([{ id: 'SYNTHETIC_ID', macAddress: 'SYNTHETIC_MAC', secret }], { ...diag(), secret });
  const r = await f.runner.discover();
  assert.equal(inspect(r).includes(secret), false);
  assert.equal(inspect(r.diagnostics).includes('SYNTHETIC'), false);
  assert.equal(inspect(r).includes(token), false);
});

test('scheduler failure settles safely without dispatch', async (t) => {
  const f = fixture(t, { scheduler: {
    schedule() {
      throw new Error(secret);
    },
  } });
  failure(await f.runner.discover(), 'dependency');
  assert.equal(f.calls.length, 0);
});


// Real 3B/4A composition: separate fake scheduler sets retain each component's ownership.
function composed(t) {
  const managerJobs = new Set();
  const httpJobs = new Set();
  const authCalls = [];
  const httpCalls = [];
  const grants = [];
  const replies = [];
  let manager;
  let client;
  const f = fixture(t, {
    tokenProvider: { getAccessToken: options => manager.getAccessToken(options) },
    discoveryClient: {
      getAccount: (...args) => client.getAccount(...args),
      getHouseholds: (...args) => client.getHouseholds(...args),
      getTonieboxes: (...args) => client.getTonieboxes(...args),
    },
  });
  const grant = (kind, value, options) => {
    authCalls.push({ kind, value, options });
    return Promise.resolve(grants.length ? grants.shift() : {
      ok: true, tokens: {
        accessToken: token, refreshToken: 'SYNTHETIC_REFRESH', tokenType: 'Bearer',
        expiresInSeconds: 300, refreshExpiresInSeconds: 3600,
      },
    });
  };
  manager = createTokenManager({
    authClient: { login: (...args) => grant('login', ...args), refresh: (...args) => grant('refresh', ...args) },
    clock: f.clock,
    scheduler: {
      schedule(callback, ms) {
        const job = { callback, ms };
        managerJobs.add(job);
        return () => managerJobs.delete(job);
      },
    },
  });
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const job = { callback, ms, unref() {} };
    httpJobs.add(job);
    return job;
  });
  t.mock.method(globalThis, 'clearTimeout', job => httpJobs.delete(job));
  client = createDiscoveryClient({
    now: () => f.clock.now().wallMs,
    fetch: (url, init) => {
      httpCalls.push({ url, init });
      assert.ok(replies.length, 'Unplanned synthetic GET');
      const value = replies.shift();
      return typeof value === 'function' ? value(url, init) : Promise.resolve(value);
    },
  });
  t.after(() => {
    manager.stop();
    assert.equal(managerJobs.size, 0);
    assert.equal(httpJobs.size, 0);
  });
  assert.equal(manager.setCredentials(credentials).ok, true);
  return { ...f, manager, managerJobs, httpJobs, authCalls, httpCalls, grants, replies };
}
const json = value => new Response(JSON.stringify(value), { status: 200 });

test('composed real 3B and 4A preserve partial discovery and cross-household routing conflicts', async (t) => {
  const c = composed(t);
  c.replies.push(json({ uuid: account.id }), json([h1, h2]),
    json([{ id: 'SYNTHETIC_A', macAddress: 'synthetic-mac', features: ['future'] }, { name: 'invalid' }]),
    json([{ id: 'SYNTHETIC_B', macAddress: 'SYNTHETIC-MAC' }]));
  const r = await c.runner.discover();
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.enumeration, 'partial');
  assert.equal(r.diagnostics.rejectedEntries, 1);
  assert.equal(r.diagnostics.ambiguousRoutingEntries, 2);
  assert.equal(r.snapshot.routing.evidence, 'insufficient');
  assert.ok(r.snapshot.devices.every(d => d.device.routingAmbiguous));
  assert.deepEqual(c.httpCalls.map(call => call.url), [
    'https://api.prod.tcs.toys/v2/me', 'https://api.prod.tcs.toys/v2/households',
    'https://api.prod.tcs.toys/v2/households/SYNTHETIC_H1/tonieboxes',
    'https://api.prod.tcs.toys/v2/households/SYNTHETIC_H2/tonieboxes',
  ]);
  assert.ok(c.httpCalls.every(call => call.init.headers.Authorization === 'Bearer ' + token));
  assert.equal(c.authCalls.length, 1);
  assert.equal(c.manager.getStatus().access, 'usable');
  c.runner.stop();
  assert.equal(c.manager.getStatus().renewal, 'ready', 'Runner must not stop shared authentication');
});

test('composed body transport failure uses exactly one GET retry without another grant', async (t) => {
  const c = composed(t);
  c.replies.push(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"uuid":'));
      controller.error(new Error(secret));
    },
  })), json({ uuid: account.id }), json([]));
  const p = c.runner.discover();
  await flush();
  assert.equal(c.httpCalls.length, 1);
  await c.advance(1000);
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.diagnostics.retries, 1);
  assert.equal(c.authCalls.length, 1);
  assert.equal(c.httpCalls.length, 3);
  assert.equal(inspect(r).includes(secret), false);
});

test('composed cancellation of discovery leaves a shared manager login available to another consumer', async (t) => {
  const c = composed(t);
  const grant = deferred();
  c.grants.push(grant.promise);
  const caller = new AbortController();
  const p = c.runner.discover({ signal: caller.signal });
  await flush();
  const shared = c.manager.getAccessToken();
  caller.abort(secret);
  failure(await p, 'cancelled');
  assert.equal(c.manager.getStatus().operation, 'login');
  grant.resolve({ ok: true, tokens: {
    accessToken: token, refreshToken: 'SYNTHETIC_REFRESH', tokenType: 'Bearer', expiresInSeconds: 300,
  } });
  assert.equal((await shared).ok, true);
  assert.equal(c.authCalls.length, 1);
  assert.equal(c.httpCalls.length, 0);
});

test('simulated owner invalidates old context before changed credentials; late old HTTP cannot publish', async (t) => {
  const c = composed(t);
  const pending = deferred();
  c.replies.push(() => pending.promise);
  const old = c.runner.discover();
  await flush();
  assert.equal(c.httpCalls.length, 1);
  c.manager.setCredentials({ ...credentials });
  assert.equal(c.manager.getStatus().access, 'usable', 'Identical delivery leaves context valid');
  c.context.abort();
  const oldResult = await old;
  failure(oldResult, 'invalidated');
  noSnapshot(oldResult);
  c.manager.setCredentials({ username: 'SYNTHETIC_NEW_USER', password: 'SYNTHETIC_NEW_PASSWORD' });
  c.jump(30000);
  const fresh = new AbortController();
  const runner = createDiscoveryRunner({ ...c.options, contextSignal: fresh.signal });
  t.after(() => runner.stop());
  c.grants.push({ ok: true, tokens: {
    accessToken: 'SYNTHETIC_NEW_TOKEN', refreshToken: 'SYNTHETIC_NEW_REFRESH', tokenType: 'Bearer', expiresInSeconds: 300,
  } });
  c.replies.push(json({ uuid: 'SYNTHETIC_NEW_ACCOUNT' }), json([]));
  const current = await runner.discover();
  assert.equal(current.snapshot.account.id, 'SYNTHETIC_NEW_ACCOUNT');
  pending.resolve(json({ uuid: 'SYNTHETIC_OLD_ACCOUNT' }));
  await flush();
  assert.equal(c.authCalls.length, 2);
  assert.ok(c.httpCalls.slice(1).every(call => call.init.headers.Authorization === 'Bearer SYNTHETIC_NEW_TOKEN'));
  assert.equal(current.snapshot.account.id, 'SYNTHETIC_NEW_ACCOUNT');
  failure(await c.runner.discover(), 'invalidated');
});

test('an uncooperative late rejection cannot settle or cancel a newer discovery run', async (t) => {
  const f = fixture(t);
  const oldRequest = deferred();
  const newToken = deferred();
  f.queues.account.push(oldRequest.promise);
  const caller = new AbortController();
  const old = f.runner.discover({ signal: caller.signal });
  await flush();
  caller.abort();
  failure(await old, 'cancelled');
  f.queues.token.push(newToken.promise);
  const current = f.runner.discover();
  await flush();
  oldRequest.reject(new Error(secret));
  await flush();
  failure(await f.runner.discover(), 'busy');
  newToken.resolve(access());
  assert.equal((await current).ok, true);
});

test('broken duplicate-household dependency contract cannot silently select a winner', async (t) => {
  const f = fixture(t);
  f.defaults.households = ok([h1, { ...h1 }]);
  failure(await f.runner.discover(), 'dependency');
  assert.equal(f.calls.length, 3);
});

test('default runner timer is unreferenced and released on shutdown', async (t) => {
  const jobs = new Set();
  let unrefs = 0;
  t.mock.method(globalThis, 'setTimeout', callback => {
    const timer = {
      callback,
      unref() {
        unrefs++;
      },
    };
    jobs.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => jobs.delete(timer));
  const f = fixture(t, { scheduler: undefined });
  const pending = deferred();
  f.queues.token.push(pending.promise);
  const p = f.runner.discover();
  await flush();
  assert.equal(unrefs, 1);
  f.runner.stop();
  failure(await p, 'stopped');
  assert.equal(jobs.size, 0);
  pending.reject(new Error(secret));
  await flush();
});

test('fractional token-manager backoff metadata is retained without rounding or disclosure', async (t) => {
  const f = fixture(t);
  f.queues.token.push({ ok: false, error: { kind: 'backoff', retryAfterMs: 1234.5, detail: secret } });
  const r = await f.runner.discover();
  failure(r, 'authentication');
  assert.equal(r.error.tokenFailure.retryAfterMs, 1234.5);
  assert.equal(r.error.retryAfterMs, 1234.5);
  assert.equal(f.calls.length, 1);
});

test('late dependency rejection cannot override an expired overall deadline', async (t) => {
  const f = fixture(t);
  const pending = deferred();
  f.queues.account.push(pending.promise);
  const p = f.runner.discover();
  await flush();
  f.jump(60000);
  pending.reject(new Error(secret));
  failure(await p, 'deadline');
  assert.equal(f.calls.length, 2);
});

test('real manager renewal never replaces the token captured by an in-flight discovery run', async (t) => {
  const c = composed(t);
  // Begin near the normal renewal point with a still-usable pair.
  assert.equal((await c.manager.getAccessToken()).ok, true);
  c.jump(239000);
  const pending = deferred();
  c.replies.push(() => pending.promise, json([]));
  const p = c.runner.discover();
  await flush();
  assert.equal(c.httpCalls.length, 1);
  c.jump(1000);
  c.grants.push({ ok: true, tokens: {
    accessToken: 'SYNTHETIC_ROTATED_ACCESS', refreshToken: 'SYNTHETIC_ROTATED_REFRESH',
    tokenType: 'Bearer', expiresInSeconds: 300,
  } });
  assert.equal((await c.manager.getAccessToken()).accessToken, 'SYNTHETIC_ROTATED_ACCESS');
  pending.resolve(json({ uuid: account.id }));
  assert.equal((await p).ok, true);
  assert.equal(c.authCalls.length, 2);
  assert.equal(c.authCalls[1].kind, 'refresh');
  assert.ok(c.httpCalls.every(call => call.init.headers.Authorization === 'Bearer ' + token));
});

test('real manager renewal backoff permits discovery with remaining access validity without another grant', async (t) => {
  const c = composed(t);
  await c.manager.getAccessToken();
  c.jump(240000);
  c.grants.push({ ok: false, error: { kind: 'transport' } });
  const retained = await c.manager.getAccessToken();
  assert.equal(retained.ok, true);
  assert.equal(c.manager.getStatus().renewal, 'backoff');
  c.replies.push(json({ uuid: account.id }), json([]));
  const result = await c.runner.discover();
  assert.equal(result.ok, true);
  assert.equal(c.authCalls.length, 2, 'Discovery must not trigger password recovery');
  assert.ok(c.httpCalls.every(call => call.init.headers.Authorization === 'Bearer ' + token));
});

for (const [label, response, expected] of [
  ['429 explicit', fail('rate-limited', 429, { retryAfterMs: 120000 }), 120000],
  ['429 absent', fail('rate-limited', 429), 60000],
  ['429 invalid', fail('rate-limited', 429, { retryAfterMs: NaN }), 60000],
  ['503 explicit', fail('http', 503, { retryAfterMs: 120000 }), 120000],
]) {
  test('deadline observation retains ' + label + ' cooldown without accepting stale discovery', async (t) => {
    const f = fixture(t);
    const caller = new AbortController();
    f.defaults.households = ok([h1, h2]);
    f.queues.boxes.push(ok([{ id: 'SYNTHETIC_EARLIER' }]), () => {
      f.jump(60000);
      return response;
    });
    const p = f.runner.discover({ signal: caller.signal });
    await flush();
    const r = await p;
    failure(r, 'deadline');
    assert.equal(r.partial.enumeration, 'partial');
    assert.deepEqual(r.partial.devices.map(d => d.device.id), ['SYNTHETIC_EARLIER']);
    assert.equal(r.diagnostics.retries, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    assert.equal(f.jobs.size, 0);
    const count = f.calls.length;
    for (let i = 0; i < 10; i++) {
      const blocked = await f.runner.discover();
      failure(blocked, 'cooldown');
      assert.equal(blocked.error.retryAfterMs, expected);
    }
    assert.equal(f.calls.length, count);
    await f.advance(expected - 1);
    assert.equal((await f.runner.discover()).error.retryAfterMs, 1);
    await f.advance(1);
    assert.equal((await f.runner.discover()).ok, true);
  });
}

test('429 observed at the token-use boundary retains guidance without extending token validity', async (t) => {
  const f = fixture(t);
  f.defaults.token = access(10000);
  f.queues.account.push(() => {
    f.jump(9000);
    return fail('rate-limited', 429, { retryAfterMs: 120000 });
  });
  const r = await f.runner.discover();
  failure(r, 'token-expired');
  noSnapshot(r);
  assert.equal((await f.runner.discover()).error.retryAfterMs, 120000);
  assert.equal(f.calls.length, 2);
});

for (const first of ['response', 'deadline']) {
  test('deadline callback versus 429 observation has explicit ' + first + '-first precedence', async (t) => {
    const response = deferred();
    const f = fixture(t, { discoveryClient: {
      getAccount: () => response.promise,
      getHouseholds: async () => ok([]),
      getTonieboxes: async () => ok([]),
    } });
    const p = f.runner.discover();
    await flush();
    const deadline = [...f.jobs][0];
    f.jump(60000);
    if (first === 'response') {
      response.resolve(fail('rate-limited', 429, { retryAfterMs: 120000 }));
      // Direct dependency reaction observes the response before the queued deadline callback.
      await Promise.resolve();
      f.jobs.delete(deadline);
      deadline.callback();
    } else {
      f.jobs.delete(deadline);
      deadline.callback();
      response.resolve(fail('rate-limited', 429, { retryAfterMs: 120000 }));
    }
    failure(await p, 'deadline');
    await flush();
    assert.equal(f.jobs.size, 0);
    if (first === 'response') {
      assert.equal((await f.runner.discover()).error.retryAfterMs, 120000);
    } else {
      // An abandoned run cannot later establish a cooldown, even at the same clock reading.
      f.queues.token.push({ ok: false, error: { kind: 'credentials-required' } });
      failure(await f.runner.discover(), 'authentication');
    }
  });
}

test('a 429 first observed past the deadline is not treated as an on-time response', async (t) => {
  const f = fixture(t);
  f.queues.account.push(() => {
    f.jump(60001);
    return fail('rate-limited', 429, { retryAfterMs: 120000 });
  });
  failure(await f.runner.discover(), 'deadline');
  assert.equal((await f.runner.discover()).ok, true);
});

for (const action of ['caller', 'context', 'stop']) {
  test(action + ' abandonment prevents late 429 metadata from affecting replacement discovery', async (t) => {
    const f = fixture(t);
    const pending = deferred();
    const caller = new AbortController();
    f.queues.account.push(pending.promise);
    const p = f.runner.discover({ signal: caller.signal });
    await flush();
    if (action === 'caller') {
      caller.abort();
    } else if (action === 'context') {
      f.context.abort();
    } else {
      f.runner.stop();
      f.runner.stop();
    }
    const kind = action === 'caller' ? 'cancelled' : action === 'context' ? 'invalidated' : 'stopped';
    const abandoned = await p;
    failure(abandoned, kind);
    noSnapshot(abandoned);
    assert.equal(f.calls[1].args[1].signal.aborted, true);
    assert.equal(f.jobs.size, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    const replacement = fixture(t);
    replacement.defaults.token = { ...access(), accessToken: 'SYNTHETIC_REPLACEMENT' };
    assert.equal((await replacement.runner.discover()).ok, true);
    pending.resolve(fail('rate-limited', 429, { retryAfterMs: 120000 }));
    await flush();
    assert.equal(f.calls.length, 2, 'Abandoned run dispatched another request');
    assert.equal((await replacement.runner.discover()).ok, true);
    assert.ok(replacement.calls.filter(c => c.kind !== 'token').every(c => c.args[0] === 'SYNTHETIC_REPLACEMENT'));
    if (action === 'caller') {
      assert.equal((await f.runner.discover()).ok, true);
    } else {
      failure(await f.runner.discover(), kind);
    }
  });
}

for (const completion of ['success', 'rejection']) {
  test('uncooperative GET overlap after cancellation isolates late ' + completion + ' from the next logical run', async (t) => {
    const oldResponse = deferred();
    const currentResponse = deferred();
    const requests = [];
    let unresolved = 0;
    let peak = 0;
    const client = {
      getAccount(value, options) {
        requests.push({ kind: 'account', value, signal: options.signal });
        unresolved++;
        peak = Math.max(peak, unresolved);
        const promise = requests.length === 1 ? oldResponse.promise : currentResponse.promise;
        return promise.finally(() => unresolved--);
      },
      async getHouseholds(value, options) {
        requests.push({ kind: 'households', value, signal: options.signal });
        return ok([]);
      },
      async getTonieboxes() {
        assert.fail('No households to enumerate');
      },
    };
    const f = fixture(t, { discoveryClient: client });
    const caller = new AbortController();
    const old = f.runner.discover({ signal: caller.signal });
    await flush();
    caller.abort();
    const cancelled = await old;
    failure(cancelled, 'cancelled');
    noSnapshot(cancelled);
    assert.equal(unresolved, 1, 'Underlying fake deliberately ignores abort');
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    assert.equal(f.jobs.size, 0);

    f.defaults.token = { ...access(), accessToken: 'SYNTHETIC_NEXT_ACCESS' };
    const current = f.runner.discover();
    await flush();
    assert.equal(peak, 2, 'Explicitly demonstrate physical overlap rather than hiding it');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].value, token);
    assert.equal(requests[1].value, 'SYNTHETIC_NEXT_ACCESS');
    failure(await f.runner.discover(), 'busy');
    if (completion === 'success') {
      oldResponse.resolve(ok({ id: 'SYNTHETIC_OBSOLETE_ACCOUNT', identitySource: 'id' }));
    } else {
      oldResponse.reject(new Error(secret));
    }
    await flush();
    await nextTurn();
    assert.equal(unresolved, 1);
    assert.equal(requests.length, 2, 'No continuation by the cancelled run');
    assert.equal(requests[1].signal.aborted, false);
    failure(await f.runner.discover(), 'busy');
    currentResponse.resolve(ok({ id: 'SYNTHETIC_CURRENT_ACCOUNT', identitySource: 'id' }));
    const result = await current;
    assert.equal(result.snapshot.account.id, 'SYNTHETIC_CURRENT_ACCOUNT');
    assert.equal(inspect(result).includes('SYNTHETIC_OBSOLETE'), false);
    assert.equal(inspect(result).includes(token), false);
    assert.equal(requests.length, 3);
    assert.equal(requests[2].value, 'SYNTHETIC_NEXT_ACCESS');
    assert.equal(unresolved, 0);
    assert.equal(f.calls.filter(c => c.kind === 'token').length, 2);
  });
}

for (const completion of ['success', 'rejection']) {
  test('real 4A cancellation settles its GET and cleans resources before later discovery: late ' + completion, async (t) => {
    const c = composed(t);
    const pending = deferred();
    const calls = [];
    let outstanding = 0;
    let peak = 0;
    const delegate = c.options.discoveryClient.getAccount;
    t.mock.method(c.options.discoveryClient, 'getAccount', (value, options) => {
      outstanding++;
      peak = Math.max(peak, outstanding);
      calls.push(options.signal);
      return delegate(value, options).finally(() => outstanding--);
    });
    c.replies.push(() => pending.promise);
    const caller = new AbortController();
    const p = c.runner.discover({ signal: caller.signal });
    await flush();
    caller.abort();
    failure(await p, 'cancelled');
    await flush();
    assert.equal(outstanding, 0, '4A settles even while its injected transport is unresolved');
    assert.equal(c.httpCalls[0].init.signal.aborted, true);
    assert.equal(getEventListeners(calls[0], 'abort').length, 0);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    assert.equal(c.httpJobs.size, 0);
    assert.equal(c.manager.getStatus().access, 'usable');
    c.replies.push(json({ uuid: 'SYNTHETIC_CURRENT_ACCOUNT' }), json([]));
    const result = await c.runner.discover();
    assert.equal(result.snapshot.account.id, 'SYNTHETIC_CURRENT_ACCOUNT');
    assert.equal(peak, 1, 'No overlapping unsettled 4A GET promises');
    assert.equal(c.authCalls.length, 1, 'Shared manager remains operational');
    let discarded = 0;
    if (completion === 'success') {
      pending.resolve(new Response(new ReadableStream({
        cancel() {
          discarded++;
        },
      }), { status: 429, headers: { 'Retry-After': '120' } }));
    } else {
      pending.reject(new Error(secret));
    }
    await flush();
    await nextTurn();
    assert.equal(discarded, completion === 'success' ? 1 : 0);
    assert.equal(c.httpCalls.length, 3);
    assert.equal(c.httpJobs.size, 0);
    c.replies.push(json({ uuid: 'SYNTHETIC_CURRENT_ACCOUNT' }), json([]));
    assert.equal((await c.runner.discover()).ok, true, 'Discarded transport response cannot install cooldown');
    assert.equal(result.snapshot.account.id, 'SYNTHETIC_CURRENT_ACCOUNT');
    c.runner.stop();
    assert.equal(c.manager.getStatus().renewal, 'ready');
  });
}
