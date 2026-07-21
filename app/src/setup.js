/**
 * WishperType — setup / settings window JS
 *
 * Handles:
 *  - Microphone + Accessibility permission checks
 *  - Mic device selector
 *  - Capsule position grid
 *  - Whisper model picker + download progress bar
 *  - Theme swatch picker
 *  - Done button
 */

const { invoke } = window.__TAURI__.core;
const { listen  } = window.__TAURI__.event;

// ── DOM refs ──────────────────────────────────────────────────────
const micStatus  = document.getElementById("micStatus");
const axStatus   = document.getElementById("axStatus");
const micRequest = document.getElementById("micRequest");
const micSettings = document.getElementById("micSettings");
const micRecheck = document.getElementById("micRecheck");
const axRequest  = document.getElementById("axRequest");
const axSettings = document.getElementById("axSettings");
const axRecheck  = document.getElementById("axRecheck");
const doneBtn    = document.getElementById("doneBtn");
const hotkeyLabel = document.getElementById("hotkeyLabel");
const hotkeyDisplay = document.getElementById("hotkeyDisplay");
const hotkeyRecord = document.getElementById("hotkeyRecord");
const hotkeyNote = document.getElementById("hotkeyNote");

// ── State ─────────────────────────────────────────────────────────
let micGranted = false;
let axGranted  = false;
let currentHotkey = "CommandOrControl+Shift+Space";
let recordingHotkey = false;
let lastModifierTap = null;

const IS_MAC = navigator.platform?.toLowerCase().includes("mac");

// ─────────────────────────────────────────────────────────────────
//  Hotkey picker
// ─────────────────────────────────────────────────────────────────
function formatHotkeyLabel(hotkey) {
  if (hotkey.startsWith("DoubleTap+")) {
    const mod = hotkey.slice("DoubleTap+".length);
    const labels = {
      CommandOrControl: IS_MAC ? "⌘ twice" : "Ctrl twice",
      Alt: IS_MAC ? "⌥ twice" : "Alt twice",
      Shift: IS_MAC ? "⇧ twice" : "Shift twice",
    };
    return labels[mod] || hotkey;
  }

  return hotkey.split("+").map((part) => {
    switch (part) {
      case "CommandOrControl":
        return IS_MAC ? "⌘" : "Ctrl";
      case "Control":
        return "Ctrl";
      case "Alt":
        return IS_MAC ? "⌥" : "Alt";
      case "Shift":
        return IS_MAC ? "⇧" : "Shift";
      case "Super":
        return IS_MAC ? "⌘" : "Win";
      case "Space":
        return "Space";
      case "Semicolon":
        return ";";
      case "Comma":
        return ",";
      case "Period":
        return ".";
      default:
        return part;
    }
  }).join(IS_MAC ? "" : "+");
}

function paintHotkey(hotkey) {
  currentHotkey = hotkey;
  const label = formatHotkeyLabel(hotkey);
  hotkeyLabel.textContent = label;
  hotkeyDisplay.textContent = label;
}

async function applyHotkey(hotkey) {
  hotkeyNote.textContent = "";
  hotkeyRecord.disabled = true;
  try {
    await invoke("set_hotkey", { hotkey });
    paintHotkey(hotkey);
    hotkeyNote.textContent = "Shortcut saved.";
  } catch (err) {
    hotkeyNote.textContent = String(err);
  } finally {
    hotkeyRecord.disabled = false;
  }
}

function codeToShortcutKey(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (/^F\d+$/.test(code)) return code;
  const named = {
    Space: "Space",
    Semicolon: "Semicolon",
    Comma: "Comma",
    Period: "Period",
    Quote: "Quote",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Slash: "Slash",
  };
  return named[code] || null;
}

function isModifierCode(code) {
  return [
    "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
    "AltLeft", "AltRight", "MetaLeft", "MetaRight", "OSLeft", "OSRight",
  ].includes(code);
}

function modifierFromCode(code) {
  if (code === "MetaLeft" || code === "MetaRight" || code === "OSLeft" || code === "OSRight") {
    return "CommandOrControl";
  }
  if (code === "ControlLeft" || code === "ControlRight") return "CommandOrControl";
  if (code === "AltLeft" || code === "AltRight") return "Alt";
  if (code === "ShiftLeft" || code === "ShiftRight") return "Shift";
  return null;
}

function eventToHotkey(event) {
  const parts = [];
  if (event.metaKey || event.ctrlKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = codeToShortcutKey(event.code);
  if (!key || isModifierCode(event.code)) return null;
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join("+");
}

function stopHotkeyRecording() {
  if (!recordingHotkey) return;
  recordingHotkey = false;
  lastModifierTap = null;
  window.removeEventListener("keydown", onHotkeyCapture, true);
  window.removeEventListener("keyup", onHotkeyCaptureKeyup, true);
  hotkeyRecord.textContent = "Create your own shortcut…";
  hotkeyRecord.classList.add("primary");
  hotkeyNote.textContent = "";
}

async function onHotkeyCaptureKeyup(event) {
  if (!recordingHotkey) return;
  event.preventDefault();
  event.stopPropagation();

  const mod = modifierFromCode(event.code);
  if (!mod) return;

  const now = Date.now();
  if (lastModifierTap?.mod === mod && now - lastModifierTap.at < 500) {
    stopHotkeyRecording();
    await applyHotkey(`DoubleTap+${mod}`);
    return;
  }

  lastModifierTap = { mod, at: now };
  hotkeyNote.textContent = IS_MAC
    ? "Tap ⌘ again quickly for double-tap, or press ⌘ + another key."
    : "Tap Ctrl again quickly for double-tap, or press Ctrl + another key.";
}

async function onHotkeyCapture(event) {
  if (!recordingHotkey) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.code === "Escape") {
    stopHotkeyRecording();
    hotkeyNote.textContent = "Recording cancelled.";
    return;
  }

  const hotkey = eventToHotkey(event);
  if (!hotkey) {
    if (!isModifierCode(event.code)) {
      hotkeyNote.textContent = "Include Cmd/Ctrl, Alt, or Shift with your key.";
    }
    return;
  }

  stopHotkeyRecording();
  await applyHotkey(hotkey);
}

hotkeyRecord.addEventListener("click", () => {
  if (recordingHotkey) {
    stopHotkeyRecording();
    return;
  }
  recordingHotkey = true;
  lastModifierTap = null;
  hotkeyRecord.textContent = "Press keys… (Esc to cancel)";
  hotkeyRecord.classList.remove("primary");
  hotkeyNote.textContent = IS_MAC
    ? "Double-tap ⌘, or press ⌘ + another key. Esc to cancel."
    : "Double-tap Ctrl, or press Ctrl + another key. Esc to cancel.";
  window.addEventListener("keydown", onHotkeyCapture, true);
  window.addEventListener("keyup", onHotkeyCaptureKeyup, true);
});

// ─────────────────────────────────────────────────────────────────
//  Permission badges
// ─────────────────────────────────────────────────────────────────
function paintBadge(el, granted, unknownText = "Not granted") {
  el.classList.remove("ok", "bad");
  if (granted === true) {
    el.textContent = "Granted";
    el.classList.add("ok");
  } else if (granted === false) {
    el.textContent = unknownText;
    el.classList.add("bad");
  } else {
    el.textContent = "Checking…";
  }
}

function refreshDone() {
  if (micGranted && axGranted) {
    doneBtn.textContent = "Start using WishperType →";
    doneBtn.classList.add("ready");
  } else {
    doneBtn.textContent = "Done";
    doneBtn.classList.remove("ready");
  }
}

// ── Microphone ────────────────────────────────────────────────────
async function probeMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    return true;
  } catch {
    return false;
  }
}

async function checkMic() {
  try {
    if (navigator.permissions?.query) {
      const res = await navigator.permissions.query({ name: "microphone" });
      res.onchange = () => checkMic();
      if (res.state === "granted") {
        micGranted = true;
        paintBadge(micStatus, true);
        micRequest.disabled = true;
        micRequest.textContent = "Granted";
        refreshDone();
        loadMics();
        return;
      }
      if (res.state === "denied") {
        micGranted = false;
        paintBadge(micStatus, false, "Denied");
        micRequest.disabled = false;
        micRequest.textContent = "Grant access";
        refreshDone();
        return;
      }
    }
  } catch { /* permissions API unsupported */ }

  micGranted = await probeMic();
  paintBadge(micStatus, micGranted, "Not granted");
  micRequest.disabled = micGranted;
  micRequest.textContent = micGranted ? "Granted" : "Grant access";
  refreshDone();
  if (micGranted) loadMics();
}

async function checkAx() {
  try {
    axGranted = await invoke("check_accessibility");
  } catch (err) {
    console.error("[WishperType] check_accessibility failed:", err);
    axGranted = false;
  }
  paintBadge(axStatus, axGranted);
  axRequest.disabled = false;
  axRequest.textContent = axGranted ? "Granted" : "Grant access";
  axRecheck.disabled = false;
  axRecheck.textContent = "Re-check";
  refreshDone();
}

// ── Button handlers ───────────────────────────────────────────────
micRequest.addEventListener("click", async () => {
  micRequest.disabled = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    micGranted = true;
    paintBadge(micStatus, true);
    micRequest.textContent = "Granted";
  } catch {
    micGranted = false;
    paintBadge(micStatus, false, "Denied");
    micRequest.textContent = "Grant access";
  }
  micRequest.disabled = micGranted;
  refreshDone();
  if (micGranted) loadMics();
});

micRecheck.addEventListener("click", async () => {
  micRecheck.disabled = true;
  micRecheck.textContent = "Checking…";
  await checkMic();
  micRecheck.disabled = false;
  micRecheck.textContent = "Re-check";
});

axRequest.addEventListener("click", async () => {
  axRequest.disabled = true;
  axRequest.textContent = "Checking…";

  let alreadyGranted = false;
  try {
    alreadyGranted = await invoke("check_accessibility");
  } catch (err) {
    console.error("[WishperType] check_accessibility failed:", err);
  }

  if (alreadyGranted) {
    axGranted = true;
    paintBadge(axStatus, true);
    axRequest.textContent = "Granted";
    axRequest.disabled = false;
    refreshDone();
    return;
  }

  try {
    await invoke("request_accessibility");
  } catch (err) {
    console.error("[WishperType] request_accessibility failed:", err);
  }
  invoke("open_settings", { pane: "accessibility" }).catch(() => {});

  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    let granted = false;
    try {
      granted = await invoke("check_accessibility");
    } catch {
      granted = false;
    }
    if (granted || attempts >= 80) {
      clearInterval(poll);
      axGranted = granted;
      paintBadge(axStatus, granted ? true : false);
      axRequest.textContent = granted ? "Granted" : "Grant access";
      axRequest.disabled = false;
      refreshDone();
    }
  }, 1_500);
});

axRecheck.addEventListener("click", async () => {
  axRecheck.disabled = true;
  axRecheck.textContent = "Checking…";
  await checkAx();
  axRecheck.disabled = false;
  axRecheck.textContent = "Re-check";
});

micSettings.addEventListener("click", () =>
  invoke("open_settings", { pane: "microphone" }));
axSettings.addEventListener("click", () =>
  invoke("open_settings", { pane: "accessibility" }));

// ─────────────────────────────────────────────────────────────────
//  Mic device selector
// ─────────────────────────────────────────────────────────────────
const micSelect = document.getElementById("micSelect");
let selectedMic = "";

async function loadMics() {
  try {
    const devs   = await navigator.mediaDevices.enumerateDevices();
    const inputs = devs.filter(d => d.kind === "audioinput");

    micSelect.innerHTML = '<option value="">System default</option>';
    inputs.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      micSelect.appendChild(opt);
    });

    micSelect.value = selectedMic;
    if (micSelect.value !== selectedMic) {
      micSelect.value = "";
      selectedMic = "";
    }

    // Share list with Rust for the tray dropdown
    invoke("report_mics", {
      devices: inputs.map((d, i) => ({
        id:    d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })),
    }).catch(() => {});
  } catch (err) {
    console.error("enumerateDevices failed:", err);
  }
}

micSelect.addEventListener("change", () => {
  selectedMic = micSelect.value;
  invoke("set_mic", { device: selectedMic });
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", loadMics);
}

// ─────────────────────────────────────────────────────────────────
//  Capsule position grid
// ─────────────────────────────────────────────────────────────────
const posGroup = document.getElementById("posGroup");

const POS_PRESETS = [
  "top-left","top-center","top-right",
  "center-left","center-center","center-right",
  "bottom-left","bottom-center","bottom-right",
];

function normalizePreset(p) {
  const legacy = { top: "top-center", center: "center-center", bottom: "bottom-center" };
  const v = legacy[p] || p;
  return POS_PRESETS.includes(v) ? v : "bottom-center";
}

function markPos(preset) {
  posGroup.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.pos === preset));
}

posGroup.querySelectorAll("button").forEach(btn =>
  btn.addEventListener("click", () => {
    markPos(btn.dataset.pos);
    invoke("set_capsule_position", { preset: btn.dataset.pos });
  })
);

async function loadPos() {
  let preset = "bottom-center";
  try { preset = await invoke("get_capsule_position"); } catch { /* use default */ }
  markPos(normalizePreset(preset));
}

// ─────────────────────────────────────────────────────────────────
//  Backend (remote / local)
// ─────────────────────────────────────────────────────────────────
const backendModeGroup = document.getElementById("backendModeGroup");
const backendUrlInput  = document.getElementById("backendUrl");
const apiKeyInput      = document.getElementById("apiKeyInput");
const backendNote      = document.getElementById("backendNote");

function markBackendMode(mode) {
  const m = mode === "local" ? "local" : "remote";
  backendModeGroup.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === m));
  const remote = m === "remote";
  backendUrlInput.disabled = !remote;
  apiKeyInput.disabled = !remote;
}

backendModeGroup.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    markBackendMode(mode);
    invoke("set_backend_mode", { mode }).catch(() => {});
    backendNote.textContent = mode === "remote"
      ? "Whisper runs on the VPS — Mac stays light."
      : "Local mode spawns Python Whisper on this Mac (high RAM).";
    backendNote.style.color = "";
  });
});

let backendUrlTimer = null;
backendUrlInput.addEventListener("input", () => {
  clearTimeout(backendUrlTimer);
  backendUrlTimer = setTimeout(() => {
    invoke("set_backend_url", { url: backendUrlInput.value.trim() }).catch(() => {});
  }, 400);
});

let apiKeyTimer = null;
apiKeyInput.addEventListener("input", () => {
  clearTimeout(apiKeyTimer);
  apiKeyTimer = setTimeout(() => {
    invoke("set_api_key", { key: apiKeyInput.value }).catch(() => {});
  }, 400);
});

// ─────────────────────────────────────────────────────────────────
//  Model selector + download
// ─────────────────────────────────────────────────────────────────
const modelGroup   = document.getElementById("modelGroup");
const modelNote    = document.getElementById("modelNote");
const progressWrap = document.getElementById("progressWrap");
const progressBar  = document.getElementById("progressBar");

let downloadingModel = null;

function markModel(model) {
  modelGroup.querySelectorAll("button").forEach(b =>
    b.classList.toggle("active", b.dataset.model === model));
}

function setModelBtnsEnabled(enabled) {
  modelGroup.querySelectorAll("button").forEach(b => { b.disabled = !enabled; });
}

function setProgress(pct) {
  progressBar.style.width = `${pct}%`;
  if (pct > 0 && pct < 100) {
    progressWrap.classList.add("visible");
  } else {
    progressWrap.classList.remove("visible");
    progressBar.style.width = "0%";
  }
}

listen("model-progress", async (event) => {
  const { model, pct, done, error } = event.payload;
  if (model !== downloadingModel) return;

  if (error) {
    modelNote.textContent = `⚠ ${error}`;
    modelNote.style.color = "#f87171";
    setProgress(0);
    downloadingModel = null;
    setModelBtnsEnabled(true);
    return;
  }

  // Update progress bar
  setProgress(pct);

  if (done) {
    modelNote.textContent = "✓ Model ready";
    modelNote.style.color = "#4ade80";
    try { await invoke("set_model", { model }); } catch { /* ignore */ }
    downloadingModel = null;
    setModelBtnsEnabled(true);
    setTimeout(() => {
      modelNote.textContent = "";
      modelNote.style.color = "";
      setProgress(0);
    }, 2_500);
    return;
  }

  modelNote.style.color = "";
  if (pct <= 1)      modelNote.textContent = "Starting…";
  else if (pct === 2) modelNote.textContent = "Connecting…";
  else               modelNote.textContent = `Downloading… ${pct}%`;
});

modelGroup.querySelectorAll("button").forEach(btn => {
  btn.addEventListener("click", () => {
    const model = btn.dataset.model;
    if (downloadingModel) return;

    markModel(model);
    downloadingModel  = model;
    modelNote.textContent = "Starting…";
    modelNote.style.color = "";
    setModelBtnsEnabled(false);

    invoke("ensure_model", { model }).catch(err => {
      modelNote.textContent = String(err);
      modelNote.style.color = "#f87171";
      downloadingModel = null;
      setModelBtnsEnabled(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────
//  Theme swatches
// ─────────────────────────────────────────────────────────────────
const themeGroup = document.getElementById("themeGroup");

function markTheme(theme) {
  themeGroup.querySelectorAll(".swatch").forEach(s =>
    s.classList.toggle("active", s.dataset.theme === theme));
}

themeGroup.querySelectorAll(".swatch").forEach(sw =>
  sw.addEventListener("click", () => {
    markTheme(sw.dataset.theme);
    invoke("set_theme", { theme: sw.dataset.theme });
  })
);

// ─────────────────────────────────────────────────────────────────
//  Done button
// ─────────────────────────────────────────────────────────────────
doneBtn.addEventListener("click", () => invoke("finish_setup"));

// Re-check permissions every time the window regains focus
// (user returns from System Settings after granting mic/accessibility)
window.addEventListener("focus", () => {
  checkMic();
  checkAx();
});

// Also poll once a second while the page is visible, to catch
// permission grants made in System Settings without a focus event.
setInterval(() => {
  if (!document.hidden) checkAx();
}, 2_000);

// ─────────────────────────────────────────────────────────────────
//  Load current settings
// ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const s = await invoke("get_settings");
    markModel(s.model     || "medium.en");
    markTheme(s.theme     || "purple");
    selectedMic = s.mic_device || "";
    paintHotkey(s.hotkey || "CommandOrControl+Shift+Space");
    markBackendMode(s.backend_mode || "remote");
    backendUrlInput.value = s.backend_url || "http://127.0.0.1:3003";
    apiKeyInput.value = s.api_key || "";
  } catch {
    markModel("medium.en");
    markTheme("purple");
    selectedMic = "";
    paintHotkey("CommandOrControl+Shift+Space");
    markBackendMode("remote");
    backendUrlInput.value = "http://127.0.0.1:3003";
    apiKeyInput.value = "";
  }
  await loadMics();
}

// ── Init ──────────────────────────────────────────────────────────
checkMic();
checkAx();
loadPos();
loadSettings();
