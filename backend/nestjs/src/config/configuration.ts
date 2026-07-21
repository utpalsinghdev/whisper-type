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
    model: process.env.WHISPER_MODEL || 'medium.en',
    modelPath: process.env.WHISPER_MODEL_PATH || './models',
    language: process.env.WHISPER_LANGUAGE || 'en',
    sampleRate: parseInt(process.env.WHISPER_SAMPLE_RATE || '16000', 10),
    threads: parseInt(process.env.WHISPER_THREADS || '4', 10),
    binary: process.env.WHISPER_BINARY || 'whisper-cli',
    timeoutMs: parseInt(process.env.TRANSCRIBE_TIMEOUT_MS || '300000', 10),
  },
});
