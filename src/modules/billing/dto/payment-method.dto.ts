import { ApiProperty } from '@nestjs/swagger';

export class PaymentMethodDto {
  @ApiProperty({
    enum: [
      'mock',
      'halyk_epay',
      'kaspi_pay',
      'tiptoppay',
      'freedom_pay',
      'bcc',
    ],
    example: 'bcc',
  })
  provider!:
    | 'mock'
    | 'halyk_epay'
    | 'kaspi_pay'
    | 'tiptoppay'
    | 'freedom_pay'
    | 'bcc';

  @ApiProperty({ enum: ['redirect', 'deeplink'], example: 'redirect' })
  kind!: 'redirect' | 'deeplink';

  @ApiProperty({ example: 'BCC Карта' })
  display_name!: string;
}

export class PaymentMethodsResponseDto {
  @ApiProperty({ type: [PaymentMethodDto] })
  providers!: PaymentMethodDto[];
}
