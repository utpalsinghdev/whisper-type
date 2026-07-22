/**
 * WishperType capsule overlay — main.js
 *
 * State machine:
 *   idle → recording → transcribing → idle
 *               ↘ cancelled → idle
 *               ↘ error     → idle
 *
 * WisprFlow-inspired UX:
 *  • Mic SVG turns accent-colored + pulse ring while recording
 *  • Freq-bar waveform during recording
 *  • Amber bouncing dots during transcription
 *  • Elapsed timer beneath waveform
 *  • Enter/Escape keyboard shortcuts
 *  • Graceful fallback if mic unavailable
 */

const { invoke } = window.__TAURI__.core;
const { listen  } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

// ── DOM refs ──────────────────────────────────────────────────────
const pill       = document.getElementById("pill");
const viz        = document.getElementById("viz");
const vizCtx     = viz.getContext("2d");
const dots       = document.getElementById("dots");
const statusText = document.getElementById("statusText");
const timerEl    = document.getElementById("timer");
const stopBtn    = document.getElementById("stopBtn");

// ── Audio constants ───────────────────────────────────────────────
const TARGET_RATE   = 16_000;   // Whisper expects 16 kHz
const CHUNK_SAMPLES = 4_096;    // larger buffer = fewer main-thread audio callbacks
/** Keep mic open this long after Stop so the last words aren't cut off. */
const TAIL_MS       = 400;
/** Upload ~4s windows while speaking; server merges them incrementally. */
const STREAM_FLUSH_SAMPLES = TARGET_RATE * 3;
const STREAM_FLUSH_EVERY_MS = 800;

// ── Session state ─────────────────────────────────────────────────
// idle | recording | trailing (post-stop tail capture) | transcribing
let state = "idle";

/**
 * Three parallel stores (never discard the master until the session ends):
 *  1) masterChunks  — full original PCM
 *  2) uploadedSamples — how far into master we've already sent
 *  3) server-side partial transcript (merged on VPS as windows finish)
 */
let masterChunks = [];
let uploadedSamples = 0;
let streamSessionId = null;
let uploadChain = Promise.resolve();
let streamFlushTimer = null;
let uploading = false; // prevent overlapping encode work on the main thread
let vizTick = 0;

let audioContext, processor, source, analyser, stream;
let freqData, timeData;
let vizFrame       = null;
let timerInterval  = null;
let elapsedSeconds = 0;

// ── Settings (fetched per session) ────────────────────────────────
let apiBase   = "https://whisper.the10x.xyz";
let modelName = "base.en";
let micDevice = "";
let themeKey  = "purple";   // default matches new purple accent

// ─────────────────────────────────────────────────────────────────
//  Theming
// ─────────────────────────────────────────────────────────────────
const THEMES = {
  green:  "#22c55e",
  blue:   "#3b82f6",
  purple: "#a855f7",
  pink:   "#ec4899",
  amber:  "#f59e0b",
};

function applyTheme(key) {
  themeKey = key || "purple";
  pill.dataset.theme = themeKey;
  // CSS [data-theme] overrides handle the rest
}

// ─────────────────────────────────────────────────────────────────
//  UI helpers
// ─────────────────────────────────────────────────────────────────
function setPillState(s) {
  pill.classList.remove("recording", "transcribing", "error-state");
  if (s) pill.classList.add(s);
}

/** Show waveform canvas, hide dots & status text. */
function showWaveform() {
  viz.classList.remove("hidden");
  dots.classList.remove("visible");
  statusText.classList.remove("visible");
}

/** Hide waveform, show amber bouncing dots. */
function showDots() {
  viz.classList.add("hidden");
  dots.classList.add("visible");
  statusText.classList.remove("visible");
}

/** Hide waveform & dots, show a text message. */
function showStatus(msg, isError = false) {
  viz.classList.add("hidden");
  dots.classList.remove("visible");
  statusText.textContent = msg;
  statusText.classList.add("visible");
  if (isError) {
    statusText.style.color = "var(--red)";
  } else {
    statusText.style.color = "";
  }
}

function clearStatus() {
  statusText.classList.remove("visible");
  statusText.textContent = "";
}

function showTimer() {
  timerEl.classList.add("visible");
}

function hideTimer() {
  timerEl.classList.remove("visible");
  timerEl.textContent = "0:00";
  elapsedSeconds = 0;
}

function startTimer() {
  elapsedSeconds = 0;
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    const m = Math.floor(elapsedSeconds / 60);
    const s = String(elapsedSeconds % 60).padStart(2, "0");
    timerEl.textContent = `${m}:${s}`;
  }, 1_000);
  showTimer();
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  hideTimer();
}

// ─────────────────────────────────────────────────────────────────
//  Waveform visualiser
// ─────────────────────────────────────────────────────────────────
function resizeViz() {
  const r = viz.getBoundingClientRect();
  viz.width  = Math.max(1, Math.round(r.width  * devicePixelRatio));
  viz.height = Math.max(1, Math.round(r.height * devicePixelRatio));
}

function startViz() {
  if (vizFrame) return;
  if (viz.width < 2) resizeViz();
  drawViz();
}

function drawViz() {
  vizFrame = requestAnimationFrame(drawViz);
  // Half-rate draw keeps the capsule smooth while ScriptProcessor also runs.
  if ((++vizTick & 1) === 1) return;

  const w = viz.width;
  const h = viz.height;
  vizCtx.clearRect(0, 0, w, h);

  if (!analyser) return;

  analyser.getByteTimeDomainData(timeData);
  const accentColor = getComputedStyle(pill).getPropertyValue("--accent").trim()
    || THEMES[themeKey] || "#a855f7";

  vizCtx.lineWidth   = 1.5 * devicePixelRatio;
  vizCtx.strokeStyle = accentColor;
  vizCtx.beginPath();
  const sliceW = w / timeData.length;
  for (let i = 0; i < timeData.length; i++) {
    const y = (timeData[i] / 255) * h;
    const x = i * sliceW;
    if (i === 0) vizCtx.moveTo(x, y);
    else         vizCtx.lineTo(x, y);
  }
  vizCtx.stroke();

  analyser.getByteFrequencyData(freqData);
  const bars = 24;
  const gap  = 2 * devicePixelRatio;
  const barW = (w - gap * (bars - 1)) / bars;
  const step = Math.max(1, Math.floor(freqData.length / bars));

  for (let i = 0; i < bars; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += freqData[i * step + j];
    const avg  = sum / step / 255;
    const barH = Math.max(2 * devicePixelRatio, avg * h * 0.65);
    const x    = i * (barW + gap);
    vizCtx.globalAlpha = 0.18 + avg * 0.55;
    vizCtx.fillStyle   = accentColor;
    vizCtx.fillRect(x, h - barH, barW, barH);
  }
  vizCtx.globalAlpha = 1;
}

function stopViz() {
  if (vizFrame) cancelAnimationFrame(vizFrame);
  vizFrame = null;
  vizCtx.clearRect(0, 0, viz.width, viz.height);
}

// ─────────────────────────────────────────────────────────────────
//  Audio helpers
// ─────────────────────────────────────────────────────────────────
function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i]  = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(buf, fromRate, toRate) {
  if (fromRate === toRate) return buf;
  const ratio = fromRate / toRate;
  const len   = Math.round(buf.length / ratio);
  const out   = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = buf[Math.floor(i * ratio)];
  return out;
}

function masterSampleCount() {
  return masterChunks.reduce((n, c) => n + c.length, 0);
}

/** Slice [start, end) samples from the master store without mutating it. */
function sliceMaster(start, end) {
  const len = Math.max(0, end - start);
  const out = new Int16Array(len);
  if (!len) return out;

  let cursor = 0;
  let wrote = 0;
  for (const chunk of masterChunks) {
    const next = cursor + chunk.length;
    if (next <= start) {
      cursor = next;
      continue;
    }
    if (cursor >= end) break;
    const from = Math.max(0, start - cursor);
    const to = Math.min(chunk.length, end - cursor);
    out.set(chunk.subarray(from, to), wrote);
    wrote += to - from;
    cursor = next;
  }
  return out;
}

/** Encode Int16 PCM as base64 without building a giant number[] for IPC. */
function int16ToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const step = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

function stopStreamFlushTimer() {
  if (streamFlushTimer) {
    clearInterval(streamFlushTimer);
    streamFlushTimer = null;
  }
}

/**
 * Upload complete windows from the master cursor.
 * force=true also uploads a short remainder (used on Stop).
 */
function scheduleUploads(force = false) {
  if (!streamSessionId || uploading) return;

  const total = masterSampleCount();
  const available = total - uploadedSamples;
  if (!force && available < STREAM_FLUSH_SAMPLES) return;
  if (available <= 0) return;

  uploading = true;
  const sessionId = streamSessionId;

  const pump = async () => {
    try {
      while (streamSessionId === sessionId) {
        const totalNow = masterSampleCount();
        const avail = totalNow - uploadedSamples;
        if (avail <= 0) break;

        let size;
        if (force) {
          size = avail;
        } else if (avail >= STREAM_FLUSH_SAMPLES) {
          size = STREAM_FLUSH_SAMPLES;
        } else {
          break;
        }

        const start = uploadedSamples;
        const end = start + size;
        uploadedSamples = end;

        const pcm = sliceMaster(start, end);
        // Yield so waveform RAF can run between encode bursts.
        await new Promise((r) => setTimeout(r, 0));
        const pcmB64 = int16ToBase64(pcm);
        await invoke("stream_chunk", { sessionId, pcmB64 });

        if (!force) break; // one window per timer tick keeps UI light
      }
    } catch (err) {
      console.warn("[WishperType] stream_chunk failed:", err);
    } finally {
      uploading = false;
    }
  };

  uploadChain = uploadChain.then(pump, pump);
}

function startStreamFlushTimer() {
  stopStreamFlushTimer();
  streamFlushTimer = setInterval(() => {
    if (state === "recording" || state === "trailing") scheduleUploads(false);
  }, STREAM_FLUSH_EVERY_MS);
}

function teardownAudio() {
  processor?.disconnect(); processor = null;
  analyser?.disconnect();  analyser  = null;
  source?.disconnect();    source    = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if (audioContext) { audioContext.close(); audioContext = null; }
  freqData = null;
  timeData = null;
}

async function reportMics() {
  try {
    const devs   = await navigator.mediaDevices.enumerateDevices();
    const inputs = devs.filter(d => d.kind === "audioinput");
    await invoke("report_mics", {
      devices: inputs.map((d, i) => ({
        id:    d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })),
    });
  } catch { /* ignore */ }
}

async function batchTranscribeMaster() {
  const total = masterSampleCount();
  if (!total) return "";
  const pcm = sliceMaster(0, total);
  const bytes = Array.from(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const text = await invoke("transcribe_pcm", { pcm: bytes, modelName });
  return (text || "").trim();
}

async function finalizeStreamOrBatch() {
  if (streamSessionId) {
    const sessionId = streamSessionId;
    try {
      // Drain any in-flight upload, then send every remaining master sample.
      while (uploading) {
        await new Promise((r) => setTimeout(r, 40));
      }
      scheduleUploads(true);
      await uploadChain;
      while (uploading) {
        await new Promise((r) => setTimeout(r, 40));
      }
      if (masterSampleCount() > uploadedSamples) {
        scheduleUploads(true);
        await uploadChain;
      }

      streamSessionId = null;
      const text = await invoke("stream_end", { sessionId });
      return (text || "").trim();
    } catch (err) {
      console.warn("[WishperType] stream finalize failed, falling back to batch:", err);
      streamSessionId = null;
    }
  }

  try {
    return await batchTranscribeMaster();
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/timed?\s*out|timeout/i.test(msg)) {
      throw new Error("Transcription timed out — try a shorter clip or a smaller model");
    }
    throw err instanceof Error ? err : new Error(msg || "Transcription failed");
  }
}

function resetStreamState() {
  stopStreamFlushTimer();
  masterChunks = [];
  uploadedSamples = 0;
  streamSessionId = null;
  uploadChain = Promise.resolve();
  uploading = false;
}

// ─────────────────────────────────────────────────────────────────
//  Session lifecycle
// ─────────────────────────────────────────────────────────────────
async function startSession() {
  if (state !== "idle") return;
  state = "recording";
  resetStreamState();
  uploadChain = Promise.resolve();

  setPillState("recording");
  showWaveform();
  stopBtn.classList.remove("hidden");
  startTimer();

  try {
    try {
      const settings = await invoke("get_settings");
      modelName = settings.model     || "base.en";
      micDevice = settings.mic_device || "";
      applyTheme(settings.theme);
    } catch { /* use defaults */ }

    const audioConstraint = micDevice ? { deviceId: { exact: micDevice } } : true;
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: audioConstraint,
      video: false,
    }).catch(async () => {
      if (!micDevice) throw new Error("Microphone unavailable");
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    });

    const setupPromise = (async () => {
      try { await invoke("ensure_server"); } catch { /* ignore */ }
      try { apiBase = await invoke("api_base"); } catch { /* ignore */ }
      try {
        streamSessionId = await invoke("stream_start", { modelName });
      } catch (err) {
        console.warn("[WishperType] stream_start failed; will batch on stop:", err);
        streamSessionId = null;
      }
    })();

    stream = await micPromise;
    await setupPromise;

    reportMics();

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();

    source   = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize               = 2048;
    analyser.smoothingTimeConstant = 0.75;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);

    processor = audioContext.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
    const silent  = audioContext.createGain();
    silent.gain.value = 0;

    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(silent);
    silent.connect(audioContext.destination);

    // Tiny callback: append to master only. Never network / encode here.
    processor.onaudioprocess = (e) => {
      if (state !== "recording" && state !== "trailing") return;
      const input = e.inputBuffer.getChannelData(0);
      const down  = downsample(input, audioContext.sampleRate, TARGET_RATE);
      masterChunks.push(floatTo16BitPCM(down));
    };

    startStreamFlushTimer();
    resizeViz();
    startViz();

  } catch (err) {
    console.error("[WishperType] startSession error:", err);
    await abortSession(err.message || "Microphone error");
  }
}

async function finishSession() {
  if (state !== "recording") return;

  // 1) Keep capturing a short tail so the last words aren't truncated.
  state = "trailing";
  stopStreamFlushTimer();
  stopBtn.classList.add("hidden");
  setPillState("transcribing");
  showDots();
  stopTimer();

  await new Promise((r) => setTimeout(r, TAIL_MS));

  // 2) Now stop the mic for real and finalize uploads + merge.
  state = "transcribing";
  stopViz();
  teardownAudio();

  try {
    const text = await finalizeStreamOrBatch();
    if (text) {
      await invoke("paste_text", { text });
    }
  } catch (err) {
    console.error("[WishperType] transcription error:", err);
    showStatus(err.message || "Transcription failed", true);
    setPillState("error-state");
    await new Promise(r => setTimeout(r, 1_200));
  } finally {
    resetStreamState();
    state = "idle";
    resetUI();
    await invoke("hide_capsule");
  }
}

async function cancelSession() {
  if (state === "idle") return;
  const hadAudio = state === "recording" || state === "trailing";
  state = "idle";

  stopTimer();
  stopViz();
  if (hadAudio) teardownAudio();

  const id = streamSessionId;
  resetStreamState();
  if (id) invoke("stream_end", { sessionId: id }).catch(() => {});

  resetUI();
  await invoke("hide_capsule");
}

async function abortSession(reason) {
  state = "idle";
  stopTimer();
  stopViz();
  teardownAudio();

  const id = streamSessionId;
  resetStreamState();
  if (id) invoke("stream_end", { sessionId: id }).catch(() => {});

  setPillState("error-state");
  showStatus(reason || "Error", true);
  stopBtn.classList.add("hidden");

  await new Promise(r => setTimeout(r, 1_400));
  resetUI();
  await invoke("hide_capsule");
}

function resetUI() {
  setPillState(null);
  showWaveform();
  clearStatus();
  stopBtn.classList.add("hidden");
  hideTimer();
  dots.classList.remove("visible");
  vizCtx.clearRect(0, 0, viz.width, viz.height);
}

// ─────────────────────────────────────────────────────────────────
//  Input handlers
// ─────────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (state === "recording") finishSession();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Return") {
    e.preventDefault();
    if (state === "recording") finishSession();
  }
  if (e.key === "Escape") {
    e.preventDefault();
    cancelSession();
  }
});

// ─────────────────────────────────────────────────────────────────
//  Tauri event listeners
// ─────────────────────────────────────────────────────────────────
await listen("session-start", () => startSession());
await listen("session-stop",  () => finishSession());
await listen("theme-changed", (ev) => applyTheme(String(ev.payload)));
await listen("server-error",  async (ev) => {
  await abortSession(String(ev.payload));
});

// ─────────────────────────────────────────────────────────────────
//  Resize
// ─────────────────────────────────────────────────────────────────
try {
  getCurrentWindow().onResized(() => {
    if (state === "recording" || state === "trailing") resizeViz();
  });
} catch { /* unavailable in some builds */ }

// ─────────────────────────────────────────────────────────────────
//  Boot: load current settings & mic list
// ─────────────────────────────────────────────────────────────────
try {
  apiBase = await invoke("api_base");
} catch { /* server not ready yet, will be fetched per-session */ }

try {
  const settings = await invoke("get_settings");
  modelName = settings.model     || "base.en";
  micDevice  = settings.mic_device || "";
  applyTheme(settings.theme);
} catch {
  applyTheme("purple");
}

reportMics();
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", reportMics);
}
