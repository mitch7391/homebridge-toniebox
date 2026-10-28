import type {
  AccountIdentity, DiscoveredToniebox, DiscoveryClient, DiscoveryClientOptions, DiscoveryDiagnostics,
  DiscoveryFailure, DiscoveryRequestOptions, DiscoveryResult, HouseholdIdentity,
} from './discoveryTypes.js';

const API_BASE = 'https://api.prod.tcs.toys/v2';
const MAX_BODY_BYTES = 1024 * 1024;
type JsonObject = Record<string, unknown>;
type Parsed<T> = { value: T; degraded: boolean };
type Payload<T> = {
  value: T; rejectedEntries: number; degradedEntries: number; duplicateEntries: number; ambiguousRoutingEntries: number;
};
type BodyResult = { ok: true; value: unknown } | { ok: false; kind: 'transport' | 'invalid-response' };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasControl = (value: string): boolean => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const isText = (value: unknown): value is string => typeof value === 'string' && /\S/u.test(value) && !hasControl(value);
const failure = (kind: DiscoveryFailure['kind'], status?: number): DiscoveryResult<never> =>
  ({ ok: false, error: { kind, ...(status === undefined ? {} : { status }) } });

function optionalText(raw: JsonObject, key: string, output: JsonObject): boolean {
  if (!Object.hasOwn(raw, key)) {
    return false;
  }
  if (!isText(raw[key])) {
    return true;
  }
  output[key] = raw[key];
  return false;
}

function account(raw: unknown): Payload<AccountIdentity> | undefined {
  if (!isObject(raw)) {
    return undefined;
  }
  // Matches the observed fallback, not a claim that uuid and id are equivalent.
  const identitySource = isText(raw.uuid) ? 'uuid' : isText(raw.id) ? 'id' : undefined;
  if (!identitySource) {
    return undefined;
  }
  const degraded = ['uuid', 'id'].some(key => Object.hasOwn(raw, key) && !isText(raw[key]));
  return {
    value: { id: raw[identitySource] as string, identitySource },
    rejectedEntries: 0, degradedEntries: Number(degraded), duplicateEntries: 0, ambiguousRoutingEntries: 0,
  };
}

function household(raw: JsonObject): Parsed<HouseholdIdentity> | undefined {
  if (!isText(raw.id)) {
    return undefined;
  }
  const value: JsonObject = { id: raw.id };
  const degraded = optionalText(raw, 'name', value);
  // access was observed, but its type and semantics were not characterised.
  return { value: value as unknown as HouseholdIdentity, degraded };
}

function box(raw: JsonObject, householdId: string): Parsed<DiscoveredToniebox> | undefined {
  if (!isText(raw.id) || (isText(raw.householdId) && raw.householdId !== householdId)) {
    return undefined;
  }
  const value: JsonObject = { id: raw.id };
  let degraded = false;
  for (const key of ['name', 'product', 'generation', 'householdId', 'itemId']) {
    degraded = optionalText(raw, key, value) || degraded;
  }
  if (Object.hasOwn(raw, 'macAddress')) {
    if (isText(raw.macAddress) && /^[^\s/+#]+$/u.test(raw.macAddress)) {
      value.macAddress = raw.macAddress.toUpperCase();
    } else {
      degraded = true;
    }
  }
  if (Object.hasOwn(raw, 'features')) {
    if (Array.isArray(raw.features) && raw.features.every(isText)) {
      value.features = [...raw.features];
    } else {
      // Do not turn missing/invalid evidence into an empty capability set.
      degraded = true;
    }
  }
  return { value: value as unknown as DiscoveredToniebox, degraded };
}

function collection<T extends { readonly id: string }>(
  raw: unknown, parse: (entry: JsonObject) => Parsed<T> | undefined,
): Payload<readonly T[]> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const accepted: Parsed<T>[] = [];
  const counts = new Map<string, number>();
  let rejectedEntries = 0;
  for (const entry of raw) {
    const parsed = isObject(entry) ? parse(entry) : undefined;
    if (!parsed) {
      rejectedEntries++;
      continue;
    }
    accepted.push(parsed);
    counts.set(parsed.value.id, (counts.get(parsed.value.id) ?? 0) + 1);
  }
  const value: T[] = [];
  let duplicateEntries = 0;
  let degradedEntries = 0;
  for (const parsed of accepted) {
    if (counts.get(parsed.value.id)! > 1) {
      duplicateEntries++;
    } else {
      value.push(parsed.value);
      degradedEntries += Number(parsed.degraded);
    }
  }
  return { value, rejectedEntries: rejectedEntries + duplicateEntries, degradedEntries, duplicateEntries, ambiguousRoutingEntries: 0 };
}

function tonieboxes(raw: unknown, householdId: string): Payload<readonly DiscoveredToniebox[]> | undefined {
  const idsByMac = new Map<string, Set<string>>();
  const parsed = collection(raw, (entry) => {
    const result = box(entry, householdId);
    const mac = result?.value.macAddress;
    if (result && mac !== undefined) {
      const ids = idsByMac.get(mac) ?? new Set<string>();
      ids.add(result.value.id);
      idsByMac.set(mac, ids);
    }
    return result;
  });
  if (!parsed) {
    return undefined;
  }
  let ambiguousRoutingEntries = 0;
  const value = parsed.value.map((device) => {
    if (device.macAddress !== undefined && idsByMac.get(device.macAddress)!.size > 1) {
      ambiguousRoutingEntries++;
      return { ...device, routingAmbiguous: true as const };
    }
    return device;
  });
  return { ...parsed, value, ambiguousRoutingEntries };
}

/** Split Link fields/parameters without treating quoted or URI punctuation as separators. */
function splitHeader(value: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let angle = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) {
      escaped = false;
    } else if (quoted && char === '\\') {
      escaped = true;
    } else if (char === '"' && !angle) {
      quoted = !quoted;
    } else if (!quoted && char === '<') {
      angle = true;
    } else if (!quoted && char === '>') {
      angle = false;
    } else if (!quoted && !angle && char === separator) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function continuation(response: Response): boolean {
  if (response.status === 206 || response.headers.has('content-range')) {
    return true;
  }
  const link = response.headers.get('link');
  if (!link) {
    return false;
  }
  // Overlong continuation metadata cannot establish completeness either.
  if (link.length > 16384) {
    return true;
  }
  return splitHeader(link, ',').some((part) => {
    if (!/^\s*<[^>]*>/u.test(part)) {
      return false;
    }
    return splitHeader(part, ';').slice(1).some((parameter) => {
      const match = /^\s*rel\s*=\s*(?:"([^"]*)"|([^\s;]+))\s*$/iu.exec(parameter);
      return match !== null && (match[1] ?? match[2]).split(/\s+/u).some(value => value.toLowerCase() === 'next');
    });
  });
}

function retryAfter(response: Response, now: () => number): number | undefined {
  if (response.status !== 429 && response.status !== 503) {
    return undefined;
  }
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^\d+$/u.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isSafeInteger(ms) && ms >= 0 ? ms : undefined;
  }
  // Accept canonical IMF-fixdate only; do not let Date.parse guess numeric or locale dates.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(raw)) {
    return undefined;
  }
  const date = Date.parse(raw);
  const current = now();
  if (!Number.isFinite(date) || !Number.isFinite(current) || new Date(date).toUTCString() !== raw) {
    return undefined;
  }
  const ms = Math.max(0, Math.ceil(date - current));
  return Number.isSafeInteger(ms) ? ms : undefined;
}

function httpFailure(response: Response, now: () => number): DiscoveryResult<never> {
  const status = response.status;
  const kind = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate-limited' : 'http';
  let retryAfterMs: number | undefined;
  try {
    retryAfterMs = retryAfter(response, now);
  } catch {
    // An unusable clock/header must not hide the HTTP status or expose an exception.
  }
  return { ok: false, error: { kind, status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } };
}

function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best-effort cleanup; never expose response or stream exceptions.
  }
}

async function readBody(
  response: Response, track: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<BodyResult> {
  if (!response.body) {
    return { ok: false, kind: 'invalid-response' };
  }
  const reader = response.body.getReader();
  track(reader);
  let complete = false;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, kind: 'transport' };
      }
      if (chunk.done) {
        complete = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        return { ok: false, kind: 'invalid-response' };
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        return { ok: false, kind: 'invalid-response' };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return { ok: true, value: JSON.parse(text + decoder.decode()) as unknown };
  } catch {
    return { ok: false, kind: 'invalid-response' };
  } finally {
    track(undefined);
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/** Stateless GET boundary. No token ownership, retry, pagination traversal or import-time I/O. */
export function createDiscoveryClient(options: DiscoveryClientOptions = {}): DiscoveryClient {
  const configured = typeof options === 'object' && options !== null && !Array.isArray(options);
  const transport = configured && options.fetch !== undefined ? options.fetch : (url: string, init: RequestInit) => globalThis.fetch(url, init);
  const timeoutMs = configured && options.timeoutMs !== undefined ? options.timeoutMs : 15000;
  const now = configured && options.now !== undefined ? options.now : () => Date.now();
  const validOptions = configured && typeof transport === 'function' && typeof now === 'function'
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647;

  function request<T>(
    accessToken: string, path: string, parse: (raw: unknown) => Payload<T> | undefined, requestOptions: DiscoveryRequestOptions,
  ): Promise<DiscoveryResult<T>> {
    if (!validOptions || typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/u.test(accessToken)
      || !isObject(requestOptions) || (requestOptions.signal !== undefined && !(requestOptions.signal instanceof AbortSignal))) {
      return Promise.resolve(failure('invalid-input'));
    }
    const signal = requestOptions.signal;
    if (signal?.aborted) {
      return Promise.resolve(failure('cancelled'));
    }
    return new Promise((resolve) => {
      const controller = new AbortController();
      let finished = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      function finish(result: DiscoveryResult<T>): void {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        timer = undefined;
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
        if (!result.ok) {
          controller.abort();
          if (reader) {
            void reader.cancel().catch(() => undefined);
          }
        }
        resolve(result);
      }

      async function run(): Promise<void> {
        if (finished) {
          return;
        }
        let response: Response;
        try {
          response = await transport(API_BASE + path, {
            method: 'GET', headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
            redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          });
        } catch {
          finish(failure('transport'));
          return;
        }
        if (finished) {
          discard(response);
          return;
        }
        const status = response.status;
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          discard(response);
          finish(failure('invalid-response'));
          return;
        }
        if (status >= 300) {
          // No error body is needed. HTTP classification does not depend on JSON or OAuth metadata.
          const result = httpFailure(response, now);
          discard(response);
          finish(result);
          return;
        }
        let body: BodyResult;
        try {
          body = await readBody(response, current => {
            reader = current;
          });
        } catch {
          body = { ok: false, kind: 'invalid-response' };
        }
        if (finished) {
          return;
        }
        if (!body.ok) {
          finish(failure(body.kind, status));
          return;
        }
        const parsed = parse(body.value);
        if (!parsed) {
          finish(failure('invalid-response', status));
          return;
        }
        const diagnostics: DiscoveryDiagnostics = {
          rejectedEntries: parsed.rejectedEntries, degradedEntries: parsed.degradedEntries,
          duplicateEntries: parsed.duplicateEntries, ambiguousRoutingEntries: parsed.ambiguousRoutingEntries,
          continuationDetected: continuation(response),
        };
        finish({ ok: true, value: parsed.value, diagnostics });
      }

      onAbort = () => finish(failure('cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(failure('timeout')), timeoutMs);
      if (signal?.aborted) {
        finish(failure('cancelled'));
      }
      void run().catch(() => finish(failure('transport')));
    });
  }

  return {
    getAccount: (accessToken, requestOptions = {}) => request(accessToken, '/me', account, requestOptions),
    getHouseholds: (accessToken, requestOptions = {}) =>
      request(accessToken, '/households', raw => collection(raw, household), requestOptions),
    getTonieboxes(accessToken, householdId, requestOptions = {}) {
      if (!isText(householdId) || householdId === '.' || householdId === '..' || /[/\\]/u.test(householdId)) {
        return Promise.resolve(failure('invalid-input'));
      }
      let encoded: string;
      try {
        encoded = encodeURIComponent(householdId);
      } catch {
        return Promise.resolve(failure('invalid-input'));
      }
      return request(accessToken, '/households/' + encoded + '/tonieboxes',
        raw => tonieboxes(raw, householdId), requestOptions);
    },
  };
}