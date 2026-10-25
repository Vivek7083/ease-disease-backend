import { Controller, Get } from '@nestjs/common';
import { HealthService, type HealthStatus } from './health.service.js';

// Cloud Run's front end answers /healthz itself (a Google 404 page) before the request reaches the container, so the same
// check is also served at /v1/health; deploy checks use that one. /healthz stays for local runs and the container's own check.
@Controller(['healthz', 'v1/health'])
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check(): Promise<HealthStatus> {
    return this.healthService.check();
  }
}
