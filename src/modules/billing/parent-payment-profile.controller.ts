import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import {
  PaymentProfileResponseDto,
  SavePaymentProfileDto,
} from './dto/payment-profile.dto';
import { UserPaymentProfileService } from './user-payment-profile.service';

@ApiTags('Parent / Billing — Payment profile')
@ApiBearerAuth()
@Controller({ path: 'parent/payment-profile', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('parent')
export class ParentPaymentProfileController {
  constructor(private readonly profiles: UserPaymentProfileService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get private billing details; falls back to the verified login phone when no profile is saved.',
  })
  @ApiOkResponse({ type: PaymentProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async get(
    @CurrentUser() user: JwtPayload,
  ): Promise<PaymentProfileResponseDto> {
    const profile = await this.profiles.get(user.sub);
    return {
      billing_phone: profile.billingPhone,
      billing_address: profile.billingAddress,
      saved: profile.saved,
    };
  }

  @Put()
  @ApiOperation({
    summary:
      'Atomically save both private billing fields without changing the login phone.',
  })
  @ApiOkResponse({ type: PaymentProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async save(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SavePaymentProfileDto,
  ): Promise<PaymentProfileResponseDto> {
    const profile = await this.profiles.save(
      user.sub,
      dto.billing_phone,
      dto.billing_address,
    );
    return {
      billing_phone: profile.billingPhone,
      billing_address: profile.billingAddress,
      saved: profile.saved,
    };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete both saved billing fields.' })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  async delete(@CurrentUser() user: JwtPayload): Promise<void> {
    await this.profiles.delete(user.sub);
  }
}
