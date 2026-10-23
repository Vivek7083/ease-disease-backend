import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PublicReadRateLimitGuard } from '../common/rate-limit/rate-limit.guards.js';
import { ErrorEnvelopeDto } from '../users/users.dto.js';
import { PackageListResponseDto } from './packages.dto.js';
import { PackagesService, type PackageItem } from './packages.service.js';

@ApiTags('packages')
@Controller('v1')
export class PackagesController {
  constructor(private readonly packages: PackagesService) {}

  /** Public: no login, no App Check, no Idempotency-Key. The browser may keep the answer for 5 minutes. */
  @Get('packages')
  @Header('Cache-Control', 'public, max-age=300')
  @UseGuards(PublicReadRateLimitGuard)
  @ApiOperation({
    summary: 'List the packages on sale',
    description: 'Public. Packages that are on sale, cheapest first. The answer may be cached for 5 minutes.',
  })
  @ApiOkResponse({ type: PackageListResponseDto })
  @ApiResponse({ status: 429, type: ErrorEnvelopeDto, description: '`RATE_LIMITED`: over 60 requests / minute from this address. See `Retry-After`.' })
  list(): Promise<{ packages: PackageItem[] }> {
    return this.packages.listActive();
  }
}
