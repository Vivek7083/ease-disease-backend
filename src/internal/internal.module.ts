import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { GoogleOidcVerifier, OIDC_VERIFIER } from './oidc-verifier.js';
import { TickAuthGuard } from './tick-auth.guard.js';
import { TickController, TickDevController } from './tick.controller.js';

@Module({
  imports: [PaymentsModule],
  controllers: [TickController, TickDevController],
  providers: [TickAuthGuard, { provide: OIDC_VERIFIER, useFactory: () => new GoogleOidcVerifier() }],
})
export class InternalModule {}
