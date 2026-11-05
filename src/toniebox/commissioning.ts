import type { DiscoveryRunResult } from './discoveryRunnerTypes.js';
import type { RouteApproval, CompatibilityPolicy } from './routingTypes.js';
import { assessCompatibility } from './routingPolicy.js';
import type { IntegrationResult, DeviceObservation } from './backendState.js';
import type { MqttSessionMessage } from './mqttLifecycleTypes.js';

/** Set true only in a separately approved commissioning build. Never read config or DEBUG. */
export const COMMISSIONING_BUILD = false;
const LIMIT = 65535;
const topics = ['metrics/battery', 'online-state', 'metrics/headphones', 'settings-applied',
  'playback/state', 'volume/state', 'app-reply/bedtime-state'] as const;
const categories = ['battery', 'online', 'headphones', 'settings', 'playback', 'volume', 'bedtime'] as const;
const exclusions = ['identity-conflict', 'household-conflict', 'invalid-route', 'missing-mac',
  'compatibility-unknown', 'beta-candidate', 'unsupported'] as const;
const newCounters = () => ({ totals: { received: 0, accepted: 0, rejected: 0, unchanged: 0, changed: 0, retained: 0, live: 0 },
  coverage: Object.fromEntries(categories.map(c => [c, 0])) as Record<typeof categories[number], number>,
  acceptedCoverage: Object.fromEntries(categories.map(c => [c, 0])) as Record<typeof categories[number], number> });
const count = (n: number): number => Math.min(LIMIT, Math.max(0, Math.floor(n)));
type Lane = 'production' | 'experimental';
export type CommissioningObservation =
  | { kind: 'discovery'; coverage: 'complete' | 'partial' | 'unknown'; provenance: 'uuid' | 'unverified';
    households: number; devices: number; tb2Candidates: number; productionRoutes: number;
    exclusions: Record<typeof exclusions[number], number> }
  | { kind: 'session'; lane: Lane; established: number }
  | { kind: 'messages'; lane: Lane; received: number; accepted: number; rejected: number;
    unchanged: number; changed: number; retained: number; live: number;
    coverage: Record<typeof categories[number], number>; acceptedCoverage: Record<typeof categories[number], number>;
    evidence?: { volumeLevel: number; retained: boolean } };

/** Passive projection only. Counters saturate; at most 64 queued/emitted observations per owner.
 * Deferred delivery prevents observer reentrancy inside backend transitions. Dropped stale observations
 * still consume budget. Message summaries: first eight, then powers of two; not a complete event log.
 */
export class CommissioningObserver {
  #budget = 64;
  #sessions = { production: 0, experimental: 0 };
  #lanes = { production: newCounters(), experimental: newCounters() };
  reset(): void {
    this.#sessions = { production: 0, experimental: 0 };
    this.#lanes = { production: newCounters(), experimental: newCounters() };
  }
  constructor(private readonly observer: (event: CommissioningObservation) => void) {}
  #emit(event: CommissioningObservation, current: () => boolean): void {
    if (this.#budget-- <= 0) {
      this.#budget = 0; return;
    }
    void Promise.resolve().then(() => {
      if (current()) {
        return this.observer(event);
      }
    }).catch(() => undefined);
  }
  discovery(result: DiscoveryRunResult, approval: RouteApproval, productionRoutes: number,
    policy: CompatibilityPolicy | undefined, current: () => boolean): void {
    const s = result.ok ? result.snapshot : result.partial;
    const excluded = Object.fromEntries(exclusions.map(k => [k,
      count(approval.excluded.filter(e => e.reason === k).length)])) as Record<typeof exclusions[number], number>;
    this.#emit({ kind: 'discovery', coverage: s ? result.ok && s.enumeration === 'finished' ? 'complete' : 'partial' : 'unknown',
      provenance: s?.account.identitySource === 'uuid' ? 'uuid' : 'unverified', households: count(s?.households.length ?? 0),
      devices: count(s?.devices.length ?? 0), productionRoutes: count(productionRoutes),
      tb2Candidates: count((s?.devices ?? []).filter(o => {
        const a = assessCompatibility(o.device, policy);
        return a.family === 'toniebox-2' && (a.kind === 'provisional' || a.kind === 'validated');
      }).length), exclusions: excluded }, current);
  }
  session(lane: Lane, current: () => boolean): void {
    this.#sessions[lane] = count(this.#sessions[lane] + 1);
    this.#emit({ kind: 'session', lane, established: this.#sessions[lane] }, current);
  }
  message(lane: Lane, message: MqttSessionMessage, applied: IntegrationResult,
    observation: () => DeviceObservation | undefined, current: () => boolean): void {
    if (!applied.accepted && applied.reason === 'stale') {
      return;
    }
    const counters = this.#lanes[lane];
    const t = counters.totals;
    const increment = (key: keyof typeof t): void => {
      t[key] = count(t[key] + 1);
    };
    increment('received'); increment(message.retained ? 'retained' : 'live');
    increment(applied.accepted ? 'accepted' : 'rejected');
    if (applied.accepted) {
      increment(applied.changed ? 'changed' : 'unchanged');
    }
    const suffix = message.topic.split('/').slice(3).join('/');
    const index = topics.findIndex(topic => topic === suffix);
    if (index >= 0) {
      const category = categories[index];
      counters.coverage[category] = count(counters.coverage[category] + 1);
      if (applied.accepted) {
        counters.acceptedCoverage[category] = count(counters.acceptedCoverage[category] + 1);
      }
    }
    if (!(t.received <= 8 || (t.received & (t.received - 1)) === 0) || this.#budget <= 0) {
      return;
    }
    const level = applied.accepted && suffix === 'volume/state' ? observation()?.state.topics['volume/state']?.value.level : undefined;
    const evidence = Number.isSafeInteger(level) && level! >= 0 ? { volumeLevel: level!, retained: message.retained } : undefined;
    this.#emit({ kind: 'messages', lane, ...t, coverage: { ...counters.coverage }, acceptedCoverage: { ...counters.acceptedCoverage },
      ...(evidence ? { evidence } : {}) }, current);
  }
}
