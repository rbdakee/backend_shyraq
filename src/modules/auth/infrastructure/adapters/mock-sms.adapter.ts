import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SmsPort, SmsSendResult } from '../../sms.port';

@Injectable()
export class MockSmsAdapter extends SmsPort {
  private readonly logger = new Logger('MockSmsAdapter');

  send(phone: string, message: string): Promise<SmsSendResult> {
    const txnId = randomUUID();
    this.logger.log(
      `[MOCK SMS] phone=${phone} txnId=${txnId} message="${message}"`,
    );
    return Promise.resolve({ txnId });
  }
}
