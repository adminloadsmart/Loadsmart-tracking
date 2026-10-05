interface Queryable {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export interface DbFeatures {
  /** TimescaleDB installed: hypertables, compression, 1-min continuous aggregates, retention. */
  timescale: boolean;
  /** PostGIS installed (optional — the service computes geometry in-process). */
  postgis: boolean;
}

/**
 * Optional database extensions. The service runs on plain PostgreSQL (e.g. sharing the main
 * loadsmart database during development) and uses TimescaleDB / PostGIS when they are present.
 * TRACKING_DB_EXTENSIONS=none forces the plain path even where they're available (tests, or a
 * deliberate choice).
 */
export function extensionsAllowed(): boolean {
  return (process.env.TRACKING_DB_EXTENSIONS ?? 'auto') !== 'none';
}

/** Extensions that can be created on this server (installed on disk), honouring the override. */
export async function availableExtensions(db: Queryable): Promise<Set<string>> {
  if (!extensionsAllowed()) return new Set();
  const rows = await db.query(
    `SELECT name FROM pg_available_extensions WHERE name IN ('timescaledb', 'postgis')`,
  );
  return new Set(rows.map((row) => String(row.name)));
}

/** Extensions actually created in this database. */
export async function detectFeatures(db: Queryable): Promise<DbFeatures> {
  const rows = await db.query(
    `SELECT extname FROM pg_extension WHERE extname IN ('timescaledb', 'postgis')`,
  );
  const names = new Set(rows.map((row) => String(row.extname)));
  return { timescale: names.has('timescaledb'), postgis: names.has('postgis') };
}
