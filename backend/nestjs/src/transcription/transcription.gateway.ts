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
import { StreamSessionService } from './stream-session.service';

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 25 * 1024 * 1024,
  path: '/socket.io',
})
export class TranscriptionGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(TranscriptionGateway.name);
  private socketSessions = new Map<string, string>();

  constructor(
    private readonly streams: StreamSessionService,
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
  }

  handleDisconnect(client: Socket) {
    const sessionId = this.socketSessions.get(client.id);
    this.socketSessions.delete(client.id);
    if (sessionId) {
      this.streams.end(sessionId).catch(() => undefined);
    }
  }

  @SubscribeMessage('session:start')
  onStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { model?: string } = {},
  ) {
    const { sessionId } = this.streams.start(data?.model);
    this.socketSessions.set(client.id, sessionId);
    return { ok: true, sessionId };
  }

  @SubscribeMessage('audio:chunk')
  async onChunk(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { audio?: number[] | ArrayBuffer | Buffer },
  ) {
    const sessionId = this.socketSessions.get(client.id);
    if (!sessionId || !data?.audio) return { ok: false };
    const chunk = Buffer.isBuffer(data.audio)
      ? data.audio
      : Buffer.from(data.audio as ArrayBuffer);
    const result = await this.streams.pushChunk(sessionId, chunk);
    if (result.text) client.emit('partial', { text: result.text });
    return { ok: true, bytes: chunk.length, text: result.text };
  }

  @SubscribeMessage('session:end')
  async onEnd(@ConnectedSocket() client: Socket) {
    const sessionId = this.socketSessions.get(client.id);
    this.socketSessions.delete(client.id);
    if (!sessionId) {
      client.emit('result', { text: '' });
      return { ok: true, text: '' };
    }
    try {
      const result = await this.streams.end(sessionId);
      client.emit('result', { text: result.text });
      return { ok: true, text: result.text };
    } catch (err) {
      const message = (err as Error).message;
      client.emit('error', { error: message });
      return { ok: false, error: message };
    }
  }
}
