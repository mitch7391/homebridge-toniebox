import type {
  AccountIdentity, DiscoveredToniebox, DiscoveryClient, DiscoveryDiagnostics, DiscoveryFailure, HouseholdIdentity,
} from './discoveryTypes.js';
import type { TokenManager, TokenManagerFailure } from './tokenManagerTypes.js';

export interface DiscoveryClock {
  now(): { readonly monotonicMs: number; readonly wallMs: number };
}

/** Asynchronous one-shot scheduling. Cancellation must be idempotent. */
export interface DiscoveryScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface DiscoveryRunnerOptions {
  readonly tokenProvider: Pick<TokenManager, 'getAccessToken'>;
  readonly discoveryClient: DiscoveryClient;
  /**
   * Owner must invalidate this context BEFORE changing/clearing credentials, then create a new runner.
   * Identical configuration need not invalidate it. Cooldowns must not be bypassed by recreating runners.
   * The token manager cannot notify this runner about arbitrary external credential changes.
   */
  readonly contextSignal: AbortSignal;
  readonly clock?: DiscoveryClock;
  readonly scheduler?: DiscoveryScheduler;
}

export type DiscoveryStage = 'account' | 'households' | 'tonieboxes';

export interface DiscoveryRunFailure {
  readonly kind:
    | 'invalid-input' | 'busy' | 'cooldown' | 'cancelled' | 'invalidated' | 'stopped'
    | 'clock-invalid' | 'dependency' | 'authentication' | 'deadline' | 'token-expired' | 'request' | 'retry-deferred';
  readonly stage?: DiscoveryStage;
  readonly retryAfterMs?: number;
  readonly tokenFailure?: TokenManagerFailure;
  readonly discoveryFailure?: DiscoveryFailure;
}

/** Private observations, not a device catalogue or permission to create MQTT routes. */
export interface DiscoveredObservation {
  readonly requestedHouseholdId: string;
  readonly device: DiscoveredToniebox;
  readonly identityConflict?: true;
}

export type HouseholdDiscovery = {
  readonly identity: HouseholdIdentity;
} & (
  | { readonly outcome: 'unattempted' | 'interrupted' }
  | { readonly outcome: 'failed'; readonly error: DiscoveryFailure }
  | { readonly outcome: 'received'; readonly diagnostics: DiscoveryDiagnostics }
);

export interface DiscoverySnapshot {
  readonly account: AccountIdentity;
  readonly accountDiagnostics: DiscoveryDiagnostics;
  readonly householdsDiagnostics?: DiscoveryDiagnostics;
  readonly households: readonly HouseholdDiscovery[];
  readonly devices: readonly DiscoveredObservation[];
  /** Finished means no known coverage gaps in observed endpoints, not proof of server completeness. */
  readonly enumeration: 'finished' | 'partial';
  /** Independent dimensions: conflicts can be observed while coverage is also insufficient. */
  readonly routing: {
    readonly conflicts: 'observed' | 'none-observed';
    readonly evidence: 'insufficient' | 'observed-endpoints';
  };
}

/** Identifier-free summary. Counts from successful 4A responses only; retries are not double-counted. */
export interface DiscoveryRunDiagnostics {
  readonly requests: number;
  readonly retries: number;
  readonly rejectedEntries: number;
  readonly degradedEntries: number;
  readonly duplicateEntries: number;
  readonly continuationDetected: boolean;
  readonly failedHouseholds: number;
  readonly unattemptedHouseholds: number;
  readonly interruptedHouseholds: number;
  readonly identityConflictEntries: number;
  readonly ambiguousRoutingEntries: number;
  readonly missingMacEntries: number;
}

export type DiscoveryRunResult =
  | { readonly ok: true; readonly snapshot: DiscoverySnapshot; readonly diagnostics: DiscoveryRunDiagnostics }
  | {
      readonly ok: false;
      readonly error: DiscoveryRunFailure;
      /** Never provided for caller cancellation, context invalidation or shutdown. */
      readonly partial?: DiscoverySnapshot;
      readonly diagnostics: DiscoveryRunDiagnostics;
    };

/**
 * One logically active run; GETs within that run are sequential.
 * Abandonment aborts and settles promptly. An injected dependency/transport that ignores
 * abort may remain physically unresolved while a later run proceeds; late results are ignored.
 * 4A independently settles its request promise and cleans up when aborted, without waiting
 * for an uncooperative underlying transport. This runner provides no physical transport mutex.
 *
 * Rate-limit observation occurs in the dependency promise reaction while the run is current.
 * At the exact deadline, observed 429/503 guidance survives but discovery still expires.
 * If abandonment runs first, subsequent reactions cannot install cooldowns or publish data.
 */
export interface DiscoveryRunner {
  discover(options?: { readonly signal?: AbortSignal }): Promise<DiscoveryRunResult>;
  /** Permanent and idempotent. Does not stop or clear the shared token manager. */
  stop(): void;
}
