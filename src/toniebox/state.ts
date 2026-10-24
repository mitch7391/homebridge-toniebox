import type { Delivery, DeviceIdentity, DeviceState, ParseResult, StateUpdate, TopicSnapshot, TransportContext } from './types.js';

export function createDeviceState(identity: DeviceIdentity & { readonly macAddress: string }): DeviceState {
  return {
    identity: {
      ...identity,
      macAddress: identity.macAddress.toUpperCase(),
      ...(identity.features === undefined ? {} : { features: [...identity.features] }),
    },
    topics: {},
    playbackNeedsLiveUpdate: true,
  };
}

function sameValue(left: object | undefined, right: object): boolean {
  if (!left) {
    return false;
  }
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length
    && entries.every(([key, value]) => Object.hasOwn(right, key) && value === right[key as keyof typeof right]);
}

/** Delivery order applies, except retained online state cannot supersede same-session live evidence. */
export function applyMessage(
  state: DeviceState,
  result: ParseResult,
  delivery: Delivery,
  transport: TransportContext,
): StateUpdate {
  const unchanged = { state, accepted: false, changed: false };
  if (result.kind !== 'parsed' || transport.status !== 'connected'
    || !Number.isSafeInteger(delivery.session) || delivery.session < 0 || delivery.session !== transport.session
    || !Number.isSafeInteger(delivery.receivedAtMs) || delivery.receivedAtMs < 0 || typeof delivery.retained !== 'boolean') {
    return unchanged;
  }
  const metadata = { receivedAtMs: delivery.receivedAtMs, retained: delivery.retained, session: delivery.session };
  const message = result.message;
  if (message.macAddress !== state.identity.macAddress) {
    return unchanged;
  }
  if (message.topic === 'settings-applied') {
    return {
      accepted: true,
      changed: !sameValue(state.settingsEvent?.value, message.value),
      state: { ...state, settingsEvent: { ...metadata, value: { ...message.value } } },
    };
  }

  const previous = state.topics[message.topic];
  // Once online state is observed live, retained history cannot supersede it in
  // this session. Receipt time cannot establish when the retained value was published.
  if (message.topic === 'online-state' && delivery.retained
    && previous?.session === delivery.session && !previous.retained) {
    return unchanged;
  }
  let playbackNeedsLiveUpdate = state.playbackNeedsLiveUpdate;
  if (message.topic === 'online-state' && message.value.onlineState !== 'connected') {
    playbackNeedsLiveUpdate = true;
  } else if (message.topic === 'playback/state') {
    playbackNeedsLiveUpdate = delivery.retained;
  }
  return {
    accepted: true,
    changed: !sameValue(previous?.value, message.value),
    state: {
      ...state,
      playbackNeedsLiveUpdate,
      topics: { ...state.topics, [message.topic]: { ...metadata, value: { ...message.value } } },
    },
  };
}

/** Delivery freshness only, not device availability. Silence does not cause automatic expiry. */
export function snapshotFreshness(
  snapshot: TopicSnapshot<unknown> | undefined,
  transport: TransportContext,
): 'unknown' | 'last-known' | 'retained' | 'observed' {
  if (!snapshot) {
    return 'unknown';
  }
  if (transport.status !== 'connected' || snapshot.session !== transport.session) {
    return 'last-known';
  }
  return snapshot.retained ? 'retained' : 'observed';
}

function currentOnline(state: DeviceState, transport: TransportContext): boolean {
  const online = state.topics['online-state'];
  return transport.status === 'connected' && online?.session === transport.session && online.value.onlineState === 'connected';
}

/**
 * A current-session non-retained playback message is required, plus a connected
 * online observation in that session. Retained pairs and unrelated live topics
 * cannot establish activity. This is a conservative estimate, not a liveness guarantee.
 */
export function playbackActivity(
  state: DeviceState,
  transport: TransportContext,
): 'unknown' | 'empty' | 'paused' | 'playing' | 'inactive' {
  const snapshot = state.topics['playback/state'];
  if (!currentOnline(state, transport) || state.playbackNeedsLiveUpdate
    || snapshotFreshness(snapshot, transport) !== 'observed' || !snapshot) {
    return 'unknown';
  }
  const value = snapshot.value;
  if (value.tonie === null) {
    return 'empty';
  }
  if (!value.tonie) {
    return 'unknown';
  }
  if (value.blocked === true || value.downloading === true || value.ended === true) {
    return 'inactive';
  }
  if (value.paused === true) {
    return 'paused';
  }
  return value.paused === false ? 'playing' : 'unknown';
}

export function playbackPositionMs(state: DeviceState, transport: TransportContext, nowMs: number): number | undefined {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return undefined;
  }
  const activity = playbackActivity(state, transport);
  const value = state.topics['playback/state']?.value;
  if (!value || value.chapter === undefined || value.chapterDurationSeconds === undefined) {
    return undefined;
  }
  const durationMs = value.chapterDurationSeconds * 1000;
  let position: number;
  if (activity === 'paused' && value.chapterPositionMs !== undefined) {
    position = value.chapterPositionMs;
  } else if (activity === 'playing' && value.chapterUntilMs !== undefined) {
    position = durationMs - (value.chapterUntilMs - nowMs);
  } else {
    return undefined;
  }
  return Math.max(0, Math.min(durationMs, position));
}

/** Countdown of the reported deadline; zero does not change the reported timer state. */
export function sleepRemainingMs(state: DeviceState, transport: TransportContext, nowMs: number): number | undefined {
  const snapshot = state.topics['app-reply/bedtime-state'];
  if (!Number.isFinite(nowMs) || nowMs < 0 || !currentOnline(state, transport)
    || !snapshot || snapshot.session !== transport.session
    || snapshot.value.state !== 'on' || snapshot.value.untilEpochSeconds === undefined) {
    return undefined;
  }
  return Math.max(0, snapshot.value.untilEpochSeconds * 1000 - nowMs);
}
