import { COMMISSIONING_BUILD } from './toniebox/commissioning.js';
import { performance } from 'node:perf_hooks';
import { createAccountCoordinator } from './toniebox/accountCoordinator.js';
import type { AuthCredentials } from './toniebox/authTypes.js';
import type { AccountCoordinator, CoordinatorResult, CoordinatorStatus } from './toniebox/accountCoordinatorTypes.js';

export interface PlatformRuntimeOptions {
  readonly coordinatorFactory?: (onStatus: (status: CoordinatorStatus) => void) => AccountCoordinator;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly jitter?: () => number;
}
export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
}
const messages = {
  starting: 'Toniebox backend starting.',
  missing: 'Toniebox credentials are not configured; backend inactive.',
  invalid: 'Toniebox credentials are invalid or incomplete; backend inactive.',
  complete: 'Toniebox discovery completed.',
  partial: 'Toniebox discovery incomplete; no automatic rediscovery scheduled.',
  retry: 'Toniebox discovery temporarily unavailable; retry scheduled.',
  authentication: 'Toniebox authentication requires attention.',
  permission: 'Toniebox discovery permission requires attention.',
  attention: 'Toniebox backend requires attention; automatic discovery paused.',
  connected: 'Toniebox production connection established.',
  reconnecting: 'Toniebox production connection retrying.',
  interrupted: 'Toniebox production connection interrupted.',
  productionAttention: 'Toniebox production connection requires attention.',
  experimentalAttention: 'Toniebox experimental connectivity requires attention.',
  shutdown: 'Toniebox backend shutdown.',
} as const;
type Notice = keyof typeof messages;
const reasons = ['complete', 'incomplete', 'transient', 'rate-limited', 'authentication', 'permission', 'invalid-response',
  'deadline', 'token-expired', 'cancelled', 'invalidated', 'stopped', 'clock-invalid', 'dependency', 'not-ready'];
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const quietly = (fn: () => void): void => {
  try {
    fn();
  } catch { /* Revoked authority never depends on successful cleanup. */ }
};
const schedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms); timer.unref(); return () => clearTimeout(timer);
};
interface Flight { controller: AbortController }
interface Alarm { cancel?: () => void }

/** Homebridge lifetime adapter only: all account, routing and MQTT algorithms remain in the coordinator. */
export class PlatformRuntime {
  readonly #log: RuntimeLogger;
  readonly #options: PlatformRuntimeOptions;
  #credentials?: AuthCredentials;
  #configuration: 'valid' | 'missing' | 'invalid' = 'invalid';
  #launched = false;
  #stopped = false;
  #coordinator?: AccountCoordinator;
  #flight?: Flight;
  #alarm?: Alarm;
  #retry = 0;
  #lastTime = 0;
  #lastNotice = new Map<string, Notice>();
  #logged = new Map<Notice, number>();

  constructor(config: unknown, log: RuntimeLogger, options: PlatformRuntimeOptions = {}) {
    this.#log = log; this.#options = { ...options };
    try {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return;
      }
      const { username, password } = config as { username?: unknown; password?: unknown };
      if (username === undefined && password === undefined) {
        this.#configuration = 'missing';
      } else if (typeof username === 'string' && /\S/u.test(username) && typeof password === 'string' && password.length > 0) {
        this.#credentials = { username, password }; this.#configuration = 'valid';
      }
    } catch { /* Configuration getters cannot escape or expose values. */ }
  }
  #now(): number {
    const now = (this.#options.now ?? (() => performance.now()))();
    if (!finite(now) || now < this.#lastTime) {
      throw new Error('Invalid runtime clock');
    }
    this.#lastTime = now; return now;
  }
  #notice(key: Notice, channel = key as string): void {
    if (this.#stopped && key !== 'shutdown') {
      return;
    }
    if (this.#lastNotice.get(channel) === key) {
      return;
    }
    this.#lastNotice.set(channel, key);
    // Fixed-size key set; flapping logs need no timer and never include dependency metadata.
    let now = this.#lastTime;
    try {
      now = this.#now();
    } catch { /* Logging must not obstruct shutdown. */ }
    const prior = this.#logged.get(key);
    if (prior !== undefined && now - prior < 60000) {
      return;
    }
    this.#logged.set(key, now);
    try {
      const returned: unknown = ['starting', 'missing', 'complete', 'connected', 'shutdown'].includes(key)
        ? this.#log.info(messages[key]) : this.#log.warn(messages[key]);
      void Promise.resolve(returned).catch(() => undefined);
    } catch { /* Logger failures do not change runtime ownership. */ }
  }
  #fault(): void {
    if (!this.#stopped) {
      this.#notice('attention'); this.stop();
    }
  }
  #status(raw: CoordinatorStatus): void {
    if (this.#stopped) {
      return;
    }
    try {
      const production = raw.connections.find(c => c.lane === 'production');
      if (production?.status.connected && production.status.phase === 'ready') {
        this.#notice('connected', 'production');
      } else if (production?.status.phase === 'waiting-retry') {
        this.#notice('reconnecting', 'production');
      } else if (production?.status.phase === 'attention-required') {
        this.#notice('productionAttention', 'production');
      } else if (production && this.#lastNotice.has('production')) {
        this.#notice('interrupted', 'production');
      }
      if (this.#stopped) {
        return;
      }
      if (raw.experimentalAdmission === 'resource-limit'
        || raw.connections.some(c => c.lane === 'experimental' && c.status.phase === 'attention-required')) {
        this.#notice('experimentalAttention', 'experimental');
      } else {
        this.#lastNotice.delete('experimental');
      }
      if (!this.#stopped && raw.phase === 'attention-required' && raw.connections.length === 0) {
        this.#notice(raw.reason === 'authentication' ? 'authentication' : 'attention');
      }
    } catch {
      this.#fault();
    }
  }
  launch(): void {
    if (this.#launched || this.#stopped) {
      return;
    }
    this.#launched = true;
    if (!this.#credentials) {
      this.#notice(this.#configuration === 'missing' ? 'missing' : 'invalid'); return;
    }
    try {
      this.#now(); this.#notice('starting');
      if (this.#stopped) {
        return;
      }
      const coordinator = (this.#options.coordinatorFactory ?? (onStatus => createAccountCoordinator({ onStatus,
        ...(COMMISSIONING_BUILD ? { onCommissioning: event => {
          if (!this.#stopped) {
            try {
              void Promise.resolve(this.#log.info('Toniebox commissioning ' + JSON.stringify(event))).catch(() => undefined);
            } catch { /* Passive diagnostics cannot affect ownership. */ }
          }
        } } : {}),
      })))(s => this.#status(s));
      if (this.#stopped) {
        quietly(() => coordinator.stop()); return;
      }
      this.#coordinator = coordinator;
      if (COMMISSIONING_BUILD) {
        try {
          void Promise.resolve(this.#log.info('Toniebox commissioning diagnostics active; bounded output.')).catch(() => undefined);
        } catch { /* No operational consequence. */ }
      }
      if (this.#stopped) {
        return;
      }
      const credentials = this.#credentials; this.#credentials = undefined;
      const supplied = coordinator.setCredentials(credentials);
      if (this.#stopped) {
        return;
      }
      if (supplied?.ok !== true) {
        this.#fault(); return;
      }
      this.#dispatch(true);
    } catch {
      this.#fault();
    } finally {
      this.#credentials = undefined;
    }
  }
  #dispatch(initial = false): void {
    if (this.#stopped || this.#flight || this.#alarm) {
      return;
    }
    const flight: Flight = { controller: new AbortController() }; this.#flight = flight;
    try {
      if (initial && this.#coordinator!.start()?.ok !== true) {
        this.#fault(); return;
      }
      if (this.#stopped || this.#flight !== flight) {
        return;
      }
      // start() installs its run synchronously. Join it now, before yielding or observing status.
      const promise = this.#coordinator!.discover({ signal: flight.controller.signal });
      void Promise.resolve(promise).then(result => {
        if (this.#stopped || this.#flight !== flight) {
          return;
        }
        this.#flight = undefined;
        try {
          this.#settled(result);
        } catch {
          this.#fault();
        }
      }, () => {
        if (!this.#stopped && this.#flight === flight) {
          this.#fault();
        }
      });
    } catch {
      this.#fault();
    }
  }
  #settled(result: CoordinatorResult): void {
    const advice = result?.recovery;
    if (!result || typeof result.ok !== 'boolean' || !advice || !reasons.includes(advice.reason)
      || !['complete', 'partial', 'unknown'].includes(advice.coverage)
      || !['retry', 'attention', 'none'].includes(advice.disposition)) {
      this.#notice('attention'); return;
    }
    if (result.ok) {
      if (advice.disposition !== 'none' || (advice.coverage !== 'complete' && advice.coverage !== 'partial')) {
        this.#notice('attention'); return;
      }
      this.#notice(advice.coverage === 'complete' ? 'complete' : 'partial'); return;
    }
    if (advice.disposition === 'attention') {
      this.#notice(advice.reason === 'authentication' ? 'authentication' : advice.reason === 'permission' ? 'permission' : 'attention');
      return;
    }
    if (advice.disposition !== 'retry') {
      return;
    }
    if (!['transient', 'rate-limited', 'authentication', 'deadline', 'token-expired'].includes(advice.reason)
      || advice.coverage === 'complete' || (advice.minimumRetryDelayMs !== undefined && !finite(advice.minimumRetryDelayMs))) {
      this.#notice('attention'); return;
    }
    const random = (this.#options.jitter ?? Math.random)();
    if (!finite(random) || random > 1) {
      throw new Error('Invalid jitter');
    }
    const base = [30000, 120000, 300000, 900000][this.#retry];
    this.#retry = Math.min(3, this.#retry + 1);
    const duration = Math.ceil(Math.max(base * (1 + random * 0.2), advice.minimumRetryDelayMs ?? 0));
    const start = this.#now();
    this.#notice('retry', 'discovery');
    if (!this.#stopped) {
      this.#arm(start, duration);
    }
  }
  #arm(start: number, duration: number): void {
    if (this.#stopped) {
      return;
    }
    // Relative monotonic deadline avoids unsafe start + duration arithmetic for long server delays.
    const remaining = Math.max(0, duration - (this.#now() - start));
    if (remaining === 0) {
      this.#dispatch(); return;
    }
    const alarm: Alarm = {}; this.#alarm = alarm;
    let scheduling = true;
    const cancel = (this.#options.schedule ?? schedule)(() => {
      if (this.#stopped || this.#alarm !== alarm) {
        return;
      }
      if (scheduling) {
        this.#fault(); return;
      }
      this.#alarm = undefined;
      quietly(() => alarm.cancel?.());
      try {
        this.#arm(start, duration);
      } catch {
        this.#fault();
      }
    }, Math.min(2147483647, remaining));
    scheduling = false;
    if (typeof cancel !== 'function') {
      throw new Error('Invalid scheduler');
    }
    alarm.cancel = cancel;
    if (this.#stopped || this.#alarm !== alarm) {
      quietly(cancel);
    }
  }
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const alarm = this.#alarm, flight = this.#flight, coordinator = this.#coordinator;
    this.#alarm = undefined; this.#flight = undefined; this.#coordinator = undefined; this.#credentials = undefined;
    quietly(() => alarm?.cancel?.());
    quietly(() => flight?.controller.abort());
    quietly(() => coordinator?.stop());
    this.#notice('shutdown');
  }
}
