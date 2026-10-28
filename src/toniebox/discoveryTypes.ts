import type { DeviceIdentity } from './types.js';

/** Private runtime data. Neither identities nor successful results are safe to log wholesale. */
export interface AccountIdentity {
  readonly id: string;
  /** Records the selected field; does not assert uuid/id equivalence. */
  readonly identitySource: 'uuid' | 'id';
}

export interface HouseholdIdentity {
  readonly id: string;
  readonly name?: string;
}

export interface DiscoveredToniebox extends DeviceIdentity {
  readonly householdId?: string;
  readonly itemId?: string;
  /** Shared normalised MAC under different cloud IDs; do not automatically route this device. */
  readonly routingAmbiguous?: true;
}

/** Counts describe only this response. No claim of account-wide enumeration completeness. */
export interface DiscoveryDiagnostics {
  readonly rejectedEntries: number;
  /** Accepted records with omitted malformed optional metadata. */
  readonly degradedEntries: number;
  /** Subset of rejectedEntries: all records in duplicate identity groups. */
  readonly duplicateEntries: number;
  /** Returned devices sharing a normalised MAC with another valid cloud identity. */
  readonly ambiguousRoutingEntries: number;
  /** Recognised continuation evidence; false does not prove pagination is absent. */
  readonly continuationDetected: boolean;
}

export type DiscoveryFailureKind =
  | 'invalid-input' | 'cancelled' | 'timeout' | 'transport' | 'invalid-response'
  | 'unauthorized' | 'forbidden' | 'rate-limited' | 'http';

export interface DiscoveryFailure {
  readonly kind: DiscoveryFailureKind;
  readonly status?: number;
  /** Valid Retry-After on 429/503, converted to milliseconds; never a raw header. */
  readonly retryAfterMs?: number;
}

export type DiscoveryResult<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: DiscoveryDiagnostics }
  | { readonly ok: false; readonly error: DiscoveryFailure };

export interface DiscoveryRequestOptions {
  readonly signal?: AbortSignal;
}

export interface DiscoveryClientOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Positive integer milliseconds, at most 2^31 - 1; defaults to 15 seconds. */
  readonly timeoutMs?: number;
  /** Wall clock used only to interpret HTTP-date Retry-After; injectable for offline tests. */
  readonly now?: () => number;
}

export interface DiscoveryClient {
  getAccount(accessToken: string, options?: DiscoveryRequestOptions): Promise<DiscoveryResult<AccountIdentity>>;
  getHouseholds(accessToken: string, options?: DiscoveryRequestOptions): Promise<DiscoveryResult<readonly HouseholdIdentity[]>>;
  getTonieboxes(
    accessToken: string, householdId: string, options?: DiscoveryRequestOptions,
  ): Promise<DiscoveryResult<readonly DiscoveredToniebox[]>>;
}