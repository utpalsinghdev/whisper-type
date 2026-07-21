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
const CHUNK_SAMPLES = 1_024;
const TAIL_MS       = 600;      // extra silence captured after "stop"

// ── Session state ─────────────────────────────────────────────────
let state          = "idle"; // idle | recording | transcribing
let recordedChunks = [];
let audioContext, processor, source, analyser, stream;
let freqData, timeData;
let vizFrame       = null;
let timerInterval  = null;
let elapsedSeconds = 0;

// ── Settings (fetched per session) ────────────────────────────────
let apiBase   = "http://127.0.0.1:3000";
let apiKey    = "";
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

  const w = viz.width;
  const h = viz.height;
  vizCtx.clearRect(0, 0, w, h);

  if (!analyser) return;

  // ── waveform line ──
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

  // ── frequency bars ──
  analyser.getByteFrequencyData(freqData);
  const bars = 28;
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

function mergeRecording() {
  const total  = recordedChunks.reduce((n, c) => n + c.length, 0);
  const merged = new Int16Array(total);
  let offset   = 0;
  for (const chunk of recordedChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
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

// ─────────────────────────────────────────────────────────────────
//  Mic enumeration (reported to Rust for tray dropdown)
// ─────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
//  Transcription
// ─────────────────────────────────────────────────────────────────
async function transcribeRecording() {
  if (recordedChunks.length === 0) return "";

  const pcm  = mergeRecording();
  const form = new FormData();
  form.append("model_name", modelName);
  form.append(
    "files",
    new Blob([pcm.buffer], { type: "application/octet-stream" }),
    "audio.pcm"
  );

  const headers = {};
  if (apiKey) headers["X-API-Key"] = apiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const res = await fetch(`${apiBase}/transcribe_pcm_chunk`, {
      method:  "POST",
      body:    form,
      headers,
      signal:  controller.signal,
    });
    if (!res.ok) throw new Error(`Transcription error (HTTP ${res.status})`);

    const data = await res.json();
    return (data.text || "").trim();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Transcription timed out — try a shorter clip or Tiny model");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────────
//  Session lifecycle
// ─────────────────────────────────────────────────────────────────
async function startSession() {
  if (state !== "idle") return;
  state          = "recording";
  recordedChunks = [];

  // Immediately show recording UI
  setPillState("recording");
  showWaveform();
  stopBtn.classList.remove("hidden");
  startTimer();

  try {
    // Load settings fresh each session
    try {
      const settings = await invoke("get_settings");
      modelName = settings.model     || "base.en";
      micDevice = settings.mic_device || "";
      apiKey    = settings.api_key    || "";
      applyTheme(settings.theme);
    } catch { /* use defaults */ }

    // Ensure server is alive (remote health-check, or spawn local Python)
    await invoke("ensure_server");
    apiBase = await invoke("api_base");
    try { apiKey = await invoke("get_api_key") || apiKey; } catch { /* ignore */ }

    // Open microphone
    const audioConstraint = micDevice ? { deviceId: { exact: micDevice } } : true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
    } catch {
      // Chosen device gone — fall back to system default
      if (micDevice) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } else {
        throw new Error("Microphone unavailable");
      }
    }

    // Enumerate now that we have permission (labels populated)
    reportMics();

    // Audio graph: source → analyser → scriptProcessor → silent gain → destination
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

    processor.onaudioprocess = (e) => {
      if (state !== "recording") return;
      const input = e.inputBuffer.getChannelData(0);
      const down  = downsample(input, audioContext.sampleRate, TARGET_RATE);
      recordedChunks.push(floatTo16BitPCM(down));
    };

    resizeViz();
    startViz();

  } catch (err) {
    console.error("[WishperType] startSession error:", err);
    await abortSession(err.message || "Microphone error");
  }
}

async function finishSession() {
  if (state !== "recording") return;
  state = "transcribing";

  // Stop recording + timer
  stopTimer();
  stopViz();
  teardownAudio();

  // Show transcribing UI
  setPillState("transcribing");
  showDots();
  stopBtn.classList.add("hidden");

  // Brief tail pause so the very last word isn't cut off
  await new Promise(r => setTimeout(r, TAIL_MS));

  try {
    const text = await transcribeRecording();
    if (text) {
      await invoke("paste_text", { text });
    }
  } catch (err) {
    console.error("[WishperType] transcription error:", err);
    showStatus(err.message || "Transcription failed", true);
    setPillState("error-state");
    await new Promise(r => setTimeout(r, 1_200));
  } finally {
    recordedChunks = [];
    state = "idle";
    resetUI();
    await invoke("hide_capsule");
  }
}

async function cancelSession() {
  if (state === "idle") return;
  const wasRecording = state === "recording";
  state = "idle";

  stopTimer();
  stopViz();
  if (wasRecording) teardownAudio();
  recordedChunks = [];

  resetUI();
  await invoke("hide_capsule");
}

async function abortSession(reason) {
  state = "idle";
  stopTimer();
  stopViz();
  teardownAudio();
  recordedChunks = [];

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
    if (state === "recording") resizeViz();
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
