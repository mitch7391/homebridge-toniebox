import type { MqttFailure, MqttMessage, MqttRoute, MqttTransport, MqttTransportOptions } from './mqttTransportTypes.js';
import type { TokenManager, TokenManagerFailureKind } from './tokenManagerTypes.js';

export interface MqttLifecycleFailure {
  readonly kind: MqttFailure['kind'] | 'token' | 'insufficient-lifetime' | 'clock-invalid'
    | 'generation-exhausted' | 'invalidated' | 'stopped';
  /** Allowlisted category only; no token, account, exception or server metadata. */
  readonly tokenFailure?: TokenManagerFailureKind;
}
export interface MqttLifecycleStatus {
  readonly phase: 'idle' | 'acquiring-token' | 'connecting' | 'ready' | 'waiting-retry' | 'attention-required' | 'stopped';
  readonly connected: boolean;
  /** Present only while this connection has message-delivery authority. Instance-local. */
  readonly session?: number;
  readonly error?: MqttLifecycleFailure;
  /** Scheduled delay, not a continuously updating countdown. */
  readonly retryAfterMs?: number;
}
export interface MqttSessionMessage extends MqttMessage { readonly session: number }
export interface MqttLifecycleOptions {
  readonly tokenProvider: Pick<TokenManager, 'getAccessToken'>;
  readonly accountUuid: string;
  /** Coordinator-approved authority, copied at construction. Never inferred from discovery. */
  readonly routes: readonly MqttRoute[];
  /** Abort BEFORE changing credentials. A replacement context requires a new lifecycle. */
  readonly contextSignal: AbortSignal;
  /** Private data delivery; never a diagnostic callback. */
  readonly onMessage: (message: MqttSessionMessage) => void;
  readonly onStatus?: (status: MqttLifecycleStatus) => void;
  /** Must return a fresh, inert, single-use 5A transport. Callbacks begin only in connect(). */
  readonly transportFactory?: (options: Pick<MqttTransportOptions, 'onMessage' | 'onStatus'>) => MqttTransport;
  readonly clock?: { now(): number };
  /** Asynchronous one-shot; cancellation is idempotent. Default timer is unreferenced. */
  readonly scheduler?: { schedule(callback: () => void, delayMs: number): () => void };
  /** Finite value in [0, 1]. Jitter is +/-20%, clamped to 10–300 seconds; token backoff can extend it. */
  readonly jitter?: () => number;
}
export interface MqttLifecycle {
  /** Non-blocking and idempotent. Attention and stopped instances cannot restart. */
  start(): void;
  getStatus(): MqttLifecycleStatus;
  /** Terminal, prompt, idempotent. Never stops or clears the shared token provider. */
  stop(): void;
}
