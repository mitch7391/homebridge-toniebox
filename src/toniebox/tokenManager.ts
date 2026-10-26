import { performance } from 'node:perf_hooks';

import type { AuthClient, AuthCredentials, AuthFailure, AuthResult, AuthTokens, OAuthErrorCode } from './authTypes.js';
import type {
  AccessTokenResult, CredentialUpdateResult, TokenClock, TokenManager, TokenManagerFailure,
  TokenManagerFailureKind, TokenManagerOptions, TokenManagerStatus, TokenScheduler,
} from './tokenManagerTypes.js';

const MIN_GRANT_MS = 30000;
const MAX_TIMER_MS = 2147483647;
const RECOVERY_MS = [30000, 120000, 900000, 1800000, 3600000] as const;
const OAUTH_ERRORS: readonly OAuthErrorCode[] = [
  'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
];
const FAILURE_KINDS: readonly AuthFailure['kind'][] = [
  'invalid-input', 'cancelled', 'timeout', 'transport', 'http', 'invalid-response',
];
type Time = ReturnType<TokenClock['now']>;
type OperationKind = 'login' | 'refresh';
interface Pair {
  access?: string;
  refresh?: string;
  accessMs: number;
  refreshMs?: number;
  start: Time;
  age: number;
}
interface Flight {
  generation: number;
  kind: OperationKind;
  start: Time;
  controller: AbortController;
  done: Promise<void>;
  settle: () => void;
}
interface Timer {
  cancel: () => void;
}

const defaultClock: TokenClock = {
  now: () => ({ monotonicMs: performance.now(), wallMs: Date.now() }),
};
const defaultScheduler: TokenScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && /\S/u.test(value);
const isLifetime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const renewalPoint = (lifetime: number): number => lifetime - Math.min(60000, lifetime * 0.2);
const pairRenewal = (pair: Pair): number => Math.min(
  renewalPoint(pair.accessMs), pair.refreshMs === undefined ? Infinity : renewalPoint(pair.refreshMs),
);

/** Check the injected client's normalised contract, not the OAuth wire schema. */
function normaliseResult(raw: unknown): AuthResult {
  if (isObject(raw) && raw.ok === true && isObject(raw.tokens)) {
    const value = raw.tokens;
    if (isText(value.accessToken) && isText(value.refreshToken) && value.tokenType === 'Bearer'
      && isLifetime(value.expiresInSeconds)
      && (value.refreshExpiresInSeconds === undefined || isLifetime(value.refreshExpiresInSeconds))) {
      const tokens: AuthTokens = {
        accessToken: value.accessToken, refreshToken: value.refreshToken, tokenType: 'Bearer',
        expiresInSeconds: value.expiresInSeconds,
        ...(value.refreshExpiresInSeconds === undefined ? {} : { refreshExpiresInSeconds: value.refreshExpiresInSeconds }),
      };
      return { ok: true, tokens };
    }
  }
  if (isObject(raw) && raw.ok === false && isObject(raw.error)) {
    const error = raw.error;
    const kind = FAILURE_KINDS.find(value => value === error.kind);
    if (kind) {
      const status = error.status;
      const oauthError = OAUTH_ERRORS.find(value => value === error.oauthError);
      return { ok: false, error: {
        kind,
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 200 && status <= 599 ? { status } : {}),
        ...(oauthError === undefined ? {} : { oauthError }),
      } };
    }
  }
  return { ok: false, error: { kind: 'invalid-response' } };
}

/** Status takes precedence: even a recognised OAuth code cannot turn 5xx into a definitive rejection. */
function recoverable(kind: OperationKind, error: AuthFailure): boolean {
  if (error.kind === 'http') {
    if (error.status === 429) {
      return false;
    }
    if (error.status === 408 || (error.status !== undefined && error.status >= 500)) {
      return true;
    }
    return kind === 'refresh' && [400, 401, 403].includes(error.status ?? 0) && error.oauthError === 'invalid_grant';
  }
  return error.kind === 'transport' || error.kind === 'timeout' || error.kind === 'cancelled'
    || (kind === 'refresh' && error.kind === 'invalid-response');
}

class AccountTokenManager implements TokenManager {
  readonly #client: AuthClient;
  readonly #clock: TokenClock;
  readonly #scheduler: TokenScheduler;
  #credentials?: AuthCredentials;
  #pair?: Pair;
  #flight?: Flight;
  #timer?: Timer;
  #generation = 0;
  #started = false;
  #stopped = false;
  #attention?: TokenManagerFailureKind;
  #lastFailure?: AuthFailure;
  #notBefore = 0;
  #recoveryStep = 0;
  #passwordSuccesses = 0;
  #lastMonotonic = -Infinity;

  constructor(options: TokenManagerOptions) {
    this.#client = options.authClient;
    this.#clock = options.clock ?? defaultClock;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  #cancelTimer(): void {
    const timer = this.#timer;
    this.#timer = undefined;
    try {
      timer?.cancel();
    } catch {
      // Identity checks also invalidate callbacks from an uncooperative scheduler.
    }
  }

  #cancelFlight(): void {
    const flight = this.#flight;
    this.#flight = undefined;
    if (flight) {
      flight.settle();
      flight.controller.abort();
    }
  }

  #pause(reason: TokenManagerFailureKind, error?: AuthFailure): void {
    this.#attention = reason;
    this.#lastFailure = error;
    this.#credentials = undefined;
    if (this.#pair) {
      this.#pair.refresh = undefined;
    }
    this.#cancelTimer();
  }

  #time(): Time | undefined {
    try {
      const sample = this.#clock.now();
      if (Number.isFinite(sample.monotonicMs) && sample.monotonicMs >= 0 && sample.monotonicMs >= this.#lastMonotonic
        && Number.isFinite(sample.wallMs)) {
        this.#lastMonotonic = sample.monotonicMs;
        return { monotonicMs: sample.monotonicMs, wallMs: sample.wallMs };
      }
    } catch {
      // Clock exceptions are not diagnostics.
    }
    this.#pause('clock-invalid');
    this.#pair = undefined;
    this.#cancelFlight();
    return undefined;
  }

  #observe(now: Time): void {
    const pair = this.#pair;
    if (pair) {
      pair.age = Math.max(pair.age, now.monotonicMs - pair.start.monotonicMs, now.wallMs - pair.start.wallMs, 0);
      if (pair.age >= pair.accessMs) {
        pair.access = undefined;
      }
    }
  }

  #error(kind: TokenManagerFailureKind, now?: Time): { ok: false; error: TokenManagerFailure } {
    return { ok: false, error: {
      kind,
      ...(now && this.#notBefore > now.monotonicMs ? { retryAfterMs: this.#notBefore - now.monotonicMs } : {}),
      ...(this.#lastFailure ? { authFailure: { ...this.#lastFailure } } : {}),
    } };
  }

  #result(generation: number): AccessTokenResult {
    if (this.#stopped) {
      return this.#error('stopped');
    }
    if (generation !== this.#generation) {
      return this.#error('invalidated');
    }
    const now = this.#time();
    if (!now) {
      return this.#error('clock-invalid');
    }
    this.#observe(now);
    const pair = this.#pair;
    if (pair?.access !== undefined) {
      return { ok: true, accessToken: pair.access, tokenType: 'Bearer', remainingLifetimeMs: pair.accessMs - pair.age };
    }
    if (this.#attention) {
      return this.#error(this.#attention, now);
    }
    if (!this.#credentials) {
      return this.#error('credentials-required');
    }
    return this.#error('backoff', now);
  }

  #arm(now: Time): void {
    this.#cancelTimer();
    if (this.#stopped) {
      return;
    }
    this.#observe(now);
    const pair = this.#pair;
    let delay = pair?.access === undefined ? Infinity : pair.accessMs - pair.age;
    if (!this.#attention && this.#started && !this.#flight) {
      const renewal = pair?.refresh === undefined ? 0 : Math.max(0, pairRenewal(pair) - pair.age);
      delay = Math.min(delay, Math.max(renewal, this.#notBefore - now.monotonicMs));
    }
    if (delay === Infinity) {
      return;
    }
    const generation = this.#generation;
    const timer: Timer = { cancel: () => undefined };
    this.#timer = timer;
    try {
      timer.cancel = this.#scheduler.schedule(() => {
        if (this.#timer !== timer || this.#generation !== generation || this.#stopped) {
          return;
        }
        this.#timer = undefined;
        this.#advance();
      }, Math.max(1, Math.min(MAX_TIMER_MS, Math.ceil(delay))));
    } catch {
      this.#pause('invalid-input');
      this.#pair = undefined;
      this.#cancelFlight();
    }
  }

  #recover(now: Time, error?: AuthFailure): void {
    this.#lastFailure = error;
    if (this.#pair) {
      this.#pair.refresh = undefined;
    }
    if (this.#passwordSuccesses >= 3) {
      this.#pause('refresh-recovery-exhausted', error);
      return;
    }
    const delay = RECOVERY_MS[this.#recoveryStep];
    this.#recoveryStep = Math.min(this.#recoveryStep + 1, RECOVERY_MS.length - 1);
    this.#notBefore = Math.max(this.#notBefore, now.monotonicMs + delay);
  }

  #complete(flight: Flight, result: AuthResult): void {
    if (this.#flight !== flight || this.#generation !== flight.generation) {
      return;
    }
    const now = this.#time();
    if (!now) {
      return;
    }
    this.#flight = undefined;
    this.#observe(now);
    if (result.ok) {
      const tokens = result.tokens;
      // One replacement, including both rotated tokens and their request-start timing.
      this.#pair = {
        access: tokens.accessToken, refresh: tokens.refreshToken,
        accessMs: tokens.expiresInSeconds * 1000,
        refreshMs: tokens.refreshExpiresInSeconds === undefined ? undefined : tokens.refreshExpiresInSeconds * 1000,
        start: flight.start, age: 0,
      };
      this.#observe(now);
      this.#lastFailure = undefined;
      if (flight.kind === 'refresh') {
        this.#passwordSuccesses = 0;
        this.#recoveryStep = 0;
      } else {
        this.#passwordSuccesses++;
      }
      if (pairRenewal(this.#pair) - this.#pair.age < MIN_GRANT_MS) {
        this.#pause('insufficient-lifetime');
      }
    } else if (result.error.kind === 'http' && result.error.status === 429) {
      this.#notBefore = Math.max(this.#notBefore, now.monotonicMs + 3600000);
      this.#pause('rate-limited', result.error);
    } else if (recoverable(flight.kind, result.error)) {
      this.#recover(now, result.error);
    } else {
      this.#pause('authentication-failed', result.error);
    }
    this.#arm(now);
    flight.settle();
  }

  async #run(flight: Flight, credentials: AuthCredentials | undefined, refreshToken: string | undefined): Promise<void> {
    let result: AuthResult;
    try {
      const options = { signal: flight.controller.signal };
      const raw = flight.kind === 'login'
        ? await this.#client.login(credentials!, options)
        : await this.#client.refresh(refreshToken!, options);
      // Invalidated results need no parsing, getters, state changes or cleanup of newer work.
      if (this.#flight !== flight || this.#generation !== flight.generation) {
        return;
      }
      result = normaliseResult(raw);
    } catch {
      result = { ok: false, error: { kind: 'transport' } };
    }
    this.#complete(flight, result);
  }

  #dispatch(now: Time): void {
    const kind: OperationKind = this.#pair?.refresh === undefined ? 'login' : 'refresh';
    if (kind === 'login' && this.#passwordSuccesses >= 3) {
      this.#pause('refresh-recovery-exhausted');
      this.#arm(now);
      return;
    }
    let settle!: () => void;
    const done = new Promise<void>(resolve => {
      settle = resolve;
    });
    const flight: Flight = {
      generation: this.#generation, kind, start: now, controller: new AbortController(), done, settle,
    };
    this.#flight = flight;
    this.#notBefore = Math.max(this.#notBefore, now.monotonicMs + MIN_GRANT_MS);
    this.#arm(now);
    // The flight and spacing gate are installed before invoking the injected client.
    if (this.#flight === flight) {
      void this.#run(flight, kind === 'login' && this.#credentials ? { ...this.#credentials } : undefined,
        kind === 'refresh' ? this.#pair?.refresh : undefined);
    }
  }

  #advance(): void {
    if (this.#stopped) {
      return;
    }
    const now = this.#time();
    if (!now) {
      return;
    }
    this.#observe(now);
    if (!this.#started || this.#attention || this.#flight) {
      this.#arm(now);
      return;
    }
    const pair = this.#pair;
    if (pair?.refresh !== undefined && pair.refreshMs !== undefined && pair.age >= pair.refreshMs) {
      this.#recover(now);
      this.#arm(now);
      return;
    }
    if ((!pair?.refresh || pair.age >= pairRenewal(pair)) && now.monotonicMs >= this.#notBefore) {
      this.#dispatch(now);
    } else {
      this.#arm(now);
    }
  }

  #reset(): void {
    this.#generation++;
    this.#cancelTimer();
    this.#cancelFlight();
    this.#credentials = undefined;
    this.#pair = undefined;
    this.#attention = undefined;
    this.#lastFailure = undefined;
    this.#started = false;
    this.#recoveryStep = 0;
    this.#passwordSuccesses = 0;
    // notBefore and the monotonic-clock guard deliberately survive an explicit reset.
  }

  setCredentials(value: AuthCredentials): CredentialUpdateResult {
    if (this.#stopped) {
      return this.#error('stopped');
    }
    let credentials: AuthCredentials;
    try {
      if (!isObject(value) || !isText(value.username) || typeof value.password !== 'string' || value.password.length === 0) {
        return this.#error('invalid-input');
      }
      credentials = { username: value.username, password: value.password };
    } catch {
      return this.#error('invalid-input');
    }
    if (this.#attention) {
      return this.#error('reauthorization-required');
    }
    if (this.#credentials?.username === credentials.username && this.#credentials.password === credentials.password) {
      return { ok: true };
    }
    this.#reset();
    this.#credentials = credentials;
    return { ok: true };
  }

  getAccessToken(options: { readonly signal?: AbortSignal } = {}): Promise<AccessTokenResult> {
    if (!isObject(options) || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
      return Promise.resolve(this.#error('invalid-input'));
    }
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.resolve(this.#error('cancelled'));
    }
    const generation = this.#generation;
    if (!this.#stopped && !this.#attention && this.#credentials) {
      this.#started = true;
      this.#advance();
    }
    const flight = this.#flight;
    if (!flight || this.#generation !== generation) {
      return Promise.resolve(this.#result(generation));
    }
    return new Promise<AccessTokenResult>((resolve) => {
      let finished = false;
      const onAbort = (): void => {
        if (!finished) {
          finished = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(this.#error('cancelled'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void flight.done.then(() => {
        if (!finished) {
          finished = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(this.#result(generation));
        }
      });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  getStatus(): TokenManagerStatus {
    const now = this.#stopped ? undefined : this.#time();
    if (now) {
      this.#observe(now);
    }
    const pair = this.#pair;
    const remaining = pair ? Math.max(0, pair.accessMs - pair.age) : undefined;
    const retryAfterMs = now ? Math.max(0, this.#notBefore - now.monotonicMs) : 0;
    const backoff = this.#started && !this.#flight && (!pair?.refresh || pair.age >= pairRenewal(pair)) && retryAfterMs > 0;
    return {
      access: !pair ? 'unavailable' : remaining === 0 ? 'expired' : pair.age >= renewalPoint(pair.accessMs) ? 'expiring' : 'usable',
      operation: this.#flight?.kind ?? 'idle',
      renewal: this.#stopped ? 'stopped' : this.#attention ? 'attention-required' : backoff ? 'backoff' : 'ready',
      ...(remaining === undefined ? {} : { accessRemainingMs: remaining }),
      ...(retryAfterMs > 0 && (backoff || this.#attention) ? { retryAfterMs } : {}),
      ...(this.#attention ? { reason: this.#attention } : {}),
      ...(this.#lastFailure ? { authFailure: { ...this.#lastFailure } } : {}),
    };
  }

  clear(): void {
    if (!this.#stopped) {
      this.#reset();
    }
  }

  stop(): void {
    if (!this.#stopped) {
      this.#stopped = true;
      this.#reset();
    }
  }
}

/** One instance per account. No account registry, persistence, logging or import-time I/O. */
export function createTokenManager(options: TokenManagerOptions): TokenManager {
  if (!options || typeof options.authClient?.login !== 'function' || typeof options.authClient?.refresh !== 'function'
    || (options.clock !== undefined && typeof options.clock.now !== 'function')
    || (options.scheduler !== undefined && typeof options.scheduler.schedule !== 'function')) {
    throw new TypeError('Invalid token manager options');
  }
  return new AccountTokenManager(options);
}
