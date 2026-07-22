import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  PayloadTooLargeException,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { SessionsService } from '../sessions/sessions.service';
import { StreamSessionService } from './stream-session.service';
import { TranscriptionService } from './transcription.service';

@Controller()
export class TranscriptionController {
  constructor(
    private readonly transcription: TranscriptionService,
    private readonly sessions: SessionsService,
    private readonly streams: StreamSessionService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Compatible with the desktop app + legacy Python API shape:
   * multipart form: model_name, files[]
   * response: { text }
   */
  @Post(['transcribe_pcm_chunk', 'api/v1/transcribe_pcm_chunk'])
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  @UseInterceptors(AnyFilesInterceptor())
  async transcribePcmChunk(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('model_name') modelName?: string,
    @Body('model') model?: string,
  ) {
    const file = files?.[0];
    if (!file?.buffer?.length) {
      throw new BadRequestException('No audio file provided');
    }

    const max = this.config.get<number>('maxUploadBytes') || 25 * 1024 * 1024;
    if (file.buffer.length > max) {
      throw new PayloadTooLargeException('payload too large');
    }

    const chosenModel = modelName || model;
    const result = await this.transcription.transcribePcm(file.buffer, chosenModel);

    try {
      await this.sessions.record({
        pcmBytes: file.buffer.length,
        sampleRate: this.config.get<number>('whisper.sampleRate') || 16000,
        text: result.text || '',
        model: chosenModel,
      });
    } catch {
      // Stats logging must not fail the transcription response.
    }

    return { text: result.text || '' };
  }

  /** Start a live streaming transcription session (chunks while speaking). */
  @Post(['transcribe_stream/start', 'api/v1/transcribe_stream/start'])
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  startStream(@Body() body: { model_name?: string; model?: string } = {}) {
    return this.streams.start(body.model_name || body.model);
  }

  /** Push a PCM chunk for an active stream session. */
  @Post(['transcribe_stream/chunk', 'api/v1/transcribe_stream/chunk'])
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  @UseInterceptors(AnyFilesInterceptor())
  async streamChunk(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('session_id') sessionId?: string,
    @Body('sessionId') sessionIdAlt?: string,
  ) {
    const id = sessionId || sessionIdAlt;
    if (!id) throw new BadRequestException('session_id required');
    const file = files?.[0];
    if (!file?.buffer?.length) {
      throw new BadRequestException('No audio chunk provided');
    }
    const max = this.config.get<number>('maxUploadBytes') || 25 * 1024 * 1024;
    if (file.buffer.length > max) {
      throw new PayloadTooLargeException('payload too large');
    }
    return this.streams.pushChunk(id, file.buffer);
  }

  /** Finish stream — flushes remainder and returns full text. */
  @Post(['transcribe_stream/end', 'api/v1/transcribe_stream/end'])
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  async endStream(@Body() body: { session_id?: string; sessionId?: string } = {}) {
    const id = body.session_id || body.sessionId;
    if (!id) throw new BadRequestException('session_id required');
    return this.streams.end(id);
  }
}
