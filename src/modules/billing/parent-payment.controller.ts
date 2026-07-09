import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { InvoiceAccessGuard } from '@/common/guards/invoice-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  InitiatePaymentDto,
  InitiatePaymentResponseDto,
  InitiatePrepaymentDto,
  InitiatePrepaymentResponseDto,
} from './dto/payment.dto';
import { InvoicePresenter } from './invoice.presenter';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-side payment initiation.
 *
 * Path prefix is `/parent/invoices/:id/...`. Tenant is derived from the
 * RESOURCE, not the JWT (the parent token carries no `kindergarten_id` for
 * multi-kg parents): `InvoiceAccessGuard` resolves the invoice cross-tenant by
 * `:id` and pins `req.tenant` to the invoice's kg. `PaymentService.assertCanPay`
 * then does the explicit guardian re-check in that kg after the invoice is
 * re-resolved RLS-scoped — so an approved guardian on kg_A can never pay an
 * invoice from kg_B even with a hand-crafted URL.
 *
 * Permission gate (BP §4.13):
 *   - primary           → allowed.
 *   - secondary         → allowed when `permissions.invoice_pay !== false`
 *                         (default open; primary can disable per row).
 *   - nanny             → 403 `nanny_cannot_pay`.
 */
@ApiTags('Parent / Billing — Payments')
@ApiBearerAuth()
@Controller({ path: 'parent/invoices', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, InvoiceAccessGuard, RolesGuard)
@Roles('parent')
export class ParentPaymentController {
  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly paymentService: PaymentService,
  ) {}

  @Post(':id/pay')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Initiate a payment against the invoice. `payment_mode=full` pays the remaining balance; `partial` requires `amount`. `idempotency_key` collapses retries.',
  })
  @ApiCreatedResponse({ type: InitiatePaymentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation error / amount mismatch / payment_provider_unavailable.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'not_a_guardian / nanny_cannot_pay / secondary_pay_not_allowed.',
  })
  @ApiNotFoundResponse({ description: 'invoice_not_found.' })
  @ApiConflictResponse({
    description:
      'invoice_already_paid / payment_idempotency_conflict / state-machine race.',
  })
  async initiatePay(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) invoiceId: string,
    @Body() dto: InitiatePaymentDto,
  ): Promise<InitiatePaymentResponseDto> {
    const kgId = requireTenant(t);
    const invoice = await this.invoiceService.get(kgId, invoiceId);
    await this.paymentService.assertCanPay(kgId, user.sub, invoice.childId);

    if (dto.payment_mode === 'partial') {
      if (dto.amount === undefined || dto.amount === null) {
        throw new BadRequestException('amount_required_for_partial');
      }
    }

    if (dto.provider === 'kaspi_pay' && !dto.kaspi_phone_number) {
      throw new BadRequestException('kaspi_phone_required');
    }

    const amount =
      dto.payment_mode === 'full'
        ? invoice.amountAfterDiscount.toNumber()
        : dto.amount!;

    const result = await this.paymentService.initiate(kgId, {
      invoiceId: invoice.id,
      amount,
      paymentMode: dto.payment_mode,
      provider: dto.provider,
      idempotencyKey: dto.idempotency_key,
      payerUserId: user.sub,
      returnUrl: dto.return_url,
      kaspiPhoneNumber: dto.kaspi_phone_number,
    });

    return {
      payment_id: result.payment.id,
      redirect_url: result.redirectUrl ?? null,
      deeplink: result.deeplink ?? null,
    };
  }

  @Post(':id/pay/prepayment')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Generate a `prepayment_{N}m` invoice for the child of the original invoice (covering the next N months) and initiate payment for it. `months` ∈ {3, 6, 12, 24}. Discount is sourced from the active tariff plan via DiscountEnginePort.',
  })
  @ApiCreatedResponse({ type: InitiatePrepaymentResponseDto })
  @ApiBadRequestResponse({
    description:
      'prepayment_horizon_not_configured / months_out_of_range / payment_provider_unavailable / validation error.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'not_a_guardian / nanny_cannot_pay / secondary_pay_not_allowed.',
  })
  @ApiNotFoundResponse({
    description: 'invoice_not_found / tariff_not_found.',
  })
  @ApiConflictResponse({ description: 'payment_idempotency_conflict.' })
  async initiatePrepayment(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) invoiceId: string,
    @Body() dto: InitiatePrepaymentDto,
  ): Promise<InitiatePrepaymentResponseDto> {
    const kgId = requireTenant(t);
    const original = await this.invoiceService.get(kgId, invoiceId);
    await this.paymentService.assertCanPay(kgId, user.sub, original.childId);

    this.paymentService.assertProviderEnabled(dto.provider);

    if (dto.provider === 'kaspi_pay' && !dto.kaspi_phone_number) {
      throw new BadRequestException('kaspi_phone_required');
    }

    const prepaymentInvoice = await this.invoiceService.prepayInvoice(
      kgId,
      original.childId,
      dto.months,
    );

    const result = await this.paymentService.initiate(kgId, {
      invoiceId: prepaymentInvoice.id,
      amount: prepaymentInvoice.amountAfterDiscount.toNumber(),
      paymentMode: 'full',
      provider: dto.provider,
      idempotencyKey: dto.idempotency_key,
      payerUserId: user.sub,
      returnUrl: dto.return_url,
      kaspiPhoneNumber: dto.kaspi_phone_number,
    });

    const presented = InvoicePresenter.one(prepaymentInvoice);
    return {
      invoice_id: prepaymentInvoice.id,
      payment_id: result.payment.id,
      redirect_url: result.redirectUrl ?? null,
      deeplink: result.deeplink ?? null,
      preview: {
        base_amount: prepaymentInvoice.amountDue.toNumber(),
        discount_pct: prepaymentInvoice.discountPct ?? 0,
        final_amount: prepaymentInvoice.amountAfterDiscount.toNumber(),
        covers_period: {
          from: presented.period_start,
          to: presented.period_end,
        },
      },
    };
  }
}
