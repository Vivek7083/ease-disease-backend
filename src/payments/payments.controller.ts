import { Body, Controller, HttpCode, HttpStatus, Inject, Logger, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AppException } from '../common/exceptions/app.exception.js';
import { SlidingWindowLimiter } from '../common/rate-limit/sliding-window-limiter.js';
import type { Env } from '../config/env.schema.js';
import { DEFAULT_FRONTEND_BASE_URL, callbackRedirectUrl, fallbackUrl } from './callback-redirect.js';
import { PaymentHandlerService } from './payment-handler.service.js';

/** Injection token for the limiter shared by the callback and the webhook (120 requests / minute / IP). */
export const PAYU_SIGNAL_LIMITER = Symbol('PAYU_SIGNAL_LIMITER');
export const PAYU_SIGNAL_LIMIT_PER_MINUTE = 120;

// We will be using this schema to store transactoin details and will track it along with the bookings so that there would be a proper mapping 
const PAYU_FIELDS_SCHEMA = {
  type: 'object',
  description:
    'Form fields exactly as PayU posts them. Authenticated by the hash in the payload, not by a token. ' +
    'A valid hash needs the salt, so do not try to craft one here; use the manual PayU test run instead.',
  properties: {
    txnid: { type: 'string', example: 'EDTX01JBTESTTXN000000001' },
    status: { type: 'string', example: 'success' },
    amount: { type: 'string', example: '2499.00' },
    productinfo: { type: 'string' },
    firstname: { type: 'string' },
    email: { type: 'string' },
    udf1: { type: 'string', description: 'Our booking reference', example: 'ED-7K3QXM' },
    additional_charges: { type: 'string', description: 'Only present when PayU adds charges' },
    hash: { type: 'string' },
  },
  additionalProperties: true,
};

/**
 * Receives PayU's two signals and hands the raw payload to the payment handler. No payment logic lives here:
 * this layer only rate-limits, works out the client IP, and answers in the shape PayU and the browser expect.
 */
@ApiTags('payments')
@Controller('v1/payments/payu')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly handler: PaymentHandlerService,
    private readonly config: ConfigService<Env, true>,
    @Inject(PAYU_SIGNAL_LIMITER) private readonly limiter: SlidingWindowLimiter,
  ) {}

  /** PayU's browser return (surl / furl). Always answers with a 303; the page reads the real status from the API. */
  @Post('callback')
  @ApiOperation({ summary: "PayU's browser return (surl / furl). Always 303 to the frontend." })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiBody({ schema: PAYU_FIELDS_SCHEMA })
  @ApiResponse({ status: 303, description: 'Redirect to {frontend}/booking/{reference}; ?e=verify, ?e=busy or ?e=server on problems.' })
  async callback(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const base = this.frontendBaseUrl();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (!this.limiter.hit(req.ip ?? 'unknown').allowed) {
      res.redirect(HttpStatus.SEE_OTHER, fallbackUrl(base, 'busy'));
      return;
    }
    try {
      const result = await this.handler.handle({ source: 'RETURN', payload: body, sourceIp: req.ip ?? null });
      res.redirect(HttpStatus.SEE_OTHER, callbackRedirectUrl(base, result));
    } catch (error) {
      // The user may have just paid: never show them an error page. The handler logged what it could.
      this.logger.error('Payment callback failed to process', error instanceof Error ? error.stack : String(error));
      res.redirect(HttpStatus.SEE_OTHER, fallbackUrl(base, 'server'));
    }
  }

  /** PayU's server-to-server notification. 200 for everything we processed or safely ignored; 5xx only if WE failed. */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "PayU's server-to-server webhook. 200 {ok:true}, also for duplicates." })
  @ApiConsumes('application/x-www-form-urlencoded', 'application/json')
  @ApiBody({ schema: PAYU_FIELDS_SCHEMA })
  @ApiResponse({ status: 200, description: '{ "ok": true }' })
  @ApiResponse({ status: 429, description: 'Rate limited (120 / minute / IP)' })
  @ApiResponse({ status: 500, description: 'Our side failed (e.g. database down): PayU should retry' })
  async webhook(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const decision = this.limiter.hit(req.ip ?? 'unknown');
    if (!decision.allowed) {
      const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new AppException('RATE_LIMITED', 'Too many requests', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
    }
    if (body === undefined || (typeof body === 'object' && body !== null && Object.keys(body).length === 0)) {
      this.logger.warn(`Webhook arrived with an empty or unparsed body (content-type: ${String(req.headers['content-type'])})`);
    }
    // Any throw here (our database down, a bug) becomes a 500 through the global filter, so PayU retries.
    await this.handler.handle({ source: 'WEBHOOK', payload: body, sourceIp: req.ip ?? null });
    return { ok: true };
  }

  private frontendBaseUrl(): string {
    return this.config.get('FRONTEND_BASE_URL', { infer: true }) ?? DEFAULT_FRONTEND_BASE_URL;
  }
}
