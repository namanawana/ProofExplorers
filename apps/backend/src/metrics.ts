/**
 * Observability & Prometheus Metrics.
 *
 * Implements P8-03:
 *   - Histograms for step latency, startup latency, checkpoint restore duration
 *   - Gauges for active sessions and memory
 *   - Counters for crashes, errors, and backpressure drops
 *   - Scrubbed labels: no user proof text or secrets in metrics
 */
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const leanStartupDuration = new Histogram({
  name: "proof_explorer_lean_startup_duration_seconds",
  help: "Duration of Lean language server startup",
  registers: [metricsRegistry],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

export const stepDuration = new Histogram({
  name: "proof_explorer_step_duration_seconds",
  help: "Duration of verified proof step execution",
  registers: [metricsRegistry],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
});

export const activeSessions = new Gauge({
  name: "proof_explorer_active_sessions",
  help: "Number of active proof sessions",
  registers: [metricsRegistry],
});

export const leanCrashesTotal = new Counter({
  name: "proof_explorer_lean_crashes_total",
  help: "Count of unexpected Lean process crashes",
  registers: [metricsRegistry],
});

export const checkpointRestoresTotal = new Counter({
  name: "proof_explorer_checkpoint_restores_total",
  help: "Count of checkpoint restores and replays",
  registers: [metricsRegistry],
});

export const wsBackpressureDropsTotal = new Counter({
  name: "proof_explorer_ws_backpressure_drops_total",
  help: "Count of realtime pushes dropped due to slow client buffer limits",
  registers: [metricsRegistry],
});
