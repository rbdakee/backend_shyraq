import { ApiProperty } from '@nestjs/swagger';

export class RoleResponseDto {
  @ApiProperty({ example: 'parent' })
  role!: string;

  @ApiProperty({
    example: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
    nullable: true,
    type: String,
  })
  kindergarten_id!: string | null;

  @ApiProperty({ example: null, nullable: true, type: String })
  group_id!: string | null;
}

export class KindergartenSummaryResponseDto {
  @ApiProperty({ example: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c' })
  id!: string;

  @ApiProperty({ example: 'Sunshine Kindergarten' })
  name!: string;

  @ApiProperty({ example: 'sunshine-almaty' })
  slug!: string;
}

export class AuthUserResponseDto {
  @ApiProperty({ example: '00000000-0000-4000-8000-000000000001' })
  id!: string;

  @ApiProperty({ example: '+77012345678' })
  phone!: string;

  @ApiProperty({ example: 'Aisha Bekova' })
  full_name!: string;

  @ApiProperty({ nullable: true, example: null, type: String })
  avatar_url!: string | null;

  @ApiProperty({ nullable: true, example: null, type: String })
  iin!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    description: 'YYYY-MM-DD or null',
    type: String,
  })
  date_of_birth!: string | null;

  @ApiProperty({ example: 'ru', enum: ['kk', 'ru'] })
  locale!: string;
}

export class AuthResponseDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIuLi4ifQ.signature',
  })
  access_token!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  })
  refresh_token!: string | null;

  @ApiProperty({ example: 'Bearer' })
  token_type!: 'Bearer';

  @ApiProperty({ example: 900 })
  expires_in!: number;

  @ApiProperty({
    example: false,
    description:
      'When true, the access token only authorises /auth/role/select. Refresh token is null in that case.',
  })
  pending_role_select!: boolean;

  @ApiProperty({ type: [RoleResponseDto] })
  roles!: RoleResponseDto[];

  @ApiProperty({ type: [KindergartenSummaryResponseDto] })
  kindergartens!: KindergartenSummaryResponseDto[];

  @ApiProperty({ type: AuthUserResponseDto })
  user!: AuthUserResponseDto;
}

export class OtpRequestResponseDto {
  @ApiProperty({ example: true })
  sent!: boolean;

  @ApiProperty({ example: 60 })
  resend_after_sec!: number;
}

export class SuperAdminAuthResponseDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIuLi4ifQ.signature',
  })
  access_token!: string;

  @ApiProperty({
    example: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  })
  refresh_token!: string;

  @ApiProperty({ example: 'Bearer' })
  token_type!: 'Bearer';

  @ApiProperty({ example: 900 })
  expires_in!: number;

  @ApiProperty({ example: false })
  pending_role_select!: false;

  @ApiProperty({ type: [RoleResponseDto] })
  roles!: RoleResponseDto[];
}
