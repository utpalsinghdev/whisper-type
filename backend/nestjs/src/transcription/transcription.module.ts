import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StreamSessionService } from './stream-session.service';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionService } from './transcription.service';
import { WhisperServerManager } from './whisper-server.manager';

@Module({
  imports: [AuthModule, SessionsModule],
  controllers: [TranscriptionController],
  providers: [
    WhisperServerManager,
    TranscriptionService,
    StreamSessionService,
    TranscriptionGateway,
  ],
  exports: [TranscriptionService, StreamSessionService],
})
export class TranscriptionModule {}
