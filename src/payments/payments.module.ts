import { Module } from '@nestjs/common';
import { PaymentHandlerService } from './payment-handler.service.js';
import { PayuModule } from './payu/payu.module.js';

@Module({
  imports: [PayuModule],
  providers: [PaymentHandlerService],
  exports: [PaymentHandlerService],
})
export class PaymentsModule {}
