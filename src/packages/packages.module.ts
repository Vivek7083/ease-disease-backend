import { Module } from '@nestjs/common';
import { RateLimitModule } from '../common/rate-limit/rate-limit.module.js';
import { PackagesController } from './packages.controller.js';
import { PackagesService } from './packages.service.js';

@Module({
  imports: [RateLimitModule],
  controllers: [PackagesController],
  providers: [PackagesService],
})
export class PackagesModule {}
