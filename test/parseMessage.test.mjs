import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { TextEncoder } from 'node:util';

import { parseMessage } from '../dist/toniebox/parseMessage.js';

const root = 'external/toniebox/synthetic-box-a/';
const parse = (topic, value) => parseMessage(root + topic, JSON.stringify(value));
function value(topic, payload) {
  const result = parse(topic, payload);
  assert.equal(result.kind, 'parsed');
  assert.equal(result.message.macAddress, 'SYNTHETIC-BOX-A');
  assert.equal(result.message.topic, topic);
  return result.message.value;
}

test('all seven documented topics normalise synthetic payloads with explicit units', () => {
  const cases = [
    ['metrics/battery', { percent: 64, raw: 68, current: -0.265, status: 'discharging' },
      { percent: 64, raw: 68, current: -0.265, status: 'discharging' }],
    ['online-state', { onlineState: 'connected' }, { onlineState: 'connected' }],
    ['metrics/headphones', { speaker: { output: true }, connected: [] }, { speakerOutput: true, connectedCount: 0 }],
    ['playback/state', {
      tonie: 'SYNTHETIC_CONTENT_A', contentVersion: 1759218085, chapter: 10,
      chapterDuration: 441.566, chapterUntilMs: 1791608996652, paused: false,
      blocked: false, downloading: false, ended: false,
    }, {
      tonie: 'SYNTHETIC_CONTENT_A', contentVersion: 1759218085, chapter: 10,
      chapterDurationSeconds: 441.566, chapterUntilMs: 1791608996652, paused: false,
      blocked: false, downloading: false, ended: false,
    }],
    ['volume/state', { level: 9, hardwarePercentage: 70 }, { level: 9, hardwarePercentage: 70 }],
    ['app-reply/bedtime-state', { stl: { state: 'on', duration: 3600, defaultDuration: 3600, until: 1791608800 } },
      { state: 'on', durationSeconds: 3600, defaultDurationSeconds: 3600, untilEpochSeconds: 1791608800 }],
    ['settings-applied', { settingsApplied: false }, { settingsApplied: false }],
  ];
  for (const [topic, input, expected] of cases) {
    assert.deepEqual(value(topic, input), expected);
  }
});

test('topic routing is exact and does not consume commands or foreign namespaces', () => {
  for (const topic of [
    'other/toniebox/synthetic-box-a/online-state',
    root + 'online-state/extra', root + 'app-control/playback',
    root + 'future-topic', root + 'ONLINE-STATE',
  ]) {
    assert.deepEqual(parseMessage(topic, 'not JSON'), { kind: 'ignored', reason: 'unknown-topic' });
  }
  for (const topic of [
    'external/toniebox/synthetic-box-a', 'external/toniebox//online-state', 'external/toniebox/+/online-state',
    'external/toniebox/synthetic box/online-state', root + '#',
    root + 'online-state/', root + 'metrics//battery', root + 'online-state\u0000',
  ]) {
    assert.deepEqual(parseMessage(topic, '{}'), { kind: 'invalid', reason: 'invalid-topic' });
  }
});

test('string and byte payloads agree; invalid UTF-8 and JSON never expose input', () => {
  const payload = '{"onlineState":"connected"}';
  const expected = parseMessage(root + 'online-state', payload);
  assert.deepEqual(parseMessage(root + 'online-state', new TextEncoder().encode(payload)), expected);
  assert.deepEqual(parseMessage(root + 'online-state', Buffer.from(payload)), expected);
  for (const input of ['', '{', '{"SYNTHETIC_SECRET":', new Uint8Array([0xff, 0xfe])]) {
    assert.deepEqual(parseMessage(root + 'online-state', input), { kind: 'invalid', reason: 'invalid-json' });
  }
});

test('non-object JSON, unknown-only objects and empty nested state are invalid', () => {
  for (const topic of ['metrics/battery', 'online-state', 'metrics/headphones', 'playback/state',
    'volume/state', 'app-reply/bedtime-state', 'settings-applied']) {
    for (const input of [null, [], 1, true, 'SYNTHETIC_VALUE', {}, { futureField: true }]) {
      assert.deepEqual(parse(topic, input), { kind: 'invalid', reason: 'invalid-payload' });
    }
  }
  for (const input of [{ stl: {} }, { stl: [] }, { stl: null }]) {
    assert.equal(parse('app-reply/bedtime-state', input).kind, 'invalid');
  }
});

test('invalid known fields reject the entire message without coercion', () => {
  const cases = [
    ['metrics/battery', { percent: 64, status: false }],
    ['metrics/battery', { percent: '64' }],
    ['metrics/battery', { percent: -1 }],
    ['metrics/battery', { percent: 101 }],
    ['online-state', { onlineState: null }],
    ['online-state', { onlineState: '' }],
    ['metrics/headphones', { speaker: { output: 'true' }, connected: [] }],
    ['metrics/headphones', { speaker: null }],
    ['metrics/headphones', { connected: {} }],
    ['playback/state', { tonie: 123 }],
    ['playback/state', { tonie: '' }],
    ['playback/state', { paused: 0 }],
    ['playback/state', { blocked: 'false' }],
    ['playback/state', { downloading: {} }],
    ['playback/state', { ended: 1 }],
    ['playback/state', { chapter: -1 }],
    ['playback/state', { chapter: 1.5 }],
    ['playback/state', { contentVersion: '1759218085' }],
    ['playback/state', { contentVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['playback/state', { chapterUntilMs: 1.5 }],
    ['playback/state', { chapterUntilMs: -1 }],
    ['playback/state', { chapterPositionMs: -1 }],
    ['playback/state', { chapterDuration: -0.1 }],
    ['playback/state', { chapterDuration: Number.MAX_SAFE_INTEGER }],
    ['volume/state', { level: -1 }],
    ['volume/state', { level: 1.5 }],
    ['volume/state', { hardwarePercentage: 101 }],
    ['app-reply/bedtime-state', { stl: { state: 'on', until: '1791608800' } }],
    ['app-reply/bedtime-state', { stl: { duration: -1 } }],
    ['app-reply/bedtime-state', { stl: { defaultDuration: null } }],
    ['settings-applied', { settingsApplied: 'false' }],
    ['settings-applied', { settingsApplied: 0 }],
  ];
  for (const [topic, input] of cases) {
    assert.deepEqual(parse(topic, input), { kind: 'invalid', reason: 'invalid-payload' }, topic);
  }
  assert.equal(parseMessage(root + 'metrics/battery', '{"current":1e400}').kind, 'invalid');
});

test('valid partial messages and explicit zero/false values survive', () => {
  assert.deepEqual(value('metrics/battery', { percent: 0 }), { percent: 0 });
  assert.deepEqual(value('metrics/headphones', { speaker: { output: false } }), { speakerOutput: false });
  assert.deepEqual(value('playback/state', { chapter: 0, paused: true, chapterPositionMs: 1234.5 }),
    { chapter: 0, paused: true, chapterPositionMs: 1234.5 });
  assert.deepEqual(value('volume/state', { level: 0 }), { level: 0 });
  assert.deepEqual(value('app-reply/bedtime-state', { stl: { state: 'off', defaultDuration: 3600 } }),
    { state: 'off', defaultDurationSeconds: 3600 });
  assert.deepEqual(value('settings-applied', { settingsApplied: true }), { settingsApplied: true });
});

test('Tonie removal clears contradictory old playback fields', () => {
  assert.deepEqual(value('playback/state', { tonie: null, chapter: 10, chapterDuration: 441.566, paused: false }), { tonie: null });
});

test('future values are preserved where their structure is known; unknown metadata is discarded', () => {
  assert.deepEqual(value('online-state', { onlineState: 'synthetic-future-state', extra: 1 }),
    { onlineState: 'synthetic-future-state' });
  assert.deepEqual(value('metrics/battery', { status: 'synthetic-future-status' }), { status: 'synthetic-future-status' });
  assert.deepEqual(value('app-reply/bedtime-state', { stl: { state: 'synthetic-future-state', extra: 1 } }),
    { state: 'synthetic-future-state' });
  assert.deepEqual(value('volume/state', { level: 99 }), { level: 99 });
  assert.deepEqual(value('metrics/headphones', {
    speaker: { output: false, unknown: true },
    connected: [{ name: 'SYNTHETIC_HEADPHONES', unknown: { battery: 42 } }],
  }), { speakerOutput: false, connectedCount: 1 });
  const result = value('playback/state', { tonie: 'SYNTHETIC_CONTENT_A', arbitrary: { account: 'SYNTHETIC_PRIVATE' } });
  assert.deepEqual(result, { tonie: 'SYNTHETIC_CONTENT_A' });
});

test('prototype-looking JSON keys are never copied into normalised data', () => {
  const result = parseMessage(root + 'volume/state', '{"level":9,"__proto__":{"polluted":true},"constructor":"SYNTHETIC_PRIVATE"}');
  assert.equal(result.kind, 'parsed');
  assert.deepEqual(result.message.value, { level: 9 });
  assert.equal(Object.hasOwn(result.message.value, '__proto__'), false);
  assert.equal(Object.prototype.polluted, undefined);
});
