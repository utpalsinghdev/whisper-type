use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use arboard::Clipboard;
use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const API_PORT: u16 = 19527;
/// Set when the user chooses Quit so ExitRequested is allowed through.
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);
/// Seconds of idle time before the Python/Whisper process is stopped to free RAM.
const SERVER_IDLE_SECS: u64 = 30;
/// Bumped when dictation restarts or a new idle timer is scheduled (invalidates older timers).
static SERVER_IDLE_GEN: AtomicU64 = AtomicU64::new(0);
/// Stop signal for the double-tap hotkey polling thread.
static HOTKEY_POLL_STOP: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

pub struct AppState {
    pub recording: Mutex<bool>,
    pub server: Mutex<Option<Child>>,
    pub positioning: AtomicBool,
    /// True when this app instance spawned the transcription server child.
    pub server_managed: AtomicBool,
    /// True when using a pre-existing server (e.g. Docker) that we must not kill.
    pub server_external: AtomicBool,
    /// PID of the app that was frontmost when recording started, so we can
    /// return focus to it before pasting.
    pub prev_pid: Mutex<Option<i32>>,
    /// Audio input devices reported by the webview (only it can enumerate them),
    /// cached so the menu-bar dropdown can list microphones.
    pub mics: Mutex<Vec<MicDevice>>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct MicDevice {
    pub id: String,
    pub label: String,
}

#[cfg(target_os = "macos")]
fn frontmost_pid() -> Option<i32> {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    let app = ws.frontmostApplication()?;
    Some(app.processIdentifier())
}

#[cfg(target_os = "macos")]
fn activate_pid(pid: i32) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct CapsuleConfig {
    /// "top" | "center" | "bottom" | "custom"
    preset: String,
    x: Option<i32>,
    y: Option<i32>,
}

impl Default for CapsuleConfig {
    fn default() -> Self {
        Self {
            preset: "bottom-center".into(),
            x: None,
            y: None,
        }
    }
}

/// Split a preset like "top-right" into (vertical, horizontal) anchors,
/// mapping legacy single-word presets ("top"/"center"/"bottom") to centered.
fn preset_anchors(preset: &str) -> (&'static str, &'static str) {
    let (v, h) = match preset {
        "top" => ("top", "center"),
        "center" => ("center", "center"),
        "bottom" => ("bottom", "center"),
        other => {
            let mut parts = other.split('-');
            (parts.next().unwrap_or("bottom"), parts.next().unwrap_or("center"))
        }
    };
    let vert = match v {
        "top" => "top",
        "center" | "middle" => "center",
        _ => "bottom",
    };
    let horiz = match h {
        "left" => "left",
        "right" => "right",
        _ => "center",
    };
    (vert, horiz)
}

fn config_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn config_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("capsule.json")
}

fn default_hotkey() -> String {
    "CommandOrControl+Shift+Space".into()
}

fn default_hotkey_enabled() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
struct AppSettings {
    /// Whisper model name without extension, e.g. "tiny.en", "base.en", "small.en".
    model: String,
    /// Accent theme key, e.g. "green", "blue", "purple", "pink", "amber".
    theme: String,
    /// Preferred microphone deviceId ("" = system default).
    #[serde(default)]
    mic_device: String,
    /// Global dictation shortcut, e.g. "CommandOrControl+Shift+Space".
    #[serde(default = "default_hotkey")]
    hotkey: String,
    /// When false, global hotkey listeners are unregistered.
    #[serde(default = "default_hotkey_enabled")]
    hotkey_enabled: bool,
    /// False until the user dismisses first-run setup ("Done").
    #[serde(default)]
    setup_complete: bool,
    /// "remote" (VPS / Docker NestJS) or "local" (spawn Python on this machine).
    #[serde(default = "default_backend_mode")]
    backend_mode: String,
    /// Base URL for the remote NestJS backend, e.g. "https://whisper.the10x.xyz".
    #[serde(default = "default_backend_url")]
    backend_url: String,
    /// Optional shared secret sent as X-API-Key.
    #[serde(default)]
    api_key: String,
}

fn default_backend_mode() -> String {
    "remote".into()
}

fn default_backend_url() -> String {
    "https://whisper.the10x.xyz".into()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            model: "base.en".into(),
            theme: "green".into(),
            mic_device: String::new(),
            hotkey: default_hotkey(),
            hotkey_enabled: true,
            setup_complete: false,
            backend_mode: default_backend_mode(),
            backend_url: default_backend_url(),
            api_key: String::new(),
        }
    }
}

fn using_remote_backend(settings: &AppSettings) -> bool {
    settings.backend_mode != "local"
}

fn settings_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("settings.json")
}

fn load_settings(app: &AppHandle) -> AppSettings {
    let path = settings_path(app);
    let Ok(raw) = fs::read_to_string(&path) else {
        return AppSettings::default();
    };
    let mut settings: AppSettings = serde_json::from_str(&raw).unwrap_or_default();
    // Older installs had a settings file but no setup_complete flag — treat as done
    // so the settings window does not pop up every launch.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
        if v.get("setup_complete").is_none() {
            settings.setup_complete = true;
            save_settings(app, &settings);
        }
    }
    settings
}

fn save_settings(app: &AppHandle, settings: &AppSettings) {
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = fs::write(settings_path(app), json);
    }
}

fn load_capsule_config(app: &AppHandle) -> CapsuleConfig {
    let path = config_path(app);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_capsule_config(app: &AppHandle, cfg: &CapsuleConfig) {
    let path = config_path(app);
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = fs::write(path, json);
    }
}

fn position_capsule(window: &WebviewWindow, cfg: &CapsuleConfig) {
    // Custom position from a previous drag.
    if cfg.preset == "custom" {
        if let (Some(x), Some(y)) = (cfg.x, cfg.y) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }

    let monitor = match window.current_monitor().ok().flatten() {
        Some(m) => m,
        None => {
            let _ = window.center();
            return;
        }
    };

    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let win_size = match window.outer_size() {
        Ok(s) => s,
        Err(_) => {
            let _ = window.center();
            return;
        }
    };

    let scale = monitor.scale_factor();
    let margin = (48.0 * scale) as i32;
    let win_w = win_size.width as i32;
    let win_h = win_size.height as i32;
    let mon_w = mon_size.width as i32;
    let mon_h = mon_size.height as i32;

    let (vert, horiz) = preset_anchors(&cfg.preset);
    let x = match horiz {
        "left" => mon_pos.x + margin,
        "right" => mon_pos.x + mon_w - win_w - margin,
        _ => mon_pos.x + ((mon_w - win_w) / 2),
    };
    let y = match vert {
        "top" => mon_pos.y + margin,
        "center" => mon_pos.y + ((mon_h - win_h) / 2),
        _ => mon_pos.y + mon_h - win_h - margin,
    };

    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn python_binary(root: &PathBuf) -> PathBuf {
    let venv = root.join(".venv/bin/python3");
    if venv.is_file() {
        return venv;
    }
    PathBuf::from("python3")
}

fn http_healthy(url: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client.get(url).send().map(|r| r.status().is_success()).unwrap_or(false)
}

fn server_healthy() -> bool {
    let url = format!("http://127.0.0.1:{API_PORT}/health");
    http_healthy(&url)
}

fn remote_backend_healthy(base: &str) -> bool {
    let base = base.trim_end_matches('/');
    http_healthy(&format!("{base}/health"))
}

fn process_command(pid: i32) -> Option<String> {
    if pid as u32 == std::process::id() {
        return None;
    }
    #[cfg(unix)]
    {
        let out = Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .arg("-o")
            .arg("command=")
            .output()
            .ok()?;
        let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if cmd.is_empty() {
            None
        } else {
            Some(cmd)
        }
    }
    #[cfg(windows)]
    {
        let out = Command::new("wmic")
            .args([
                "process",
                "where",
                &format!("ProcessId={pid}"),
                "get",
                "CommandLine",
                "/value",
            ])
            .output()
            .ok()?;
        let cmd = String::from_utf8_lossy(&out.stdout);
        let line = cmd
            .lines()
            .find_map(|l| l.strip_prefix("CommandLine="))
            .unwrap_or("")
            .trim()
            .to_string();
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    }
}

fn is_wishpertype_server_pid(pid: i32) -> bool {
    process_command(pid).is_some_and(|cmd| {
        cmd.contains("uvicorn") && (cmd.contains("poc.serve") || cmd.contains("wispertype"))
    })
}

fn pids_on_port(port: u16) -> Vec<i32> {
    let mut pids = Vec::new();
    #[cfg(unix)]
    if let Ok(out) = Command::new("lsof")
        .args(["-ti", &format!(":{port}")])
        .output()
    {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Ok(pid) = line.trim().parse::<i32>() {
                pids.push(pid);
            }
        }
    }
    #[cfg(windows)]
    if let Ok(out) = Command::new("netstat").args(["-ano"]).output() {
        let needle = format!(":{port}");
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if line.contains(&needle) && line.contains("LISTENING") {
                if let Some(pid_str) = line.split_whitespace().last() {
                    if let Ok(pid) = pid_str.parse::<i32>() {
                        pids.push(pid);
                    }
                }
            }
        }
    }
    pids
}

fn kill_wishper_servers_on_port(port: u16) -> bool {
    let mut killed = false;
    for pid in pids_on_port(port) {
        if is_wishpertype_server_pid(pid) {
            eprintln!("WishperType: killing transcription server (pid {pid})");
            #[cfg(unix)]
            {
                let _ = Command::new("kill").arg(pid.to_string()).status();
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .status();
            }
            killed = true;
        }
    }
    killed
}

fn wait_server_stopped(max_ms: u64) -> bool {
    let steps = max_ms / 200;
    for _ in 0..steps {
        if !server_healthy() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    !server_healthy()
}

fn child_running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(_) => false,
    }
}

fn stop_server_child(guard: &mut Option<Child>) -> bool {
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        true
    } else {
        false
    }
}

fn stop_transcription_server(state: &State<AppState>) {
    if let Ok(mut guard) = state.server.lock() {
        stop_server_child(&mut guard);
    }
    state.server_managed.store(false, Ordering::SeqCst);
}

fn stop_transcription_server_idle(state: &State<AppState>) -> bool {
    if state.server_external.load(Ordering::SeqCst) {
        eprintln!(
            "WishperType: idle timeout — external server on port {API_PORT} (e.g. Docker; app does not free its RAM)"
        );
        return false;
    }

    let managed = state.server_managed.load(Ordering::SeqCst);
    let mut killed = false;

    if let Ok(mut guard) = state.server.lock() {
        killed = stop_server_child(&mut guard);
    }

    if (managed || server_healthy()) && server_healthy() {
        killed = kill_wishper_servers_on_port(API_PORT) || killed;
    }

    if !killed && !managed {
        return false;
    }

    state.server_managed.store(false, Ordering::SeqCst);
    let stopped = wait_server_stopped(4_000);
    if stopped {
        eprintln!("WishperType: stopped idle transcription server (freeing RAM) — confirmed");
    } else {
        eprintln!(
            "WishperType: stopped idle transcription server (freeing RAM) — warning: port {API_PORT} still responding"
        );
    }
    true
}

fn cancel_scheduled_server_stop() {
    SERVER_IDLE_GEN.fetch_add(1, Ordering::SeqCst);
}

fn shutdown_app(app: &AppHandle) {
    stop_hotkey_poll_listener();
    if let Some(state) = app.try_state::<AppState>() {
        stop_transcription_server(&state);
    }
}

fn stop_hotkey_poll_listener() {
    if let Ok(mut guard) = HOTKEY_POLL_STOP.lock() {
        if let Some(flag) = guard.take() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn start_double_tap_listener(app: &AppHandle, modifier: &str) -> Result<(), String> {
    use device_query::{DeviceQuery, DeviceState, Keycode};

    let watch: Vec<Keycode> = match modifier {
        "CommandOrControl" => {
            #[cfg(target_os = "macos")]
            {
                vec![Keycode::LMeta, Keycode::RMeta]
            }
            #[cfg(not(target_os = "macos"))]
            {
                vec![Keycode::LControl, Keycode::RControl]
            }
        }
        "Alt" => vec![Keycode::LAlt, Keycode::RAlt],
        "Shift" => vec![Keycode::LShift, Keycode::RShift],
        _ => return Err(format!("Unknown double-tap modifier: {modifier}")),
    };

    stop_hotkey_poll_listener();
    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = HOTKEY_POLL_STOP.lock() {
        *guard = Some(stop.clone());
    }

    let handle = app.clone();
    thread::spawn(move || {
        let device_state = DeviceState::new();
        let mut was_down = false;
        let mut last_tap: Option<Instant> = None;

        while !stop.load(Ordering::Relaxed) {
            let keys = device_state.get_keys();
            let down = keys.iter().any(|k| watch.contains(k));

            if down && !was_down {
                let now = Instant::now();
                if let Some(prev) = last_tap {
                    if now.duration_since(prev) < Duration::from_millis(500) {
                        last_tap = None;
                        if let Some(state) = handle.try_state::<AppState>() {
                            toggle_recording(&handle, &state);
                        }
                        thread::sleep(Duration::from_millis(350));
                    } else {
                        last_tap = Some(now);
                    }
                } else {
                    last_tap = Some(now);
                }
            }

            was_down = down;
            thread::sleep(Duration::from_millis(20));
        }
    });

    eprintln!("WishperType: registered double-tap {modifier}");
    Ok(())
}

/// Stop the Python server after idle time so Whisper/PyTorch release ~2–3 GB RAM.
fn schedule_server_stop(app: AppHandle) {
    let should_schedule = app
        .try_state::<AppState>()
        .map(|state| {
            state.server_managed.load(Ordering::SeqCst)
                || state.server_external.load(Ordering::SeqCst)
                || state.server.lock().map(|g| g.is_some()).unwrap_or(false)
                || server_healthy()
        })
        .unwrap_or(false);

    if !should_schedule {
        return;
    }

    let gen = SERVER_IDLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    eprintln!(
        "WishperType: will stop transcription server in {SERVER_IDLE_SECS}s to free RAM (if still idle)"
    );
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(SERVER_IDLE_SECS));
        if SERVER_IDLE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let recording = match state.recording.lock() {
            Ok(g) => *g,
            Err(_) => return,
        };
        if recording {
            eprintln!("WishperType: RAM cleanup deferred (dictation active)");
            return;
        }
        if stop_transcription_server_idle(&state) {
            return;
        }
        if server_healthy() {
            eprintln!(
                "WishperType: idle timeout reached; transcription server still running on port {API_PORT}"
            );
        } else {
            eprintln!("WishperType: idle timeout reached; transcription server already stopped");
        }
    });
}

fn model_ready(root: &PathBuf) -> bool {
    root.join("backend/wispertype/models/base.en.pt").is_file()
}

fn bootstrap_model(root: &PathBuf, python: &PathBuf) -> Result<(), String> {
    if model_ready(root) {
        return Ok(());
    }

    eprintln!("WishperType: downloading Whisper model (first run)...");
    let backend = root.join("backend");
    let pythonpath = format!("{}:{}", backend.display(), root.display());
    let status = Command::new(python)
        .env("PYTHONPATH", pythonpath)
        .current_dir(root)
        .args(["poc/bootstrap_model.py"])
        .status()
        .map_err(|e| e.to_string())?;

    if !status.success() || !model_ready(root) {
        return Err("Failed to install Whisper model. Run: python poc/bootstrap_model.py".into());
    }
    Ok(())
}

fn spawn_transcription_server(app: &AppHandle, state: &State<AppState>) -> Result<(), String> {
    let settings = load_settings(app);
    if using_remote_backend(&settings) {
        let base = settings.backend_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err("Remote backend URL is empty — set it in Settings".into());
        }
        // Do not spawn local Python/Whisper — frees Mac RAM.
        state.server_managed.store(false, Ordering::SeqCst);
        state.server_external.store(true, Ordering::SeqCst);
        if remote_backend_healthy(base) {
            return Ok(());
        }
        return Err(format!(
            "Remote backend not reachable at {base}/health — is Docker/VPS running?"
        ));
    }

    let mut guard = state.server.lock().map_err(|e| e.to_string())?;

    if let Some(child) = guard.as_mut() {
        if child_running(child) {
            if server_healthy() {
                state.server_managed.store(true, Ordering::SeqCst);
                state.server_external.store(false, Ordering::SeqCst);
                return Ok(());
            }
            for _ in 0..40 {
                if server_healthy() {
                    state.server_managed.store(true, Ordering::SeqCst);
                    state.server_external.store(false, Ordering::SeqCst);
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(250));
            }
            stop_server_child(&mut guard);
            state.server_managed.store(false, Ordering::SeqCst);
            return Err("Transcription server failed to start".into());
        }
        stop_server_child(&mut guard);
        state.server_managed.store(false, Ordering::SeqCst);
    }

    if server_healthy() {
        if kill_wishper_servers_on_port(API_PORT) {
            eprintln!("WishperType: stopped orphan transcription server on port {API_PORT}");
            let _ = wait_server_stopped(5_000);
        }
        if server_healthy() {
            state.server_external.store(true, Ordering::SeqCst);
            state.server_managed.store(false, Ordering::SeqCst);
            eprintln!("WishperType: using external transcription server on port {API_PORT}");
            return Ok(());
        }
    }

    let root = repo_root();
    let python = python_binary(&root);
    bootstrap_model(&root, &python)?;

    let settings = load_settings(app);
    let model_file = format!("{}.pt", settings.model);
    let backend = root.join("backend");
    let pythonpath = format!("{}:{}", backend.display(), root.display());

    let child = Command::new(&python)
        .env("PYTHONPATH", pythonpath)
        .env("WT_MODEL", &model_file)
        .env("OMP_NUM_THREADS", "4")
        .env("MKL_NUM_THREADS", "4")
        .current_dir(&root)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .args([
            "-m",
            "uvicorn",
            "poc.serve:app",
            "--host",
            "127.0.0.1",
            "--port",
            &API_PORT.to_string(),
        ])
        .spawn()
        .map_err(|e| format!("Failed to start server with {}: {e}", python.display()))?;

    let pid = child.id();
    *guard = Some(child);
    state.server_managed.store(true, Ordering::SeqCst);
    state.server_external.store(false, Ordering::SeqCst);
    eprintln!("WishperType: started local transcription server (pid {pid})");

    // First request loads the Whisper model — allow up to 90s on CPU.
    for _ in 0..180 {
        if server_healthy() {
            return Ok(());
        }
        if let Some(child) = guard.as_mut() {
            if !child_running(child) {
                stop_server_child(&mut guard);
                return Err("Transcription server exited during startup".into());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }

    stop_server_child(&mut guard);
    Err("Transcription server did not become ready".into())
}

#[tauri::command]
fn api_base(app: AppHandle) -> String {
    let settings = load_settings(&app);
    if using_remote_backend(&settings) {
        settings.backend_url.trim().trim_end_matches('/').to_string()
    } else {
        format!("http://127.0.0.1:{API_PORT}")
    }
}

#[tauri::command]
fn get_api_key(app: AppHandle) -> String {
    load_settings(&app).api_key
}

#[tauri::command]
fn set_backend_mode(app: AppHandle, mode: String) {
    let mut settings = load_settings(&app);
    settings.backend_mode = if mode == "local" {
        "local".into()
    } else {
        "remote".into()
    };
    save_settings(&app, &settings);
    if using_remote_backend(&settings) {
        if let Some(state) = app.try_state::<AppState>() {
            stop_transcription_server(&state);
        }
    }
}

#[tauri::command]
fn set_backend_url(app: AppHandle, url: String) {
    let mut settings = load_settings(&app);
    settings.backend_url = url.trim().trim_end_matches('/').to_string();
    save_settings(&app, &settings);
}

#[tauri::command]
fn set_api_key(app: AppHandle, key: String) {
    let mut settings = load_settings(&app);
    settings.api_key = key;
    save_settings(&app, &settings);
}

/// Upload PCM from Rust so the desktop app is not blocked by browser CORS.
#[tauri::command]
fn transcribe_pcm(app: AppHandle, pcm: Vec<u8>, model_name: Option<String>) -> Result<String, String> {
    if pcm.is_empty() {
        return Ok(String::new());
    }

    let settings = load_settings(&app);
    let base = api_base_from_settings(&settings);
    let model = model_name
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| settings.model.clone());

    let url = format!("{base}/transcribe_pcm_chunk");
    let part = reqwest::blocking::multipart::Part::bytes(pcm)
        .file_name("audio.pcm")
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("model_name", model)
        .part("files", part);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.post(&url).multipart(form);
    if !settings.api_key.is_empty() {
        req = req.header("X-API-Key", &settings.api_key);
    }

    let res = req.send().map_err(|e| format!("Transcription request failed: {e}"))?;
    let status = res.status();
    let body = res.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Transcription error (HTTP {status}): {body}"));
    }

    let data: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad transcription response: {e}"))?;
    Ok(data
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

fn api_base_from_settings(settings: &AppSettings) -> String {
    if using_remote_backend(settings) {
        settings.backend_url.trim().trim_end_matches('/').to_string()
    } else {
        format!("http://127.0.0.1:{API_PORT}")
    }
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())
}

/// Begin a live streaming transcription session on the Nest backend.
#[tauri::command]
fn stream_start(app: AppHandle, model_name: Option<String>) -> Result<String, String> {
    let settings = load_settings(&app);
    let base = api_base_from_settings(&settings);
    let model = model_name
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| settings.model.clone());
    let url = format!("{base}/transcribe_stream/start");
    let client = http_client()?;
    let mut req = client.post(&url).json(&serde_json::json!({ "model_name": model }));
    if !settings.api_key.is_empty() {
        req = req.header("X-API-Key", &settings.api_key);
    }
    let res = req.send().map_err(|e| format!("stream_start failed: {e}"))?;
    let status = res.status();
    let body = res.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("stream_start HTTP {status}: {body}"));
    }
    let data: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad stream_start response: {e}"))?;
    data.get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("stream_start missing sessionId: {body}"))
}

/// Push a PCM chunk while the user is still speaking.
/// `pcm_b64` is base64 of raw int16 LE PCM — avoids huge JSON number arrays in IPC.
#[tauri::command]
fn stream_chunk(app: AppHandle, session_id: String, pcm_b64: String) -> Result<(), String> {
    use base64::Engine;
    if pcm_b64.is_empty() {
        return Ok(());
    }
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64.as_bytes())
        .map_err(|e| format!("bad pcm base64: {e}"))?;
    if pcm.is_empty() {
        return Ok(());
    }

    let settings = load_settings(&app);
    let base = api_base_from_settings(&settings);
    let url = format!("{base}/transcribe_stream/chunk");
    let part = reqwest::blocking::multipart::Part::bytes(pcm)
        .file_name("chunk.pcm")
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("session_id", session_id)
        .part("files", part);

    // Uploads are fast now (server buffers only). Keep timeout short so a stall
    // cannot freeze the desktop IPC for minutes.
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).multipart(form);
    if !settings.api_key.is_empty() {
        req = req.header("X-API-Key", &settings.api_key);
    }
    let res = req.send().map_err(|e| format!("stream_chunk failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().unwrap_or_default();
        return Err(format!("stream_chunk HTTP {status}: {body}"));
    }
    Ok(())
}

/// Finish a live stream and return the full merged transcript.
#[tauri::command]
fn stream_end(app: AppHandle, session_id: String) -> Result<String, String> {
    let settings = load_settings(&app);
    let base = api_base_from_settings(&settings);
    let url = format!("{base}/transcribe_stream/end");
    let client = http_client()?;
    let mut req = client
        .post(&url)
        .json(&serde_json::json!({ "session_id": session_id }));
    if !settings.api_key.is_empty() {
        req = req.header("X-API-Key", &settings.api_key);
    }
    let res = req.send().map_err(|e| format!("stream_end failed: {e}"))?;
    let status = res.status();
    let body = res.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("stream_end HTTP {status}: {body}"));
    }
    let data: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad stream_end response: {e}"))?;
    Ok(data
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

#[tauri::command]
fn check_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_accessibility_client::accessibility::application_is_trusted_with_prompt()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
fn open_settings(pane: String) {
    #[cfg(target_os = "macos")]
    {
        let url = match pane.as_str() {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy",
        };
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let uri = match pane.as_str() {
            "microphone" => "ms-settings:privacy-microphone",
            "accessibility" => "ms-settings:easeofaccess-keyboard",
            _ => "ms-settings:privacy",
        };
        let _ = Command::new("cmd")
            .args(["/C", "start", "", uri])
            .spawn();
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = pane;
    }
}

#[tauri::command]
fn finish_setup(app: AppHandle) {
    let mut settings = load_settings(&app);
    settings.setup_complete = true;
    save_settings(&app, &settings);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
    // Return to menu-bar-only (no dock icon) once setup is dismissed.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    load_settings(&app)
}

#[tauri::command]
fn set_theme(app: AppHandle, theme: String) {
    let mut settings = load_settings(&app);
    settings.theme = theme.clone();
    save_settings(&app, &settings);
    if let Some(win) = app.get_webview_window("capsule") {
        let _ = win.emit("theme-changed", theme);
    }
}

#[tauri::command]
fn set_model(app: AppHandle, model: String) {
    let mut settings = load_settings(&app);
    settings.model = model;
    save_settings(&app, &settings);
    // Restart server on next session so the new Whisper weights are loaded.
    if let Some(state) = app.try_state::<AppState>() {
        stop_transcription_server(&state);
    }
}

#[tauri::command]
fn set_mic(app: AppHandle, device: String) {
    let mut settings = load_settings(&app);
    settings.mic_device = device;
    save_settings(&app, &settings);
}

fn validate_chord_hotkey(hotkey: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| format!("Invalid shortcut: {e}"))?;
    if shortcut.mods == Modifiers::empty() {
        return Err("Shortcut must include Ctrl, Alt, Shift, or Cmd".into());
    }
    Ok(shortcut)
}

fn disable_hotkey_listening(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let recording = state.recording.lock().map(|g| *g).unwrap_or(false);
        if recording {
            let _ = stop_capsule(app);
            if let Ok(mut rec) = state.recording.lock() {
                *rec = false;
            }
        }
    }
    let _ = app.global_shortcut().unregister_all();
    stop_hotkey_poll_listener();
    eprintln!("WishperType: hotkey listening disabled");
}

fn sync_hotkey_listening(app: &AppHandle) -> Result<(), String> {
    let settings = load_settings(app);
    if settings.hotkey_enabled {
        register_hotkey_listener(app, &settings.hotkey)
    } else {
        disable_hotkey_listening(app);
        Ok(())
    }
}

fn register_hotkey_listener(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    stop_hotkey_poll_listener();

    if let Some(modifier) = hotkey.strip_prefix("DoubleTap+") {
        return start_double_tap_listener(app, modifier);
    }

    let shortcut = validate_chord_hotkey(hotkey)?;
    let handle = app.clone();
    gs.on_shortcut(shortcut, move |app, _shortcut, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        if let Some(state) = app.try_state::<AppState>() {
            toggle_recording(&handle, &state);
        }
    })
    .map_err(|e| format!("Could not register shortcut (it may be in use): {e}"))?;

    eprintln!("WishperType: registered {hotkey}");
    Ok(())
}

#[tauri::command]
fn set_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    let mut settings = load_settings(&app);
    settings.hotkey = hotkey;
    save_settings(&app, &settings);
    sync_hotkey_listening(&app)
}

fn set_hotkey_enabled(app: AppHandle, enabled: bool) {
    let mut settings = load_settings(&app);
    settings.hotkey_enabled = enabled;
    save_settings(&app, &settings);
    let _ = sync_hotkey_listening(&app);
    refresh_tray(&app);
}

#[tauri::command]
fn report_mics(app: AppHandle, devices: Vec<MicDevice>) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut mics) = state.mics.lock() {
            *mics = devices;
        }
    }
    refresh_tray(&app);
}

#[derive(Serialize, Clone)]
struct ModelProgress {
    model: String,
    pct: u8,
    done: bool,
    error: Option<String>,
}

#[tauri::command]
fn ensure_model(app: AppHandle, model: String) -> Result<(), String> {
    let settings = load_settings(&app);
    if using_remote_backend(&settings) {
        // Models live on the VPS; just remember the preference for the next request.
        set_model(app.clone(), model.clone());
        refresh_tray(&app);
        let _ = app.emit(
            "model-progress",
            ModelProgress {
                model,
                pct: 100,
                done: true,
                error: None,
            },
        );
        return Ok(());
    }

    let root = repo_root();
    let target = root.join(format!("backend/wispertype/models/{model}.pt"));

    if target.is_file() {
        set_model(app.clone(), model.clone());
        refresh_tray(&app);
        let _ = app.emit(
            "model-progress",
            ModelProgress {
                model: model.clone(),
                pct: 100,
                done: true,
                error: None,
            },
        );
        return Ok(());
    }

    // Tell the UI immediately so it doesn't look frozen while Python starts.
    let _ = app.emit(
        "model-progress",
        ModelProgress {
            model: model.clone(),
            pct: 0,
            done: false,
            error: None,
        },
    );

    let app_bg = app.clone();
    thread::spawn(move || download_model(app_bg, model, root));

    Ok(())
}

fn download_model(app: AppHandle, model: String, root: PathBuf) {
    let target = root.join(format!("backend/wispertype/models/{model}.pt"));
    if target.is_file() {
        let _ = app.emit(
            "model-progress",
            ModelProgress {
                model: model.clone(),
                pct: 100,
                done: true,
                error: None,
            },
        );
        return;
    }

    let python = python_binary(&root);
    let backend = root.join("backend");
    let pythonpath = format!("{}:{}", backend.display(), root.display());

    let mut child = match Command::new(&python)
        .env("PYTHONPATH", pythonpath)
        .env("PYTHONUNBUFFERED", "1")
        .current_dir(&root)
        .args(["poc/bootstrap_model.py", &model])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let err = format!("Failed to start download: {e}");
            let _ = app.emit(
                "model-progress",
                ModelProgress {
                    model,
                    pct: 0,
                    done: true,
                    error: Some(err),
                },
            );
            return;
        }
    };

    if let Some(out) = child.stdout.take() {
        let reader = BufReader::new(out);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(pct) = line.strip_prefix("PROGRESS:") {
                if let Ok(pct) = pct.trim().parse::<u8>() {
                    let _ = app.emit(
                        "model-progress",
                        ModelProgress {
                            model: model.clone(),
                            pct,
                            done: false,
                            error: None,
                        },
                    );
                }
            }
        }
    }

    let status = child.wait();
    if status.is_err() || !status.as_ref().map(|s| s.success()).unwrap_or(false) || !target.is_file()
    {
        let err = format!("Failed to download model '{model}'");
        let _ = app.emit(
            "model-progress",
            ModelProgress {
                model: model.clone(),
                pct: 0,
                done: true,
                error: Some(err),
            },
        );
        return;
    }

    let _ = app.emit(
        "model-progress",
        ModelProgress {
            model: model.clone(),
            pct: 100,
            done: true,
            error: None,
        },
    );
    set_model(app.clone(), model.clone());
    refresh_tray(&app);
}

#[tauri::command]
fn get_capsule_position(app: AppHandle) -> String {
    load_capsule_config(&app).preset
}

#[tauri::command]
fn set_capsule_position(app: AppHandle, preset: String) {
    let mut cfg = load_capsule_config(&app);
    cfg.preset = preset;
    if cfg.preset != "custom" {
        cfg.x = None;
        cfg.y = None;
    }
    save_capsule_config(&app, &cfg);

    // Live-preview: reposition and briefly show the capsule.
    if let Some(window) = app.get_webview_window("capsule") {
        if let Some(state) = app.try_state::<AppState>() {
            state.positioning.store(true, Ordering::SeqCst);
        }
        position_capsule(&window, &cfg);
        let _ = window.show();
        let handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(900));
            if let Some(state) = handle.try_state::<AppState>() {
                let recording = state
                    .recording
                    .lock()
                    .map(|g| *g)
                    .unwrap_or(false);
                if !recording {
                    if let Some(win) = handle.get_webview_window("capsule") {
                        let _ = win.hide();
                    }
                }
                state.positioning.store(false, Ordering::SeqCst);
            }
        });
    }
}

#[tauri::command]
fn ensure_server(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    spawn_transcription_server(&app, &state)
}

#[tauri::command]
fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        if let Some(win) = app.get_webview_window("capsule") {
            let _ = win.hide();
        }
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut rec) = state.recording.lock() {
                *rec = false;
            }
        }
        return Ok(());
    }

    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(&trimmed).map_err(|e| e.to_string())?;

    // Hide capsule first so we are not the key window when Cmd+V fires.
    if let Some(win) = app.get_webview_window("capsule") {
        let _ = win.hide();
    }
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut rec) = state.recording.lock() {
            *rec = false;
        }
    }

    #[cfg(target_os = "macos")]
    {
        let pid = app
            .try_state::<AppState>()
            .and_then(|s| s.prev_pid.lock().ok().and_then(|g| *g));
        if let Some(pid) = pid {
            activate_pid(pid);
        }
    }

    // Focus restore is flaky if we paste too early; wait then re-assert clipboard.
    thread::sleep(Duration::from_millis(350));
    if let Err(e) = clipboard.set_text(&trimmed) {
        eprintln!("WishperType: clipboard re-set failed: {e}");
    }
    thread::sleep(Duration::from_millis(150));

    #[cfg(target_os = "macos")]
    {
        // AppleScript Cmd+V is more reliable than enigo on macOS (avoids bare "v").
        // Requires Accessibility permission — same as the rest of the paste flow.
        if paste_via_osascript().is_ok() {
            return Ok(());
        }
        eprintln!("WishperType: osascript paste failed; falling back to enigo");
    }

    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        enigo
            .key(Key::Meta, Direction::Press)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(80));
        enigo
            .key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(80));
        enigo
            .key(Key::Meta, Direction::Release)
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        enigo
            .key(Key::Control, Direction::Press)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(40));
        enigo
            .key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(40));
        enigo
            .key(Key::Control, Direction::Release)
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        enigo
            .key(Key::Control, Direction::Press)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(40));
        enigo
            .key(Key::Unicode('v'), Direction::Click)
            .map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(40));
        enigo
            .key(Key::Control, Direction::Release)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn paste_via_osascript() -> Result<(), String> {
    let status = Command::new("osascript")
        .args([
            "-e",
            "tell application \"System Events\" to keystroke \"v\" using command down",
        ])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("osascript exited with {status}"))
    }
}

#[tauri::command]
fn hide_capsule(app: AppHandle, window: WebviewWindow, state: State<AppState>) -> Result<(), String> {
    if let Ok(mut rec) = state.recording.lock() {
        *rec = false;
    }
    window.hide().map_err(|e| e.to_string())?;
    schedule_server_stop(app);
    Ok(())
}

fn show_capsule(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capsule")
        .ok_or("Capsule window not found")?;

    let cfg = load_capsule_config(app);

    if let Some(state) = app.try_state::<AppState>() {
        state.positioning.store(true, Ordering::SeqCst);
    }
    position_capsule(&window, &cfg);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<AppState>() {
        let handle = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(400));
            if let Some(state) = handle.try_state::<AppState>() {
                state.positioning.store(false, Ordering::SeqCst);
            }
            let _ = state;
        });
    }

    window.emit("session-start", ()).map_err(|e| e.to_string())?;
    Ok(())
}

fn stop_capsule(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("capsule")
        .ok_or("Capsule window not found")?;
    window.emit("session-stop", ()).map_err(|e| e.to_string())?;
    Ok(())
}

fn toggle_recording(app: &AppHandle, state: &State<AppState>) {
    let should_stop = {
        let mut recording = match state.recording.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if *recording {
            *recording = false;
            true
        } else {
            cancel_scheduled_server_stop();
            *recording = true;
            false
        }
    };

    if should_stop {
        let _ = stop_capsule(app);
        return;
    }

    // Remember which app was frontmost so we can paste back into it.
    #[cfg(target_os = "macos")]
    {
        if let Some(pid) = frontmost_pid() {
            if pid as u32 != std::process::id() {
                if let Ok(mut prev) = state.prev_pid.lock() {
                    *prev = Some(pid);
                }
            }
        }
    }

    if let Err(err) = show_capsule(app) {
        eprintln!("WishperType: failed to show capsule: {err}");
        if let Ok(mut recording) = state.recording.lock() {
            *recording = false;
        }
        return;
    }

    if let Err(err) = spawn_transcription_server(app, state) {
        eprintln!("WishperType: server error: {err}");
        let _ = app.emit("server-error", err);
    }
}

const TRAY_ID: &str = "wishper-tray";

fn show_settings_window(app: &AppHandle) {
    // On macOS the app runs as an Accessory (no dock icon), so a hidden window
    // won't come to the front on show(). Temporarily become a Regular app so
    // the settings window is focused and visible.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = load_settings(app);
    let cfg = load_capsule_config(app);

    let hotkey_listen = CheckMenuItem::with_id(
        app,
        "hotkey_enabled",
        "Listen for hotkey",
        true,
        settings.hotkey_enabled,
        None::<&str>,
    )?;

    let toggle = MenuItem::with_id(app, "toggle", "Start / Stop Dictation", true, None::<&str>)?;

    let (cur_v, cur_h) = preset_anchors(&cfg.preset);
    let current_preset = if cfg.preset == "custom" {
        "custom".to_string()
    } else {
        format!("{cur_v}-{cur_h}")
    };
    let pos_defs = [
        ("top-left", "Top Left"),
        ("top-center", "Top Center"),
        ("top-right", "Top Right"),
        ("center-left", "Center Left"),
        ("center-center", "Center"),
        ("center-right", "Center Right"),
        ("bottom-left", "Bottom Left"),
        ("bottom-center", "Bottom Center"),
        ("bottom-right", "Bottom Right"),
    ];
    let mut pos_items = Vec::new();
    for (key, label) in pos_defs {
        pos_items.push(CheckMenuItem::with_id(
            app,
            format!("pos:{key}"),
            label,
            true,
            current_preset == key,
            None::<&str>,
        )?);
    }
    let pos_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        pos_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let pos_menu = Submenu::with_items(app, "Capsule Position", true, &pos_refs)?;

    let theme_defs = [
        ("green", "Green"),
        ("blue", "Blue"),
        ("purple", "Purple"),
        ("pink", "Pink"),
        ("amber", "Amber"),
    ];
    let mut theme_items = Vec::new();
    for (key, label) in theme_defs {
        theme_items.push(CheckMenuItem::with_id(
            app,
            format!("theme:{key}"),
            label,
            true,
            settings.theme == key,
            None::<&str>,
        )?);
    }
    let theme_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        theme_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let theme_menu = Submenu::with_items(app, "Theme", true, &theme_refs)?;

    let model_defs = [
        ("tiny.en", "Tiny (fastest)"),
        ("base.en", "Base (light)"),
        ("small.en", "Small (solid)"),
        ("medium.en", "Medium (recommended)"),
        ("large-v3-turbo", "Large Turbo (fast)"),
        ("large-v3", "Large (max accuracy)"),
    ];
    let mut model_items = Vec::new();
    for (key, label) in model_defs {
        model_items.push(CheckMenuItem::with_id(
            app,
            format!("model:{key}"),
            label,
            true,
            settings.model == key,
            None::<&str>,
        )?);
    }
    let model_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        model_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let model_menu = Submenu::with_items(app, "Model", true, &model_refs)?;

    let cached_mics = app
        .try_state::<AppState>()
        .and_then(|s| s.mics.lock().ok().map(|g| g.clone()))
        .unwrap_or_default();
    let mut mic_items = Vec::new();
    mic_items.push(CheckMenuItem::with_id(
        app,
        "mic:",
        "System default",
        true,
        settings.mic_device.is_empty(),
        None::<&str>,
    )?);
    for dev in &cached_mics {
        let label = if dev.label.is_empty() {
            "Microphone".to_string()
        } else {
            dev.label.clone()
        };
        mic_items.push(CheckMenuItem::with_id(
            app,
            format!("mic:{}", dev.id),
            label,
            true,
            settings.mic_device == dev.id,
            None::<&str>,
        )?);
    }
    let mic_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        mic_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let mic_menu = Submenu::with_items(app, "Microphone", true, &mic_refs)?;

    let settings_item =
        MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit WishperType", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &hotkey_listen,
            &sep1,
            &toggle,
            &sep2,
            &mic_menu,
            &pos_menu,
            &theme_menu,
            &model_menu,
            &sep3,
            &settings_item,
            &quit,
        ],
    )
}

fn refresh_tray(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
        let tooltip = if load_settings(app).hotkey_enabled {
            "WishperType — voice typing"
        } else {
            "WishperType — hotkey off"
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let icon = app.default_window_icon().cloned().unwrap();

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip(if load_settings(app).hotkey_enabled {
            "WishperType — voice typing"
        } else {
            "WishperType — hotkey off"
        })
        .on_menu_event(|app, event| {
            let id = event.id.as_ref().to_string();
            match id.as_str() {
                "quit" => {
                    FORCE_QUIT.store(true, Ordering::SeqCst);
                    shutdown_app(app);
                    app.exit(0);
                }
                "settings" => show_settings_window(app),
                "hotkey_enabled" => {
                    let enabled = !load_settings(app).hotkey_enabled;
                    set_hotkey_enabled(app.clone(), enabled);
                }
                "toggle" => {
                    if let Some(state) = app.try_state::<AppState>() {
                        toggle_recording(app, &state);
                    }
                }
                _ => {
                    if let Some(m) = id.strip_prefix("mic:") {
                        set_mic(app.clone(), m.to_string());
                        refresh_tray(app);
                    } else if let Some(p) = id.strip_prefix("pos:") {
                        set_capsule_position(app.clone(), p.to_string());
                        refresh_tray(app);
                    } else if let Some(t) = id.strip_prefix("theme:") {
                        set_theme(app.clone(), t.to_string());
                        refresh_tray(app);
                    } else if let Some(m) = id.strip_prefix("model:") {
                        let _ = ensure_model(app.clone(), m.to_string());
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            recording: Mutex::new(false),
            server: Mutex::new(None),
            positioning: AtomicBool::new(false),
            server_managed: AtomicBool::new(false),
            server_external: AtomicBool::new(false),
            prev_pid: Mutex::new(None),
            mics: Mutex::new(Vec::new()),
        })
        .invoke_handler(tauri::generate_handler![
            api_base,
            get_api_key,
            ensure_server,
            paste_text,
            hide_capsule,
            check_accessibility,
            request_accessibility,
            open_settings,
            finish_setup,
            get_capsule_position,
            set_capsule_position,
            get_settings,
            set_theme,
            set_model,
            set_mic,
            set_hotkey,
            set_backend_mode,
            set_backend_url,
            set_api_key,
            transcribe_pcm,
            stream_start,
            stream_chunk,
            stream_end,
            report_mics,
            ensure_model
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            build_tray(app.handle())?;
            if let Err(err) = sync_hotkey_listening(app.handle()) {
                eprintln!("WishperType: hotkey unavailable ({err}). Use the tray icon.");
            }

            if let Some(win) = app.get_webview_window("main") {
                let settings = load_settings(app.handle());
                if settings.setup_complete {
                    let _ = win.hide();
                } else {
                    // First launch — show onboarding once.
                    #[cfg(target_os = "macos")]
                    let _ = app.handle().set_activation_policy(tauri::ActivationPolicy::Regular);
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                // Closing the settings window should hide it (so it can be
                // reopened from the tray), not destroy it or quit the app.
                let handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        // Closing via the window chrome also counts as finishing first-run.
                        let mut settings = load_settings(&handle);
                        if !settings.setup_complete {
                            settings.setup_complete = true;
                            save_settings(&handle, &settings);
                        }
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        #[cfg(target_os = "macos")]
                        let _ = handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }

            // Remember the capsule position when the user drags it.
            if let Some(capsule) = app.get_webview_window("capsule") {
                let handle = app.handle().clone();
                capsule.on_window_event(move |event| {
                    if let WindowEvent::Moved(pos) = event {
                        if let Some(state) = handle.try_state::<AppState>() {
                            if state.positioning.load(Ordering::SeqCst) {
                                return;
                            }
                        }
                        let mut cfg = load_capsule_config(&handle);
                        cfg.preset = "custom".into();
                        cfg.x = Some(pos.x);
                        cfg.y = Some(pos.y);
                        save_capsule_config(&handle, &cfg);
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if FORCE_QUIT.load(Ordering::SeqCst) {
                        shutdown_app(app);
                    } else {
                        // Keep the app resident in the tray when windows close.
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    shutdown_app(app);
                }
                _ => {}
            }
        });
}
