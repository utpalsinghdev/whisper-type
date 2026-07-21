# ── whisper.cpp builder ──────────────────────────────────────────
FROM debian:bookworm-slim AS whisper-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git cmake build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Pin a release — master occasionally breaks on aarch64 Docker.
RUN git clone --depth 1 --branch v1.7.5 https://github.com/ggerganov/whisper.cpp.git . \
 && cmake -B build \
      -DWHISPER_BUILD_TESTS=OFF \
      -DGGML_NATIVE=OFF \
      -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j"$(nproc)" --config Release \
 && mkdir -p /whisper/bin /whisper/lib \
 && (cp build/bin/whisper-cli /whisper/bin/ 2>/dev/null \
     || cp build/bin/main /whisper/bin/whisper-cli) \
 && find build -name 'libwhisper*.so*' -exec cp -a {} /whisper/lib/ \; \
 && find build -name 'libggml*.so*' -exec cp -a {} /whisper/lib/ \; \
 && touch /whisper/lib/.keep

# ── NestJS builder ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS nest-builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY nest-cli.json tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=whisper-builder /whisper/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /whisper/lib/ /usr/local/lib/
RUN ldconfig

COPY --from=nest-builder /app/dist ./dist
COPY --from=nest-builder /app/node_modules ./node_modules
COPY --from=nest-builder /app/package.json ./

RUN mkdir -p /app/models /app/tmp \
 && useradd --system --uid 1001 --create-home nestjs \
 && chown -R nestjs:nestjs /app

USER nestjs

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    WHISPER_MODEL=base.en \
    WHISPER_MODEL_PATH=/app/models \
    WHISPER_THREADS=4 \
    WHISPER_LANGUAGE=en \
    WHISPER_BINARY=whisper-cli \
    LD_LIBRARY_PATH=/usr/local/lib

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/main.js"]
