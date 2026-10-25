import type {
  AuthClient, AuthClientOptions, AuthFailure, AuthRequestOptions, AuthResult, AuthTokens, OAuthErrorCode,
} from './authTypes.js';

const TOKEN_ENDPOINT = 'https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token';
const MAX_BODY_BYTES = 64 * 1024;
const OAUTH_ERRORS: readonly OAuthErrorCode[] = [
  'invalid_request', 'invalid_client', 'invalid_grant',
  'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && /\S/u.test(value);
const isLifetime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const failure = (kind: AuthFailure['kind'], status?: number): AuthResult =>
  ({ ok: false, error: { kind, ...(status === undefined ? {} : { status }) } });

/**
 * The PoC verifies grants and rotation, not a complete response schema.
 * Bearer type, positive integral lifetimes and a complete pair are fail-closed client policy.
 * Tokens stay opaque and unchanged; unknown metadata (including ID tokens) is discarded.
 */
function tokensFrom(raw: unknown): AuthTokens | undefined {
  if (!isObject(raw) || !isText(raw.access_token) || !isText(raw.refresh_token)
    || typeof raw.token_type !== 'string' || raw.token_type.toLowerCase() !== 'bearer'
    || !isLifetime(raw.expires_in)) {
    return undefined;
  }
  if (Object.hasOwn(raw, 'refresh_expires_in') && !isLifetime(raw.refresh_expires_in)) {
    return undefined;
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    tokenType: 'Bearer',
    expiresInSeconds: raw.expires_in,
    ...(Object.hasOwn(raw, 'refresh_expires_in') ? { refreshExpiresInSeconds: raw.refresh_expires_in as number } : {}),
  };
}

function httpFailure(status: number, raw: unknown): AuthResult {
  const code = isObject(raw) ? OAUTH_ERRORS.find(value => value === raw.error) : undefined;
  return { ok: false, error: { kind: 'http', status, ...(code === undefined ? {} : { oauthError: code }) } };
}

/** Cancellation is best-effort cleanup, never a reason to delay a settled result. */
function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A locked or already unusable body must not expose its exception.
  }
}

async function readBody(
  response: Response,
  trackReader: (reader: ReadableStreamDefaultReader<Uint8Array> | undefined) => void,
): Promise<unknown> {
  if (!response.body) {
    return undefined;
  }
  const reader = response.body.getReader();
  trackReader(reader);
  let complete = false;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        return undefined;
      }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    // JSON, decoder and stream errors can contain secrets.
    return undefined;
  } finally {
    trackReader(undefined);
    if (!complete) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

/**
 * No token ownership, retry, scheduling or I/O until an operation is called.
 * A failed refresh may already have rotated server-side; recovery belongs to the coordinator.
 */
export function createAuthClient(options: AuthClientOptions = {}): AuthClient {
  const configured = typeof options === 'object' && options !== null && !Array.isArray(options);
  const transport = configured && options.fetch !== undefined ? options.fetch : (url: string, init: RequestInit) => globalThis.fetch(url, init);
  const timeoutMs = configured && options.timeoutMs !== undefined ? options.timeoutMs : 15000;
  const validOptions = configured && typeof transport === 'function'
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647;

  function request(fields: Record<string, string>, requestOptions: AuthRequestOptions): Promise<AuthResult> {
    if (!validOptions || !isObject(requestOptions)
      || (requestOptions.signal !== undefined && !(requestOptions.signal instanceof AbortSignal))) {
      return Promise.resolve(failure('invalid-input'));
    }
    const signal = requestOptions.signal as AbortSignal | undefined;
    if (signal?.aborted) {
      return Promise.resolve(failure('cancelled'));
    }

    return new Promise<AuthResult>((resolve) => {
      const controller = new AbortController();
      let finished = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      function finish(result: AuthResult): void {
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
      onAbort = () => {
        // Caller-provided reasons never enter a result or the transport signal.
        finish(failure('cancelled'));
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(failure('timeout')), timeoutMs);
      // Covers cancellation during setup as well as before the initial check.
      if (signal?.aborted) {
        finish(failure('cancelled'));
      }

      async function run(): Promise<void> {
        if (finished) {
          return;
        }
        let response: Response;
        try {
          response = await transport(TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: new URLSearchParams({ client_id: 'meine-tonies', ...fields }).toString(),
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
          });
        } catch {
          finish(failure('transport'));
          return;
        }
        if (finished) {
          discardBody(response);
          return;
        }
        const status = response.status;
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          discardBody(response);
          finish(failure('invalid-response'));
          return;
        }
        // Never forward the credential-bearing POST to a redirect destination.
        if (status >= 300 && status < 400) {
          discardBody(response);
          finish(httpFailure(status, undefined));
          return;
        }
        let raw: unknown;
        try {
          raw = await readBody(response, current => {
            reader = current;
          });
        } catch {
          // Includes an unusable/locked body. Preserve HTTP failures independently.
          raw = undefined;
        }
        if (finished) {
          return;
        }
        if (status >= 300) {
          finish(httpFailure(status, raw));
          return;
        }
        const tokens = tokensFrom(raw);
        finish(tokens ? { ok: true, tokens } : failure('invalid-response', status));
      }

      // Also absorbs late rejection from a transport that ignored abort.
      void run().catch(() => finish(failure('transport')));
    });
  }

  return {
    login(credentials, requestOptions = {}) {
      if (!isObject(credentials) || !isText(credentials.username)
        || typeof credentials.password !== 'string' || credentials.password.length === 0) {
        return Promise.resolve(failure('invalid-input'));
      }
      return request({
        grant_type: 'password', username: credentials.username, password: credentials.password, scope: 'openid',
      }, requestOptions);
    },
    refresh(refreshToken, requestOptions = {}) {
      if (!isText(refreshToken)) {
        return Promise.resolve(failure('invalid-input'));
      }
      return request({ grant_type: 'refresh_token', refresh_token: refreshToken }, requestOptions);
    },
  };
}
