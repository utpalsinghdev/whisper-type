import {
  BadRequestException,
  Controller,
  HttpCode,
  PayloadTooLargeException,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { TranscriptionService } from './transcription.service';

@Controller()
export class TranscriptionController {
  constructor(
    private readonly transcription: TranscriptionService,
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

    const result = await this.transcription.transcribePcm(
      file.buffer,
      modelName || model,
    );
    return { text: result.text || '' };
  }
}
