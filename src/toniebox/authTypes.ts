/** Credentials and successful results are private runtime data; never log them wholesale. */
export interface AuthCredentials {
  readonly username: string;
  readonly password: string;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresInSeconds: number;
  /** Absent means unknown. No default lifetime is inferred. */
  readonly refreshExpiresInSeconds?: number;
}

export type OAuthErrorCode =
  | 'invalid_request' | 'invalid_client' | 'invalid_grant'
  | 'unauthorized_client' | 'unsupported_grant_type' | 'invalid_scope';

export type AuthFailureKind =
  | 'invalid-input' | 'cancelled' | 'timeout' | 'transport' | 'http' | 'invalid-response';

/** Only fixed categories, numeric status and allowlisted OAuth codes may leave the boundary. */
export interface AuthFailure {
  readonly kind: AuthFailureKind;
  readonly status?: number;
  readonly oauthError?: OAuthErrorCode;
}

export type AuthResult =
  | { readonly ok: true; readonly tokens: AuthTokens }
  | { readonly ok: false; readonly error: AuthFailure };

export interface AuthRequestOptions {
  readonly signal?: AbortSignal;
}

/** Fetch-compatible transport. The production default is Node's built-in fetch. */
export type AuthTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface AuthClientOptions {
  readonly fetch?: AuthTransport;
  /** Positive integer milliseconds, at most 2^31 - 1. Default: 15 seconds. */
  readonly timeoutMs?: number;
}

export interface AuthClient {
  login(credentials: AuthCredentials, options?: AuthRequestOptions): Promise<AuthResult>;
  refresh(refreshToken: string, options?: AuthRequestOptions): Promise<AuthResult>;
}
