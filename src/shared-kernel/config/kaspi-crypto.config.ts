import { registerAs } from '@nestjs/config';
import { Transform } from 'class-transformer';
import { IsHexadecimal, IsOptional, Length } from 'class-validator';
import validateConfig from '../../utils/validate-config';
import { KaspiCryptoConfig } from './kaspi-crypto-config.type';

class EnvironmentVariablesValidator {
  // Coerce a blank value (e.g. `KASPI_ENCRYPTION_KEY=` copied verbatim from
  // env-example) to undefined BEFORE validation, so @IsOptional actually skips
  // it. Without this, an empty string fails @IsHexadecimal/@Length and crashes
  // startup — defeating the boot-safe "missing key → UnconfiguredCipher" contract.
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsOptional()
  @IsHexadecimal()
  @Length(64, 64)
  KASPI_ENCRYPTION_KEY?: string;
}

export default registerAs<KaspiCryptoConfig>('kaspiCrypto', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    encryptionKeyHex: process.env.KASPI_ENCRYPTION_KEY || undefined,
  };
});
