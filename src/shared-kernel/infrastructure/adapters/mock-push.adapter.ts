import { Injectable, Logger } from '@nestjs/common';
import {
  PushNotificationPort,
  PushPayload,
  PushTarget,
} from '../../domain/push-notification.port';

/**
 * Recorded `send()` invocation. Tests capture these via `getCalls()` /
 * `clearCalls()` to assert that the dispatcher invoked the right user × token
 * combinations without coupling to a real transport.
 */
export interface MockPushCall {
  target: PushTarget;
  payload: PushPayload;
  at: Date;
}

/**
 * Mock push adapter. Logs every invocation through Nest's Logger and stores a
 * structured copy in `getCalls()` for assertion in service-unit tests. Never
 * throws — mirrors `MockSmsAdapter` so the dispatcher can rely on push
 * failures coming from the FCM adapter only (in production).
 *
 * Instances are kept as singletons by the DI container, so test code can
 * inject `PushNotificationPort` and downcast to `MockPushAdapter` to read
 * the recorded calls.
 */
@Injectable()
export class MockPushAdapter extends PushNotificationPort {
  private readonly logger = new Logger('MockPushAdapter');
  private readonly calls: MockPushCall[] = [];

  send(target: PushTarget, payload: PushPayload): Promise<void> {
    const platforms = target.tokens.map((t) => t.platform).join(',');
    this.logger.log(
      `[MockPush] → user=${target.userId} platforms=${platforms} title="${payload.title}"`,
    );
    this.calls.push({ target, payload, at: new Date() });
    return Promise.resolve();
  }

  /** Tests-only — returns the list of recorded `send()` calls in order. */
  getCalls(): readonly MockPushCall[] {
    return this.calls;
  }

  /** Tests-only — drops the recorded calls so successive tests stay isolated. */
  clearCalls(): void {
    this.calls.length = 0;
  }
}
