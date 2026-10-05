/**
 * A readiness check: resolve (optionally with details to surface in /readyz) when healthy,
 * throw when not. Checks run concurrently, each bounded by a timeout so one hung dependency
 * can't hang the probe itself.
 */
export type HealthCheck = () => Promise<Record<string, unknown> | void>;

export interface CheckResult {
  status: 'ok' | 'fail';
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'fail';
  checks: Record<string, CheckResult>;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  constructor(private readonly checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS) {}

  register(name: string, check: HealthCheck): void {
    if (this.checks.has(name)) throw new Error(`Health check "${name}" is already registered`);
    this.checks.set(name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.checks.entries()].map(async ([name, check]): Promise<[string, CheckResult]> => {
        const startedAt = Date.now();
        try {
          const details = await withTimeout(Promise.resolve().then(check), this.checkTimeoutMs);
          return [
            name,
            { status: 'ok', durationMs: Date.now() - startedAt, ...(details ? { details } : {}) },
          ];
        } catch (err) {
          return [
            name,
            {
              status: 'fail',
              durationMs: Date.now() - startedAt,
              error: err instanceof Error ? err.message : String(err),
            },
          ];
        }
      }),
    );

    const checks = Object.fromEntries(entries);
    const status = entries.every(([, result]) => result.status === 'ok') ? 'ok' : 'fail';
    return { status, checks };
  }
}
