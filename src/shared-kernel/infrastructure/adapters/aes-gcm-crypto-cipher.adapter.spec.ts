import * as crypto from 'crypto';
import { AesGcmCryptoCipherAdapter } from './aes-gcm-crypto-cipher.adapter';

// Fixed 32-byte test key (deterministic, never used in production).
const TEST_KEY_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const TEST_KEY = Buffer.from(TEST_KEY_HEX, 'hex');

describe('AesGcmCryptoCipherAdapter', () => {
  let adapter: AesGcmCryptoCipherAdapter;

  beforeEach(() => {
    adapter = new AesGcmCryptoCipherAdapter(TEST_KEY);
  });

  it('returns the original buffer after encrypt → decrypt round-trip', () => {
    const plaintext = crypto.randomBytes(64);
    const blob = adapter.encrypt(plaintext);
    const result = adapter.decrypt(blob);
    expect(result).toEqual(plaintext);
  });

  it('returns the original string after encryptString → decryptString round-trip', () => {
    const original = 'Kaspi merchant vtoken: some-secret-value-123';
    const blob = adapter.encryptString(original);
    const result = adapter.decryptString(blob);
    expect(result).toBe(original);
  });

  it('produces a different ciphertext blob on each encrypt (random iv)', () => {
    const plaintext = Buffer.from('same plaintext every time', 'utf8');
    const blob1 = adapter.encrypt(plaintext);
    const blob2 = adapter.encrypt(plaintext);
    expect(blob1).not.toBe(blob2);
    // Both must still decrypt correctly.
    expect(adapter.decrypt(blob1)).toEqual(plaintext);
    expect(adapter.decrypt(blob2)).toEqual(plaintext);
  });

  it('throws when the auth tag is tampered', () => {
    const blob = adapter.encrypt(Buffer.from('secret', 'utf8'));
    const buf = Buffer.from(blob, 'base64');
    // Flip a byte inside the tag region (indices 12..28).
    buf[15] ^= 0xff;
    const tamperedBlob = buf.toString('base64');
    expect(() => adapter.decrypt(tamperedBlob)).toThrow();
  });

  it('throws when the ciphertext is tampered', () => {
    const blob = adapter.encrypt(Buffer.from('another secret', 'utf8'));
    const buf = Buffer.from(blob, 'base64');
    // Flip a byte in the ciphertext region (index >= 28).
    if (buf.length > 28) {
      buf[28] ^= 0xff;
    }
    const tamperedBlob = buf.toString('base64');
    expect(() => adapter.decrypt(tamperedBlob)).toThrow();
  });

  it('throws when constructed with a key of wrong length', () => {
    expect(() => new AesGcmCryptoCipherAdapter(Buffer.alloc(16))).toThrow(
      'kaspi_encryption_key_invalid_length',
    );
  });

  it('throws when the blob is too short', () => {
    const shortBlob = Buffer.alloc(10).toString('base64');
    expect(() => adapter.decrypt(shortBlob)).toThrow(
      'kaspi_cipher_blob_too_short',
    );
  });

  it('decrypts a blob produced by the reference encryptSecret format', () => {
    // Inline reference implementation (matches kaspi_pay_test/src/crypto.js).
    const referenceEncrypt = (secretBuffer: Buffer, key: Buffer): string => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(secretBuffer),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, encrypted]).toString('base64');
    };

    const original = Buffer.from('cross-compat test payload', 'utf8');
    const blob = referenceEncrypt(original, TEST_KEY);
    const result = adapter.decrypt(blob);
    expect(result).toEqual(original);
  });
});
