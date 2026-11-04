import { parseMessage } from './parseMessage.js';
import { validRoutePlan } from './routingPolicy.js';
import { applyMessage, createDeviceState, playbackActivity, playbackPositionMs, sleepRemainingMs, snapshotFreshness } from './state.js';
import type { MqttLifecycleStatus, MqttSessionMessage } from './mqttLifecycleTypes.js';
import type { ApprovedRoutePlan } from './routingTypes.js';
import type { DeviceState, StateTopic, TransportContext } from './types.js';

export interface BackendStateStatus {
  readonly phase: 'idle' | 'disconnected' | 'connected' | 'attention-required' | 'invalidated';
  readonly devices: number;
  readonly stateSession?: number;
  readonly error?: 'invalid-status' | 'generation-exhausted';
}
export interface StateNotice {
  readonly kind: 'routes' | 'transport' | 'message' | 'invalidated';
  readonly changed?: boolean;
}
export type IntegrationResult =
  | { readonly accepted: true; readonly changed: boolean }
  | { readonly accepted: false;
      readonly reason: 'stale' | 'invalid-plan' | 'invalid-status' | 'invalid-message' | 'ignored-history' | 'unknown-route' | 'generation-exhausted' };
/** These closures carry account AND lifecycle authority. Pass each pair to exactly one 5B instance. */
export interface StateBinding {
  onStatus(status: MqttLifecycleStatus): IntegrationResult;
  onMessage(message: MqttSessionMessage): IntegrationResult;
}
export interface DeviceObservation {
  readonly state: DeviceState;
  readonly transport: TransportContext;
  readonly freshness: Partial<Record<StateTopic, ReturnType<typeof snapshotFreshness>>>;
  readonly settingsFreshness: ReturnType<typeof snapshotFreshness>;
  readonly playback: ReturnType<typeof playbackActivity>;
  readonly playbackPositionMs?: number;
  readonly sleepRemainingMs?: number;
}
export interface BackendStateOptions {
  readonly context: symbol;
  /** Identifier-free notification. Read private observations separately; never log them wholesale. */
  readonly onChange?: (notice: StateNotice) => void;
  /** Test seam / reserved counter prefix in a fresh namespace. Never restores persisted state. */
  readonly sessionSeed?: number;
}
export interface BackendState {
  /** Atomic authority replacement; empty plans withdraw all routes without creating a connection. */
  bind(plan: ApprovedRoutePlan): { readonly ok: true; readonly binding: StateBinding } | { readonly ok: false; readonly reason: 'invalid-plan' | 'stale' };
  getStatus(): BackendStateStatus;
  /** Private detached data; nowMs is explicit, never an internal timer or clock read. */
  getDevice(routeId: string, nowMs?: number): DeviceObservation | undefined;
  /** Terminal for this account namespace. A replacement account needs a new adapter. */
  invalidate(): void;
}
interface Binding {
  readonly plan: ApprovedRoutePlan;
  lastLocal: number;
  activeLocal?: number;
  terminal: boolean;
}
const reject = (reason: Extract<IntegrationResult, { accepted: false }>['reason']): IntegrationResult => ({ accepted: false, reason });
const phases = ['idle', 'acquiring-token', 'connecting', 'ready', 'waiting-retry', 'attention-required', 'stopped'];

/** A mapping counter, not a second owner of MQTT sessions. Never wrap retained snapshot authority. */
export function nextStateSession(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('State session exhausted');
  }
  return current + 1;
}

class AccountState implements BackendState {
  readonly #context: symbol;
  #observer?: BackendStateOptions['onChange'];
  #account?: string;
  #binding?: Binding;
  #states = new Map<string, DeviceState>();
  #session: number;
  #transport: TransportContext;
  #status: BackendStateStatus = { phase: 'idle', devices: 0 };
  #terminal = false;

  constructor(options: BackendStateOptions) {
    this.#context = options.context;
    this.#observer = options.onChange;
    this.#session = options.sessionSeed ?? 0;
    this.#transport = { status: 'unknown', session: this.#session };
  }

  #notify(notice: StateNotice): void {
    try {
      const returned: unknown = this.#observer?.({ ...notice });
      if (returned !== undefined) {
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch { /* Observers cannot roll back committed state, leak errors, or obstruct invalidation. */ }
  }

  #current(binding: Binding): boolean {
    return !this.#terminal && this.#binding === binding && !binding.terminal;
  }

  bind(input: ApprovedRoutePlan): ReturnType<BackendState['bind']> {
    if (this.#terminal) {
      return { ok: false, reason: 'stale' };
    }
    let copied: ApprovedRoutePlan;
    try {
      if (!validRoutePlan(input) || input.context !== this.#context || (this.#account !== undefined && input.accountUuid !== this.#account)) {
        return { ok: false, reason: 'invalid-plan' };
      }
      copied = { context: input.context, accountUuid: input.accountUuid, lane: input.lane, routes: structuredClone(input.routes) };
    } catch {
      return { ok: false, reason: 'invalid-plan' };
    }
    const previous = this.#binding;
    const states = new Map<string, DeviceState>();
    for (const route of copied.routes) {
      const oldRoute = previous?.plan.routes.find(r => r.routeId === route.routeId);
      const oldState = this.#states.get(route.routeId);
      const unchanged = oldRoute?.macAddress === route.macAddress && oldRoute.householdId === route.householdId
        && previous?.plan.lane === copied.lane;
      const fresh = createDeviceState(route.identity);
      states.set(route.routeId, unchanged && oldState ? { ...oldState, identity: fresh.identity } : fresh);
    }
    if (previous) {
      previous.terminal = true;
      previous.activeLocal = undefined;
    }
    const binding: Binding = { plan: copied, lastLocal: 0, terminal: false };
    this.#binding = binding;
    this.#account = copied.accountUuid;
    this.#states = states;
    this.#transport = { status: 'disconnected', session: this.#session };
    this.#status = { phase: 'disconnected', devices: states.size };
    const callbacks: StateBinding = {
      onStatus: value => this.#onStatus(binding, value),
      onMessage: value => this.#onMessage(binding, value),
    };
    this.#notify({ kind: 'routes' });
    return { ok: true, binding: callbacks };
  }

  #invalidStatus(binding: Binding, error: 'invalid-status' | 'generation-exhausted'): IntegrationResult {
    binding.terminal = true;
    binding.activeLocal = undefined;
    this.#transport = { status: 'disconnected', session: this.#session };
    this.#status = { phase: 'attention-required', devices: this.#states.size, error };
    // Counter exhaustion is terminal even across bind(), otherwise replacement could bypass it.
    if (error === 'generation-exhausted') {
      this.#terminal = true;
    }
    this.#notify({ kind: 'transport' });
    return reject(error);
  }

  #onStatus(binding: Binding, status: MqttLifecycleStatus): IntegrationResult {
    if (!this.#current(binding)) {
      return reject('stale');
    }
    if (!status || !phases.includes(status.phase) || typeof status.connected !== 'boolean'
      || status.connected !== (status.phase === 'ready') || (status.phase !== 'ready' && status.session !== undefined)) {
      return this.#invalidStatus(binding, 'invalid-status');
    }
    if (status.phase === 'ready') {
      const local = status.session;
      if (!Number.isSafeInteger(local) || local === undefined || local <= 0 || binding.plan.routes.length === 0) {
        return this.#invalidStatus(binding, 'invalid-status');
      }
      if (local === binding.activeLocal) {
        return { accepted: true, changed: false };
      }
      if (local <= binding.lastLocal) {
        return reject('stale');
      }
      try {
        this.#session = nextStateSession(this.#session);
      } catch {
        return this.#invalidStatus(binding, 'generation-exhausted');
      }
      binding.lastLocal = local;
      binding.activeLocal = local;
      this.#transport = { status: 'connected', session: this.#session };
      this.#status = { phase: 'connected', devices: this.#states.size, stateSession: this.#session };
    } else {
      const phase = status.phase === 'attention-required' ? 'attention-required' : 'disconnected';
      const changed = binding.activeLocal !== undefined || this.#status.phase !== phase;
      binding.activeLocal = undefined;
      binding.terminal = status.phase === 'stopped' || status.phase === 'attention-required';
      this.#transport = { status: 'disconnected', session: this.#session };
      // Preserve the attention signal; 6B owns detailed lifecycle diagnostics and recovery.
      this.#status = { phase, devices: this.#states.size };
      if (!changed) {
        return { accepted: true, changed: false };
      }
    }
    // Authority and transport are committed before observers (or buffered messages) can reenter.
    this.#notify({ kind: 'transport' });
    return { accepted: true, changed: true };
  }

  #onMessage(binding: Binding, message: MqttSessionMessage): IntegrationResult {
    if (!this.#current(binding) || binding.activeLocal === undefined || message?.session !== binding.activeLocal) {
      return reject('stale');
    }
    if (!message || typeof message.routeId !== 'string' || typeof message.topic !== 'string'
      || !(message.payload instanceof Uint8Array) || message.payload.byteLength > 65536
      || typeof message.retained !== 'boolean' || typeof message.duplicate !== 'boolean'
      || (message.qos !== 0 && message.qos !== 1) || !Number.isSafeInteger(message.receivedAtMs) || message.receivedAtMs < 0) {
      return reject('invalid-message');
    }
    const state = this.#states.get(message.routeId);
    if (!state) {
      return reject('unknown-route');
    }
    const parsed = parseMessage(message.topic, message.payload);
    if (parsed.kind !== 'parsed' || parsed.message.macAddress !== state.identity.macAddress) {
      return reject('invalid-message');
    }
    const update = applyMessage(state, parsed, {
      session: this.#session, retained: message.retained, receivedAtMs: message.receivedAtMs,
    }, this.#transport);
    if (!update.accepted) {
      return reject('ignored-history');
    }
    this.#states.set(message.routeId, update.state); // Includes changed:false metadata updates.
    this.#notify({ kind: 'message', changed: update.changed });
    return { accepted: true, changed: update.changed };
  }

  getStatus(): BackendStateStatus {
    return { ...this.#status };
  }

  getDevice(routeId: string, nowMs?: number): DeviceObservation | undefined {
    const state = this.#states.get(routeId);
    if (!state) {
      return undefined;
    }
    const freshness: DeviceObservation['freshness'] = Object.fromEntries(
      Object.entries(state.topics).map(([topic, snapshot]) => [topic, snapshotFreshness(snapshot, this.#transport)]),
    );
    return {
      state: structuredClone(state), transport: { ...this.#transport }, freshness,
      settingsFreshness: snapshotFreshness(state.settingsEvent, this.#transport), playback: playbackActivity(state, this.#transport),
      ...(nowMs === undefined ? {} : {
        playbackPositionMs: playbackPositionMs(state, this.#transport, nowMs),
        sleepRemainingMs: sleepRemainingMs(state, this.#transport, nowMs),
      }),
    };
  }

  invalidate(): void {
    if (this.#status.phase === 'invalidated') {
      return;
    }
    this.#terminal = true;
    this.#binding = undefined;
    this.#states.clear();
    this.#account = undefined;
    this.#transport = { status: 'disconnected', session: this.#session };
    this.#status = { phase: 'invalidated', devices: 0 };
    this.#notify({ kind: 'invalidated' });
    this.#observer = undefined;
  }
}

/** No connection, token, discovery, timers or Homebridge ownership. One immutable account namespace. */
export function createBackendState(options: BackendStateOptions): BackendState {
  if (!options || typeof options.context !== 'symbol'
    || (options.onChange !== undefined && typeof options.onChange !== 'function')
    || !Number.isSafeInteger(options.sessionSeed ?? 0) || (options.sessionSeed ?? 0) < 0) {
    throw new TypeError('Invalid backend state options');
  }
  return new AccountState(options);
}
