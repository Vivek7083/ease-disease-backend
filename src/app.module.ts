import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { PayuModule } from './payments/payu/payu.module.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';

@Module({
  imports: [ConfigModule, PrismaModule, HealthModule, PayuModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
