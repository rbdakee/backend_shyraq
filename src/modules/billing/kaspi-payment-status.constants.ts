/**
 * BullMQ queue + job names for the K8 Kaspi status poller. Unlike the monthly
 * billing cron there is NO repeatable scheduler — each payment owns a
 * self-rescheduling delayed job chain that starts when `PaymentService.initiate`
 * persists the Kaspi QrOperationId and stops on a terminal status / ExpireDate.
 *
 * This file is intentionally dependency-free (no service/provider imports) so it
 * can be shared by `payment.service`, the poller service, and the processor
 * without re-creating the `payment.service → poller-service → payment.service`
 * ES-module import cycle that breaks `AppModule` DI resolution.
 */
export const KASPI_PAYMENT_STATUS_QUEUE = 'kaspi-payment-status';
export const KASPI_PAYMENT_STATUS_JOB = 'kaspi-poll';

export interface KaspiPaymentStatusJobData {
  kindergartenId: string;
  paymentId: string;
}

/**
 * Adaptive polling cadence for the K8 Kaspi status poller. Env-overridable so
 * ops can re-tune the aggressive/backoff/tail windows without a redeploy
 * (IMPLEMENTATION_PLAN.md §2.2 "Стратегия опроса статуса (K8)"):
 *
 *   0–2 min    : every 5s   (aggressive — most payments land here)
 *   2–10 min   : every 20s  (backoff — probability drops, save calls)
 *   10 min–exp : every 60s  (tail — "forgot and paid later")
 *   ExpireDate / hard-cap → stop, markFailed
 */
export const KASPI_POLL_AGGRESSIVE_INTERVAL_MS = numEnv(
  'KASPI_POLL_AGGRESSIVE_MS',
  5_000,
);
export const KASPI_POLL_BACKOFF_INTERVAL_MS = numEnv(
  'KASPI_POLL_BACKOFF_MS',
  20_000,
);
export const KASPI_POLL_TAIL_INTERVAL_MS = numEnv('KASPI_POLL_TAIL_MS', 60_000);
export const KASPI_POLL_AGGRESSIVE_WINDOW_MS = numEnv(
  'KASPI_POLL_AGGRESSIVE_WINDOW_MS',
  2 * 60_000,
);
export const KASPI_POLL_BACKOFF_WINDOW_MS = numEnv(
  'KASPI_POLL_BACKOFF_WINDOW_MS',
  10 * 60_000,
);
export const KASPI_POLL_HARD_CAP_MS = numEnv(
  'KASPI_POLL_HARD_CAP_MS',
  24 * 60 * 60_000,
);

// ── env helper ─────────────────────────────────────────────────────────────

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
