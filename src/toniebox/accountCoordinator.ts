import { CommissioningObserver } from './commissioning.js';
import { performance } from 'node:perf_hooks';
import { createAuthClient } from './authClient.js';
import { createTokenManager } from './tokenManager.js';
import { createDiscoveryClient } from './discoveryClient.js';
import { createDiscoveryRunner } from './discoveryRunner.js';
import { createMqttLifecycle } from './mqttLifecycle.js';
import { createBackendState } from './backendState.js';
import { approveRoutes, reconcileRoutes } from './routingPolicy.js';
import type { AuthCredentials } from './authTypes.js';
import type { BackendState } from './backendState.js';
import type { DiscoveryResult, DiscoveryRequestOptions } from './discoveryTypes.js';
import type { DiscoveryRunner, DiscoveryRunResult } from './discoveryRunnerTypes.js';
import type { MqttLifecycle, MqttLifecycleStatus } from './mqttLifecycleTypes.js';
import type { ApprovedRoutePlan, CompatibilityPolicy } from './routingTypes.js';
import type { TokenClock, TokenManager } from './tokenManagerTypes.js';
import { MAX_EXPERIMENTAL_CONNECTIONS } from './accountCoordinatorTypes.js';
import type { AccountCoordinator, AccountCoordinatorOptions, CoordinatorFailure, CoordinatorResult, CoordinatorStatus,
  DiscoveryRecovery, DiscoveryRecoveryReason } from './accountCoordinatorTypes.js';

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
  return { phase, connected: phase === 'ready', ...(phase === 'ready' ? { session: raw.session } : {}),
    ...(kind ? { error: { kind, ...(tokenFailure ? { tokenFailure } : {}) } } : {}),
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
  #remaining(): number {
    const now = this.#now();
    return this.#cooldown ? Math.max(0, this.#cooldown.duration - (now - this.#cooldown.start)) : 0;
  }
  #notify(): void {
    try {
      void Promise.resolve(this.#options.onStatus?.(this.getStatus())).catch(() => undefined);
    } catch { /* Observer only. */ }
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
    slot.state.invalidate();
    quiet(() => slot.lifecycle?.stop());
  }
  #release(reason: CoordinatorFailure): void {
    const c = this.#context;
    this.#context = undefined; // Revoke every callback before abort/stop can reenter.
    if (!c) {
      return;
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
          if (this.#commissioning) {
            quiet(() => {
              previouslyReady ||= status.phase === 'ready';
              const key = JSON.stringify([status.phase, status.session, status.error?.kind, status.error?.tokenFailure]);
              if (key !== diagnosticKey) {
                diagnosticKey = key;
                const transition = diagnosticTransition = {};
                this.#commissioning!.lifecycle(plan.lane, status, previouslyReady,
                  () => live() && diagnosticTransition === transition);
              }
            });
          }
          if (newSession && this.#commissioning) {
            quiet(() => this.#commissioning!.session(plan.lane, () => live() && slot.status.session === status.session));
          }
          this.#refresh(c); this.#notify();
        } catch {
          if (live()) {
            this.#fatal('dependency');
          }
        }
      },
      onMessage: message => {
        if (live()) {
          const applied = bound.binding.onMessage(message);
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
    const snapshot = result.ok ? result.snapshot : result.partial;
    if (c.uuid && snapshot?.account.identitySource === 'uuid' && snapshot.account.id !== c.uuid) {
      this.#fatal('invalidated'); return;
    }
    const decision = reconcileRoutes({ previous: c.production?.plan, discovery: result, context: c.key, policy: this.#policy });
    if (decision.authority === 'revoked') {
      this.#fatal('invalidated'); return;
    }
    this.#status = { ...this.#status, authority: decision.plan?.routes.length ? decision.authority : 'none' };
    // 6A's retain action compares routing identifiers; its approved plan may confirm a new model.
    const modelChanged = c.production && decision.plan && !same(c.production.plan, decision.plan);
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
