/**
 * CryptoCipherPort — symmetric authenticated encryption for at-rest storage
 * of sensitive credentials (Kaspi merchant vtoken, ECDSA/ECDH keypairs, etc.).
 *
 * The blob format is: base64( iv[12] || tag[16] || ciphertext )
 * — compatible with the reference Node.js AES-256-GCM implementation in
 * kaspi_pay_test/src/crypto.js.
 *
 * Framework-free: no NestJS / TypeORM / ioredis imports allowed here.
 */
export abstract class CryptoCipherPort {
  /**
   * Encrypts a raw byte buffer and returns a base64 blob.
   * Each call produces a unique ciphertext due to a random 12-byte IV.
   */
  abstract encrypt(plaintext: Buffer): string;

  /**
   * Decrypts a base64 blob produced by `encrypt`.
   * Throws if the authentication tag is invalid (tampered data) or the
   * blob is malformed.
   */
  abstract decrypt(blobBase64: string): Buffer;

  /**
   * Convenience: encrypt a UTF-8 string. Returns a base64 blob.
   */
  abstract encryptString(plaintext: string): string;

  /**
   * Convenience: decrypt a base64 blob and return the UTF-8 string.
   */
  abstract decryptString(blobBase64: string): string;
}
