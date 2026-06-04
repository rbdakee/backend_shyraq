import { Injectable } from '@nestjs/common';
import { CryptoCipherPort } from '../../application/ports/crypto-cipher.port';

/**
 * UnconfiguredCryptoCipherAdapter — a no-key fallback registered by
 * SharedKernelModule when KASPI_ENCRYPTION_KEY is not set in the environment.
 *
 * Every method throws `kaspi_encryption_key_not_configured` on use, so
 * non-Kaspi environments boot without issue but any accidental misuse is
 * immediately surfaced with a clear error.
 */
@Injectable()
export class UnconfiguredCryptoCipherAdapter extends CryptoCipherPort {
  private fail(): never {
    throw new Error('kaspi_encryption_key_not_configured');
  }

  encrypt(_plaintext: Buffer): string {
    return this.fail();
  }

  decrypt(_blobBase64: string): Buffer {
    return this.fail();
  }

  encryptString(_plaintext: string): string {
    return this.fail();
  }

  decryptString(_blobBase64: string): string {
    return this.fail();
  }
}
