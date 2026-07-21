import { Module } from '@nestjs/common';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionService } from './transcription.service';

@Module({
  controllers: [TranscriptionController],
  providers: [TranscriptionService, TranscriptionGateway],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
