import type { AuthClient, AuthCredentials } from './authTypes.js';
import type { DeviceObservation } from './backendState.js';
import type { DiscoveryClient } from './discoveryTypes.js';
import type { MqttLifecycle, MqttLifecycleOptions, MqttLifecycleStatus } from './mqttLifecycleTypes.js';
import type { CompatibilityPolicy } from './routingTypes.js';
import type { TokenClock, TokenScheduler } from './tokenManagerTypes.js';

/** Conservative account-wide budget: at most four isolated experiments, plus one production connection.
 * Oversized sets suspend all experiments; never truncate or pick an arbitrary subset. */
export const MAX_EXPERIMENTAL_CONNECTIONS = 4;

export type CoordinatorPhase = 'not-configured' | 'idle' | 'authentication-pending' | 'discovering'
  | 'degraded' | 'connecting' | 'connected' | 'retrying' | 'attention-required' | 'invalidated' | 'stopped';
export type CoordinatorFailure = 'invalid-input' | 'busy' | 'cancelled' | 'not-started' | 'not-configured'
  | 'invalidated' | 'stopped' | 'cooldown' | 'authentication' | 'discovery' | 'dependency' | 'clock-invalid';
/** Advisory metadata for discover() only. Absence never authorises automatic retry. */
export type DiscoveryRecoveryReason = 'complete' | 'incomplete' | 'transient' | 'rate-limited'
  | 'authentication' | 'permission' | 'invalid-response' | 'deadline' | 'token-expired'
  | 'cancelled' | 'invalidated' | 'stopped' | 'clock-invalid' | 'dependency' | 'not-ready';
export type DiscoveryRecovery = {
  readonly coverage: 'complete' | 'partial' | 'unknown';
} & (
  | { readonly disposition: 'retry'; readonly reason: DiscoveryRecoveryReason; readonly minimumRetryDelayMs?: number }
  | { readonly disposition: 'attention' | 'none'; readonly reason: DiscoveryRecoveryReason }
);
export type CoordinatorResult = ({ readonly ok: true } | {
  readonly ok: false; readonly reason: CoordinatorFailure; readonly retryAfterMs?: number;
}) & { readonly recovery?: DiscoveryRecovery };
/** Identifier-free snapshots. Private device observations are available only through getDevice(). */
export interface CoordinatorStatus {
  readonly phase: CoordinatorPhase;
  readonly discovery: 'never' | 'running' | 'complete' | 'degraded';
  readonly authority: 'none' | 'current' | 'last-known';
  readonly devices: number;
  /** Independent of production connectivity; cleared when a subsequent plan fits the budget. */
  readonly experimentalAdmission?: 'resource-limit';
  readonly retryAfterMs?: number;
  readonly reason?: CoordinatorFailure;
  readonly connections: readonly { readonly lane: 'production' | 'experimental'; readonly status: MqttLifecycleStatus }[];
}
export interface AccountCoordinatorOptions {
  readonly authClient?: AuthClient;
  readonly discoveryClient?: DiscoveryClient;
  /** Trusted inert factory; callbacks must not begin until start(). */
  readonly lifecycleFactory?: (options: MqttLifecycleOptions) => MqttLifecycle;
  readonly policy?: CompatibilityPolicy;
  readonly onStatus?: (status: CoordinatorStatus) => void;
  readonly clock?: TokenClock;
  readonly scheduler?: TokenScheduler;
}
export interface AccountCoordinator {
  /** Inert. Identical credentials are a no-op; terminal authentication needs deliberate clear first. */
  setCredentials(credentials: AuthCredentials): CoordinatorResult;
  /** Explicit policy update can revoke existing routes, but never grants from an old snapshot. */
  setPolicy(policy?: CompatibilityPolicy): CoordinatorResult;
  /** Non-blocking, idempotent per context; initiates one discovery. No periodic discovery. */
  start(): CoordinatorResult;
  /** Concurrent callers share a run; caller abort cancels only its own wait. */
  discover(options?: { readonly signal?: AbortSignal }): Promise<CoordinatorResult>;
  getStatus(): CoordinatorStatus;
  getDevice(routeId: string, lane?: 'production' | 'experimental', nowMs?: number): DeviceObservation | undefined;
  /** Revokes context before clearing tokens; both token and discovery cooldowns survive. */
  clear(): void;
  /** Terminal for current context; deliberate clear + credential supply can reauthorise. */
  invalidate(): void;
  /** Permanent and idempotent. */
  stop(): void;
}
