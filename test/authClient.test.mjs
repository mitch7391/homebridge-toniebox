import assert from 'node:assert/strict';
import console from 'node:console';
import { getEventListeners } from 'node:events';
import net from 'node:net';
import { ReadableStream } from 'node:stream/web';
import { after, before, mock, test } from 'node:test';
import { URLSearchParams } from 'node:url';
import { inspect, TextEncoder } from 'node:util';

const { AbortController, AbortSignal, Response } = globalThis;

let createAuthClient;
const endpoint = 'https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token';
const credentials = Object.freeze({ username: ' SYNTHETIC_USER+&=é ', password: ' \tSYNTHETIC_PASSWORD+&=雪 ' });
const secret = 'SYNTHETIC_PRIVATE_ERROR';
const encoder = new TextEncoder();

before(async () => {
  const forbidden = () => assert.fail('Authentication tests attempted real network activity');
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(net.Socket.prototype, 'connect', forbidden);
  const timeout = mock.method(globalThis, 'setTimeout', () => assert.fail('Import scheduled work'));
  const interval = mock.method(globalThis, 'setInterval', () => assert.fail('Import scheduled work'));
  try {
    ({ createAuthClient } = await import('../dist/toniebox/authClient.js'));
  } finally {
    timeout.mock.restore();
    interval.mock.restore();
  }
});
after(() => mock.restoreAll());

function wire(overrides = {}) {
  return {
    access_token: 'SYNTHETIC_ACCESS_NEW',
    refresh_token: 'SYNTHETIC_REFRESH_NEW',
    token_type: 'Bearer',
    expires_in: 271,
    refresh_expires_in: 7654321,
    ...overrides,
  };
}
function response(overrides = {}, status = 200) {
  return new Response(JSON.stringify(wire(overrides)), { status });
}
function fixture(responder = () => response(), options = {}) {
  const calls = [];
  const client = createAuthClient({
    ...options,
    fetch: (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  });
  return { client, calls };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** No wall-clock waits, including tests of transports which ignore abort forever. */
function clock(t) {
  let now = 0;
  let id = 0;
  const pending = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    pending.set(++id, { callback, at: now + delay });
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', key => pending.delete(key));
  return {
    pending,
    tick(ms) {
      now += ms;
      for (const [key, job] of [...pending]) {
        if (job.at <= now) {
          pending.delete(key);
          job.callback();
        }
      }
    },
  };
}
function bodyFixture(cancel = () => undefined) {
  const reading = deferred();
  const cancelled = deferred();
  let controller;
  let cancellations = 0;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
    pull() {
      reading.resolve();
    },
    cancel() {
      cancellations++;
      cancelled.resolve();
      return cancel();
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(body),
    body,
    reading: reading.promise,
    cancelled: cancelled.promise,
    get cancellations() {
      return cancellations;
    },
    push: value => controller.enqueue(value),
    close: () => controller.close(),
    error: () => controller.error(new Error(secret)),
  };
}
function assertFailure(result, kind, extra = {}) {
  assert.deepEqual(result, { ok: false, error: { kind, ...extra } });
  assert.equal(inspect(result).includes(secret), false);
}

test('constructing either default or injected client is inert', (t) => {
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('Construction scheduled work'));
  t.mock.method(globalThis, 'setInterval', () => assert.fail('Construction scheduled work'));
  const custom = fixture(() => assert.fail('Construction dispatched HTTP'));
  createAuthClient();
  assert.equal(custom.calls.length, 0);
});

test('login uses the exact endpoint, safe request options and lossless form encoding', async () => {
  const { client, calls } = fixture();
  const result = await client.login(credentials);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' });
  assert.deepEqual([...new URLSearchParams(init.body)], [
    ['client_id', 'meine-tonies'], ['grant_type', 'password'],
    ['username', credentials.username], ['password', credentials.password], ['scope', 'openid'],
  ]);
  assert.ok(init.body.includes('%2B%26%3D'));
  assert.ok(init.body.includes('%E9%9B%AA'));
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
});

test('refresh sends only its grant and current token and preserves the complete replacement pair', async () => {
  const { client, calls } = fixture();
  const result = await client.refresh(' SYNTHETIC_OLD+&=TOKEN ');
  assert.deepEqual([...new URLSearchParams(calls[0].init.body)], [
    ['client_id', 'meine-tonies'], ['grant_type', 'refresh_token'], ['refresh_token', ' SYNTHETIC_OLD+&=TOKEN '],
  ]);
  assert.deepEqual(result, {
    ok: true,
    tokens: {
      accessToken: 'SYNTHETIC_ACCESS_NEW', refreshToken: 'SYNTHETIC_REFRESH_NEW',
      tokenType: 'Bearer', expiresInSeconds: 271, refreshExpiresInSeconds: 7654321,
    },
  });
  assert.equal(calls.length, 1);
});

test('tokens stay opaque and unaltered; only token type is canonicalised and extra fields are discarded', async () => {
  const raw = wire({
    access_token: ' SYNTHETIC_OPAQUE+&=é ', refresh_token: ' SYNTHETIC_REFRESH+&=雪 ', token_type: 'bEaReR',
    id_token: secret, session_state: secret, error_description: secret, unknown: { account: secret },
  });
  const { client } = fixture(() => new Response(JSON.stringify(raw)));
  const result = await client.login(credentials);
  assert.equal(result.ok, true);
  assert.equal(result.tokens.accessToken, raw.access_token);
  assert.equal(result.tokens.refreshToken, raw.refresh_token);
  assert.equal(result.tokens.tokenType, 'Bearer');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(Object.keys(result.tokens).length, 5);
});

test('refresh need not change token text but must supply a complete pair every time', async () => {
  const { client, calls } = fixture(() => response({ refresh_token: 'SYNTHETIC_SAME' }));
  assert.equal((await client.refresh('SYNTHETIC_SAME')).tokens.refreshToken, 'SYNTHETIC_SAME');
  const missing = fixture(() => response({ refresh_token: undefined }));
  assertFailure(await missing.client.refresh('SYNTHETIC_OLD'), 'invalid-response', { status: 200 });
  assert.equal(calls.length, 1);
  assert.equal(missing.calls.length, 1);
});

test('invalid credentials and refresh inputs are rejected before scheduling or dispatch', async (t) => {
  const time = clock(t);
  const { client, calls } = fixture();
  for (const input of [null, undefined, [], '', {}, { username: 1, password: 'x' },
    { username: '', password: 'x' }, { username: ' \t', password: 'x' },
    { username: 'SYNTHETIC', password: '' }, { username: 'SYNTHETIC', password: false }]) {
    assertFailure(await client.login(input), 'invalid-input');
  }
  for (const input of [null, undefined, 1, false, {}, [], '', ' \t']) {
    assertFailure(await client.refresh(input), 'invalid-input');
  }
  assert.equal(calls.length, 0);
  assert.equal(time.pending.size, 0);
});

test('password whitespace is preserved rather than interpreted or stripped', async () => {
  const { client, calls } = fixture();
  assert.equal((await client.login({ username: 'SYNTHETIC', password: ' \t ' })).ok, true);
  assert.equal(new URLSearchParams(calls[0].init.body).get('password'), ' \t ');
});

test('invalid timeout and signal options fail safely without dispatch', async (t) => {
  const time = clock(t);
  for (const timeoutMs of [null, 0, -1, 1.5, NaN, Infinity, 2147483648, '15000']) {
    const { client, calls } = fixture(undefined, { timeoutMs });
    assertFailure(await client.login(credentials), 'invalid-input');
    assert.equal(calls.length, 0);
  }
  const { client, calls } = fixture();
  for (const options of [null, [], { signal: false }, { signal: {} }]) {
    assertFailure(await client.refresh('SYNTHETIC', options), 'invalid-input');
  }
  assert.equal(calls.length, 0);
  assert.equal(time.pending.size, 0);
});

test('invalid client options never fall back to a live default transport', async (t) => {
  const time = clock(t);
  for (const options of [null, [], 'invalid', { fetch: null }, { fetch: false }, { fetch: {} }]) {
    const client = createAuthClient(options);
    assertFailure(await client.login(credentials), 'invalid-input');
    assertFailure(await client.refresh('SYNTHETIC'), 'invalid-input');
  }
  assert.equal(time.pending.size, 0);
});

test('missing, malformed or blank required token fields reject the whole response', async () => {
  const cases = [];
  for (const field of ['access_token', 'refresh_token']) {
    for (const value of [undefined, null, '', ' \t', 123, false, [], {}]) {
      cases.push({ [field]: value });
    }
  }
  for (const value of [undefined, null, '', ' Bearer', 'Bearer ', 'Basic', 1, {}]) {
    cases.push({ token_type: value });
  }
  for (const change of cases) {
    const { client, calls } = fixture(() => response(change));
    assertFailure(await client.login(credentials), 'invalid-response', { status: 200 });
    assert.equal(calls.length, 1);
  }
});

test('expiry validation rejects coercion, nonpositive, fractional and overflowing values', async () => {
  for (const field of ['expires_in', 'refresh_expires_in']) {
    for (const value of [null, '300', true, {}, [], 0, -1, 1.5, NaN, Infinity,
      Number.MAX_SAFE_INTEGER, Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1]) {
      const { client } = fixture(() => response({ [field]: value }));
      assertFailure(await client.refresh('SYNTHETIC'), 'invalid-response', { status: 200 });
    }
  }
  const missing = fixture(() => response({ expires_in: undefined }));
  assertFailure(await missing.client.login(credentials), 'invalid-response', { status: 200 });
  const infinite = fixture(() => new Response('{"access_token":"SYNTHETIC","refresh_token":"SYNTHETIC","token_type":"Bearer","expires_in":1e400}'));
  assertFailure(await infinite.client.login(credentials), 'invalid-response', { status: 200 });
});

test('optional refresh expiry and safe lifetime boundaries are accepted without guessed defaults', async () => {
  const max = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
  for (const expires_in of [1, 149, max]) {
    const { client } = fixture(() => response({ expires_in, refresh_expires_in: undefined }));
    const result = await client.login(credentials);
    assert.equal(result.ok, true);
    assert.equal(result.tokens.expiresInSeconds, expires_in);
    assert.equal(Object.hasOwn(result.tokens, 'refreshExpiresInSeconds'), false);
  }
  const { client } = fixture(() => response({ refresh_expires_in: max }));
  assert.equal((await client.refresh('SYNTHETIC')).tokens.refreshExpiresInSeconds, max);
});

test('HTTP statuses remain HTTP failures without implying incorrect credentials or retrying', async () => {
  for (const status of [400, 401, 403, 429, 500, 502, 503, 599]) {
    const { client, calls } = fixture(() => new Response(JSON.stringify({ error: secret, error_description: secret }), { status }));
    assertFailure(await client.login(credentials), 'http', { status });
    assert.equal(calls.length, 1);
  }
});

test('invalid injected HTTP status metadata cannot enter a public failure', async () => {
  for (const status of [secret, '401', NaN, Infinity, undefined, 0, 200.5, 600]) {
    const { client, calls } = fixture(() => ({ status, ok: false, body: null }));
    assertFailure(await client.login(credentials), 'invalid-response');
    assert.equal(calls.length, 1);
  }
});

test('only recognised OAuth error codes can cross the HTTP failure boundary', async () => {
  for (const error of ['invalid_request', 'invalid_client', 'invalid_grant',
    'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']) {
    const { client } = fixture(() => new Response(JSON.stringify({ error, error_description: secret, error_uri: secret }), { status: 400 }));
    assertFailure(await client.refresh('SYNTHETIC'), 'http', { status: 400, oauthError: error });
  }
  for (const error of [secret, 'INVALID_GRANT', '', 1, null, ['invalid_grant'], { code: 'invalid_grant' }]) {
    const { client } = fixture(() => new Response(JSON.stringify({ error }), { status: 401 }));
    assertFailure(await client.login(credentials), 'http', { status: 401 });
  }
});

test('invalid HTTP error bodies retain their status; successful status still requires valid JSON tokens', async () => {
  for (const body of ['', '<html>' + secret, '{"error_description":"' + secret, 'null', '[]', 'false', '42', '"SYNTHETIC"', '{}']) {
    for (const status of [200, 400, 503]) {
      const { client } = fixture(() => new Response(body, { status }));
      assertFailure(await client.login(credentials), status === 200 ? 'invalid-response' : 'http', { status });
    }
  }
  const empty = fixture(() => new Response(null, { status: 204 }));
  assertFailure(await empty.client.login(credentials), 'invalid-response', { status: 204 });
});

test('redirects are not followed and their unused bodies are cancelled', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const stream = bodyFixture();
    const redirected = new Response(stream.body, { status, headers: { Location: 'https://synthetic.invalid/' + secret } });
    const { client, calls } = fixture(() => redirected);
    assertFailure(await client.login(credentials), 'http', { status });
    await stream.cancelled;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
  }
});

test('transport throws and rejected promises are sanitised and attempted only once', async () => {
  for (const responder of [
    () => {
      throw new Error(secret, { cause: { password: secret } });
    },
    () => Promise.reject(new Error(secret)),
    () => Promise.reject(secret),
  ]) {
    const { client, calls } = fixture(responder);
    assertFailure(await client.refresh('SYNTHETIC'), 'transport');
    assert.equal(calls.length, 1);
  }
});

test('chunked UTF-8 is decoded correctly and invalid UTF-8 is rejected', async () => {
  const bytes = encoder.encode(JSON.stringify(wire({ access_token: 'SYNTHETIC_雪' })));
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(new Uint8Array([byte]));
      }
      controller.close();
    },
  });
  const { client } = fixture(() => new Response(body));
  assert.equal((await client.login(credentials)).tokens.accessToken, 'SYNTHETIC_雪');
  const invalid = fixture(() => new Response(new Uint8Array([0xff, 0xfe])));
  assertFailure(await invalid.client.login(credentials), 'invalid-response', { status: 200 });
});

test('body limit counts actual bytes across chunks and allows the exact 64 KiB boundary', async () => {
  const json = JSON.stringify(wire());
  const exact = fixture(() => new Response(json.padEnd(65536, ' ')));
  assert.equal((await exact.client.login(credentials)).ok, true);
  for (const status of [200, 503]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(json.padEnd(40000, ' ')));
        controller.enqueue(new Uint8Array(25537));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client, calls } = fixture(() => new Response(body, { status }));
    assertFailure(await client.login(credentials), status === 200 ? 'invalid-response' : 'http', { status });
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(calls.length, 1);
  }
  const unicode = fixture(() => response({ extra: '雪'.repeat(22000) }));
  assertFailure(await unicode.client.login(credentials), 'invalid-response', { status: 200 });
});

test('failed, non-byte and locked streams produce safe failures', async () => {
  const failed = bodyFixture();
  const first = fixture(() => failed.response);
  const result = first.client.login(credentials);
  await failed.reading;
  failed.error();
  assertFailure(await result, 'invalid-response', { status: 200 });
  assert.equal(failed.body.locked, false);

  const wrong = new ReadableStream({ start(controller) {
    controller.enqueue(secret);
  } });
  const second = fixture(() => new Response(wrong));
  assertFailure(await second.client.login(credentials), 'invalid-response', { status: 200 });
  assert.equal(wrong.locked, false);

  const locked = response();
  const reader = locked.body.getReader();
  const third = fixture(() => locked);
  assertFailure(await third.client.login(credentials), 'invalid-response', { status: 200 });
  await reader.cancel();
  reader.releaseLock();
});

test('cancellation before dispatch creates no request, deadline or listener', async (t) => {
  const time = clock(t);
  const abort = new AbortController();
  abort.abort(new Error(secret));
  const { client, calls } = fixture();
  assertFailure(await client.login(credentials, { signal: abort.signal }), 'cancelled');
  assert.equal(calls.length, 0);
  assert.equal(time.pending.size, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('cancellation settles despite an uncooperative transport and cancels its late body', async (t) => {
  const time = clock(t);
  const late = deferred();
  const abort = new AbortController();
  const { client, calls } = fixture(() => late.promise);
  const result = client.refresh('SYNTHETIC', { signal: abort.signal });
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort(secret);
  assertFailure(await result, 'cancelled');
  assert.equal(calls[0].init.signal.aborted, true);
  assert.notEqual(calls[0].init.signal.reason, secret);
  assert.equal(time.pending.size, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  const stream = bodyFixture();
  late.resolve(stream.response);
  await stream.cancelled;
  assert.equal(stream.cancellations, 1);
  assertFailure(await result, 'cancelled');
  assert.equal(calls.length, 1);
});

test('late transport rejection after cancellation is absorbed', async (t) => {
  clock(t);
  const late = deferred();
  const abort = new AbortController();
  const { client, calls } = fixture(() => late.promise);
  const result = client.login(credentials, { signal: abort.signal });
  abort.abort(secret);
  assertFailure(await result, 'cancelled');
  late.reject(new Error(secret));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1);
});

test('cancellation during body reading settles even when underlying stream cancellation never finishes', async (t) => {
  const time = clock(t);
  const stream = bodyFixture(() => new Promise(() => {}));
  const abort = new AbortController();
  const { client, calls } = fixture(() => stream.response);
  const result = client.login(credentials, { signal: abort.signal });
  await stream.reading;
  stream.push(encoder.encode('{"access_token":"SYNTHETIC'));
  abort.abort(new Error(secret));
  assertFailure(await result, 'cancelled');
  await stream.cancelled;
  assert.equal(time.pending.size, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(calls.length, 1);
});

test('cancellation wins over queued complete token bytes and cleanup rejection cannot leak', async (t) => {
  clock(t);
  const stream = bodyFixture(() => Promise.reject(new Error(secret)));
  const abort = new AbortController();
  const { client } = fixture(() => stream.response);
  const result = client.login(credentials, { signal: abort.signal });
  await stream.reading;
  stream.push(encoder.encode(JSON.stringify(wire())));
  abort.abort(secret);
  assertFailure(await result, 'cancelled');
  await stream.cancelled;
  await Promise.resolve();
});

test('default deadline settles stalled headers at 15 seconds and discards a late success', async (t) => {
  const time = clock(t);
  const late = deferred();
  const abort = new AbortController();
  const { client, calls } = fixture(() => late.promise);
  let settled = false;
  const result = client.login(credentials, { signal: abort.signal }).then(value => {
    settled = true;
    return value;
  });
  time.tick(14999);
  await Promise.resolve();
  assert.equal(settled, false);
  time.tick(1);
  assertFailure(await result, 'timeout');
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(time.pending.size, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  const stream = bodyFixture();
  late.resolve(stream.response);
  await stream.cancelled;
  assertFailure(await result, 'timeout');
  assert.equal(calls.length, 1);
});

test('whole-request deadline is not reset when headers arrive and body reading begins', async (t) => {
  const time = clock(t);
  const headers = deferred();
  const stream = bodyFixture();
  const { client, calls } = fixture(() => headers.promise);
  const result = client.refresh('SYNTHETIC');
  time.tick(10000);
  headers.resolve(stream.response);
  await stream.reading;
  stream.push(encoder.encode('{"access_token":"SYNTHETIC'));
  time.tick(5000);
  assertFailure(await result, 'timeout');
  await stream.cancelled;
  assert.equal(time.pending.size, 0);
  assert.equal(calls.length, 1);
});

test('timeout wins over queued complete body bytes and later caller cancellation', async (t) => {
  const time = clock(t);
  const stream = bodyFixture();
  const abort = new AbortController();
  const { client } = fixture(() => stream.response, { timeoutMs: 7 });
  const result = client.login(credentials, { signal: abort.signal });
  await stream.reading;
  stream.push(encoder.encode(JSON.stringify(wire())));
  stream.close();
  time.tick(7);
  abort.abort(secret);
  assertFailure(await result, 'timeout');
  assert.equal(time.pending.size, 0);
});

test('deadline and caller listener are removed on success and every non-cancellation failure path', async (t) => {
  const time = clock(t);
  const responders = [
    () => response(),
    () => new Response('{'),
    () => response({ refresh_token: undefined }),
    () => new Response(secret, { status: 401 }),
    () => new Response(null, { status: 302 }),
    () => Promise.reject(new Error(secret)),
    () => new Response(new Uint8Array(65537)),
    () => new Response(new ReadableStream({ start(controller) {
      controller.error(new Error(secret));
    } })),
  ];
  for (const responder of responders) {
    const abort = new AbortController();
    const ownListener = () => undefined;
    abort.signal.addEventListener('abort', ownListener);
    const { client, calls } = fixture(responder);
    const result = await client.login(credentials, { signal: abort.signal });
    assert.equal(getEventListeners(abort.signal, 'abort').length, 1, 'Unrelated caller listener must remain');
    assert.equal(time.pending.size, 0);
    time.tick(30000);
    abort.abort(secret);
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('overlapping requests keep input, cancellation and token results independent without coordination', async (t) => {
  const time = clock(t);
  const first = deferred();
  const second = deferred();
  let count = 0;
  const { client, calls } = fixture(() => ++count === 1 ? first.promise : second.promise);
  const abort = new AbortController();
  const a = client.refresh('SYNTHETIC_A', { signal: abort.signal });
  const b = client.refresh('SYNTHETIC_B');
  assert.equal(time.pending.size, 2);
  abort.abort(secret);
  assertFailure(await a, 'cancelled');
  assert.equal(time.pending.size, 1);
  assert.equal(calls[1].init.signal.aborted, false);
  second.resolve(response({ access_token: 'SYNTHETIC_B_ACCESS', refresh_token: 'SYNTHETIC_B_REFRESH' }));
  assert.equal((await b).tokens.refreshToken, 'SYNTHETIC_B_REFRESH');
  const lateBody = bodyFixture();
  first.resolve(lateBody.response);
  await lateBody.cancelled;
  assert.equal(new URLSearchParams(calls[0].init.body).get('refresh_token'), 'SYNTHETIC_A');
  assert.equal(new URLSearchParams(calls[1].init.body).get('refresh_token'), 'SYNTHETIC_B');
  assert.equal(calls.length, 2);
  assert.equal(time.pending.size, 0);
});

test('the default transport resolves native fetch only for an explicit operation', async (t) => {
  const calls = [];
  const fake = t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return response();
  });
  const client = createAuthClient();
  assert.equal(fake.mock.callCount(), 0);
  assert.equal((await client.login(credentials)).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, endpoint);
});

test('failures and diagnostics cannot contain synthetic credentials, server content or exception causes', async (t) => {
  const time = clock(t);
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, level, (...args) => logs.push(args));
  }
  const responders = [
    () => {
      throw new Error(secret, { cause: credentials });
    },
    () => new Response(JSON.stringify({ error: secret, error_description: credentials.password, account: credentials.username }), { status: 400 }),
    () => new Response('{"password":"' + credentials.password),
    () => response({ expires_in: secret, account: credentials.username }),
    () => new Response(new ReadableStream({ start(controller) {
      controller.error(credentials);
    } })),
  ];
  const results = [];
  for (const responder of responders) {
    results.push(await fixture(responder).client.login(credentials));
  }
  const pending = fixture(() => new Promise(() => {}));
  const abort = new AbortController();
  const cancelled = pending.client.refresh('SYNTHETIC_SECRET_REFRESH', { signal: abort.signal });
  abort.abort({ password: credentials.password, refreshToken: 'SYNTHETIC_SECRET_REFRESH' });
  results.push(await cancelled);
  const timed = pending.client.login(credentials);
  time.tick(15000);
  results.push(await timed);
  assert.deepEqual(logs, []);
  const publicOutput = JSON.stringify(results) + inspect(results) + JSON.stringify(logs);
  for (const value of [secret, credentials.username, credentials.password, 'SYNTHETIC_SECRET_REFRESH', 'SYNTHETIC_ACCESS_NEW']) {
    assert.equal(publicOutput.includes(value), false);
  }
  assert.equal(time.pending.size, 0);
});

test('prototype-looking and error fields in successful JSON never enter the token object', async () => {
  const json = JSON.stringify(wire()).slice(0, -1) + ',"__proto__":{"polluted":true},"constructor":"SYNTHETIC_PRIVATE","error":"invalid_grant"}';
  const { client } = fixture(() => new Response(json));
  const result = await client.login(credentials);
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.tokens, '__proto__'), false);
  assert.equal(Object.hasOwn(result.tokens, 'constructor'), false);
  assert.equal(Object.prototype.polluted, undefined);
});
