import { Module } from '@nestjs/common';
import { SlidingWindowLimiter } from '../common/rate-limit/sliding-window-limiter.js';
import { PaymentHandlerService } from './payment-handler.service.js';
import { PAYU_SIGNAL_LIMIT_PER_MINUTE, PAYU_SIGNAL_LIMITER, PaymentsController } from './payments.controller.js';
import { PayuModule } from './payu/payu.module.js';

@Module({
  imports: [PayuModule],
  controllers: [PaymentsController],
  providers: [
    PaymentHandlerService,
    { provide: PAYU_SIGNAL_LIMITER, useFactory: () => new SlidingWindowLimiter(PAYU_SIGNAL_LIMIT_PER_MINUTE, 60_000) },
  ],
  exports: [PaymentHandlerService],
})
export class PaymentsModule {}
