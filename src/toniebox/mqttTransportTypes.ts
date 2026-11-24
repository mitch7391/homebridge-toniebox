import type { IClientOptions, MqttClient } from 'mqtt';
import type { Duplex } from 'node:stream';

export interface MqttRoute { readonly routeId: string; readonly macAddress: string }
export interface MqttCredentials { readonly uuid: string; readonly accessToken: string }
export interface MqttMessage {
  readonly routeId: string;
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly retained: boolean;
  readonly qos: 0 | 1;
  readonly duplicate: boolean;
  readonly receivedAtMs: number;
}
export interface MqttFailure {
  readonly kind: 'invalid-input' | 'closed' | 'cancelled' | 'timeout' | 'transport' | 'protocol'
    | 'subscription-refused' | 'authentication-refused' | 'resource-limit' | 'unsafe-tracing' | 'dependency';
  readonly reasonCode?: number;
  /** Authentication refusal provenance only; never inferred from a generic error code. */
  readonly origin?: 'disconnect' | 'error';
}
export type MqttResult = { readonly ok: true } | { readonly ok: false; readonly error: MqttFailure };
export type MqttStatus = {
  readonly phase: 'idle' | 'connecting' | 'subscribing' | 'ready' | 'closed';
  readonly error?: MqttFailure;
};
export interface MqttTransportOptions {
  /** Private runtime callbacks, not diagnostic logging. No session ownership in 5A. */
  readonly onMessage: (message: MqttMessage) => void;
  readonly onStatus?: (status: MqttStatus) => void;
  readonly clock?: { now(): { monotonicMs: number; wallMs: number } };
  readonly scheduler?: { schedule(callback: () => void, delayMs: number): () => void };
  /** Trusted test seam. Production always supplies the fixed WSS stream. */
  readonly streamFactory?: () => Duplex;
  /** Trusted test seam; must remain inert until connect(). Never exposed by the adapter. */
  readonly clientFactory?: (builder: () => Duplex, options: IClientOptions) => MqttClient;
}
export type PlaybackAction = 'play' | 'pause';
export type PlaybackPublishFailure = 'invalid-input' | 'not-authorised' | 'not-ready' | 'capacity'
  | 'closed' | 'interrupted' | 'cancelled' | 'timeout' | 'invalid-acknowledgement'
  | 'no-subscribers' | 'broker-refused' | 'publish-error' | 'unsafe-tracing' | 'dependency';
/** Broker acceptance only, never physical execution. "uncertain" includes any call into publish(). */
export type PlaybackPublishResult = { readonly ok: true; readonly acknowledgement: 'broker' } | {
  readonly ok: false;
  readonly reason: PlaybackPublishFailure;
  readonly delivery: 'not-dispatched' | 'uncertain';
};
export interface MqttConnectOptions {
  readonly signal?: AbortSignal;
  /** Explicit subset of connect() route IDs. Empty by default; copied before connecting. */
  readonly playbackRouteIds?: readonly string[];
}
export interface MqttTransport {
  connect(credentials: MqttCredentials, routes: readonly MqttRoute[], options?: MqttConnectOptions): Promise<MqttResult>;
  /** Ready-only, QoS 1, non-retained. One pending request, 3s acknowledgement deadline; no replay. */
  publishPlayback(routeId: string, action: PlaybackAction, options?: { readonly signal?: AbortSignal }): Promise<PlaybackPublishResult>;
  getStatus(): MqttStatus;
  close(): void;
}
