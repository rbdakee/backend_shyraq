import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class InviteGuardianDto {
  @ApiPropertyOptional({
    example: '+77011223344',
    description:
      'E.164 phone of the guardian-to-invite. Provide exactly one of user_phone or user_id.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/)
  user_phone?: string;

  @ApiPropertyOptional({
    example: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    description:
      'UUID of an existing user. Provide exactly one of user_phone or user_id.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  user_id?: string;

  @ApiProperty({
    enum: ['primary', 'secondary', 'nanny'],
    example: 'secondary',
  })
  @IsIn(['primary', 'secondary', 'nanny'])
  role!: 'primary' | 'secondary' | 'nanny';

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the guardian is allowed to pick the child up.',
  })
  @IsOptional()
  @IsBoolean()
  can_pickup?: boolean;
}

export class UpdateGuardianRolePickupDto {
  @ApiPropertyOptional({ enum: ['primary', 'secondary', 'nanny'] })
  @IsOptional()
  @IsIn(['primary', 'secondary', 'nanny'])
  role?: 'primary' | 'secondary' | 'nanny';

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  can_pickup?: boolean;
}

export class ApproveGuardianDto {
  @ApiPropertyOptional({
    example: false,
    description:
      'When true, also grants has_approval_rights. Cap of ≤2 per child enforced server-side.',
  })
  @IsOptional()
  @IsBoolean()
  grant_approval_rights?: boolean;
}

export class ToggleApprovalRightsDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  grant!: boolean;
}

export class UpdateGuardianPermissionsDto {
  @ApiProperty({
    description:
      'Subset of toggleable permission keys to override (booleans). Locked keys are rejected.',
    example: { view_payments: true, view_cctv: false },
    additionalProperties: { type: 'boolean' },
  })
  @IsObject()
  permissions!: Record<string, boolean>;
}
