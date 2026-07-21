import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  DashboardPagesController,
  DashboardStaticController,
} from './dashboard.controller';

@Module({
  imports: [AuthModule],
  controllers: [DashboardPagesController, DashboardStaticController],
})
export class DashboardModule {}
