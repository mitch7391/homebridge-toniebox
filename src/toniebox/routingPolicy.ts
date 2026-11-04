import type { DiscoveryDiagnostics } from './discoveryTypes.js';
import type { DiscoveredObservation, DiscoveryRunResult, DiscoverySnapshot } from './discoveryRunnerTypes.js';
import type {
  ApprovedDeviceRoute, ApprovedRoutePlan, CompatibilityAssessment, CompatibilityPolicy, CompatibilityRule,
  ExcludedObservation, ReconcileInput, Reconciliation, RouteApproval, RoutingAuthority,
} from './routingTypes.js';
import type { DeviceIdentity, Topic } from './types.js';

const TOPICS: readonly Topic[] = ['metrics/battery', 'online-state', 'metrics/headphones', 'settings-applied',
  'playback/state', 'volume/state', 'app-reply/bedtime-state'];
/** Mirrors 5A/5B input constraints; contract tests detect divergence without importing transport I/O. */
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/\s/u.test(value) && [...value].every(c => c.charCodeAt(0) > 31 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159));
const mac = (value: unknown): value is string => text(value) && !/[/\\+#]/u.test(value);
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const ordered = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function ruleValid(rule: CompatibilityRule): boolean {
  return !!rule && nonblank(rule.product) && nonblank(rule.generation) && nonblank(rule.evidence)
    && (rule.deviceId === undefined || text(rule.deviceId))
    && ['toniebox-1', 'toniebox-2', 'toniebox-lite', 'unknown'].includes(rule.family)
    && ['beta-candidate', 'experimental', 'validated', 'unsupported'].includes(rule.decision)
    && (rule.requiredFeatures === undefined || (Array.isArray(rule.requiredFeatures) && rule.requiredFeatures.every(nonblank)))
    && (!['experimental', 'validated'].includes(rule.decision) || rule.protocol === 'ici-seven-state-topics');
}

/** Snapshot policy once so malformed or throwing configuration is not a revocation decision. */
function readPolicy(read: () => CompatibilityPolicy | undefined):
  { ok: true; value?: CompatibilityPolicy } | { ok: false } {
  try {
    const value = read();
    if (value === undefined) {
      return { ok: true };
    }
    const copied = structuredClone(value);
    return copied && Array.isArray(copied.rules) && copied.rules.every(ruleValid)
      ? { ok: true, value: copied } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function matchingRules(device: DeviceIdentity, policy?: CompatibilityPolicy): readonly CompatibilityRule[] {
  return policy?.rules.filter(rule => rule.product === device.product && rule.generation === device.generation
    && (rule.deviceId === undefined || rule.deviceId === device.id)
    && (rule.requiredFeatures ?? []).every(feature => device.features?.includes(feature))) ?? [];
}

/** Evaluate explicit restrictions against trusted metadata too; loss of a selector cannot evade them. */
function restricted(device: DeviceIdentity, policy?: CompatibilityPolicy): boolean {
  const matches = matchingRules(device, policy);
  return matches.length > 1 || matches.some(rule => rule.decision !== 'validated');
}

/** Central compatibility decision. Unknown advertisements survive; none become command guarantees. */
export function assessCompatibility(device: DeviceIdentity, policy?: CompatibilityPolicy): CompatibilityAssessment {
  const advertised = device.features === undefined ? {} : { advertisedFeatures: [...device.features] };
  const unknown: CompatibilityAssessment = {
    kind: 'unknown', family: device.product === 'tb2' ? 'toniebox-2' : 'unknown',
    evidenceScope: 'none', evidencedStateTopics: [], ...advertised,
  };
  const checked = readPolicy(() => policy);
  if (!checked.ok) {
    return unknown;
  }
  const matches = matchingRules(device, checked.value);
  if (matches.length > 1) {
    return unknown; // Conflicting supplied policy never becomes first-match authority.
  }
  if (matches.length === 1) {
    const rule = matches[0];
    return {
      kind: rule.decision, family: rule.family,
      evidenceScope: rule.deviceId === undefined ? 'supplied-model' : 'supplied-device',
      evidencedStateTopics: rule.decision === 'validated' ? [...TOPICS] : [], ...advertised,
    };
  }
  if (device.product === 'tb2' && device.generation === 'tng' && device.features?.includes('playbackControls')) {
    return { ...unknown, kind: 'provisional', evidenceScope: 'reference-device', evidencedStateTopics: [...TOPICS] };
  }
  return unknown;
}

function diagnosticValid(d: DiscoveryDiagnostics | undefined): d is DiscoveryDiagnostics {
  return !!d && count(d.rejectedEntries) && count(d.degradedEntries) && count(d.duplicateEntries)
    && count(d.ambiguousRoutingEntries) && d.duplicateEntries <= d.rejectedEntries && typeof d.continuationDetected === 'boolean';
}
function covered(d: DiscoveryDiagnostics | undefined): boolean {
  return diagnosticValid(d) && d.rejectedEntries === 0 && !d.continuationDetected;
}
interface Analysis {
  snapshot?: DiscoverySnapshot;
  observations: DiscoveredObservation[];
  excluded: ExcludedObservation[];
  ids: Set<string>;
  macs: Set<string>;
  unlocalised: boolean;
  complete: boolean;
  invalid: boolean;
}

/** Inspect ALL observations before compatibility filtering, including rejected identity groups' diagnostics. */
function analyse(result: DiscoveryRunResult): Analysis {
  const snapshot = result.ok ? result.snapshot : result.partial;
  const analysis: Analysis = {
    snapshot, observations: [], excluded: [], ids: new Set(), macs: new Set(), unlocalised: false, complete: false, invalid: false,
  };
  if (!snapshot) {
    return analysis;
  }
  analysis.observations = structuredClone(snapshot.devices) as DiscoveredObservation[];
  const diagnostics = [snapshot.accountDiagnostics, snapshot.householdsDiagnostics,
    ...snapshot.households.map(h => h.outcome === 'received' ? h.diagnostics : undefined)];
  analysis.invalid = !snapshot.account || !nonblank(snapshot.account.id) || !['uuid', 'id'].includes(snapshot.account.identitySource)
    || !['finished', 'partial'].includes(snapshot.enumeration)
    || !['insufficient', 'observed-endpoints'].includes(snapshot.routing.evidence)
    || !['observed', 'none-observed'].includes(snapshot.routing.conflicts)
    || diagnostics.some(d => d !== undefined && !diagnosticValid(d));
  analysis.unlocalised = diagnostics.some(d => diagnosticValid(d) && d.duplicateEntries > 0);
  const households = new Map<string, number>();
  for (const h of snapshot.households) {
    if (!nonblank(h.identity.id)) {
      analysis.invalid = true;
    }
    households.set(h.identity.id, (households.get(h.identity.id) ?? 0) + 1);
  }
  const idCounts = new Map<string, number>();
  const macCounts = new Map<string, number>();
  for (const observation of analysis.observations) {
    const d = observation.device;
    if (!d || !nonblank(d.id) || !nonblank(observation.requestedHouseholdId)
      || (d.features !== undefined && (!Array.isArray(d.features) || !d.features.every(nonblank)))) {
      analysis.invalid = true;
      continue;
    }
    idCounts.set(d.id, (idCounts.get(d.id) ?? 0) + 1);
    if (typeof d.macAddress === 'string') {
      const normal = d.macAddress.toUpperCase();
      macCounts.set(normal, (macCounts.get(normal) ?? 0) + 1);
    }
  }
  for (const observation of analysis.observations) {
    const d = observation.device;
    const normal = typeof d?.macAddress === 'string' ? d.macAddress.toUpperCase() : undefined;
    const householdConflict = households.get(observation.requestedHouseholdId) !== 1
      || (d.householdId !== undefined && d.householdId !== observation.requestedHouseholdId);
    const conflict = observation.identityConflict || d.routingAmbiguous
      || (idCounts.get(d.id) ?? 0) > 1 || (normal !== undefined && (macCounts.get(normal) ?? 0) > 1);
    if (conflict || householdConflict) {
      analysis.ids.add(d.id);
      if (normal !== undefined) {
        analysis.macs.add(normal);
      }
      analysis.excluded.push({ observation, reason: householdConflict ? 'household-conflict' : 'identity-conflict' });
    }
  }
  // A summary without localisable evidence cannot safely exonerate an existing route.
  const flagged = analysis.observations.filter(o => o.device.routingAmbiguous).length;
  const ambiguousCount = diagnostics.reduce((n, d) => n + (d?.ambiguousRoutingEntries ?? 0), 0);
  if (ambiguousCount > flagged || (snapshot.routing.conflicts === 'observed' && analysis.ids.size === 0)) {
    analysis.unlocalised = true;
  }
  analysis.complete = result.ok && !analysis.invalid && snapshot.enumeration === 'finished'
    && snapshot.routing.evidence === 'observed-endpoints' && diagnostics.every(covered)
    && snapshot.households.every(h => h.outcome === 'received')
    && [...households.values()].every(n => n === 1)
    && analysis.observations.every(o => snapshot.households.some(h => h.identity.id === o.requestedHouseholdId && h.outcome === 'received'));
  return analysis;
}

/** Returned plans are deeply frozen and detached from discovery/policy inputs. */
function plan(context: symbol, accountUuid: string, lane: ApprovedRoutePlan['lane'], routes: readonly ApprovedDeviceRoute[]): ApprovedRoutePlan {
  const copied = routes.map(route => Object.freeze({
    routeId: route.routeId, macAddress: route.macAddress, householdId: route.householdId,
    identity: Object.freeze({ ...route.identity,
      ...(route.identity.features === undefined ? {} : { features: Object.freeze([...route.identity.features]) }) }),
  })).sort((a, b) => ordered(a.routeId, b.routeId));
  return Object.freeze({ context, accountUuid, lane, routes: Object.freeze(copied) });
}

/** Also used by the state adapter at its private plan boundary. Empty plans mean no transport. */
export function validRoutePlan(value: ApprovedRoutePlan): boolean {
  if (!value || typeof value.context !== 'symbol' || !text(value.accountUuid)
    || !['production', 'experimental'].includes(value.lane) || !Array.isArray(value.routes)
    || value.routes.length > (value.lane === 'experimental' ? 1 : 100)) {
    return false;
  }
  const ids = new Set<string>();
  const macs = new Set<string>();
  let size = 0;
  for (const route of value.routes) {
    if (!route || !text(route.routeId) || !mac(route.macAddress) || !nonblank(route.householdId)
      || route.identity?.id !== route.routeId || route.identity.macAddress !== route.macAddress
      || (route.identity.features !== undefined && (!Array.isArray(route.identity.features) || !route.identity.features.every(nonblank)))
      || route.macAddress !== route.macAddress.toUpperCase() || ids.has(route.routeId) || macs.has(route.macAddress)) {
      return false;
    }
    ids.add(route.routeId);
    macs.add(route.macAddress);
    for (const topic of TOPICS) {
      size += Buffer.byteLength('external/toniebox/' + route.macAddress + '/' + topic) + 3;
    }
  }
  return size <= 65536;
}

function approve(analysis: Analysis, context: symbol, policy?: CompatibilityPolicy): RouteApproval {
  const { snapshot, observations, excluded } = analysis;
  let authority: RoutingAuthority = analysis.invalid ? 'invalid-evidence' : analysis.complete ? 'sufficient' : 'insufficient';
  if (snapshot && (snapshot.account.identitySource !== 'uuid' || !text(snapshot.account.id))) {
    authority = 'account-unverified';
  }
  const production: ApprovedDeviceRoute[] = [];
  const experiments: ApprovedDeviceRoute[] = [];
  for (const observation of observations) {
    if (excluded.some(e => e.observation === observation)) {
      continue;
    }
    const d = observation.device;
    let reason: ExcludedObservation['reason'] | undefined;
    const assessment = assessCompatibility(d, policy);
    if (d.macAddress === undefined) {
      reason = 'missing-mac';
    } else if (!text(d.id) || !mac(d.macAddress)) {
      reason = 'invalid-route';
    } else if (assessment.kind === 'unknown') {
      reason = 'compatibility-unknown';
    } else if (assessment.kind === 'beta-candidate' || assessment.kind === 'unsupported') {
      reason = assessment.kind;
    }
    if (reason) {
      excluded.push({ observation, reason });
    } else {
      const normal = d.macAddress!.toUpperCase();
      const route = {
        routeId: d.id, macAddress: normal, householdId: observation.requestedHouseholdId,
        identity: { ...d, macAddress: normal },
      };
      (assessment.kind === 'experimental' ? experiments : production).push(route);
    }
  }
  let approved: ApprovedRoutePlan | undefined;
  let experimental: ApprovedRoutePlan[] = [];
  if (authority === 'sufficient' && !analysis.unlocalised) {
    approved = plan(context, snapshot!.account.id, 'production', production);
    experimental = experiments.map(route => plan(context, snapshot!.account.id, 'experimental', [route]));
    if (!validRoutePlan(approved) || experimental.some(p => !validRoutePlan(p))) {
      authority = 'resource-limit';
      approved = undefined;
      experimental = [];
    }
  } else if (analysis.unlocalised && authority === 'sufficient') {
    authority = 'insufficient';
  }
  return {
    authority, ...(approved ? { production: approved } : {}), experimental, observations, excluded,
    diagnostics: {
      authority, observed: observations.length, excluded: excluded.length, conflicts: analysis.ids.size,
      production: approved?.routes.length ?? 0, experimental: experimental.length,
    },
  };
}

/** Takes a current-context 4B result; the caller must reject stale runs before supplying it. */
export function approveRoutes(result: DiscoveryRunResult, context: symbol, policy?: CompatibilityPolicy): RouteApproval {
  try {
    if (typeof context !== 'symbol') {
      throw new TypeError();
    }
    return approve(analyse(result), context, policy);
  } catch {
    return {
      authority: 'invalid-evidence', observations: [], excluded: [], experimental: [],
      diagnostics: { authority: 'invalid-evidence', observed: 0, excluded: 0, conflicts: 0, production: 0, experimental: 0 },
    };
  }
}

function sameRoutes(a: ApprovedRoutePlan, b: ApprovedRoutePlan): boolean {
  return a.routes.length === b.routes.length && a.routes.every(route => b.routes.some(other =>
    route.routeId === other.routeId && route.macAddress === other.macAddress && route.householdId === other.householdId));
}

/**
 * Production reconciliation only. Experiments require independent, explicit lifecycle decisions.
 * Failed/partial observations cannot add routes or prove absence; positive conflicts can revoke.
 * Malformed input is not positive revocation evidence. Context invalidation always takes priority.
 */
export function reconcileRoutes(input: ReconcileInput): Reconciliation {
  const previous = input.previous;
  if (input.context === undefined || (previous && previous.context !== input.context)) {
    return { action: previous?.routes.length ? 'withdraw' : 'none', authority: 'revoked', reason: 'invalidated' };
  }
  try {
    if (!input.discovery.ok && input.discovery.error.kind === 'invalidated') {
      return { action: previous?.routes.length ? 'withdraw' : 'none', authority: 'revoked', reason: 'invalidated' };
    }
    if (previous && (!validRoutePlan(previous) || previous.lane !== 'production')) {
      return { action: 'withdraw', authority: 'revoked', reason: 'invalidated' };
    }
    const analysis = analyse(input.discovery);
    const snapshot = analysis.snapshot;
    if (previous && snapshot?.account.identitySource === 'uuid' && text(snapshot.account.id) && snapshot.account.id !== previous.accountUuid) {
      return { action: 'withdraw', authority: 'revoked', reason: 'account-changed' };
    }
    const policy = readPolicy(() => input.policy);
    // An invalid policy cannot approve routes. Still inspect independent discovery contradictions.
    const approval = policy.ok ? approve(analysis, input.context, policy.value) : undefined;
    // Explicit policy applies to trusted prior identity even when discovery returns no snapshot.
    let remaining = (previous?.routes ?? []).filter(route => !policy.ok || !restricted(route.identity, policy.value));
    if (previous && !analysis.invalid && snapshot?.account.identitySource === 'uuid' && snapshot.account.id === previous.accountUuid) {
      remaining = analysis.unlocalised ? [] : remaining.filter(route => {
        if (analysis.ids.has(route.routeId) || analysis.macs.has(route.macAddress)) {
          return false;
        }
        const observed = analysis.observations.find(o => o.device.id === route.routeId);
        if (analysis.complete && !observed) {
          return false; // Authoritative absence is independent of policy validity and new-plan capacity.
        }
        return !analysis.observations.some(({ device, requestedHouseholdId }) =>
          (device.id === route.routeId && ((mac(device.macAddress) && device.macAddress.toUpperCase() !== route.macAddress)
            || requestedHouseholdId !== route.householdId
            || (nonblank(device.product) && device.product !== route.identity.product)
            || (nonblank(device.generation) && device.generation !== route.identity.generation)
            || (policy.ok && restricted(device, policy.value))))
          || (mac(device.macAddress) && device.macAddress.toUpperCase() === route.macAddress && device.id !== route.routeId));
      });
    }
    if (approval?.production) {
      const routes = approval.production.routes.filter(route => {
        const old = previous?.routes.find(r => r.routeId === route.routeId);
        return !old || !policy.ok || !restricted(old.identity, policy.value);
      });
      const retained = remaining.filter(route => !routes.some(r => r.routeId === route.routeId)
        && approval.excluded.some(({ observation: o, reason }) => reason === 'compatibility-unknown'
          && o.device.id === route.routeId && mac(o.device.macAddress)
          && o.device.macAddress.toUpperCase() === route.macAddress && o.requestedHouseholdId === route.householdId));
      // Retain the complete trusted identity, not a merge of degraded metadata into its evidence.
      const next = plan(input.context, snapshot!.account.id, 'production', [...routes, ...retained]);
      if (validRoutePlan(next)) {
        return {
          action: previous && sameRoutes(previous, next) ? 'retain' : next.routes.length ? 'replace' : previous?.routes.length ? 'withdraw' : 'none',
          authority: retained.length ? 'last-known' : 'current', reason: retained.length ? 'incomplete' : 'complete', plan: next,
        };
      }
      // Combining last-known and newly approved routes must still respect the whole-plan bound.
    }
    if (!previous) {
      return { action: 'none', authority: 'last-known', reason: 'incomplete' };
    }
    const next = plan(previous.context, previous.accountUuid, 'production', remaining);
    const changed = remaining.length !== previous.routes.length;
    return {
      action: changed ? remaining.length ? 'replace' : 'withdraw' : 'retain',
      authority: 'last-known',
      reason: changed ? 'conflict' : approval?.authority === 'resource-limit' ? 'resource-limit' : 'incomplete',
      plan: next,
    };
  } catch {
    // A malformed/throwing dependency value is neither deletion nor authenticated contradiction.
    return previous
      ? { action: 'retain', authority: 'last-known', reason: 'incomplete',
        plan: plan(previous.context, previous.accountUuid, previous.lane, previous.routes) }
      : { action: 'none', authority: 'last-known', reason: 'incomplete' };
  }
}
