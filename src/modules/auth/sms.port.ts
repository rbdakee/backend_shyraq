export interface SmsSendResult {
  txnId: string;
}

export abstract class SmsPort {
  abstract send(phone: string, message: string): Promise<SmsSendResult>;
}
