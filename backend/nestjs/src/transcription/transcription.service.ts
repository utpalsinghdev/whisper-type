import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

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

  constructor(private readonly config: ConfigService) {
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
    await this.ensureModel(this.currentModel);
  }

  isModelLoaded(): boolean {
    return this.modelReady;
  }

  getModelInfo() {
    return {
      name: this.currentModel,
      path: this.modelFile(this.currentModel),
      loaded: this.modelReady,
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
    if (normalized === this.currentModel && this.modelReady) return;
    await this.ensureModel(normalized);
  }

  async transcribePcm(audioBuffer: Buffer, modelName?: string): Promise<TranscriptionResult> {
    if (!this.modelReady) {
      throw new ServiceUnavailableException('Whisper model not loaded yet');
    }

    // Serialize inference so a small VPS doesn't OOM on parallel jobs.
    const run = this.queue.then(() => this.runTranscription(audioBuffer, modelName));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTranscription(
    audioBuffer: Buffer,
    modelName?: string,
  ): Promise<TranscriptionResult> {
    const model = this.normalizeModelName(modelName || this.currentModel);
    if (model !== this.currentModel) {
      await this.ensureModel(model);
    }

    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const pcmFile = path.join(this.tempDir, `${id}.pcm`);
    const wavFile = path.join(this.tempDir, `${id}.wav`);
    const outPrefix = path.join(this.tempDir, `${id}_out`);

    try {
      fs.writeFileSync(pcmFile, audioBuffer);
      await this.pcmToWav(pcmFile, wavFile);

      const modelFile = this.modelFile(model);
      const args = [
        '-m',
        modelFile,
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

  private async ensureModel(modelName: string): Promise<void> {
    const normalized = this.normalizeModelName(modelName);
    const file = this.modelFile(normalized);
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) {
      this.logger.log(`Downloading ggml model ${normalized}…`);
      await this.downloadModel(normalized, file);
    }
    this.currentModel = normalized;
    this.modelReady = true;
    this.logger.log(`Model ready: ${normalized} (${file})`);
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

  private pcmToWav(pcmFile: string, wavFile: string): Promise<void> {
    return this.runCommand(
      'ffmpeg',
      [
        '-y',
        '-f',
        's16le',
        '-ar',
        String(this.sampleRate),
        '-ac',
        '1',
        '-i',
        pcmFile,
        wavFile,
      ],
      60_000,
    );
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
