import type { DiscoveredObservation, DiscoveryRunResult } from './discoveryRunnerTypes.js';
import type { MqttRoute } from './mqttTransportTypes.js';
import type { DeviceIdentity, Topic } from './types.js';

export type DeviceFamily = 'toniebox-1' | 'toniebox-2' | 'toniebox-lite' | 'unknown';
export type CompatibilityKind = 'provisional' | 'unknown' | 'beta-candidate' | 'experimental' | 'validated' | 'unsupported';

/**
 * Trusted, explicitly supplied evidence, never inferred from a feature string or user wildcard.
 * Selectors match exactly. A device-specific grant ALSO requires its model and generation.
 * Explicit experiments target 5A's entire seven-topic contract; each gets its own plan.
 * An experimental grant is permission to test that contract, not proof of compatibility.
 * No Classic/Lite wire identifiers are built in. Supplied evidence is not verified by this module.
 */
export interface CompatibilityRule {
  readonly product: string;
  readonly generation: string;
  readonly deviceId?: string;
  readonly requiredFeatures?: readonly string[];
  readonly family: DeviceFamily;
  readonly decision: 'beta-candidate' | 'experimental' | 'validated' | 'unsupported';
  readonly evidence: string;
  readonly protocol?: 'ici-seven-state-topics';
}
export interface CompatibilityPolicy { readonly rules: readonly CompatibilityRule[] }
export interface CompatibilityAssessment {
  readonly kind: CompatibilityKind;
  readonly family: DeviceFamily;
  readonly evidenceScope: 'none' | 'reference-device' | 'supplied-model' | 'supplied-device';
  /** Advertisement is not proof that a command or topic works. Undefined remains unknown. */
  readonly advertisedFeatures?: readonly string[];
  /** Evidence scope above applies; not a claim of live verification of this discovered device. */
  readonly evidencedStateTopics: readonly Topic[];
}

/** Private runtime observations; never send these objects to diagnostic logging. */
export interface ApprovedDeviceRoute extends MqttRoute {
  readonly householdId: string;
  readonly identity: DeviceIdentity & { readonly macAddress: string };
}
export interface ApprovedRoutePlan {
  /** Opaque authority supplied by the owner. Never use an account identifier as the context key. */
  readonly context: symbol;
  readonly accountUuid: string;
  readonly lane: 'production' | 'experimental';
  readonly routes: readonly ApprovedDeviceRoute[];
}
export type RouteExclusion =
  | 'identity-conflict' | 'household-conflict' | 'invalid-route' | 'missing-mac'
  | 'compatibility-unknown' | 'beta-candidate' | 'unsupported';
export interface ExcludedObservation {
  readonly observation: DiscoveredObservation;
  readonly reason: RouteExclusion;
}
export type RoutingAuthority = 'sufficient' | 'insufficient' | 'account-unverified' | 'invalid-evidence' | 'resource-limit';
/** Safe to log: fixed categories and counts only. */
export interface RoutingDiagnostics {
  readonly authority: RoutingAuthority;
  readonly observed: number;
  readonly excluded: number;
  readonly conflicts: number;
  readonly production: number;
  readonly experimental: number;
}
export interface RouteApproval {
  readonly authority: RoutingAuthority;
  /** An empty production plan is valid policy output, never a reason to construct a 5B lifecycle. */
  readonly production?: ApprovedRoutePlan;
  /** One explicitly authorised device per experimental connection; never mixed with production. */
  readonly experimental: readonly ApprovedRoutePlan[];
  readonly observations: readonly DiscoveredObservation[];
  readonly excluded: readonly ExcludedObservation[];
  readonly diagnostics: RoutingDiagnostics;
}
export interface Reconciliation {
  readonly action: 'retain' | 'replace' | 'withdraw' | 'none';
  readonly authority: 'current' | 'last-known' | 'revoked';
  readonly reason: 'complete' | 'incomplete' | 'conflict' | 'account-changed' | 'invalidated' | 'resource-limit';
  readonly plan?: ApprovedRoutePlan;
}
/** Explicit inputs, no catalogue, network, timers or hidden reconciliation history. */
export interface ReconcileInput {
  readonly previous?: ApprovedRoutePlan;
  readonly discovery: DiscoveryRunResult;
  /** Undefined means the owner has revoked account authority. */
  readonly context?: symbol;
  readonly policy?: CompatibilityPolicy;
}
