import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

/**
 * Keeps whisper.cpp `whisper-server` running with the model loaded in RAM.
 * Nest talks to it over loopback HTTP (/inference, /load).
 */
@Injectable()
export class WhisperServerManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhisperServerManager.name);
  private child: ChildProcess | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private loadedModel = '';

  private readonly host: string;
  private readonly port: number;
  private readonly binary: string;
  private readonly threads: number;
  private readonly language: string;
  private readonly modelPath: string;
  private readonly defaultModel: string;
  private readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.host = this.config.get<string>('whisper.serverHost') || '127.0.0.1';
    this.port = this.config.get<number>('whisper.serverPort') || 8090;
    this.binary = this.config.get<string>('whisper.serverBinary') || 'whisper-server';
    this.threads = this.config.get<number>('whisper.threads') || 4;
    this.language = this.config.get<string>('whisper.language') || 'en';
    this.modelPath = this.config.get<string>('whisper.modelPath') || './models';
    this.defaultModel = this.config.get<string>('whisper.model') || 'base.en';
    this.enabled = (this.config.get<string>('whisper.serverEnabled') || 'true') !== 'false';
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  isReady(): boolean {
    return this.ready && !!this.child && !this.child.killed;
  }

  getLoadedModel(): string {
    return this.loadedModel;
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Warm whisper-server disabled (WHISPER_SERVER_ENABLED=false)');
    }
    // Actual start happens after TranscriptionService downloads the model file.
  }

  async onModuleDestroy() {
    this.stop();
  }

  modelFile(modelName: string): string {
    const name = modelName.replace(/\.pt$/i, '').replace(/^ggml-/, '').replace(/\.bin$/i, '');
    return path.join(this.modelPath, `ggml-${name}.bin`);
  }

  async ensureStarted(modelName?: string): Promise<void> {
    if (!this.enabled) {
      throw new Error('whisper-server is disabled');
    }
    const model = (modelName || this.defaultModel)
      .replace(/\.pt$/i, '')
      .replace(/^ggml-/, '')
      .replace(/\.bin$/i, '');

    if (this.starting) {
      await this.starting;
      if (this.isReady() && this.loadedModel === model) return;
    }

    this.starting = this.startOrReload(model).finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private async startOrReload(model: string): Promise<void> {
    const file = this.modelFile(model);
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
      throw new Error(`Model file missing or tiny: ${file}`);
    }

    if (this.isReady() && this.loadedModel === model) {
      return;
    }

    if (this.isReady() && this.loadedModel && this.loadedModel !== model) {
      this.logger.log(`Switching warm model ${this.loadedModel} → ${model}`);
      await this.loadModel(file);
      this.loadedModel = model;
      return;
    }

    this.stop();
    this.logger.log(`Starting whisper-server with ${model} on ${this.baseUrl}`);
    const child = spawn(
      this.binary,
      [
        '-m',
        file,
        '-l',
        this.language,
        '-t',
        String(this.threads),
        '-nt',
        '--host',
        this.host,
        '--port',
        String(this.port),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;

    child.stdout?.on('data', (d) => this.logger.debug(String(d).trim()));
    child.stderr?.on('data', (d) => {
      const line = String(d).trim();
      if (line) this.logger.log(`[whisper-server] ${line.slice(0, 400)}`);
    });
    child.on('exit', (code, signal) => {
      this.logger.warn(`whisper-server exited code=${code} signal=${signal}`);
      this.ready = false;
      this.child = null;
    });

    await this.waitUntilUp(120_000);
    this.loadedModel = model;
    this.ready = true;
    this.logger.log(`whisper-server ready (model=${model})`);
  }

  private loadModel(modelFile: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const boundary = `----wt${Date.now()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelFile}\r\n` +
            `--${boundary}--\r\n`,
        ),
      ]);
      const req = http.request(
        {
          hostname: this.host,
          port: this.port,
          path: '/load',
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: 120_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(
                new Error(
                  `whisper-server /load failed HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
                ),
              );
            }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private waitUntilUp(timeoutMs: number): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!this.child || this.child.killed) {
          reject(new Error('whisper-server process died during startup'));
          return;
        }
        const req = http.get(`http://${this.host}:${this.port}/`, (res) => {
          res.resume();
          // Any HTTP response means the server socket is accepting connections.
          resolve();
        });
        req.on('error', () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error('Timed out waiting for whisper-server'));
            return;
          }
          setTimeout(tick, 400);
        });
        req.setTimeout(800, () => {
          req.destroy();
        });
      };
      tick();
    });
  }

  stop() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.child = null;
    this.ready = false;
  }
}
