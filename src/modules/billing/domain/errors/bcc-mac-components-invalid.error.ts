import { UnprocessableEntityError } from '@/shared-kernel/domain/errors';

export class BccMacComponentsInvalidError extends UnprocessableEntityError {
  public readonly code = 'bcc_mac_components_invalid' as const;

  constructor() {
    super(
      'bcc_mac_components_invalid',
      'BCC MAC components must be separate 16-byte HEX values',
    );
  }
}
