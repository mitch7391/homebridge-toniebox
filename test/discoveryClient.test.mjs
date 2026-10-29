import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import net from 'node:net';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { inspect } from 'node:util';

const { AbortController, AbortSignal, Response, ReadableStream, TextEncoder, URL } = globalThis;

const token = 'SYNTHETIC_ACCESS';
const householdId = 'SYNTHETIC_HOUSEHOLD';
const privateText = 'SYNTHETIC_PRIVATE_ERROR';
const base = 'https://api.prod.tcs.toys/v2';
let createDiscoveryClient;
let suiteNetworkAttempts = 0;
let testNetworkAttempts = 0;

function forbiddenAttempt(record) {
  record();
  assert.fail('Unexpected real network activity');
}
function assertNoNetworkAttempts(count) {
  assert.equal(count, 0, 'Forbidden network attempts were observed');
}

before(async () => {
  const forbidden = () => forbiddenAttempt(() => {
    suiteNetworkAttempts++;
    testNetworkAttempts++;
  });
  mock.method(globalThis, 'fetch', forbidden);
  mock.method(net.Socket.prototype, 'connect', forbidden);
  const timeout = mock.method(globalThis, 'setTimeout', () => assert.fail('Import scheduled work'));
  const interval = mock.method(globalThis, 'setInterval', () => assert.fail('Unexpected polling'));
  try {
    ({ createDiscoveryClient } = await import('../dist/toniebox/discoveryClient.js'));
    createDiscoveryClient();
  } finally {
    timeout.mock.restore();
    interval.mock.restore();
  }
});
beforeEach(() => {
  testNetworkAttempts = 0;
});
afterEach(async () => {
  await nextTurn();
  assertNoNetworkAttempts(testNetworkAttempts);
});
after(async () => {
  try {
    // Keep a cumulative audit so attempts between per-test hooks cannot be lost.
    await nextTurn();
    assertNoNetworkAttempts(suiteNetworkAttempts);
  } finally {
    mock.restoreAll();
  }
});

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const diagnostics = (overrides = {}) => ({
  rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false, ...overrides,
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
function fixture(t, responder = () => json([]), options = {}) {
  const jobs = new Map();
  let serial = 0;
  let time = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    jobs.set(++serial, { callback, at: time + delay });
    return serial;
  });
  t.mock.method(globalThis, 'clearTimeout', id => jobs.delete(id));
  t.mock.method(globalThis, 'setInterval', () => assert.fail('Unexpected polling'));
  t.after(() => assert.equal(jobs.size, 0, 'Request timer leaked'));
  const calls = [];
  const client = createDiscoveryClient({
    fetch: (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
    ...options,
  });
  return {
    client, calls, jobs,
    tick(ms) {
      time += ms;
      for (const [id, job] of [...jobs]) {
        if (job.at <= time) {
          jobs.delete(id);
          job.callback();
        }
      }
    },
  };
}
function stalledBody() {
  let cancellations = 0;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('['));
    },
    cancel() {
      cancellations++;
    },
  }));
  return { response, get cancellations() {
    return cancellations;
  } };
}

test('construction is inert and the API contains only the three discovery operations', (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.client).sort(), ['getAccount', 'getHouseholds', 'getTonieboxes']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.jobs.size, 0);
});

for (const [operation, path, body, args] of [
  ['getAccount', '/me', { uuid: 'SYNTHETIC_ACCOUNT' }, []],
  ['getHouseholds', '/households', [], []],
  ['getTonieboxes', '/households/SYNTHETIC_HOUSEHOLD/tonieboxes', [], [householdId]],
]) {
  test(operation + ' uses the exact evidenced endpoint and private bearer header', async (t) => {
    const f = fixture(t, () => json(body));
    const result = await f.client[operation](token, ...args);
    assert.equal(result.ok, true);
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, base + path);
    assert.deepEqual(init.headers, { Authorization: 'Bearer ' + token, Accept: 'application/json' });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
  });
}

test('account keeps explicit uuid selection provenance when both identifiers differ', async (t) => {
  const f = fixture(t, () => json({ uuid: 'SYNTHETIC_UUID', id: 'SYNTHETIC_ID', email: privateText }));
  assert.deepEqual(await f.client.getAccount(token), {
    ok: true, value: { id: 'SYNTHETIC_UUID', identitySource: 'uuid' }, diagnostics: diagnostics(),
  });
});
test('account falls back to id and reports malformed uuid without leaking it', async (t) => {
  const f = fixture(t, () => json({ uuid: null, id: 'SYNTHETIC_ID' }));
  assert.deepEqual(await f.client.getAccount(token), {
    ok: true, value: { id: 'SYNTHETIC_ID', identitySource: 'id' }, diagnostics: diagnostics({ degradedEntries: 1 }),
  });
});
test('account accepts an id-only record without degradation', async (t) => {
  const f = fixture(t, () => json({ id: 'SYNTHETIC_ID' }));
  assert.equal((await f.client.getAccount(token)).diagnostics.degradedEntries, 0);
});
test('account rejects missing or invalid identity and non-object shapes', async (t) => {
  for (const raw of [{}, { uuid: '', id: 42 }, [], null, 'text']) {
    const f = fixture(t, () => json(raw));
    assert.deepEqual(await f.client.getAccount(token), { ok: false, error: { kind: 'invalid-response', status: 200 } });
  }
});
test('households retain opaque identities, optional names, and ignore uncharacterised access', async (t) => {
  const f = fixture(t, () => json([
    { id: 'SYNTHETIC_A', name: 'Synthetic room', access: { future: true } },
    { id: ' SYNTHETIC_B ', extra: { secret: privateText } },
  ]));
  const result = await f.client.getHouseholds(token);
  assert.deepEqual(result.value, [{ id: 'SYNTHETIC_A', name: 'Synthetic room' }, { id: ' SYNTHETIC_B ' }]);
  assert.deepEqual(result.diagnostics, diagnostics());
});
test('a rename changes metadata without changing identity', async (t) => {
  let name = 'Synthetic first';
  const f = fixture(t, () => json([{ id: 'SYNTHETIC_BOX', name }]));
  const first = await f.client.getTonieboxes(token, householdId);
  name = 'Synthetic second';
  const second = await f.client.getTonieboxes(token, householdId);
  assert.equal(first.value[0].id, second.value[0].id);
  assert.notEqual(first.value[0].name, second.value[0].name);
});
test('unknown models and features survive; REST online state is not retained', async (t) => {
  const raw = {
    id: 'SYNTHETIC_BOX', householdId, itemId: 'SYNTHETIC_ITEM', macAddress: 'synthetic-box',
    product: 'future-product', generation: 'future-generation', features: ['playbackControls', 'future-feature'],
    onlineState: 'connected', unknown: { privateText },
  };
  const f = fixture(t, () => json([raw]));
  const result = await f.client.getTonieboxes(token, householdId);
  assert.deepEqual(result.value, [{
    id: raw.id, householdId, itemId: raw.itemId, macAddress: 'SYNTHETIC-BOX',
    product: raw.product, generation: raw.generation, features: raw.features,
  }]);
  assert.deepEqual(result.diagnostics, diagnostics());
});
test('missing MAC and absent versus empty capabilities are preserved for every model', async (t) => {
  const f = fixture(t, () => json([
    { id: 'SYNTHETIC_CLASSIC', generation: 'classic' },
    { id: 'SYNTHETIC_LITE', product: 'unknown-lite', features: [] },
  ]));
  const result = await f.client.getTonieboxes(token, householdId);
  assert.equal(Object.hasOwn(result.value[0], 'features'), false);
  assert.equal(Object.hasOwn(result.value[0], 'macAddress'), false);
  assert.deepEqual(result.value[1].features, []);
});
test('malformed optional fields degrade metadata without rejecting an identified device', async (t) => {
  const f = fixture(t, () => json([{
    id: 'SYNTHETIC_BOX', householdId: null, itemId: 12, name: [], product: null,
    generation: false, features: ['valid', null], macAddress: 'invalid/route',
  }]));
  const result = await f.client.getTonieboxes(token, householdId);
  assert.deepEqual(result.value, [{ id: 'SYNTHETIC_BOX' }]);
  assert.deepEqual(result.diagnostics, diagnostics({ degradedEntries: 1 }));
});
test('malformed siblings and mismatched household do not hide valid devices', async (t) => {
  const f = fixture(t, () => json([
    { id: 'SYNTHETIC_A' }, null, { id: 1 }, [], { name: 'missing identity' },
    { id: 'SYNTHETIC_WRONG', householdId: 'SYNTHETIC_OTHER' }, { id: 'SYNTHETIC_B' },
  ]));
  const result = await f.client.getTonieboxes(token, householdId);
  assert.deepEqual(result.value, [{ id: 'SYNTHETIC_A' }, { id: 'SYNTHETIC_B' }]);
  assert.deepEqual(result.diagnostics, diagnostics({ rejectedEntries: 5 }));
});
test('household entry failures and metadata degradation are distinct', async (t) => {
  const f = fixture(t, () => json([null, { id: 'SYNTHETIC_A', name: 10 }, { id: 'SYNTHETIC_B' }]));
  const result = await f.client.getHouseholds(token);
  assert.equal(result.value.length, 2);
  assert.deepEqual(result.diagnostics, diagnostics({ rejectedEntries: 1, degradedEntries: 1 }));
});
for (const operation of ['getHouseholds', 'getTonieboxes']) {
  test(operation + ' rejects all duplicate identity records, preserving unrelated siblings', async (t) => {
    const f = fixture(t, () => json([
      { id: 'SYNTHETIC_DUP', name: 'first' }, { id: 'SYNTHETIC_OK' },
      { id: 'SYNTHETIC_DUP', name: 'conflicting' }, { id: 'SYNTHETIC_SAME' }, { id: 'SYNTHETIC_SAME' },
    ]));
    const args = operation === 'getHouseholds' ? [] : [householdId];
    const result = await f.client[operation](token, ...args);
    assert.deepEqual(result.value, [{ id: 'SYNTHETIC_OK' }]);
    assert.deepEqual(result.diagnostics, diagnostics({ rejectedEntries: 4, duplicateEntries: 4 }));
  });
  test(operation + ' accepts [] but never turns an invalid envelope into []', async (t) => {
    const args = operation === 'getHouseholds' ? [] : [householdId];
    for (const raw of [[], {}, { items: [] }, { data: [] }, null, 0, '[]']) {
      const f = fixture(t, () => json(raw));
      const result = await f.client[operation](token, ...args);
      assert.equal(result.ok, Array.isArray(raw));
      if (result.ok) {
        assert.deepEqual(result.value, []);
        assert.deepEqual(result.diagnostics, diagnostics());
      }
    }
  });
}
test('household path uses one encoded segment on the fixed origin', async (t) => {
  const id = 'SYNTHETIC &?#% 雪';
  const f = fixture(t);
  await f.client.getTonieboxes(token, id);
  assert.equal(f.calls[0].url, base + '/households/' + encodeURIComponent(id) + '/tonieboxes');
  assert.equal(new URL(f.calls[0].url).origin, 'https://api.prod.tcs.toys');
});
test('invalid path identifiers and header tokens fail without I/O', async (t) => {
  const f = fixture(t);
  for (const id of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a\n', '\ud800', null, 42]) {
    assert.equal((await f.client.getTonieboxes(token, id)).error.kind, 'invalid-input');
  }
  for (const value of ['', ' ', 'a\r\nb', null, 42, 'non-ascii-雪']) {
    assert.equal((await f.client.getAccount(value)).error.kind, 'invalid-input');
  }
  assert.equal(f.calls.length, 0);
});
test('invalid client/request options cannot dispatch', async (t) => {
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }, { fetch: false }, { now: false }]) {
    const f = fixture(t, undefined, options);
    assert.equal((await f.client.getAccount(token)).error.kind, 'invalid-input');
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t);
  for (const options of [null, [], { signal: {} }]) {
    assert.equal((await f.client.getHouseholds(token, options)).error.kind, 'invalid-input');
  }
  assert.equal(f.calls.length, 0);
});

for (const [status, kind] of [
  [301, 'http'], [302, 'http'], [307, 'http'], [308, 'http'], [400, 'http'], [401, 'unauthorized'],
  [403, 'forbidden'], [404, 'http'], [408, 'http'], [429, 'rate-limited'], [500, 'http'], [503, 'http'],
]) {
  test('HTTP ' + status + ' is classified without retries, redirects or authentication side effects', async (t) => {
    const f = fixture(t, () => json({ error: 'invalid_grant', privateText }, status, { Location: 'https://example.invalid/private' }));
    assert.deepEqual(await f.client.getHouseholds(token), { ok: false, error: { kind, status } });
    f.tick(3600000);
    await flush();
    assert.equal(f.calls.length, 1);
  });
}
test('HTTP failures settle without waiting for or parsing an error body', async (t) => {
  const stalled = stalledBody();
  const response = new Response(stalled.response.body, { status: 403 });
  const f = fixture(t, () => response);
  assert.equal((await f.client.getHouseholds(token)).error.kind, 'forbidden');
  await flush();
  assert.equal(stalled.cancellations, 1);
});
test('Retry-After seconds and canonical HTTP-date are numeric and never shortened', async (t) => {
  const now = Date.UTC(2026, 0, 1);
  for (const [header, expected] of [
    ['120', 120000], ['0', 0], ['86400', 86400000],
    [new Date(now + 90000).toUTCString(), 90000], [new Date(now - 1000).toUTCString(), 0],
  ]) {
    const f = fixture(t, () => json(null, 429, { 'Retry-After': header }), { now: () => now });
    assert.equal((await f.client.getHouseholds(token)).error.retryAfterMs, expected);
    assert.equal(f.calls.length, 1);
  }
});
test('malformed Retry-After is omitted without losing HTTP classification', async (t) => {
  for (const header of ['-1', '1.5', 'Infinity', '99999999999999999999999', privateText, '01/02/2026']) {
    const f = fixture(t, () => json(null, 503, { 'Retry-After': header }));
    assert.deepEqual(await f.client.getHouseholds(token), { ok: false, error: { kind: 'http', status: 503 } });
  }
});
test('Retry-After clock failure is sanitised and metadata is limited to 429/503', async (t) => {
  const f = fixture(t, () => json(null, 503, { 'Retry-After': 'Thu, 01 Jan 2026 00:00:00 GMT' }), {
    now: () => {
      throw new Error(privateText);
    },
  });
  assert.deepEqual(await f.client.getHouseholds(token), { ok: false, error: { kind: 'http', status: 503 } });
  const other = fixture(t, () => json(null, 403, { 'Retry-After': '120' }));
  assert.equal(Object.hasOwn((await other.client.getHouseholds(token)).error, 'retryAfterMs'), false);
});
test('Link next is reported without following URLs or exposing them', async (t) => {
  const f = fixture(t, () => json([], 200, {
    Link: '<https://example.invalid/private?a=1,2>; title="comma,semi;colon"; rel="prev next"',
  }));
  const result = await f.client.getHouseholds(token);
  assert.equal(result.diagnostics.continuationDetected, true);
  assert.equal(f.calls.length, 1);
  assert.equal(inspect(result).includes('example.invalid'), false);
});
test('Link text mentioning next is not confused with a next relation', async (t) => {
  const f = fixture(t, () => json([], 200, { Link: '<https://example.invalid/>; title="next"; rel="prev"' }));
  assert.equal((await f.client.getHouseholds(token)).diagnostics.continuationDetected, false);
});
test('HTTP 206 reports partial representation even without Link', async (t) => {
  const f = fixture(t, () => json([], 206));
  assert.equal((await f.client.getHouseholds(token)).diagnostics.continuationDetected, true);
});
test('all rejected entries are observably different from a valid empty collection', async (t) => {
  const f = fixture(t, () => json([null, {}]));
  const result = await f.client.getHouseholds(token);
  assert.deepEqual(result.value, []);
  assert.equal(result.diagnostics.rejectedEntries, 2);
});

test('invalid JSON, empty body, invalid UTF-8 and primitive success bodies are rejected', async (t) => {
  for (const body of ['{', '', 'null', 'true', new Uint8Array([0xff])]) {
    const f = fixture(t, () => new Response(body));
    assert.equal((await f.client.getHouseholds(token)).error.kind, 'invalid-response');
  }
  const f = fixture(t, () => new Response(null, { status: 204 }));
  assert.equal((await f.client.getHouseholds(token)).error.kind, 'invalid-response');
});
test('body size is bounded independently of Content-Length', async (t) => {
  const f = fixture(t, () => new Response(' '.repeat(1024 * 1024) + '[]', { headers: { 'Content-Length': '2' } }));
  assert.equal((await f.client.getHouseholds(token)).error.kind, 'invalid-response');
});
test('a response exactly at the body limit is accepted', async (t) => {
  const f = fixture(t, () => new Response('[]' + ' '.repeat(1024 * 1024 - 2)));
  assert.equal((await f.client.getHouseholds(token)).ok, true);
});
test('transport throws and rejections are sanitised without retry', async (t) => {
  for (const responder of [
    () => {
      throw new Error(privateText);
    }, () => Promise.reject(new Error(privateText)),
  ]) {
    const f = fixture(t, responder);
    assert.deepEqual(await f.client.getAccount(token), { ok: false, error: { kind: 'transport' } });
    assert.equal(f.calls.length, 1);
  }
});
test('timeout settles even when transport ignores abort; late response body is cancelled', async (t) => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  const result = f.client.getHouseholds(token);
  f.tick(15000);
  assert.deepEqual(await result, { ok: false, error: { kind: 'timeout' } });
  assert.equal(f.calls[0].init.signal.aborted, true);
  const late = stalledBody();
  pending.resolve(late.response);
  await flush();
  assert.equal(late.cancellations, 1);
  assert.equal(f.calls.length, 1);
});
test('the deadline includes response-body reading and cancels stalled streams', async (t) => {
  const stalled = stalledBody();
  const f = fixture(t, () => stalled.response, { timeoutMs: 50 });
  const result = f.client.getHouseholds(token);
  await flush();
  f.tick(49);
  assert.equal(f.jobs.size, 1);
  f.tick(1);
  assert.equal((await result).error.kind, 'timeout');
  await flush();
  assert.equal(stalled.cancellations, 1);
  assert.equal(stalled.response.body.locked, false);
});
test('pre-aborted callers cause no HTTP request or listener leak', async (t) => {
  const controller = new AbortController();
  controller.abort(privateText);
  const f = fixture(t);
  assert.deepEqual(await f.client.getHouseholds(token, { signal: controller.signal }), { ok: false, error: { kind: 'cancelled' } });
  assert.equal(f.calls.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('caller cancellation settles promptly; late rejection is absorbed', async (t) => {
  const pending = deferred();
  const controller = new AbortController();
  const f = fixture(t, () => pending.promise);
  const result = f.client.getAccount(token, { signal: controller.signal });
  controller.abort(privateText);
  assert.deepEqual(await result, { ok: false, error: { kind: 'cancelled' } });
  assert.notEqual(f.calls[0].init.signal.reason, privateText);
  pending.reject(new Error(privateText));
  await flush();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
test('cancellation during body reading releases the reader', async (t) => {
  const stalled = stalledBody();
  const controller = new AbortController();
  const f = fixture(t, () => stalled.response);
  const result = f.client.getHouseholds(token, { signal: controller.signal });
  await flush();
  controller.abort();
  assert.equal((await result).error.kind, 'cancelled');
  await flush();
  assert.equal(stalled.cancellations, 1);
  assert.equal(stalled.response.body.locked, false);
});
test('successful requests remove listeners; later caller cancellation has no effect', async (t) => {
  const controller = new AbortController();
  const f = fixture(t);
  const result = await f.client.getHouseholds(token, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  assert.equal(result.ok, true);
  assert.equal(f.calls[0].init.signal.aborted, false);
});
test('independent requests never cancel one another or share result state', async (t) => {
  const pending = deferred();
  let index = 0;
  const f = fixture(t, () => ++index === 1 ? pending.promise : json([{ id: 'SYNTHETIC_OTHER' }]));
  const controller = new AbortController();
  const first = f.client.getHouseholds(token, { signal: controller.signal });
  const second = f.client.getHouseholds('SYNTHETIC_OTHER_TOKEN');
  controller.abort();
  assert.equal((await first).error.kind, 'cancelled');
  assert.deepEqual((await second).value, [{ id: 'SYNTHETIC_OTHER' }]);
  pending.resolve(json([]));
  await flush();
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer SYNTHETIC_OTHER_TOKEN');
});
test('failures and diagnostics contain no private response, identifier, token or exception text', async (t) => {
  const f = fixture(t, () => json([
    { id: 'SYNTHETIC_DUP', name: privateText }, { id: 'SYNTHETIC_DUP', name: privateText },
    { id: null, account: privateText },
  ]));
  const result = await f.client.getHouseholds(token);
  const output = inspect(result);
  assert.equal(output.includes(privateText), false);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes('SYNTHETIC_DUP'), false);
  assert.deepEqual(result.diagnostics, diagnostics({ rejectedEntries: 3, duplicateEntries: 2 }));
});

test('Content-Range on a successful response reports incomplete representation without traversal', async (t) => {
  const f = fixture(t, () => json([{ id: 'SYNTHETIC_PARTIAL' }], 200, { 'Content-Range': 'items 0-0/2' }));
  const result = await f.client.getHouseholds(token);
  assert.deepEqual(result.value, [{ id: 'SYNTHETIC_PARTIAL' }]);
  assert.equal(result.diagnostics.continuationDetected, true);
  assert.equal(f.calls.length, 1);
});
test('overlong Link metadata cannot silently imply complete enumeration', async (t) => {
  const f = fixture(t, () => json([], 200, { Link: 'x'.repeat(16385) }));
  assert.equal((await f.client.getHouseholds(token)).diagnostics.continuationDetected, true);
  assert.equal(f.calls.length, 1);
});
test('stream failures are sanitised and release the reader and timer', async (t) => {
  const response = new Response(new ReadableStream({
    pull(controller) {
      controller.error(new Error(privateText));
    },
  }));
  const f = fixture(t, () => response);
  assert.deepEqual(await f.client.getHouseholds(token), { ok: false, error: { kind: 'transport', status: 200 } });
  assert.equal(response.body.locked, false);
});
test('streamed UTF-8 can span chunks without corrupting identity metadata', async (t) => {
  const bytes = new TextEncoder().encode(JSON.stringify([{ id: 'SYNTHETIC_BOX', name: 'Synthetic 雪' }]));
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) {
        controller.enqueue(new Uint8Array([byte]));
      }
      controller.close();
    },
  }));
  const f = fixture(t, () => response);
  assert.deepEqual((await f.client.getTonieboxes(token, householdId)).value, [{ id: 'SYNTHETIC_BOX', name: 'Synthetic 雪' }]);
  assert.equal(response.body.locked, false);
});

test('body failure after valid initial bytes is transport and releases resources', async (t) => {
  let stream;
  const response = new Response(new ReadableStream({
    start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('[{"id":"SYNTHETIC'));
    },
  }));
  const f = fixture(t, () => response);
  const result = f.client.getHouseholds(token);
  await flush();
  stream.error(new Error(privateText));
  assert.deepEqual(await result, { ok: false, error: { kind: 'transport', status: 200 } });
  assert.equal(response.body.locked, false);
  assert.equal(f.calls.length, 1);
});

for (const [name, bytes] of [
  ['malformed JSON', new TextEncoder().encode('[{"id":')],
  ['invalid UTF-8', new Uint8Array([0x5b, 0xff, 0x5d])],
]) {
  test(name + ' remains invalid-response rather than transport', async (t) => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }));
    const f = fixture(t, () => response);
    assert.deepEqual(await f.client.getHouseholds(token), { ok: false, error: { kind: 'invalid-response', status: 200 } });
    assert.equal(response.body.locked, false);
    assert.equal(f.calls.length, 1);
  });
}

for (const ending of ['cancelled', 'timeout']) {
  for (const order of ['lifecycle-first', 'stream-first']) {
    test(ending + ' takes precedence over same-turn stream rejection: ' + order, async (t) => {
      let stream;
      const response = new Response(new ReadableStream({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode('['));
        },
      }));
      const controller = new AbortController();
      const f = fixture(t, () => response, { timeoutMs: 50 });
      const result = f.client.getHouseholds(token, { signal: controller.signal });
      await flush();
      const end = () => ending === 'cancelled' ? controller.abort(privateText) : f.tick(50);
      if (order === 'lifecycle-first') {
        end();
        stream.error(new Error(privateText));
      } else {
        stream.error(new Error(privateText));
        end();
      }
      assert.deepEqual(await result, { ok: false, error: { kind: ending } });
      await flush();
      assert.equal(f.calls[0].init.signal.aborted, true);
      assert.equal(response.body.locked, false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      assert.equal(f.calls.length, 1);
    });
  }
}

for (const secondMac of ['synthetic-shared', 'SYNTHETIC-SHARED']) {
  test('different cloud IDs sharing MAC ' + secondMac + ' are individually marked without losing siblings', async (t) => {
    const f = fixture(t, () => json([
      { id: 'SYNTHETIC_A', macAddress: 'synthetic-shared' },
      { id: 'SYNTHETIC_B', macAddress: secondMac },
      { id: 'SYNTHETIC_C', macAddress: 'synthetic-unique' },
      { id: 'SYNTHETIC_NO_MAC' },
    ]));
    const result = await f.client.getTonieboxes(token, householdId);
    assert.deepEqual(result.value, [
      { id: 'SYNTHETIC_A', macAddress: 'SYNTHETIC-SHARED', routingAmbiguous: true },
      { id: 'SYNTHETIC_B', macAddress: 'SYNTHETIC-SHARED', routingAmbiguous: true },
      { id: 'SYNTHETIC_C', macAddress: 'SYNTHETIC-UNIQUE' },
      { id: 'SYNTHETIC_NO_MAC' },
    ]);
    assert.deepEqual(result.diagnostics, diagnostics({ ambiguousRoutingEntries: 2 }));
    assert.equal(inspect(result.diagnostics).includes('SYNTHETIC'), false);
  });
}

test('duplicate-ID rejection remains distinct and still protects a surviving conflicting route', async (t) => {
  const f = fixture(t, () => json([
    { id: 'SYNTHETIC_DUP', macAddress: 'synthetic-shared' },
    { id: 'SYNTHETIC_DUP', macAddress: 'synthetic-other' },
    { id: 'SYNTHETIC_SURVIVOR', macAddress: 'SYNTHETIC-SHARED' },
    { id: 'SYNTHETIC_UNRELATED' },
  ]));
  const result = await f.client.getTonieboxes(token, householdId);
  assert.deepEqual(result.value, [
    { id: 'SYNTHETIC_SURVIVOR', macAddress: 'SYNTHETIC-SHARED', routingAmbiguous: true },
    { id: 'SYNTHETIC_UNRELATED' },
  ]);
  assert.deepEqual(result.diagnostics, diagnostics({ rejectedEntries: 2, duplicateEntries: 2, ambiguousRoutingEntries: 1 }));
});

test('repeated cloud identity alone is not a conflict between different routing identities', async (t) => {
  const f = fixture(t, () => json([
    { id: 'SYNTHETIC_DUP', macAddress: 'synthetic-shared' },
    { id: 'SYNTHETIC_DUP', macAddress: 'SYNTHETIC-SHARED' },
    { id: 'SYNTHETIC_NO_MAC_A' }, { id: 'SYNTHETIC_NO_MAC_B' },
  ]));
  const result = await f.client.getTonieboxes(token, householdId);
  assert.deepEqual(result.value, [{ id: 'SYNTHETIC_NO_MAC_A' }, { id: 'SYNTHETIC_NO_MAC_B' }]);
  assert.deepEqual(result.diagnostics, diagnostics({ rejectedEntries: 2, duplicateEntries: 2 }));
});

test('independent network audit detects a forbidden attempt whose assertion the client sanitises', async (t) => {
  let attempts = 0;
  // Exercise the same guard/audit with an isolated counter, never a real network call.
  const f = fixture(t, () => forbiddenAttempt(() => {
    attempts++;
  }));
  assert.deepEqual(await f.client.getHouseholds(token), { ok: false, error: { kind: 'transport' } });
  assert.equal(attempts, 1);
  assert.throws(() => assertNoNetworkAttempts(attempts), { code: 'ERR_ASSERTION' });
  assert.doesNotThrow(() => assertNoNetworkAttempts(0));
});

test('independent network audit detects a late forbidden attempt after caller cancellation', async (t) => {
  let attempts = 0;
  const pending = deferred();
  const f = fixture(t, () => pending.promise.then(() => forbiddenAttempt(() => {
    attempts++;
  })));
  const controller = new AbortController();
  const result = f.client.getHouseholds(token, { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await result, { ok: false, error: { kind: 'cancelled' } });
  pending.resolve();
  await nextTurn();
  assert.equal(attempts, 1);
  assert.throws(() => assertNoNetworkAttempts(attempts), { code: 'ERR_ASSERTION' });
});
