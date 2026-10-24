import type { Battery, Bedtime, Headphones, ParseResult, Playback, TopicValues } from './types.js';

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText: Check = value => typeof value === 'string' && value.trim().length > 0;
const isBoolean: Check = value => typeof value === 'boolean';
const isFiniteNumber: Check = value => typeof value === 'number' && Number.isFinite(value);
const isNonNegative: Check = value => isFiniteNumber(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER;
const isInteger: Check = value => Number.isSafeInteger(value) && (value as number) >= 0;
const isPercentage: Check = value => isNonNegative(value) && (value as number) <= 100;
const isSeconds: Check = value => isNonNegative(value) && (value as number) <= Number.MAX_SAFE_INTEGER / 1000;

/** Copy only validated known fields. Missing fields are not filled from earlier messages. */
function fields<T extends object>(
  input: ObjectValue,
  rules: { [K in keyof T]-?: readonly [string, Check] },
): T | undefined {
  const result: Partial<T> = {};
  for (const key of Object.keys(rules) as (keyof T)[]) {
    const [wireKey, check] = rules[key];
    if (Object.hasOwn(input, wireKey)) {
      const value = input[wireKey];
      if (!check(value)) {
        return undefined;
      }
      result[key] = value as T[typeof key];
    }
  }
  return Object.keys(result).length > 0 ? result as T : undefined;
}

function headphones(input: ObjectValue): Headphones | undefined {
  const value: { speakerOutput?: boolean; connectedCount?: number } = {};
  if (Object.hasOwn(input, 'speaker')) {
    if (!isObject(input.speaker)) {
      return undefined;
    }
    if (Object.hasOwn(input.speaker, 'output')) {
      if (typeof input.speaker.output !== 'boolean') {
        return undefined;
      }
      value.speakerOutput = input.speaker.output;
    }
  }
  if (Object.hasOwn(input, 'connected')) {
    if (!Array.isArray(input.connected)) {
      return undefined;
    }
    value.connectedCount = input.connected.length;
  }
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Pure protocol boundary: no logging, I/O, credentials or MQTT.js dependency. */
export function parseMessage(topic: string, payload: string | Uint8Array): ParseResult {
  const parts = topic.split('/');
  if (parts[0] !== 'external' || parts[1] !== 'toniebox') {
    return { kind: 'ignored', reason: 'unknown-topic' };
  }
  if (parts.length < 4 || !parts[2] || topic.includes('\0') || !/^[^\s/+#]+$/u.test(parts[2])
    || parts.slice(3).some(part => !part || /[+#]/u.test(part))) {
    return { kind: 'invalid', reason: 'invalid-topic' };
  }
  const suffix = parts.slice(3).join('/');
  const known = ['metrics/battery', 'online-state', 'metrics/headphones', 'playback/state',
    'volume/state', 'app-reply/bedtime-state', 'settings-applied'];
  if (!known.includes(suffix)) {
    return { kind: 'ignored', reason: 'unknown-topic' };
  }

  let raw: unknown;
  try {
    const json = typeof payload === 'string' ? payload : new TextDecoder('utf-8', { fatal: true }).decode(payload);
    raw = JSON.parse(json);
  } catch {
    // JSON exception text can contain private payload data.
    return { kind: 'invalid', reason: 'invalid-json' };
  }
  if (!isObject(raw)) {
    return { kind: 'invalid', reason: 'invalid-payload' };
  }

  const macAddress = parts[2].toUpperCase();
  switch (suffix) {
  case 'metrics/battery': {
    const value = fields<Battery>(raw, {
      percent: ['percent', isPercentage],
      raw: ['raw', isFiniteNumber],
      current: ['current', isFiniteNumber],
      status: ['status', isText],
    });
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value } };
    }
    break;
  }
  case 'online-state': {
    const value = fields<TopicValues['online-state']>(raw, { onlineState: ['onlineState', isText] });
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value } };
    }
    break;
  }
  case 'metrics/headphones': {
    const value = headphones(raw);
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value } };
    }
    break;
  }
  case 'playback/state': {
    const value = fields<Playback>(raw, {
      tonie: ['tonie', value => value === null || isText(value)],
      paused: ['paused', isBoolean],
      // Boolean forms are supported; other representations are not guessed.
      blocked: ['blocked', isBoolean],
      downloading: ['downloading', isBoolean],
      ended: ['ended', isBoolean],
      contentVersion: ['contentVersion', isInteger],
      chapter: ['chapter', isInteger],
      chapterDurationSeconds: ['chapterDuration', isSeconds],
      chapterUntilMs: ['chapterUntilMs', isInteger],
      chapterPositionMs: ['chapterPositionMs', isNonNegative],
    });
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value: value.tonie === null ? { tonie: null } : value } };
    }
    break;
  }
  case 'volume/state': {
    const value = fields<TopicValues['volume/state']>(raw, {
      level: ['level', isInteger],
      hardwarePercentage: ['hardwarePercentage', isPercentage],
    });
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value } };
    }
    break;
  }
  case 'app-reply/bedtime-state': {
    const value = isObject(raw.stl) ? fields<Bedtime>(raw.stl, {
      state: ['state', isText],
      durationSeconds: ['duration', isSeconds],
      defaultDurationSeconds: ['defaultDuration', isSeconds],
      untilEpochSeconds: ['until', value => isInteger(value) && isSeconds(value)],
    }) : undefined;
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value } };
    }
    break;
  }
  case 'settings-applied': {
    const value = fields<TopicValues['settings-applied']>(raw, { settingsApplied: ['settingsApplied', isBoolean] });
    if (value) {
      return { kind: 'parsed', message: { macAddress, topic: suffix, value } };
    }
    break;
  }
  }
  return { kind: 'invalid', reason: 'invalid-payload' };
}
