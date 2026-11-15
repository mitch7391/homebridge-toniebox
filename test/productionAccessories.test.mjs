import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http from 'node:http';
import https from 'node:https';
import timers from 'node:timers';
import test from 'node:test';

const { TextEncoder } = globalThis;
const immediate = timers.setImmediate;
const account = 'SYNTHETIC_ACCOUNT_A', mac = 'AA:BB:CC:DD:EE:01';
const device = (routeId = 'SYNTHETIC_ROUTE', macAddress = mac, displayName = 'Private Device') => ({ routeId, macAddress, displayName });
const inventory = (devices = [device()], accountUuid = account, authority = 'current') => ({ authority, accountUuid, identitySource: 'uuid', devices });
const observation = (playback = 'playing', d = device()) => ({
  playback, state: { identity: { id: d.routeId, macAddress: d.macAddress } },
  transport: { status: 'connected', session: 1 }, freshness: { 'playback/state': 'observed' },
});
async function drain() {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
}

test('production external SmartSpeaker (real installed HAP, synthetic offline host)', async t => {
  let forbidden = 0;
  const deny = () => {
    forbidden++; throw new Error('Forbidden network, command or polling attempt');
  };
  for (const [object, name] of [[globalThis, 'fetch'], [net.Socket.prototype, 'connect'], [net.Server.prototype, 'listen'],
    [tls, 'connect'], [dgram, 'createSocket'], [http, 'request'], [https, 'request'], [globalThis, 'setInterval'], [timers, 'setInterval']]) {
    t.mock.method(object, name, deny);
  }
  // HAP itself debounces service configuration. No real timer or socket is started.
  const scheduled = new Map();
  const schedule = (fn, ms, ...args) => {
    if (ms !== 1000) {
      deny();
    }
    const timer = { unref() {
      return timer;
    } }; scheduled.set(timer, () => fn(...args)); return timer;
  };
  for (const object of [globalThis, timers]) {
    t.mock.method(object, 'setTimeout', schedule);
    t.mock.method(object, 'clearTimeout', timer => scheduled.delete(timer));
  }
  syncBuiltinESMExports();
  const root = dirname(dirname(createRequire(import.meta.url).resolve('homebridge')));
  const require = createRequire(join(root, 'package.json'));
  const hapModule = await import(pathToFileURL(require.resolve('@homebridge/hap-nodejs')).href);
  const hap = hapModule.default ?? hapModule;
  const { PlatformAccessory } = await import(pathToFileURL(join(root, 'dist/platformAccessory.js')).href);
  const { HomebridgeAPI } = await import(pathToFileURL(join(root, 'dist/api.js')).href);
  const { ProductionAccessories, productionAccessoryUuid } = await import('../dist/productionAccessories.js');
  const { TonieboxPlatform } = await import('../dist/platform.js');
  const { PlatformRuntime } = await import('../dist/platformRuntime.js');
  const { createAccountCoordinator } = await import('../dist/toniebox/accountCoordinator.js');
  const { Service: S, Characteristic: C, HAPStatus: H } = hap;
  const managers = [];
  t.after(async () => {
    for (const manager of managers) {
      manager.stop();
    }
    for (const [timer, callback] of scheduled) {
      scheduled.delete(timer); callback();
    }
    await new Promise(resolve => immediate(resolve));
    assert.equal(forbidden, 0); assert.equal(scheduled.size, 0);
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const setup = (options = {}) => {
    const f = { inventory: inventory(), observation: observation(), published: [], logs: [], reads: [] };
    const api = new EventEmitter();
    Object.assign(api, { hap, platformAccessory: PlatformAccessory,
      publishExternalAccessories(plugin, accessories) {
        HomebridgeAPI.prototype.publishExternalAccessories.call(api, plugin, accessories);
        f.published.push({ plugin, accessories }); return options.publish?.(f);
      }, registerPlatformAccessories: deny, unregisterPlatformAccessories: deny, updatePlatformAccessories: deny });
    f.api = api;
    f.reader = { getProductionInventory: () => options.inventory?.(f) ?? f.inventory,
      getDevice: (id, lane) => {
        f.reads.push([id, lane]); return options.read?.(f) ?? f.observation;
      }, publish: deny };
    f.time = 0; f.jobs = new Set();
    f.timing = { now: () => f.time, schedule: (fn, ms) => {
      const job = { fn, ms }; f.jobs.add(job); return () => f.jobs.delete(job);
    } };
    f.elapse = async ms => {
      f.time += ms; for (const job of [...f.jobs]) {
        f.jobs.delete(job); job.fn();
      } await drain();
    };
    f.manager = new ProductionAccessories(api, f.reader, message => {
      f.logs.push(message); return options.log?.();
    }, f.timing);
    managers.push(f.manager);
    f.refresh = async () => {
      f.manager.refresh(); await drain();
    };
    f.accessory = (i = 0) => f.published[i].accessories[0];
    f.current = (i = 0) => f.accessory(i).getService(S.SmartSpeaker).getCharacteristic(C.CurrentMediaState);
    return f;
  };
  const unavailable = characteristic => assert.rejects(characteristic.handleGetRequest(), e => e === H.SERVICE_COMMUNICATION_FAILURE);

  await t.test('construction is inert; publication is coalesced, external, primary and minimal', async () => {
    const before = scheduled.size, f = setup(); assert.equal(scheduled.size, before); assert.equal(f.published.length, 0);
    f.manager.refresh(); f.manager.refresh(); await drain();
    assert.equal(f.published.length, 1); assert.equal(f.published[0].plugin, 'homebridge-toniebox');
    const a = f.accessory(), speaker = a.getService(S.SmartSpeaker);
    assert.equal(a.category, hap.Categories.SPEAKER); assert.equal(speaker.isPrimaryService, true);
    assert.deepEqual(a.services.map(s => s.UUID).sort(), [S.AccessoryInformation.UUID, S.SmartSpeaker.UUID].sort());
    for (const type of [C.Volume, C.Mute, C.AirPlayEnable, C.On]) {
      assert.equal(speaker.testCharacteristic(type), false);
    }
    for (let i = 0; i < 10; i++) {
      await f.refresh();
    }
    assert.equal(f.published.length, 1); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
  });
  await t.test('identity is account and normalised MAC scoped, deterministic across fresh host instances', async () => {
    const f = setup(), g = setup(); await f.refresh(); await g.refresh();
    assert.equal(f.accessory().UUID, g.accessory().UUID);
    assert.equal(productionAccessoryUuid(f.api, account, mac.toLowerCase()), f.accessory().UUID);
    assert.notEqual(productionAccessoryUuid(f.api, 'OTHER', mac), f.accessory().UUID);
    assert.notEqual(productionAccessoryUuid(f.api, account, 'AA:BB:CC:DD:EE:02'), f.accessory().UUID);
    assert.notEqual(productionAccessoryUuid(f.api, 'a,b', 'c'), productionAccessoryUuid(f.api, 'a', 'b,c'));
  });
  await t.test('multiple distinct production devices publish independently', async () => {
    const f = setup(); const second = device('SECOND', 'AA:BB:CC:DD:EE:02'); f.inventory = inventory([device(), second]);
    await f.refresh(); assert.equal(f.published.length, 2); assert.notEqual(f.accessory().UUID, f.accessory(1).UUID);
    assert.ok(f.reads.every(([, lane]) => lane === 'production'));
  });
  await t.test('route, name and household changes do not change identity or duplicate publication', async () => {
    const f = setup(); await f.refresh(); const uuid = f.accessory().UUID;
    const changed = device('NEW_ROUTE', mac, 'New Private Name'); f.inventory = inventory([changed]); f.observation = observation('paused', changed);
    f.observation.state.identity.household = 'OTHER_HOUSEHOLD'; await f.refresh();
    assert.equal(f.published.length, 1); assert.equal(f.accessory().UUID, uuid);
    const name = f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.ConfiguredName);
    assert.equal(await name.handleGetRequest(), 'New Private Name'); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
  });
  for (const [label, raw] of [
    ['unverified account', { ...inventory(), identitySource: 'id' }], ['missing account', { ...inventory(), accountUuid: undefined }],
    ['missing MAC', inventory([{ routeId: 'A' }])], ['duplicate MAC', inventory([device(), device('SECOND')])],
    ['duplicate route', inventory([device(), device('SYNTHETIC_ROUTE', 'OTHER')])], ['experimental lane', { ...inventory(), authority: 'experimental' }],
    ['empty authority', { authority: 'none', devices: [] }], ['initial last-known', inventory([device()], account, 'last-known')],
  ]) {
    await t.test(label + ' cannot authorise new publication', async () => {
      const f = setup(); f.inventory = raw; await f.refresh(); assert.equal(f.published.length, 0);
    });
  }
  for (const [state, expected] of [['playing', C.CurrentMediaState.PLAY], ['paused', C.CurrentMediaState.PAUSE], ['empty', C.CurrentMediaState.STOP]]) {
    await t.test('backend ' + state + ' maps to established HAP value with change notification', async () => {
      const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
      f.observation = observation(state); await f.refresh(); assert.equal(await f.current().handleGetRequest(), expected);
      if (state !== 'playing') {
        assert.ok(changes.includes(expected));
      }
      const n = changes.length; await f.refresh(); assert.equal(changes.length, n);
    });
  }
  for (const mode of ['unknown', 'inactive', 'retained', 'last-known', 'disconnected', 'wrong-device']) {
    await t.test(mode + ' state is unavailable, never fabricated playback', async () => {
      const f = setup(); await f.refresh();
      if (['unknown', 'inactive'].includes(mode)) {
        f.observation.playback = mode;
      }
      if (['retained', 'last-known'].includes(mode)) {
        f.observation.freshness['playback/state'] = mode;
      }
      if (mode === 'disconnected') {
        f.observation.transport.status = 'disconnected';
      }
      if (mode === 'wrong-device') {
        f.observation.state.identity.macAddress = 'WRONG';
      }
      await f.refresh(); await unavailable(f.current()); assert.equal(f.current().statusCode, H.SERVICE_COMMUNICATION_FAILURE);
    });
  }
  await t.test('unknown initial observation has no successful default Playing read', async () => {
    const f = setup(); f.observation = undefined; await f.refresh(); await unavailable(f.current());
  });
  await t.test('reconnect remains unavailable until backend supplies fresh accepted playback', async () => {
    const f = setup(); await f.refresh(); f.observation.transport.status = 'disconnected'; await f.refresh(); await unavailable(f.current());
    f.observation.transport = { status: 'connected', session: 2 }; f.observation.freshness['playback/state'] = 'retained';
    await f.refresh(); await unavailable(f.current());
    f.observation.freshness['playback/state'] = 'observed'; await f.refresh();
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY); assert.equal(f.published.length, 1);
  });
  await t.test('empty inventory and retained authority suspend presentation without deleting identity', async () => {
    const f = setup(); await f.refresh(); const old = f.accessory();
    for (const absent of [{ authority: 'none', devices: [] }, inventory([device()], account, 'last-known')]) {
      f.inventory = absent; await f.refresh(); await unavailable(f.current()); assert.equal(f.published.length, 1);
    }
    f.inventory = inventory(); await f.refresh(); assert.equal(f.accessory(), old);
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
  });
  await t.test('cross-account transfer never repurposes old pairing, including rapid replacement', async () => {
    const f = setup(); await f.refresh(); const old = f.current();
    f.inventory = { authority: 'none', devices: [] }; f.manager.refresh(); f.inventory = inventory([device()], 'SYNTHETIC_ACCOUNT_B');
    await f.refresh(); assert.equal(f.published.length, 2); assert.notEqual(f.accessory().UUID, f.accessory(1).UUID);
    await unavailable(old); assert.equal(await f.current(1).handleGetRequest(), C.CurrentMediaState.PLAY);
  });
  await t.test('media and name writes reject; desired media state is unknown', async () => {
    const f = setup(); await f.refresh(); const speaker = f.accessory().getService(S.SmartSpeaker);
    const target = speaker.getCharacteristic(C.TargetMediaState); await unavailable(target);
    for (const value of [C.TargetMediaState.PLAY, C.TargetMediaState.PAUSE, C.TargetMediaState.STOP]) {
      await assert.rejects(target.handleSetRequest(value), e => e === H.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    await assert.rejects(speaker.getCharacteristic(C.ConfiguredName).handleSetRequest('changed'), e => e === H.NOT_ALLOWED_IN_CURRENT_STATE);
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
  });
  await t.test('terminal shutdown suppresses queued and late refresh and prevents cached read resurrection', async () => {
    const f = setup(); await f.refresh(); const reading = f.current().handleGetRequest(); f.manager.stop(); await reading;
    // The already-served read was valid, but its completion cannot clear the later terminal HAP error.
    assert.equal(f.current().statusCode, H.SERVICE_COMMUNICATION_FAILURE); await unavailable(f.current());
    f.manager.refresh(); f.manager.stop(); await drain(); assert.equal(f.published.length, 1);
    const g = setup(); g.manager.refresh(); g.manager.stop(); await drain(); assert.equal(g.published.length, 0);
  });
  await t.test('reentrant publication shutdown and notification cannot publish a second device', async () => {
    const f = setup({ publish: value => {
      value.manager.stop(); value.manager.refresh();
    } });
    f.inventory = inventory([device(), device('SECOND', 'OTHER_MAC')]); await f.refresh();
    assert.equal(f.published.length, 1); await unavailable(f.current());
  });
  await t.test('reentrant state read invalidation rejects the old observation', async () => {
    let invalidate = false;
    const f = setup({ read: value => {
      if (invalidate) {
        value.inventory = { authority: 'none', devices: [] }; value.manager.refresh();
      }
      return value.observation;
    } });
    await f.refresh(); invalidate = true; await unavailable(f.current()); await drain();
    assert.equal(f.published.length, 1);
  });
  for (const mode of ['throw', 'reject']) {
    await t.test('publication ' + mode + ' is contained without unsafe duplicate retry', async () => {
      const f = setup({ publish: () => {
        if (mode === 'throw') {
          throw new Error('PRIVATE_EXCEPTION');
        }
        return Promise.reject(new Error('PRIVATE_EXCEPTION'));
      } });
      await f.refresh(); for (let i = 0; i < 5; i++) {
        await f.refresh();
      }
      assert.equal(f.published.length, 1); await unavailable(f.current()); assert.equal(f.logs.length, 1);
      assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|SYNTHETIC|AA:BB/);
    });
  }
  await t.test('throwing inventory, observations and logger cannot destabilise other work', async () => {
    let fault = false;
    const f = setup({ inventory: () => {
      if (fault) {
        throw new Error('PRIVATE');
      }
    }, log: () => Promise.reject(new Error('PRIVATE')) });
    await f.refresh(); fault = true; await f.refresh(); await unavailable(f.current());
    fault = false; await f.refresh(); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
    assert.equal(f.published.length, 1);
  });
  await t.test('one API process cannot gain a second publication owner', async () => {
    const f = setup(); await f.refresh(); const other = new ProductionAccessories(f.api, f.reader, () => {});
    other.refresh(); f.manager.stop(); other.refresh(); await drain(); assert.equal(f.published.length, 1);
  });
  await t.test('historical external registry is bounded without arbitrary truncation', async () => {
    const f = setup(); f.inventory = inventory(Array.from({ length: 100 }, (_, i) => device('R' + i, 'MAC' + i)));
    await f.refresh(); assert.equal(f.published.length, 100);
    f.inventory = inventory([device('R0', 'MAC0'), device('NEW', 'NEW_MAC')]); await f.refresh();
    assert.equal(f.published.length, 100); assert.equal(f.logs.length, 1);
  });
  await t.test('platform runtime attaches presentation before startup and disposes it before backend shutdown', async () => {
    const f = setup(), calls = []; f.manager.stop(); // Use a fresh host for the actual platform owner.
    const api = new EventEmitter(); Object.assign(api, { hap, platformAccessory: PlatformAccessory });
    // A fresh host represents a fresh platform lifetime; use only public API methods.
    api.publishExternalAccessories = f.api.publishExternalAccessories;
    let notice;
    const logger = { info() {}, warn() {} };
    const platform = new TonieboxPlatform(logger, { username: 'SYNTHETIC', password: 'SECRET' }, api, {
      coordinatorFactory: (_status, change) => {
        notice = change; return { ...f.reader, setCredentials: () => ({ ok: true }), start() {
          calls.push('start'); change({ reasons: ['inventory'] }); return { ok: true };
        }, discover() {
          calls.push('discover'); return Promise.resolve({ ok: true });
        }, stop() {
          calls.push('stop'); notice({ reasons: ['stopped'] });
        } };
      },
    });
    platform.configureAccessory(Object.freeze({ context: Object.freeze({}) }));
    assert.deepEqual(calls, []); api.emit('didFinishLaunching'); await drain(); assert.equal(f.published.length, 1);
    api.emit('shutdown'); notice({ reasons: ['observation'] }); await drain();
    await unavailable(f.current()); assert.deepEqual(calls, ['start', 'discover', 'stop']);
  });
  await t.test('real coordinator and backend state supply fresh read-only playback with experimental exclusion', async () => {
    const f = setup(); f.manager.stop(); const jobs = new Set(), lifecycles = []; let manager;
    const ok = value => ({ ok: true, value, diagnostics: {
      rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false,
    } });
    const coordinator = createAccountCoordinator({
      clock: { now: () => ({ monotonicMs: 0, wallMs: 0 }) }, scheduler: { schedule(fn, ms) {
        const job = { fn, ms }; jobs.add(job); return () => jobs.delete(job);
      } },
      authClient: { login: async () => ({ ok: true, tokens: {
        accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresInSeconds: 300, tokenType: 'Bearer',
      } }), refresh: deny },
      discoveryClient: { getAccount: async () => ok({ id: account, identitySource: 'uuid' }),
        getHouseholds: async () => ok([{ id: 'SYNTHETIC_HOUSE' }]), getTonieboxes: async () => ok([
          { id: 'SYNTHETIC_ROUTE', macAddress: mac, product: 'tb2', generation: 'tng', features: ['playbackControls'] },
          { id: 'EXPERIMENT', macAddress: 'OTHER_MAC', product: 'unknown', generation: 'unknown', features: ['playbackControls'] },
        ]) },
      policy: { rules: [{ product: 'unknown', generation: 'unknown', family: 'unknown', decision: 'experimental',
        protocol: 'ici-seven-state-topics', evidence: 'SYNTHETIC_APPROVAL' }] },
      lifecycleFactory: options => {
        lifecycles.push(options); return {
          start: () => options.onStatus({ phase: 'ready', connected: true, session: 1 }), stop() {}, getStatus: () => ({ phase: 'idle', connected: false }),
        };
      }, onProductionChange: () => manager?.refresh(),
    });
    const host = new EventEmitter(); Object.assign(host, { hap, platformAccessory: PlatformAccessory,
      publishExternalAccessories: f.api.publishExternalAccessories });
    manager = new ProductionAccessories(host, coordinator, () => {}); managers.push(manager);
    try {
      coordinator.setCredentials({ username: 'SYNTHETIC', password: 'SECRET' }); coordinator.start(); await coordinator.discover(); await drain();
      assert.equal(lifecycles.length, 2); assert.equal(f.published.length, 1); await unavailable(f.current());
      const message = (topic, value, retained = false) => lifecycles[0].onMessage({ routeId: 'SYNTHETIC_ROUTE',
        topic: 'external/toniebox/' + mac + '/' + topic, payload: new TextEncoder().encode(JSON.stringify(value)),
        retained, receivedAtMs: 100, session: 1, duplicate: false, qos: 1 });
      message('online-state', { onlineState: 'connected' }, true);
      message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: false }, true); await drain(); await unavailable(f.current());
      message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: false }); await drain();
      assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
      message('online-state', { onlineState: 'disconnected' }); await drain();
      assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
      message('online-state', { onlineState: 'connected' }, true); await drain();
      assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
      coordinator.invalidate(); await drain(); await unavailable(f.current()); assert.equal(f.published.length, 1);
    } finally {
      manager.stop(); coordinator.stop();
    }
    assert.equal(jobs.size, 0);
  });
  await t.test('HAP reads reread backend state even before a deferred refresh hint is processed', async () => {
    const f = setup(); await f.refresh(); f.observation.playback = 'paused';
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
    f.inventory = { authority: 'none', devices: [] };
    await unavailable(f.current()); assert.equal(f.published.length, 1);
  });
  await t.test('reentrant refresh hints during publication coalesce without losing the second device', async () => {
    const f = setup({ publish: value => value.manager.refresh() });
    f.inventory = inventory([device(), device('SECOND', 'OTHER_MAC')]); await f.refresh();
    assert.equal(f.published.length, 2); await f.refresh(); assert.equal(f.published.length, 2);
  });
  await t.test('one failed publication cannot prevent unrelated authorised publication', async () => {
    const f = setup({ publish: value => {
      if (value.published.length === 1) {
        throw new Error('PRIVATE');
      }
    } });
    const second = device('SECOND', 'OTHER_MAC'); f.inventory = inventory([device(), second]); f.observation = observation('paused', second);
    await f.refresh(); assert.equal(f.published.length, 2); await unavailable(f.current());
    assert.equal(await f.current(1).handleGetRequest(), C.CurrentMediaState.PAUSE);
  });
  await t.test('queued creation is cancelled by withdrawal before the flush', async () => {
    const f = setup(); f.manager.refresh(); f.inventory = { authority: 'none', devices: [] }; await drain();
    assert.equal(f.published.length, 0);
  });
  await t.test('shutdown reentered from a characteristic notification remains terminal', async () => {
    const f = setup(); await f.refresh(); f.current().on('change', () => f.manager.stop());
    f.observation.playback = 'paused'; await f.refresh();
    assert.equal(f.current().statusCode, H.SERVICE_COMMUNICATION_FAILURE); await unavailable(f.current());
  });
  for (const mode of ['factory-throw', 'factory-stop', 'observer-throw', 'observer-reject']) {
    await t.test('runtime presentation isolation: ' + mode, async () => {
      const calls = []; let runtime, notify;
      runtime = new PlatformRuntime({ username: 'SYNTHETIC', password: 'SECRET' }, { info() {}, warn() {} }, {
        coordinatorFactory: (_status, change) => {
          notify = change;
          return { setCredentials: () => ({ ok: true }), start() {
            calls.push('start'); change({ reasons: ['inventory'] }); return { ok: true };
          }, discover() {
            calls.push('discover'); return Promise.resolve({ ok: true });
          }, stop() {
            calls.push('backend-stop');
          } };
        },
        presentationFactory: () => {
          if (mode === 'factory-throw') {
            throw new Error('PRIVATE');
          }
          if (mode === 'factory-stop') {
            runtime.stop();
          }
          return { refresh() {
            if (mode === 'observer-throw') {
              throw new Error('PRIVATE');
            }
            return Promise.reject(new Error('PRIVATE'));
          }, stop() {
            calls.push('presentation-stop');
          } };
        },
      });
      runtime.launch(); await drain(); runtime.stop(); notify({ reasons: ['observation'] }); await drain();
      if (mode === 'factory-stop') {
        assert.deepEqual(calls, ['backend-stop', 'presentation-stop']);
      } else {
        assert.deepEqual(calls, ['start', 'discover', ...(mode === 'factory-throw' ? [] : ['presentation-stop']), 'backend-stop']);
      }
    });
  }
  await t.test('approved ConfiguredName is populated before external publication', async () => {
    let checked = false;
    const f = setup({ publish: value => {
      const name = value.accessory().getService(S.SmartSpeaker).getCharacteristic(C.ConfiguredName);
      assert.equal(name.value, 'Private Device'); assert.equal(name.statusCode, H.SUCCESS); checked = true;
    } });
    await f.refresh(); assert.equal(checked, true);
    f.inventory = inventory([device('SYNTHETIC_ROUTE', mac, 'Renamed')]); await f.refresh();
    assert.equal(f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.ConfiguredName).value, 'Renamed');
    assert.equal(f.published.length, 1);
  });
  await t.test('standard Identify acknowledges locally without a physical command or state change', async () => {
    const f = setup(); await f.refresh(); const reads = f.reads.length, publications = f.published.length;
    assert.equal(f.accessory().listenerCount('identify'), 0);
    const identify = f.accessory().getService(S.AccessoryInformation).getCharacteristic(C.Identify);
    await identify.handleSetRequest(true);
    assert.equal(f.reads.length, reads); assert.equal(f.published.length, publications);
    assert.equal(f.observation.playback, 'playing'); assert.deepEqual(f.logs, []);
  });
  await t.test('live physical offline pushes PAUSE, while retained or old-session offline does not', async () => {
    const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
    f.observation.playback = 'unknown';
    f.observation.state.topics = { 'online-state': { value: { onlineState: 'disconnected' }, session: 1, retained: true } };
    f.observation.freshness['online-state'] = 'retained'; await f.refresh(); await unavailable(f.current());
    f.observation.state.topics['online-state'].retained = false; f.observation.state.topics['online-state'].session = 0;
    f.observation.freshness['online-state'] = 'observed'; await f.refresh(); await unavailable(f.current());
    f.observation.state.topics['online-state'].session = 1; await f.refresh();
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE); assert.ok(changes.includes(C.CurrentMediaState.PAUSE));
    assert.equal(f.observation.playback, 'unknown'); assert.equal(f.jobs.size, 0);
    await unavailable(f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState));
  });
  await t.test('two-second interruption cancels grace on fresh recovery without a false PAUSE', async () => {
    const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
    f.observation.transport.status = 'disconnected'; await f.refresh(); await f.refresh(); assert.equal(f.jobs.size, 1);
    await f.elapse(2000); assert.equal(f.jobs.size, 1); await unavailable(f.current());
    f.observation = observation(); await f.refresh(); assert.equal(f.jobs.size, 0);
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY); assert.ok(!changes.includes(C.CurrentMediaState.PAUSE));
  });
  await t.test('sustained loss pushes PAUSE once and retained reconnect cannot revive PLAY', async () => {
    const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
    f.observation.transport.status = 'disconnected'; await f.refresh(); await f.elapse(10000);
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE); assert.equal(f.jobs.size, 0);
    f.observation = observation('unknown'); f.observation.freshness['playback/state'] = 'retained';
    await f.refresh(); await f.refresh(); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
    assert.equal(changes.filter(v => v === C.CurrentMediaState.PAUSE).length, 1);
    f.observation = observation('playing'); await f.refresh(); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
  });
  await t.test('reconnection awaiting fresh evidence preserves original grace deadline', async () => {
    const f = setup(); await f.refresh(); f.observation.transport.status = 'disconnected'; await f.refresh(); await f.elapse(2000);
    f.observation = observation('unknown'); f.observation.freshness['playback/state'] = 'retained'; await f.refresh();
    await f.elapse(8000); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
  });
  for (const action of ['revoke', 'mismatch', 'invalid', 'stop']) {
    await t.test('grace cleanup and late timer isolation: ' + action, async () => {
      const f = setup(); await f.refresh(); f.observation.transport.status = 'disconnected'; await f.refresh();
      const late = [...f.jobs][0].fn;
      if (action === 'revoke') {
        f.inventory = { authority: 'none', devices: [] };
      }
      if (action === 'mismatch') {
        f.observation.state.identity.macAddress = 'OTHER';
      }
      if (action === 'invalid') {
        f.inventory = {};
      }
      if (action === 'stop') {
        f.manager.stop();
      }
      await f.refresh(); assert.equal(f.jobs.size, 0); f.time = 10000; late(); await drain(); await unavailable(f.current());
    });
  }
  for (const mode of ['clock', 'scheduler', 'synchronous']) {
    await t.test('grace dependency failure stays unavailable: ' + mode, async () => {
      const f = setup(); await f.refresh(); f.observation.transport.status = 'disconnected';
      if (mode === 'clock') {
        f.timing.now = () => NaN;
      }
      if (mode === 'scheduler') {
        f.timing.schedule = () => {
          throw new Error('PRIVATE');
        };
      }
      if (mode === 'synchronous') {
        f.timing.schedule = fn => {
          fn(); return () => {};
        };
      }
      await f.refresh(); await unavailable(f.current()); assert.equal(f.jobs.size, 0);
    });
  }
  await t.test('failed cancellation cannot revive a revoked grace callback', async () => {
    const f = setup(); await f.refresh(); let late;
    f.timing.schedule = fn => {
      late = fn; return () => {
        throw new Error('PRIVATE');
      };
    };
    f.observation.transport.status = 'disconnected'; await f.refresh(); f.manager.stop(); f.time = 10000; late();
    await drain(); await unavailable(f.current());
  });
  await t.test('explicit offline is recognised but unsupported online values are not guessed', async () => {
    const f = setup(); await f.refresh(); f.observation.playback = 'unknown';
    f.observation.state.topics = { 'online-state': { value: { onlineState: 'unsupported' }, session: 1, retained: false } };
    f.observation.freshness['online-state'] = 'observed'; await f.refresh(); await unavailable(f.current());
    f.observation.state.topics['online-state'].value.onlineState = 'offline'; await f.refresh();
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
  });
});
