import { performance } from 'node:perf_hooks';

import type { AuthFailure, OAuthErrorCode } from './authTypes.js';
import type {
  AccountIdentity, DiscoveredToniebox, DiscoveryDiagnostics, DiscoveryFailure, DiscoveryResult, HouseholdIdentity,
} from './discoveryTypes.js';
import type { AccessTokenResult, TokenManagerFailure, TokenManagerFailureKind } from './tokenManagerTypes.js';
import type {
  DiscoveredObservation, DiscoveryClock, DiscoveryRunDiagnostics, DiscoveryRunFailure, DiscoveryRunner,
  DiscoveryRunnerOptions, DiscoveryRunResult, DiscoveryScheduler, DiscoverySnapshot, DiscoveryStage, HouseholdDiscovery,
} from './discoveryRunnerTypes.js';

const OVERALL_MS = 60000;
const TOKEN_ALLOWANCE_MS = 1000;
const ENDED = Symbol('ended');
type Time = ReturnType<DiscoveryClock['now']>;
interface Alarm { cancel(): void }
interface Run {
  controller: AbortController;
  ended: Promise<void>;
  release(): void;
  resolve(result: DiscoveryRunResult): void;
  removeListeners(): void;
  start: Time;
  age: number;
  tokenStart?: Time;
  tokenAge: number;
  tokenMs: number;
  token?: string;
  alarm?: Alarm;
  delay?: Alarm;
  account?: AccountIdentity;
  accountDiagnostics?: DiscoveryDiagnostics;
  householdsDiagnostics?: DiscoveryDiagnostics;
  households: HouseholdDiscovery[];
  devices: DiscoveredObservation[];
  requests: number;
  retries: number;
}

const defaultClock: DiscoveryClock = { now: () => ({ monotonicMs: performance.now(), wallMs: Date.now() }) };
const defaultScheduler: DiscoveryScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const delay = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const status = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 200 && v <= 599;
const tokenKinds: readonly TokenManagerFailureKind[] = [
  'invalid-input', 'cancelled', 'invalidated', 'stopped', 'credentials-required', 'reauthorization-required',
  'backoff', 'authentication-failed', 'rate-limited', 'refresh-recovery-exhausted', 'insufficient-lifetime', 'clock-invalid',
];
const authKinds: readonly AuthFailure['kind'][] = ['invalid-input', 'cancelled', 'timeout', 'transport', 'http', 'invalid-response'];
const oauthCodes: readonly OAuthErrorCode[] = [
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
];
const discoveryKinds: readonly DiscoveryFailure['kind'][] = [
  'invalid-input', 'cancelled', 'timeout', 'transport', 'invalid-response', 'unauthorized', 'forbidden', 'rate-limited', 'http',
];

function copyTokenResult(raw: unknown): AccessTokenResult {
  if (object(raw) && raw.ok === true && text(raw.accessToken) && raw.tokenType === 'Bearer'
    && typeof raw.remainingLifetimeMs === 'number' && Number.isFinite(raw.remainingLifetimeMs)
    && raw.remainingLifetimeMs > 0 && raw.remainingLifetimeMs <= Number.MAX_SAFE_INTEGER) {
    return { ok: true, accessToken: raw.accessToken, tokenType: 'Bearer', remainingLifetimeMs: raw.remainingLifetimeMs };
  }
  if (object(raw) && raw.ok === false && object(raw.error)) {
    const e = raw.error;
    const kind = tokenKinds.find(k => k === e.kind);
    if (kind) {
      let authFailure: AuthFailure | undefined;
      if (object(e.authFailure)) {
        const a = e.authFailure;
        const authKind = authKinds.find(k => k === a.kind);
        const oauthError = oauthCodes.find(k => k === a.oauthError);
        if (authKind) {
          authFailure = {
            kind: authKind, ...(status(a.status) ? { status: a.status } : {}),
            ...(oauthError ? { oauthError } : {}),
          };
        }
      }
      const error: TokenManagerFailure = {
        kind, ...(typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)
          && e.retryAfterMs >= 0 && e.retryAfterMs <= Number.MAX_SAFE_INTEGER ? { retryAfterMs: e.retryAfterMs } : {}),
        ...(authFailure ? { authFailure } : {}),
      };
      return { ok: false, error };
    }
  }
  throw ENDED;
}

function copyFailure(raw: unknown): DiscoveryFailure {
  if (!object(raw)) {
    throw ENDED;
  }
  const kind = discoveryKinds.find(k => k === raw.kind);
  if (!kind) {
    throw ENDED;
  }
  return {
    kind, ...(status(raw.status) ? { status: raw.status } : {}),
    ...([429, 503].includes(raw.status as number) && delay(raw.retryAfterMs) ? { retryAfterMs: raw.retryAfterMs } : {}),
  };
}

function copyDiagnostics(raw: unknown): DiscoveryDiagnostics {
  if (!object(raw) || !delay(raw.rejectedEntries) || !delay(raw.degradedEntries) || !delay(raw.duplicateEntries)
    || !delay(raw.ambiguousRoutingEntries) || typeof raw.continuationDetected !== 'boolean'
    || raw.duplicateEntries > raw.rejectedEntries) {
    throw ENDED;
  }
  return {
    rejectedEntries: raw.rejectedEntries, degradedEntries: raw.degradedEntries, duplicateEntries: raw.duplicateEntries,
    ambiguousRoutingEntries: raw.ambiguousRoutingEntries, continuationDetected: raw.continuationDetected,
  };
}

/** Copy the normalised dependency contract only. Wire parsing remains exclusively in 4A. */
function copyAccount(raw: unknown): AccountIdentity {
  if (!object(raw) || !text(raw.id) || (raw.identitySource !== 'uuid' && raw.identitySource !== 'id')) {
    throw ENDED;
  }
  return { id: raw.id, identitySource: raw.identitySource };
}

function copyHousehold(raw: unknown): HouseholdIdentity {
  if (!object(raw) || !text(raw.id) || (raw.name !== undefined && typeof raw.name !== 'string')) {
    throw ENDED;
  }
  return { id: raw.id, ...(raw.name === undefined ? {} : { name: raw.name }) };
}

function copyBox(raw: unknown): DiscoveredToniebox {
  if (!object(raw) || !text(raw.id)) {
    throw ENDED;
  }
  const value: Record<string, unknown> = { id: raw.id };
  for (const key of ['householdId', 'itemId', 'macAddress', 'name', 'product', 'generation']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string') {
        throw ENDED;
      }
      value[key] = key === 'macAddress' ? raw[key].toUpperCase() : raw[key];
    }
  }
  if (raw.features !== undefined) {
    if (!Array.isArray(raw.features) || !raw.features.every(text)) {
      throw ENDED;
    }
    value.features = [...raw.features];
  }
  if (raw.routingAmbiguous !== undefined) {
    if (raw.routingAmbiguous !== true) {
      throw ENDED;
    }
    value.routingAmbiguous = true;
  }
  return value as unknown as DiscoveredToniebox;
}

function copyArray<T>(raw: unknown, copy: (value: unknown) => T): T[] {
  if (!Array.isArray(raw)) {
    throw ENDED;
  }
  return raw.map(copy);
}

function copyResponse<T>(raw: unknown, copy: (value: unknown) => T): DiscoveryResult<T> {
  if (!object(raw)) {
    throw ENDED;
  }
  if (raw.ok === false) {
    return { ok: false, error: copyFailure(raw.error) };
  }
  if (raw.ok !== true) {
    throw ENDED;
  }
  return { ok: true, value: copy(raw.value), diagnostics: copyDiagnostics(raw.diagnostics) };
}

function summary(run?: Run): DiscoveryRunDiagnostics {
  const values = run ? [
    run.accountDiagnostics, run.householdsDiagnostics,
    ...run.households.map(h => h.outcome === 'received' ? h.diagnostics : undefined),
  ].filter((d): d is DiscoveryDiagnostics => d !== undefined) : [];
  return {
    requests: run?.requests ?? 0, retries: run?.retries ?? 0,
    rejectedEntries: values.reduce((n, d) => n + d.rejectedEntries, 0),
    degradedEntries: values.reduce((n, d) => n + d.degradedEntries, 0),
    duplicateEntries: values.reduce((n, d) => n + d.duplicateEntries, 0),
    continuationDetected: values.some(d => d.continuationDetected),
    failedHouseholds: run?.households.filter(h => h.outcome === 'failed').length ?? 0,
    unattemptedHouseholds: run?.households.filter(h => h.outcome === 'unattempted').length ?? 0,
    interruptedHouseholds: run?.households.filter(h => h.outcome === 'interrupted').length ?? 0,
    identityConflictEntries: 0, ambiguousRoutingEntries: 0,
    missingMacEntries: run?.devices.filter(d => !d.device.macAddress).length ?? 0,
  };
}

function snapshot(run: Run, diagnostics: DiscoveryRunDiagnostics, interrupted: boolean): DiscoverySnapshot | undefined {
  if (!run.account || !run.accountDiagnostics) {
    return undefined;
  }
  const ids = new Map<string, Set<string>>();
  const macs = new Map<string, number>();
  for (const observation of run.devices) {
    const groups = ids.get(observation.device.id) ?? new Set<string>();
    groups.add(observation.requestedHouseholdId);
    ids.set(observation.device.id, groups);
    const mac = observation.device.macAddress;
    if (mac) {
      macs.set(mac, (macs.get(mac) ?? 0) + 1);
    }
  }
  const devices = run.devices.map(observation => ({
    requestedHouseholdId: observation.requestedHouseholdId,
    device: {
      ...copyBox(observation.device),
      ...(observation.device.macAddress && macs.get(observation.device.macAddress)! > 1 ? { routingAmbiguous: true as const } : {}),
    },
    ...(ids.get(observation.device.id)!.size > 1 ? { identityConflict: true as const } : {}),
  }));
  const partial = interrupted || !run.householdsDiagnostics || diagnostics.rejectedEntries > 0
    || diagnostics.continuationDetected || diagnostics.failedHouseholds > 0
    || diagnostics.unattemptedHouseholds > 0 || diagnostics.interruptedHouseholds > 0;
  return {
    account: { ...run.account }, accountDiagnostics: { ...run.accountDiagnostics },
    ...(run.householdsDiagnostics ? { householdsDiagnostics: { ...run.householdsDiagnostics } } : {}),
    households: run.households.map(h => {
      const identity = { ...h.identity };
      if (h.outcome === 'received') {
        return { identity, outcome: h.outcome, diagnostics: { ...h.diagnostics } };
      }
      return h.outcome === 'failed' ? { identity, outcome: h.outcome, error: { ...h.error } } : { identity, outcome: h.outcome };
    }),
    devices, enumeration: partial ? 'partial' : 'finished',
    routing: {
      conflicts: devices.some(d => d.identityConflict || d.device.routingAmbiguous) ? 'observed' : 'none-observed',
      evidence: partial ? 'insufficient' : 'observed-endpoints',
    },
  };
}

function cancel(alarm?: Alarm): void {
  try {
    alarm?.cancel();
  } catch {
    // Run and alarm identities protect against callbacks even if cancellation fails.
  }
}

class AccountDiscoveryRunner implements DiscoveryRunner {
  readonly #options: DiscoveryRunnerOptions;
  readonly #clock: DiscoveryClock;
  readonly #scheduler: DiscoveryScheduler;
  #active?: Run;
  #stopped = false;
  #clockInvalid = false;
  #lastMonotonic = -Infinity;
  #cooldown?: { start: number; delay: number };

  constructor(options: DiscoveryRunnerOptions) {
    this.#options = { ...options };
    this.#clock = options.clock ?? defaultClock;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  #now(): Time {
    const t = this.#clock.now();
    if (this.#clockInvalid || !Number.isFinite(t.monotonicMs) || t.monotonicMs < 0 || t.monotonicMs < this.#lastMonotonic
      || !Number.isFinite(t.wallMs)) {
      throw ENDED;
    }
    this.#lastMonotonic = t.monotonicMs;
    return { monotonicMs: t.monotonicMs, wallMs: t.wallMs };
  }

  #remainingCooldown(now: Time): number {
    return this.#cooldown ? Math.max(0, this.#cooldown.delay - (now.monotonicMs - this.#cooldown.start)) : 0;
  }

  #finish(run: Run, error?: DiscoveryRunFailure): void {
    if (this.#active !== run) {
      return;
    }
    this.#active = undefined;
    const diagnostics = summary(run);
    const publish = !error || !['cancelled', 'invalidated', 'stopped', 'clock-invalid', 'dependency'].includes(error.kind);
    const value = publish ? snapshot(run, diagnostics, error !== undefined) : undefined;
    const counted = value ? {
      ...diagnostics,
      identityConflictEntries: value.devices.filter(d => d.identityConflict).length,
      ambiguousRoutingEntries: value.devices.filter(d => d.device.routingAmbiguous).length,
    } : diagnostics;
    cancel(run.alarm);
    cancel(run.delay);
    run.alarm = undefined;
    run.delay = undefined;
    run.removeListeners();
    run.token = undefined;
    run.account = undefined;
    run.accountDiagnostics = undefined;
    run.householdsDiagnostics = undefined;
    run.households = [];
    run.devices = [];
    run.release();
    run.controller.abort();
    if (error) {
      run.resolve({ ok: false, error, ...(value ? { partial: value } : {}), diagnostics: counted });
    } else {
      run.resolve({ ok: true, snapshot: value!, diagnostics: counted });
    }
  }

  #check(run: Run, observedFailure?: DiscoveryFailure): Time | undefined {
    if (this.#active !== run) {
      return undefined;
    }
    if (this.#options.contextSignal.aborted) {
      this.#finish(run, { kind: 'invalidated' });
      return undefined;
    }
    let now: Time;
    try {
      now = this.#now();
    } catch {
      this.#clockInvalid = true;
      this.#finish(run, { kind: 'clock-invalid' });
      return undefined;
    }
    run.age = Math.max(run.age, now.monotonicMs - run.start.monotonicMs, now.wallMs - run.start.wallMs);
    if (run.tokenStart) {
      run.tokenAge = Math.max(run.tokenAge, now.monotonicMs - run.tokenStart.monotonicMs, now.wallMs - run.tokenStart.wallMs);
    }
    // Keep only rate-limit metadata observed by the current run at/before its boundary.
    // Deadline-first abandonment wins; observing metadata never admits an expired snapshot.
    if (observedFailure && run.age <= OVERALL_MS && (!run.tokenStart || run.tokenAge <= run.tokenMs)) {
      const limited = observedFailure.status === 429 || observedFailure.kind === 'rate-limited';
      if (limited || (observedFailure.status === 503 && observedFailure.retryAfterMs !== undefined)) {
        const ms = observedFailure.retryAfterMs ?? 60000; // Local 429 fallback, not observed server policy.
        this.#cooldown = { start: now.monotonicMs, delay: Math.max(ms, this.#remainingCooldown(now)) };
      }
    }
    if (run.age >= OVERALL_MS || (run.tokenStart && run.tokenAge >= run.tokenMs)) {
      this.#finish(run, { kind: run.age >= OVERALL_MS ? 'deadline' : 'token-expired' });
      return undefined;
    }
    return now;
  }

  #remaining(run: Run): number {
    return Math.min(OVERALL_MS - run.age, run.tokenStart ? run.tokenMs - run.tokenAge : Infinity);
  }

  #arm(run: Run): void {
    cancel(run.alarm);
    run.alarm = undefined;
    if (!this.#check(run)) {
      return;
    }
    const alarm: Alarm = { cancel: () => undefined };
    run.alarm = alarm;
    alarm.cancel = this.#scheduler.schedule(() => {
      if (this.#active === run && run.alarm === alarm) {
        run.alarm = undefined;
        if (this.#check(run)) {
          try {
            this.#arm(run);
          } catch {
            this.#finish(run, { kind: 'dependency' });
          }
        }
      }
    }, Math.max(1, Math.ceil(this.#remaining(run))));
  }

  async #wait<T>(run: Run, invoke: () => Promise<unknown> | unknown, copy: (value: unknown) => T): Promise<T> {
    if (!this.#check(run)) {
      throw ENDED;
    }
    // Install the run before invocation. Both branches observe late rejection even after cancellation.
    const pending = Promise.resolve().then(() => {
      if (!this.#check(run)) {
        throw ENDED;
      }
      return invoke();
    }).then(value => {
      if (!this.#check(run)) {
        throw ENDED;
      }
      const copied = copy(value);
      if (!this.#check(run)) {
        throw ENDED;
      }
      return copied;
    });
    const value = await Promise.race([pending, run.ended.then(() => {
      throw ENDED;
    })]);
    if (!this.#check(run)) {
      throw ENDED;
    }
    return value;
  }

  async #sleep(run: Run, ms: number): Promise<void> {
    await this.#wait(run, () => new Promise<void>(resolve => {
      const alarm: Alarm = { cancel: () => undefined };
      run.delay = alarm;
      const now = this.#check(run);
      if (!now) {
        return;
      }
      const start = now.monotonicMs;
      const wake = (): void => {
        if (this.#active !== run || run.delay !== alarm) {
          return;
        }
        const now = this.#check(run);
        if (!now) {
          return;
        }
        const left = ms - (now.monotonicMs - start);
        if (left > 0) {
          try {
            alarm.cancel = this.#scheduler.schedule(wake, Math.ceil(left));
          } catch {
            this.#finish(run, { kind: 'dependency' });
          }
        } else {
          run.delay = undefined;
          resolve();
        }
      };
      alarm.cancel = this.#scheduler.schedule(wake, Math.ceil(ms));
    }), () => undefined);
  }

  async #get<T>(run: Run, stage: DiscoveryStage, invoke: () => Promise<DiscoveryResult<T>>, copy: (raw: unknown) => T)
    : Promise<DiscoveryResult<T>> {
    let retry = false;
    while (this.#check(run)) {
      const result = await this.#wait(run, () => {
        run.requests++;
        if (retry) {
          run.retries++;
        }
        // Attach directly to the dependency promise, before #wait's deadline checks/adoption.
        // Observation means this reaction has run, not merely that a transport resolved elsewhere.
        return invoke().then(raw => {
          if (this.#active === run && !this.#options.contextSignal.aborted && object(raw) && raw.ok === false) {
            this.#check(run, copyFailure(raw.error));
          }
          return raw;
        });
      }, raw => copyResponse(raw, copy));
      if (!this.#check(run)) {
        throw ENDED;
      }
      if (result.ok) {
        return result;
      }
      const error = result.error;
      const limited = error.status === 429 || error.kind === 'rate-limited';
      if (limited || error.status === 401 || error.kind === 'unauthorized') {
        return result;
      }
      const retryable = error.kind === 'transport' || error.kind === 'timeout'
        || (error.kind === 'http' && [408, 500, 502, 503, 504].includes(error.status ?? 0));
      if (!retryable || run.retries > 0) {
        return result;
      }
      const ms = Math.max(1000, error.status === 503 ? error.retryAfterMs ?? 0 : 0);
      if (ms >= this.#remaining(run)) {
        this.#finish(run, { kind: 'retry-deferred', stage, discoveryFailure: error, retryAfterMs: ms });
        throw ENDED;
      }
      await this.#sleep(run, ms);
      retry = true;
    }
    throw ENDED;
  }

  async #run(run: Run): Promise<void> {
    try {
      const token = await this.#wait(run,
        () => this.#options.tokenProvider.getAccessToken({ signal: run.controller.signal }), copyTokenResult);
      const received = this.#check(run);
      if (!received) {
        return;
      }
      if (!token.ok) {
        this.#finish(run, { kind: 'authentication', tokenFailure: token.error, retryAfterMs: token.error.retryAfterMs });
        return;
      }
      // remainingLifetimeMs is already aged by 3B: do not subtract acquisition duration again.
      run.token = token.accessToken;
      run.tokenStart = received;
      run.tokenMs = token.remainingLifetimeMs - TOKEN_ALLOWANCE_MS;
      this.#arm(run);
      if (!this.#check(run)) {
        return;
      }
      const client = this.#options.discoveryClient;
      const options = { signal: run.controller.signal };
      const account = await this.#get(run, 'account', () => client.getAccount(run.token!, options), copyAccount);
      if (!this.#check(run)) {
        return;
      }
      if (!account.ok) {
        this.#finish(run, { kind: 'request', stage: 'account', discoveryFailure: account.error });
        return;
      }
      run.account = account.value;
      run.accountDiagnostics = account.diagnostics;
      const households = await this.#get(run, 'households', () => client.getHouseholds(run.token!, options),
        raw => copyArray(raw, copyHousehold));
      if (!this.#check(run)) {
        return;
      }
      if (!households.ok) {
        this.#finish(run, { kind: 'request', stage: 'households', discoveryFailure: households.error });
        return;
      }
      // 4A guarantees unique accepted household IDs; reject a broken injected contract, not arbitrary winners.
      if (new Set(households.value.map(h => h.id)).size !== households.value.length) {
        throw ENDED;
      }
      run.householdsDiagnostics = households.diagnostics;
      run.households = households.value.map(identity => ({ identity, outcome: 'unattempted' }));
      for (let index = 0; index < run.households.length; index++) {
        if (!this.#check(run)) {
          return;
        }
        const identity = run.households[index].identity;
        run.households[index] = { identity, outcome: 'interrupted' };
        const boxes = await this.#get(run, 'tonieboxes', () => client.getTonieboxes(run.token!, identity.id, options),
          raw => copyArray(raw, copyBox));
        if (!this.#check(run)) {
          return;
        }
        if (boxes.ok) {
          run.households[index] = { identity, outcome: 'received', diagnostics: boxes.diagnostics };
          run.devices.push(...boxes.value.map(device => ({ requestedHouseholdId: identity.id, device })));
        } else {
          const error = boxes.error;
          run.households[index] = { identity, outcome: 'failed', error };
          // Only evidenced endpoint-local failures permit moving to another household.
          const local = error.kind === 'invalid-response' || error.kind === 'forbidden' || [403, 404].includes(error.status ?? 0);
          if (!local) {
            this.#finish(run, { kind: 'request', stage: 'tonieboxes', discoveryFailure: error });
            return;
          }
        }
      }
      if (this.#check(run)) {
        this.#finish(run);
      }
    } catch {
      if (this.#check(run)) {
        this.#finish(run, { kind: 'dependency' });
      }
    }
  }

  discover(options: { readonly signal?: AbortSignal } = {}): Promise<DiscoveryRunResult> {
    const failure = (error: DiscoveryRunFailure): Promise<DiscoveryRunResult> =>
      Promise.resolve({ ok: false, error, diagnostics: summary() });
    if (this.#stopped) {
      return failure({ kind: 'stopped' });
    }
    if (this.#options.contextSignal.aborted) {
      return failure({ kind: 'invalidated' });
    }
    if (!object(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      return failure({ kind: 'invalid-input' });
    }
    if (options.signal?.aborted) {
      return failure({ kind: 'cancelled' });
    }
    if (this.#active) {
      return failure({ kind: 'busy' });
    }
    let now: Time;
    try {
      now = this.#now();
    } catch {
      this.#clockInvalid = true;
      return failure({ kind: 'clock-invalid' });
    }
    const retryAfterMs = this.#remainingCooldown(now);
    if (retryAfterMs > 0) {
      return failure({ kind: 'cooldown', retryAfterMs });
    }
    this.#cooldown = undefined;
    return new Promise(resolve => {
      let release!: () => void;
      const ended = new Promise<void>(done => {
        release = done;
      });
      const run: Run = {
        controller: new AbortController(), ended, release, resolve, removeListeners: () => undefined,
        start: now, age: 0, tokenAge: 0, tokenMs: 0, households: [], devices: [], requests: 0, retries: 0,
      };
      this.#active = run;
      const onCaller = (): void => this.#finish(run, { kind: 'cancelled' });
      const onContext = (): void => this.#finish(run, { kind: 'invalidated' });
      run.removeListeners = () => {
        options.signal?.removeEventListener('abort', onCaller);
        this.#options.contextSignal.removeEventListener('abort', onContext);
      };
      options.signal?.addEventListener('abort', onCaller, { once: true });
      this.#options.contextSignal.addEventListener('abort', onContext, { once: true });
      try {
        this.#arm(run);
        if (options.signal?.aborted) {
          onCaller();
        }
        if (this.#options.contextSignal.aborted) {
          onContext();
        }
        if (this.#active === run) {
          void this.#run(run);
        }
      } catch {
        this.#finish(run, { kind: 'dependency' });
      }
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#active) {
      this.#finish(this.#active, { kind: 'stopped' });
    }
  }
}

/** No registry, storage, logging or default network transport. One runner per explicitly owned account context. */
export function createDiscoveryRunner(options: DiscoveryRunnerOptions): DiscoveryRunner {
  if (!options || typeof options.tokenProvider?.getAccessToken !== 'function'
    || !(options.contextSignal instanceof AbortSignal)
    || ['getAccount', 'getHouseholds', 'getTonieboxes'].some(k => typeof options.discoveryClient?.[k as keyof typeof options.discoveryClient] !== 'function')
    || (options.clock !== undefined && typeof options.clock.now !== 'function')
    || (options.scheduler !== undefined && typeof options.scheduler.schedule !== 'function')) {
    throw new TypeError('Invalid discovery runner options');
  }
  return new AccountDiscoveryRunner(options);
}
