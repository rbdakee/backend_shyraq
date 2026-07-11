import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export const BCC_BILLING_PHONE_PATTERN = /^\+7\d{10}$/;

export class SavePaymentProfileDto {
  @ApiProperty({
    example: '+77011234567',
    description:
      'Billing phone used for card payments. This never changes the login phone.',
  })
  @IsString()
  @Matches(BCC_BILLING_PHONE_PATTERN, {
    message: 'invalid_billing_phone_format',
  })
  billing_phone!: string;

  @ApiProperty({
    example: 'г. Алматы, ул. Абая, 10',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  billing_address!: string;
}

export class PaymentProfileResponseDto {
  @ApiProperty({ example: '+77011234567' })
  billing_phone!: string;

  @ApiProperty({
    example: 'г. Алматы, ул. Абая, 10',
    nullable: true,
  })
  billing_address!: string | null;

  @ApiProperty({ example: true })
  saved!: boolean;
}
