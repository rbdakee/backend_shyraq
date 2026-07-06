import { DomainError } from '@/shared-kernel/domain/errors';

export class BccGatewayUnavailableError extends DomainError {
  public readonly code = 'bcc_gateway_unavailable' as const;

  constructor() {
    super('bcc_gateway_unavailable', 'BCC gateway is unavailable');
  }
}

export class BccConnectionCheckFailedError extends DomainError {
  public readonly code = 'bcc_connection_check_failed' as const;

  constructor() {
    super(
      'bcc_connection_check_failed',
      'BCC rejected the merchant connection check',
    );
  }
}
