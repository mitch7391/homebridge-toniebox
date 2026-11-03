import { performance } from 'node:perf_hooks';

import { createMqttTransport } from './mqttTransport.js';
import type { MqttMessage, MqttStatus, MqttTransport } from './mqttTransportTypes.js';
import type { TokenManagerFailureKind } from './tokenManagerTypes.js';
import type {
  MqttLifecycle, MqttLifecycleFailure, MqttLifecycleOptions, MqttLifecycleStatus,
} from './mqttLifecycleTypes.js';

const DELAYS = [10000, 20000, 40000, 60000, 120000, 300000] as const;
const STABLE_MS = 300000;
const MIN_TOKEN_MS = 31000; // 5A's 30-second establishment window plus a local one-second allowance.
const MAX_TIMER_MS = 2147483647;
const TOKEN_KINDS: readonly TokenManagerFailureKind[] = [
  'invalid-input', 'cancelled', 'invalidated', 'stopped', 'credentials-required', 'reauthorization-required',
  'backoff', 'authentication-failed', 'rate-limited', 'refresh-recovery-exhausted', 'insufficient-lifetime', 'clock-invalid',
];
const MQTT_KINDS = [
  'invalid-input', 'closed', 'cancelled', 'timeout', 'transport', 'protocol',
  'subscription-refused', 'authentication-refused', 'resource-limit', 'unsafe-tracing', 'dependency',
] as const;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256
  && !/\s/u.test(v) && [...v].every(c => c.charCodeAt(0) > 31 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159));
const duration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const cancel = (fn?: () => void): void => {
  try {
    fn?.();
  } catch { /* Identity checks invalidate late callbacks even if scheduler cleanup throws. */ }
};
const defaultScheduler = {
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
interface Attempt {
  readonly controller: AbortController;
  transport?: MqttTransport;
  connecting: boolean;
  readyAt?: number;
  session?: number;
}
interface Alarm { cancel?: () => void }

/** Internal pure counter boundary, exported to exercise exhaustion without billions of connections. */
export function nextMqttSession(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('MQTT session exhausted');
  }
  return current + 1;
}

class AccountMqttLifecycle implements MqttLifecycle {
  readonly #options: MqttLifecycleOptions;
  readonly #clock: { now(): number };
  readonly #scheduler: NonNullable<MqttLifecycleOptions['scheduler']>;
  #status: MqttLifecycleStatus = { phase: 'idle', connected: false };
  #attempt?: Attempt;
  #alarm?: Alarm;
  #session = 0;
  #step = 0;
  #lastTime = -Infinity;
  readonly #onAbort = (): void => this.#terminate('stopped', { kind: 'invalidated' });

  constructor(options: MqttLifecycleOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { now: () => performance.now() };
    this.#scheduler = options.scheduler ?? defaultScheduler;
    options.contextSignal.addEventListener('abort', this.#onAbort, { once: true });
    if (options.contextSignal.aborted) {
      this.#onAbort();
    }
  }

  #terminal(): boolean {
    return this.#status.phase === 'stopped' || this.#status.phase === 'attention-required';
  }

  #current(attempt: Attempt): boolean {
    if (this.#options.contextSignal.aborted && this.#status.phase !== 'stopped') {
      this.#onAbort();
    }
    return !this.#terminal() && this.#status.phase !== 'waiting-retry' && this.#attempt === attempt;
  }

  #now(): number | undefined {
    try {
      const value = this.#clock.now();
      if (duration(value) && value >= this.#lastTime) {
        this.#lastTime = value;
        return value;
      }
    } catch { /* No raw dependency exceptions. */ }
    this.#terminate('attention-required', { kind: 'clock-invalid' });
    return undefined;
  }

  #notify(): void {
    try {
      const returned: unknown = this.#options.onStatus?.(this.getStatus());
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch { /* Observational status callbacks cannot disrupt cleanup or leak exceptions. */ }
  }

  #close(transport?: MqttTransport): boolean {
    try {
      transport?.close();
      return true;
    } catch {
      return false;
    }
  }

  #release(): boolean {
    const attempt = this.#attempt;
    this.#attempt = undefined; // Revoke authority BEFORE abort/close can invoke callbacks.
    const alarm = this.#alarm;
    this.#alarm = undefined;
    cancel(alarm?.cancel);
    if (attempt) {
      attempt.session = undefined;
      const transport = attempt.transport;
      attempt.transport = undefined;
      attempt.controller.abort();
      return this.#close(transport);
    }
    return true;
  }

  #terminate(phase: 'attention-required' | 'stopped', error: MqttLifecycleFailure): void {
    if (this.#status.phase === 'stopped' || (this.#terminal() && phase === 'attention-required')) {
      return;
    }
    const terminal = { phase, connected: false, error };
    this.#status = terminal;
    this.#options.contextSignal.removeEventListener('abort', this.#onAbort);
    this.#release();
    if (this.#status === terminal) {
      this.#notify();
    }
  }

  #retry(attempt: Attempt, error: MqttLifecycleFailure, minimum = 0): void {
    if (!this.#current(attempt)) {
      return;
    }
    const readyAt = attempt.readyAt;
    // Revoke delivery before clock, jitter or cleanup code can reenter.
    this.#status = { phase: 'waiting-retry', connected: false, error };
    const now = this.#now(); // Observe disconnect before cleanup can consume stability-threshold time.
    if (now === undefined || this.#terminal()) {
      return;
    }
    if (!this.#release()) {
      this.#terminate('attention-required', { kind: 'dependency' });
      return;
    }
    if (this.#terminal()) {
      return;
    }
    if (readyAt !== undefined && now - readyAt >= STABLE_MS) {
      this.#step = 0;
    }
    let wait: number;
    try {
      const random = (this.#options.jitter ?? Math.random)();
      if (!Number.isFinite(random) || random < 0 || random > 1) {
        throw new Error('Invalid jitter');
      }
      const base = DELAYS[this.#step];
      wait = Math.max(minimum, Math.min(300000, Math.max(10000, base + Math.round(base * 0.2 * (2 * random - 1)))));
    } catch {
      this.#terminate('attention-required', { kind: 'dependency' });
      return;
    }
    if (this.#terminal()) {
      return;
    }
    this.#step = Math.min(this.#step + 1, DELAYS.length - 1);
    this.#status = { phase: 'waiting-retry', connected: false, error, retryAfterMs: wait };
    const alarm: Alarm = {};
    this.#alarm = alarm;
    this.#notify();
    if (this.#alarm === alarm && !this.#terminal()) {
      this.#arm(alarm, now, wait);
    }
  }

  #arm(alarm: Alarm, start: number, delay: number): void {
    const now = this.#now();
    if (now === undefined || this.#alarm !== alarm || this.#terminal()) {
      return;
    }
    let installing = true;
    try {
      const cleanup = this.#scheduler.schedule(() => {
        if (this.#alarm !== alarm || this.#terminal()) {
          return;
        }
        if (installing) {
          this.#terminate('attention-required', { kind: 'dependency' });
          return;
        }
        // Each one-shot callback is consumed once, even if invoked again by an injected scheduler.
        this.#alarm = undefined;
        const time = this.#now();
        if (time === undefined || this.#terminal()) {
          return;
        }
        if (time - start < delay) {
          const next: Alarm = {};
          this.#alarm = next;
          this.#arm(next, start, delay);
        } else {
          this.#begin();
        }
      }, Math.max(1, Math.min(MAX_TIMER_MS, Math.ceil(delay - (now - start)))));
      installing = false;
      if (typeof cleanup !== 'function') {
        throw new Error('Invalid scheduler');
      }
      if (this.#alarm === alarm && !this.#terminal()) {
        alarm.cancel = cleanup;
      } else {
        cancel(cleanup);
      }
    } catch {
      installing = false;
      this.#terminate('attention-required', { kind: 'dependency' });
    }
  }

  #failure(attempt: Attempt, raw: unknown): void {
    if (!this.#current(attempt)) {
      return;
    }
    try {
      const kind = object(raw) ? MQTT_KINDS.find(k => k === raw.kind) : undefined;
      if (!kind) {
        throw new Error('Invalid transport failure');
      }
      if (kind === 'transport' || kind === 'timeout') {
        this.#retry(attempt, { kind });
      } else {
        this.#terminate('attention-required', { kind });
      }
    } catch {
      if (this.#current(attempt)) {
        this.#terminate('attention-required', { kind: 'dependency' });
      }
    }
  }

  #onStatus(attempt: Attempt, raw: MqttStatus): void {
    if (!this.#current(attempt)) {
      return;
    }
    try {
      if (!attempt.connecting || !object(raw)) {
        throw new Error('Invalid transport callback');
      }
      if (raw.phase === 'closed') {
        this.#failure(attempt, raw.error);
      } else if (raw.phase === 'ready') {
        if (attempt.session !== undefined) {
          return;
        }
        const now = this.#now();
        if (now === undefined || !this.#current(attempt)) {
          return;
        }
        try {
          this.#session = nextMqttSession(this.#session);
        } catch {
          this.#terminate('attention-required', { kind: 'generation-exhausted' });
          return;
        }
        attempt.session = this.#session;
        attempt.readyAt = now;
        this.#status = { phase: 'ready', connected: true, session: attempt.session };
        this.#notify(); // 5A drains retained messages immediately after this callback.
      } else if (!['connecting', 'subscribing'].includes(raw.phase) || attempt.session !== undefined) {
        throw new Error('Invalid transport phase');
      }
    } catch {
      if (this.#current(attempt)) {
        this.#terminate('attention-required', { kind: 'dependency' });
      }
    }
  }

  #onMessage(attempt: Attempt, message: MqttMessage): void {
    if (!this.#current(attempt)) {
      return;
    }
    if (attempt.session === undefined) {
      this.#terminate('attention-required', { kind: 'dependency' });
      return;
    }
    try {
      // 5A owns payload/routing validation; explicitly project its private message contract.
      const delivery = {
        session: attempt.session, routeId: message.routeId, topic: message.topic, payload: message.payload,
        retained: message.retained, qos: message.qos, duplicate: message.duplicate, receivedAtMs: message.receivedAtMs,
      };
      if (this.#current(attempt)) {
        const returned: unknown = this.#options.onMessage(delivery);
        if (returned !== undefined) {
          void Promise.resolve(returned).catch(() => {
            if (this.#current(attempt)) {
              this.#terminate('attention-required', { kind: 'dependency' });
            }
          });
        }
      }
    } catch {
      if (this.#current(attempt)) {
        this.#terminate('attention-required', { kind: 'dependency' });
      }
    }
  }

  #connect(attempt: Attempt, accessToken: string, lifetime: number, received: number): void {
    if (!this.#current(attempt)) {
      return;
    }
    let transport: MqttTransport | undefined;
    try {
      transport = (this.#options.transportFactory ?? createMqttTransport)({
        onStatus: status => this.#onStatus(attempt, status),
        onMessage: message => this.#onMessage(attempt, message),
      });
      if (!this.#current(attempt)) {
        this.#close(transport);
        return;
      }
      attempt.transport = transport;
      if (!transport || typeof transport.connect !== 'function' || typeof transport.close !== 'function'
        || typeof transport.getStatus !== 'function' || transport.getStatus().phase !== 'idle') {
        throw new Error('Invalid transport');
      }
      const now = this.#now();
      if (now === undefined || !this.#current(attempt)) {
        return;
      }
      if (lifetime - (now - received) < MIN_TOKEN_MS) {
        this.#retry(attempt, { kind: 'insufficient-lifetime' });
        return;
      }
      this.#status = { phase: 'connecting', connected: false };
      this.#notify();
      if (!this.#current(attempt)) {
        return;
      }
      // Owner callbacks may consume time; never double-count the token acquisition itself.
      const dispatch = this.#now();
      if (dispatch === undefined || !this.#current(attempt)) {
        return;
      }
      if (lifetime - (dispatch - received) < MIN_TOKEN_MS) {
        this.#retry(attempt, { kind: 'insufficient-lifetime' });
        return;
      }
      attempt.connecting = true;
      const pending = transport.connect(
        { uuid: this.#options.accountUuid, accessToken }, this.#options.routes, { signal: attempt.controller.signal },
      );
      void Promise.resolve(pending).then(result => {
        if (!this.#current(attempt)) {
          return;
        }
        if (!object(result) || typeof result.ok !== 'boolean') {
          throw new Error('Invalid transport result');
        }
        if (!result.ok) {
          this.#failure(attempt, result.error);
        } else if (attempt.session === undefined) {
          throw new Error('Missing readiness callback');
        }
      }).catch(() => {
        if (this.#current(attempt)) {
          this.#terminate('attention-required', { kind: 'dependency' });
        }
      });
    } catch {
      if (this.#current(attempt)) {
        this.#terminate('attention-required', { kind: 'dependency' });
      }
    }
  }

  #token(attempt: Attempt, raw: unknown): void {
    if (!this.#current(attempt)) {
      return;
    }
    try {
      if (!object(raw)) {
        throw new Error('Invalid token result');
      }
      if (raw.ok === false && object(raw.error)) {
        const error = raw.error;
        const kind = TOKEN_KINDS.find(k => k === error.kind);
        if (!kind || (error.retryAfterMs !== undefined && !duration(error.retryAfterMs))) {
          throw new Error('Invalid token failure');
        }
        if (kind === 'backoff') {
          this.#retry(attempt, { kind: 'token', tokenFailure: kind }, error.retryAfterMs as number | undefined);
        } else if (kind === 'invalidated') {
          this.#terminate('stopped', { kind: 'invalidated' });
        } else {
          this.#terminate('attention-required', { kind: 'token', tokenFailure: kind });
        }
        return;
      }
      if (raw.ok !== true || raw.tokenType !== 'Bearer' || typeof raw.accessToken !== 'string'
        || !/^[\x21-\x7e]+$/u.test(raw.accessToken) || raw.accessToken.length > 65535
        || !duration(raw.remainingLifetimeMs) || raw.remainingLifetimeMs <= 0) {
        throw new Error('Invalid token result');
      }
      const received = this.#now();
      if (received === undefined || !this.#current(attempt)) {
        return;
      }
      if (raw.remainingLifetimeMs < MIN_TOKEN_MS) {
        this.#retry(attempt, { kind: 'insufficient-lifetime' });
      } else {
        this.#connect(attempt, raw.accessToken, raw.remainingLifetimeMs, received);
      }
    } catch {
      if (this.#current(attempt)) {
        this.#terminate('attention-required', { kind: 'dependency' });
      }
    }
  }

  #begin(): void {
    if (this.#terminal() || this.#attempt || this.#alarm) {
      return;
    }
    if (this.#options.contextSignal.aborted) {
      this.#onAbort();
      return;
    }
    const attempt: Attempt = { controller: new AbortController(), connecting: false };
    this.#attempt = attempt;
    this.#status = { phase: 'acquiring-token', connected: false };
    if (this.#now() === undefined || !this.#current(attempt)) {
      return;
    }
    this.#notify();
    if (!this.#current(attempt)) {
      return;
    }
    try {
      // Installed authority precedes invocation, including synchronous/reentrant injected providers.
      const pending = this.#options.tokenProvider.getAccessToken({ signal: attempt.controller.signal });
      void Promise.resolve(pending).then(result => this.#token(attempt, result)).catch(() => {
        if (this.#current(attempt)) {
          this.#terminate('attention-required', { kind: 'dependency' });
        }
      });
    } catch {
      if (this.#current(attempt)) {
        this.#terminate('attention-required', { kind: 'dependency' });
      }
    }
  }

  start(): void {
    if (this.#status.phase === 'idle') {
      this.#begin();
    }
  }

  getStatus(): MqttLifecycleStatus {
    return { ...this.#status, ...(this.#status.error ? { error: { ...this.#status.error } } : {}) };
  }

  stop(): void {
    this.#terminate('stopped', { kind: 'stopped' });
  }
}

/**
 * One immutable account context, with logical single-attempt ownership. Uncooperative injected
 * dependencies can remain physically pending after abort; their late results have no authority.
 * Only transport/timeout, token backoff, and a usable-but-too-short token retry automatically.
 * No timer or token-expiry observation ever tears down a healthy connection.
 */
export function createMqttLifecycle(options: MqttLifecycleOptions): MqttLifecycle {
  try {
    if (!options || typeof options.tokenProvider?.getAccessToken !== 'function' || !text(options.accountUuid)
      || !(options.contextSignal instanceof AbortSignal) || typeof options.onMessage !== 'function'
      || (options.onStatus !== undefined && typeof options.onStatus !== 'function')
      || (options.transportFactory !== undefined && typeof options.transportFactory !== 'function')
      || (options.clock !== undefined && typeof options.clock.now !== 'function')
      || (options.scheduler !== undefined && typeof options.scheduler.schedule !== 'function')
      || (options.jitter !== undefined && typeof options.jitter !== 'function')
      || !Array.isArray(options.routes) || options.routes.length === 0 || options.routes.length > 100) {
      throw new Error('Invalid options');
    }
    const ids = new Set<string>();
    const macs = new Set<string>();
    const routes = options.routes.map(route => {
      if (!route || !text(route.routeId) || !text(route.macAddress) || /[/\\+#]/u.test(route.macAddress)
        || ids.has(route.routeId) || macs.has(route.macAddress.toUpperCase())) {
        throw new Error('Invalid routes');
      }
      ids.add(route.routeId);
      macs.add(route.macAddress.toUpperCase());
      return Object.freeze({ routeId: route.routeId, macAddress: route.macAddress });
    });
    return new AccountMqttLifecycle({ ...options, routes: Object.freeze(routes) });
  } catch {
    throw new TypeError('Invalid MQTT lifecycle options');
  }
}
