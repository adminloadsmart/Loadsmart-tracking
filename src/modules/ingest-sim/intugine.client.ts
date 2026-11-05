import {
  consentResponseSchema,
  endTripResponseSchema,
  loginResponseSchema,
  startTripResponseSchema,
  toSimConsent,
  type SimConsent,
} from './intugine.contract';

export interface IntugineClientOptions {
  /** Base URL including the stage, e.g. https://sct.intutrack.com/api/prod */
  url: string;
  username: string;
  password: string;
  /** Status and end calls. */
  timeoutMs: number;
  /** Consent and start-trip depend on the telecom operators and can take ~2 min. */
  slowTimeoutMs: number;
}

export interface StartTripInput {
  /** 10-digit number, no country code. */
  tel: string;
  src: [number, number];
  srcName: string;
  dest: [number, number];
  destName: string;
  destAddress?: string;
  truckNumber: string;
  /** Our load code. */
  invoice: string;
  /** Our load id, sent as custom_load_id so a trip can be found again if the response is lost. */
  loadId: string;
  etaTimeMs?: number;
}

export interface StartTripResult {
  intugineTripId: string;
  consent: SimConsent | null;
}

export class IntugineError extends Error {
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

/** What the SIM poll and lifecycle jobs need from Intugine (a fake in tests). */
export interface SimProvider {
  checkConsent(tel: string): Promise<SimConsent>;
  startTrip(input: StartTripInput): Promise<StartTripResult>;
  /** False when Intugine had no such trip or it had already ended. */
  endTrip(intugineTripId: string): Promise<boolean>;
  setTracking(intugineTripId: string, state: 'START' | 'STOP'): Promise<void>;
  /** The Intugine trip started with this invoice, or null. Used to find a trip whose start response was lost. */
  findTripByInvoice(invoice: string): Promise<string | null>;
  /** Newest first. Raw rows, validated one by one by the caller. */
  fetchLocations(intugineTripId: string, limit: number): Promise<unknown[]>;
}

type Timeout = 'fast' | 'slow';

/**
 * Intugine SCT API. Authenticates with the API credentials (Basic) once to get a bearer token,
 * which is kept in memory until shortly before it expires and renewed on a 401. The token lives
 * about 24 h, so each process logs in about once a day.
 */
export class IntugineClient implements SimProvider {
  private token: { value: string; expiresAtMs: number } | null = null;
  private login: Promise<string> | null = null;

  constructor(private readonly options: IntugineClientOptions) {}

  async checkConsent(tel: string): Promise<SimConsent> {
    const body = await this.request('GET', `/consents?tel=${encodeURIComponent(tel)}`, 'slow');
    const parsed = consentResponseSchema.safeParse(body);
    if (!parsed.success || parsed.data.length === 0) {
      throw new IntugineError('Intugine consent response has an unexpected shape', null);
    }
    return toSimConsent(parsed.data[0].result);
  }

  async startTrip(input: StartTripInput): Promise<StartTripResult> {
    const body = await this.request('POST', '/trips/start', 'slow', {
      tel: input.tel,
      sim_no: input.tel,
      src: input.src.map(String),
      srcname: input.srcName,
      dest: input.dest.map(String),
      destname: input.destName,
      destaddress: input.destAddress ?? input.destName,
      truck_number: input.truckNumber,
      invoice: input.invoice,
      custom_load_id: input.loadId,
      ...(input.etaTimeMs ? { eta_time: input.etaTimeMs } : {}),
    });
    const parsed = startTripResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new IntugineError(
        `Intugine start-trip response has an unexpected shape: ${parsed.error}`,
        null,
      );
    }
    const first = consentResponseSchema.safeParse(
      (parsed.data.consentResults ?? []).map((entry) => ({ result: entry })),
    );
    return {
      intugineTripId: parsed.data.tripId,
      consent: first.success && first.data.length > 0 ? toSimConsent(first.data[0].result) : null,
    };
  }

  async endTrip(intugineTripId: string): Promise<boolean> {
    const body = await this.request(
      'POST',
      `/trips/end/${encodeURIComponent(intugineTripId)}`,
      'fast',
    );
    const parsed = endTripResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new IntugineError('Intugine end-trip response has an unexpected shape', null);
    }
    return parsed.data.msg === 'Trip Completed';
  }

  async setTracking(intugineTripId: string, state: 'START' | 'STOP'): Promise<void> {
    await this.request('PUT', '/trips/', 'fast', { _id: intugineTripId, tracking_state: state });
  }

  async findTripByInvoice(invoice: string): Promise<string | null> {
    const query = `custom_parameter=invoice&invoice=${encodeURIComponent(invoice)}`;
    const body = await this.request('GET', `/trips/tripinfo?${query}`, 'fast');
    // The response shape is not documented in the collection: accept a trip or a list of trips.
    const trip = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    const nested = trip?.trip as Record<string, unknown> | undefined;
    const id = trip?.tripId ?? trip?._id ?? nested?._id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  async fetchLocations(intugineTripId: string, limit: number): Promise<unknown[]> {
    const query = `tripId=${encodeURIComponent(intugineTripId)}&limit=${limit}`;
    const body = await this.request('GET', `/status?${query}`, 'fast');
    if (!Array.isArray(body)) {
      throw new IntugineError('Intugine status response is not a list', null);
    }
    return body;
  }

  private async request(
    method: string,
    path: string,
    timeout: Timeout,
    payload?: unknown,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(this.options.url + path, {
        method,
        signal: AbortSignal.timeout(
          timeout === 'slow' ? this.options.slowTimeoutMs : this.options.timeoutMs,
        ),
        headers: {
          Authorization: `Bearer ${await this.bearer()}`,
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      if (response.status === 401 && attempt === 0) {
        this.token = null; // expired or revoked: log in again, once
        continue;
      }
      if (!response.ok) {
        throw new IntugineError(
          `Intugine ${response.status}: ${(await response.text()).slice(0, 300)}`,
          response.status,
        );
      }
      return response.json();
    }
  }

  private async bearer(): Promise<string> {
    if (this.token && this.token.expiresAtMs > Date.now() + 60_000) return this.token.value;
    // Concurrent callers share one login.
    this.login ??= this.doLogin().finally(() => (this.login = null));
    return this.login;
  }

  private async doLogin(): Promise<string> {
    const basic = Buffer.from(`${this.options.username}:${this.options.password}`).toString(
      'base64',
    );
    const response = await fetch(`${this.options.url}/login`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.options.timeoutMs),
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!response.ok) {
      throw new IntugineError(
        `Intugine login ${response.status}: ${(await response.text()).slice(0, 300)}`,
        response.status,
      );
    }
    const parsed = loginResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new IntugineError('Intugine login response has no token', null);
    const value = parsed.data.token;
    this.token = { value, expiresAtMs: jwtExpiryMs(value) ?? Date.now() + 60 * 60_000 };
    return value;
  }
}

/** `exp` of a JWT in epoch ms, or null if it can't be read. */
export function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
