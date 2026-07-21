import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardAuthGuard } from '../auth/dashboard-auth.guard';
import { formatDuration, SessionsService } from './sessions.service';

@Controller('dashboard/api')
@UseGuards(DashboardAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('stats')
  stats() {
    return this.sessions.stats();
  }

  @Get('sessions')
  async list(@Query('limit') limit?: string) {
    const rows = await this.sessions.list(limit ? parseInt(limit, 10) : 100);
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        durationMs: s.durationMs,
        durationLabel: formatDuration(s.durationMs),
        wordCount: s.wordCount,
        text: s.text,
        model: s.model,
      })),
    };
  }
}
