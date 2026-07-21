import { Injectable } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';

export interface TranscriptionSessionDto {
  id: number;
  createdAt: string;
  durationMs: number;
  wordCount: number;
  text: string;
  model: string | null;
}

export interface SessionStats {
  totalSessions: number;
  totalWords: number;
  totalDurationMs: number;
  totalAudioMinutes: number;
  totalAudioLabel: string;
}

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async record(opts: {
    pcmBytes: number;
    sampleRate: number;
    text: string;
    model?: string;
  }): Promise<TranscriptionSessionDto> {
    const durationMs = Math.max(
      0,
      Math.round((opts.pcmBytes / 2 / Math.max(1, opts.sampleRate)) * 1000),
    );
    const text = (opts.text || '').trim();
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

    const row = await this.prisma.transcriptionSession.create({
      data: {
        durationMs,
        wordCount,
        text,
        model: opts.model || null,
      },
    });

    return this.toDto(row);
  }

  async list(limit = 100): Promise<TranscriptionSessionDto[]> {
    const rows = await this.prisma.transcriptionSession.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((r) => this.toDto(r));
  }

  async stats(): Promise<SessionStats> {
    const agg = await this.prisma.transcriptionSession.aggregate({
      _count: { _all: true },
      _sum: { wordCount: true, durationMs: true },
    });

    const totalDurationMs = agg._sum.durationMs || 0;
    return {
      totalSessions: agg._count._all || 0,
      totalWords: agg._sum.wordCount || 0,
      totalDurationMs,
      totalAudioMinutes: Math.round((totalDurationMs / 60000) * 100) / 100,
      totalAudioLabel: formatDuration(totalDurationMs),
    };
  }

  private toDto(row: {
    id: number;
    createdAt: Date;
    durationMs: number;
    wordCount: number;
    text: string;
    model: string | null;
  }): TranscriptionSessionDto {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      durationMs: row.durationMs,
      wordCount: row.wordCount,
      text: row.text,
      model: row.model,
    };
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);

  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} and ${parts[2]}`;
}
