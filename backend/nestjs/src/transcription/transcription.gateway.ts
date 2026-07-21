import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { TranscriptionService } from './transcription.service';
import { SessionsService } from '../sessions/sessions.service';

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 25 * 1024 * 1024,
  path: '/socket.io',
})
export class TranscriptionGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TranscriptionGateway.name);
  private buffers = new Map<string, Buffer[]>();
  private models = new Map<string, string>();

  constructor(
    private readonly transcription: TranscriptionService,
    private readonly sessions: SessionsService,
    private readonly config: ConfigService,
  ) {}

  handleConnection(client: Socket) {
    const expected = this.config.get<string>('apiKey') || '';
    if (expected) {
      const key =
        (client.handshake.auth?.apiKey as string) ||
        (client.handshake.headers['x-api-key'] as string) ||
        '';
      if (key !== expected) {
        this.logger.warn(`Rejecting socket ${client.id}: bad api key`);
        client.disconnect(true);
        return;
      }
    }
    this.logger.log(`Socket connected: ${client.id}`);
    this.buffers.set(client.id, []);
  }

  handleDisconnect(client: Socket) {
    this.buffers.delete(client.id);
    this.models.delete(client.id);
  }

  @SubscribeMessage('session:start')
  onStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { model?: string } = {},
  ) {
    this.buffers.set(client.id, []);
    if (data?.model) this.models.set(client.id, data.model);
    return { ok: true };
  }

  @SubscribeMessage('audio:chunk')
  onChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { audio?: number[] | ArrayBuffer | Buffer },
  ) {
    if (!data?.audio) return { ok: false };
    const chunk = Buffer.isBuffer(data.audio)
      ? data.audio
      : Buffer.from(data.audio as ArrayBuffer);
    const list = this.buffers.get(client.id) || [];
    list.push(chunk);
    this.buffers.set(client.id, list);
    return { ok: true, bytes: chunk.length };
  }

  @SubscribeMessage('session:end')
  async onEnd(@ConnectedSocket() client: Socket) {
    const list = this.buffers.get(client.id) || [];
    this.buffers.set(client.id, []);
    if (!list.length) {
      client.emit('result', { text: '' });
      return { ok: true, text: '' };
    }

    try {
      const pcm = Buffer.concat(list);
      const model = this.models.get(client.id);
      const result = await this.transcription.transcribePcm(pcm, model);
      try {
        await this.sessions.record({
          pcmBytes: pcm.length,
          sampleRate: this.config.get<number>('whisper.sampleRate') || 16000,
          text: result.text || '',
          model,
        });
      } catch {
        /* ignore logging errors */
      }
      client.emit('result', { text: result.text });
      return { ok: true, text: result.text };
    } catch (err) {
      const message = (err as Error).message;
      client.emit('error', { error: message });
      return { ok: false, error: message };
    }
  }
}
