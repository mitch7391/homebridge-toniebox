import assert from 'node:assert/strict';
import net from 'node:net';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

const { AbortController, Response, structuredClone } = globalThis;
let approveRoutes, reconcileRoutes, assessCompatibility, validRoutePlan;
let forbidden = 0, perTest = 0;
before(async () => {
  const deny = () => {
    forbidden++; perTest++; throw new Error('Forbidden network or timer');
  };
  mock.method(globalThis, 'fetch', deny);
  mock.method(net.Socket.prototype, 'connect', deny);
  mock.method(globalThis, 'setTimeout', deny);
  mock.method(globalThis, 'setInterval', deny);
  ({ approveRoutes, reconcileRoutes, assessCompatibility, validRoutePlan } = await import('../dist/toniebox/routingPolicy.js'));
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
const diagnostics = (extra = {}) => ({
  rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false, ...extra,
});
const observation = (id = 'SYNTHETIC_BOX_A', extra = {}, household = 'SYNTHETIC_HOUSE_A') => ({
  requestedHouseholdId: household,
  device: { id, macAddress: 'SYNTHETIC_MAC_' + id, product: 'tb2', generation: 'tng', features: ['playbackControls'], ...extra },
});
function discovery(devices = [observation()]) {
  const households = [...new Set(devices.map(o => o.requestedHouseholdId))];
  return {
    ok: true,
    snapshot: {
      account: { id: 'SYNTHETIC_ACCOUNT', identitySource: 'uuid' }, accountDiagnostics: diagnostics(), householdsDiagnostics: diagnostics(),
      households: households.map(id => ({ identity: { id }, outcome: 'received', diagnostics: diagnostics() })),
      devices, enumeration: 'finished', routing: { evidence: 'observed-endpoints', conflicts: 'none-observed' },
    }, diagnostics: {},
  };
}
const temporary = { ok: false, error: { kind: 'request', discoveryFailure: { kind: 'transport' } }, diagnostics: {} };
const approved = () => approveRoutes(discovery(), context).production;
function partial(result = discovery()) {
  result.snapshot.enumeration = 'partial';
  result.snapshot.routing.evidence = 'insufficient';
  return result;
}
const reconcile = (previous, result, extra = {}) => reconcileRoutes({ previous, discovery: result, context, ...extra });
function rule(extra = {}) {
  return {
    product: 'SYNTHETIC_CLASSIC_PRODUCT', generation: 'SYNTHETIC_CLASSIC_GENERATION', family: 'toniebox-1',
    evidence: 'SYNTHETIC_EVIDENCE', decision: 'beta-candidate', ...extra,
  };
}

test('complete evidenced TB2 observation approves a frozen provisional production route', () => {
  const source = discovery();
  source.snapshot.devices[0].device.features.push('synthetic-future-feature');
  const output = approveRoutes(source, context);
  assert.equal(output.authority, 'sufficient');
  assert.equal(output.production.context, context);
  assert.equal(output.production.routes.length, 1);
  assert.equal(output.experimental.length, 0);
  assert.ok(validRoutePlan(output.production));
  assert.equal(assessCompatibility(source.snapshot.devices[0].device).kind, 'provisional');
  source.snapshot.devices[0].device.features.push('later');
  assert.deepEqual(output.production.routes[0].identity.features, ['playbackControls', 'synthetic-future-feature']);
  assert.throws(() => {
    output.production.routes[0].identity.features.push('mutation');
  }, TypeError);
});
for (const [label, modify] of [
  ['partial enumeration', r => {
    r.snapshot.enumeration = 'partial';
  }],
  ['insufficient endpoint evidence', r => {
    r.snapshot.routing.evidence = 'insufficient';
  }],
  ['missing household diagnostics', r => {
    delete r.snapshot.householdsDiagnostics;
  }],
  ['account continuation', r => {
    r.snapshot.accountDiagnostics.continuationDetected = true;
  }],
  ['household continuation', r => {
    r.snapshot.householdsDiagnostics.continuationDetected = true;
  }],
  ['box continuation', r => {
    r.snapshot.households[0].diagnostics.continuationDetected = true;
  }],
  ['rejected account metadata', r => {
    r.snapshot.accountDiagnostics.rejectedEntries = 1;
  }],
  ['rejected household', r => {
    r.snapshot.householdsDiagnostics.rejectedEntries = 1;
  }],
  ['rejected device', r => {
    r.snapshot.households[0].diagnostics.rejectedEntries = 1;
  }],
  ['failed household', r => {
    r.snapshot.households[0] = { identity: r.snapshot.households[0].identity, outcome: 'failed', error: { kind: 'forbidden' } };
  }],
  ['unattempted household', r => {
    r.snapshot.households[0].outcome = 'unattempted';
  }],
  ['interrupted household', r => {
    r.snapshot.households[0].outcome = 'interrupted';
  }],
  ['duplicate household identity', r => {
    r.snapshot.households.push(structuredClone(r.snapshot.households[0]));
  }],
]) {
  test(label + ' cannot approve new routes', () => {
    const value = discovery(); modify(value);
    const result = approveRoutes(value, context);
    assert.equal(result.production, undefined);
    assert.equal(result.experimental.length, 0);
    assert.equal(result.diagnostics.production, 0);
  });
}
test('failed run cannot promote its otherwise complete-looking partial snapshot', () => {
  const result = approveRoutes({ ...temporary, partial: discovery().snapshot }, context);
  assert.equal(result.authority, 'insufficient');
  assert.equal(result.production, undefined);
});
test('fallback account id is never repurposed as MQTT UUID', () => {
  const value = discovery(); value.snapshot.account.identitySource = 'id';
  const output = approveRoutes(value, context);
  assert.equal(output.authority, 'account-unverified');
  assert.equal(output.observations.length, 1);
  assert.equal(output.production, undefined);
});
test('optional metadata degradation alone does not remove valid routes', () => {
  const value = discovery();
  value.snapshot.households[0].diagnostics.degradedEntries = 1;
  assert.equal(approveRoutes(value, context).production.routes.length, 1);
});
for (const [label, devices] of [
  ['duplicate IDs', [observation(), observation(undefined, { macAddress: 'SYNTHETIC_OTHER' })]],
  ['duplicate normalised MACs', [observation('A', { macAddress: 'synthetic_mac' }), observation('B', { macAddress: 'SYNTHETIC_MAC' })]],
  ['unsupported MAC collision', [observation('A', { macAddress: 'SYNTHETIC_MAC' }),
    observation('B', { macAddress: 'SYNTHETIC_MAC', product: 'synthetic-unknown' })]],
  ['cross-household identity', [observation(), observation(undefined, {}, 'SYNTHETIC_HOUSE_B')]],
]) {
  test(label + ' excludes every affected identity while preserving unrelated sibling', () => {
    const output = approveRoutes(discovery([...devices, observation('SIBLING')]), context);
    assert.deepEqual(output.production.routes.map(r => r.routeId), ['SIBLING']);
    assert.equal(output.excluded.length, 2);
    assert.ok(output.excluded.every(e => e.reason === 'identity-conflict'));
  });
}
test('explicit household contradiction excludes that observation', () => {
  const output = approveRoutes(discovery([observation('A', { householdId: 'WRONG' }), observation('B')]), context);
  assert.deepEqual(output.production.routes.map(r => r.routeId), ['B']);
  assert.equal(output.excluded[0].reason, 'household-conflict');
});
test('existing routingAmbiguous and identityConflict flags remain authoritative', () => {
  const a = observation('A', { routingAmbiguous: true });
  const b = { ...observation('B'), identityConflict: true };
  assert.equal(approveRoutes(discovery([a, b]), context).production.routes.length, 0);
});
for (const bad of ['', 'has space', 'bad/route', 'bad+route', 'bad#route', 'bad\\route', '\u0000bad', 'x'.repeat(257)]) {
  test('invalid MAC is excluded: ' + JSON.stringify(bad.slice(0, 15)), () => {
    const out = approveRoutes(discovery([observation('A', { macAddress: bad })]), context);
    assert.equal(out.production.routes.length, 0);
    assert.equal(out.excluded[0].reason, 'invalid-route');
  });
}
test('missing MAC remains discovered without transport eligibility', () => {
  const output = approveRoutes(discovery([observation('A', { macAddress: undefined })]), context);
  assert.equal(output.observations.length, 1);
  assert.equal(output.production.routes.length, 0);
  assert.equal(output.excluded[0].reason, 'missing-mac');
});
for (const bad of ['contains space', '\u0080bad', 'x'.repeat(257)]) {
  test('invalid route ID denied: ' + JSON.stringify(bad.slice(0, 15)), () => {
    const result = approveRoutes(discovery([observation(bad, { macAddress: 'SYNTHETIC_MAC' })]), context);
    assert.equal(result.production.routes.length, 0);
  });
}
for (const fields of [
  { product: 'future', generation: 'tng' }, { product: 'tb2', generation: 'future' },
  { product: undefined }, { generation: undefined }, { features: undefined }, { features: [] }, { features: ['unknown'] },
]) {
  test('metadata is insufficient for automatic compatibility: ' + JSON.stringify(fields), () => {
    const source = observation('A', fields);
    const result = approveRoutes(discovery([source]), context);
    assert.equal(result.production.routes.length, 0);
    assert.equal(assessCompatibility(source.device).kind, 'unknown');
  });
}
test('unknown advertisements survive without fabricated capability claims', () => {
  const result = assessCompatibility(observation('A', { product: 'future', features: ['synthetic-new'] }).device);
  assert.deepEqual(result.advertisedFeatures, ['synthetic-new']);
  assert.deepEqual(result.evidencedStateTopics, []);
  assert.equal(result.evidenceScope, 'none');
});
for (const family of ['toniebox-1', 'toniebox-lite']) {
  test('synthetic ' + family + ' candidate is distinguishable but never automatically routed', () => {
    const candidate = rule({ family, product: 'SYNTHETIC_' + family });
    const device = observation('A', { product: candidate.product, generation: candidate.generation });
    const policy = { rules: [candidate] };
    assert.equal(assessCompatibility(device.device, policy).kind, 'beta-candidate');
    assert.equal(assessCompatibility(device.device, policy).family, family);
    assert.equal(approveRoutes(discovery([device]), context, policy).production.routes.length, 0);
  });
}
test('explicit device experiment gets an isolated single-device plan, not production authority', () => {
  const experiment = rule({ decision: 'experimental', protocol: 'ici-seven-state-topics', deviceId: 'A' });
  const devices = [observation('A', experiment), observation('B', experiment), observation('C')];
  const output = approveRoutes(discovery(devices), context, { rules: [experiment] });
  assert.deepEqual(output.production.routes.map(r => r.routeId), ['C']);
  assert.equal(output.experimental.length, 1);
  assert.equal(output.experimental[0].routes[0].routeId, 'A');
  assert.equal(output.experimental[0].lane, 'experimental');
});
test('several explicitly approved experiments are never combined', () => {
  const experiment = rule({ decision: 'experimental', protocol: 'ici-seven-state-topics' });
  const output = approveRoutes(discovery([observation('A', experiment), observation('B', experiment)]), context, { rules: [experiment] });
  assert.equal(output.experimental.length, 2);
  assert.ok(output.experimental.every(p => p.routes.length === 1));
});
test('future validated evidence fits the existing seven-topic contract without model-specific routing code', () => {
  const validated = rule({ decision: 'validated', protocol: 'ici-seven-state-topics' });
  const value = observation('A', validated);
  const output = approveRoutes(discovery([value]), context, { rules: [validated] });
  assert.equal(output.production.routes.length, 1);
  assert.equal(assessCompatibility(value.device, { rules: [validated] }).evidenceScope, 'supplied-model');
});
for (const extra of [{ protocol: undefined }, { evidence: '' }, { product: '' }, { decision: 'allow-unknown' }]) {
  test('invalid or unrestricted compatibility grant cannot authorise routes: ' + JSON.stringify(extra), () => {
    const candidate = rule({ decision: 'experimental', protocol: 'ici-seven-state-topics' });
    const output = approveRoutes(discovery([observation('A', candidate)]), context, { rules: [{ ...candidate, ...extra }] });
    assert.equal(output.production.routes.length, 0);
    assert.equal(output.experimental.length, 0);
  });
}
test('conflicting compatibility rules fail closed, not first-match', () => {
  const value = rule({ decision: 'validated', protocol: 'ici-seven-state-topics' });
  const output = approveRoutes(discovery([observation('A', value)]), context, { rules: [value, { ...value, decision: 'unsupported' }] });
  assert.equal(output.production.routes.length, 0);
});
test('valid empty enumeration produces an empty plan', () => {
  assert.deepEqual(approveRoutes(discovery([]), context).production.routes, []);
});
test('route ordering is independent of household and device enumeration order', () => {
  const a = discovery([observation('Z'), observation('A', {}, 'HOUSE_B')]);
  const b = structuredClone(a); b.snapshot.households.reverse(); b.snapshot.devices.reverse();
  assert.deepEqual(approveRoutes(a, context).production, approveRoutes(b, context).production);
});
for (const n of [100, 101]) {
  test(n + ' prospective routes enforce the whole-plan count boundary', () => {
    const output = approveRoutes(discovery(Array.from({ length: n }, (_, i) => observation('D' + i))), context);
    assert.equal(output.authority, n === 100 ? 'sufficient' : 'resource-limit');
    assert.equal(output.production?.routes.length, n === 100 ? 100 : undefined);
  });
}
test('subscription byte budget accounts for UTF-8 and never truncates', () => {
  const output = approveRoutes(discovery(Array.from({ length: 50 }, (_, i) => observation('D' + i, { macAddress: 'é'.repeat(230) + i }))), context);
  assert.equal(output.authority, 'resource-limit');
  assert.equal(output.production, undefined);
});

test('temporary discovery failure preserves last-known approved authority', () => {
  const previous = approved();
  const decision = reconcile(previous, temporary);
  assert.equal(decision.action, 'retain');
  assert.equal(decision.authority, 'last-known');
  assert.deepEqual(decision.plan, previous);
});
test('partial absence never deletes or adds routes', () => {
  const previous = approved();
  const decision = reconcile(previous, partial(discovery([observation('NEW')])));
  assert.equal(decision.action, 'retain');
  assert.deepEqual(decision.plan, previous);
});
test('complete unchanged discovery retains connection despite metadata/order changes', () => {
  const previous = approved();
  const next = discovery([observation(undefined, { name: 'SYNTHETIC_NEW_NAME' })]);
  const decision = reconcile(previous, next);
  assert.equal(decision.action, 'retain');
  assert.equal(decision.authority, 'current');
  assert.equal(decision.plan.routes[0].identity.name, 'SYNTHETIC_NEW_NAME');
});
test('complete route additions replace rather than silently mutate a live route plan', () => {
  const decision = reconcile(approved(), discovery([observation(), observation('NEW')]));
  assert.equal(decision.action, 'replace');
  assert.equal(decision.plan.routes.length, 2);
});
test('complete empty evidence withdraws routing, without claiming physical deletion', () => {
  const decision = reconcile(approved(), discovery([]));
  assert.equal(decision.action, 'withdraw');
  assert.equal(decision.reason, 'complete');
  assert.deepEqual(decision.plan.routes, []);
});
test('localisable partial MAC conflict withdraws affected routes only', () => {
  const previous = approveRoutes(discovery([observation(), observation('SIBLING')]), context).production;
  const other = observation('OTHER', { macAddress: previous.routes.find(r => r.routeId !== 'SIBLING').macAddress, product: 'UNKNOWN' });
  const decision = reconcile(previous, partial(discovery([observation(), other])));
  assert.equal(decision.action, 'replace');
  assert.equal(decision.reason, 'conflict');
  assert.deepEqual(decision.plan.routes.map(r => r.routeId), ['SIBLING']);
});
test('discarded duplicate IDs leave unlocalisable conflict evidence and withdraw old routing', () => {
  const value = partial(discovery([]));
  value.snapshot.householdsDiagnostics = diagnostics({ rejectedEntries: 2, duplicateEntries: 2 });
  const decision = reconcile(approved(), value);
  assert.equal(decision.action, 'withdraw');
  assert.equal(decision.reason, 'conflict');
});
test('unlocalisable ambiguity summary does not falsely exonerate old routes', () => {
  const value = partial(discovery([]));
  value.snapshot.routing.conflicts = 'observed';
  assert.equal(reconcile(approved(), value).action, 'withdraw');
});
test('ordinary rejected entries without confirmed conflicts preserve previous routes', () => {
  const value = partial(discovery([]));
  value.snapshot.householdsDiagnostics.rejectedEntries = 1;
  assert.equal(reconcile(approved(), value).action, 'retain');
});
for (const [label, next] of [
  ['MAC changed', observation(undefined, { macAddress: 'SYNTHETIC_CHANGED' })],
  ['household moved', observation(undefined, {}, 'SYNTHETIC_MOVED')],
  ['MAC reassigned', observation('OTHER', { macAddress: observation().device.macAddress })],
]) {
  test('positive partial contradiction withdraws previous route: ' + label, () => {
    const decision = reconcile(approved(), partial(discovery([next])));
    assert.equal(decision.action, 'withdraw');
    assert.equal(decision.reason, 'conflict');
  });
}
test('partial metadata loss is not confirmed MAC revocation', () => {
  assert.equal(reconcile(approved(), partial(discovery([observation(undefined, { macAddress: undefined })]))).action, 'retain');
});
test('changed account UUID revokes old authority, never silently switches accounts', () => {
  const next = discovery(); next.snapshot.account.id = 'SYNTHETIC_OTHER_ACCOUNT';
  const decision = reconcile(approved(), next);
  assert.equal(decision.action, 'withdraw');
  assert.equal(decision.reason, 'account-changed');
  assert.equal(decision.plan, undefined);
});
test('fallback ID on rediscovery cannot prove UUID equivalence or account change', () => {
  const next = partial(discovery()); next.snapshot.account = { id: 'SYNTHETIC_OTHER', identitySource: 'id' };
  assert.equal(reconcile(approved(), next).action, 'retain');
});
for (const otherContext of [undefined, Symbol('replacement')]) {
  test('context revocation precedes even successful discovery: ' + String(otherContext), () => {
    const decision = reconcile(approved(), discovery(), { context: otherContext });
    assert.equal(decision.action, 'withdraw');
    assert.equal(decision.authority, 'revoked');
    assert.equal(decision.plan, undefined);
  });
}
test('resource-limited rediscovery cannot truncate or replace prior healthy authority', () => {
  const next = discovery([observation(), ...Array.from({ length: 101 }, (_, i) => observation('D' + i))]);
  const decision = reconcile(approved(), next);
  assert.equal(decision.action, 'retain');
  assert.equal(decision.reason, 'resource-limit');
});
test('malformed evidence is safe failure, not an empty account or deletion', () => {
  const bad = { ok: true, snapshot: { devices: null }, diagnostics: {} };
  assert.equal(approveRoutes(bad, context).authority, 'invalid-evidence');
  assert.equal(reconcile(approved(), bad).action, 'retain');
});
test('public diagnostics do not contain private observations or injected errors', () => {
  const source = discovery([observation('SYNTHETIC_SECRET', { name: 'SYNTHETIC_PRIVATE_NAME' })]);
  const output = approveRoutes(source, context);
  assert.doesNotMatch(JSON.stringify(output.diagnostics), /SYNTHETIC/);
  const bad = { get ok() {
    throw new Error('SYNTHETIC_SECRET');
  } };
  assert.doesNotMatch(JSON.stringify(approveRoutes(bad, context)), /SYNTHETIC/);
});
test('detached private observations cannot mutate an approved plan or input', () => {
  const source = discovery();
  const output = approveRoutes(source, context);
  output.observations[0].device.features.push('mutation');
  assert.equal(source.snapshot.devices[0].device.features.length, 1);
  assert.equal(output.production.routes[0].identity.features.length, 1);
});
test('actual 4A and 4B discovery contracts feed route approval without authentication ownership', async () => {
  const { createDiscoveryClient } = await import('../dist/toniebox/discoveryClient.js');
  const { createDiscoveryRunner } = await import('../dist/toniebox/discoveryRunner.js');
  const controller = new AbortController();
  const jobs = new Set();
  const scheduler = { schedule(fn) {
    jobs.add(fn); return () => jobs.delete(fn);
  } };
  const requests = [];
  const client = createDiscoveryClient({ fetch: async url => {
    requests.push(url);
    const value = url.endsWith('/me') ? { uuid: 'SYNTHETIC_ACCOUNT' }
      : url.endsWith('/households') ? [{ id: 'SYNTHETIC_HOUSE_A' }] : [observation().device];
    return new Response(JSON.stringify(value));
  } });
  // 4A has real deadline timers; intercept with a deterministic cancellable implementation.
  const timers = new Set();
  const timerMock = mock.method(globalThis, 'setTimeout', () => {
    const timer = { unref() {} }; timers.add(timer); return timer;
  });
  const clearMock = mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
  const runner = createDiscoveryRunner({
    tokenProvider: { getAccessToken: async () => ({ ok: true, accessToken: 'SYNTHETIC_ACCESS', tokenType: 'Bearer', remainingLifetimeMs: 300000 }) },
    discoveryClient: client, contextSignal: controller.signal, scheduler, clock: { now: () => ({ monotonicMs: 0, wallMs: 0 }) },
  });
  try {
    const result = await runner.discover();
    assert.equal(result.ok, true);
    assert.equal(approveRoutes(result, context).production.routes.length, 1);
    assert.equal(requests.length, 3);
    assert.equal(timers.size, 0);
  } finally {
    runner.stop(); controller.abort(); timerMock.mock.restore(); clearMock.mock.restore();
    assert.equal(jobs.size, 0);
  }
});

test('malformed diagnostic counts are not affirmative route-revocation evidence', () => {
  const value = partial(discovery([]));
  value.snapshot.householdsDiagnostics.rejectedEntries = NaN;
  assert.equal(approveRoutes(value, context).authority, 'invalid-evidence');
  assert.equal(reconcile(approved(), value).action, 'retain');
});
test('explicit invalidated runner result revokes authority even before owner drops its context key', () => {
  const decision = reconcile(approved(), { ...temporary, error: { kind: 'invalidated' } });
  assert.equal(decision.action, 'withdraw');
  assert.equal(decision.authority, 'revoked');
});
test('permission to experiment is not reported as verified topic evidence', () => {
  const experiment = rule({ decision: 'experimental', protocol: 'ici-seven-state-topics' });
  const assessment = assessCompatibility(observation('A', experiment).device, { rules: [experiment] });
  assert.equal(assessment.kind, 'experimental');
  assert.deepEqual(assessment.evidencedStateTopics, []);
});
test('explicit unsupported policy overrides otherwise evidenced model eligibility', () => {
  const policy = { rules: [rule({ product: 'tb2', generation: 'tng', family: 'toniebox-2', decision: 'unsupported' })] };
  const result = approveRoutes(discovery(), context, policy);
  assert.equal(result.production.routes.length, 0);
  assert.equal(result.excluded[0].reason, 'unsupported');
});
test('model evidence with missing required features cannot grant experimental routing', () => {
  const experiment = rule({ decision: 'experimental', protocol: 'ici-seven-state-topics', requiredFeatures: ['synthetic-required'] });
  const output = approveRoutes(discovery([observation('A', experiment)]), context, { rules: [experiment] });
  assert.equal(output.experimental.length, 0);
});
test('resource rejection still withdraws positively conflicted old routes', () => {
  const value = discovery([...Array.from({ length: 101 }, (_, i) => observation('D' + i)),
    observation(), observation('CONFLICT', { macAddress: observation().device.macAddress })]);
  const decision = reconcile(approved(), value);
  assert.equal(decision.action, 'withdraw');
  assert.equal(decision.reason, 'conflict');
});
test('conflict decisions are independent of partial observation ordering', () => {
  const value = partial(discovery([observation(), observation('OTHER', { macAddress: observation().device.macAddress })]));
  const reordered = structuredClone(value); reordered.snapshot.devices.reverse();
  assert.deepEqual(reconcile(approved(), value), reconcile(approved(), reordered));
});
test('caller cancellation alone is not account revocation', () => {
  assert.equal(reconcile(approved(), { ...temporary, error: { kind: 'cancelled' } }).action, 'retain');
});

test('throwing discovery properties cannot escape reconciliation as private exceptions', () => {
  const bad = { get ok() {
    throw new Error('SYNTHETIC_PRIVATE_EXCEPTION');
  } };
  const result = reconcile(approved(), bad);
  assert.equal(result.action, 'retain');
  assert.equal(result.reason, 'incomplete');
  assert.doesNotMatch(JSON.stringify({ action: result.action, reason: result.reason }), /SYNTHETIC/);
});

// Review regressions: compatibility uncertainty is not affirmative routing revocation.
for (const fields of [
  { features: undefined }, { features: [] }, { features: ['synthetic-unknown'] },
  { product: undefined }, { generation: undefined },
]) {
  test('complete compatibility metadata loss retains trusted evidence: ' + JSON.stringify(fields), () => {
    const previous = approved();
    const result = discovery([observation(undefined, fields), observation('UNKNOWN_NEW', fields)]);
    const decision = reconcile(previous, result);
    assert.equal(decision.action, 'retain');
    assert.equal(decision.authority, 'last-known');
    assert.deepEqual(decision.plan, previous);
    assert.equal(approveRoutes(result, context).production.routes.length, 0);
    assert.equal(Object.isFrozen(decision.plan.routes[0].identity), true);
  });
}
for (const features of [undefined, [], 'invalid', [42], ['playbackControls', 42], ['synthetic-unknown']]) {
  test('actual 4A optional feature degradation retains old evidence: ' + JSON.stringify(features), async () => {
    const { createDiscoveryClient } = await import('../dist/toniebox/discoveryClient.js');
    const timers = new Set();
    const timerMock = mock.method(globalThis, 'setTimeout', () => {
      const timer = { unref() {} }; timers.add(timer); return timer;
    });
    const clearMock = mock.method(globalThis, 'clearTimeout', timer => timers.delete(timer));
    try {
      const client = createDiscoveryClient({ fetch: async () => new Response(JSON.stringify([
        observation(undefined, { features }).device, observation('NEW', { features }).device,
      ])) });
      const response = await client.getTonieboxes('SYNTHETIC_ACCESS', 'SYNTHETIC_HOUSE_A');
      assert.equal(response.ok, true);
      assert.equal(response.value.length, 2);
      const result = discovery(response.value.map(device => ({ device, requestedHouseholdId: 'SYNTHETIC_HOUSE_A' })));
      result.snapshot.households[0].diagnostics = response.diagnostics;
      const previous = approved();
      const decision = reconcile(previous, result);
      assert.equal(decision.action, 'retain');
      assert.equal(decision.authority, 'last-known');
      assert.deepEqual(decision.plan, previous);
      assert.equal(approveRoutes(result, context).production.routes.length, 0);
    } finally {
      timerMock.mock.restore(); clearMock.mock.restore(); assert.equal(timers.size, 0);
    }
  });
}
const invalidPolicies = [
  { rules: 'not-an-array' }, null, {}, { rules: [null] }, { rules: [rule({ evidence: '' })] },
  { get rules() {
    throw new Error('SYNTHETIC_PRIVATE_POLICY');
  } },
];
for (const [index, policy] of invalidPolicies.entries()) {
  test('invalid policy cannot grant or revoke authority: ' + index, () => {
    const previous = approved();
    const result = discovery([observation(), observation('NEW')]);
    const decision = reconcile(previous, result, { policy });
    assert.equal(decision.action, 'retain');
    assert.equal(decision.authority, 'last-known');
    assert.deepEqual(decision.plan, previous);
    assert.equal(reconcile(undefined, result, { policy }).action, 'none');
    const initial = approveRoutes(result, context, policy);
    assert.equal(initial.production?.routes.length ?? 0, 0);
    assert.equal(initial.experimental.length, 0);
    assert.doesNotMatch(JSON.stringify(initial.diagnostics), /SYNTHETIC_PRIVATE/);
  });
}
for (const [label, change] of [
  ['MAC conflict', r => r.snapshot.devices.push(observation('OTHER', { macAddress: observation().device.macAddress }))],
  ['household conflict', r => {
    r.snapshot.devices[0].device.householdId = 'OTHER';
  }],
  ['account changed', r => {
    r.snapshot.account.id = 'OTHER_ACCOUNT';
  }],
  ['complete absence', r => {
    r.snapshot.devices = [];
  }],
  ['device moved', r => {
    r.snapshot.devices[0].requestedHouseholdId = 'OTHER';
  }],
]) {
  test('throwing policy cannot hide independent revocation: ' + label, () => {
    const result = discovery(); change(result);
    const input = { previous: approved(), discovery: result, context,
      get policy() {
        throw new Error('SYNTHETIC_PRIVATE_POLICY');
      } };
    const decision = reconcileRoutes(input);
    assert.equal(decision.action, 'withdraw');
    assert.equal(decision.plan?.routes.length ?? 0, 0);
  });
}
for (const decision of ['unsupported', 'beta-candidate', 'experimental']) {
  test('explicit ' + decision + ' policy applies to trusted metadata despite optional loss', () => {
    const policy = { rules: [rule({ product: 'tb2', generation: 'tng', family: 'toniebox-2', decision,
      protocol: 'ici-seven-state-topics', requiredFeatures: ['playbackControls'] })] };
    for (const result of [discovery(), discovery([observation(undefined, { features: [] })]),
      partial(discovery([observation(undefined, { product: undefined })]))]) {
      assert.equal(reconcile(approved(), result, { policy }).action, 'withdraw');
    }
  });
}
for (const fields of [{ product: 'synthetic-other' }, { generation: 'synthetic-other' },
  { macAddress: 'SYNTHETIC_OTHER_MAC', features: [] }, { householdId: 'SYNTHETIC_OTHER_HOUSE', features: [] }]) {
  test('contradiction cannot use compatibility fallback: ' + JSON.stringify(fields), () => {
    assert.equal(reconcile(approved(), discovery([observation(undefined, fields)])).action, 'withdraw');
  });
}
test('retained evidence and evidenced new siblings can coexist without speculative additions', () => {
  const previous = approved();
  const decision = reconcile(previous, discovery([observation(undefined, { features: [] }),
    observation('NEW'), observation('UNKNOWN', { features: [] })]));
  assert.equal(decision.action, 'replace');
  assert.equal(decision.authority, 'last-known');
  assert.deepEqual(decision.plan.routes.map(r => r.routeId), ['NEW', 'SYNTHETIC_BOX_A']);
  assert.deepEqual(decision.plan.routes[1], previous.routes[0]);
});
test('invalid policy preserves survivors but not confirmed absence or new siblings', () => {
  const previous = approveRoutes(discovery([observation(), observation('ABSENT')]), context).production;
  const decision = reconcile(previous, discovery([observation(), observation('NEW')]), { policy: { rules: 42 } });
  assert.equal(decision.action, 'replace');
  assert.equal(decision.authority, 'last-known');
  assert.deepEqual(decision.plan.routes.map(r => r.routeId), ['SYNTHETIC_BOX_A']);
});
test('compatibility fallback cannot exceed the production route limit', () => {
  const previous = approved();
  const result = discovery([observation(undefined, { features: [] }), ...Array.from({ length: 100 }, (_, i) => observation('NEW' + i))]);
  const decision = reconcile(previous, result);
  assert.equal(decision.action, 'retain');
  assert.deepEqual(decision.plan, previous);
  assert.ok(validRoutePlan(decision.plan));
});
test('partial degraded rediscovery retains old evidence without adding a valid new sibling', () => {
  const previous = approved();
  const decision = reconcile(previous, partial(discovery([observation(undefined, { features: [] }), observation('NEW')])));
  assert.equal(decision.action, 'retain');
  assert.deepEqual(decision.plan, previous);
});
test('invalid policy cannot conceal context invalidation', () => {
  assert.equal(reconcile(approved(), discovery(), { context: undefined, policy: { rules: 42 } }).authority, 'revoked');
});

// Final review: affirmative revocation does not depend on discovery availability or plan capacity.
const unsupportedTb2 = extra => ({ rules: [rule({
  product: 'tb2', generation: 'tng', family: 'toniebox-2', decision: 'unsupported',
  requiredFeatures: ['playbackControls'], ...extra,
})] });
for (const hasPartial of [false, true]) {
  for (const multiple of [false, true]) {
    test('explicit restriction during failed discovery, partial=' + hasPartial + ', multiple=' + multiple, () => {
      const prior = approveRoutes(discovery(multiple ? [observation(), observation('SIBLING')] : [observation()]), context).production;
      const failed = hasPartial ? { ...temporary, partial: partial(discovery([observation('NEW')])).snapshot } : temporary;
      const policy = unsupportedTb2(multiple ? { deviceId: 'SYNTHETIC_BOX_A' } : {});
      const decision = reconcile(prior, failed, { policy });
      assert.equal(decision.action, multiple ? 'replace' : 'withdraw');
      assert.deepEqual(decision.plan.routes, multiple ? prior.routes.filter(r => r.routeId === 'SIBLING') : []);
      assert.ok(validRoutePlan(decision.plan));
      assert.equal(reconcile(undefined, failed, { policy }).action, 'none');
      assert.equal(approveRoutes(failed, context, policy).production, undefined);
    });
  }
}
test('model restriction during outage preserves an unrelated validated model', () => {
  const otherRule = rule({ decision: 'validated', protocol: 'ici-seven-state-topics' });
  const prior = approveRoutes(discovery([observation(), observation('OTHER_MODEL', otherRule)]), context, { rules: [otherRule] }).production;
  assert.equal(prior.routes.length, 2);
  const decision = reconcile(prior, temporary, { policy: { rules: [...unsupportedTb2().rules, otherRule] } });
  assert.equal(decision.action, 'replace');
  assert.deepEqual(decision.plan.routes, prior.routes.filter(r => r.routeId === 'OTHER_MODEL'));
});
for (const [label, policy] of [
  ['invalid', { rules: 'invalid' }],
  ['throwing', { get rules() {
    throw new Error('SYNTHETIC_PRIVATE_POLICY');
  } }],
]) {
  for (const hasPartial of [false, true]) {
    test(label + ' policy during discovery failure cannot revoke, partial=' + hasPartial, () => {
      const prior = approved();
      const failed = hasPartial ? { ...temporary, partial: partial(discovery([observation('NEW')])).snapshot } : temporary;
      const decision = reconcile(prior, failed, { policy });
      assert.equal(decision.action, 'retain');
      assert.deepEqual(decision.plan, prior);
      assert.equal(reconcile(undefined, failed, { policy }).action, 'none');
    });
  }
}
test('context and account revocation retain priority over explicit policy during failure', () => {
  const prior = approved(), policy = unsupportedTb2();
  assert.equal(reconcile(prior, temporary, { context: undefined, policy }).reason, 'invalidated');
  assert.equal(reconcile(prior, { ...temporary, error: { kind: 'invalidated' } }, { policy }).reason, 'invalidated');
  const snapshot = discovery().snapshot; snapshot.account.id = 'SYNTHETIC_OTHER_ACCOUNT';
  const decision = reconcile(prior, { ...temporary, partial: snapshot }, { policy });
  assert.equal(decision.reason, 'account-changed');
  assert.equal(decision.authority, 'revoked');
  assert.equal(decision.plan, undefined);
});
test('nonmatching explicit restriction does not revoke trusted identity during outage', () => {
  const prior = approved();
  for (const selector of [{ product: 'OTHER' }, { generation: 'OTHER' }, { deviceId: 'OTHER' }, { requiredFeatures: ['OTHER'] }]) {
    assert.deepEqual(reconcile(prior, temporary, { policy: unsupportedTb2(selector) }).plan, prior);
  }
});
const oversizedNew = () => Array.from({ length: 101 }, (_, i) => observation('NEW' + i));
test('complete absence withdraws old route even when 101 new routes exceed capacity', () => {
  const result = discovery(oversizedNew());
  assert.equal(approveRoutes(result, context).authority, 'resource-limit');
  const decision = reconcile(approved(), result);
  assert.equal(decision.action, 'withdraw');
  assert.deepEqual(decision.plan.routes, []);
  assert.equal(reconcile(undefined, result).action, 'none');
});
test('old route still present survives overflow without accepting any of 101 new routes', () => {
  const prior = approved();
  const decision = reconcile(prior, discovery([observation(), ...oversizedNew()]));
  assert.equal(decision.action, 'retain');
  assert.equal(decision.reason, 'resource-limit');
  assert.deepEqual(decision.plan, prior);
});
test('oversized complete discovery withdraws absent old sibling and retains present sibling', () => {
  const prior = approveRoutes(discovery([observation('A'), observation('B')]), context).production;
  const decision = reconcile(prior, discovery([observation('B'), ...oversizedNew()]));
  assert.equal(decision.action, 'replace');
  assert.deepEqual(decision.plan.routes, prior.routes.filter(r => r.routeId === 'B'));
  assert.ok(validRoutePlan(decision.plan));
});
test('combined current and last-known capacity rejection cannot hide absent old sibling', () => {
  const prior = approveRoutes(discovery([observation('A'), observation('B')]), context).production;
  const result = discovery([observation('B', { features: [] }), ...oversizedNew().slice(0, 100)]);
  assert.equal(approveRoutes(result, context).production.routes.length, 100);
  const decision = reconcile(prior, result);
  assert.equal(decision.action, 'replace');
  assert.deepEqual(decision.plan.routes, prior.routes.filter(r => r.routeId === 'B'));
  assert.equal(decision.authority, 'last-known');
  assert.ok(validRoutePlan(decision.plan));
});
test('partial or failed oversized membership cannot establish absence or authorise new routes', () => {
  const prior = approved();
  for (const result of [temporary, partial(discovery(oversizedNew())),
    { ...temporary, partial: discovery(oversizedNew()).snapshot }]) {
    const decision = reconcile(prior, result);
    assert.equal(decision.action, 'retain');
    assert.deepEqual(decision.plan, prior);
  }
});
