import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

// Single registry for the whole process, exposed on the ops server's /metrics. Later phases
// register their own counters/histograms here (points ingested, stream lag, poll due-lag, ...).
export const metricsRegistry = new Registry();
metricsRegistry.setDefaultLabels({ service: 'loadsmart-tracking' });
collectDefaultMetrics({ register: metricsRegistry });

export const roleUp = new Gauge({
  name: 'tracking_role_up',
  help: '1 while the given process role is running',
  labelNames: ['role'] as const,
  registers: [metricsRegistry],
});

// Redis Streams consumer groups (streams/stream-consumer.ts), sampled by each consumer for the
// streams it reads.
export const streamLag = new Gauge({
  name: 'tracking_stream_lag',
  help: 'Entries in the stream not yet delivered to the consumer group (backlog)',
  labelNames: ['stream', 'group'] as const,
  registers: [metricsRegistry],
});

export const streamPending = new Gauge({
  name: 'tracking_stream_pending',
  help: 'Entries delivered to the consumer group but not yet acked',
  labelNames: ['stream', 'group'] as const,
  registers: [metricsRegistry],
});

export const streamLength = new Gauge({
  name: 'tracking_stream_length',
  help: 'Entries held in the stream (capped near its MAXLEN)',
  labelNames: ['stream'] as const,
  registers: [metricsRegistry],
});

export const streamTrimmed = new Counter({
  name: 'tracking_stream_trimmed_total',
  help: 'Pending entries trimmed by MAXLEN before they were processed (lost)',
  labelNames: ['stream', 'group'] as const,
  registers: [metricsRegistry],
});

export const streamDeadLettered = new Counter({
  name: 'tracking_stream_dead_lettered_total',
  help: 'Entries moved to the dead-letter stream',
  labelNames: ['stream', 'group'] as const,
  registers: [metricsRegistry],
});
