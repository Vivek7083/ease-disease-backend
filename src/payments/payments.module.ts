import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { UsersModule } from '../users/users.module.js';
import { SlidingWindowLimiter } from '../common/rate-limit/sliding-window-limiter.js';
import { CheckoutController } from './checkout.controller.js';
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
import { ReconcileService } from './reconcile.service.js';

@Module({
  imports: [PayuModule, AuthModule, RateLimitModule, UsersModule],
  controllers: [PaymentsController, CheckoutController, PaymentsDevController],
  providers: [
    PaymentHandlerService,
    ReconcileService,
    CheckoutService,
    { provide: TXNID_GENERATOR, useValue: () => generateTxnid() },
    {
      provide: PAYU_SIGNAL_LIMITER,
      useFactory: () =>
        new SlidingWindowLimiter(PAYU_SIGNAL_LIMIT_PER_MINUTE, 60_000),
    },
  ],
  exports: [PaymentHandlerService, ReconcileService, CheckoutService],
})
export class PaymentsModule {}
