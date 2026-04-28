import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '@/common/decorators/public.decorator';
import { HealthService } from './health.service';
import { HealthReadyDto, HealthStatusDto } from './dto/health-status.dto';

@ApiTags('health')
@Public()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness/readiness probe' })
  @ApiOkResponse({ type: HealthStatusDto })
  getHealth(): HealthStatusDto {
    return this.healthService.getStatus();
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiOkResponse({ type: HealthReadyDto })
  getReadiness(): Promise<HealthReadyDto> {
    return this.healthService.getReadiness();
  }
}
