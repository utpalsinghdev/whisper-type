import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { WhisperServerManager } from './whisper-server.manager';
import { pcmToWavBuffer } from './wav.util';

export interface TranscriptionResult {
  text: string;
  language?: string;
}

@Injectable()
export class TranscriptionService implements OnModuleInit {
  private readonly logger = new Logger(TranscriptionService.name);
  private modelReady = false;
  private currentModel: string;
  private readonly modelPath: string;
  private readonly tempDir: string;
  private readonly binary: string;
  private readonly language: string;
  private readonly threads: number;
  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ConfigService,
    private readonly whisperServer: WhisperServerManager,
  ) {
    this.currentModel = this.config.get<string>('whisper.model') || 'base.en';
    this.modelPath = this.config.get<string>('whisper.modelPath') || './models';
    this.binary = this.config.get<string>('whisper.binary') || 'whisper-cli';
    this.language = this.config.get<string>('whisper.language') || 'en';
    this.threads = this.config.get<number>('whisper.threads') || 4;
    this.sampleRate = this.config.get<number>('whisper.sampleRate') || 16000;
    this.timeoutMs = this.config.get<number>('whisper.timeoutMs') || 300000;
    this.tempDir = path.join(process.cwd(), 'tmp');
  }

  async onModuleInit() {
    fs.mkdirSync(this.modelPath, { recursive: true });
    fs.mkdirSync(this.tempDir, { recursive: true });
    // Download default model + warm whisper-server in the background.
    this.warmDefault().catch((err) => {
      this.logger.error(`Warm-up failed: ${(err as Error).message}`);
    });
  }

  private async warmDefault() {
    await this.ensureModelFile(this.currentModel);
    try {
      await this.whisperServer.ensureStarted(this.currentModel);
      this.modelReady = true;
      this.logger.log(`Warm model ready in RAM: ${this.currentModel}`);
    } catch (err) {
      this.logger.warn(
        `whisper-server warm start failed (${(err as Error).message}); will fall back to whisper-cli`,
      );
      this.modelReady = fs.existsSync(this.modelFile(this.currentModel));
    }
  }

  isModelLoaded(): boolean {
    return this.modelReady || this.whisperServer.isReady();
  }

  getModelInfo() {
    return {
      name: this.whisperServer.getLoadedModel() || this.currentModel,
      path: this.modelFile(this.currentModel),
      loaded: this.isModelLoaded(),
      warmServer: this.whisperServer.isReady(),
    };
  }

  getAvailableModels(): string[] {
    if (!fs.existsSync(this.modelPath)) return [];
    return fs
      .readdirSync(this.modelPath)
      .filter((f) => f.startsWith('ggml-') && f.endsWith('.bin'))
      .map((f) => f.replace(/^ggml-/, '').replace(/\.bin$/, ''));
  }

  async switchModel(modelName: string): Promise<void> {
    const normalized = this.normalizeModelName(modelName);
    await this.ensureModelFile(normalized);
    try {
      await this.whisperServer.ensureStarted(normalized);
    } catch {
      /* CLI fallback still works */
    }
    this.currentModel = normalized;
    this.modelReady = true;
  }

  async transcribePcm(audioBuffer: Buffer, modelName?: string): Promise<TranscriptionResult> {
    const model = this.normalizeModelName(modelName || this.currentModel);
    await this.ensureModelFile(model);

    const run = this.queue.then(() => this.runTranscription(audioBuffer, model));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTranscription(
    audioBuffer: Buffer,
    model: string,
  ): Promise<TranscriptionResult> {
    if (!audioBuffer?.length) return { text: '', language: this.language };

    // Prefer warm whisper-server (model already in RAM).
    try {
      await this.whisperServer.ensureStarted(model);
      const text = await this.inferViaServer(audioBuffer);
      this.currentModel = model;
      this.modelReady = true;
      return { text: text.trim(), language: this.language };
    } catch (err) {
      this.logger.warn(
        `Warm server inference failed (${(err as Error).message}); falling back to whisper-cli`,
      );
      return this.inferViaCli(audioBuffer, model);
    }
  }

  private async inferViaServer(pcm: Buffer): Promise<string> {
    const wav = pcmToWavBuffer(pcm, this.sampleRate);
    const boundary = `----wt${Date.now()}${Math.random().toString(16).slice(2)}`;
    const fileHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n`,
    );
    const fields = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="temperature"\r\n\r\n0.0\r\n` +
        `--${boundary}--\r\n`,
    );
    const body = Buffer.concat([fileHeader, wav, fields]);
    const url = new URL(`${this.whisperServer.baseUrl}/inference`);

    const raw = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!res.statusCode || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
              return;
            }
            resolve(text);
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('whisper-server inference timed out'));
      });
      req.write(body);
      req.end();
    });

    try {
      const data = JSON.parse(raw);
      if (typeof data.text === 'string') return data.text;
      if (typeof data.transcription === 'string') return data.transcription;
      if (Array.isArray(data.transcription)) {
        return data.transcription.map((s: { text?: string }) => s.text || '').join('');
      }
    } catch {
      // Some builds return plain text
      if (raw.trim()) return raw.trim();
    }
    return '';
  }

  private async inferViaCli(audioBuffer: Buffer, model: string): Promise<TranscriptionResult> {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const pcmFile = path.join(this.tempDir, `${id}.pcm`);
    const wavFile = path.join(this.tempDir, `${id}.wav`);
    const outPrefix = path.join(this.tempDir, `${id}_out`);

    try {
      fs.writeFileSync(pcmFile, audioBuffer);
      fs.writeFileSync(wavFile, pcmToWavBuffer(audioBuffer, this.sampleRate));

      const args = [
        '-m',
        this.modelFile(model),
        '-f',
        wavFile,
        '-l',
        this.language,
        '-t',
        String(this.threads),
        '-nt',
        '-oj',
        '-of',
        outPrefix,
      ];

      await this.runCommand(this.binary, args, this.timeoutMs);
      const text = this.readTranscript(`${outPrefix}.json`, `${outPrefix}.txt`);
      this.currentModel = model;
      this.modelReady = true;
      return { text: text.trim(), language: this.language };
    } finally {
      this.safeUnlink(pcmFile);
      this.safeUnlink(wavFile);
      this.safeUnlink(`${outPrefix}.json`);
      this.safeUnlink(`${outPrefix}.txt`);
      this.safeUnlink(`${outPrefix}.srt`);
      this.safeUnlink(`${outPrefix}.vtt`);
    }
  }

  private normalizeModelName(name: string): string {
    return name.replace(/\.pt$/i, '').replace(/^ggml-/, '').replace(/\.bin$/i, '');
  }

  private modelFile(modelName: string): string {
    return path.join(this.modelPath, `ggml-${this.normalizeModelName(modelName)}.bin`);
  }

  private async ensureModelFile(modelName: string): Promise<void> {
    const normalized = this.normalizeModelName(modelName);
    const file = this.modelFile(normalized);
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
      this.logger.log(`Downloading ggml model ${normalized}…`);
      await this.downloadModel(normalized, file);
    }
    this.currentModel = normalized;
  }

  private downloadModel(modelName: string, dest: string): Promise<void> {
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelName}.bin`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;

    return new Promise((resolve, reject) => {
      const get = (target: string, redirects = 0) => {
        https
          .get(target, (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location &&
              redirects < 5
            ) {
              res.resume();
              get(res.headers.location, redirects + 1);
              return;
            }
            if (res.statusCode !== 200) {
              reject(new Error(`Model download failed HTTP ${res.statusCode} for ${url}`));
              res.resume();
              return;
            }
            const out = createWriteStream(tmp);
            pipeline(res, out)
              .then(() => {
                fs.renameSync(tmp, dest);
                resolve();
              })
              .catch((err) => {
                this.safeUnlink(tmp);
                reject(err);
              });
          })
          .on('error', (err) => {
            this.safeUnlink(tmp);
            reject(err);
          });
      };
      get(url);
    });
  }

  private runCommand(bin: string, args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.logger.debug(`${bin} ${args.join(' ')}`);
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to start ${bin}: ${err.message}`));
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${bin} exited ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }

  private readTranscript(jsonPath: string, txtPath: string): string {
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (typeof data.transcription === 'string') return data.transcription;
        if (typeof data.text === 'string') return data.text;
        if (Array.isArray(data.transcription)) {
          return data.transcription.map((s: { text?: string }) => s.text || '').join('').trim();
        }
      } catch (err) {
        this.logger.warn(`Failed to parse ${jsonPath}: ${(err as Error).message}`);
      }
    }
    if (fs.existsSync(txtPath)) {
      return fs.readFileSync(txtPath, 'utf8');
    }
    return '';
  }

  private safeUnlink(filePath: string) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}
