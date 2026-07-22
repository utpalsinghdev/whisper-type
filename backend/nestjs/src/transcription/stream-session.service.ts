import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SessionsService } from '../sessions/sessions.service';
import { TranscriptionService } from './transcription.service';
import { mergeTranscript } from './wav.util';

/**
 * Streaming strategy for base.en on CPU (council + Wispr-alt research):
 *
 * - `buffer` (default): upload PCM while speaking; run ONE full greedy
 *   transcription on Stop. No mid-recording Whisper → CPU free for Stop,
 *   no sliding-window merge errors. Matches Handy / Outsider guidance.
 * - `live`: whisrs-style single-flight sliding windows for partial progress;
 *   on Stop, cancel backlog and finalize only the uncommitted tail (or a
 *   full pass for short utterances).
 */
interface LiveSession {
  id: string;
  model?: string;
  pcm: Buffer;
  flushedBytes: number;
  text: string;
  /** Bumped to drop stale sliding-window work. */
  epoch: number;
  busy: boolean;
  dirty: boolean;
  ending: boolean;
  chain: Promise<void>;
  createdAt: number;
}

@Injectable()
export class StreamSessionService {
  private readonly logger = new Logger(StreamSessionService.name);
  private readonly sessions = new Map<string, LiveSession>();
  private readonly sampleRate: number;
  private readonly chunkBytes: number;
  private readonly overlapBytes: number;
  private readonly mode: 'buffer' | 'live';
  private readonly maxAgeMs = 30 * 60 * 1000;
  /** Below this duration, live mode prefers one full re-decode on Stop. */
  private readonly fullPassMaxSec = 20;

  constructor(
    private readonly transcription: TranscriptionService,
    private readonly sessionsLog: SessionsService,
    private readonly config: ConfigService,
  ) {
    this.sampleRate = this.config.get<number>('whisper.sampleRate') || 16000;
    const chunkSec = this.config.get<number>('whisper.streamChunkSec') || 3;
    const overlapSec = this.config.get<number>('whisper.streamOverlapSec') || 0.5;
    this.chunkBytes = Math.max(1, Math.round(chunkSec * this.sampleRate) * 2);
    this.overlapBytes = Math.max(0, Math.round(overlapSec * this.sampleRate) * 2);
    const raw = (this.config.get<string>('whisper.streamMode') || 'buffer').toLowerCase();
    this.mode = raw === 'live' ? 'live' : 'buffer';
    this.logger.log(`Stream mode=${this.mode} chunk=${chunkSec}s overlap=${overlapSec}s`);
  }

  start(model?: string): { sessionId: string } {
    this.gc();
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      model,
      pcm: Buffer.alloc(0),
      flushedBytes: 0,
      text: '',
      epoch: 0,
      busy: false,
      dirty: false,
      ending: false,
      chain: Promise.resolve(),
      createdAt: Date.now(),
    });
    return { sessionId: id };
  }

  pushChunk(sessionId: string, chunk: Buffer): { ok: boolean; queued: number } {
    const session = this.require(sessionId);
    if (!chunk?.length || session.ending) return { ok: true, queued: 0 };

    session.pcm = Buffer.concat([session.pcm, chunk]);

    // Buffer mode: never burn CPU mid-recording — Stop gets a free warm server.
    if (this.mode === 'buffer') {
      return { ok: true, queued: chunk.length };
    }

    if (session.busy) {
      session.dirty = true;
      return { ok: true, queued: chunk.length };
    }

    this.kick(session);
    return { ok: true, queued: chunk.length };
  }

  async end(sessionId: string): Promise<{ text: string; latencyMs?: number; mode?: string }> {
    const session = this.require(sessionId);
    const t0 = Date.now();
    try {
      session.ending = true;
      session.epoch += 1;
      session.dirty = false;

      if (this.mode === 'buffer') {
        await this.finalizeFull(session);
      } else {
        await session.chain;
        const audioSec = session.pcm.length / (this.sampleRate * 2);
        // Short dictations: one clean full pass beats merge artifacts.
        if (audioSec > 0 && audioSec <= this.fullPassMaxSec) {
          await this.finalizeFull(session);
        } else {
          await this.catchUp(session, true);
        }
      }

      const text = session.text.trim();
      const latencyMs = Date.now() - t0;
      this.logger.log(
        `stream end mode=${this.mode} audio=${(session.pcm.length / (this.sampleRate * 2)).toFixed(1)}s stop=${latencyMs}ms`,
      );
      try {
        await this.sessionsLog.record({
          pcmBytes: session.pcm.length,
          sampleRate: this.sampleRate,
          text,
          model: session.model,
        });
      } catch {
        /* ignore */
      }
      return { text, latencyMs, mode: this.mode };
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  private async finalizeFull(session: LiveSession): Promise<void> {
    if (!session.pcm.length) {
      session.text = '';
      session.flushedBytes = 0;
      return;
    }
    const result = await this.transcription.transcribePcm(session.pcm, session.model);
    session.text = (result.text || '').trim();
    session.flushedBytes = session.pcm.length;
  }

  private kick(session: LiveSession) {
    if (session.busy) {
      session.dirty = true;
      return;
    }
    session.busy = true;
    const epoch = session.epoch;
    session.chain = this.catchUp(session, false)
      .catch((err) => {
        this.logger.warn(`Stream catch-up error: ${(err as Error).message}`);
      })
      .finally(() => {
        session.busy = false;
        if (!session.ending && session.dirty && session.epoch === epoch) {
          session.dirty = false;
          this.kick(session);
        }
      });
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown stream session');
    return session;
  }

  /**
   * Commit pending audio. At most one Whisper call unless coalescing a backlog,
   * so Stop never waits on a long queue of windows.
   */
  private async catchUp(session: LiveSession, final: boolean): Promise<void> {
    const epochAtStart = session.epoch;

    while (true) {
      if (!final && session.epoch !== epochAtStart) return;

      const pending = session.pcm.length - session.flushedBytes;
      const minNeeded = final ? Math.round(this.sampleRate * 2 * 0.08) : this.chunkBytes;
      if (pending < minNeeded) return;

      const coalesce = final || pending >= this.chunkBytes * 2;
      const sliceEnd = coalesce
        ? session.pcm.length
        : session.flushedBytes + this.chunkBytes;
      const sliceStart = Math.max(0, session.flushedBytes - this.overlapBytes);
      const window = Buffer.from(session.pcm.subarray(sliceStart, sliceEnd));

      const result = await this.transcription.transcribePcm(window, session.model, {
        prompt: session.text || undefined,
      });

      if (!final && session.epoch !== epochAtStart) return;

      session.text = mergeTranscript(session.text, result.text || '');
      session.flushedBytes = sliceEnd;

      if (final || !coalesce) return;
    }
  }

  private gc() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > this.maxAgeMs) this.sessions.delete(id);
    }
  }
}
