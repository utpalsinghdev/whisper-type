/** Build a mono 16-bit PCM WAV buffer in memory (no ffmpeg). */
export function pcmToWavBuffer(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/** Append new Whisper text, stripping duplicated overlap at the join. */
export function mergeTranscript(prev: string, next: string): string {
  const a = (prev || '').trim();
  const b = (next || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(a)) return b;

  const aWords = a.split(/\s+/);
  const bWords = b.split(/\s+/);
  const max = Math.min(aWords.length, bWords.length, 12);
  for (let n = max; n >= 1; n--) {
    const tail = aWords.slice(-n).join(' ').toLowerCase();
    const head = bWords.slice(0, n).join(' ').toLowerCase();
    if (tail === head) {
      return `${a} ${bWords.slice(n).join(' ')}`.trim();
    }
  }
  return `${a} ${b}`.trim();
}
