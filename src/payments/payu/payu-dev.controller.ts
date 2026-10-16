import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Put, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AppException } from '../../common/exceptions/app.exception.js';
import { DevelopmentOnlyGuard } from '../../common/guards/development-only.guard.js';
import { PayuCredentialsProvider, type PayuCredentialsStatus } from './payu-credentials.provider.js';

const credentialsBody = z.object({
  key: z.string().trim().min(1).max(100),
  salt: z.string().trim().min(1).max(200),
  env: z.enum(['test', 'live']),
  confirmLive: z.boolean().optional(),
});

/**
 * Development-only: lets you paste PayU credentials into Swagger so the hosted checkout flow can be
 * tried locally without putting secrets in a file. Not part of the locked API contract. Returns 404
 * outside NODE_ENV=development (guard, and the provider refuses too).
 */
@ApiTags('dev (development only)')
@Controller('dev/payu/credentials')
@UseGuards(DevelopmentOnlyGuard)
export class PayuDevController {
  constructor(private readonly credentials: PayuCredentialsProvider) {}

  @Put()
  @ApiOperation({
    summary: 'Load PayU credentials into server memory',
    description:
      'Held in memory only, lost on restart. Use TEST credentials normally. env "live" needs confirmLive: true and makes real charges.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['key', 'salt', 'env'],
      properties: {
        key: { type: 'string' },
        salt: { type: 'string', format: 'password' },
        env: { type: 'string', enum: ['test', 'live'] },
        confirmLive: { type: 'boolean', description: 'Must be true when env is "live"' },
      },
    },
  })
  load(@Body() body: unknown): PayuCredentialsStatus {
    const parsed = credentialsBody.safeParse(body);
    if (!parsed.success) {
      // Field names only: never echo submitted values (one of them is the salt).
      const fields = Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.') || '_', issue.message]));
      throw new AppException('VALIDATION_FAILED', 'Invalid credentials payload', HttpStatus.BAD_REQUEST, { fields });
    }
    const { key, salt, env, confirmLive } = parsed.data;
    if (env === 'live' && confirmLive !== true) {
      throw new AppException(
        'VALIDATION_FAILED',
        'Live credentials make real charges: send confirmLive: true to proceed',
        HttpStatus.BAD_REQUEST,
        { fields: { confirmLive: 'required when env is live' } },
      );
    }
    this.credentials.setOverride({ key, salt, env });
    return this.credentials.status();
  }

  @Get()
  @ApiOperation({ summary: 'Which credentials are active (never returns the salt)' })
  status(): PayuCredentialsStatus {
    return this.credentials.status();
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forget in-memory credentials (falls back to env vars, if set)' })
  clear(): PayuCredentialsStatus {
    this.credentials.clearOverride();
    return this.credentials.status();
  }
}
