import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import timers from 'node:timers';
import { URL } from 'node:url';

function forbidEffects(t) {
  let attempts = 0;
  t.after(() => assert.equal(attempts, 0));
  const forbidden = () => {
    attempts++; assert.fail('Platform attempted a network connection or scheduled work');
  };
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(net.Socket.prototype, 'connect', forbidden);
  t.mock.method(dgram, 'createSocket', forbidden);
  t.mock.method(globalThis, 'setInterval', forbidden);
  t.mock.method(globalThis, 'setTimeout', forbidden);
  t.mock.method(timers, 'setInterval', forbidden);
  t.mock.method(timers, 'setTimeout', forbidden);
}

function fakeApi(t) {
  const api = new EventEmitter();
  let attempts = 0;
  t.after(() => assert.equal(attempts, 0));
  const forbidden = () => {
    attempts++; assert.fail('Platform attempted accessory operations');
  };
  api.platformAccessory = forbidden;
  api.registerPlatformAccessories = forbidden;
  api.updatePlatformAccessories = forbidden;
  api.unregisterPlatformAccessories = forbidden;
  api.publishExternalAccessories = forbidden;
  Object.defineProperty(api, 'hap', { get: forbidden });
  return api;
}

function fakeLogger() {
  const entries = [];
  const log = (...args) => entries.push(args);
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) {
    log[level] = log;
  }
  return { log, entries };
}

test('entry point registers the package and schema identities without starting work', async (t) => {
  forbidEffects(t);
  const { default: register } = await import('../dist/index.js');
  const { TonieboxPlatform } = await import('../dist/platform.js');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
  const calls = [];
  register({ registerPlatform: (...args) => calls.push(args) });

  assert.equal(pkg.name, 'homebridge-toniebox');
  assert.equal(schema.pluginAlias, 'Toniebox');
  assert.equal(schema.singular, true);
  assert.equal(schema.schema.properties.password.format, 'password');
  assert.equal(schema.schema.properties.username.type, 'string');
  assert.deepEqual(schema.schema.required, ['name']);
  assert.deepEqual(calls, [[pkg.name, schema.pluginAlias, TonieboxPlatform]]);
});

test('startup delegates once after launch and remains private with synthetic backend', async (t) => {
  forbidEffects(t);
  const { TonieboxPlatform } = await import('../dist/platform.js');
  const { log, entries } = fakeLogger();
  const api = fakeApi(t);
  const config = Object.freeze({
    platform: 'Toniebox',
    name: 'SYNTHETIC_PRIVATE_DEVICE_NAME',
    username: 'SYNTHETIC_ACCOUNT',
    password: 'SYNTHETIC_PASSWORD',
    accessToken: 'SYNTHETIC_ACCESS_TOKEN',
    refreshToken: 'SYNTHETIC_REFRESH_TOKEN',
  });

  const calls = [];
  new TonieboxPlatform(log, config, api, { coordinatorFactory: () => {
    calls.push('create'); return {
      setCredentials: () => {
        calls.push('credentials'); return { ok: true };
      },
      start: () => {
        calls.push('start'); return { ok: true };
      },
      discover: () => {
        calls.push('discover'); return Promise.resolve({ ok: true });
      },
      stop: () => {
        calls.push('stop');
      },
    };
  } });
  assert.deepEqual(calls, []);
  api.emit('didFinishLaunching');
  api.emit('shutdown');

  api.emit('didFinishLaunching'); api.emit('shutdown');
  assert.deepEqual(calls, ['create', 'credentials', 'start', 'discover', 'stop']);
  assert.ok(entries.length > 0, 'Backend lifecycle status should be visible');
  const output = JSON.stringify(entries);
  for (const value of Object.values(config).filter(value => value.startsWith('SYNTHETIC_'))) {
    assert.equal(output.includes(value), false, 'Configuration data must not appear in logs');
  }
});

test('restored accessories are neither changed, deleted nor logged', async (t) => {
  forbidEffects(t);
  const { TonieboxPlatform } = await import('../dist/platform.js');
  const { log, entries } = fakeLogger();
  const api = fakeApi(t);
  const accessory = Object.freeze({
    UUID: 'SYNTHETIC_PRIVATE_BOX_UUID',
    displayName: 'SYNTHETIC_PRIVATE_ACCESSORY_NAME',
    context: Object.freeze({ device: Object.freeze({ id: 'SYNTHETIC_PRIVATE_DEVICE_ID' }) }),
    services: Object.freeze([]),
  });
  const before = JSON.stringify(accessory);
  const platform = new TonieboxPlatform(log, { platform: 'Toniebox', name: 'Test' }, api);
  const logCount = entries.length;

  platform.configureAccessory(accessory);
  platform.configureAccessory(accessory);
  assert.equal(entries.length, logCount);
  api.emit('didFinishLaunching');
  api.emit('shutdown');
  assert.equal(JSON.stringify(accessory), before);
  assert.doesNotMatch(JSON.stringify(entries), /SYNTHETIC/);
});
