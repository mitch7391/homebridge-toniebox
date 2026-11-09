import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import process from 'node:process';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import timers from 'node:timers';
import test from 'node:test';

const dependencyRoot = process.env.HOMEBRIDGE_FIXTURE_DEPENDENCIES ?? dirname(dirname(createRequire(import.meta.url).resolve('homebridge')));
assert.ok(dependencyRoot, 'Set HOMEBRIDGE_FIXTURE_DEPENDENCIES to the existing homebridge package directory.');
const immediate = timers.setImmediate;

test('synthetic presentation fixture (real installed HAP, no servers)', async t => {
  let attempts = 0;
  const forbidden = () => {
    attempts++; throw new Error('Forbidden offline side effect');
  };
  for (const [object, method] of [
    [globalThis, 'fetch'], [net.Socket.prototype, 'connect'], [net.Server.prototype, 'listen'],
    [tls, 'connect'], [dgram, 'createSocket'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [globalThis, 'setInterval'], [timers, 'setInterval'],
  ]) {
    t.mock.method(object, method, forbidden);
  }
  // Real HAP construction debounces configuration for one second, even before publication.
  // Execute this library-only work under explicit control; never wait on wall-clock time.
  const scheduled = new Map();
  const schedule = (callback, delay, ...args) => {
    if (delay !== 1000) {
      forbidden();
    }
    const timer = { unref() {
      return timer;
    } };
    scheduled.set(timer, () => callback(...args));
    return timer;
  };
  for (const object of [globalThis, timers]) {
    t.mock.method(object, 'setTimeout', schedule);
    t.mock.method(object, 'clearTimeout', timer => scheduled.delete(timer));
  }
  syncBuiltinESMExports();
  const rejections = [];
  const rejected = reason => rejections.push(reason);
  process.on('unhandledRejection', rejected);
  t.after(async () => {
    try {
      // Drain after all shutdowns. Any late network attempt still hits the independent guard.
      for (const [timer, callback] of scheduled) {
        scheduled.delete(timer);
        callback();
      }
      assert.equal(scheduled.size, 0);
      await new Promise(resolve => immediate(resolve));
      assert.equal(attempts, 0, 'Independent forbidden-network/polling audit');
      assert.equal(rejections.length, 0, 'No unhandled rejections');
    } finally {
      process.removeListener('unhandledRejection', rejected);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  const require = createRequire(join(dependencyRoot, 'package.json'));
  const pkg = JSON.parse(readFileSync(join(dependencyRoot, 'package.json'), 'utf8'));
  const hapPackage = pkg.dependencies['@homebridge/hap-nodejs'] ? '@homebridge/hap-nodejs' : 'hap-nodejs';
  const hapModule = await import(pathToFileURL(require.resolve(hapPackage)).href);
  const hap = hapModule.default ?? hapModule;
  const layout = existsSync(join(dependencyRoot, 'dist', 'platformAccessory.js')) ? 'dist' : 'lib';
  const { PlatformAccessory } = await import(pathToFileURL(join(dependencyRoot, layout, 'platformAccessory.js')).href);
  const { HomebridgeAPI } = await import(pathToFileURL(join(dependencyRoot, layout, 'api.js')).href);
  const { default: register, PresentationPlatform, readConfiguration, fixtureUuid, PLUGIN_NAME, PLATFORM_NAME } = await import('../index.mjs');
  const { Service: S, Characteristic: C, HAPStatus: H } = hap;
  const base = { fixtureOnly: true, scenario: 'B', playback: 'paused', battery: 'discharging', unavailable: false };
  const setup = (config = {}, options = {}) => {
    const calls = { external: [], registered: [], updated: [], removed: [], plugin: [], logs: [] };
    const api = new EventEmitter();
    Object.assign(api, {
      hap, platformAccessory: PlatformAccessory,
      user: { storagePath: () => options.storage ?? '/synthetic/toniebox-presentation-' + (config.scenario ?? 'B') },
      registerPlatform: (...args) => calls.plugin.push(args),
      publishExternalAccessories: (...args) => {
        HomebridgeAPI.prototype.publishExternalAccessories.call(api, ...args);
        calls.external.push(args); options.effect?.(api);
      },
      registerPlatformAccessories: (...args) => {
        HomebridgeAPI.prototype.registerPlatformAccessories.call(api, ...args);
        calls.registered.push(args); options.effect?.(api);
      },
      updatePlatformAccessories: (...args) => calls.updated.push(args),
      unregisterPlatformAccessories: (...args) => {
        calls.removed.push(args); forbidden();
      },
    });
    const log = { info: options.logger ?? (message => calls.logs.push(message)) };
    const platform = new PresentationPlatform(log, { ...base, ...config }, api);
    return { api, platform, calls, log, launch: () => api.emit('didFinishLaunching'),
      stop: () => api.emit('shutdown'), accessory: () => calls.external[0]?.[1][0] ?? calls.registered[0]?.[2][0] };
  };
  const read = (accessory, service, type) => accessory.getService(service).getCharacteristic(type).handleGetRequest();
  const rejects = (promise, code) => assert.rejects(promise, error => error === code);

  await t.test('entry point registers only the isolated plugin', () => {
    const f = setup(); register(f.api);
    assert.deepEqual(f.calls.plugin, [[PLUGIN_NAME, PLATFORM_NAME, PresentationPlatform]]);
    assert.equal(f.calls.registered.length + f.calls.external.length, 0);
    f.stop();
  });
  for (const scenario of ['A', 'B', 'C']) {
    await t.test('scenario ' + scenario + ' has real HAP services, required fields and a single publication', async () => {
      const f = setup({ scenario });
      assert.equal(f.calls.registered.length + f.calls.external.length, 0);
      f.launch(); f.launch();
      const a = f.accessory();
      assert.ok(a instanceof PlatformAccessory);
      assert.deepEqual(a.services.map(s => s.UUID).sort(),
        [S.AccessoryInformation.UUID, S.Battery.UUID, ...(scenario === 'C' ? [] : [S.SmartSpeaker.UUID])].sort());
      assert.equal(f.calls.external.length, scenario === 'A' ? 1 : 0);
      assert.equal(f.calls.registered.length, scenario === 'A' ? 0 : 1);
      assert.equal(a.category, scenario === 'C' ? hap.Categories.OTHER : hap.Categories.SPEAKER);
      const battery = a.getService(S.Battery);
      for (const type of [C.StatusLowBattery, C.BatteryLevel, C.ChargingState]) {
        assert.ok(battery.testCharacteristic(type));
        assert.deepEqual(battery.getCharacteristic(type).props.perms.slice().sort(), ['ev', 'pr']);
      }
      const info = a.getService(S.AccessoryInformation);
      for (const type of [C.Identify, C.Manufacturer, C.Model, C.Name, C.SerialNumber, C.FirmwareRevision]) {
        assert.ok(info.testCharacteristic(type));
      }
      if (scenario !== 'C') {
        const speaker = a.getService(S.SmartSpeaker);
        assert.equal(speaker.isPrimaryService, true);
        assert.ok(speaker.testCharacteristic(C.CurrentMediaState));
        assert.ok(speaker.testCharacteristic(C.TargetMediaState));
        assert.ok(speaker.getCharacteristic(C.TargetMediaState).props.perms.includes('pw'));
        assert.ok(speaker.testCharacteristic(C.ConfiguredName));
        for (const type of [C.Mute, C.Volume, C.AirPlayEnable]) {
          assert.equal(speaker.testCharacteristic(type), false);
        }
      } else {
        assert.equal(battery.isPrimaryService, true);
      }
      // External publication does not establish a bridged cache association.
      if (scenario === 'A') {
        assert.throws(() => PlatformAccessory.serialize(a), /missing associated platform/);
      } else {
        const saved = PlatformAccessory.serialize(a);
        assert.equal(saved.UUID, a.UUID);
        assert.doesNotThrow(() => JSON.stringify(saved));
      }
      f.stop(); f.stop(); f.launch();
      assert.equal(f.calls.registered.length + f.calls.external.length, 1);
      assert.equal(f.calls.removed.length, 0);
      assert.equal(f.api.listenerCount('didFinishLaunching'), 0);
      assert.equal(f.api.listenerCount('shutdown'), 0);
      await rejects(read(a, S.Battery, C.BatteryLevel), H.SERVICE_COMMUNICATION_FAILURE);
    });
  }
  for (const [playback, value] of [['playing', C.CurrentMediaState.PLAY], ['paused', C.CurrentMediaState.PAUSE], ['no-media', C.CurrentMediaState.STOP]]) {
    await t.test('playback ' + playback + ' remains fixed when every valid target write is rejected', async () => {
      const f = setup({ playback }); f.launch(); const a = f.accessory();
      const target = a.getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState);
      let updates = 0;
      target.on('change', () => updates++);
      for (const request of [0, 1, 2]) {
        await rejects(target.handleSetRequest(request), H.NOT_ALLOWED_IN_CURRENT_STATE);
        assert.equal(await read(a, S.SmartSpeaker, C.CurrentMediaState), value);
        assert.equal(await target.handleGetRequest(), value);
      }
      assert.equal(updates, 0);
      const name = a.getService(S.SmartSpeaker).getCharacteristic(C.ConfiguredName);
      await rejects(name.handleSetRequest('SYNTHETIC_RENAME'), H.NOT_ALLOWED_IN_CURRENT_STATE);
      assert.equal(await name.handleGetRequest(), 'Synthetic Toniebox B');
      f.stop();
      await rejects(target.handleSetRequest(0), H.SERVICE_COMMUNICATION_FAILURE);
    });
  }
  for (const [battery, percent, charging, low] of [
    ['charging', 78, C.ChargingState.CHARGING, 0],
    ['discharging', 64, C.ChargingState.NOT_CHARGING, 0],
    ['low', 12, C.ChargingState.NOT_CHARGING, 1],
  ]) {
    await t.test('battery preset ' + battery + ' is valid read-only HAP data', async () => {
      const f = setup({ battery }); f.launch(); const a = f.accessory();
      assert.equal(await read(a, S.Battery, C.BatteryLevel), percent);
      assert.equal(await read(a, S.Battery, C.ChargingState), charging);
      assert.equal(await read(a, S.Battery, C.StatusLowBattery), low);
      f.stop();
    });
  }
  for (const scenario of ['A', 'B', 'C']) {
    await t.test('unknown battery ' + scenario + ' omits optional values; required status errors instead of a normal/zero value', async () => {
      const f = setup({ scenario, battery: 'unknown' }); f.launch(); const a = f.accessory();
      assert.equal(a.getService(S.Battery).testCharacteristic(C.BatteryLevel), false);
      assert.equal(a.getService(S.Battery).testCharacteristic(C.ChargingState), false);
      await rejects(read(a, S.Battery, C.StatusLowBattery), H.SERVICE_COMMUNICATION_FAILURE);
      f.stop();
    });
    await t.test('unavailable ' + scenario + ' errors without losing static information', async () => {
      const f = setup({ scenario, unavailable: true }); f.launch(); const a = f.accessory();
      for (const type of [C.BatteryLevel, C.ChargingState, C.StatusLowBattery]) {
        await rejects(read(a, S.Battery, type), H.SERVICE_COMMUNICATION_FAILURE);
      }
      if (scenario !== 'C') {
        await rejects(read(a, S.SmartSpeaker, C.CurrentMediaState), H.SERVICE_COMMUNICATION_FAILURE);
        await rejects(read(a, S.SmartSpeaker, C.TargetMediaState), H.SERVICE_COMMUNICATION_FAILURE);
      }
      assert.equal(await read(a, S.AccessoryInformation, C.Manufacturer), 'Synthetic Fixture');
      f.stop();
    });
  }
  await t.test('UUIDs are deterministic, distinct and independent of preset', () => {
    const f = setup();
    const ids = ['A', 'B', 'C'].map(s => fixtureUuid(f.api, s));
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(ids, ['A', 'B', 'C'].map(s => fixtureUuid(f.api, s)));
    assert.throws(() => fixtureUuid(f.api, 'J'));
    f.stop();
  });
  for (const scenario of ['B', 'C']) {
    await t.test('real serialised cache ' + scenario + ' restores once and replaces stale preset values', async () => {
      const first = setup({ scenario }); first.launch();
      const serialized = PlatformAccessory.serialize(first.accessory()); first.stop();
      const restored = PlatformAccessory.deserialize(JSON.parse(JSON.stringify(serialized)));
      const f = setup({ scenario, battery: 'low', playback: 'playing' });
      f.platform.configureAccessory(restored); f.platform.configureAccessory(restored);
      f.launch(); f.launch();
      assert.equal(f.calls.registered.length, 0); assert.equal(f.calls.external.length, 0);
      assert.deepEqual(f.calls.updated, [[[restored]]]);
      assert.equal(restored.UUID, serialized.UUID);
      assert.equal(await read(restored, S.Battery, C.BatteryLevel), 12);
      assert.equal(restored.services.length, scenario === 'C' ? 2 : 3);
      f.stop();
      const unknown = setup({ scenario, battery: 'unknown' });
      const restoredAgain = PlatformAccessory.deserialize(PlatformAccessory.serialize(restored));
      unknown.platform.configureAccessory(restoredAgain); unknown.launch();
      assert.equal(restoredAgain.getService(S.Battery).testCharacteristic(C.BatteryLevel), false);
      assert.equal(restoredAgain.getService(S.Battery).testCharacteristic(C.ChargingState), false);
      await rejects(read(restoredAgain, S.Battery, C.StatusLowBattery), H.SERVICE_COMMUNICATION_FAILURE);
      unknown.stop();
    });
  }
  await t.test('external restart republishes the same deterministic identity without using bridged cache', () => {
    const a = setup({ scenario: 'A' }); a.launch(); const uuid = a.accessory().UUID; a.stop();
    const b = setup({ scenario: 'A' }); b.launch();
    assert.equal(b.accessory().UUID, uuid);
    assert.equal(b.calls.updated.length + b.calls.registered.length, 0);
    b.stop();
  });
  await t.test('cached optional media controls are removed on restoration', () => {
    const a = setup(); a.launch();
    a.accessory().getService(S.SmartSpeaker).getCharacteristic(C.Volume);
    const restored = PlatformAccessory.deserialize(PlatformAccessory.serialize(a.accessory())); a.stop();
    const b = setup(); b.platform.configureAccessory(restored); b.launch();
    assert.equal(restored.getService(S.SmartSpeaker).testCharacteristic(C.Volume), false);
    b.stop();
  });
  for (const config of [
    { fixtureOnly: false }, { scenario: 'J' }, { playback: 'buffering' }, { battery: 0 },
    { unavailable: 'false' }, { username: 'SYNTHETIC_PRIVATE' }, { password: 'SYNTHETIC_PRIVATE' },
    { playback: { private: true } },
  ]) {
    await t.test('invalid configuration fails closed: ' + Object.keys(config)[0] + ' ' + JSON.stringify(config), () => {
      const f = setup(config); f.launch(); f.stop();
      assert.equal(f.calls.registered.length + f.calls.external.length, 0);
      assert.equal(JSON.stringify(f.calls.logs).includes('SYNTHETIC_PRIVATE'), false);
      assert.equal(f.api.listenerCount('didFinishLaunching'), 0);
    });
  }
  await t.test('throwing configuration getters are contained and never logged', () => {
    const config = { ...base };
    Object.defineProperty(config, 'battery', { get() {
      throw new Error('SYNTHETIC_PRIVATE');
    } });
    assert.equal(readConfiguration(config), undefined);
    assert.equal(readConfiguration(null), undefined);
    assert.equal(readConfiguration([]), undefined);
  });
  await t.test('configuration is an immutable primitive snapshot', async () => {
    const f = setup();
    const config = { ...base };
    const snap = readConfiguration(config); config.battery = 'low';
    assert.equal(snap.battery, 'discharging'); assert.equal(Object.isFrozen(snap), true);
    f.launch(); assert.equal(await read(f.accessory(), S.Battery, C.BatteryLevel), 64); f.stop();
  });
  await t.test('wrong storage and multiple scenario platforms cannot start', () => {
    const bad = setup({}, { storage: '/production/.homebridge' }); bad.launch();
    assert.equal(bad.calls.registered.length, 0);
    const f = setup();
    new PresentationPlatform(f.log, { ...base, scenario: 'A' }, f.api);
    new PresentationPlatform(f.log, base, f.api);
    f.launch(); assert.equal(f.calls.registered.length, 1); assert.equal(f.calls.external.length, 0); f.stop();
  });
  await t.test('shutdown before launch is terminal', () => {
    const f = setup(); f.stop(); f.launch(); f.platform.start(); f.platform.stop();
    assert.equal(f.calls.registered.length, 0);
  });
  await t.test('reentrant shutdown during registration revokes getters and suppresses active log', async () => {
    const f = setup({}, { effect: api => api.emit('shutdown') }); f.launch();
    await rejects(read(f.accessory(), S.Battery, C.BatteryLevel), H.SERVICE_COMMUNICATION_FAILURE);
    assert.equal(f.calls.logs.length, 0); f.launch(); assert.equal(f.calls.registered.length, 1);
  });
  await t.test('throwing publication is terminal, sanitised and not retried', () => {
    const f = setup({}, { effect: () => {
      throw new Error('SYNTHETIC_PRIVATE');
    } });
    f.launch(); f.launch(); assert.equal(f.calls.registered.length, 1);
    assert.equal(JSON.stringify(f.calls.logs).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(f.api.listenerCount('shutdown'), 0);
  });
  for (const logger of [() => {
    throw new Error('SYNTHETIC_PRIVATE');
  }, () => Promise.reject(new Error('SYNTHETIC_PRIVATE'))]) {
    await t.test('logger failure does not disrupt terminal cleanup', async () => {
      const f = setup({}, { logger }); f.launch(); f.stop(); f.launch();
      await new Promise(resolve => immediate(resolve));
      assert.equal(f.calls.registered.length, 1);
    });
  }
  await t.test('late saved launch callback cannot revive a stopped fixture', () => {
    const f = setup(); const late = f.api.listeners('didFinishLaunching')[0];
    f.stop(); late(); assert.equal(f.calls.registered.length, 0);
  });
  await t.test('unexpected cache does not trigger removal or new registration', () => {
    const f = setup();
    f.platform.configureAccessory(new PlatformAccessory('Unrelated Synthetic', hap.uuid.generate('unrelated-synthetic')));
    f.launch(); assert.equal(f.calls.registered.length + f.calls.removed.length, 0);
  });
  await t.test('sample configurations have isolated identities, ports and only the fixture plugin', () => {
    const configs = ['A', 'B', 'C'].map(s => JSON.parse(readFileSync(new URL('../config-' + s + '.json', import.meta.url), 'utf8')));
    for (const config of configs) {
      assert.deepEqual(config.plugins, [PLUGIN_NAME]); assert.deepEqual(config.accessories, []);
      assert.equal(config.platforms.length, 1); assert.ok(readConfiguration(config.platforms[0]));
    }
    assert.equal(new Set(configs.map(c => c.ports.start)).size, 3);
    for (const config of configs) {
      assert.equal(config.ports.start, config.ports.end);
    }
    for (const field of ['username', 'port', 'pin']) {
      assert.equal(new Set(configs.map(c => c.bridge[field])).size, 3);
    }
  });
  await t.test('host-required battery characteristics remain present and unavailable', async () => {
    class RequiredBattery extends S.Battery {
      constructor(...args) {
        super(...args);
        if (!this.testCharacteristic(C.BatteryLevel)) {
          this.addCharacteristic(C.BatteryLevel);
        }
        if (!this.testCharacteristic(C.ChargingState)) {
          this.addCharacteristic(C.ChargingState);
        }
      }
    }
    const f = setup({ battery: 'unknown' });
    f.api.hap = { ...hap, Service: { ...S, Battery: RequiredBattery } };
    f.launch(); const a = f.accessory();
    for (const type of [C.BatteryLevel, C.ChargingState, C.StatusLowBattery]) {
      assert.ok(a.getService(S.Battery).testCharacteristic(type));
      await rejects(read(a, S.Battery, type), H.SERVICE_COMMUNICATION_FAILURE);
    }
    f.stop();
  });
  await t.test('Windows storage paths are accepted only for the matching scenario', () => {
    const f = setup({ scenario: 'C' }, { storage: 'C:\\Synthetic\\toniebox-presentation-C\\' });
    f.launch(); assert.equal(f.calls.registered.length, 1); f.stop();
    const bad = setup({ scenario: 'C' }, { storage: 'C:\\Synthetic\\toniebox-presentation-B' });
    bad.launch(); assert.equal(bad.calls.registered.length, 0);
  });
  await t.test('unexpected duplicate cached objects never cause another registration', () => {
    const f = setup(); f.launch();
    const serial = PlatformAccessory.serialize(f.accessory()); f.stop();
    const g = setup();
    g.platform.configureAccessory(PlatformAccessory.deserialize(serial));
    g.platform.configureAccessory(PlatformAccessory.deserialize(serial));
    g.launch(); assert.equal(g.calls.registered.length + g.calls.updated.length, 0);
    assert.equal(g.api.listenerCount('didFinishLaunching'), 0);
  });
  await t.test('listener removal failure cannot revive terminal authority', () => {
    const f = setup();
    f.api.removeListener = () => {
      throw new Error('SYNTHETIC_PRIVATE');
    };
    f.stop(); f.launch(); f.stop();
    assert.equal(f.calls.registered.length + f.calls.external.length, 0);
    assert.equal(JSON.stringify(f.calls.logs).includes('SYNTHETIC_PRIVATE'), false);
  });
  for (const scenario of ['D', 'E', 'F']) {
    await t.test('8A2 ' + scenario + ' is external with same-accessory linked Battery and isolated services', async () => {
      const f = setup({ scenario }); f.launch(); f.launch(); const a = f.accessory();
      const speaker = a.getService(S.SmartSpeaker); const battery = a.getService(S.Battery);
      assert.deepEqual(speaker.linkedServices, [battery]);
      assert.ok(a.services.includes(battery)); assert.ok(a.services.includes(speaker));
      assert.equal(speaker.isPrimaryService, true); assert.equal(battery.isPrimaryService, false);
      assert.deepEqual(a.services.map(s => s.UUID).sort(),
        [S.AccessoryInformation.UUID, S.SmartSpeaker.UUID, S.Battery.UUID, ...(scenario === 'F' ? [S.Switch.UUID] : [])].sort());
      assert.equal(f.calls.external.length, 1); assert.equal(f.calls.registered.length + f.calls.updated.length, 0);
      assert.equal(a.category, hap.Categories.SPEAKER);
      for (const type of [C.Volume, C.Mute, C.AirPlayEnable]) {
        assert.equal(speaker.testCharacteristic(type), false);
      }
      assert.equal(await read(a, S.Battery, C.BatteryLevel), 64);
      if (scenario === 'F') {
        assert.equal(a.getService(S.Switch).displayName, 'Playback');
        assert.equal(a.getService(S.Switch).isPrimaryService, false);
        assert.deepEqual(a.getService(S.Switch).getCharacteristic(C.On).props.perms.slice().sort(), ['ev', 'pr', 'pw']);
      }
      f.stop(); f.launch();
      assert.equal(f.calls.external.length, 1); assert.equal(f.calls.removed.length, 0);
      assert.equal(f.api.listenerCount('shutdown'), 0);
      await rejects(read(a, S.Battery, C.BatteryLevel), H.SERVICE_COMMUNICATION_FAILURE);
    });
    await t.test('8A2 ' + scenario + ' preserves unknown battery without fabricating percent or normal status', async () => {
      const f = setup({ scenario, battery: 'unknown' }); f.launch(); const a = f.accessory();
      assert.equal(a.getService(S.Battery).testCharacteristic(C.BatteryLevel), false);
      assert.equal(a.getService(S.Battery).testCharacteristic(C.ChargingState), false);
      await rejects(read(a, S.Battery, C.StatusLowBattery), H.SERVICE_COMMUNICATION_FAILURE); f.stop();
    });
    await t.test('8A2 ' + scenario + ' remains terminal when stopped before launch', () => {
      const f = setup({ scenario }); f.stop(); f.launch(); f.platform.start();
      assert.equal(f.calls.external.length, 0);
    });
  }
  await t.test('8A2 D media writes still reject without mutating fixed playback', async () => {
    const f = setup({ scenario: 'D' }); f.launch(); const a = f.accessory();
    const target = a.getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState);
    for (const value of [0, 1, 2]) {
      await rejects(target.handleSetRequest(value), H.NOT_ALLOWED_IN_CURRENT_STATE);
      assert.equal(await read(a, S.SmartSpeaker, C.CurrentMediaState), C.CurrentMediaState.PAUSE);
      assert.equal(await target.handleGetRequest(), C.TargetMediaState.PAUSE);
    }
    f.stop();
  });
  for (const scenario of ['E', 'F']) {
    const mediaWrite = scenario === 'E';
    const control = a => a.getService(mediaWrite ? S.SmartSpeaker : S.Switch).getCharacteristic(mediaWrite ? C.TargetMediaState : C.On);
    await t.test('8A2 ' + scenario + ' accepts only synthetic transitions with consistent reads and HAP change events', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      const current = a.getService(S.SmartSpeaker).getCharacteristic(C.CurrentMediaState);
      const target = a.getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState);
      const events = [];
      current.on('change', event => events.push(event.newValue));
      for (const [request, expected] of [[mediaWrite ? 0 : true, 0], [mediaWrite ? 1 : false, 1], [mediaWrite ? 0 : true, 0]]) {
        await control(a).handleSetRequest(request);
        assert.equal(await current.handleGetRequest(), expected);
        assert.equal(await target.handleGetRequest(), expected);
        assert.equal(current.value, expected); assert.equal(target.value, expected);
        if (!mediaWrite) {
          assert.equal(await control(a).handleGetRequest(), expected === 0);
          await rejects(target.handleSetRequest(1), H.NOT_ALLOWED_IN_CURRENT_STATE);
          assert.equal(await current.handleGetRequest(), expected);
        }
      }
      assert.deepEqual(events, [0, 1, 0]);
      assert.ok(f.calls.logs.includes(mediaWrite ? 'Synthetic media write received.' : 'Synthetic switch write received.'));
      assert.ok(f.calls.logs.includes('Synthetic transition applied: playing.'));
      f.stop();
      const logs = f.calls.logs.length;
      await rejects(control(a).handleSetRequest(mediaWrite ? 1 : false), H.SERVICE_COMMUNICATION_FAILURE);
      assert.equal(f.calls.logs.length, logs);
    });
    await t.test('8A2 ' + scenario + ' rejects malformed writes without changing state or logging supplied values', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      const invalid = mediaWrite ? ['SYNTHETIC_PRIVATE', true, null, {}, NaN, Infinity, -1, 3, 0.5] : ['SYNTHETIC_PRIVATE', 0, 1, null, {}];
      for (const value of invalid) {
        await rejects(control(a).handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
        assert.equal(await read(a, S.SmartSpeaker, C.CurrentMediaState), 1);
      }
      if (mediaWrite) {
        await rejects(control(a).handleSetRequest(2), H.NOT_ALLOWED_IN_CURRENT_STATE);
      }
      assert.doesNotMatch(JSON.stringify(f.calls.logs), /SYNTHETIC_PRIVATE/); f.stop();
    });
    for (const config of [{ unavailable: true }, { playback: 'no-media' }]) {
      await t.test('8A2 ' + scenario + ' rejects controls for ' + Object.keys(config)[0], async () => {
        const f = setup({ scenario, ...config }); f.launch(); const a = f.accessory();
        const expected = config.unavailable ? H.SERVICE_COMMUNICATION_FAILURE : H.NOT_ALLOWED_IN_CURRENT_STATE;
        await rejects(control(a).handleSetRequest(mediaWrite ? 0 : true), expected);
        if (config.unavailable || !mediaWrite) {
          await rejects(control(a).handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
        } else {
          assert.equal(await control(a).handleGetRequest(), C.TargetMediaState.STOP);
        }
        f.stop();
      });
    }
    await t.test('8A2 ' + scenario + ' shutdown during a synchronous characteristic event prevents acknowledgement', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      a.getService(S.SmartSpeaker).getCharacteristic(C.CurrentMediaState).on('change', () => f.stop());
      await rejects(control(a).handleSetRequest(mediaWrite ? 0 : true), H.SERVICE_COMMUNICATION_FAILURE);
      await rejects(read(a, S.SmartSpeaker, C.CurrentMediaState), H.SERVICE_COMMUNICATION_FAILURE);
      assert.equal(f.calls.logs.includes('Synthetic transition applied: playing.'), false);
    });
    await t.test('8A2 ' + scenario + ' contains reentrant writes and preserves the outer transition', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory(); let nested;
      a.getService(S.SmartSpeaker).getCharacteristic(C.CurrentMediaState).once('change', () => {
        nested = rejects(control(a).handleSetRequest(mediaWrite ? 1 : false), H.NOT_ALLOWED_IN_CURRENT_STATE);
      });
      await control(a).handleSetRequest(mediaWrite ? 0 : true); await nested;
      assert.equal(await read(a, S.SmartSpeaker, C.CurrentMediaState), 0); f.stop();
    });
    await t.test('8A2 ' + scenario + ' bounds synthetic write logging and contains observer failures', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      for (let i = 0; i < 30; i++) {
        await control(a).handleSetRequest(mediaWrite ? i % 2 : i % 2 === 0);
      }
      assert.equal(f.calls.logs.length, 33); // One startup notice plus 32 write notices.
      f.stop();
      const g = setup({ scenario }, { logger: () => Promise.reject(new Error('SYNTHETIC_PRIVATE')) });
      g.launch(); await control(g.accessory()).handleSetRequest(mediaWrite ? 0 : true); g.stop();
      await new Promise(resolve => immediate(resolve));
    });
  }
  for (const scenario of ['E', 'F']) {
    await t.test('8A2 ' + scenario + ' write logger cannot reenter the transition or acknowledge after shutdown', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      const control = a.getService(scenario === 'E' ? S.SmartSpeaker : S.Switch)
        .getCharacteristic(scenario === 'E' ? C.TargetMediaState : C.On);
      let nested;
      f.log.info = () => {
        nested = rejects(control.handleSetRequest(scenario === 'E' ? 1 : false), H.NOT_ALLOWED_IN_CURRENT_STATE);
      };
      await control.handleSetRequest(scenario === 'E' ? 0 : true); await nested;
      assert.equal(await read(a, S.SmartSpeaker, C.CurrentMediaState), 0);
      f.log.info = () => f.stop();
      await rejects(control.handleSetRequest(scenario === 'E' ? 1 : false), H.SERVICE_COMMUNICATION_FAILURE);
    });
  }

  await t.test('8A2 all six identities, storage suffixes, bridge/external ports and pairing codes are distinct', () => {
    const scenarios = ['A', 'B', 'C', 'D', 'E', 'F'];
    const configs = scenarios.map(s => JSON.parse(readFileSync(new URL('../config-' + s + '.json', import.meta.url), 'utf8')));
    const f = setup();
    assert.equal(new Set(scenarios.map(s => fixtureUuid(f.api, s))).size, 6);
    for (const field of ['username', 'port', 'pin']) {
      assert.equal(new Set(configs.map(c => c.bridge[field])).size, 6);
    }
    assert.equal(new Set(configs.flatMap(c => [c.bridge.port, c.ports.start])).size, 12);
    for (const [i, config] of configs.entries()) {
      assert.equal(config.platforms[0].scenario, scenarios[i]);
      assert.equal(config.platforms.length, 1); assert.deepEqual(config.plugins, [PLUGIN_NAME]);
      assert.equal(config.ports.start, config.ports.end); assert.ok(readConfiguration(config.platforms[0]));
    }
    f.stop();
  });
  await t.test('8A2 A/B/C retain their original unlinked arrangements', () => {
    for (const scenario of ['A', 'B', 'C']) {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      assert.equal(a.getService(S.Switch), undefined);
      if (scenario !== 'C') {
        assert.deepEqual(a.getService(S.SmartSpeaker).linkedServices, []);
      }
      f.stop();
    }
  });


  for (const scenario of ['G', 'H']) {
    const controls = a => ({
      current: a.getService(S.SmartSpeaker).getCharacteristic(C.CurrentMediaState),
      target: a.getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState),
      on: a.getService(S.Switch).getCharacteristic(C.On),
    });
    await t.test('8A3 ' + scenario + ' has one external speaker, linked battery and one playback switch', () => {
      const f = setup({ scenario }); f.launch(); f.launch(); const a = f.accessory();
      assert.equal(f.calls.external.length, 1);
      assert.equal(f.calls.registered.length + f.calls.updated.length, 0);
      assert.deepEqual(a.services.map(s => s.UUID).sort(), [S.AccessoryInformation.UUID, S.SmartSpeaker.UUID, S.Battery.UUID, S.Switch.UUID].sort());
      const speaker = a.getService(S.SmartSpeaker);
      assert.equal(speaker.isPrimaryService, true);
      assert.deepEqual(speaker.linkedServices, [a.getService(S.Battery)]);
      assert.ok(a.services.includes(speaker.linkedServices[0]));
      assert.equal(a.getService(S.Switch).displayName, 'Playback');
      assert.equal(a.category, hap.Categories.SPEAKER);
      assert.equal(speaker.testCharacteristic(C.AirPlayEnable), false);
      assert.equal(speaker.testCharacteristic(C.Volume), scenario === 'H');
      assert.equal(speaker.testCharacteristic(C.Mute), scenario === 'H');
      f.stop(); f.launch(); assert.equal(f.calls.external.length, 1);
      assert.equal(f.calls.removed.length, 0); assert.equal(f.api.listenerCount('shutdown'), 0);
    });
    await t.test('8A3 ' + scenario + ' both inputs synchronise all playback caches, getters and notifications', async () => {
      const f = setup({ scenario }); f.launch(); const c = controls(f.accessory());
      const events = { current: [], target: [], on: [] };
      for (const key of Object.keys(c)) {
        c[key].on('change', event => events[key].push(event.newValue));
      }
      for (const [key, value, media] of [['target', 0, 0], ['on', false, 1], ['on', true, 0], ['target', 1, 1]]) {
        await c[key].handleSetRequest(value);
        assert.deepEqual([c.current.value, c.target.value, c.on.value], [media, media, media === 0]);
        assert.deepEqual(await Promise.all([c.current.handleGetRequest(), c.target.handleGetRequest(), c.on.handleGetRequest()]), [media, media, media === 0]);
        assert.equal(events.current.at(-1), media);
        assert.equal(events.target.at(-1), media);
        assert.equal(events.on.at(-1), media === 0);
      }
      assert.deepEqual(events.current, [0, 1, 0, 1]);
      f.stop();
    });
    await t.test('8A3 ' + scenario + ' concurrent cross-interface writes cannot replay stale cached values', async () => {
      const f = setup({ scenario }); f.launch(); const c = controls(f.accessory());
      await Promise.all([c.target.handleSetRequest(0), c.on.handleSetRequest(false)]);
      assert.deepEqual([c.current.value, c.target.value, c.on.value], [1, 1, false]);
      await Promise.all([c.on.handleSetRequest(true), c.target.handleSetRequest(1)]);
      assert.deepEqual([c.current.value, c.target.value, c.on.value], [1, 1, false]);
      f.stop();
    });
    await t.test('8A3 ' + scenario + ' rejects malformed and unsupported playback without changing shared state', async () => {
      const f = setup({ scenario }); f.launch(); const c = controls(f.accessory());
      for (const value of [-1, 3, 0.5, NaN, Infinity, true, null, {}, 'SYNTHETIC_PRIVATE']) {
        await rejects(c.target.handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
      }
      for (const value of [0, 1, null, {}, 'SYNTHETIC_PRIVATE']) {
        await rejects(c.on.handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
      }
      await rejects(c.target.handleSetRequest(2), H.NOT_ALLOWED_IN_CURRENT_STATE);
      assert.deepEqual([c.current.value, c.target.value, c.on.value], [1, 1, false]);
      assert.doesNotMatch(JSON.stringify(f.calls.logs), /SYNTHETIC_PRIVATE/);
      f.stop();
    });
    for (const unavailable of [false, true]) {
      await t.test('8A3 ' + scenario + ' conservatively rejects ' + (unavailable ? 'unavailable' : 'no-media') + ' playback', async () => {
        const f = setup({ scenario, playback: 'no-media', unavailable }); f.launch(); const c = controls(f.accessory());
        await rejects(c.on.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
        const code = unavailable ? H.SERVICE_COMMUNICATION_FAILURE : H.NOT_ALLOWED_IN_CURRENT_STATE;
        await rejects(c.target.handleSetRequest(0), code); await rejects(c.on.handleSetRequest(true), code);
        if (!unavailable) {
          assert.equal(await c.current.handleGetRequest(), 2); assert.equal(await c.target.handleGetRequest(), 2);
        }
        f.stop();
      });
    }
    for (const reason of ['update', 'write']) {
      await t.test('8A3 ' + scenario + ' rejects cross-interface reentrancy during HAP ' + reason, async () => {
        const f = setup({ scenario }); f.launch(); const c = controls(f.accessory()); let nested;
        c.target.on('change', event => {
          if (event.reason === reason) {
            nested = rejects(c.on.handleSetRequest(false), H.NOT_ALLOWED_IN_CURRENT_STATE);
          }
        });
        await c.target.handleSetRequest(0); assert.ok(nested); await nested;
        assert.deepEqual([c.current.value, c.target.value, c.on.value], [0, 0, true]); f.stop();
      });
    }
    await t.test('8A3 ' + scenario + ' shutdown during transition rejects and later callbacks remain terminal', async () => {
      const f = setup({ scenario }); f.launch(); const c = controls(f.accessory());
      c.current.once('change', () => f.stop());
      await rejects(c.target.handleSetRequest(0), H.SERVICE_COMMUNICATION_FAILURE);
      await rejects(c.on.handleSetRequest(false), H.SERVICE_COMMUNICATION_FAILURE);
      for (const value of Object.values(c)) {
        await rejects(value.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
      }
      assert.equal(f.calls.logs.includes('Synthetic transition applied: playing.'), false); f.launch();
      assert.equal(f.calls.external.length, 1);
    });
    await t.test('8A3 ' + scenario + ' restart keeps identity while resetting only synthetic in-memory state', async () => {
      const f = setup({ scenario }); f.launch(); const a = f.accessory(); await controls(a).on.handleSetRequest(true); f.stop();
      const g = setup({ scenario }); g.launch(); const b = g.accessory();
      assert.equal(a.UUID, b.UUID);
      assert.equal(await read(b, S.AccessoryInformation, C.SerialNumber), 'SYNTHETIC-8A1-' + scenario);
      assert.deepEqual([controls(b).current.value, controls(b).target.value, controls(b).on.value], [1, 1, false]);
      await rejects(controls(a).on.handleSetRequest(false), H.SERVICE_COMMUNICATION_FAILURE); g.stop();
    });
    await t.test('8A3 ' + scenario + ' preserves unknown battery and rejects unexpected storage or unknown playback', async () => {
      const f = setup({ scenario, battery: 'unknown' }); f.launch(); const a = f.accessory();
      assert.equal(a.getService(S.Battery).testCharacteristic(C.BatteryLevel), false);
      await rejects(read(a, S.Battery, C.StatusLowBattery), H.SERVICE_COMMUNICATION_FAILURE); f.stop();
      const bad = setup({ scenario }, { storage: '/synthetic/toniebox-presentation-A' }); bad.launch();
      assert.equal(bad.calls.external.length, 0);
      const unknown = setup({ scenario, playback: 'unknown' }); unknown.launch();
      assert.equal(unknown.calls.external.length, 0);
      const stopped = setup({ scenario }); stopped.stop(); stopped.launch();
      assert.equal(stopped.calls.external.length, 0);
    });
  }
  const audioSetup = (config = {}, options = {}) => {
    const f = setup({ scenario: 'H', ...config }, options); f.launch(); const a = f.accessory();
    const speaker = a.getService(S.SmartSpeaker);
    return { ...f, a, volume: speaker.getCharacteristic(C.Volume), mute: speaker.getCharacteristic(C.Mute),
      target: speaker.getCharacteristic(C.TargetMediaState), on: a.getService(S.Switch).getCharacteristic(C.On) };
  };
  await t.test('8A3 H uses native HAP Volume and Mute definitions with read/write/notify', async () => {
    const f = audioSetup();
    assert.deepEqual(f.volume.props, new C.Volume().props);
    assert.deepEqual(f.mute.props, new C.Mute().props);
    assert.equal(f.volume.props.format, 'uint8'); assert.equal(f.volume.props.unit, 'percentage');
    assert.equal(f.volume.props.minValue, 0); assert.equal(f.volume.props.maxValue, 100); assert.equal(f.volume.props.minStep, 1);
    assert.equal(f.mute.props.format, 'bool');
    for (const c of [f.volume, f.mute]) {
      assert.deepEqual(c.props.perms.slice().sort(), ['ev', 'pr', 'pw']);
    }
    assert.equal(await f.volume.handleGetRequest(), 50); assert.equal(await f.mute.handleGetRequest(), false); f.stop();
  });
  await t.test('8A3 H accepts volume boundaries and emits native change notifications', async () => {
    const f = audioSetup(); const events = []; f.volume.on('change', e => events.push(e.newValue));
    for (const value of [0, 1, 37, 100, 50]) {
      await f.volume.handleSetRequest(value);
      assert.equal(f.volume.value, value); assert.equal(await f.volume.handleGetRequest(), value);
      assert.equal(events.at(-1), value); assert.equal(await f.mute.handleGetRequest(), false);
    }
    assert.deepEqual([...new Set(events)], [0, 1, 37, 100, 50]); f.stop();
  });
  await t.test('8A3 H rejects invalid volume and mute without coercion or private logs', async () => {
    const f = audioSetup();
    for (const value of [-1, 101, 1.5, NaN, Infinity, true, false, null, undefined, {}, 'SYNTHETIC_PRIVATE']) {
      await rejects(f.volume.handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
      assert.equal(await f.volume.handleGetRequest(), 50);
    }
    for (const value of [0, 1, null, undefined, {}, 'SYNTHETIC_PRIVATE']) {
      await rejects(f.mute.handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
      assert.equal(await f.mute.handleGetRequest(), false);
    }
    assert.doesNotMatch(JSON.stringify(f.calls.logs), /SYNTHETIC_PRIVATE/); f.stop();
  });
  await t.test('8A3 H mute preserves volume and playback remains independent', async () => {
    const f = audioSetup(); const events = []; f.mute.on('change', e => events.push(e.newValue));
    await f.volume.handleSetRequest(73); await f.mute.handleSetRequest(true); await f.target.handleSetRequest(0);
    assert.equal(await f.volume.handleGetRequest(), 73); assert.equal(await f.mute.handleGetRequest(), true);
    await f.volume.handleSetRequest(24);
    assert.equal(await f.mute.handleGetRequest(), true);
    await f.on.handleSetRequest(false); await f.mute.handleSetRequest(false);
    assert.equal(await f.volume.handleGetRequest(), 24);
    assert.deepEqual([f.target.value, f.on.value], [1, false]);
    assert.ok(events.includes(true)); assert.equal(events.at(-1), false); f.stop();
  });
  await t.test('8A3 H unavailable and shutdown reject all audio reads and writes', async () => {
    for (const unavailable of [true, false]) {
      const f = audioSetup({ unavailable }); if (!unavailable) {
        f.stop();
      }
      for (const [c, value] of [[f.volume, 60], [f.mute, true]]) {
        await rejects(c.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
        await rejects(c.handleSetRequest(value), H.SERVICE_COMMUNICATION_FAILURE);
      }
      f.stop();
    }
  });
  await t.test('8A3 H no-media does not fabricate playback when independent audio preferences change', async () => {
    const f = audioSetup({ playback: 'no-media' });
    await f.volume.handleSetRequest(20); await f.mute.handleSetRequest(true);
    assert.equal(await read(f.a, S.SmartSpeaker, C.CurrentMediaState), 2);
    await rejects(f.on.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
    await rejects(f.target.handleSetRequest(0), H.NOT_ALLOWED_IN_CURRENT_STATE); f.stop();
  });
  for (const field of ['volume', 'mute']) {
    await t.test('8A3 H ' + field + ' shutdown during update prevents acknowledgement', async () => {
      const f = audioSetup(); f[field].once('change', () => f.stop());
      await rejects(f[field].handleSetRequest(field === 'volume' ? 60 : true), H.SERVICE_COMMUNICATION_FAILURE);
      await rejects(f[field].handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
      assert.equal(f.calls.logs.includes('Synthetic ' + field + ' transition applied.'), false);
    });
  }
  await t.test('8A3 H shares its reentrancy guard across playback, volume, mute and logger callbacks', async () => {
    const f = audioSetup(); let nested;
    f.volume.once('change', () => {
      nested = rejects(f.on.handleSetRequest(true), H.NOT_ALLOWED_IN_CURRENT_STATE);
    });
    await f.volume.handleSetRequest(60); await nested;
    assert.equal(f.on.value, false);
    f.target.once('change', () => {
      nested = rejects(f.mute.handleSetRequest(true), H.NOT_ALLOWED_IN_CURRENT_STATE);
    });
    await f.target.handleSetRequest(0); await nested; assert.equal(f.mute.value, false);
    f.log.info = () => {
      nested = rejects(f.volume.handleSetRequest(10), H.NOT_ALLOWED_IN_CURRENT_STATE);
    };
    await f.mute.handleSetRequest(true); await nested; assert.equal(f.volume.value, 60);
    f.log.info = () => f.stop();
    await rejects(f.volume.handleSetRequest(70), H.SERVICE_COMMUNICATION_FAILURE);
  });
  await t.test('8A3 H bounded write diagnostics contain logger failures and restart restores audio defaults', async () => {
    const f = audioSetup();
    for (let i = 0; i < 40; i++) {
      await f.volume.handleSetRequest(i);
    }
    assert.equal(f.calls.logs.length, 33); f.stop();
    const g = audioSetup({}, { logger: () => Promise.reject(new Error('SYNTHETIC_PRIVATE')) });
    assert.equal(await g.volume.handleGetRequest(), 50); assert.equal(await g.mute.handleGetRequest(), false);
    await g.mute.handleSetRequest(true); g.stop(); await new Promise(resolve => immediate(resolve));
  });
  await t.test('8A3 all eight scenario identities, serials, ports and pairing configurations are distinct', async () => {
    const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']; const uuids = []; const serials = [];
    const configs = letters.map(s => JSON.parse(readFileSync(new URL('../config-' + s + '.json', import.meta.url), 'utf8')));
    for (const scenario of letters) {
      const f = setup({ scenario }); f.launch(); const a = f.accessory();
      uuids.push(a.UUID); serials.push(await read(a, S.AccessoryInformation, C.SerialNumber)); f.stop();
    }
    assert.equal(new Set(uuids).size, 8); assert.equal(new Set(serials).size, 8);
    for (const key of ['username', 'pin']) {
      assert.equal(new Set(configs.map(c => c.bridge[key])).size, 8);
    }
    assert.equal(new Set(configs.flatMap(c => [c.bridge.port, c.ports.start])).size, 16);
    for (const [i, c] of configs.entries()) {
      assert.equal(c.platforms[0].scenario, letters[i]); assert.ok(readConfiguration(c.platforms[0]));
      assert.equal(c.ports.start, c.ports.end); assert.deepEqual(c.plugins, [PLUGIN_NAME]); assert.deepEqual(c.accessories, []);
    }
  });
  await t.test('8A3 A-F configs and private package metadata retain approved byte hashes', () => {
    const hashes = {
      'config-A.json': '7ff9ae5a0e9dfb47e0d6f15186b1ee25224fbe493527792140cf11feed205ca8',
      'config-B.json': 'd7265a24fafae1421bdc5ca98eedad1fafc38746926906d3e8e682fb429568d7',
      'config-C.json': '7daec0eb3445e320bec9c0f65fd8b28d0abc3d2986daf4c48bba8b9af47de122',
      'config-D.json': 'dd3e83b9357bdb0ddac571e83d214712f4db04ea92b071f285e0fb1a404f1285',
      'config-E.json': '7739b92b1a3dd211c47bd2a430cbf59209ea038ce1d4b4b0f1a44c4d92be22de',
      'config-F.json': 'd7c3a4efedda972c06455dc1ea17480f358f3ce41c6e19099edbc8e468dc60f3',
      'package.json': '699a9362ee80e7d11e2970167a914bff9e0a4d1a06134d91d1727b168c4d31ed',
    };
    for (const [name, expected] of Object.entries(hashes)) {
      assert.equal(createHash('sha256').update(readFileSync(new URL('../' + name, import.meta.url))).digest('hex'), expected);
    }
  });


  const regularSetup = (config = {}, options = {}) => {
    const f = setup({ scenario: 'I', ...config }, options); f.launch();
    const a = f.accessory(); const speaker = a.getService(S.Speaker);
    return { ...f, a, speaker, volume: speaker.getCharacteristic(C.Volume),
      mute: speaker.getCharacteristic(C.Mute), on: a.getService(S.Switch).getCharacteristic(C.On) };
  };
  await t.test('8A4 I publishes only regular Speaker, linked Battery, Switch and information', async () => {
    const f = regularSetup(); f.launch();
    assert.deepEqual(f.a.services.map(s => s.UUID).sort(), [S.AccessoryInformation.UUID, S.Speaker.UUID, S.Battery.UUID, S.Switch.UUID].sort());
    assert.equal(f.a.getService(S.SmartSpeaker), undefined);
    assert.equal(f.speaker.isPrimaryService, true); assert.equal(f.a.category, hap.Categories.SPEAKER);
    assert.deepEqual(f.speaker.linkedServices, [f.a.getService(S.Battery)]);
    assert.ok(f.a.services.includes(f.speaker.linkedServices[0]));
    for (const type of [C.CurrentMediaState, C.TargetMediaState, C.Active, C.AirPlayEnable]) {
      assert.equal(f.speaker.testCharacteristic(type), false);
    }
    assert.ok(new S.Speaker().testCharacteristic(C.Mute));
    assert.deepEqual(f.mute.props, new C.Mute().props); assert.deepEqual(f.volume.props, new C.Volume().props);
    assert.equal(await f.volume.handleGetRequest(), 50); assert.equal(await f.on.handleGetRequest(), false);
    assert.equal(await f.mute.handleGetRequest(), false);
    assert.equal(f.calls.external.length, 1); assert.equal(f.calls.registered.length + f.calls.updated.length, 0);
    f.stop(); f.launch(); assert.equal(f.calls.external.length, 1); assert.equal(f.calls.removed.length, 0);
    assert.equal(f.api.listenerCount('shutdown'), 0);
  });
  await t.test('8A4 I rejects every mute operation without emulation or changing volume/playback', async () => {
    const f = regularSetup(); await f.volume.handleSetRequest(73); await f.on.handleSetRequest(true);
    for (const value of [true, false, 'PRIVATE', null]) {
      await rejects(f.mute.handleSetRequest(value), H.NOT_ALLOWED_IN_CURRENT_STATE);
      assert.equal(await f.mute.handleGetRequest(), false);
      assert.equal(await f.volume.handleGetRequest(), 73); assert.equal(await f.on.handleGetRequest(), true);
    }
    assert.doesNotMatch(JSON.stringify(f.calls.logs), /PRIVATE/); f.stop();
  });
  await t.test('8A4 I volume and switch writes notify independently and remain coherent concurrently', async () => {
    const f = regularSetup(); const volumes = []; const playback = [];
    f.volume.on('change', e => volumes.push(e.newValue)); f.on.on('change', e => playback.push(e.newValue));
    for (const value of [0, 100, 36]) {
      await f.volume.handleSetRequest(value);
      assert.equal(await f.volume.handleGetRequest(), value); assert.equal(volumes.at(-1), value);
      assert.equal(await f.on.handleGetRequest(), false);
    }
    await Promise.all([f.on.handleSetRequest(true), f.volume.handleSetRequest(81)]);
    assert.equal(f.on.value, true); assert.equal(f.volume.value, 81); assert.equal(playback.at(-1), true);
    await f.on.handleSetRequest(false); assert.equal(f.volume.value, 81); assert.equal(playback.at(-1), false);
    assert.equal(await f.mute.handleGetRequest(), false); f.stop();
  });
  await t.test('8A4 I rejects invalid callback values without corrupting state', async () => {
    const f = regularSetup();
    for (const value of [-1, 101, 0.5, NaN, Infinity, true, null, {}, 'PRIVATE']) {
      await rejects(f.volume.handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
    }
    for (const value of [0, 1, null, {}, 'PRIVATE']) {
      await rejects(f.on.handleSetRequest(value), H.INVALID_VALUE_IN_REQUEST);
    }
    assert.equal(await f.volume.handleGetRequest(), 50); assert.equal(await f.on.handleGetRequest(), false);
    assert.doesNotMatch(JSON.stringify(f.calls.logs), /PRIVATE/); f.stop();
  });
  for (const mode of ['discharging', 'charging', 'low', 'unknown']) {
    await t.test('8A4 I preserves battery preset ' + mode, async () => {
      const f = regularSetup({ battery: mode }); const b = f.a.getService(S.Battery);
      if (mode === 'unknown') {
        assert.equal(b.testCharacteristic(C.BatteryLevel), false);
        assert.equal(b.testCharacteristic(C.ChargingState), false);
        await rejects(read(f.a, S.Battery, C.StatusLowBattery), H.SERVICE_COMMUNICATION_FAILURE);
      } else {
        assert.equal(await read(f.a, S.Battery, C.BatteryLevel), { discharging: 64, charging: 78, low: 12 }[mode]);
        assert.equal(await read(f.a, S.Battery, C.ChargingState), mode === 'charging' ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
        assert.equal(await read(f.a, S.Battery, C.StatusLowBattery), mode === 'low' ? 1 : 0);
      }
      f.stop();
    });
  }
  await t.test('8A4 I unavailable and stopped instances reject reads and all writes', async () => {
    for (const unavailable of [true, false]) {
      const f = regularSetup({ unavailable });
      if (!unavailable) {
        f.stop();
      }
      for (const [c, value] of [[f.on, true], [f.volume, 70], [f.mute, false]]) {
        await rejects(c.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
        await rejects(c.handleSetRequest(value), H.SERVICE_COMMUNICATION_FAILURE);
      }
      f.stop();
    }
    const early = setup({ scenario: 'I' }); early.stop(); early.launch(); assert.equal(early.calls.external.length, 0);
    const wrong = setup({ scenario: 'I' }, { storage: '/synthetic/toniebox-presentation-H' });
    wrong.launch(); assert.equal(wrong.calls.external.length, 0);
  });
  await t.test('8A4 I no-media remains unavailable on the switch while volume stays independent', async () => {
    const f = regularSetup({ playback: 'no-media' });
    await rejects(f.on.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE);
    await rejects(f.on.handleSetRequest(true), H.NOT_ALLOWED_IN_CURRENT_STATE);
    await f.volume.handleSetRequest(25); assert.equal(await f.volume.handleGetRequest(), 25);
    await rejects(f.on.handleGetRequest(), H.SERVICE_COMMUNICATION_FAILURE); f.stop();
  });
  await t.test('8A4 I protects cross-control reentrancy through acknowledgement and terminal shutdown', async () => {
    const f = regularSetup(); let nested;
    f.on.on('change', e => {
      if (e.reason === 'write') {
        nested = rejects(f.volume.handleSetRequest(90), H.NOT_ALLOWED_IN_CURRENT_STATE);
      }
    });
    await f.on.handleSetRequest(true); assert.ok(nested); await nested; assert.equal(f.volume.value, 50);
    f.volume.once('change', () => f.stop());
    await rejects(f.volume.handleSetRequest(60), H.SERVICE_COMMUNICATION_FAILURE);
    await rejects(f.on.handleSetRequest(false), H.SERVICE_COMMUNICATION_FAILURE);
    assert.equal(f.calls.logs.includes('Synthetic volume transition applied.'), false);
  });
  await t.test('8A4 I diagnostics are bounded and logger failures remain contained', async () => {
    const f = regularSetup();
    for (let i = 0; i < 40; i++) {
      await rejects(f.mute.handleSetRequest(true), H.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    assert.equal(f.calls.logs.length, 33); f.stop();
    const g = regularSetup({}, { logger: () => Promise.reject(new Error('PRIVATE')) });
    await g.volume.handleSetRequest(25); await g.on.handleSetRequest(true); g.stop();
    await new Promise(resolve => immediate(resolve));
  });
  await t.test('8A4 I identity restarts deterministically and all nine configurations are distinct', async () => {
    const f = regularSetup(); const uuid = f.a.UUID; const serial = await read(f.a, S.AccessoryInformation, C.SerialNumber);
    await f.volume.handleSetRequest(88); await f.on.handleSetRequest(true); f.stop();
    const g = regularSetup(); assert.equal(g.a.UUID, uuid);
    assert.equal(await read(g.a, S.AccessoryInformation, C.SerialNumber), serial);
    assert.equal(await g.volume.handleGetRequest(), 50); assert.equal(await g.on.handleGetRequest(), false); g.stop();
    const letters = ['A','B','C','D','E','F','G','H','I'];
    const configs = letters.map(s => JSON.parse(readFileSync(new URL('../config-' + s + '.json', import.meta.url), 'utf8')));
    assert.equal(new Set(letters.map(s => fixtureUuid(f.api, s))).size, 9);
    for (const key of ['username', 'pin']) {
      assert.equal(new Set(configs.map(c => c.bridge[key])).size, 9);
    }
    assert.equal(new Set(configs.flatMap(c => [c.bridge.port, c.ports.start])).size, 18);
    const c = configs.at(-1);
    assert.equal(c.bridge.port, 53189); assert.equal(c.ports.start, 53289); assert.equal(c.ports.end, 53289);
    assert.deepEqual(c.plugins, [PLUGIN_NAME]); assert.deepEqual(c.accessories, []);
    assert.equal(c.platforms.length, 1); assert.ok(readConfiguration(c.platforms[0]));
  });
  await t.test('8A4 G/H configurations remain byte-for-byte unchanged', () => {
    for (const [name, hash] of [
      ['config-G.json', '95bff6464a787ef7f42b0880ea366af35f054e6630a8d70378be24f27006418e'],
      ['config-H.json', '590c2afc3b0c243845f2d38355279db477e0e7d54e76df890081b517dc8523b3'],
    ]) {
      assert.equal(createHash('sha256').update(readFileSync(new URL('../' + name, import.meta.url))).digest('hex'), hash);
    }
  });

  await t.test('source isolation is explicit: no imports, backend, networking, timers or additional control surface', () => {
    const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\s|\bimport\s*\(|require\s*\(/m);
    assert.doesNotMatch(source, /accountCoordinator|mqtt|fetch\s*\(|setInterval|setTimeout|createServer|process\./);
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(metadata.private, true);
    assert.equal(metadata.dependencies, undefined); assert.equal(metadata.devDependencies, undefined);
  });
});
