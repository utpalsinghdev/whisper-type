import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DashboardAuthGuard } from './dashboard-auth.guard';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, DashboardAuthGuard, ApiKeyGuard],
  exports: [AuthService, DashboardAuthGuard, ApiKeyGuard],
})
export class AuthModule {}
