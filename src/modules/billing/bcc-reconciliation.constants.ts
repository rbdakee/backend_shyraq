export const BCC_RECONCILIATION_QUEUE = 'bcc-payment-reconciliation';
export const BCC_RECONCILIATION_JOB = 'bcc-reconcile';

export interface BccReconciliationJobData {
  kindergartenId: string;
  paymentId: string;
  tick: number;
}

/** BCC payments must remain processing for at least five minutes. */
export const BCC_RECONCILIATION_INITIAL_DELAY_MS = Math.max(
  5 * 60_000,
  positiveEnv('BCC_RECONCILIATION_INITIAL_DELAY_MS', 5 * 60_000),
);
export const BCC_RECONCILIATION_BASE_DELAY_MS = positiveEnv(
  'BCC_RECONCILIATION_BASE_DELAY_MS',
  5 * 60_000,
);
export const BCC_RECONCILIATION_MAX_DELAY_MS = positiveEnv(
  'BCC_RECONCILIATION_MAX_DELAY_MS',
  60 * 60_000,
);
export const BCC_RECONCILIATION_HARD_CAP_MS = positiveEnv(
  'BCC_RECONCILIATION_HARD_CAP_MS',
  24 * 60 * 60_000,
);

export function bccReconciliationDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(30, attempts - 1));
  return Math.min(
    BCC_RECONCILIATION_MAX_DELAY_MS,
    BCC_RECONCILIATION_BASE_DELAY_MS * 2 ** exponent,
  );
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
