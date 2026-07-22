export default () => ({
  port: parseInt(process.env.PORT || '3003', 10),
  host: process.env.HOST || '0.0.0.0',
  apiKey: process.env.API_KEY || '',
  sessionSecret:
    process.env.SESSION_SECRET || 'wishpertype-dev-secret-change-me',
  databasePath: process.env.DATABASE_PATH || './data/wishpertype.db',
  corsOrigin: (process.env.CORS_ORIGIN ||
    'http://localhost:3003,http://localhost:5173,tauri://localhost,http://tauri.localhost'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES || String(25 * 1024 * 1024), 10),
  whisper: {
    model: process.env.WHISPER_MODEL || 'base.en',
    modelPath: process.env.WHISPER_MODEL_PATH || './models',
    language: process.env.WHISPER_LANGUAGE || 'en',
    sampleRate: parseInt(process.env.WHISPER_SAMPLE_RATE || '16000', 10),
    threads: parseInt(process.env.WHISPER_THREADS || '4', 10),
    binary: process.env.WHISPER_BINARY || 'whisper-cli',
    serverBinary: process.env.WHISPER_SERVER_BINARY || 'whisper-server',
    serverHost: process.env.WHISPER_SERVER_HOST || '127.0.0.1',
    serverPort: parseInt(process.env.WHISPER_SERVER_PORT || '8090', 10),
    serverEnabled: process.env.WHISPER_SERVER_ENABLED || 'true',
    // Buffer-by-default: no mid-recording Whisper (faster Stop on CPU base.en).
    streamMode: process.env.WHISPER_STREAM_MODE || 'buffer',
    streamChunkSec: parseFloat(process.env.WHISPER_STREAM_CHUNK_SEC || '3'),
    streamOverlapSec: parseFloat(process.env.WHISPER_STREAM_OVERLAP_SEC || '0.5'),
    timeoutMs: parseInt(process.env.TRANSCRIBE_TIMEOUT_MS || '300000', 10),
  },
});

