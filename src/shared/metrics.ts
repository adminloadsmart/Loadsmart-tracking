import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';

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
