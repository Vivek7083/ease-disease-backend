import { Module } from '@nestjs/common';
import { SlidingWindowLimiter } from '../common/rate-limit/sliding-window-limiter.js';
import { CheckoutService, TXNID_GENERATOR } from './checkout.service.js';
import { PaymentHandlerService } from './payment-handler.service.js';
import {
  PAYU_SIGNAL_LIMIT_PER_MINUTE,
  PAYU_SIGNAL_LIMITER,
  PaymentsController,
} from './payments.controller.js';
import { PaymentsDevController } from './dev/payments-dev.controller.js';
import { PayuModule } from './payu/payu.module.js';
import { generateTxnid } from './payu/payu-txnid.js';

@Module({
  imports: [PayuModule],
  controllers: [PaymentsController, PaymentsDevController],
  providers: [
    PaymentHandlerService,
    CheckoutService,
    { provide: TXNID_GENERATOR, useValue: () => generateTxnid() },
    {
      provide: PAYU_SIGNAL_LIMITER,
      useFactory: () =>
        new SlidingWindowLimiter(PAYU_SIGNAL_LIMIT_PER_MINUTE, 60_000),
    },
  ],
  exports: [PaymentHandlerService, CheckoutService],
})
export class PaymentsModule {}
