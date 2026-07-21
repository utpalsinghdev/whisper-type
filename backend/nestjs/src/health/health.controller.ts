import { Controller, Get } from '@nestjs/common';
import { TranscriptionService } from '../transcription/transcription.service';

@Controller()
export class HealthController {
  constructor(private readonly transcription: TranscriptionService) {}

  @Get(['health', 'api/v1/health'])
  health() {
    return {
      status: 'ok',
      service: 'wishpertype-backend',
      model: this.transcription.getModelInfo(),
      modelLoaded: this.transcription.isModelLoaded(),
    };
  }

  @Get(['ready', 'api/v1/ready'])
  ready() {
    const loaded = this.transcription.isModelLoaded();
    return {
      status: loaded ? 'ok' : 'starting',
      modelLoaded: loaded,
      model: this.transcription.getModelInfo(),
      models: this.transcription.getAvailableModels(),
    };
  }
}
