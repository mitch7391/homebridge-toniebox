import type { API, Characteristic, PlatformAccessory } from 'homebridge';
import type { AccountCoordinator, ProductionInventory } from './toniebox/accountCoordinatorTypes.js';
import { PLUGIN_NAME } from './settings.js';

export type ProductionReader = Pick<AccountCoordinator, 'getProductionInventory' | 'getDevice'>;
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
  failed: boolean;
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

/** Read-only HAP projection. No backend state ownership, commands or storage. Only a bounded last-confirmed presentation.
 * One cancellable presentation grace deadline per accessory.
 * Homebridge owns pairing/server lifetime. A dispatched publication is never retried in-process:
 * its void API cannot distinguish failure before side effects from failure after publication. */
export class ProductionAccessories implements ProductionPresentation {
  readonly #api: API;
  readonly #timing: PresentationTiming;
  readonly #warn: (message: string) => void;
  #reader?: ProductionReader;
  #entries = new Map<string, Entry>();
  #warnings = new Set<string>();
  #stopped = false;
  #queued = false;
  #epoch: object = {};

  constructor(api: API, reader: ProductionReader, warn: (message: string) => void, timing: PresentationTiming = {}) {
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
      // Only explicit live, current-session physical disconnection bypasses the grace period.
      if (online && ['disconnected', 'offline'].includes(online.value.onlineState) && online.retained === false
        && online.session === observation.transport.session && observation.freshness['online-state'] === 'observed') {
        this.#clearOutage(entry);
        entry.outage = { start: 0, last: 0, expired: true };
        entry.confirmed = undefined;
        return APPLE_MEDIA_UNKNOWN;
      }
      if (observation.freshness['playback/state'] === 'observed'
        && ['playing', 'paused', 'empty'].includes(observation.playback)) {
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
    // Reconnection/retained history alone cannot restore PLAY or restart the deadline.
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
    const target = speaker.getCharacteristic(C.TargetMediaState);
    target.on('get', callback => callback(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    target.on('set', (_value, callback) => callback(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE));
    target.updateValue(this.#unavailable()); // No desired physical state is known or commanded.
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
    } catch { /* Fault one accessory, never the backend or unrelated accessories. */
      this.#fault(entry);
    }
  }
  #fault(entry: Entry): void {
    this.#clearOutage(entry); entry.confirmed = undefined; entry.session = undefined;
    try {
      entry.current?.updateValue(this.#unavailable());
    } catch { /* A broken host characteristic cannot regain read authority. */ }
  }
  refresh(): void {
    if (this.#stopped) {
      return;
    }
    this.#epoch = {};
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
