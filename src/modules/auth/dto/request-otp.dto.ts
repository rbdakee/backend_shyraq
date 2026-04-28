import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({
    description: 'Kazakhstan phone number in E.164 format',
    example: '+77012345678',
    pattern: '^\\+7\\d{10}$',
  })
  @IsString()
  @Matches(/^\+7\d{10}$/, { message: 'phone must be E.164 +7XXXXXXXXXX' })
  phone!: string;
}
