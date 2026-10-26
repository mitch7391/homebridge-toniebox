import assert from 'node:assert/strict';
import console from 'node:console';
import { getEventListeners } from 'node:events';
import net from 'node:net';
import { after, afterEach, before, mock, test } from 'node:test';
import { inspect } from 'node:util';

const { AbortController, Response } = globalThis;
const credentials = Object.freeze({ username: ' SYNTHETIC_ACCOUNT ', password: ' SYNTHETIC_PASSWORD ' });
const changed = Object.freeze({ username: 'SYNTHETIC_OTHER', password: 'SYNTHETIC_OTHER_PASSWORD' });
const secret = 'SYNTHETIC_EXCEPTION_SECRET';
let createTokenManager;
let createAuthClient;
const fixtures = [];

before(async () => {
  const forbidden = () => assert.fail('Unexpected network or real timer');
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(net.Socket.prototype, 'connect', forbidden);
  mock.method(globalThis, 'setTimeout', forbidden);
  mock.method(globalThis, 'setInterval', forbidden);
  ({ createTokenManager } = await import('../dist/toniebox/tokenManager.js'));
  ({ createAuthClient } = await import('../dist/toniebox/authClient.js'));
});
after(() => mock.restoreAll());
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.manager.stop();
    assert.equal(f.unexpected, 0, 'Unexpected fake-client dispatch was sanitised by the manager');
    assert.ok(f.maximum <= 1, 'More than one lifecycle timer');
    assert.equal(f.jobs.size, 0);
    for (let i = 1; i < f.calls.length; i++) {
      assert.ok(f.calls[i].at - f.calls[i - 1].at >= 30000, 'Grant spacing was bypassed');
    }
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function success(name = 'A', overrides = {}) {
  return { ok: true, tokens: {
    accessToken: `SYNTHETIC_ACCESS_${name}`, refreshToken: `SYNTHETIC_REFRESH_${name}`,
    tokenType: 'Bearer', expiresInSeconds: 300, refreshExpiresInSeconds: 15552000, ...overrides,
  } };
}
const fail = (kind, extra = {}) => ({ ok: false, error: { kind, ...extra } });
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}
function fixture() {
  let mono = 0;
  let wall = 1800000000000;
  let maximum = 0;
  let unexpected = 0;
  const jobs = new Set();
  const history = [];
  const calls = [];
  const queue = [];
  const clock = { now: () => ({ monotonicMs: mono, wallMs: wall }) };
  const scheduler = {
    schedule(callback, delay) {
      const job = { callback, delay, at: mono + delay };
      jobs.add(job);
      history.push(job);
      maximum = Math.max(maximum, jobs.size);
      return () => jobs.delete(job);
    },
  };
  const invoke = (kind, input, options) => {
    calls.push({ kind, input, signal: options.signal, at: mono });
    if (queue.length === 0) {
      unexpected++;
      assert.fail('Unexpected authentication request');
    }
    const reply = queue.shift();
    return typeof reply === 'function' ? reply() : reply;
  };
  const authClient = {
    login: (input, options) => invoke('login', input, options),
    refresh: (input, options) => invoke('refresh', input, options),
  };
  const manager = createTokenManager({ authClient, clock, scheduler });
  const f = {
    manager, authClient, clock, scheduler, calls, queue, jobs, history,
    get unexpected() {
      return unexpected;
    },
    get maximum() {
      return maximum;
    },
    get mono() {
      return mono;
    },
    jump(ms, wallMs = ms) {
      mono += ms;
      wall += wallMs;
    },
    setTime(m, w = wall) {
      mono = m;
      wall = w;
    },
    async fire() {
      for (const job of [...jobs]) {
        if (job.at <= mono && jobs.delete(job)) {
          job.callback();
        }
      }
      await flush();
    },
    async advance(ms, wallMs = ms) {
      this.jump(ms, wallMs);
      await this.fire();
    },
    nextDelay() {
      assert.equal(jobs.size, 1);
      return [...jobs][0].at - mono;
    },
  };
  fixtures.push(f);
  return f;
}
function assertFailure(value, kind) {
  assert.equal(value.ok, false);
  assert.equal(value.error.kind, kind);
  assert.equal(inspect(value).includes(secret), false);
}
async function login(f, reply = success()) {
  f.queue.push(reply);
  assert.deepEqual(f.manager.setCredentials(credentials), { ok: true });
  return f.manager.getAccessToken();
}
async function renew(f, reply = success('B')) {
  f.queue.push(reply);
  await f.advance(240000);
}

test('import, construction, status and credential supply are inert and private', () => {
  const f = fixture();
  assert.equal(f.manager.getStatus().access, 'unavailable');
  f.manager.setCredentials(credentials);
  assert.equal(f.calls.length, 0);
  assert.equal(f.jobs.size, 0);
  assert.equal(inspect(f.manager).includes(credentials.password), false);
  assert.throws(() => createTokenManager({}), { message: 'Invalid token manager options' });
  f.manager.stop();
});

test('concurrent startup installs one flight before a reentrant client can acquire', async () => {
  const f = fixture();
  const d = deferred();
  let nested;
  f.queue.push(() => {
    nested = f.manager.getAccessToken();
    return d.promise;
  });
  f.manager.setCredentials(credentials);
  const callers = Array.from({ length: 100 }, () => f.manager.getAccessToken());
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].input, credentials);
  d.resolve(success());
  const results = await Promise.all([...callers, nested]);
  assert.ok(results.every(value => value.ok && value.accessToken === 'SYNTHETIC_ACCESS_A'));
  assert.equal(f.nextDelay(), 240000);
  assert.equal(f.maximum, 1);
  f.manager.stop();
});

test('multiple box consumers share an account while separate accounts remain isolated', async () => {
  const a = fixture();
  const b = fixture();
  a.queue.push(success('ACCOUNT_A'));
  b.queue.push(success('ACCOUNT_B'));
  a.manager.setCredentials(credentials);
  b.manager.setCredentials(changed);
  const results = await Promise.all([a.manager.getAccessToken(), a.manager.getAccessToken(), b.manager.getAccessToken()]);
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(results[0].accessToken, results[1].accessToken);
  assert.notEqual(results[0].accessToken, results[2].accessToken);
  a.manager.stop();
  b.manager.stop();
});

test('refresh atomically replaces opaque tokens and never returns the refresh token', async () => {
  const f = fixture();
  await login(f);
  await renew(f);
  assert.equal(f.calls[1].input, 'SYNTHETIC_REFRESH_A');
  assert.deepEqual(await f.manager.getAccessToken(), {
    ok: true, accessToken: 'SYNTHETIC_ACCESS_B', tokenType: 'Bearer', remainingLifetimeMs: 300000,
  });
  await renew(f, success('C'));
  assert.equal(f.calls[2].input, 'SYNTHETIC_REFRESH_B');
  assert.equal(inspect(f.manager.getStatus()).includes('SYNTHETIC'), false);
  f.manager.stop();
});

test('unknown refresh expiry remains unknown; known earlier expiry drives renewal', async () => {
  const unknown = fixture();
  await login(unknown, success('U', { refreshExpiresInSeconds: undefined }));
  assert.equal(unknown.nextDelay(), 240000);
  const known = fixture();
  await login(known, success('K', { refreshExpiresInSeconds: 100 }));
  assert.equal(known.nextDelay(), 80000);
  unknown.manager.stop();
  known.manager.stop();
});

test('a known expired refresh token is never submitted after suspension', async () => {
  const f = fixture();
  await login(f, success('A', { refreshExpiresInSeconds: 100 }));
  f.jump(100000);
  const result = await f.manager.getAccessToken();
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.nextDelay(), 30000);
  f.queue.push(success('B'));
  await f.advance(30000);
  assert.equal(f.calls[1].kind, 'login');
  f.manager.stop();
});

test('request-start accounting includes response latency and uses server lifetimes', async () => {
  const f = fixture();
  const d = deferred();
  const waiting = login(f, d.promise);
  f.jump(10000);
  d.resolve(success('A', { expiresInSeconds: 271 }));
  const value = await waiting;
  assert.equal(value.remainingLifetimeMs, 261000);
  assert.equal(f.nextDelay(), 206800);
  f.manager.stop();
});

test('consumer acquisition renews at the exact margin even if the timer has not fired', async () => {
  const f = fixture();
  await login(f);
  f.jump(239999);
  assert.equal((await f.manager.getAccessToken()).remainingLifetimeMs, 60001);
  assert.equal(f.calls.length, 1);
  f.jump(1);
  f.queue.push(success('B'));
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_B');
  assert.equal(f.calls.length, 2);
  f.manager.stop();
});

test('a timer racing with many consumers shares one refresh operation', async () => {
  const f = fixture();
  await login(f);
  const d = deferred();
  f.queue.push(d.promise);
  await f.advance(240000);
  const callers = Array.from({ length: 100 }, () => f.manager.getAccessToken());
  await f.fire();
  assert.equal(f.calls.length, 2);
  d.resolve(success('B'));
  assert.ok((await Promise.all(callers)).every(value => value.accessToken === 'SYNTHETIC_ACCESS_B'));
  assert.equal(f.maximum, 1);
  f.manager.stop();
});

test('long delays are clamped and rearmed without premature authentication', async () => {
  const f = fixture();
  await login(f, success('LONG', { expiresInSeconds: 3000000, refreshExpiresInSeconds: undefined }));
  assert.equal(f.nextDelay(), 2147483647);
  await f.advance(2147483647);
  assert.equal(f.calls.length, 1);
  assert.equal(f.nextDelay(), 3000000000 - 60000 - 2147483647);
  assert.equal(f.maximum, 1);
  f.manager.stop();
});

test('native background timers are unrefed and cancelled on stop', async (t) => {
  const handles = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const handle = { callback, delay, unrefs: 0, unref() {
      this.unrefs++;
    } };
    handles.push(handle);
    return handle;
  });
  const cleared = [];
  t.mock.method(globalThis, 'clearTimeout', handle => cleared.push(handle));
  const f = fixture();
  const manager = createTokenManager({ authClient: { login: async () => success(), refresh: async () => success() }, clock: f.clock });
  manager.setCredentials(credentials);
  await manager.getAccessToken();
  assert.equal(handles.length, 1);
  assert.equal(handles[0].unrefs, 1);
  manager.stop();
  assert.ok(cleared.includes(handles[0]));
});

test('pre-cancelled and invalid acquisition inputs do not start work', async () => {
  const f = fixture();
  f.manager.setCredentials(credentials);
  const controller = new AbortController();
  controller.abort(secret);
  assertFailure(await f.manager.getAccessToken({ signal: controller.signal }), 'cancelled');
  for (const options of [null, [], { signal: {} }]) {
    assertFailure(await f.manager.getAccessToken(options), 'invalid-input');
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.jobs.size, 0);
  f.manager.stop();
});

test('one caller cancellation leaves other waiters and rotation unaffected', async () => {
  const f = fixture();
  const d = deferred();
  f.queue.push(d.promise);
  f.manager.setCredentials(credentials);
  const controller = new AbortController();
  const cancelled = f.manager.getAccessToken({ signal: controller.signal });
  const other = f.manager.getAccessToken();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(secret);
  assertFailure(await cancelled, 'cancelled');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.calls[0].signal.aborted, false);
  d.resolve(success());
  assert.equal((await other).ok, true);
  f.manager.stop();
});

test('cancelling every refresh waiter still commits the rotated pair', async () => {
  const f = fixture();
  await login(f);
  f.jump(240000);
  const d = deferred();
  f.queue.push(d.promise);
  const controllers = Array.from({ length: 10 }, () => new AbortController());
  const results = controllers.map(value => f.manager.getAccessToken({ signal: value.signal }));
  controllers.forEach(value => value.abort());
  assert.ok((await Promise.all(results)).every(value => value.error.kind === 'cancelled'));
  assert.equal(f.calls[1].signal.aborted, false);
  d.resolve(success('ROTATED'));
  await flush();
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_ROTATED');
  f.manager.stop();
});

for (const action of ['clear', 'stop', 'replace']) {
  test(`${action} settles waiters immediately and rejects uncooperative late success`, async () => {
    const f = fixture();
    const d = deferred();
    const waiting = login(f, d.promise);
    if (action === 'replace') {
      f.manager.setCredentials(changed);
    } else {
      f.manager[action]();
    }
    assertFailure(await waiting, action === 'stop' ? 'stopped' : 'invalidated');
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.jobs.size, 0);
    d.resolve(success('STALE'));
    await flush();
    assert.equal(f.manager.getStatus().access, 'unavailable');
    if (action === 'stop') {
      f.manager.clear();
      assertFailure(f.manager.setCredentials(changed), 'stopped');
      assertFailure(await f.manager.getAccessToken(), 'stopped');
    }
    f.manager.stop();
  });
}

test('late rejection and old cleanup cannot disturb a newer flight or timer', async () => {
  const f = fixture();
  const old = deferred();
  const waiting = login(f, old.promise);
  f.manager.setCredentials(changed);
  assertFailure(await waiting, 'invalidated');
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  const newer = deferred();
  f.queue.push(newer.promise);
  await f.advance(30000);
  assert.equal(f.calls.length, 2);
  old.reject(new Error(secret));
  await flush();
  assert.equal(f.manager.getStatus().operation, 'login');
  newer.resolve(success('NEW'));
  await flush();
  const job = [...f.jobs][0];
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_NEW');
  f.manager.clear();
  job.callback();
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.jobs.size, 0);
  f.manager.stop();
});

test('queued cancelled timers cannot dispatch in a replacement generation', async () => {
  const f = fixture();
  await login(f);
  const old = [...f.jobs][0];
  f.manager.setCredentials(changed);
  f.jump(240000);
  old.callback();
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.jobs.size, 0);
  f.manager.stop();
});

test('refresh failure preserves access until exact expiry and never replays the token', async () => {
  const f = fixture();
  await login(f);
  await renew(f, fail('timeout'));
  assert.equal((await f.manager.getAccessToken()).remainingLifetimeMs, 60000);
  assert.equal(f.nextDelay(), 30000);
  f.queue.push(fail('transport'));
  await f.advance(30000);
  assert.equal(f.calls[2].kind, 'login');
  assert.equal(f.nextDelay(), 30000);
  await f.advance(30000);
  assert.equal(f.manager.getStatus().access, 'expired');
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.nextDelay(), 90000);
  assert.equal(f.calls.filter(value => value.kind === 'refresh').length, 1);
  f.manager.stop();
});

const transient = [
  fail('transport'), fail('timeout'), fail('cancelled'), fail('http', { status: 408 }),
  ...[500, 502, 503, 599].flatMap(status => [
    fail('http', { status }), fail('http', { status, oauthError: 'invalid_grant' }),
    fail('http', { status, oauthError: 'invalid_client' }),
  ]),
];
for (const [index, error] of transient.entries()) {
  test(`transient login failure ${index + 1} schedules recovery; HTTP precedence is explicit`, async () => {
    const f = fixture();
    assertFailure(await login(f, error), 'backoff');
    assert.equal(f.nextDelay(), 30000);
    assert.equal(f.manager.getStatus().renewal, 'backoff');
    f.manager.stop();
  });
}

test('HTTP 408 and 5xx override every recognised OAuth code for login and refresh', async () => {
  const codes = ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope'];
  for (const kind of ['login', 'refresh']) {
    for (const status of [408, 500, 503]) {
      for (const oauthError of codes) {
        const f = fixture();
        const error = fail('http', { status, oauthError });
        if (kind === 'login') {
          await login(f, error);
        } else {
          await login(f);
          await renew(f, error);
        }
        assert.equal(f.manager.getStatus().renewal, 'backoff');
        assert.equal(f.nextDelay(), 30000);
        f.manager.stop();
      }
    }
  }
});

test('definitive HTTP and OAuth login failures never schedule password retries', async () => {
  const cases = [
    ...[300, 302, 400, 401, 403, 404, 422].map(status => fail('http', { status })),
    ...['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']
      .map(oauthError => fail('http', { status: 400, oauthError })),
    fail('invalid-input'), fail('invalid-response'),
  ];
  for (const error of cases) {
    const f = fixture();
    assertFailure(await login(f, error), 'authentication-failed');
    assert.equal(f.jobs.size, 0);
    assertFailure(f.manager.setCredentials(credentials), 'reauthorization-required');
    f.jump(100000000);
    assertFailure(await f.manager.getAccessToken(), 'authentication-failed');
    assert.equal(f.calls.length, 1);
    f.manager.stop();
  }
});

test('refresh invalid_grant and malformed responses recover but other rejections pause', async () => {
  for (const error of [
    fail('http', { status: 400, oauthError: 'invalid_grant' }), fail('invalid-response'),
    fail('http', { status: 401, oauthError: 'invalid_grant' }), fail('http', { status: 403, oauthError: 'invalid_grant' }),
  ]) {
    const f = fixture();
    await login(f);
    await renew(f, error);
    assert.equal(f.manager.getStatus().renewal, 'backoff');
    assert.equal(f.nextDelay(), 30000);
    f.manager.stop();
  }
  for (const error of [
    fail('http', { status: 401 }), fail('http', { status: 403 }), fail('invalid-input'),
    fail('http', { status: 400, oauthError: 'invalid_client' }),
  ]) {
    const f = fixture();
    await login(f);
    await renew(f, error);
    assert.equal(f.manager.getStatus().renewal, 'attention-required');
    assert.equal((await f.manager.getAccessToken()).ok, true);
    assert.equal(f.nextDelay(), 60000);
    await f.advance(60000);
    assert.equal(f.jobs.size, 0);
    f.manager.stop();
  }
});

test('429 dominates OAuth metadata, pauses automation and survives explicit clear', async () => {
  const f = fixture();
  await login(f, fail('http', { status: 429, oauthError: 'invalid_grant' }));
  assert.equal(f.manager.getStatus().reason, 'rate-limited');
  assert.equal(f.jobs.size, 0);
  assertFailure(f.manager.setCredentials(changed), 'reauthorization-required');
  f.manager.clear();
  f.manager.setCredentials(credentials);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.nextDelay(), 3600000);
  f.queue.push(fail('http', { status: 429, oauthError: 'invalid_client' }));
  await f.advance(3600000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.getStatus().reason, 'rate-limited');
  assert.equal(f.manager.getStatus().retryAfterMs, 3600000);
  assert.equal(f.jobs.size, 0);
  f.manager.stop();
});

test('30-minute outage recovers unattended on the scheduled later attempt', async () => {
  const f = fixture();
  await login(f);
  await renew(f, fail('transport'));
  const start = f.mono;
  for (const delay of [30000, 120000, 900000]) {
    f.queue.push(fail('transport'));
    await f.advance(delay);
  }
  assert.equal(f.mono - start, 1050000);
  f.jump(750000);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.calls.length, 5);
  f.queue.push(success('RESTORED'));
  await f.advance(1050000);
  assert.equal(f.mono - start, 2850000);
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_RESTORED');
  await renew(f, success('REFRESHED'));
  await renew(f, fail('transport'));
  assert.equal(f.nextDelay(), 30000);
  assert.equal(f.maximum, 1);
  f.manager.stop();
});

test('prolonged failures settle into hourly recovery without consumer bypass', async () => {
  const f = fixture();
  await login(f, fail('transport'));
  for (const delay of [30000, 120000, 900000, 1800000, 3600000, 3600000, 3600000]) {
    assert.equal(f.nextDelay(), delay);
    const count = f.calls.length;
    for (let i = 0; i < 100; i++) {
      assertFailure(await f.manager.getAccessToken(), 'backoff');
      f.manager.setCredentials(credentials);
    }
    assert.equal(f.calls.length, count);
    f.queue.push(fail('timeout'));
    await f.advance(delay);
  }
  assert.equal(f.nextDelay(), 3600000);
  assert.equal(f.maximum, 1);
  f.manager.stop();
});

test('password success retains backoff progression; successful refresh resets it', async () => {
  const f = fixture();
  await login(f, fail('transport'));
  f.queue.push(success('A'));
  await f.advance(30000);
  await renew(f, fail('transport'));
  assert.equal(f.manager.getStatus().retryAfterMs, 120000);
  f.queue.push(success('B'));
  await f.advance(120000);
  await renew(f, success('C'));
  await renew(f, fail('transport'));
  assert.equal(f.manager.getStatus().retryAfterMs, 30000);
  f.manager.stop();
});

test('third password pair can refresh but a fourth password grant is blocked', async () => {
  const f = fixture();
  await login(f);
  await renew(f, fail('transport'));
  f.queue.push(success('B'));
  await f.advance(30000);
  await renew(f, fail('transport'));
  f.queue.push(success('C'));
  await f.advance(120000);
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_C');
  await renew(f, fail('transport'));
  assert.equal(f.manager.getStatus().reason, 'refresh-recovery-exhausted');
  assert.equal(f.calls.filter(value => value.kind === 'login').length, 3);
  assertFailure(f.manager.setCredentials(credentials), 'reauthorization-required');
  assertFailure(f.manager.setCredentials(changed), 'reauthorization-required');
  await f.advance(60000);
  assert.equal(f.jobs.size, 0);
  f.manager.clear();
  f.manager.setCredentials(credentials);
  f.queue.push(success('RESET'));
  assert.equal((await f.manager.getAccessToken()).ok, true);
  f.manager.stop();
});

test('a successful refresh of the third password pair replenishes fallback protection', async () => {
  const f = fixture();
  await login(f);
  await renew(f, fail('timeout'));
  f.queue.push(success('B'));
  await f.advance(30000);
  await renew(f, fail('timeout'));
  f.queue.push(success('C'));
  await f.advance(120000);
  await renew(f, success('D'));
  await renew(f, fail('timeout'));
  f.queue.push(success('E'));
  await f.advance(30000);
  assert.equal(f.calls.filter(value => value.kind === 'login').length, 4);
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_E');
  f.manager.stop();
});

test('15-second tokens remain usable but hundreds of consumers cannot renew them', async () => {
  const f = fixture();
  f.queue.push(success('SHORT', { expiresInSeconds: 15 }));
  f.manager.setCredentials(credentials);
  const results = await Promise.all(Array.from({ length: 200 }, () => f.manager.getAccessToken()));
  assert.ok(results.every(value => value.ok && value.remainingLifetimeMs === 15000));
  assert.equal(f.manager.getStatus().reason, 'insufficient-lifetime');
  assert.equal(f.nextDelay(), 15000);
  f.jump(12000);
  for (let i = 0; i < 200; i++) {
    assert.equal((await f.manager.getAccessToken()).remainingLifetimeMs, 3000);
  }
  await f.advance(3000);
  assert.equal(f.jobs.size, 0);
  for (let i = 0; i < 200; i++) {
    assertFailure(await f.manager.getAccessToken(), 'insufficient-lifetime');
  }
  assert.equal(f.calls.length, 1);
  assertFailure(f.manager.setCredentials(credentials), 'reauthorization-required');
  f.manager.clear();
  f.manager.setCredentials(credentials);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  f.queue.push(success('NORMAL'));
  await f.advance(15000);
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_NORMAL');
  assert.equal(f.manager.getStatus().renewal, 'ready');
  f.manager.stop();
});

test('receipt boundary is strictly less than 30 seconds, including response latency', async () => {
  for (const latency of [2000, 2001]) {
    const f = fixture();
    const d = deferred();
    const waiting = login(f, d.promise);
    f.jump(latency);
    d.resolve(success('BOUNDARY', { expiresInSeconds: 40 }));
    assert.equal((await waiting).ok, true);
    assert.equal(f.manager.getStatus().reason, latency === 2001 ? 'insufficient-lifetime' : undefined);
    assert.equal(f.nextDelay(), latency === 2001 ? 37999 : 30000);
    f.manager.stop();
  }
});

test('already-expired responses pause without looping or retaining usable access', async () => {
  const f = fixture();
  const d = deferred();
  const waiting = login(f, d.promise);
  f.jump(300000);
  d.resolve(success());
  assertFailure(await waiting, 'insufficient-lifetime');
  assert.equal(f.manager.getStatus().access, 'expired');
  assert.equal(f.jobs.size, 0);
  assert.equal(f.calls.length, 1);
  f.manager.stop();
});

test('short refresh lifetime also suspends renewal and expiry cleanup makes no request', async () => {
  const f = fixture();
  await login(f, success('SHORT_REFRESH', { refreshExpiresInSeconds: 15 }));
  assert.equal(f.manager.getStatus().reason, 'insufficient-lifetime');
  assert.equal(f.nextDelay(), 300000);
  await f.advance(300000);
  assert.equal(f.jobs.size, 0);
  assert.equal(f.calls.length, 1);
  f.manager.stop();
});

test('short lifetime received from refresh adopts the new access and never rolls back', async () => {
  const f = fixture();
  await login(f);
  await renew(f, success('SHORT_ROTATION', { expiresInSeconds: 15 }));
  assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_SHORT_ROTATION');
  await f.advance(15000);
  assertFailure(await f.manager.getAccessToken(), 'insufficient-lifetime');
  assert.equal(f.calls.length, 2);
  f.manager.stop();
});

test('identical credentials preserve login, refresh, healthy and backoff states', async () => {
  const f = fixture();
  const d = deferred();
  const waiting = login(f, d.promise);
  f.manager.setCredentials({ ...credentials });
  assert.equal(f.calls[0].signal.aborted, false);
  d.resolve(success());
  await waiting;
  const job = [...f.jobs][0];
  f.manager.setCredentials({ ...credentials });
  assert.equal([...f.jobs][0], job);
  f.jump(240000);
  const r = deferred();
  f.queue.push(r.promise);
  const refreshing = f.manager.getAccessToken();
  f.manager.setCredentials(credentials);
  assert.equal(f.calls[1].signal.aborted, false);
  r.resolve(fail('transport'));
  await refreshing;
  const retry = [...f.jobs][0];
  f.manager.setCredentials(credentials);
  assert.equal([...f.jobs][0], retry);
  assert.equal(f.calls.length, 2);
  f.manager.stop();
});

test('invalid replacements do not alter context or cooldown; valid changes preserve spacing', async () => {
  const f = fixture();
  await login(f);
  for (const input of [null, {}, { username: ' ', password: 'x' }, { username: 'x', password: '' }]) {
    const job = [...f.jobs][0];
    assertFailure(f.manager.setCredentials(input), 'invalid-input');
    assert.equal([...f.jobs][0], job);
    assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_A');
  }
  f.manager.setCredentials(changed);
  assert.equal(f.jobs.size, 0);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.nextDelay(), 30000);
  f.queue.push(success('NEW'));
  await f.advance(30000);
  assert.equal(f.calls[1].at - f.calls[0].at, 30000);
  assert.deepEqual(f.calls[1].input, changed);
  f.manager.stop();
});

test('clear and changed credentials preserve an outstanding extended recovery cooldown', async () => {
  for (const action of ['clear', 'replace']) {
    const f = fixture();
    await login(f, fail('transport'));
    f.queue.push(fail('transport'));
    await f.advance(30000);
    if (action === 'clear') {
      f.manager.clear();
    }
    f.manager.setCredentials(changed);
    assertFailure(await f.manager.getAccessToken(), 'backoff');
    assert.equal(f.nextDelay(), 120000);
    f.queue.push(success('NEW'));
    await f.advance(120000);
    assert.equal(f.calls.length, 3);
    f.manager.stop();
  }
});

test('username and password comparisons preserve whitespace and exact values', async () => {
  const f = fixture();
  f.manager.setCredentials({ username: 'SYNTHETIC', password: ' ' });
  f.queue.push(success());
  await f.manager.getAccessToken();
  assert.deepEqual(f.calls[0].input, { username: 'SYNTHETIC', password: ' ' });
  f.manager.setCredentials({ username: 'synthetic', password: ' ' });
  assert.equal(f.manager.getStatus().access, 'unavailable');
  f.manager.stop();
});

test('backward wall changes cannot extend tokens; forward age cannot be undone', async () => {
  const f = fixture();
  await login(f);
  f.jump(10000, -100000);
  assert.equal(f.manager.getStatus().accessRemainingMs, 290000);
  f.jump(0, 350000);
  assert.equal(f.manager.getStatus().accessRemainingMs, 50000);
  f.jump(0, -350000);
  assert.equal(f.manager.getStatus().accessRemainingMs, 50000);
  f.manager.stop();
});

test('wall-clock suspension evidence expires access without bypassing monotonic backoff', async () => {
  const f = fixture();
  await login(f);
  await renew(f, fail('timeout'));
  f.jump(0, 3600000);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.getStatus().retryAfterMs, 30000);
  f.manager.stop();
});

test('delayed callback handles expiry without reviving old access', async () => {
  const f = fixture();
  await login(f);
  f.queue.push(fail('timeout'));
  await f.advance(400000);
  assert.equal(f.manager.getStatus().access, 'expired');
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.calls.length, 2);
  f.manager.stop();
});

test('invalid or regressing clocks fail closed and settle in-flight waiters', async () => {
  for (const invalid of [-1, NaN, Infinity]) {
    const f = fixture();
    const d = deferred();
    const waiting = login(f, d.promise);
    f.setTime(invalid);
    assert.equal(f.manager.getStatus().reason, 'clock-invalid');
    assertFailure(await waiting, 'clock-invalid');
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.jobs.size, 0);
    d.resolve(success('LATE'));
    await flush();
    f.manager.stop();
  }
  const f = fixture();
  await login(f);
  f.jump(1000);
  f.manager.getStatus();
  f.setTime(999);
  assert.equal(f.manager.getStatus().reason, 'clock-invalid');
  f.manager.stop();
});

test('malformed client results cannot introduce invalid lifetimes or partial pairs', async () => {
  const values = [
    null, {}, success('X', { accessToken: '' }), success('X', { refreshToken: undefined }),
    ...[undefined, 0, -1, 1.5, NaN, Infinity, '300', Number.MAX_SAFE_INTEGER].map(expiresInSeconds => success('X', { expiresInSeconds })),
    success('X', { refreshExpiresInSeconds: 0 }),
  ];
  for (const value of values) {
    const f = fixture();
    assertFailure(await login(f, value), 'authentication-failed');
    assert.equal(f.jobs.size, 0);
    assert.equal(f.manager.getStatus().access, 'unavailable');
    f.manager.stop();
  }
});

test('caller mutation cannot alter token ownership, credentials or safe diagnostics', async () => {
  const f = fixture();
  const input = { ...credentials };
  const reply = success();
  f.manager.setCredentials(input);
  input.password = secret;
  f.queue.push(reply);
  const value = await f.manager.getAccessToken();
  reply.tokens.refreshToken = secret;
  value.accessToken = secret;
  assert.equal(f.calls[0].input.password, credentials.password);
  await renew(f, fail('http', { status: 503, oauthError: 'invalid_grant', cause: secret }));
  assert.equal(f.calls[1].input, 'SYNTHETIC_REFRESH_A');
  const status = f.manager.getStatus();
  status.authFailure.oauthError = secret;
  assert.equal(f.manager.getStatus().authFailure.oauthError, 'invalid_grant');
  f.manager.stop();
});

test('throws, rejected promises and arbitrary diagnostic fields cannot leak secrets', async (t) => {
  const output = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => output.push(args));
  }
  for (const reply of [
    () => {
      throw new Error(secret);
    },
    () => Promise.reject(new Error(secret)),
    fail('http', { status: 401, oauthError: secret, message: secret, cause: new Error(secret) }),
  ]) {
    const f = fixture();
    const value = await login(f, reply);
    const diagnostics = inspect([value, f.manager.getStatus(), f.manager]);
    for (const sensitive of [secret, credentials.username, credentials.password, 'SYNTHETIC_ACCESS', 'SYNTHETIC_REFRESH']) {
      assert.equal(diagnostics.includes(sensitive), false);
    }
    assert.equal(f.calls.length, 1);
    f.manager.stop();
  }
  assert.deepEqual(output, []);
});

test('successful and invalidated waiters remove caller listeners; stop removes timers', async () => {
  const f = fixture();
  const d = deferred();
  f.manager.setCredentials(credentials);
  f.queue.push(d.promise);
  const controller = new AbortController();
  const waiting = f.manager.getAccessToken({ signal: controller.signal });
  d.resolve(success());
  await waiting;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  f.jump(240000);
  const never = deferred();
  f.queue.push(never.promise);
  const pending = f.manager.getAccessToken({ signal: controller.signal });
  f.manager.stop();
  assertFailure(await pending, 'stopped');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.jobs.size, 0);
  never.reject(new Error(secret));
  await flush();
  assert.equal(f.jobs.size, 0);
});

test('real 3A client integrates through synthetic HTTP without exposing protocol details', async (t) => {
  const deadlines = new Set();
  t.mock.method(globalThis, 'setTimeout', callback => {
    deadlines.add(callback);
    return callback;
  });
  t.mock.method(globalThis, 'clearTimeout', callback => deadlines.delete(callback));
  const f = fixture();
  const requests = [];
  const client = createAuthClient({
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        access_token: 'SYNTHETIC_WIRE_ACCESS', refresh_token: 'SYNTHETIC_WIRE_REFRESH',
        token_type: 'Bearer', expires_in: 300,
      }), { status: 200 });
    },
  });
  const manager = createTokenManager({ authClient: client, clock: f.clock, scheduler: f.scheduler });
  manager.setCredentials(credentials);
  assert.equal((await manager.getAccessToken()).accessToken, 'SYNTHETIC_WIRE_ACCESS');
  assert.equal(requests.length, 1);
  assert.equal(deadlines.size, 0);
  manager.stop();
  assert.equal(f.jobs.size, 0);
});

test('recovery delay begins at failure settlement, not dispatch', async () => {
  const f = fixture();
  const d = deferred();
  const waiting = login(f, d.promise);
  f.jump(10000);
  d.resolve(fail('timeout'));
  assertFailure(await waiting, 'backoff');
  assert.equal(f.nextDelay(), 30000);
  f.manager.clear();
  f.manager.setCredentials(changed);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.nextDelay(), 30000);
  f.queue.push(success('NEW'));
  await f.advance(30000);
  assert.equal(f.calls[1].at, 40000);
  f.manager.stop();
});

test('unknown refresh expiry does not acquire a guessed 180-day limit', async () => {
  const f = fixture();
  await login(f, success('A', { refreshExpiresInSeconds: undefined }));
  f.jump(200 * 86400000);
  f.queue.push(success('B'));
  assert.equal((await f.manager.getAccessToken()).ok, true);
  assert.equal(f.calls[1].kind, 'refresh');
  assert.equal(f.calls[1].input, 'SYNTHETIC_REFRESH_A');
  f.manager.stop();
});

test('identical token strings on successful refresh still establish new lifetimes', async () => {
  const f = fixture();
  await login(f);
  await renew(f, success('A', { expiresInSeconds: 600 }));
  assert.equal((await f.manager.getAccessToken()).remainingLifetimeMs, 600000);
  assert.equal(f.nextDelay(), 540000);
  f.manager.stop();
});

test('refresh 429 preserves access, cleans up expiry and never schedules another grant', async () => {
  const f = fixture();
  await login(f);
  await renew(f, fail('http', { status: 429, oauthError: 'invalid_client' }));
  assert.equal(f.manager.getStatus().reason, 'rate-limited');
  assert.equal((await f.manager.getAccessToken()).remainingLifetimeMs, 60000);
  assert.equal(f.nextDelay(), 60000);
  await f.advance(60000);
  assertFailure(await f.manager.getAccessToken(), 'rate-limited');
  assert.equal(f.jobs.size, 0);
  assert.equal(f.calls.length, 2);
  f.manager.clear();
  f.manager.setCredentials(credentials);
  assertFailure(await f.manager.getAccessToken(), 'backoff');
  assert.equal(f.nextDelay(), 3540000);
  f.manager.stop();
});

for (const action of ['clear', 'stop', 'replace']) {
  test(`${action} during refresh rejects late rotation without affecting replacement authentication`, async () => {
    const f = fixture();
    await login(f);
    f.jump(240000);
    const old = deferred();
    f.queue.push(old.promise);
    const waiting = f.manager.getAccessToken();
    if (action === 'replace') {
      f.manager.setCredentials(changed);
    } else {
      f.manager[action]();
    }
    assertFailure(await waiting, action === 'stop' ? 'stopped' : 'invalidated');
    assert.equal(f.calls[1].signal.aborted, true);
    if (action === 'stop') {
      old.resolve(success('STALE'));
      await flush();
      assert.equal(f.jobs.size, 0);
      return;
    }
    if (action === 'clear') {
      f.manager.setCredentials(changed);
    }
    assertFailure(await f.manager.getAccessToken(), 'backoff');
    const newer = deferred();
    f.queue.push(newer.promise);
    await f.advance(30000);
    old.resolve(success('STALE'));
    await flush();
    assert.equal(f.manager.getStatus().operation, 'login');
    newer.resolve(success('NEW'));
    await flush();
    assert.equal((await f.manager.getAccessToken()).accessToken, 'SYNTHETIC_ACCESS_NEW');
    f.manager.stop();
  });
}

test('a cancelled expiry callback racing with short-token consumers cannot renew', async () => {
  const f = fixture();
  await login(f);
  f.jump(240000);
  const d = deferred();
  f.queue.push(d.promise);
  const waiting = f.manager.getAccessToken();
  const oldExpiry = [...f.jobs][0];
  d.resolve(success('SHORT', { expiresInSeconds: 15 }));
  await waiting;
  for (let i = 0; i < 100; i++) {
    oldExpiry.callback();
    assert.equal((await f.manager.getAccessToken()).ok, true);
  }
  await f.advance(15000);
  oldExpiry.callback();
  assertFailure(await f.manager.getAccessToken(), 'insufficient-lifetime');
  assert.equal(f.calls.length, 2);
  assert.equal(f.jobs.size, 0);
  f.manager.stop();
});

test('an exact normal expiry never returns old access while a refresh is pending', async () => {
  const f = fixture();
  await login(f);
  f.jump(300000);
  const d = deferred();
  f.queue.push(d.promise);
  const waiting = f.manager.getAccessToken();
  assert.equal(f.manager.getStatus().access, 'expired');
  assert.equal(f.manager.getStatus().operation, 'refresh');
  d.resolve(fail('transport'));
  assertFailure(await waiting, 'backoff');
  assert.equal(f.calls.length, 2);
  f.manager.stop();
});
