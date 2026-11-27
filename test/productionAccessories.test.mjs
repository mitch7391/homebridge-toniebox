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
    }, f.timing, { enablePlaybackCommands: options.enablePlaybackCommands });
    managers.push(f.manager);
    f.refresh = async () => {
      f.manager.refresh(); await drain();
    };
    f.accessory = (i = 0) => f.published[i].accessories[0];
    f.current = (i = 0) => f.accessory(i).getService(S.SmartSpeaker).getCharacteristic(C.CurrentMediaState);
    return f;
  };
  const unknown = async characteristic => {
    assert.equal(await characteristic.handleGetRequest(), 3); assert.equal(characteristic.statusCode, H.SUCCESS);
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
        f.observation.freshness['playback/state'] = mode; f.observation.playback = 'unknown';
      }
      if (mode === 'disconnected') {
        f.observation.transport.status = 'disconnected';
      }
      if (mode === 'wrong-device') {
        f.observation.state.identity.macAddress = 'WRONG';
      }
      await f.refresh();
      if (mode === 'wrong-device') {
        await unavailable(f.current());
      } else if (mode === 'disconnected') {
        assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
      } else {
        await unknown(f.current());
      }
    });
  }
  await t.test('unknown initial observation has no successful default Playing read', async () => {
    const f = setup(); f.observation = undefined; await f.refresh(); await unknown(f.current());
  });
  await t.test('reconnect remains unavailable until backend supplies fresh accepted playback', async () => {
    const f = setup(); await f.refresh(); f.observation.transport.status = 'disconnected'; await f.refresh();
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
    f.observation.transport = { status: 'connected', session: 2 }; f.observation.freshness['playback/state'] = 'retained';
    await f.refresh(); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
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
  for (const [initial, expected] of [[{ tonie: 'SYNTHETIC_CONTENT', paused: false }, C.CurrentMediaState.PLAY],
    [{ tonie: 'SYNTHETIC_CONTENT', paused: true }, C.CurrentMediaState.PAUSE], [{ tonie: null }, C.CurrentMediaState.STOP]]) {
    await t.test('real coordinator retained startup and repeated recovery: ' + expected, async () => {
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
      manager = new ProductionAccessories(host, coordinator, () => {}, f.timing); managers.push(manager);
      try {
        coordinator.setCredentials({ username: 'SYNTHETIC', password: 'SECRET' }); coordinator.start(); await coordinator.discover(); await drain();
        assert.equal(lifecycles.length, 2); assert.equal(f.published.length, 1); await unknown(f.current());
        let session = 1;
        const message = (topic, value, retained = false) => lifecycles[0].onMessage({ routeId: 'SYNTHETIC_ROUTE',
          topic: 'external/toniebox/' + mac + '/' + topic, payload: new TextEncoder().encode(JSON.stringify(value)),
          retained, receivedAtMs: 100, session, duplicate: false, qos: 1 });
        message('online-state', { onlineState: 'connected' }, true);
        message('playback/state', initial, true); await drain();
        assert.equal(await f.current().handleGetRequest(), expected); // No live event or physical interaction.
        assert.equal(coordinator.getDevice('SYNTHETIC_ROUTE').freshness['playback/state'], 'retained');
        for (session = 2; session <= 4; session++) {
          lifecycles[0].onStatus({ phase: 'connecting', connected: false }); await drain();
          assert.equal(f.jobs.size, 1); const late = [...f.jobs][0].fn;
          f.time += 2000;
          lifecycles[0].onStatus({ phase: 'ready', connected: true, session }); await drain();
          message('playback/state', initial, true); message('online-state', { onlineState: 'connected' }, true); await drain();
          assert.equal(await f.current().handleGetRequest(), expected); assert.equal(f.jobs.size, 0);
          late(); await drain(); assert.equal(await f.current().handleGetRequest(), expected);
          const current = session; session--; message('playback/state', { tonie: null }); session = current; await drain();
          assert.equal(await f.current().handleGetRequest(), expected);
        }
        session = 4;
        message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: true }); await drain();
        assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
        message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: false }, true); await drain();
        assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PAUSE);
        message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: false }); await drain();
        assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
        message('playback/state', { tonie: null }); await drain();
        assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.STOP);
        message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: false }); await drain();
        assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
        message('online-state', { onlineState: 'disconnected' }); await drain();
        assert.equal(await f.current().handleGetRequest(), 3);
        message('online-state', { onlineState: 'connected' }, true); await drain();
        assert.equal(await f.current().handleGetRequest(), 3);
        coordinator.invalidate(); await drain(); await unavailable(f.current()); assert.equal(f.published.length, 1);
      } finally {
        manager.stop(); coordinator.stop();
      }
      assert.equal(jobs.size, 0);
    });
  }
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
  await t.test('live physical offline pushes UNKNOWN, while retained or old-session offline does not', async () => {
    const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
    f.observation.playback = 'unknown';
    f.observation.state.topics = { 'online-state': { value: { onlineState: 'disconnected' }, session: 1, retained: true } };
    f.observation.freshness['online-state'] = 'retained'; await f.refresh(); await unknown(f.current());
    f.observation.state.topics['online-state'].retained = false; f.observation.state.topics['online-state'].session = 0;
    f.observation.freshness['online-state'] = 'observed'; await f.refresh(); await unknown(f.current());
    f.observation.state.topics['online-state'].session = 1; await f.refresh();
    assert.equal(await f.current().handleGetRequest(), 3); assert.ok(changes.includes(3));
    assert.equal(f.observation.playback, 'unknown'); assert.equal(f.jobs.size, 0);
    await unavailable(f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState));
  });
  await t.test('two-second interruption cancels grace on fresh recovery without a false PAUSE', async () => {
    const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
    f.observation.transport.status = 'disconnected'; await f.refresh(); await f.refresh(); assert.equal(f.jobs.size, 1);
    await f.elapse(2000); assert.equal(f.jobs.size, 1); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
    f.observation = observation(); await f.refresh(); assert.equal(f.jobs.size, 0);
    assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY); assert.ok(!changes.includes(3));
  });
  await t.test('sustained loss pushes UNKNOWN once and retained reconnect cannot revive PLAY', async () => {
    const f = setup(); await f.refresh(); const changes = []; f.current().on('change', e => changes.push(e.newValue));
    f.observation.transport.status = 'disconnected'; await f.refresh(); await f.elapse(10000);
    assert.equal(await f.current().handleGetRequest(), 3); assert.equal(f.jobs.size, 0);
    f.observation = observation('unknown'); f.observation.freshness['playback/state'] = 'retained';
    await f.refresh(); await f.refresh(); assert.equal(await f.current().handleGetRequest(), 3);
    assert.equal(changes.filter(v => v === 3).length, 1);
    f.observation = observation('playing'); await f.refresh(); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
  });
  await t.test('reconnection awaiting fresh evidence preserves original grace deadline', async () => {
    const f = setup(); await f.refresh(); f.observation.transport.status = 'disconnected'; await f.refresh(); await f.elapse(2000);
    f.observation = observation('unknown'); f.observation.freshness['playback/state'] = 'retained'; await f.refresh();
    await f.elapse(8000); assert.equal(await f.current().handleGetRequest(), 3);
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
      await f.refresh(); await unknown(f.current()); assert.equal(f.jobs.size, 0);
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
    f.observation.freshness['online-state'] = 'observed'; await f.refresh(); await unknown(f.current());
    f.observation.state.topics['online-state'].value.onlineState = 'offline'; await f.refresh();
    assert.equal(await f.current().handleGetRequest(), 3);
  });
  await t.test('instance-local UNKNOWN is accepted, notified and advertised without global changes', async () => {
    const f = setup(); await f.refresh(); const c = f.current(), changes = [];
    c.on('change', e => changes.push(e.newValue)); f.observation = observation('unknown'); await f.refresh();
    await unknown(c); assert.ok(changes.includes(3));
    // Synthetic instance ID supplies the offline serializer prerequisite; no server is published.
    c.iid = 1; const wire = await c.toHAP(undefined, false);
    assert.deepEqual(wire['valid-values'], [0, 1, 2, 3, 4, 5]); assert.equal(wire.value, 3);
    assert.deepEqual(new C.CurrentMediaState().props.validValues, [0, 1, 2, 4, 5]);
    assert.equal(C.CurrentMediaState.UNKNOWN, undefined);
    assert.deepEqual(f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState).props.validValues, [0, 1, 2]);
  });
  for (const [playback, expected] of [['playing', C.CurrentMediaState.PLAY], ['paused', C.CurrentMediaState.PAUSE], ['empty', C.CurrentMediaState.STOP]]) {
    await t.test('successive sessions restore ' + playback + ' and obsolete timers cannot overwrite it', async () => {
      const f = setup(); await f.refresh();
      for (let session = 2; session <= 5; session++) {
        f.observation.transport.status = 'disconnected'; await f.refresh(); const late = [...f.jobs][0].fn;
        f.observation = observation('unknown'); f.observation.transport.session = session;
        f.observation.freshness['playback/state'] = 'last-known'; await f.refresh();
        await f.elapse(10000); await unknown(f.current());
        f.observation = observation(playback); f.observation.transport.session = session; await f.refresh();
        assert.equal(f.jobs.size, 0); late(); await drain();
        assert.equal(await f.current().handleGetRequest(), expected); assert.equal(f.jobs.size, 0);
      }
    });
  }
  await t.test('session replacement without an intermediate hint still has one bounded grace', async () => {
    const f = setup(); await f.refresh(); f.observation = observation('unknown'); f.observation.transport.session = 2;
    await f.refresh(); assert.equal(f.jobs.size, 1); assert.equal(await f.current().handleGetRequest(), C.CurrentMediaState.PLAY);
    await f.elapse(10000); await unknown(f.current()); assert.equal(f.jobs.size, 0);
  });
  await t.test('cold disconnected startup never fabricates playback during grace', async () => {
    const f = setup(); f.observation = observation('unknown'); f.observation.transport.status = 'disconnected';
    await f.refresh(); await unknown(f.current()); await f.elapse(10000); await unknown(f.current());
  });

  const controls = async (request, extra = {}) => {
    const f = setup({ enablePlaybackCommands: true, ...extra });
    f.observation.state.topics = { 'online-state': { session: 1, value: { onlineState: 'connected' } } };
    f.commands = [];
    f.reader.requestPlayback = (target, action, options) => {
      f.commands.push({ target, action, options }); return request?.(f, target, action, options);
    };
    await f.refresh();
    f.target = () => f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState);
    return f;
  };
  const defer = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
      resolve = a; reject = b;
    });
    return { promise, resolve, reject };
  };
  const rawWrite = (characteristic, value) => new Promise(resolve => characteristic.emit('set', value, resolve));

  await t.test('command opt-in is strict and disabled presentation cannot invoke coordinator', async () => {
    for (const enablePlaybackCommands of [undefined, false, 'true', 1]) {
      const f = await controls(() => {
        throw new Error('Must not invoke');
      }, { enablePlaybackCommands });
      await assert.rejects(f.target().handleSetRequest(C.TargetMediaState.PAUSE), e => e === H.NOT_ALLOWED_IN_CURRENT_STATE);
      assert.equal(f.commands.length, 0); await unavailable(f.target());
    }
  });
  for (const [value, action] of [[C.TargetMediaState.PLAY, 'play'], [C.TargetMediaState.PAUSE, 'pause']]) {
    await t.test('native ' + action + ' forwards current verified identity and waits for confirmation', async () => {
      const pending = defer(), f = await controls(() => pending.promise);
      const expectedUuid = f.accessory().UUID;
      let settled = false;
      const write = f.target().handleSetRequest(value).then(() => {
        settled = true;
      });
      await drain(); assert.equal(settled, false); assert.equal(f.current().value, C.CurrentMediaState.PLAY);
      assert.deepEqual(f.commands[0].target, { accountUuid: account, routeId: 'SYNTHETIC_ROUTE', macAddress: mac });
      assert.equal(f.commands[0].action, action); assert.ok(f.commands[0].options.signal instanceof globalThis.AbortSignal);
      f.observation.playback = action === 'play' ? 'playing' : 'paused'; await f.refresh();
      assert.equal(settled, false); // An observation alone is not coordinator completion.
      pending.resolve({ ok: true, outcome: 'confirmed' }); await write;
      assert.equal(f.target().value, value); assert.equal(f.current().value, value);
      assert.equal(await f.target().handleGetRequest(), value); assert.equal(f.accessory().UUID, expectedUuid);
      assert.deepEqual(f.accessory().services.map(x => x.UUID).sort(), [S.AccessoryInformation.UUID, S.SmartSpeaker.UUID, S.Switch.UUID].sort());
      assert.equal(f.jobs.size, 0);
    });
  }
  await t.test('already-satisfied coordinator completion succeeds without inventing physical changes', async () => {
    const f = await controls(() => ({ ok: true, outcome: 'already-satisfied' }));
    await f.target().handleSetRequest(C.TargetMediaState.PLAY);
    assert.equal(f.current().value, C.CurrentMediaState.PLAY); assert.equal(f.commands.length, 1);
  });
  await t.test('STOP and malformed values reject without coordinator calls', async () => {
    const f = await controls();
    assert.equal(await rawWrite(f.target(), C.TargetMediaState.STOP), H.NOT_ALLOWED_IN_CURRENT_STATE);
    for (const value of [null, undefined, '0', true, -1, 3, NaN, Infinity, 0.5, {}]) {
      assert.equal(await rawWrite(f.target(), value), H.INVALID_VALUE_IN_REQUEST);
    }
    assert.equal(f.commands.length, 0);
  });
  await t.test('pending and callback-reentrant writes are busy; latest observation wins HAP cache', async () => {
    const pending = defer(), f = await controls(() => pending.promise);
    const first = f.target().handleSetRequest(C.TargetMediaState.PAUSE);
    await assert.rejects(f.target().handleSetRequest(C.TargetMediaState.PLAY), e => e === H.RESOURCE_BUSY);
    let nested;
    f.target().on('change', event => {
      if (event.reason === 'write') {
        nested = rawWrite(f.target(), C.TargetMediaState.PLAY);
      }
    });
    // Confirmation can be followed by an independent physical change before HAP acknowledges.
    f.observation.playback = 'playing'; pending.resolve({ ok: true, outcome: 'confirmed' }); await first;
    assert.equal(await nested, H.RESOURCE_BUSY); assert.equal(f.commands.length, 1);
    assert.equal(f.target().value, C.TargetMediaState.PLAY); assert.equal(f.current().value, C.CurrentMediaState.PLAY);
  });
  for (const [reason, delivery, expected] of [
    ['timeout', 'uncertain', H.SERVICE_COMMUNICATION_FAILURE], ['interrupted', 'uncertain', H.SERVICE_COMMUNICATION_FAILURE],
    ['busy', 'not-dispatched', H.RESOURCE_BUSY], ['capacity', 'not-dispatched', H.RESOURCE_BUSY],
    ['insufficient-state', 'not-dispatched', H.NOT_ALLOWED_IN_CURRENT_STATE],
    ['invalid-input', 'not-dispatched', H.INVALID_VALUE_IN_REQUEST], ['not-authorised', 'not-dispatched', H.SERVICE_COMMUNICATION_FAILURE],
    ['busy', 'uncertain', H.SERVICE_COMMUNICATION_FAILURE],
  ]) {
    await t.test('sanitised native failure: ' + reason + '/' + delivery, async () => {
      const f = await controls(() => ({ ok: false, reason, delivery }));
      await assert.rejects(f.target().handleSetRequest(C.TargetMediaState.PAUSE), e => e === expected);
      assert.equal(f.current().value, C.CurrentMediaState.PLAY); assert.equal(f.commands.length, 1);
      assert.deepEqual(f.logs, []);
    });
  }
  for (const mode of ['throw', 'reject', 'malformed', 'puback']) {
    await t.test('dependency failure never reports success: ' + mode, async () => {
      const f = await controls(() => {
        if (mode === 'throw') {
          throw new Error('PRIVATE');
        }
        if (mode === 'reject') {
          return Promise.reject(new Error('PRIVATE'));
        }
        return mode === 'puback' ? { ok: true, acknowledgement: 'broker' } : null;
      });
      await assert.rejects(f.target().handleSetRequest(C.TargetMediaState.PAUSE), e => e === H.SERVICE_COMMUNICATION_FAILURE);
      assert.deepEqual(f.logs, []); assert.equal(f.commands.length, 1);
    });
  }
  for (const mode of ['shutdown', 'revocation', 'account', 'route', 'last-known']) {
    await t.test('pending write cancelled once on ' + mode + '; late success is inert', async () => {
      const pending = defer(), f = await controls(() => pending.promise); let count = 0, status;
      f.target().emit('set', C.TargetMediaState.PAUSE, error => {
        count++; status = error;
      });
      if (mode === 'shutdown') {
        f.manager.stop();
      } else {
        f.inventory = mode === 'revocation' ? { authority: 'none', devices: [] }
          : mode === 'account' ? inventory([device()], 'OTHER_ACCOUNT')
            : mode === 'route' ? inventory([device('OTHER_ROUTE')]) : inventory([device()], account, 'last-known');
        f.manager.refresh();
      }
      await drain(); assert.equal(count, 1); assert.equal(status, H.SERVICE_COMMUNICATION_FAILURE);
      assert.equal(f.commands[0].options.signal.aborted, true);
      pending.resolve({ ok: true, outcome: 'confirmed' }); await drain(); assert.equal(count, 1);
      await unavailable(f.target()); assert.equal(f.jobs.size, 0);
    });
  }
  await t.test('throwing callback completes once and releases the busy guard', async () => {
    const f = await controls(() => ({ ok: true, outcome: 'confirmed' })); let count = 0;
    f.target().emit('set', C.TargetMediaState.PAUSE, () => {
      count++; throw new Error('PRIVATE');
    });
    await drain(); assert.equal(count, 1);
    await f.target().handleSetRequest(C.TargetMediaState.PLAY); assert.equal(f.commands.length, 2);
  });
  await t.test('transport display grace is not used as command authority or target read evidence', async () => {
    const f = await controls(() => ({ ok: false, reason: 'not-ready', delivery: 'not-dispatched' }));
    f.observation.transport.status = 'disconnected'; f.observation.playback = 'unknown'; await f.refresh();
    assert.equal(f.current().value, C.CurrentMediaState.PLAY); await unavailable(f.target());
    await assert.rejects(f.target().handleSetRequest(C.TargetMediaState.PAUSE), e => e === H.SERVICE_COMMUNICATION_FAILURE);
    assert.equal(f.commands.length, 1); // Coordinator, never the grace display, decides admission.
    f.manager.stop(); assert.equal(f.jobs.size, 0);
  });

  await t.test('abort cleanup revocation cannot turn a completed result into obsolete HAP success', async () => {
    const f = await controls((_f, _target, _action, options) => {
      options.signal.addEventListener('abort', () => {
        f.inventory = { authority: 'none', devices: [] };
      });
      return { ok: true, outcome: 'confirmed' };
    });
    await assert.rejects(f.target().handleSetRequest(C.TargetMediaState.PAUSE), e => e === H.SERVICE_COMMUNICATION_FAILURE);
    await unavailable(f.target());
  });
  await t.test('publication reentrancy cannot dispatch before the accessory is published', async () => {
    let rejected;
    const f = await controls(() => ({ ok: true, outcome: 'confirmed' }), { publish(host) {
      rejected = rawWrite(host.accessory().getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState), C.TargetMediaState.PLAY);
    } });
    assert.equal(await rejected, H.SERVICE_COMMUNICATION_FAILURE); assert.equal(f.commands.length, 0);
  });
  for (const enabled of [false, true]) {
    await t.test('platform native writes compose with real coordinator, enabled=' + enabled, async () => {
      const f = setup(); f.manager.stop(); const jobs = new Set(), calls = [];
      let coordinator, lane, status = { phase: 'idle', connected: false }, now = 0;
      const ok = value => ({ ok: true, value, diagnostics: {
        rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0, ambiguousRoutingEntries: 0, continuationDetected: false,
      } });
      const host = new EventEmitter(); Object.assign(host, { hap, platformAccessory: PlatformAccessory,
        publishExternalAccessories: f.api.publishExternalAccessories });
      const platform = new TonieboxPlatform({ info(message) {
        f.logs.push(message);
      }, warn(message) {
        f.logs.push(message);
      } },
      { username: 'SYNTHETIC', password: 'SECRET', enablePlaybackCommands: true }, host, {
        enablePlaybackCommands: enabled,
        coordinatorFactory: (onStatus, onProductionChange, permission) => {
          assert.equal(permission, enabled);
          coordinator = createAccountCoordinator({ enablePlaybackCommands: permission, onStatus, onProductionChange,
            clock: { now: () => ({ monotonicMs: now, wallMs: now }) }, scheduler: { schedule(fn, ms) {
              const job = { fn, ms }; jobs.add(job); return () => jobs.delete(job);
            } },
            authClient: { login: async () => ({ ok: true, tokens: {
              accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', expiresInSeconds: 300, tokenType: 'Bearer',
            } }), refresh: deny },
            discoveryClient: { getAccount: async () => ok({ id: account, identitySource: 'uuid' }),
              getHouseholds: async () => ok([{ id: 'SYNTHETIC_HOUSE' }]), getTonieboxes: async () => ok([
                { id: 'SYNTHETIC_ROUTE', macAddress: mac, product: 'tb2', generation: 'tng', features: ['playbackControls'] },
              ]) },
            lifecycleFactory: options => {
              lane = options; return { start() {
                status = { phase: 'ready', connected: true, session: 1 }; options.onStatus(status);
              }, stop() {}, getStatus: () => status,
              publishPlayback(routeId, action, opts) {
                calls.push({ routeId, action, opts }); return Promise.resolve({ ok: true, acknowledgement: 'broker' });
              } };
            },
          }); return coordinator;
        },
      });
      const message = (topic, payload, retained = false) => lane.onMessage({ routeId: 'SYNTHETIC_ROUTE',
        topic: 'external/toniebox/' + mac + '/' + topic, payload: new TextEncoder().encode(JSON.stringify(payload)),
        session: 1, retained, duplicate: false, qos: 1, receivedAtMs: ++now });
      try {
        platform.configureAccessory(); host.emit('didFinishLaunching'); await drain(); await coordinator.discover(); await drain();
        message('online-state', { onlineState: 'connected' });
        message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: false }); await drain();
        assert.equal(f.published.length, 1, JSON.stringify({ logs: f.logs, status: coordinator.getStatus(), inventory: coordinator.getProductionInventory() }));
        const target = f.accessory().getService(S.SmartSpeaker).getCharacteristic(C.TargetMediaState);
        if (!enabled) {
          await assert.rejects(target.handleSetRequest(C.TargetMediaState.PAUSE), e => e === H.NOT_ALLOWED_IN_CURRENT_STATE);
          assert.equal(calls.length, 0); assert.deepEqual(lane.playbackRouteIds ?? [], []);
        } else {
          await target.handleSetRequest(C.TargetMediaState.PLAY); assert.equal(calls.length, 0); // Real no-op admission.
          let settled = false;
          const pause = f.accessory().getService(S.Switch).getCharacteristic(C.On).handleSetRequest(false).then(() => {
            settled = true;
          });
          await drain(); assert.equal(calls.length, 1); assert.equal(settled, false); // PUBACK alone is insufficient.
          assert.equal(f.current().value, C.CurrentMediaState.PLAY);
          message('playback/state', { tonie: 'SYNTHETIC_CONTENT', paused: true }); await pause; await drain();
          assert.equal(f.current().value, C.CurrentMediaState.PAUSE); assert.equal(target.value, C.TargetMediaState.PAUSE);
          const timed = assert.rejects(target.handleSetRequest(C.TargetMediaState.PLAY), e => e === H.SERVICE_COMMUNICATION_FAILURE);
          await drain(); now += 5000;
          for (const job of [...jobs]) {
            if (job.ms <= 5000) {
              job.fn();
            }
          }
          await timed; assert.equal(calls.length, 2);
          const interrupted = assert.rejects(f.accessory().getService(S.Switch).getCharacteristic(C.On).handleSetRequest(true),
            e => e === H.SERVICE_COMMUNICATION_FAILURE);
          await drain(); coordinator.setCredentials({ username: 'SYNTHETIC_REPLACEMENT', password: 'OTHER_SECRET' });
          await interrupted; assert.equal(calls.length, 3);
          await assert.rejects(target.handleSetRequest(C.TargetMediaState.PLAY), e => e === H.SERVICE_COMMUNICATION_FAILURE);
          assert.equal(calls.length, 3); // No replay across credential replacement.
        }
      } finally {
        host.emit('shutdown'); coordinator?.stop();
      }
      assert.equal(jobs.size, 0);
    });
  }

  await t.test('reentrant request getter revokes dispatch and immediate callback errors are contained', async () => {
    const f = await controls(); let dispatched = 0, count = 0;
    Object.defineProperty(f.reader, 'requestPlayback', { get() {
      f.manager.stop(); return () => {
        dispatched++; return { ok: true, outcome: 'confirmed' };
      };
    } });
    assert.doesNotThrow(() => f.target().emit('set', C.TargetMediaState.PLAY, status => {
      count++; assert.equal(status, H.SERVICE_COMMUNICATION_FAILURE); throw new Error('PRIVATE');
    }));
    await drain(); assert.equal(count, 1); assert.equal(dispatched, 0);
    assert.doesNotThrow(() => f.target().emit('set', C.TargetMediaState.STOP, () => {
      throw new Error('PRIVATE');
    }));
  });

  const switchOn = f => f.accessory().getService(S.Switch).getCharacteristic(C.On);
  await t.test('Playback Switch identity is stable and disabled composition remains unchanged', async () => {
    const f = await controls(), uuid = f.accessory().UUID, service = f.accessory().getService(S.Switch);
    assert.equal(service.displayName, 'Playback'); assert.equal(service.subtype, 'playback');
    for (let i = 0; i < 5; i++) {
      await f.refresh();
    }
    assert.equal(f.published.length, 1); assert.equal(f.accessory().UUID, uuid);
    assert.equal(f.accessory().getService(S.Switch), service); assert.equal(f.accessory().getService(S.SmartSpeaker).isPrimaryService, true);
    const disabled = setup(); await disabled.refresh(); assert.equal(disabled.accessory().getService(S.Switch), undefined);
  });
  for (const state of ['playing', 'paused', 'empty', 'unknown', 'inactive']) {
    await t.test('Switch authoritative read: ' + state, async () => {
      const f = await controls(); f.observation.playback = state; await f.refresh();
      if (state === 'playing' || state === 'paused') {
        assert.equal(await switchOn(f).handleGetRequest(), state === 'playing');
      } else {
        await unavailable(switchOn(f));
      }
      assert.equal(f.commands.length, 0);
    });
  }
  for (const viaSwitch of [true, false]) {
    await t.test('shared pending ownership and callback reconciliation, switch first=' + viaSwitch, async () => {
      const pending = defer(), f = await controls(() => pending.promise), on = switchOn(f);
      const first = viaSwitch ? on : f.target(), other = viaSwitch ? f.target() : on;
      const write = first.handleSetRequest(viaSwitch ? false : C.TargetMediaState.PAUSE);
      await assert.rejects(other.handleSetRequest(viaSwitch ? C.TargetMediaState.PLAY : true), e => e === H.RESOURCE_BUSY);
      assert.equal(on.value, true); assert.equal(f.commands.length, 1); assert.equal(f.commands[0].action, 'pause');
      let nested;
      first.on('change', event => {
        if (event.reason === 'write') {
          nested = rawWrite(other, viaSwitch ? C.TargetMediaState.PLAY : true);
        }
      });
      f.observation.playback = 'paused'; await f.refresh(); assert.equal(on.value, false);
      f.observation.playback = 'playing'; pending.resolve({ ok: true, outcome: 'confirmed' }); await write;
      assert.equal(await nested, H.RESOURCE_BUSY); assert.equal(on.value, true); assert.equal(f.target().value, C.TargetMediaState.PLAY);
    });
  }
  for (const mode of ['shutdown', 'revoked', 'account', 'last-known', 'offline']) {
    await t.test('Switch authority failure: ' + mode, async () => {
      const pending = defer(), f = await controls(() => pending.promise), on = switchOn(f);
      const failure = assert.rejects(on.handleSetRequest(false), e => e === H.SERVICE_COMMUNICATION_FAILURE);
      if (mode === 'shutdown') {
        f.manager.stop();
      } else if (mode === 'offline') {
        f.observation.transport.status = 'disconnected'; pending.resolve({ ok: false, reason: 'interrupted', delivery: 'uncertain' });
      } else {
        f.inventory = mode === 'revoked' ? { authority: 'none', devices: [] } : inventory([device()], mode === 'account' ? 'OTHER' : account,
          mode === 'last-known' ? 'last-known' : 'current');
      }
      await f.refresh(); await failure; pending.resolve({ ok: true, outcome: 'confirmed' }); await drain();
      await unavailable(on); assert.equal(f.commands.length, 1); f.manager.stop(); assert.equal(f.jobs.size, 0);
    });
  }
  await t.test('Switch rejects malformed inputs and maps true to play with exact identity', async () => {
    const f = await controls(() => ({ ok: true, outcome: 'already-satisfied' }));
    for (const value of [0, 1, 'true', null, undefined, {}]) {
      assert.equal(await rawWrite(switchOn(f), value), H.INVALID_VALUE_IN_REQUEST);
    }
    assert.equal(f.commands.length, 0); await switchOn(f).handleSetRequest(true);
    assert.equal(f.commands[0].action, 'play'); assert.deepEqual(f.commands[0].target, { accountUuid: account, routeId: 'SYNTHETIC_ROUTE', macAddress: mac });
  });

  for (const [reason, delivery, expected] of [
    ['busy', 'not-dispatched', H.RESOURCE_BUSY], ['not-ready', 'not-dispatched', H.SERVICE_COMMUNICATION_FAILURE],
    ['insufficient-state', 'not-dispatched', H.NOT_ALLOWED_IN_CURRENT_STATE], ['timeout', 'uncertain', H.SERVICE_COMMUNICATION_FAILURE],
  ]) {
    await t.test('Switch failure reconciliation: ' + reason, async () => {
      const f = await controls(() => ({ ok: false, reason, delivery }));
      await assert.rejects(switchOn(f).handleSetRequest(false), e => e === expected);
      assert.equal(switchOn(f).value, true); assert.equal(f.current().value, C.CurrentMediaState.PLAY);
      assert.equal(f.commands.length, 1);
    });
  }
  await t.test('independent devices have separate pending guards and publication failure cancels once', async () => {
    const pending = defer(), publication = defer();
    const f = await controls(() => pending.promise, { publish: () => publication.promise });
    const second = device('SECOND', 'SECOND_MAC'); f.inventory = inventory([device(), second]);
    f.reader.getDevice = id => {
      const result = observation('playing', id === 'SECOND' ? second : device());
      result.state.topics = { 'online-state': { session: 1, value: { onlineState: 'connected' } } }; return result;
    };
    await f.refresh(); const other = f.accessory(1).getService(S.Switch).getCharacteristic(C.On);
    let firstCount = 0, secondCount = 0;
    switchOn(f).emit('set', false, status => {
      firstCount++; assert.equal(status, H.SERVICE_COMMUNICATION_FAILURE);
    });
    other.emit('set', false, status => {
      secondCount++; assert.equal(status, H.SERVICE_COMMUNICATION_FAILURE);
    });
    assert.equal(f.commands.length, 2);
    publication.reject(new Error('PRIVATE')); await drain(); assert.equal(firstCount, 1); assert.equal(secondCount, 1);
    pending.resolve({ ok: true, outcome: 'confirmed' }); await drain();
    assert.equal(firstCount, 1); assert.equal(secondCount, 1); await unavailable(switchOn(f)); await unavailable(other);
  });

});
