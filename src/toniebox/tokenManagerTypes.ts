import type { AuthClient, AuthCredentials, AuthFailure } from './authTypes.js';

export interface TokenClock {
  now(): { readonly monotonicMs: number; readonly wallMs: number };
}

/** Schedule asynchronously once; return an idempotent cancellation function. */
export interface TokenScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface TokenManagerOptions {
  readonly authClient: AuthClient;
  readonly clock?: TokenClock;
  readonly scheduler?: TokenScheduler;
}

export type TokenManagerFailureKind =
  | 'invalid-input' | 'cancelled' | 'invalidated' | 'stopped' | 'credentials-required'
  | 'reauthorization-required' | 'backoff' | 'authentication-failed'
  | 'rate-limited' | 'refresh-recovery-exhausted' | 'insufficient-lifetime' | 'clock-invalid';

export interface TokenManagerFailure {
  readonly kind: TokenManagerFailureKind;
  readonly retryAfterMs?: number;
  /** Reconstructed, allowlisted metadata only; never an exception or server body. */
  readonly authFailure?: AuthFailure;
}

export type CredentialUpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: TokenManagerFailure };

export type AccessTokenResult =
  | {
      readonly ok: true;
      /** Secret for explicit consumers only. Never log this result wholesale. */
      readonly accessToken: string;
      readonly tokenType: 'Bearer';
      readonly remainingLifetimeMs: number;
      /** Present on real-manager successes. Optional here for defensive discovery projections. */
      readonly revision?: number;
    }
  | { readonly ok: false; readonly error: TokenManagerFailure };

/** Mandatory revision on the real manager/provider contract; discovery keeps its existing projection type. */
export type RevisionAccessTokenResult = Extract<AccessTokenResult, { ok: false }>
  | (Extract<AccessTokenResult, { ok: true }> & { readonly revision: number });

export interface TokenManagerStatus {
  readonly access: 'unavailable' | 'usable' | 'expiring' | 'expired';
  readonly operation: 'idle' | 'login' | 'refresh';
  readonly renewal: 'ready' | 'backoff' | 'attention-required' | 'stopped';
  readonly accessRemainingMs?: number;
  readonly retryAfterMs?: number;
  readonly reason?: TokenManagerFailureKind;
  readonly authFailure?: AuthFailure;
}

/** Non-secret observation. A subscription belongs to the current credential context. */
export interface CredentialSnapshot {
  readonly revision?: number;
  readonly status: TokenManagerStatus;
  readonly grant?: {
    readonly kind: 'login' | 'refresh';
    readonly outcome: 'success' | 'failure';
    readonly accessChanged?: boolean;
  };
}

export interface TokenManager {
  /** Inert; identical active credentials are a no-op. Terminal attention requires clear first. */
  setCredentials(credentials: AuthCredentials): CredentialUpdateResult;
  getAccessToken(options?: { readonly signal?: AbortSignal }): Promise<RevisionAccessTokenResult>;
  /** No requests. Returned metadata contains no credentials or token values. */
  getStatus(): TokenManagerStatus;
  /** Deferred, coalesced, observational only. Reset/stop and abort unsubscribe permanently. */
  observeCredentials(observer: (snapshot: CredentialSnapshot) => void,
    options?: { readonly signal?: AbortSignal }): () => void;
  /** Explicit operator reset. Removes secrets but preserves any dispatch cooldown. */
  clear(): void;
  /** Terminal, idempotent shutdown. */
  stop(): void;
}
