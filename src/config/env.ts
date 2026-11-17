// src/config/env.ts
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function numberWithDefault(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = Number(val);
  if (Number.isNaN(parsed)) throw new Error(`Env var ${key} must be a number, got "${val}"`);
  return parsed;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  nodeEnv,
  // Which process roles this instance runs — 'all' or a comma list (see config/roles.ts).
  role: process.env.ROLE ?? 'all',
  // REST API (api role).
  port: numberWithDefault('PORT', 4100),
  // socket.io server (realtime role) — phone GPS ingest on /driver, map viewers on /live.
  realtimePort: numberWithDefault('REALTIME_PORT', 4101),
  // /healthz, /readyz, /metrics — served by every process regardless of role, so container
  // probes and Prometheus scraping work the same way for each deployment.
  opsPort: numberWithDefault('OPS_PORT', 9100),
  corsOrigins,
  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
  // The main loadsmart backend's Redis: its access-token blocklist, checked on every driver and
  // viewer handshake. Defaults to our own Redis so the service runs standalone in dev/tests.
  mainRedisUrl: process.env.MAIN_REDIS_URL || process.env.REDIS_URL || 'redis://localhost:6380',
  // Point stream partitions (docs/ROADMAP.md §7). Fixed for the life of the stream — changing it
  // needs a drain-and-rehash, so it's sized generously up front.
  pointPartitions: numberWithDefault('POINT_PARTITIONS', 16),
  // Approximate per-partition stream cap (XADD MAXLEN ~) — ~48h of replay at 2k vehicles.
  pointStreamMaxLen: numberWithDefault('POINT_STREAM_MAXLEN', 1_500_000),
  // Phone GPS (docs/contracts/driver-socket.md): fixes worse than this are rejected, and a socket
  // may send at most one `loc` per PHONE_MIN_INTERVAL_MS (the app's cadence is 15s).
  phoneMaxAccuracyM: numberWithDefault('PHONE_MAX_ACCURACY_M', 50),
  phoneMinIntervalMs: numberWithDefault('PHONE_MIN_INTERVAL_MS', 4000),
  // Deliveries before a failing stream entry is moved to its dead-letter stream.
  streamMaxDeliveries: numberWithDefault('STREAM_MAX_DELIVERIES', 5),
  logLevel: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
  // Hard upper bound on graceful shutdown — a stuck close() must never hang a deploy.
  shutdownTimeoutMs: numberWithDefault('SHUTDOWN_TIMEOUT_MS', 10_000),
  // Scheduler single-leader lock (shared/lifecycle/leader-lock.ts).
  leaderLockTtlMs: numberWithDefault('LEADER_LOCK_TTL_MS', 15_000),
  // OpenTelemetry tracing is only started when an OTLP endpoint is configured.
  otelExporterEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'loadsmart-tracking',
  // Google Routes + Geocoding (planned routes for DELAY/DEV rules). Optional: without it trips get
  // no planned route and the route-based rules stay inactive.
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || undefined,
  // Roadcast GPS devices (poller role). One account for all of Loadsmart; every vehicle with a
  // gps_device_imei in main is pulled. Optional: without a key the Roadcast poller stays off.
  roadcastApiUrl: process.env.ROADCAST_API_URL || undefined,
  roadcastApiKey: process.env.ROADCAST_API_KEY || undefined,
  // One call per org per ROADCAST_POLL_INTERVAL_MS (fixed 10 s for every org) with the IMEIs of
  // its trucks on a trip…
  roadcastPollIntervalMs: numberWithDefault('ROADCAST_POLL_INTERVAL_MS', 10_000),
  // …and once per ROADCAST_IDLE_INTERVAL_MS with all its IMEIs: idle trucks get a point this often.
  roadcastIdleIntervalMs: numberWithDefault('ROADCAST_IDLE_INTERVAL_MS', 300_000),
  // Below the poll interval, so a hung call never overlaps the next one.
  roadcastTimeoutMs: numberWithDefault('ROADCAST_TIMEOUT_MS', 8_000),
  // Unit of the API's `speed` field: 'kmh' or 'knots' (unconfirmed by Roadcast).
  roadcastSpeedUnit: (process.env.ROADCAST_SPEED_UNIT === 'knots' ? 'knots' : 'kmh') as
    'kmh' | 'knots',
  // Intugine SIM tracking (poller role). One account for all of Loadsmart. Optional: without
  // credentials SIM tracking stays off.
  intugineApiUrl: process.env.INTUGINE_API_URL || undefined,
  intugineUsername: process.env.INTUGINE_USERNAME || undefined,
  intuginePassword: process.env.INTUGINE_PASSWORD || undefined,
  // Status and end calls…
  intugineTimeoutMs: numberWithDefault('INTUGINE_TIMEOUT_MS', 15_000),
  // …consent and start-trip wait on the telecom operators (~2 min).
  intugineSlowTimeoutMs: numberWithDefault('INTUGINE_SLOW_TIMEOUT_MS', 120_000),
  // How often a trip on SIM is polled. Intugine only has a new location once per its own ping
  // rate, so keep this in step with the rate set on their side.
  intuginePollIntervalMin: numberWithDefault('INTUGINE_POLL_INTERVAL_MIN', 20),
  // Newest locations asked for per poll. Whether Intugine caps this, or returns history, is not known yet.
  intugineStatusLimit: numberWithDefault('INTUGINE_STATUS_LIMIT', 50),
  // How often a pending consent is re-checked. The consent call may re-send the driver's SMS, so
  // keep this slow.
  intugineConsentCheckMin: numberWithDefault('INTUGINE_CONSENT_CHECK_MIN', 60),
  // Consent is asked once the load's source is `sim`, and a driver can take hours to approve: wait this long.
  intugineConsentTtlMin: numberWithDefault('INTUGINE_CONSENT_TTL_MIN', 720),
  // ULIP FASTag toll crossings (poller role). One account for all of Loadsmart. Optional: without
  // credentials FASTag collection stays off.
  ulipApiUrl: process.env.ULIP_API_URL || undefined,
  ulipUsername: process.env.ULIP_USERNAME || undefined,
  ulipPassword: process.env.ULIP_PASSWORD || undefined,
  ulipTimeoutMs: numberWithDefault('ULIP_TIMEOUT_MS', 20_000),
  // The login token carries no expiry, so it is trusted for this long (ROADMAP: refresh every 30 min).
  ulipTokenTtlMin: numberWithDefault('ULIP_TOKEN_TTL_MIN', 30),
  // How often a load in transit is polled. ULIP keeps ~72 h per vehicle, so this is about freshness, not safety.
  ulipPollIntervalMin: numberWithDefault('ULIP_POLL_INTERVAL_MIN', 15),
  // A delivered load gets one last poll this long after delivery, for tolls ULIP posts late.
  ulipFinalPollDelayMin: numberWithDefault('ULIP_FINAL_POLL_DELAY_MIN', 30),
  // Shared with the main loadsmart backend so this service can verify its access/driver tokens.
  // Optional until Phase 2 (driver socket auth) — nothing verifies tokens yet.
  jwtSecret: process.env.JWT_SECRET || undefined,
  // Raw-payload archive (S3/MinIO). Optional until Phase 1 (archiver).
  s3Endpoint: process.env.S3_ENDPOINT || undefined,
  s3Bucket: process.env.S3_BUCKET || undefined,
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || undefined,
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || undefined,
  awsRegion: process.env.AWS_REGION || undefined,
};
