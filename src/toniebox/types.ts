/** Runtime identifiers are private data. Never log these objects wholesale. */
export interface DeviceIdentity {
  readonly id: string;
  readonly macAddress?: string;
  readonly name?: string;
  readonly product?: string;
  readonly generation?: string;
  /** Undefined means undiscovered, not an empty capability set. */
  readonly features?: readonly string[];
}

export interface Battery {
  readonly percent?: number;
  readonly raw?: number;
  readonly current?: number;
  readonly status?: string;
}

export interface Headphones {
  readonly speakerOutput?: boolean;
  /** Entry count only; connected headphone metadata is not characterised. */
  readonly connectedCount?: number;
}

export interface Playback {
  readonly tonie?: string | null;
  readonly paused?: boolean;
  readonly blocked?: boolean;
  readonly downloading?: boolean;
  readonly ended?: boolean;
  readonly contentVersion?: number;
  readonly chapter?: number;
  readonly chapterDurationSeconds?: number;
  readonly chapterUntilMs?: number;
  readonly chapterPositionMs?: number;
}

export interface Bedtime {
  readonly state?: string;
  readonly durationSeconds?: number;
  readonly defaultDurationSeconds?: number;
  readonly untilEpochSeconds?: number;
}

export interface TopicValues {
  'metrics/battery': Battery;
  'online-state': { readonly onlineState: string };
  'metrics/headphones': Headphones;
  'playback/state': Playback;
  'volume/state': { readonly level?: number; readonly hardwarePercentage?: number };
  'app-reply/bedtime-state': Bedtime;
  'settings-applied': { readonly settingsApplied: boolean };
}

export type Topic = keyof TopicValues;
export type StateTopic = Exclude<Topic, 'settings-applied'>;
export type ParsedMessage = {
  [K in Topic]: { readonly macAddress: string; readonly topic: K; readonly value: TopicValues[K] };
}[Topic];

export type ParseResult =
  | { readonly kind: 'parsed'; readonly message: ParsedMessage }
  | { readonly kind: 'ignored'; readonly reason: 'unknown-topic' }
  | { readonly kind: 'invalid'; readonly reason: 'invalid-topic' | 'invalid-json' | 'invalid-payload' };

/** Receipt time is not the device publication time, especially for retained data. */
export interface Delivery {
  readonly receivedAtMs: number;
  readonly retained: boolean;
  readonly session: number;
}

export interface TopicSnapshot<T> extends Delivery {
  readonly value: T;
}

/** The coordinator must increment session for each newly established connection. */
export interface TransportContext {
  readonly status: 'unknown' | 'connected' | 'disconnected';
  readonly session: number;
}

export interface DeviceState {
  readonly identity: DeviceIdentity & { readonly macAddress: string };
  readonly topics: { readonly [K in StateTopic]?: TopicSnapshot<TopicValues[K]> };
  /** Last application-status event, never persistent device configuration. */
  readonly settingsEvent?: TopicSnapshot<TopicValues['settings-applied']>;
  /** A non-connected report invalidates earlier playback evidence without erasing it. */
  readonly playbackNeedsLiveUpdate: boolean;
}

export interface StateUpdate {
  readonly state: DeviceState;
  readonly accepted: boolean;
  /** Semantic payload change only; delivery metadata can change independently. */
  readonly changed: boolean;
}
