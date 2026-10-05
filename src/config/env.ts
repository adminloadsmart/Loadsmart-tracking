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
  // The main loadsmart backend's Redis: source of the `loadsmart.events` snapshot stream (sync
  // module) and, from Phase 2, its access-token blocklist. Defaults to our own Redis so the
  // service runs standalone in dev/tests.
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
