import { Module } from '@nestjs/common';
import { TranscriptionModule } from '../transcription/transcription.module';
import { HealthController } from './health.controller';

@Module({
  imports: [TranscriptionModule],
  controllers: [HealthController],
})
export class HealthModule {}
