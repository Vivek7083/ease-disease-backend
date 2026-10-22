import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { ConfigModule } from './config/config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './health/health.module.js';
import { InternalModule } from './internal/internal.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { UsersModule } from './users/users.module.js';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware.js';

@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, HealthModule, PaymentsModule, InternalModule, UsersModule, BookingsModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
