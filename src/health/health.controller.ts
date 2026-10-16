import { Controller, Get } from '@nestjs/common';
import { HealthService, type HealthStatus } from './health.service.js';

@Controller('healthz')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check(): Promise<HealthStatus> {
    return this.healthService.check();
  }
}
