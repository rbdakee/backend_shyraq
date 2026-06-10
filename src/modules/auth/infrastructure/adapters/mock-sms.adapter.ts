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

  sendOtp(phone: string, code: string): Promise<SmsSendResult> {
    const txnId = randomUUID();
    this.logger.log(
      `[MOCK SMS otp] phone=${phone} txnId=${txnId} code="${code}"`,
    );
    return Promise.resolve({ txnId });
  }

  sendAdminInvite(
    phone: string,
    kindergartenName: string,
  ): Promise<SmsSendResult> {
    const txnId = randomUUID();
    this.logger.log(
      `[MOCK SMS template admin_invite_ru] phone=${phone} txnId=${txnId} kg_name="${kindergartenName}"`,
    );
    return Promise.resolve({ txnId });
  }

  sendStaffInvite(
    phone: string,
    kindergartenName: string,
  ): Promise<SmsSendResult> {
    const txnId = randomUUID();
    this.logger.log(
      `[MOCK SMS template staff_invite_ru] phone=${phone} txnId=${txnId} kg_name="${kindergartenName}"`,
    );
    return Promise.resolve({ txnId });
  }

  sendTrustedPersonAssigned(
    phone: string,
    childName: string,
    kindergartenName: string,
  ): Promise<SmsSendResult> {
    const txnId = randomUUID();
    this.logger.log(
      `[MOCK SMS template trusted_person_assigned_ru] phone=${phone} txnId=${txnId} child_name="${childName}" kg_name="${kindergartenName}"`,
    );
    return Promise.resolve({ txnId });
  }

  sendPickupOtp(
    phone: string,
    childName: string,
    kindergartenName: string,
    code: string,
  ): Promise<SmsSendResult> {
    const txnId = randomUUID();
    this.logger.log(
      `[MOCK SMS template pickup_otp_ru] phone=${phone} txnId=${txnId} child_name="${childName}" kg_name="${kindergartenName}" otp="${code}"`,
    );
    return Promise.resolve({ txnId });
  }
}
