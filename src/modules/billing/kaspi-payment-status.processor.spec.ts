import {
  KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
  KASPI_POLL_AGGRESSIVE_WINDOW_MS,
  KASPI_POLL_BACKOFF_INTERVAL_MS,
  KASPI_POLL_BACKOFF_WINDOW_MS,
  KASPI_POLL_TAIL_INTERVAL_MS,
} from './kaspi-payment-status.constants';
import { nextDelayMs } from './kaspi-payment-status.processor';

describe('nextDelayMs', () => {
  const created = new Date('2026-06-04T12:00:00.000Z');
  const at = (ageMs: number): Date => new Date(created.getTime() + ageMs);

  it('returns the aggressive interval for a fresh payment', () => {
    expect(nextDelayMs(created, at(0))).toBe(KASPI_POLL_AGGRESSIVE_INTERVAL_MS);
    expect(nextDelayMs(created, at(60_000))).toBe(
      KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
    );
  });

  it('returns the backoff interval at the aggressive-window boundary', () => {
    expect(nextDelayMs(created, at(KASPI_POLL_AGGRESSIVE_WINDOW_MS))).toBe(
      KASPI_POLL_BACKOFF_INTERVAL_MS,
    );
    expect(nextDelayMs(created, at(KASPI_POLL_AGGRESSIVE_WINDOW_MS + 1))).toBe(
      KASPI_POLL_BACKOFF_INTERVAL_MS,
    );
  });

  it('returns the tail interval at the backoff-window boundary', () => {
    expect(nextDelayMs(created, at(KASPI_POLL_BACKOFF_WINDOW_MS))).toBe(
      KASPI_POLL_TAIL_INTERVAL_MS,
    );
    expect(
      nextDelayMs(created, at(KASPI_POLL_BACKOFF_WINDOW_MS + 60_000)),
    ).toBe(KASPI_POLL_TAIL_INTERVAL_MS);
  });

  it('defaults to 5s / 20s / 60s', () => {
    expect(KASPI_POLL_AGGRESSIVE_INTERVAL_MS).toBe(5_000);
    expect(KASPI_POLL_BACKOFF_INTERVAL_MS).toBe(20_000);
    expect(KASPI_POLL_TAIL_INTERVAL_MS).toBe(60_000);
  });
});
