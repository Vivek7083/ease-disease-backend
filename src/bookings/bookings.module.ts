import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { UsersModule } from '../users/users.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [AuthModule, RateLimitModule, UsersModule],
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
