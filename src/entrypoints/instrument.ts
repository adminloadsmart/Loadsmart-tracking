// Imported FIRST by main.ts: OpenTelemetry auto-instrumentation patches modules (http, express,
// pg, ioredis, ...) at require time, so it must be started before anything else loads them.
import { startTelemetry } from '../shared/telemetry';

startTelemetry();
