import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMessage } from '../dist/toniebox/parseMessage.js';
import {
  applyMessage, createDeviceState, playbackActivity, playbackPositionMs, sleepRemainingMs, snapshotFreshness,
} from '../dist/toniebox/state.js';

const connected = { status: 'connected', session: 1 };
const identity = { id: 'SYNTHETIC_BOX_A', macAddress: 'synthetic-box-a', product: 'synthetic-model', generation: 'synthetic-generation' };
const playing = {
  tonie: 'SYNTHETIC_CONTENT_A', contentVersion: 1759218085, chapter: 0,
  chapterDuration: 441.566, chapterUntilMs: 1791608996652, paused: false,
};
const delivery = { receivedAtMs: 1791608500000, retained: false, session: 1 };

function receive(state, topic, input, meta = {}, transport = connected, mac = 'synthetic-box-a') {
  return applyMessage(state, parseMessage('external/toniebox/' + mac + '/' + topic, JSON.stringify(input)), { ...delivery, ...meta }, transport);
}
function online(state = createDeviceState(identity), meta = {}, transport = connected) {
  return receive(state, 'online-state', { onlineState: 'connected' }, meta, transport).state;
}
function active() {
  return receive(online(), 'playback/state', playing).state;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

test('unknown identity/capabilities survive without inferring model behaviour', () => {
  const features = ['playbackControls', 'synthetic-future-feature'];
  const state = createDeviceState({ ...identity, features });
  features.push('later-mutation');
  assert.deepEqual(state.identity.features, ['playbackControls', 'synthetic-future-feature']);
  assert.equal(state.identity.product, 'synthetic-model');
  assert.equal(state.identity.generation, 'synthetic-generation');
  assert.equal(state.identity.macAddress, 'SYNTHETIC-BOX-A');
  assert.equal(createDeviceState(identity).identity.features, undefined);
  assert.deepEqual(createDeviceState({ ...identity, features: [] }).identity.features, []);
  assert.deepEqual(state.topics, {});
  assert.equal(state.settingsEvent, undefined);
  assert.equal(playbackActivity(state, connected), 'unknown');
  assert.equal(snapshotFreshness(undefined, connected), 'unknown');
});

test('partial snapshots replace omitted fields; content changes and removal cannot inherit chapter timing', () => {
  const initial = active();
  const partial = receive(initial, 'playback/state', { paused: true }).state;
  assert.deepEqual(partial.topics['playback/state'].value, { paused: true });
  assert.equal(playbackActivity(partial, connected), 'unknown');
  assert.equal(playbackPositionMs(partial, connected, delivery.receivedAtMs), undefined);
  const replacement = receive(initial, 'playback/state', { tonie: 'SYNTHETIC_CONTENT_B', paused: true }).state;
  assert.equal(replacement.topics['playback/state'].value.chapter, undefined);
  assert.equal(playbackPositionMs(replacement, connected, delivery.receivedAtMs), undefined);
  const removed = receive(initial, 'playback/state', { tonie: null }).state;
  assert.deepEqual(removed.topics['playback/state'].value, { tonie: null });
  assert.equal(playbackActivity(removed, connected), 'empty');
  assert.equal(initial.topics['playback/state'].value.chapter, 0);
});

test('invalid or unknown messages preserve exact previous state and freshness', () => {
  const state = freeze(active());
  for (const result of [
    parseMessage('external/toniebox/synthetic-box-a/playback/state', '{"paused":"false"}'),
    parseMessage('external/toniebox/synthetic-box-a/playback/state', ''),
    parseMessage('external/toniebox/synthetic-box-a/future-topic', '{}'),
  ]) {
    assert.deepEqual(applyMessage(state, result, delivery, connected), { state, accepted: false, changed: false });
    assert.equal(applyMessage(state, result, delivery, connected).state, state);
  }
});

test('topic updates are independent and cannot contaminate another box', () => {
  const a = freeze(active());
  const b = freeze(createDeviceState({ id: 'SYNTHETIC_BOX_B', macAddress: 'synthetic-box-b' }));
  const result = receive(a, 'metrics/battery', { percent: 64 });
  assert.equal(result.state.topics['playback/state'], a.topics['playback/state']);
  assert.equal(result.state.topics['online-state'], a.topics['online-state']);
  assert.equal(a.topics['metrics/battery'], undefined);
  assert.equal(receive(b, 'metrics/battery', { percent: 64 }).accepted, false);
  const bUpdate = receive(b, 'metrics/battery', { percent: 12 }, {}, connected, 'synthetic-box-b');
  assert.equal(bUpdate.state.topics['metrics/battery'].value.percent, 12);
  assert.equal(result.state.topics['metrics/battery'].value.percent, 64);
});

test('semantic duplicates refresh receipt metadata without a payload change', () => {
  const first = receive(createDeviceState(identity), 'volume/state', { level: 9, hardwarePercentage: 70 }, { retained: true });
  assert.equal(first.changed, true);
  const second = receive(first.state, 'volume/state', { extra: true, hardwarePercentage: 70, level: 9 }, { receivedAtMs: 1791608501000 });
  assert.equal(second.accepted, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state.topics['volume/state'].value, first.state.topics['volume/state'].value);
  assert.equal(second.state.topics['volume/state'].receivedAtMs, 1791608501000);
  assert.equal(second.state.topics['volume/state'].retained, false);
  assert.equal(receive(second.state, 'volume/state', { level: 10 }).changed, true);
  assert.equal(receive(second.state, 'volume/state', { level: 9 }).changed, true, 'Omitted percentage is a real snapshot change');
});

test('retained pairs, live online alone and live unrelated topics do not establish playback activity', () => {
  let state = online(createDeviceState(identity), { retained: true });
  state = receive(state, 'playback/state', playing, { retained: true }).state;
  assert.equal(snapshotFreshness(state.topics['playback/state'], connected), 'retained');
  assert.equal(playbackActivity(state, connected), 'unknown');
  assert.equal(playbackPositionMs(state, connected, delivery.receivedAtMs), undefined);
  state = online(state);
  state = receive(state, 'metrics/battery', { percent: 64 }).state;
  assert.equal(playbackActivity(state, connected), 'unknown');
  assert.equal(receive(state, 'playback/state', playing).changed, false);
  state = receive(state, 'playback/state', playing).state;
  assert.equal(playbackActivity(state, connected), 'playing');
});

test('a live playback update and same-session connected observation suffice in either arrival order', () => {
  const playbackFirst = receive(createDeviceState(identity), 'playback/state', playing).state;
  assert.equal(playbackActivity(playbackFirst, connected), 'unknown');
  const laterOnline = online(playbackFirst, { retained: true });
  const onlineFirst = receive(online(createDeviceState(identity), { retained: true }), 'playback/state', playing).state;
  assert.equal(playbackActivity(laterOnline, connected), 'playing');
  assert.equal(playbackActivity(onlineFirst, connected), 'playing');
});

test('unknown/non-connected online reports invalidate earlier playback evidence without erasing snapshots', () => {
  for (const report of ['offline', 'unsupported', 'synthetic-future-state']) {
    const state = active();
    const unavailable = receive(state, 'online-state', { onlineState: report }).state;
    assert.equal(unavailable.topics['online-state'].value.onlineState, report);
    assert.equal(unavailable.topics['playback/state'], state.topics['playback/state']);
    assert.equal(playbackActivity(unavailable, connected), 'unknown');
    const reconnected = online(unavailable);
    assert.equal(playbackActivity(reconnected, connected), 'unknown');
    assert.equal(playbackActivity(receive(reconnected, 'playback/state', playing).state, connected), 'playing');
  }
});

test('transport loss and new sessions preserve last-known data without resurrecting activity', () => {
  const state = freeze(active());
  const disconnected = { status: 'disconnected', session: 1 };
  const nextSession = { status: 'connected', session: 2 };
  for (const context of [disconnected, { status: 'unknown', session: 1 }, nextSession]) {
    assert.equal(snapshotFreshness(state.topics['playback/state'], context), 'last-known');
    assert.equal(playbackActivity(state, context), 'unknown');
    assert.equal(playbackPositionMs(state, context, delivery.receivedAtMs), undefined);
  }
  assert.equal(receive(state, 'volume/state', { level: 9 }, {}, disconnected).accepted, false);
  assert.equal(receive(state, 'volume/state', { level: 9 }, {}, nextSession).accepted, false);
  assert.equal(receive(state, 'volume/state', { level: 9 }, { session: 3 }, nextSession).accepted, false);
  let restored = online(state, { session: 2, retained: true }, nextSession);
  assert.equal(playbackActivity(restored, nextSession), 'unknown');
  restored = receive(restored, 'playback/state', playing, { session: 2, retained: true }, nextSession).state;
  assert.equal(playbackActivity(restored, nextSession), 'unknown');
  restored = receive(restored, 'playback/state', playing, { session: 2 }, nextSession).state;
  assert.equal(playbackActivity(restored, nextSession), 'playing');
});

test('quiet topics do not expire; delivery order is not inferred from chapter or wall-clock values', () => {
  const state = active();
  assert.equal(snapshotFreshness(state.topics['playback/state'], connected), 'observed');
  assert.equal(playbackActivity(state, connected), 'playing');
  const earlier = receive(state, 'playback/state', { ...playing, chapter: 0, chapterUntilMs: 1000 }, { receivedAtMs: 500 }).state;
  assert.equal(earlier.topics['playback/state'].value.chapterUntilMs, 1000);
  assert.equal(earlier.topics['playback/state'].receivedAtMs, 500);
  assert.equal(playbackPositionMs(state, connected, 1891608996652), 441566);
  assert.equal(playbackActivity(state, connected), 'playing', 'Elapsed deadline does not invent an ended event');
});

test('settings application is an independent transient boolean event, including duplicates', () => {
  const initial = freeze(active());
  const pending = receive(initial, 'settings-applied', { settingsApplied: false });
  assert.equal(pending.state.settingsEvent.value.settingsApplied, false);
  assert.equal(pending.state.topics, initial.topics);
  const duplicate = receive(pending.state, 'settings-applied', { settingsApplied: false });
  assert.equal(duplicate.accepted, true);
  assert.equal(duplicate.changed, false);
  const applied = receive(pending.state, 'settings-applied', { settingsApplied: true });
  assert.equal(applied.changed, true);
  assert.equal(applied.state.settingsEvent.value.settingsApplied, true);
  assert.equal(Object.hasOwn(applied.state.topics, 'settings-applied'), false);
  assert.equal(snapshotFreshness(applied.state.settingsEvent, { status: 'connected', session: 2 }), 'last-known');
});

test('playback calculations use fractional seconds and epoch milliseconds, clamp and honour exact paused positions', () => {
  const state = active();
  const end = playing.chapterUntilMs;
  assert.equal(playbackPositionMs(state, connected, end - 441566 - 100), 0);
  assert.equal(playbackPositionMs(state, connected, end - 441566 + 2500), 2500);
  assert.equal(playbackPositionMs(state, connected, end + 100), 441566);
  const paused = receive(state, 'playback/state', { ...playing, paused: true, chapterPositionMs: 1234.5 }).state;
  assert.equal(playbackActivity(paused, connected), 'paused');
  assert.equal(playbackPositionMs(paused, connected, end), 1234.5);
  assert.equal(playbackPositionMs(paused, connected, end + 10000), 1234.5);
  const beyond = receive(state, 'playback/state', { ...playing, paused: true, chapterPositionMs: 999999 }).state;
  assert.equal(playbackPositionMs(beyond, connected, end), 441566);
  for (const partial of [
    { ...playing, paused: true }, { tonie: 'SYNTHETIC_CONTENT_A', paused: false },
    { ...playing, chapterDuration: undefined }, { ...playing, chapterUntilMs: undefined },
  ]) {
    assert.equal(playbackPositionMs(receive(state, 'playback/state', partial).state, connected, end), undefined);
  }
  for (const flag of ['blocked', 'downloading', 'ended']) {
    const inactive = receive(state, 'playback/state', { ...playing, [flag]: true }).state;
    assert.equal(playbackActivity(inactive, connected), 'inactive');
    assert.equal(playbackPositionMs(inactive, connected, end), undefined);
  }
});

test('sleep countdown uses epoch seconds and does not convert expiry into an off event', () => {
  const input = { stl: { state: 'on', duration: 3600, defaultDuration: 3600, until: 1791608800 } };
  const state = receive(online(), 'app-reply/bedtime-state', input, { retained: true }).state;
  assert.equal(sleepRemainingMs(state, connected, 1791608799000), 1000);
  assert.equal(sleepRemainingMs(state, connected, 1791608801000), 0);
  assert.equal(state.topics['app-reply/bedtime-state'].value.state, 'on');
  assert.equal(sleepRemainingMs(state, { status: 'disconnected', session: 1 }, 1791608799000), undefined);
  assert.equal(sleepRemainingMs(state, { status: 'connected', session: 2 }, 1791608799000), undefined);
  for (const stl of [{ state: 'on' }, { state: 'off', defaultDuration: 3600 }, { state: 'synthetic-future-state', until: 1791608800 }]) {
    const next = receive(state, 'app-reply/bedtime-state', { stl }).state;
    assert.equal(sleepRemainingMs(next, connected, 1791608799000), undefined);
  }
});

test('invalid delivery metadata and calculation clocks cannot produce state or timing', () => {
  const state = active();
  for (const meta of [
    { session: -1 }, { session: 1.5 }, { session: NaN },
    { receivedAtMs: -1 }, { receivedAtMs: Infinity }, { receivedAtMs: 1.5 }, { retained: 'false' },
  ]) {
    const result = receive(state, 'volume/state', { level: 9 }, meta);
    assert.equal(result.state, state);
    assert.equal(result.accepted, false);
  }
  for (const now of [NaN, Infinity, -1]) {
    assert.equal(playbackPositionMs(state, connected, now), undefined);
    assert.equal(sleepRemainingMs(state, connected, now), undefined);
  }
});

test('state functions are pure and own their payload copies without scheduling or network access', (t) => {
  const forbidden = () => assert.fail('Pure state functions attempted an external effect');
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(globalThis, 'setTimeout', forbidden);
  t.mock.method(globalThis, 'setInterval', forbidden);
  const state = freeze(active());
  const result = parseMessage('external/toniebox/synthetic-box-a/volume/state', '{"level":9}');
  const meta = freeze({ ...delivery });
  const context = freeze({ ...connected });
  const before = JSON.stringify(state);
  const next = applyMessage(state, result, meta, context);
  result.message.value.level = 99;
  assert.equal(next.state.topics['volume/state'].value.level, 9);
  assert.equal(JSON.stringify(state), before);
  assert.equal(playbackActivity(state, context), 'playing');
});

test('delivery extras and duplicate hints cannot enter snapshots or suppress changed values', () => {
  const state = receive(createDeviceState(identity), 'volume/state', { level: 9 }).state;
  const next = receive(state, 'volume/state', { level: 10 }, { dup: true, privateExtra: 'SYNTHETIC_PRIVATE' });
  assert.equal(next.changed, true);
  assert.deepEqual(Object.keys(next.state.topics['volume/state']).sort(), ['receivedAtMs', 'retained', 'session', 'value']);
  assert.equal(JSON.stringify(next.state).includes('SYNTHETIC_PRIVATE'), false);
});

test('retained redelivery after live playback revokes activity even when the payload is identical', () => {
  const state = active();
  const replay = receive(state, 'playback/state', playing, { retained: true });
  assert.equal(replay.changed, false);
  assert.equal(playbackActivity(replay.state, connected), 'unknown');
  assert.equal(playbackActivity(state, connected), 'playing');
});

test('retained connected cannot undo live non-connected evidence after newer live playback', () => {
  for (const report of ['offline', 'unsupported', 'synthetic-future-state']) {
    const activities = [];
    let state = online();
    activities.push(playbackActivity(state, connected));
    state = receive(state, 'playback/state', playing).state;
    activities.push(playbackActivity(state, connected));
    state = receive(state, 'online-state', { onlineState: report }).state;
    activities.push(playbackActivity(state, connected));
    state = freeze(receive(state, 'playback/state', playing).state);
    activities.push(playbackActivity(state, connected));
    const replay = receive(state, 'online-state', { onlineState: 'connected' },
      { retained: true, receivedAtMs: delivery.receivedAtMs + 5000 });
    activities.push(playbackActivity(replay.state, connected));
    assert.deepEqual(activities, ['unknown', 'playing', 'unknown', 'unknown', 'unknown']);
    assert.deepEqual(replay, { state, accepted: false, changed: false });
    assert.equal(replay.state, state);
    assert.equal(snapshotFreshness(replay.state.topics['online-state'], connected), 'observed');
    assert.equal(playbackPositionMs(replay.state, connected, playing.chapterUntilMs), undefined);
    // A genuinely live connected update can use playback received after the non-connected report.
    assert.equal(playbackActivity(online(replay.state), connected), 'playing');
  }
});

test('same-session retained online snapshots cannot replace or relabel a live online observation', () => {
  for (const report of ['connected', 'offline', 'synthetic-future-state']) {
    const state = freeze(receive(active(), 'online-state', { onlineState: report }).state);
    for (const retainedReport of ['connected', 'offline', 'synthetic-future-state']) {
      const result = receive(state, 'online-state', { onlineState: retainedReport },
        { retained: true, receivedAtMs: delivery.receivedAtMs + 10000 });
      assert.equal(result.state, state);
      assert.equal(result.accepted, false);
      assert.equal(result.changed, false);
      assert.equal(result.state.topics['online-state'].retained, false);
      assert.equal(playbackActivity(result.state, connected), report === 'connected' ? 'playing' : 'unknown');
    }
    const liveDuplicate = receive(state, 'online-state', { onlineState: report }, { receivedAtMs: delivery.receivedAtMs + 1 });
    assert.equal(liveDuplicate.accepted, true);
    assert.equal(liveDuplicate.changed, false);
    assert.equal(liveDuplicate.state.topics['online-state'].receivedAtMs, delivery.receivedAtMs + 1);
  }
});

test('intervening retained online values and other topics cannot erase live non-connected evidence', () => {
  let state = receive(active(), 'online-state', { onlineState: 'offline' }).state;
  const liveOnline = state.topics['online-state'];
  for (const report of ['synthetic-future-state', 'offline', 'connected', 'connected']) {
    state = receive(state, 'online-state', { onlineState: report }, { retained: true }).state;
    state = receive(state, 'metrics/battery', { percent: 64 }, { retained: true }).state;
    state = receive(state, 'playback/state', playing).state;
    assert.equal(state.topics['online-state'], liveOnline);
    assert.equal(playbackActivity(state, connected), 'unknown');
  }
  const other = createDeviceState({ id: 'SYNTHETIC_BOX_B', macAddress: 'synthetic-box-b' });
  const initial = receive(other, 'online-state', { onlineState: 'connected' }, { retained: true }, connected, 'synthetic-box-b');
  assert.equal(initial.accepted, true);
  assert.equal(snapshotFreshness(initial.state.topics['online-state'], connected), 'retained');
  assert.equal(playbackActivity(initial.state, connected), 'unknown');
});

test('initial retained online snapshots remain replaceable until a live online observation arrives', () => {
  let state = receive(createDeviceState(identity), 'online-state', { onlineState: 'synthetic-future-state' }, { retained: true }).state;
  const retainedConnected = receive(state, 'online-state', { onlineState: 'connected' }, { retained: true });
  assert.equal(retainedConnected.accepted, true);
  state = receive(retainedConnected.state, 'playback/state', playing, { retained: true }).state;
  assert.equal(playbackActivity(state, connected), 'unknown');
  state = receive(state, 'playback/state', playing).state;
  assert.equal(playbackActivity(state, connected), 'playing');
  const liveOnline = receive(state, 'online-state', { onlineState: 'connected' });
  assert.equal(liveOnline.accepted, true);
  assert.equal(liveOnline.changed, false);
  assert.equal(snapshotFreshness(liveOnline.state.topics['online-state'], connected), 'observed');
});

test('live online precedence is session-local; reconnect still requires new-session live playback', () => {
  const previous = freeze(receive(active(), 'online-state', { onlineState: 'offline' }).state);
  const disconnected = { status: 'disconnected', session: 1 };
  const next = { status: 'connected', session: 2 };
  assert.equal(playbackActivity(previous, disconnected), 'unknown');
  assert.equal(receive(previous, 'online-state', { onlineState: 'connected' }, { retained: true }, disconnected).state, previous);
  assert.equal(receive(previous, 'online-state', { onlineState: 'connected' }, {}, next).state, previous);
  for (const playbackFirst of [false, true]) {
    let state = previous;
    if (playbackFirst) {
      state = receive(state, 'playback/state', playing, { session: 2 }, next).state;
      assert.equal(playbackActivity(state, next), 'unknown');
    }
    const initialOnline = receive(state, 'online-state', { onlineState: 'connected' }, { session: 2, retained: true }, next);
    assert.equal(initialOnline.accepted, true);
    state = initialOnline.state;
    if (!playbackFirst) {
      state = receive(state, 'playback/state', playing, { session: 2, retained: true }, next).state;
      assert.equal(playbackActivity(state, next), 'unknown');
      state = receive(state, 'playback/state', playing, { session: 2 }, next).state;
    }
    assert.equal(playbackActivity(state, next), 'playing');
    assert.equal(snapshotFreshness(previous.topics['online-state'], next), 'last-known');
    state = receive(state, 'online-state', { onlineState: 'offline' }, { session: 2 }, next).state;
    const lateOldSession = receive(state, 'online-state', { onlineState: 'connected' }, {}, next);
    assert.equal(lateOldSession.state, state);
    assert.equal(playbackActivity(online(state, { session: 2, retained: true }, next), next), 'unknown');
    state = online(state, { session: 2 }, next);
    assert.equal(playbackActivity(state, next), 'unknown', 'Live recovery does not resurrect playback predating the offline report');
    assert.equal(playbackActivity(receive(state, 'playback/state', playing, { session: 2 }, next).state, next), 'playing');
  }
});
