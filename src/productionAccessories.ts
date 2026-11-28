import type { API, Characteristic, PlatformAccessory } from 'homebridge';
import type { AccountCoordinator, PlaybackTarget, ProductionInventory } from './toniebox/accountCoordinatorTypes.js';
import { PLUGIN_NAME } from './settings.js';

export type ProductionReader = Pick<AccountCoordinator, 'getProductionInventory' | 'getDevice'>
  & Partial<Pick<AccountCoordinator, 'requestPlayback'>>;
export interface PlaybackPresentationOptions { readonly enablePlaybackCommands?: boolean }
interface PendingWrite {
  readonly target: PlaybackTarget;
  readonly controller: AbortController;
  readonly callback: (status: number | null) => void;
  settled: boolean;
}
/** One-shot presentation deadline only; never a backend retry or poll. */
export interface PresentationTiming {
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, ms: number) => () => void;
}
// Apple HMCharacteristicValueCurrentMediaState.unknown = 3; absent from HAP-NodeJS 2.2.2 constants.
// https://developer.apple.com/documentation/homekit/hmcharacteristicvaluecurrentmediastate
const APPLE_MEDIA_UNKNOWN = 3;
const OFFLINE_GRACE_MS = 10000;
interface Outage { readonly start: number; last: number; expired: boolean; cancel?: () => void }
export interface ProductionPresentation { refresh(): void; stop(): void }
// External accessories cannot be publicly unpublished. Bound the process-lifetime registry too.
const MAX_EXTERNAL_ACCESSORIES = 100;
const owners = new WeakSet<API>();
interface Entry {
  readonly uuid: string;
  accessory?: PlatformAccessory;
  current?: Characteristic;
  target?: Characteristic;
  playbackSwitch?: Characteristic;
  switchRecoveryPending?: boolean; // Notification history only; GET/SET can independently clear HAP status.
  pending?: PendingWrite;
  failed: boolean;
  published?: boolean;
  outage?: Outage;
  timingFailed?: boolean;
  confirmed?: number;
  session?: number;
}
type Inventory = Extract<ProductionInventory, { accountUuid: string }>;
const text = (s: unknown): s is string => typeof s === 'string' && s.length <= 4096 && /\S/u.test(s)
  && ![...s].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Private account namespace. Keep the version and tuple encoding stable across restarts.
 * MAC spelling is normalised exactly as in routing; physical MAC stability remains a cloud assumption. */
export function productionAccessoryUuid(api: Pick<API, 'hap'>, account: string, mac: string): string {
  return api.hap.uuid.generate(JSON.stringify([PLUGIN_NAME, 'external-smartspeaker', 1, account, mac.toUpperCase()]));
}

/** Observed HAP projection with an explicit, default-disabled coordinator command adapter.
 * No backend state ownership or storage. Only a bounded last-confirmed presentation.
 * One cancellable presentation grace deadline per accessory.
 * Homebridge owns pairing/server lifetime. A dispatched publication is never retried in-process:
 * its void API cannot distinguish failure before side effects from failure after publication. */
export class ProductionAccessories implements ProductionPresentation {
  readonly #api: API;
  readonly #timing: PresentationTiming;
  readonly #commands: boolean;
  readonly #warn: (message: string) => void;
  #reader?: ProductionReader;
  #entries = new Map<string, Entry>();
  #warnings = new Set<string>();
  #stopped = false;
  #queued = false;
  #epoch: object = {};

  constructor(api: API, reader: ProductionReader, warn: (message: string) => void,
    timing: PresentationTiming = {}, commands: PlaybackPresentationOptions = {}) {
    this.#commands = commands.enablePlaybackCommands === true;
    this.#timing = timing; this.#api = api; this.#reader = reader; this.#warn = warn;
    // Singular platform: a second owner in the same Homebridge process must not republish externals.
    if (owners.has(api)) {
      this.#stopped = true; this.#reader = undefined;
    } else {
      owners.add(api);
    }
  }
  #notice(kind: 'inventory' | 'publication' | 'capacity'): void {
    if (this.#warnings.has(kind) || this.#stopped) {
      return;
    }
    this.#warnings.add(kind);
    const messages = {
      inventory: 'Toniebox presentation inventory unavailable; accessories remain unavailable until verified.',
      publication: 'Toniebox accessory publication requires attention; restart after resolving the Homebridge error.',
      capacity: 'Toniebox external accessory lifetime limit reached; new publication deferred until restart.',
    };
    try {
      void Promise.resolve(this.#warn(messages[kind])).catch(() => undefined);
    } catch { /* Diagnostics never own backend or HAP authority. */ }
  }
  #inventory(): Inventory | undefined {
    const input = this.#reader?.getProductionInventory();
    if (this.#stopped || !input) {
      return undefined;
    }
    if (input.authority === 'none' && Array.isArray(input.devices) && input.devices.length === 0) {
      return undefined;
    }
    if ((input.authority !== 'current' && input.authority !== 'last-known') || input.identitySource !== 'uuid'
      || !text(input.accountUuid) || !Array.isArray(input.devices) || input.devices.length > 100) {
      throw new Error('Invalid presentation inventory');
    }
    const ids = new Set<string>(), macs = new Set<string>();
    const devices = input.devices.map(d => {
      if (!d || !text(d.routeId) || !text(d.macAddress) || /[\s/+#]/u.test(d.macAddress)) {
        throw new Error('Invalid presentation identity');
      }
      const mac = d.macAddress.toUpperCase();
      if (ids.has(d.routeId) || macs.has(mac)) {
        throw new Error('Ambiguous presentation inventory');
      }
      ids.add(d.routeId); macs.add(mac);
      return { routeId: d.routeId, macAddress: mac,
        displayName: text(d.displayName) ? d.displayName.slice(0, 64) : 'Toniebox' };
    });
    return { authority: input.authority, identitySource: 'uuid', accountUuid: input.accountUuid, devices };
  }
  #route(entry: Entry) {
    if (this.#stopped || entry.failed) {
      return undefined;
    }
    const inventory = this.#inventory();
    if (inventory?.authority !== 'current') {
      return undefined;
    }
    return inventory.devices.find(d => productionAccessoryUuid(this.#api, inventory.accountUuid, d.macAddress) === entry.uuid);
  }
  #commandTarget(entry: Entry): PlaybackTarget | undefined {
    if (this.#stopped || entry.failed || !entry.published) {
      return undefined;
    }
    const inventory = this.#inventory();
    if (inventory?.authority !== 'current') {
      return undefined;
    }
    const route = inventory.devices.find(d => productionAccessoryUuid(this.#api, inventory.accountUuid, d.macAddress) === entry.uuid);
    return route && { accountUuid: inventory.accountUuid, routeId: route.routeId, macAddress: route.macAddress };
  }
  #ownsWrite(entry: Entry, pending: PendingWrite): boolean {
    const target = this.#commandTarget(entry);
    return !this.#stopped && !entry.failed && entry.pending === pending && !!target
      && target.accountUuid === pending.target.accountUuid && target.routeId === pending.target.routeId
      && target.macAddress === pending.target.macAddress;
  }
  #finishWrite(entry: Entry, pending: PendingWrite, status: number | null): void {
    if (entry.pending !== pending || pending.settled) {
      return;
    }
    pending.settled = true;
    try {
      pending.controller.abort();
    } catch { /* Local cancellation cannot retract a transmitted command. */ }
    try {
      if (!this.#ownsWrite(entry, pending)) {
        status = this.#api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
      }
    } catch {
      status = this.#api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
    }
    if (this.#stopped || entry.failed) {
      status = this.#api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
    }
    try {
      pending.callback(status);
    } catch { /* Host callback failures must not escape or cause another acknowledgement. */ } finally {
      // HAP's callback synchronously caches the submitted value. Reconcile afterwards,
      // retaining the busy guard through both the callback and characteristic notifications.
      this.#sync(entry);
      if (entry.pending === pending) {
        entry.pending = undefined;
      }
    }
  }
  #cancelWrite(entry: Entry): void {
    if (entry.pending) {
      this.#finishWrite(entry, entry.pending, this.#api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }
  #write(entry: Entry, value: unknown, callback: (status: number | null) => void): void {
    const { HAPStatus: H } = this.#api.hap;
    const C = this.#api.hap.Characteristic.TargetMediaState;
    if (!this.#commands) {
      callback(H.NOT_ALLOWED_IN_CURRENT_STATE); return;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || ![C.PLAY, C.PAUSE, C.STOP].includes(value)) {
      callback(H.INVALID_VALUE_IN_REQUEST); return;
    }
    if (value === C.STOP) {
      callback(H.NOT_ALLOWED_IN_CURRENT_STATE); return;
    }
    if (entry.pending) {
      callback(H.RESOURCE_BUSY); return;
    }
    // Reserve before invoking inventory getters or dependency callbacks.
    const pending: PendingWrite = { target: { accountUuid: '', routeId: '', macAddress: '' },
      controller: new AbortController(), callback, settled: false };
    entry.pending = pending;
    try {
      const target = this.#commandTarget(entry);
      const reader = this.#reader, request = reader?.requestPlayback;
      if (!target || typeof request !== 'function' || this.#stopped || pending.settled) {
        this.#finishWrite(entry, pending, H.SERVICE_COMMUNICATION_FAILURE); return;
      }
      Object.assign(pending.target, target);
      if (!this.#ownsWrite(entry, pending) || pending.settled) {
        this.#finishWrite(entry, pending, H.SERVICE_COMMUNICATION_FAILURE); return;
      }
      const result = request.call(reader, { ...target }, value === C.PLAY ? 'play' : 'pause', { signal: pending.controller.signal });
      void Promise.resolve(result).then(outcome => {
        let status: number | null = H.SERVICE_COMMUNICATION_FAILURE;
        if (outcome?.ok === true && ['confirmed', 'already-satisfied'].includes(outcome.outcome)) {
          status = null;
        } else if (outcome?.ok === false && outcome.delivery === 'not-dispatched') {
          if (outcome.reason === 'busy' || outcome.reason === 'capacity') {
            status = H.RESOURCE_BUSY;
          } else if (outcome.reason === 'insufficient-state') {
            status = H.NOT_ALLOWED_IN_CURRENT_STATE;
          } else if (outcome.reason === 'invalid-input') {
            status = H.INVALID_VALUE_IN_REQUEST;
          }
        }
        this.#finishWrite(entry, pending, status);
      }).catch(() => this.#finishWrite(entry, pending, H.SERVICE_COMMUNICATION_FAILURE));
    } catch {
      this.#finishWrite(entry, pending, H.SERVICE_COMMUNICATION_FAILURE);
    }
  }
  #targetMedia(entry: Entry): number {
    const epoch = this.#epoch;
    const target = this.#commandTarget(entry);
    const observation = target && this.#reader?.getDevice(target.routeId, 'production');
    const still = this.#commandTarget(entry);
    if (epoch !== this.#epoch || !target || !still || target.accountUuid !== still.accountUuid || target.routeId !== still.routeId
      || target.macAddress !== still.macAddress || this.#stopped || entry.failed
      || observation?.state.identity.id !== target.routeId || observation.state.identity.macAddress !== target.macAddress
      || observation.transport.status !== 'connected') {
      throw this.#unavailable();
    }
    const online = observation.state.topics?.['online-state'];
    if (online?.session !== observation.transport.session || online?.value.onlineState !== 'connected') {
      throw this.#unavailable();
    }
    const C = this.#api.hap.Characteristic.TargetMediaState;
    if (observation.playback === 'playing') {
      return C.PLAY;
    }
    if (observation.playback === 'paused') {
      return C.PAUSE;
    }
    if (observation.playback === 'empty') {
      return C.STOP;
    }
    throw this.#unavailable();
  }
  #switchValue(entry: Entry): boolean {
    const value = this.#targetMedia(entry), C = this.#api.hap.Characteristic.TargetMediaState;
    if (value === C.PLAY) {
      return true;
    }
    // Off means confirmed playback is not active, including empty (STOP), never unknown.
    // Read feedback does not grant permission: writes still use coordinator admission.
    if (value === C.PAUSE || value === C.STOP) {
      return false;
    }
    throw this.#unavailable();
  }
  #unavailable(): Error {
    return new this.#api.hap.HapStatusError(this.#api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  #clearOutage(entry: Entry): void {
    const old = entry.outage; entry.outage = undefined;
    try {
      old?.cancel?.();
    } catch { /* Revoked timer callbacks are inert even if cancellation fails. */ }
  }
  #arm(entry: Entry, outage: Outage): void {
    try {
      const now = (this.#timing.now ?? (() => performance.now()))();
      if (!Number.isFinite(now) || now < outage.last) {
        throw new Error('Invalid presentation clock');
      }
      outage.last = now;
      const remaining = Math.max(0, OFFLINE_GRACE_MS - (now - outage.start));
      if (remaining === 0) {
        outage.expired = true; this.refresh(); return;
      }
      let scheduling = true;
      const cancel = (this.#timing.schedule ?? ((fn, ms) => {
        const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer);
      }))(() => {
        if (this.#stopped || entry.outage !== outage) {
          return;
        }
        if (scheduling) {
          entry.timingFailed = true; this.#clearOutage(entry); return;
        }
        outage.cancel = undefined;
        this.#arm(entry, outage);
      }, remaining);
      scheduling = false;
      if (typeof cancel !== 'function') {
        throw new Error('Invalid presentation scheduler');
      }
      outage.cancel = cancel;
      if (this.#stopped || entry.outage !== outage) {
        cancel();
      }
    } catch {
      entry.timingFailed = true; this.#clearOutage(entry);
    }
  }
  #media(entry: Entry): number {
    const epoch = this.#epoch;
    let observation;
    try {
      const route = this.#route(entry);
      if (!route) {
        throw this.#unavailable();
      }
      observation = this.#reader?.getDevice(route.routeId, 'production');
      const still = this.#route(entry);
      if (!observation && !this.#stopped && epoch === this.#epoch && still?.routeId === route.routeId) {
        this.#clearOutage(entry); entry.confirmed = undefined; entry.session = undefined;
        return APPLE_MEDIA_UNKNOWN;
      }
      if (this.#stopped || epoch !== this.#epoch || still?.routeId !== route.routeId
        || observation?.state.identity.id !== route.routeId || observation.state.identity.macAddress !== route.macAddress
        || !['connected', 'disconnected'].includes(observation.transport.status)) {
        throw this.#unavailable();
      }
    } catch {
      this.#clearOutage(entry); entry.confirmed = undefined; entry.session = undefined; throw this.#unavailable();
    }
    const C = this.#api.hap.Characteristic.CurrentMediaState;
    if (observation.transport.status === 'connected') {
      const online = observation.state.topics?.['online-state'];
      // Current-session physical disconnection (live or retained) bypasses the transport grace.
      if (online && ['disconnected', 'offline'].includes(online.value.onlineState)
        && online.session === observation.transport.session) {
        this.#clearOutage(entry);
        entry.outage = { start: 0, last: 0, expired: true };
        entry.confirmed = undefined;
        return APPLE_MEDIA_UNKNOWN;
      }
      if (['playing', 'paused', 'empty'].includes(observation.playback)) {
        this.#clearOutage(entry); entry.timingFailed = false;
        entry.session = observation.transport.session;
        entry.confirmed = observation.playback === 'playing' ? C.PLAY : observation.playback === 'paused' ? C.PAUSE : C.STOP;
        return entry.confirmed;
      }
      // The backend projection already applies playbackActivity's session and retained-message rules.
      if (observation.playback === 'inactive') {
        this.#clearOutage(entry); entry.confirmed = undefined; return APPLE_MEDIA_UNKNOWN;
      }
    }
    if ((observation.transport.status === 'disconnected' || (entry.session !== undefined
      && entry.session !== observation.transport.session)) && !entry.outage && !entry.timingFailed) {
      try {
        const now = (this.#timing.now ?? (() => performance.now()))();
        if (!Number.isFinite(now) || now < 0) {
          throw new Error('Invalid presentation clock');
        }
        const outage: Outage = { start: now, last: now, expired: false }; entry.outage = outage;
        this.#arm(entry, outage);
      } catch {
        entry.timingFailed = true; this.#clearOutage(entry);
      }
    }
    // Readiness alone cannot restore PLAY or restart the deadline; usable playback above cancels it.
    if (entry.outage?.expired) {
      entry.confirmed = undefined; return APPLE_MEDIA_UNKNOWN;
    }
    if (entry.outage && !entry.timingFailed) {
      return entry.confirmed ?? APPLE_MEDIA_UNKNOWN;
    }
    entry.confirmed = undefined;
    return APPLE_MEDIA_UNKNOWN;
  }
  #build(entry: Entry): void {
    const { Service: S, Characteristic: C, Categories, HAPStatus } = this.#api.hap;
    // Generic wrapper name keeps Homebridge's publication logs free of the private device name.
    const accessory = new this.#api.platformAccessory('Toniebox', entry.uuid, Categories.SPEAKER);
    entry.accessory = accessory;
    const info = accessory.getService(S.AccessoryInformation)!;
    info.setCharacteristic(C.Manufacturer, 'Tonies');
    info.setCharacteristic(C.Model, 'Toniebox');
    info.setCharacteristic(C.SerialNumber, entry.uuid); // Opaque account-scoped HAP identity, never raw MAC/account.
    // Retain Homebridge's harmless Identify acknowledgement; no physical identify listener is installed.
    const speaker = accessory.addService(S.SmartSpeaker, 'Toniebox');
    speaker.setPrimaryService(true);
    const current = speaker.getCharacteristic(C.CurrentMediaState); entry.current = current;
    current.setProps({ validValues: [...new Set([...(current.props.validValues ?? []), APPLE_MEDIA_UNKNOWN])].sort((a, b) => a - b) });
    // Public synchronous callback prevents onGet's awaited return from restoring a revoked cached value.
    current.on('get', callback => {
      let value: number;
      try {
        value = this.#media(entry);
      } catch {
        callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE); return;
      }
      callback(null, value);
    });
    current.updateValue(this.#unavailable());
    const target = speaker.getCharacteristic(C.TargetMediaState); entry.target = target;
    target.on('get', callback => {
      let value: number;
      try {
        if (!this.#commands) {
          throw this.#unavailable();
        }
        value = this.#targetMedia(entry);
      } catch {
        callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE); return;
      }
      callback(null, value);
    });
    target.on('set', (value, callback) => this.#write(entry, value, status => {
      try {
        callback(status);
      } catch { /* Host callbacks never escape the adapter, including immediate rejection. */ }
    }));
    target.updateValue(this.#unavailable()); // No desired physical state is known or commanded.
    if (this.#commands) {
      const playback = accessory.addService(S.Switch, 'Playback', 'playback');
      const on = playback.getCharacteristic(C.On); entry.playbackSwitch = on;
      entry.switchRecoveryPending = true;
      on.updateValue(this.#unavailable());
      on.on('get', callback => {
        let value: boolean;
        try {
          value = this.#switchValue(entry);
        } catch {
          entry.switchRecoveryPending = true;
          callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE); return;
        }
        callback(null, value);
      });
      on.on('set', (value, callback) => {
        const done = (status: number | null): void => {
          try {
            callback(status);
          } catch { /* Host callbacks cannot escape the shared command adapter. */ }
        };
        if (typeof value !== 'boolean') {
          done(HAPStatus.INVALID_VALUE_IN_REQUEST); return;
        }
        this.#write(entry, value ? C.TargetMediaState.PLAY : C.TargetMediaState.PAUSE, done);
      });
    }
    const name = speaker.getCharacteristic(C.ConfiguredName);
    const initialRoute = this.#route(entry);
    name.updateValue(initialRoute?.displayName ?? this.#unavailable());
    name.on('get', callback => {
      try {
        const route = this.#route(entry);
        if (!route) {
          callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE); return;
        }
        callback(null, route.displayName ?? 'Toniebox');
      } catch {
        callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    });
    name.on('set', (_value, callback) => callback(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
  }
  #sync(entry: Entry): void {
    try {
      if (entry.pending && !entry.pending.settled && !this.#ownsWrite(entry, entry.pending)) {
        this.#cancelWrite(entry);
      }
      const route = this.#route(entry);
      if (route && entry.accessory) {
        const name = entry.accessory.getService(this.#api.hap.Service.SmartSpeaker)!
          .getCharacteristic(this.#api.hap.Characteristic.ConfiguredName);
        if (name.value !== route.displayName || name.statusCode !== 0) {
          name.updateValue(route.displayName ?? 'Toniebox');
        }
      }
      let value: number | Error;
      try {
        value = this.#media(entry);
      } catch {
        value = this.#unavailable();
      }
      if (entry.current && (value instanceof Error || entry.current.value !== value || entry.current.statusCode !== 0)) {
        entry.current.updateValue(value);
      }
      if (this.#commands && entry.target) {
        let target: number | Error;
        try {
          target = this.#targetMedia(entry);
        } catch {
          target = this.#unavailable();
        }
        if (target instanceof Error || entry.target.value !== target || entry.target.statusCode !== 0) {
          entry.target.updateValue(target);
        }
      }
      if (entry.playbackSwitch) {
        let value: boolean | Error;
        try {
          value = this.#switchValue(entry);
        } catch {
          value = this.#unavailable();
        }
        if (value instanceof Error) {
          entry.switchRecoveryPending = true;
          entry.playbackSwitch.updateValue(value); // HAP errors are available to reads, not event notifications.
        } else if (entry.switchRecoveryPending) {
          // HAP retains the Boolean during errors and filters ordinary same-value recovery.
          // A GET may already have cleared statusCode. Consume before synchronous event reentrancy;
          // a nested fault can then mark recovery pending again without being overwritten here.
          entry.switchRecoveryPending = false;
          entry.playbackSwitch.sendEventNotification(value);
        } else if (entry.playbackSwitch.value !== value || entry.playbackSwitch.statusCode !== 0) {
          entry.playbackSwitch.updateValue(value);
        }
      }
    } catch { /* Fault one accessory, never the backend or unrelated accessories. */
      this.#fault(entry);
    }
  }
  #fault(entry: Entry): void {
    this.#cancelWrite(entry);
    this.#clearOutage(entry); entry.confirmed = undefined; entry.session = undefined;
    entry.switchRecoveryPending = true;
    try {
      entry.current?.updateValue(this.#unavailable());
      entry.target?.updateValue(this.#unavailable());
      entry.playbackSwitch?.updateValue(this.#unavailable());
    } catch { /* A broken host characteristic cannot regain read authority. */ }
  }
  refresh(): void {
    if (this.#stopped) {
      return;
    }
    this.#epoch = {};
    for (const entry of this.#entries.values()) {
      if (entry.pending && !entry.pending.settled) {
        try {
          if (!this.#ownsWrite(entry, entry.pending)) {
            this.#cancelWrite(entry);
          }
        } catch {
          this.#cancelWrite(entry);
        }
      }
    }
    if (this.#queued) {
      return;
    }
    this.#queued = true;
    void Promise.resolve().then(() => {
      this.#queued = false;
      if (this.#stopped) {
        return;
      }
      const epoch = this.#epoch;
      try {
        const inventory = this.#inventory();
        if (inventory?.authority === 'current') {
          const desired = inventory.devices.map(d => productionAccessoryUuid(this.#api, inventory.accountUuid, d.macAddress));
          if (new Set(desired).size !== desired.length) {
            throw new Error('Ambiguous presentation UUID');
          }
          const missing = desired.filter(uuid => !this.#entries.has(uuid));
          // No arbitrary truncation; retain existing accessories but admit none of an oversized new set.
          if (this.#entries.size + missing.length > MAX_EXTERNAL_ACCESSORIES) {
            this.#notice('capacity');
          } else {
            for (const uuid of missing) {
              if (this.#stopped || this.#epoch !== epoch) {
                break;
              }
              const entry: Entry = { uuid, failed: false };
              this.#entries.set(uuid, entry); // Reserve identity before any reentrant host callback.
              try {
                this.#build(entry);
                if (this.#stopped || this.#epoch !== epoch || !this.#route(entry)) {
                  entry.failed = true; this.#fault(entry); continue;
                }
                // Public API returns void, not confirmation. Never log or infer publication success.
                const returned: unknown = this.#api.publishExternalAccessories(PLUGIN_NAME, [entry.accessory!]);
                entry.published = true;
                void Promise.resolve(returned).catch(() => {
                  entry.failed = true; this.#fault(entry); this.#notice('publication');
                });
              } catch {
                entry.failed = true; this.#fault(entry); this.#notice('publication');
              }
            }
          }
        }
        for (const entry of this.#entries.values()) {
          if (this.#stopped || this.#epoch !== epoch) {
            break;
          }
          this.#sync(entry);
        }
      } catch {
        for (const entry of this.#entries.values()) {
          this.#fault(entry);
        }
        this.#notice('inventory');
      }
    }).catch(() => undefined);
  }
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true; this.#reader = undefined; this.#epoch = {};
    for (const entry of this.#entries.values()) {
      this.#fault(entry);
    }
    // Do not unregister bridged accessories or reach into Homebridge's private external servers.
  }
}
