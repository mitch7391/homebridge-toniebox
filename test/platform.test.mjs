import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import timers from 'node:timers';
import { URL } from 'node:url';

function forbidEffects(t) {
  const forbidden = () => assert.fail('Platform foundation attempted a network connection or scheduled work');
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(net.Socket.prototype, 'connect', forbidden);
  t.mock.method(dgram, 'createSocket', forbidden);
  t.mock.method(globalThis, 'setInterval', forbidden);
  t.mock.method(globalThis, 'setTimeout', forbidden);
  t.mock.method(timers, 'setInterval', forbidden);
  t.mock.method(timers, 'setTimeout', forbidden);
}

function fakeApi() {
  const api = new EventEmitter();
  const forbidden = () => assert.fail('Platform foundation attempted to create or modify an accessory');
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
  assert.deepEqual(calls, [[pkg.name, schema.pluginAlias, TonieboxPlatform]]);
});

test('startup and lifecycle events remain offline, inert and private', async (t) => {
  forbidEffects(t);
  const { TonieboxPlatform } = await import('../dist/platform.js');
  const { log, entries } = fakeLogger();
  const api = fakeApi();
  const config = Object.freeze({
    platform: 'Toniebox',
    name: 'SYNTHETIC_PRIVATE_DEVICE_NAME',
    username: 'SYNTHETIC_ACCOUNT',
    password: 'SYNTHETIC_PASSWORD',
    accessToken: 'SYNTHETIC_ACCESS_TOKEN',
    refreshToken: 'SYNTHETIC_REFRESH_TOKEN',
  });

  new TonieboxPlatform(log, config, api);
  api.emit('didFinishLaunching');
  api.emit('shutdown');

  assert.equal(api.eventNames().length, 0);
  assert.ok(entries.length > 0, 'The inert development status should be visible');
  const output = JSON.stringify(entries);
  for (const value of Object.values(config).filter(value => value.startsWith('SYNTHETIC_'))) {
    assert.equal(output.includes(value), false, 'Configuration data must not appear in logs');
  }
});

test('restored accessories are neither changed, deleted nor logged', async (t) => {
  forbidEffects(t);
  const { TonieboxPlatform } = await import('../dist/platform.js');
  const { log, entries } = fakeLogger();
  const api = fakeApi();
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
  api.emit('didFinishLaunching');
  api.emit('shutdown');

  assert.equal(JSON.stringify(accessory), before);
  assert.equal(entries.length, logCount);
});
