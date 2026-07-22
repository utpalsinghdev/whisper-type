import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SessionsService } from '../sessions/sessions.service';
import { TranscriptionService } from './transcription.service';
import { mergeTranscript } from './wav.util';

interface LiveSession {
  id: string;
  model?: string;
  /** Growing PCM buffer for this live dictation. */
  pcm: Buffer;
  flushedBytes: number;
  text: string;
  /** Background transcription chain — never awaited by pushChunk. */
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
  private readonly maxAgeMs = 30 * 60 * 1000;

  constructor(
    private readonly transcription: TranscriptionService,
    private readonly sessionsLog: SessionsService,
    private readonly config: ConfigService,
  ) {
    this.sampleRate = this.config.get<number>('whisper.sampleRate') || 16000;
    const chunkSec = this.config.get<number>('whisper.streamChunkSec') || 4;
    const overlapSec = this.config.get<number>('whisper.streamOverlapSec') || 0.75;
    this.chunkBytes = Math.max(1, Math.round(chunkSec * this.sampleRate) * 2);
    this.overlapBytes = Math.max(0, Math.round(overlapSec * this.sampleRate) * 2);
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
      chain: Promise.resolve(),
      createdAt: Date.now(),
    });
    return { sessionId: id };
  }

  /**
   * Buffer audio and return immediately. Whisper runs in the background so the
   * desktop UI / waveform never waits on inference during recording.
   */
  pushChunk(sessionId: string, chunk: Buffer): { ok: boolean; queued: number } {
    const session = this.require(sessionId);
    if (!chunk?.length) return { ok: true, queued: 0 };

    session.pcm = Buffer.concat([session.pcm, chunk]);
    session.chain = session.chain
      .then(() => this.flushReadyWindows(session))
      .catch((err) => {
        this.logger.warn(`Stream flush error: ${(err as Error).message}`);
      });

    return { ok: true, queued: chunk.length };
  }

  async end(sessionId: string): Promise<{ text: string }> {
    const session = this.require(sessionId);
    try {
      await session.chain;
      await this.flushRemainder(session);
      const text = session.text.trim();
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
      return { text };
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Unknown stream session');
    return session;
  }

  private async flushReadyWindows(session: LiveSession): Promise<void> {
    while (session.pcm.length - session.flushedBytes >= this.chunkBytes) {
      const end = session.flushedBytes + this.chunkBytes;
      const start = Math.max(0, session.flushedBytes - this.overlapBytes);
      const window = Buffer.from(session.pcm.subarray(start, end));
      const result = await this.transcription.transcribePcm(window, session.model);
      session.text = mergeTranscript(session.text, result.text || '');
      session.flushedBytes = end;
    }
  }

  private async flushRemainder(session: LiveSession): Promise<void> {
    if (session.pcm.length <= session.flushedBytes) return;
    const start = Math.max(0, session.flushedBytes - this.overlapBytes);
    const window = Buffer.from(session.pcm.subarray(start));
    if (window.length < this.sampleRate * 2 * 0.3) return;
    const result = await this.transcription.transcribePcm(window, session.model);
    session.text = mergeTranscript(session.text, result.text || '');
    session.flushedBytes = session.pcm.length;
  }

  private gc() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > this.maxAgeMs) this.sessions.delete(id);
    }
  }
}
