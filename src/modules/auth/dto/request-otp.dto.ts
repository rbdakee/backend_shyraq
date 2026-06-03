import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

export type AuthApp = 'parent' | 'staff' | 'admin';

export const AUTH_APPS: readonly AuthApp[] = ['parent', 'staff', 'admin'];

export class RequestOtpDto {
  @ApiProperty({
    description: 'Kazakhstan phone number in E.164 format',
    example: '+77012345678',
    pattern: '^\\+7\\d{10}$',
  })
  @IsString()
  @Matches(/^\+7\d{10}$/, { message: 'phone must be E.164 +7XXXXXXXXXX' })
  phone!: string;

  @ApiProperty({
    description:
      'Which client app the login targets. Drives the audience filter: ' +
      '`parent` → role parent (open registration); `staff` → mentor/specialist/reception; ' +
      '`admin` → admin. For `staff`/`admin` the phone must already be invited.',
    example: 'parent',
    enum: AUTH_APPS,
  })
  @IsIn(AUTH_APPS, { message: 'app must be one of parent|staff|admin' })
  app!: AuthApp;
}
