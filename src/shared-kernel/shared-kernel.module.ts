import { Global, Module } from '@nestjs/common';
import { ClockPort } from './application/ports/clock.port';
import { SystemClockAdapter } from './infrastructure/adapters/system-clock.adapter';

@Global()
@Module({
  providers: [{ provide: ClockPort, useClass: SystemClockAdapter }],
  exports: [ClockPort],
})
export class SharedKernelModule {}
