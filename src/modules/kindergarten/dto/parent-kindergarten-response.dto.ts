import { ApiProperty } from '@nestjs/swagger';

/**
 * Parent-facing kindergarten card. Deliberately a NARROW subset of
 * `KindergartenDto` — only the public-facing identity fields a parent needs
 * to see. `settings` (fiscal / fee / discount config), `plan` (the садик's
 * SaaS subscription tier), `slug` and `is_active` are intentionally omitted:
 * they are operator/admin-internal and must never leak to the parent app.
 */
export class ParentKindergartenDto {
  @ApiProperty({ example: '331faeff-2ab2-43a8-b504-7c34df8b547c' })
  id!: string;

  @ApiProperty({ example: 'Детский сад «Солнышко»' })
  name!: string;

  @ApiProperty({ example: 'Алматы, ул. Абая, 1', nullable: true })
  address!: string | null;

  @ApiProperty({ example: '+77272221100', nullable: true })
  phone!: string | null;

  @ApiProperty({
    example:
      'https://balam-media.object.pscloud.io/331faeff/2026-07/9f2c….png?X-Amz-…',
    nullable: true,
    type: String,
    description:
      'Branding logo. Short-lived presigned media URL (or null when unset). Safe to drop straight into an <img src>. Re-fetch the kindergarten to refresh an expired link.',
  })
  logo_url!: string | null;
}
