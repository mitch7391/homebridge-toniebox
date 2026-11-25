import { CommissioningObserver } from './commissioning.js';
import { performance } from 'node:perf_hooks';
import { createAuthClient } from './authClient.js';
import { createTokenManager } from './tokenManager.js';
import { createDiscoveryClient } from './discoveryClient.js';
import { createDiscoveryRunner } from './discoveryRunner.js';
import { createMqttLifecycle, playbackPublishResult } from './mqttLifecycle.js';
import { createBackendState } from './backendState.js';
import { approveRoutes, reconcileRoutes } from './routingPolicy.js';
import type { PlaybackAction } from './mqttTransportTypes.js';
import type { AuthCredentials } from './authTypes.js';
import type { BackendState } from './backendState.js';
import type { DiscoveryResult, DiscoveryRequestOptions } from './discoveryTypes.js';
import type { DiscoveryRunner, DiscoveryRunResult } from './discoveryRunnerTypes.js';
import type { MqttLifecycle, MqttLifecycleStatus } from './mqttLifecycleTypes.js';
import type { ApprovedRoutePlan, CompatibilityPolicy } from './routingTypes.js';
import type { TokenClock, TokenManager } from './tokenManagerTypes.js';
import { MAX_EXPERIMENTAL_CONNECTIONS } from './accountCoordinatorTypes.js';
import type { AccountCoordinator, AccountCoordinatorOptions, CoordinatorFailure, CoordinatorResult, CoordinatorStatus,
  DiscoveryRecovery, DiscoveryRecoveryReason, ProductionChangeReason, ProductionInventory,
  PlaybackTarget, PlaybackRequestResult, PlaybackRequestFailure } from './accountCoordinatorTypes.js';

const fail = (reason: CoordinatorFailure, retryAfterMs?: number): CoordinatorResult =>
  ({ ok: false, reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
const quiet = (fn: () => void): void => {
  try {
    fn();
  } catch { /* Revoked authority cannot be restored by cleanup failure. */ }
};
const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const kinds = ['invalid-input', 'closed', 'cancelled', 'timeout', 'transport', 'protocol', 'subscription-refused',
  'authentication-refused', 'resource-limit', 'unsafe-tracing', 'dependency', 'token', 'insufficient-lifetime',
  'clock-invalid', 'generation-exhausted', 'invalidated', 'stopped'] as const;
const tokenKinds = ['invalid-input', 'cancelled', 'invalidated', 'stopped', 'credentials-required', 'reauthorization-required',
  'backoff', 'authentication-failed', 'rate-limited', 'refresh-recovery-exhausted', 'insufficient-lifetime', 'clock-invalid'] as const;
const phases = ['idle', 'acquiring-token', 'connecting', 'ready', 'waiting-retry', 'attention-required', 'stopped'] as const;
function safeStatus(raw: MqttLifecycleStatus): MqttLifecycleStatus {
  const phase = phases.find(p => p === raw.phase);
  if (!phase || raw.connected !== (phase === 'ready') || (phase === 'ready'
    ? !Number.isSafeInteger(raw.session) || raw.session! <= 0 : raw.session !== undefined)) {
    throw new Error('Invalid lifecycle status');
  }
  const kind = kinds.find(k => k === raw.error?.kind);
  const tokenFailure = tokenKinds.find(k => k === raw.error?.tokenFailure);
  const origin = raw.error?.origin;
  const reasonCode = raw.error?.reasonCode;
  const replacement = raw.replacement;
  return { phase, connected: phase === 'ready', ...(phase === 'ready' ? { session: raw.session } : {}),
    ...(kind ? { error: { kind, ...(tokenFailure ? { tokenFailure } : {}),
      ...(kind === 'authentication-refused' && (origin === 'disconnect' || origin === 'error')
        ? { origin } : {}),
      ...(kind === 'authentication-refused' && (reasonCode === 134 || reasonCode === 135)
        ? { reasonCode } : {}) } } : {}),
    ...(replacement === 'proactive' || replacement === 'recovery' ? { replacement } : {}),
    ...(number(raw.retryAfterMs) ? { retryAfterMs: raw.retryAfterMs } : {}) };
}
function policyCopy(value?: CompatibilityPolicy): CompatibilityPolicy | undefined {
  try {
    return structuredClone(value);
  } catch {
    return { rules: null } as unknown as CompatibilityPolicy;
  }
}
const same = (a: ApprovedRoutePlan, b: ApprovedRoutePlan): boolean => a.accountUuid === b.accountUuid
  && a.routes.length === b.routes.length && a.routes.every(r => b.routes.some(t => r.routeId === t.routeId
    && r.macAddress === t.macAddress && r.householdId === t.householdId
    // Missing optional evidence is not a model change; 6A retains trusted authority in that case.
    && (t.identity.product === undefined || r.identity.product === t.identity.product)
    && (t.identity.generation === undefined || r.identity.generation === t.identity.generation)));
interface Slot {
  active: boolean;
  plan: ApprovedRoutePlan;
  state: BackendState;
  lifecycle?: MqttLifecycle;
  status: MqttLifecycleStatus;
}
const commandFailure = (reason: PlaybackRequestFailure, invoked = false): PlaybackRequestResult =>
  Object.freeze({ ok: false, reason, delivery: invoked ? 'uncertain' : 'not-dispatched' });
const playbackEligible = (route: ApprovedRoutePlan['routes'][number]): boolean => route.identity.product === 'tb2'
  && route.identity.generation === 'tng' && route.identity.features?.includes('playbackControls') === true;
interface Command {
  readonly context: Context;
  readonly slot: Slot;
  readonly target: PlaybackTarget;
  readonly action: PlaybackAction;
  readonly session: number;
  readonly controller: AbortController;
  readonly resolve: (result: PlaybackRequestResult) => void;
  readonly deadline: number;
  invoked: boolean;
  acknowledged: boolean;
  /** Undefined until synchronous dispatch admission has returned; reentrant preparation messages cannot confirm. */
  evidence?: boolean;
  timerEpoch?: object;
  cancelTimer?: () => void;
  removeAbort?: () => void;
}
interface Operation { promise: Promise<CoordinatorResult>; resolve(value: CoordinatorResult): void }
interface Context {
  key: symbol;
  controller: AbortController;
  runner?: DiscoveryRunner;
  operation?: Operation;
  production?: Slot;
  experiments: Map<string, Slot>;
  uuid?: string;
  started: boolean;
}
const emptyDiagnostics = { requests: 0, retries: 0, rejectedEntries: 0, degradedEntries: 0, duplicateEntries: 0,
  continuationDetected: false, failedHouseholds: 0, unattemptedHouseholds: 0, interruptedHouseholds: 0,
  identityConflictEntries: 0, ambiguousRoutingEntries: 0, missingMacEntries: 0 };
const unavailable: DiscoveryRunResult = { ok: false, error: { kind: 'request' }, diagnostics: emptyDiagnostics };

class Coordinator implements AccountCoordinator {
  readonly #options: AccountCoordinatorOptions;
  readonly #commissioning?: CommissioningObserver;
  readonly #clock: TokenClock;
  readonly #tokens: TokenManager;
  #context?: Context;
  readonly #commands = new Map<string, Command>();
  #commandAdmission = false;
  #commandCleanup = false;
  #productionEpoch: object = {};
  #productionPending = new Map<ProductionChangeReason, () => boolean>();
  #productionQueued = false;
  #credentials?: AuthCredentials;
  #policy?: CompatibilityPolicy;
  #stopped = false;
  #changing = false;
  #attention = false;
  #lastTime = -Infinity;
  #cooldown?: { start: number; duration: number };
  #status: CoordinatorStatus = { phase: 'not-configured', discovery: 'never', authority: 'none', devices: 0, connections: [] };

  constructor(options: AccountCoordinatorOptions) {
    this.#options = { ...options };
    if (typeof options.onCommissioning === 'function') {
      this.#commissioning = new CommissioningObserver(options.onCommissioning);
    }
    this.#clock = options.clock ?? { now: () => ({ monotonicMs: performance.now(), wallMs: Date.now() }) };
    this.#tokens = createTokenManager({ authClient: options.authClient ?? createAuthClient(), clock: this.#clock, scheduler: options.scheduler });
    this.#policy = policyCopy(options.policy);
  }
  #current(c: Context): boolean {
    return !this.#stopped && this.#context === c && !c.controller.signal.aborted;
  }
  #slots(c: Context): Slot[] {
    return [...(c.production ? [c.production] : []), ...c.experiments.values()];
  }
  #now(): number {
    const n = this.#clock.now().monotonicMs;
    if (!number(n) || n < this.#lastTime) {
      throw new Error('Invalid clock');
    }
    this.#lastTime = n;
    return n;
  }
  #settleCommand(p: Command, result: PlaybackRequestResult): void {
    if (this.#commands.get(p.target.routeId) !== p) {
      return;
    }
    this.#commands.delete(p.target.routeId); p.timerEpoch = undefined;
    const cleaning = this.#commandCleanup;
    this.#commandCleanup = true;
    try {
      quiet(() => p.cancelTimer?.()); quiet(() => p.removeAbort?.());
      p.resolve(result);
      p.controller.abort();
    } finally {
      this.#commandCleanup = cleaning;
    }
  }
  #cancelCommands(reason: PlaybackRequestFailure, slot?: Slot): void {
    for (const p of [...this.#commands.values()]) {
      if (!slot || p.slot === slot) {
        this.#settleCommand(p, commandFailure(reason, p.invoked));
      }
    }
  }
  #commandState(c: Context, slot: Slot, target: PlaybackTarget, session?: number) {
    const authorised = (): boolean => this.#options.enablePlaybackCommands === true && this.#current(c) && c.started
      && !this.#changing && c.production === slot && slot.active && slot.plan.context === c.key
      && slot.plan.lane === 'production' && this.#status.authority === 'current'
      && c.uuid === target.accountUuid && slot.plan.accountUuid === target.accountUuid;
    if (!authorised()) {
      return { reason: 'not-authorised' as const };
    }
    const route = slot.plan.routes.find(r => r.routeId === target.routeId);
    if (!route || route.macAddress !== target.macAddress || route.identity.id !== target.routeId
      || route.identity.macAddress !== target.macAddress || !playbackEligible(route)) {
      return { reason: 'not-authorised' as const };
    }
    const renewal = this.#tokens.getStatus().renewal;
    if (renewal === 'attention-required' || renewal === 'stopped') {
      return { reason: 'not-ready' as const };
    }
    const status = safeStatus(slot.lifecycle!.getStatus());
    if (!authorised()) {
      return { reason: 'invalidated' as const };
    }
    if (status.phase !== 'ready' || !status.connected || status.session !== slot.status.session
      || slot.status.phase !== 'ready' || (session !== undefined && status.session !== session)) {
      return { reason: 'not-ready' as const };
    }
    return { ...this.#commandObservation(slot, target), session: status.session! };
  }
  #commandObservation(slot: Slot, target: PlaybackTarget) {
    const observation = slot.state.getDevice(target.routeId);
    if (!observation || observation.state.identity.id !== target.routeId || observation.state.identity.macAddress !== target.macAddress) {
      return { reason: 'not-authorised' as const };
    }
    const online = observation.state.topics['online-state'];
    if (observation.transport.status !== 'connected' || online?.session !== observation.transport.session
      || online.value.onlineState !== 'connected') {
      return { reason: 'not-ready' as const };
    }
    if (!['playing', 'paused'].includes(observation.playback)) {
      return { reason: 'insufficient-state' as const };
    }
    return { observation };
  }
  #ownsCommand(c: Context, slot: Slot, target: PlaybackTarget, session: number): boolean {
    return this.#current(c) && c.started && !this.#changing && c.production === slot && slot.active
      && this.#status.authority === 'current' && c.uuid === target.accountUuid && slot.plan.accountUuid === target.accountUuid
      && slot.status.phase === 'ready' && slot.status.connected && slot.status.session === session
      && slot.plan.routes.some(r => r.routeId === target.routeId && r.macAddress === target.macAddress && playbackEligible(r));
  }
  #checkCommand(p: Command): boolean {
    if (this.#commands.get(p.target.routeId) !== p) {
      return false;
    }
    try {
      const now = this.#now();
      if (this.#commands.get(p.target.routeId) !== p) {
        return false;
      }
      if (now >= p.deadline) {
        this.#settleCommand(p, commandFailure('timeout', p.invoked)); return false;
      }
      const state = this.#commandState(p.context, p.slot, p.target, p.session);
      const after = this.#now();
      if (this.#commands.get(p.target.routeId) !== p) {
        return false;
      }
      if (after >= p.deadline) {
        this.#settleCommand(p, commandFailure('timeout', p.invoked)); return false;
      }
      const current = this.#commandObservation(p.slot, p.target);
      if (state.reason || current.reason || !this.#ownsCommand(p.context, p.slot, p.target, p.session)) {
        this.#settleCommand(p, commandFailure(state.reason === 'not-ready' ? 'interrupted' : 'invalidated', p.invoked));
        return false;
      }
      return this.#commands.get(p.target.routeId) === p;
    } catch {
      this.#settleCommand(p, commandFailure('dependency', p.invoked)); return false;
    }
  }
  #completeCommand(p: Command): void {
    if (!this.#checkCommand(p) || !p.acknowledged || !p.evidence) {
      return;
    }
    const state = p.slot.state.getDevice(p.target.routeId);
    if (state?.playback === (p.action === 'play' ? 'playing' : 'paused') && state.freshness['playback/state'] === 'observed') {
      this.#settleCommand(p, Object.freeze({ ok: true, outcome: 'confirmed' }));
    }
  }
  #armCommand(p: Command): void {
    if (!this.#checkCommand(p)) {
      return;
    }
    const epoch = p.timerEpoch = {};
    let installing = true;
    const schedule = this.#options.scheduler?.schedule.bind(this.#options.scheduler) ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms); timer.unref(); return () => clearTimeout(timer);
    });
    const cleanup = schedule(() => {
      if (this.#commands.get(p.target.routeId) !== p || p.timerEpoch !== epoch) {
        return;
      }
      p.timerEpoch = undefined;
      if (installing) {
        this.#settleCommand(p, commandFailure('dependency', p.invoked)); return;
      }
      try {
        this.#armCommand(p);
      } catch {
        this.#settleCommand(p, commandFailure('dependency', p.invoked));
      }
    }, Math.max(1, Math.ceil(p.deadline - this.#now())));
    installing = false;
    if (typeof cleanup !== 'function') {
      throw new Error('Invalid command scheduler');
    }
    if (this.#commands.get(p.target.routeId) === p) {
      p.cancelTimer = cleanup;
    } else {
      quiet(cleanup);
    }
  }
  requestPlayback(raw: PlaybackTarget, action: PlaybackAction, options: { readonly signal?: AbortSignal } = {}): Promise<PlaybackRequestResult> {
    if (this.#commandAdmission || this.#commandCleanup) {
      return Promise.resolve(commandFailure('busy'));
    }
    this.#commandAdmission = true;
    try {
      if (this.#stopped) {
        return Promise.resolve(commandFailure('stopped'));
      }
      if (this.#options.enablePlaybackCommands !== true) {
        return Promise.resolve(commandFailure('not-authorised'));
      }
      const deadline = this.#now() + 5000;
      if (deadline > Number.MAX_SAFE_INTEGER) {
        return Promise.resolve(commandFailure('dependency'));
      }
      const target = raw && { accountUuid: raw.accountUuid, routeId: raw.routeId, macAddress: raw.macAddress };
      const validText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/\s/u.test(v);
      if (!target || !validText(target.accountUuid) || !validText(target.routeId) || !validText(target.macAddress)
        || (action !== 'play' && action !== 'pause') || !options || typeof options !== 'object' || Array.isArray(options)) {
        return Promise.resolve(commandFailure('invalid-input'));
      }
      const signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        return Promise.resolve(commandFailure('invalid-input'));
      }
      if (signal?.aborted) {
        return Promise.resolve(commandFailure('cancelled'));
      }
      const c = this.#context, slot = c?.production;
      if (!c || !slot) {
        return Promise.resolve(commandFailure('not-authorised'));
      }
      if (this.#commands.has(target.routeId)) {
        return Promise.resolve(commandFailure('busy'));
      }
      const state = this.#commandState(c, slot, target);
      if (state.reason) {
        return Promise.resolve(commandFailure(state.reason));
      }
      if (this.#now() >= deadline) {
        return Promise.resolve(commandFailure('timeout'));
      }
      if (!this.#ownsCommand(c, slot, target, state.session!)) {
        return Promise.resolve(commandFailure('invalidated'));
      }
      if (signal?.aborted) {
        return Promise.resolve(commandFailure('cancelled'));
      }
      const current = this.#commandObservation(slot, target);
      if (current.reason) {
        return Promise.resolve(commandFailure(current.reason));
      }
      if (current.observation!.playback === (action === 'play' ? 'playing' : 'paused')
        && current.observation!.freshness['playback/state'] === 'observed') {
        return Promise.resolve(Object.freeze({ ok: true, outcome: 'already-satisfied' }));
      }
      return new Promise<PlaybackRequestResult>(resolve => {
        const p: Command = { context: c, slot, target, action, session: state.session!, deadline,
          controller: new AbortController(), resolve, invoked: false, acknowledged: false };
        this.#commands.set(target.routeId, p);
        try {
          const abort = (): void => this.#settleCommand(p, commandFailure('cancelled', p.invoked));
          p.removeAbort = () => signal?.removeEventListener('abort', abort);
          signal?.addEventListener('abort', abort, { once: true });
          if (this.#commands.get(target.routeId) !== p) {
            quiet(p.removeAbort); return;
          }
          if (signal?.aborted) {
            abort(); return;
          }
          this.#armCommand(p);
          const lifecycle = slot.lifecycle, publish = lifecycle?.publishPlayback;
          if (typeof publish !== 'function') {
            throw new Error('Missing publisher');
          }
          if (!this.#checkCommand(p)) {
            return;
          }
          p.invoked = true;
          const pending = publish.call(lifecycle, target.routeId, action, { session: p.session, signal: p.controller.signal });
          p.evidence = false; // Network observations after dispatch may precede the asynchronous PUBACK result.
          void Promise.resolve(pending).then(rawResult => {
            if (!this.#checkCommand(p)) {
              return;
            }
            const result = playbackPublishResult(rawResult);
            if (!result) {
              this.#settleCommand(p, commandFailure('dependency', true));
            } else if (!result.ok) {
              this.#settleCommand(p, commandFailure(result.reason === 'capacity' ? 'busy' : result.reason, result.delivery === 'uncertain'));
            } else {
              p.acknowledged = true; this.#completeCommand(p);
            }
          }).catch(() => this.#settleCommand(p, commandFailure('dependency', p.invoked)));
        } catch {
          this.#settleCommand(p, commandFailure('dependency', p.invoked));
        }
      });
    } catch {
      return Promise.resolve(commandFailure('dependency'));
    } finally {
      this.#commandAdmission = false;
    }
  }
  #remaining(): number {
    const now = this.#now();
    return this.#cooldown ? Math.max(0, this.#cooldown.duration - (now - this.#cooldown.start)) : 0;
  }
  #notify(): void {
    try {
      void Promise.resolve(this.#options.onStatus?.(this.getStatus())).catch(() => undefined);
    } catch { /* Observer only. */ }
  }
  #productionNotice(reason: ProductionChangeReason, current: () => boolean): void {
    if (typeof this.#options.onProductionChange !== 'function') {
      return;
    }
    // At most five fixed reasons and one microtask; never retain payloads or snapshots.
    this.#productionPending.set(reason, current);
    if (this.#productionQueued) {
      return;
    }
    this.#productionQueued = true;
    void Promise.resolve().then(() => {
      this.#productionQueued = false;
      const pending = this.#productionPending;
      this.#productionPending = new Map();
      const reasons = [...pending].filter(([, valid]) => valid()).map(([kind]) => kind);
      if (reasons.length) {
        return this.#options.onProductionChange?.(Object.freeze({ reasons: Object.freeze(reasons) }));
      }
    }).catch(() => undefined);
  }

  #refresh(c: Context): void {
    if (!this.#current(c)) {
      return;
    }
    const slots = this.#slots(c);
    const statuses = slots.map(s => ({ lane: s.plan.lane, status: safeStatus(s.status) }));
    let phase = this.#status.phase;
    if (!c.operation) {
      phase = statuses.some(s => s.status.phase === 'attention-required') ? 'attention-required'
        : statuses.some(s => s.status.phase === 'waiting-retry') ? 'retrying'
          : statuses.some(s => s.status.phase === 'acquiring-token' || s.status.phase === 'connecting') ? 'connecting'
            : statuses.some(s => s.status.connected) ? 'connected'
              : this.#status.discovery === 'degraded' ? 'degraded' : 'idle';
    }
    this.#status = { ...this.#status, phase, connections: statuses, devices: slots.reduce((n, s) => n + s.plan.routes.length, 0) };
  }
  #close(slot: Slot): void {
    slot.active = false;
    this.#cancelCommands('invalidated', slot);
    slot.state.invalidate();
    quiet(() => slot.lifecycle?.stop());
  }
  #release(reason: CoordinatorFailure): void {
    const c = this.#context;
    this.#context = undefined; // Revoke every callback before abort/stop can reenter.
    this.#cancelCommands(reason === 'stopped' ? 'stopped' : 'invalidated');
    if (!c) {
      return;
    }
    const epoch = this.#productionEpoch = {};
    if (reason !== 'stopped') {
      this.#productionNotice('revoked', () => !this.#stopped && this.#productionEpoch === epoch);
    }
    const operation = c.operation; c.operation = undefined;
    operation?.resolve(fail(reason));
    for (const slot of this.#slots(c)) {
      slot.active = false; slot.state.invalidate();
    }
    c.controller.abort();
    quiet(() => c.runner?.stop());
    for (const slot of this.#slots(c)) {
      quiet(() => slot.lifecycle?.stop());
    }
    c.experiments.clear(); c.production = undefined;
  }
  #fatal(reason: CoordinatorFailure): void {
    if (this.#stopped) {
      return;
    }
    this.#attention = true;
    this.#release(reason);
    if (this.#stopped) {
      return;
    }
    this.#credentials = undefined;
    quiet(() => this.#tokens.clear());
    this.#status = { phase: 'attention-required', discovery: 'degraded', authority: 'none', devices: 0, connections: [], reason };
    this.#notify();
  }
  setCredentials(raw: AuthCredentials): CoordinatorResult {
    if (this.#stopped) {
      return fail('stopped');
    }
    if (this.#changing) {
      return fail('busy');
    }
    let value: AuthCredentials;
    try {
      if (!raw || typeof raw.username !== 'string' || !/\S/u.test(raw.username)
        || typeof raw.password !== 'string' || !raw.password.length) {
        return fail('invalid-input');
      }
      value = { username: raw.username, password: raw.password };
    } catch {
      return fail('invalid-input');
    }
    if (this.#attention) {
      return fail('authentication');
    }
    if (this.#credentials?.username === value.username && this.#credentials.password === value.password) {
      return { ok: true };
    }
    this.#changing = true;
    try {
      this.#release('invalidated');
      if (this.#stopped) {
        return fail('stopped');
      }
      const result = this.#tokens.setCredentials(value);
      if (!result.ok) {
        this.#credentials = undefined; this.#fatal('authentication'); return fail('authentication');
      }
      this.#credentials = value;
      const c: Context = { key: Symbol(), controller: new AbortController(), experiments: new Map(), started: false };
      this.#context = c;
      this.#commissioning?.reset();
      if (this.#commissioning || this.#options.enablePlaybackCommands === true) {
        let grantKey = '';
        this.#tokens.observeCredentials(snapshot => {
          if (!this.#current(c)) {
            return;
          }
          if (snapshot.status.renewal === 'attention-required' || snapshot.status.renewal === 'stopped') {
            this.#cancelCommands('invalidated');
          }
          const grant = snapshot.grant;
          const key = grant ? JSON.stringify([snapshot.revision, grant.kind, grant.outcome, grant.accessChanged]) : '';
          if (key !== grantKey) {
            grantKey = key;
            if (grant && this.#commissioning) {
              quiet(() => this.#commissioning!.renewal(grant, () => this.#current(c)));
            }
          }
        }, { signal: c.controller.signal });
      }
      const client = this.#options.discoveryClient ?? createDiscoveryClient();
      const request = async <T>(invoke: () => Promise<DiscoveryResult<T>>, options?: DiscoveryRequestOptions): Promise<DiscoveryResult<T>> => {
        if (!this.#current(c) || options?.signal?.aborted) {
          return { ok: false, error: { kind: 'cancelled' } };
        }
        const remaining = this.#remaining();
        if (remaining > 0) {
          return { ok: false, error: { kind: 'rate-limited', status: 429, retryAfterMs: Math.ceil(remaining) } };
        }
        this.#status = { ...this.#status, phase: 'discovering' };
        this.#notify();
        if (!this.#current(c) || options?.signal?.aborted) {
          return { ok: false, error: { kind: 'cancelled' } };
        }
        const result = await invoke();
        // Observe before 4B adopts the promise; do not transfer responses first observed after abandonment.
        if (this.#current(c) && !options?.signal?.aborted && result.ok === false) {
          const e = result.error;
          const valid = Number.isSafeInteger(e.retryAfterMs) && number(e.retryAfterMs);
          if (e.status === 429 || e.kind === 'rate-limited' || (e.status === 503 && valid)) {
            const now = this.#now();
            const old = this.#cooldown ? Math.max(0, this.#cooldown.duration - (now - this.#cooldown.start)) : 0;
            this.#cooldown = { start: now, duration: Math.max(old, valid ? e.retryAfterMs! : 60000) };
          }
        }
        return result;
      };
      c.runner = createDiscoveryRunner({ tokenProvider: this.#tokens, contextSignal: c.controller.signal,
        clock: this.#clock, scheduler: this.#options.scheduler, discoveryClient: {
          getAccount: (t, o) => request(() => client.getAccount(t, o), o),
          getHouseholds: (t, o) => request(() => client.getHouseholds(t, o), o),
          getTonieboxes: (t, h, o) => request(() => client.getTonieboxes(t, h, o), o),
        } });
      this.#status = { phase: 'idle', discovery: 'never', authority: 'none', devices: 0, connections: [] };
    } catch {
      this.#fatal('dependency'); return fail('dependency');
    } finally {
      this.#changing = false;
    }
    this.#notify();
    return { ok: true };
  }
  setPolicy(value?: CompatibilityPolicy): CoordinatorResult {
    if (this.#stopped) {
      return fail('stopped');
    }
    if (this.#changing || this.#context?.operation) {
      return fail('busy');
    }
    this.#policy = policyCopy(value);
    const c = this.#context;
    if (c) {
      try {
        this.#apply(c, unavailable); this.#refresh(c); this.#notify();
      } catch {
        this.#fatal('dependency'); return fail('dependency');
      }
    }
    return { ok: true };
  }
  start(): CoordinatorResult {
    if (this.#stopped) {
      return fail('stopped');
    }
    const c = this.#context;
    if (!c) {
      return fail(this.#attention ? 'invalidated' : 'not-configured');
    }
    if (!c.started) {
      c.started = true; void this.discover();
    }
    return { ok: true };
  }
  #install(c: Context, plan: ApprovedRoutePlan): Slot {
    const slot: Slot = { active: true, plan, state: createBackendState({ context: c.key }), status: { phase: 'idle', connected: false } };
    const bound = slot.state.bind(plan);
    if (!bound.ok) {
      throw new Error('Invalid binding');
    }
    const live = (): boolean => this.#current(c) && slot.active;
    let previouslyReady = false;
    let diagnosticTransition: object = {};
    let diagnosticKey = '';
    const lifecycle = (this.#options.lifecycleFactory ?? createMqttLifecycle)({
      tokenProvider: this.#tokens, accountUuid: plan.accountUuid, routes: plan.routes, contextSignal: c.controller.signal,
      ...(this.#options.enablePlaybackCommands === true && plan.lane === 'production'
        ? { playbackRouteIds: plan.routes.filter(playbackEligible).map(route => route.routeId) } : {}),
      clock: { now: () => this.#now() }, scheduler: this.#options.scheduler,
      onStatus: raw => {
        if (!live()) {
          return;
        }
        try {
          const status = safeStatus(raw);
          const accepted = bound.binding.onStatus(status);
          if (!accepted.accepted) {
            if (accepted.reason === 'stale') {
              return;
            }
            throw new Error('State contract');
          }
          const newSession = status.phase === 'ready' && slot.status.session !== status.session;
          slot.status = status;
          for (const p of [...this.#commands.values()]) {
            if (p.slot === slot && (status.phase !== 'ready' || status.session !== p.session)) {
              this.#settleCommand(p, commandFailure('interrupted', p.invoked));
            }
          }
          if (this.#commissioning) {
            quiet(() => {
              previouslyReady ||= status.phase === 'ready';
              const key = JSON.stringify([status.phase, status.session, status.error?.kind, status.error?.tokenFailure,
                status.error?.origin, status.error?.reasonCode, status.replacement]);
              if (key !== diagnosticKey) {
                diagnosticKey = key;
                const transition = diagnosticTransition = {};
                this.#commissioning!.replacement(plan.lane, status, () => live() && diagnosticTransition === transition);
                this.#commissioning!.lifecycle(plan.lane, status, previouslyReady,
                  () => live() && diagnosticTransition === transition);
              }
            });
          }
          if (newSession && this.#commissioning) {
            quiet(() => this.#commissioning!.session(plan.lane, () => live() && slot.status.session === status.session));
          }
          this.#refresh(c);
          if (plan.lane === 'production' && accepted.changed) {
            this.#productionNotice('transport', () => live() && c.production === slot);
          }
          this.#notify();
        } catch {
          if (live()) {
            this.#fatal('dependency');
          }
        }
      },
      onMessage: message => {
        if (live()) {
          const applied = bound.binding.onMessage(message);
          const pending = this.#commands.get(message.routeId);
          if (applied.accepted && plan.lane === 'production' && pending?.slot === slot && pending.context === c) {
            // Capture acceptance before any clock/status callback can reenter. A duplicate cannot renew confirmation.
            if (pending.evidence !== undefined && message.topic.endsWith('/playback/state')) {
              pending.evidence = pending.invoked && message.session === pending.session && !message.retained && !message.duplicate
                && slot.state.getDevice(message.routeId)?.playback === (pending.action === 'play' ? 'playing' : 'paused');
            }
            this.#completeCommand(pending);
          }
          if (plan.lane === 'production' && applied.accepted && live()) {
            const session = slot.status.session;
            this.#productionNotice('observation',
              () => live() && c.production === slot && slot.status.phase === 'ready' && slot.status.session === session);
          }
          if (this.#commissioning && live()) {
            quiet(() => this.#commissioning!.message(plan.lane, message, applied,
              () => slot.state.getDevice(message.routeId), () => live() && slot.status.phase === 'ready' && slot.status.session === message.session));
          }
        }
      },
    });
    slot.lifecycle = lifecycle;
    if (!live()) {
      this.#close(slot); return slot;
    }
    if (!lifecycle || typeof lifecycle.start !== 'function' || typeof lifecycle.stop !== 'function'
      || lifecycle.getStatus().phase !== 'idle') {
      this.#close(slot); throw new Error('Invalid lifecycle');
    }
    return slot;
  }
  #apply(c: Context, result: DiscoveryRunResult): void {
    const previousProduction = c.production;
    const previousAuthority = this.#status.authority;
    const snapshot = result.ok ? result.snapshot : result.partial;
    if (c.uuid && snapshot?.account.identitySource === 'uuid' && snapshot.account.id !== c.uuid) {
      this.#fatal('invalidated'); return;
    }
    const decision = reconcileRoutes({ previous: c.production?.plan, discovery: result, context: c.key, policy: this.#policy });
    if (decision.authority === 'revoked') {
      this.#fatal('invalidated'); return;
    }
    this.#status = { ...this.#status, authority: decision.plan?.routes.length ? decision.authority : 'none' };
    if (this.#status.authority !== 'current') {
      this.#cancelCommands('invalidated');
    }
    // 6A's retain action compares routing identifiers; its approved plan may confirm a new model.
    const modelChanged = c.production && decision.plan && (!same(c.production.plan, decision.plan)
      // Opted-in command grants are immutable for a transport; changed capability requires a new slot.
      || (this.#options.enablePlaybackCommands === true && c.production.plan.routes.some(route =>
        playbackEligible(route) !== decision.plan!.routes.some(next => next.routeId === route.routeId && playbackEligible(next)))));
    if (decision.action !== 'retain' || modelChanged) {
      const old = c.production; c.production = undefined;
      if (old) {
        this.#close(old);
      }
      if (!this.#current(c)) {
        return;
      }
      if (decision.plan?.routes.length) {
        c.uuid = decision.plan.accountUuid;
        c.production = this.#install(c, decision.plan);
      }
    }
    // Experimental authority is fresh-run-only; never reinterpret a production-only reconciliation API.
    const approval = approveRoutes(result, c.key, this.#policy);
    // Reject the entire oversized set: no ordering-dependent selection and no production disruption.
    const limited = approval.experimental.length > MAX_EXPERIMENTAL_CONNECTIONS;
    this.#status = { ...this.#status, experimentalAdmission: limited ? 'resource-limit' : undefined };
    const desired = limited ? [] : approval.experimental;
    for (const [id, slot] of c.experiments) {
      const next = desired.find(p => p.routes[0].routeId === id);
      if (!next || !same(slot.plan, next)) {
        c.experiments.delete(id); this.#close(slot);
      }
    }
    for (const plan of desired) {
      if (!this.#current(c)) {
        return;
      }
      const id = plan.routes[0].routeId;
      if (!c.experiments.has(id)) {
        c.uuid = plan.accountUuid; c.experiments.set(id, this.#install(c, plan));
      }
    }
    if (this.#commissioning && this.#current(c)) {
      quiet(() => this.#commissioning!.discovery(result, approval, c.production?.plan.routes.length ?? 0,
        this.#policy, () => this.#current(c)));
    }
    if (this.#current(c) && (c.production !== previousProduction || this.#status.authority !== previousAuthority)) {
      const production = c.production;
      this.#productionNotice('inventory', () => this.#current(c) && c.production === production);
    }
    // All slots/bindings are installed before any lifecycle can emit ready and buffered messages.
    for (const slot of this.#slots(c)) {
      if (!this.#current(c)) {
        return;
      }
      if (slot.status.phase === 'idle') {
 slot.lifecycle!.start();
      }
    }
  }
  #recovery(result: DiscoveryRunResult): DiscoveryRecovery {
    const coverage = result.ok ? result.snapshot.enumeration === 'finished' ? 'complete' : 'partial'
      : result.partial ? 'partial' : 'unknown';
    if (result.ok) {
      return { disposition: 'none', reason: coverage === 'complete' ? 'complete' : 'incomplete', coverage };
    }
    const e = result.error;
    const none = (reason: DiscoveryRecoveryReason): DiscoveryRecovery => ({ disposition: 'none', reason, coverage });
    const attention = (reason: DiscoveryRecoveryReason): DiscoveryRecovery => ({ disposition: 'attention', reason, coverage });
    if (e.kind === 'cancelled' || e.kind === 'invalidated' || e.kind === 'stopped') {
      return none(e.kind);
    }
    if (e.kind === 'clock-invalid' || e.kind === 'dependency') {
      return attention(e.kind);
    }
    try {
      const token = this.#tokens.getStatus();
      const retry = (reason: DiscoveryRecoveryReason): DiscoveryRecovery => {
        const delays = [e.retryAfterMs, e.discoveryFailure?.retryAfterMs, e.tokenFailure?.retryAfterMs,
          this.#remaining(), token.renewal === 'backoff' ? token.retryAfterMs : undefined];
        const minimumRetryDelayMs = Math.max(0, ...delays.filter(number));
        return { disposition: 'retry', reason, coverage, ...(minimumRetryDelayMs > 0 ? { minimumRetryDelayMs } : {}) };
      };
      if (token.renewal === 'attention-required') {
        return attention(token.reason === 'clock-invalid' ? 'clock-invalid' : 'authentication');
      }
      if (token.renewal === 'stopped') {
        return none('stopped');
      }
      if (e.kind === 'authentication') {
        return e.tokenFailure?.kind === 'backoff' || e.tokenFailure?.kind === 'rate-limited'
          ? retry(e.tokenFailure.kind === 'rate-limited' ? 'rate-limited' : 'authentication') : attention('authentication');
      }
      const http = e.discoveryFailure;
      if (http?.status === 401 || http?.kind === 'unauthorized') {
        return attention('authentication');
      }
      if (http?.status === 403 || http?.kind === 'forbidden') {
        return attention('permission');
      }
      if (http?.status === 429 || http?.kind === 'rate-limited' || e.kind === 'cooldown') {
        return retry('rate-limited');
      }
      if (e.kind === 'deadline' || e.kind === 'token-expired') {
        return retry(e.kind);
      }
      if (http?.kind === 'transport' || http?.kind === 'timeout'
        || (http?.kind === 'http' && [408, 500, 502, 503, 504].includes(http.status ?? 0))) {
        return retry('transient');
      }
      return attention(http?.kind === 'invalid-response' ? 'invalid-response' : 'dependency');
    } catch {
      return attention('clock-invalid');
    }
  }
  discover(options: { readonly signal?: AbortSignal } = {}): Promise<CoordinatorResult> {
    // Detach metadata for each waiter, including shared runs; do not inspect a replacement context here.
    return this.#discover(options).then(result => {
      if (result.recovery) {
        return structuredClone(result);
      }
      const reason = result.ok ? undefined : result.reason;
      const recovery: DiscoveryRecovery = reason === 'cooldown'
        ? { disposition: 'retry', reason: 'rate-limited', coverage: 'unknown',
          ...(number(result.ok ? undefined : result.retryAfterMs) ? { minimumRetryDelayMs: result.ok ? undefined : result.retryAfterMs } : {}) }
        : reason === 'cancelled' || reason === 'invalidated' || reason === 'stopped'
          ? { disposition: 'none', reason, coverage: 'unknown' }
          : { disposition: 'attention', reason: reason === 'clock-invalid' || reason === 'dependency' || reason === 'authentication' ? reason : 'not-ready',
            coverage: 'unknown' };
      return { ...result, recovery };
    });
  }
  #discover(options: { readonly signal?: AbortSignal } = {}): Promise<CoordinatorResult> {
    if (this.#stopped) {
      return Promise.resolve(fail('stopped'));
    }
    if (!options || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      return Promise.resolve(fail('invalid-input'));
    }
    if (options.signal?.aborted) {
      return Promise.resolve(fail('cancelled'));
    }
    const c = this.#context;
    if (!c) {
      return Promise.resolve(fail(this.#attention ? 'invalidated' : 'not-configured'));
    }
    if (!c.started) {
      return Promise.resolve(fail('not-started'));
    }
    if (!c.operation) {
      try {
        const remaining = this.#remaining();
        if (remaining > 0) {
          return Promise.resolve(fail('cooldown', Math.ceil(remaining)));
        }
      } catch {
        this.#fatal('clock-invalid'); return Promise.resolve(fail('clock-invalid'));
      }
      let resolve!: (result: CoordinatorResult) => void;
      const promise = new Promise<CoordinatorResult>(done => {
        resolve = done;
      });
      const op = { promise, resolve }; c.operation = op;
      this.#status = { ...this.#status, phase: 'authentication-pending', discovery: 'running' };
      this.#notify();
      void Promise.resolve().then(async () => {
        if (!this.#current(c) || c.operation !== op) {
          return;
        }
        const result = await c.runner!.discover();
        if (!this.#current(c) || c.operation !== op) {
          return;
        }
        this.#status = { ...this.#status, discovery: result.ok && result.snapshot.enumeration === 'finished' ? 'complete' : 'degraded' };
        this.#apply(c, result);
        if (!this.#current(c) || c.operation !== op) {
          return;
        }
        c.operation = undefined;
        const authentication = !result.ok && (result.error.kind === 'authentication'
          || result.error.discoveryFailure?.kind === 'unauthorized');
        const retry = !result.ok ? result.error.retryAfterMs : undefined;
        this.#status = { ...this.#status, reason: result.ok ? undefined : authentication ? 'authentication' : 'discovery',
          ...(number(retry) ? { retryAfterMs: retry } : { retryAfterMs: undefined }) };
        this.#refresh(c);
        if (authentication && this.#tokens.getStatus().renewal === 'attention-required') {
          this.#status = { ...this.#status, phase: 'attention-required' };
        }
        op.resolve({ ...(result.ok ? { ok: true as const } : fail(authentication ? 'authentication' : 'discovery', retry)),
          recovery: this.#recovery(result) });
        this.#notify();
      }).catch(() => {
        if (this.#current(c) && c.operation === op) {
          this.#fatal('dependency');
        }
      });
    }
    const pending = c.operation?.promise;
    if (!pending) {
      return Promise.resolve(fail('invalidated'));
    }
    const signal = options.signal;
    if (!signal) {
      return pending;
    }
    return new Promise(resolve => {
      let done = false;
      const abort = (): void => {
        if (!done) {
          done = true;
          signal.removeEventListener('abort', abort);
          resolve(fail('cancelled'));
        }
      };
      const finish = (value: CoordinatorResult): void => {
        if (!done) {
          done = true; signal.removeEventListener('abort', abort); resolve(value);
        }
      };
      signal.addEventListener('abort', abort, { once: true });
      void pending.then(finish);
      if (signal.aborted) {
        abort();
      }
    });
  }
  getProductionInventory(): ProductionInventory {
    const c = this.#context;
    const slot = c?.production;
    if (!c || !this.#current(c) || !slot?.active || slot.plan.lane !== 'production'
      || (this.#status.authority !== 'current' && this.#status.authority !== 'last-known')) {
      return Object.freeze({ authority: 'none', devices: Object.freeze([]) });
    }
    // Only installed approved plans supply identity. Never project raw discovery or last-known state.
    return Object.freeze({
      authority: this.#status.authority, accountUuid: slot.plan.accountUuid, identitySource: 'uuid',
      devices: Object.freeze(slot.plan.routes.map(route => Object.freeze({
        routeId: route.routeId, macAddress: route.macAddress,
        ...(route.identity.name === undefined ? {} : { displayName: route.identity.name }),
      }))),
    });
  }

  getStatus(): CoordinatorStatus {
    return structuredClone(this.#status);
  }
  getDevice(routeId: string, lane: 'production' | 'experimental' = 'production', nowMs?: number) {
    const c = this.#context;
    if (!c || !this.#current(c)) {
      return undefined;
    }
    return (lane === 'production' ? c.production : c.experiments.get(routeId))?.state.getDevice(routeId, nowMs);
  }
  clear(): void {
    if (this.#stopped || this.#changing) {
      return;
    }
    this.#changing = true;
    this.#release('invalidated');
    if (this.#stopped) {
      this.#changing = false; return;
    }
    this.#credentials = undefined; this.#attention = false;
    quiet(() => this.#tokens.clear());
    this.#status = { phase: 'not-configured', discovery: 'never', authority: 'none', devices: 0, connections: [] };
    this.#changing = false; this.#notify();
  }
  invalidate(): void {
    if (this.#stopped) {
      return;
    }
    this.#attention = true; this.#release('invalidated');
    if (this.#stopped) {
      return;
    }
    this.#credentials = undefined;
    quiet(() => this.#tokens.clear());
    this.#status = { phase: 'invalidated', discovery: 'never', authority: 'none', devices: 0, connections: [] };
    this.#notify();
  }
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true; this.#release('stopped'); this.#credentials = undefined;
    quiet(() => this.#tokens.stop());
    this.#status = { phase: 'stopped', discovery: 'never', authority: 'none', devices: 0, connections: [] };
    const epoch = this.#productionEpoch;
    this.#productionNotice('stopped', () => this.#stopped && this.#productionEpoch === epoch);
    this.#notify();
  }
}

export function createAccountCoordinator(options: AccountCoordinatorOptions = {}): AccountCoordinator {
  try {
    return new Coordinator(options);
  } catch {
    throw new TypeError('Invalid account coordinator options');
  }
}
