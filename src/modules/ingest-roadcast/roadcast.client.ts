import { roadcastResponseSchema } from './roadcast.contract';

export interface RoadcastClientOptions {
  url: string;
  apiKey: string;
  timeoutMs: number;
}

/** Pulls the latest position of the given devices (Roadcast in production; a fake in tests). */
export interface PositionSource {
  /** Raw rows, validated one by one by the caller. */
  pullPositions(imeis: string[]): Promise<unknown[]>;
}

export class RoadcastError extends Error {
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

/**
 * Roadcast pull-positions API, filtered to a list of IMEIs (at most `maxDeviceCap`, 1000, per
 * call). Called once per org per tick with that org's IMEIs.
 */
export class RoadcastClient implements PositionSource {
  constructor(private readonly options: RoadcastClientOptions) {}

  async pullPositions(imeis: string[]): Promise<unknown[]> {
    if (imeis.length === 0) return [];
    const response = await fetch(this.options.url, {
      method: 'POST',
      signal: AbortSignal.timeout(this.options.timeoutMs),
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': this.options.apiKey },
      body: JSON.stringify({ input: { deviceImeis: imeis } }),
    });
    if (!response.ok) {
      throw new RoadcastError(
        `Roadcast ${response.status}: ${(await response.text()).slice(0, 300)}`,
        response.status,
      );
    }
    const parsed = roadcastResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new RoadcastError(`Roadcast response has an unexpected shape: ${parsed.error}`, null);
    }
    return parsed.data.data.PositionsPull?.rows ?? [];
  }
}
