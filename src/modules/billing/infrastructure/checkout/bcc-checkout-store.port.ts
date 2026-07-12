import { BccFormFields } from '../payment-provider/bcc/bcc-protocol';

export interface BccCheckoutSession {
  paymentId: string;
  kindergartenId: string;
  order: string;
  gatewayUrl: string;
  formFields: BccFormFields;
  billingPhone: string;
  billingAddress: string;
}

export interface BccCheckoutHandle {
  token: string;
  expiresInSeconds: number;
}

export abstract class BccCheckoutStorePort {
  abstract createOrReuse(
    session: BccCheckoutSession,
  ): Promise<BccCheckoutHandle>;

  abstract findTokenByPayment(
    kindergartenId: string,
    paymentId: string,
  ): Promise<string | null>;

  abstract consume(token: string): Promise<BccCheckoutSession | null>;
}
