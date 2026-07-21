import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionService } from './transcription.service';

@Module({
  imports: [AuthModule, SessionsModule],
  controllers: [TranscriptionController],
  providers: [TranscriptionService, TranscriptionGateway],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}
