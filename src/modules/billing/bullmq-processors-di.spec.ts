/**
 * B22a T3 — BullMQ processors DI regression (FINDINGS SP1).
 *
 * Asserts that every BullMQ processor in the worker import graph carries
 * an explicit `@Inject(ClockPort)` (and `@Inject(NotificationPort)` for
 * `ContentPublishProcessor`) on its constructor. Without those
 * decorators, reflect-metadata can return `undefined` for abstract-class
 * tokens at worker boot — Nest's emitted `design:paramtypes` is best-effort
 * for `abstract class` and TS-strict mode otherwise compiles a `Function`
 * sentinel that the worker DI graph cannot match against the registered
 * `useClass` provider.
 *
 * The test reads `Reflect.getMetadata('self:paramtypes', Ctor)` (Nest's
 * `SELF_DECLARED_DEPS_METADATA` key — see
 * `@nestjs/common/constants.ts`). Each entry has shape
 * `{ index: number, param: <token> }`. We assert the expected token at
 * the expected param index — a mis-typed `@Inject(...)` would fail this
 * assertion before the worker ever boots.
 */
import 'reflect-metadata';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { NotificationPort } from '@/common/notifications/notification.port';
import { OutboxPollerProcessor } from '@/modules/notification/outbox-poller.processor';
import { WeeklyRolloutProcessor } from '@/modules/schedule-rollout/weekly-rollout.processor';
import { MonthlyBillingProcessor } from './monthly-billing.processor';
import { DiscountExpireProcessor } from './discount-expire.processor';
import { OverdueInvoiceProcessor } from './overdue-invoice.processor';
import { BirthdayGenerationProcessor } from '@/modules/content/processors/birthday-generation.processor';
import { ContentPublishProcessor } from '@/modules/content/processors/content-publish.processor';
import { StoryCleanupProcessor } from '@/modules/content/processors/story-cleanup.processor';

const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';

interface InjectEntry {
  index: number;
  param: unknown;
}

type ConstructorLike = abstract new (...args: unknown[]) => unknown;

function paramAt(ctor: ConstructorLike, index: number): unknown | undefined {
  const entries =
    (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, ctor) as
      | InjectEntry[]
      | undefined) ?? [];
  const found = entries.find((e) => e.index === index);
  return found?.param;
}

describe('BullMQ processors — explicit @Inject for abstract ports (SP1)', () => {
  it('OutboxPollerProcessor injects ClockPort at param index 3', () => {
    expect(paramAt(OutboxPollerProcessor, 3)).toBe(ClockPort);
  });

  it('WeeklyRolloutProcessor injects ClockPort at param index 1', () => {
    expect(paramAt(WeeklyRolloutProcessor, 1)).toBe(ClockPort);
  });

  it('MonthlyBillingProcessor injects ClockPort at param index 2', () => {
    expect(paramAt(MonthlyBillingProcessor, 2)).toBe(ClockPort);
  });

  it('DiscountExpireProcessor injects ClockPort at param index 2', () => {
    expect(paramAt(DiscountExpireProcessor, 2)).toBe(ClockPort);
  });

  it('OverdueInvoiceProcessor injects ClockPort at param index 3 (T1 carry-forward)', () => {
    expect(paramAt(OverdueInvoiceProcessor, 3)).toBe(ClockPort);
  });

  it('BirthdayGenerationProcessor injects ClockPort at param index 2', () => {
    expect(paramAt(BirthdayGenerationProcessor, 2)).toBe(ClockPort);
  });

  it('ContentPublishProcessor injects NotificationPort at param 1 + ClockPort at param 3', () => {
    expect(paramAt(ContentPublishProcessor, 1)).toBe(NotificationPort);
    expect(paramAt(ContentPublishProcessor, 3)).toBe(ClockPort);
  });

  it('StoryCleanupProcessor injects ClockPort at param index 3', () => {
    expect(paramAt(StoryCleanupProcessor, 3)).toBe(ClockPort);
  });
});
