import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';

@Module({
  imports: [ConfigModule, PrismaModule, HealthModule, PaymentsModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
