import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { CryptoCipherPort } from '../../application/ports/crypto-cipher.port';

/**
 * AesGcmCryptoCipherAdapter — AES-256-GCM symmetric cipher for at-rest
 * encryption of Kaspi merchant credentials.
 *
 * Blob format: base64( iv[12] || tag[16] || ciphertext )
 * — byte-for-byte compatible with the reference implementation in
 * kaspi_pay_test/src/crypto.js.
 *
 * The 32-byte key is injected at construction time so the adapter is fully
 * unit-testable without env vars.
 */
@Injectable()
export class AesGcmCryptoCipherAdapter extends CryptoCipherPort {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    super();
    if (key.length !== 32) {
      throw new Error('kaspi_encryption_key_invalid_length');
    }
    this.key = key;
  }

  encrypt(plaintext: Buffer): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(blobBase64: string): Buffer {
    const buf = Buffer.from(blobBase64, 'base64');
    if (buf.length < 28) {
      throw new Error('kaspi_cipher_blob_too_short');
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  encryptString(plaintext: string): string {
    return this.encrypt(Buffer.from(plaintext, 'utf8'));
  }

  decryptString(blobBase64: string): string {
    return this.decrypt(blobBase64).toString('utf8');
  }
}
