import { Module } from '@nestjs/common';
import { DevelopmentOnlyGuard } from '../../common/guards/development-only.guard.js';
import { PayuClient } from './payu-client.js';
import { PayuCredentialsProvider } from './payu-credentials.provider.js';
import { PayuDevController } from './payu-dev.controller.js';

@Module({
  controllers: [PayuDevController],
  providers: [
    PayuCredentialsProvider,
    DevelopmentOnlyGuard,
    {
      provide: PayuClient,
      useFactory: (credentials: PayuCredentialsProvider) => new PayuClient(() => credentials.get()),
      inject: [PayuCredentialsProvider],
    },
  ],
  exports: [PayuClient, PayuCredentialsProvider],
})
export class PayuModule {}
