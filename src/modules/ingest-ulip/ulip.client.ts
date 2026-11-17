import { extractTransactions, loginResponseSchema } from './ulip.contract';

export interface UlipClientOptions {
  /** Base URL including the version, e.g. https://www.ulip.dpiit.gov.in/ulip/v1.0.0 */
  url: string;
  username: string;
  password: string;
  timeoutMs: number;
  /** How long a login is trusted. The token carries no expiry, so this is our own limit. */
  tokenTtlMs: number;
}

export class UlipError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/** What the FASTag poll needs from ULIP (a fake in tests). */
export interface FastagProvider {
  /** Raw toll transactions ULIP holds for the plate (about the last 72 h), validated one by one by the caller. */
  fetchCrossings(vehicleNumber: string): Promise<unknown[]>;
}

/**
 * ULIP (dpiit.gov.in) FASTag API. Logs in with the account's username and password to get a
 * bearer token, keeps it in memory for `tokenTtlMs` and logs in again on a 401. Concurrent
 * callers share one login.
 */
export class UlipClient implements FastagProvider {
  private token: { value: string; expiresAtMs: number } | null = null;
  private login: Promise<string> | null = null;
  private readonly baseUrl: string;

  constructor(private readonly options: UlipClientOptions) {
    this.baseUrl = options.url.replace(/\/+$/, '');
  }

  async fetchCrossings(vehicleNumber: string): Promise<unknown[]> {
    const body = await this.post('/FASTAG/01', { vehiclenumber: vehicleNumber });
    const extracted = extractTransactions(body);
    if (!extracted.ok) {
      throw new UlipError(
        `ULIP FASTag ${vehicleNumber}: ${extracted.reason}${extracted.respCode ? ` (respCode ${extracted.respCode})` : ''}`,
        null,
      );
    }
    return extracted.txns;
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(this.baseUrl + path, {
        method: 'POST',
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (response.status === 401 && attempt === 0) {
        this.token = null; // expired or revoked: log in again, once
        continue;
      }
      if (!response.ok) {
        throw new UlipError(
          `ULIP ${response.status}: ${(await response.text()).slice(0, 300)}`,
          response.status,
        );
      }
      return response.json();
    }
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAtMs > Date.now()) return this.token.value;
    this.login ??= this.doLogin().finally(() => (this.login = null));
    return this.login;
  }

  private async doLogin(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/user/login`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.options.timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: this.options.username, password: this.options.password }),
    });
    if (!response.ok) {
      throw new UlipError(
        `ULIP login ${response.status}: ${(await response.text()).slice(0, 300)}`,
        response.status,
      );
    }
    const parsed = loginResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new UlipError('ULIP login response has no token', null);
    const value = parsed.data.response.id;
    this.token = { value, expiresAtMs: Date.now() + this.options.tokenTtlMs };
    return value;
  }
}
