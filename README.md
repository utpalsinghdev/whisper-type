# WishperType

Lightweight cross-platform voice typing for macOS, Windows, and Linux. Press a global hotkey, speak into a small capsule overlay, and have your words transcribed and pasted into whatever app you're using.

## Features

- Global hotkey (`Cmd+Shift+R` on macOS, `Ctrl+Shift+R` elsewhere)
- Floating capsule with live waveform
- Paste into the previously active application
- Menu bar quick settings (mic, model, theme, position)
- Multiple Whisper models: Tiny, Base, Small
- Customizable capsule position and color theme

## Quick start

### Docker (easiest — transcription server)

Skips installing Python, PyTorch, and Whisper on your machine. You still need [Rust](https://rustup.rs) and [Node.js](https://nodejs.org) for the desktop app.

```bash
git clone https://github.com/utpalsinghdev/wishper-type.git
cd wishper-type

# Terminal 1 — start transcription API (first run downloads ~145 MB model)
docker compose up --build

# Terminal 2 — start desktop app
cd app
npm install
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run dev
```

The app auto-detects the server on `http://127.0.0.1:19527`.

### Local setup (no Docker)

```bash
git clone https://github.com/utpalsinghdev/wishper-type.git
cd wishper-type
chmod +x scripts/setup.sh
./scripts/setup.sh

cd app
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for full contributor guide.

## Build installer (macOS)

```bash
cd app
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run build
```

Output: `$CARGO_TARGET_DIR/release/bundle/dmg/WishperType_*.dmg`

Pre-built releases will be published in [releases/](releases/) and on [GitHub Releases](https://github.com/utpalsinghdev/wishper-type/releases).

## Project structure

```
wishper-type/
├── app/                  # Tauri desktop app (Rust + web UI)
├── backend/wispertype/   # Whisper transcription engine
├── poc/                  # Server entrypoint + model bootstrap
├── releases/             # Published installers (not in source tree)
├── scripts/              # Setup helpers
├── Dockerfile            # Transcription server image
└── docker-compose.yml
```

## Models & accuracy

| Model     | Size   | Speed   | Accuracy    |
|-----------|--------|---------|-------------|
| `tiny.en` | ~75 MB | Fastest | Basic       |
| `base.en` | ~145 MB| Balanced| **Default** |
| `small.en`| ~480 MB| Slower  | Best        |

Models download on first use — they are **not** bundled in the repo or installer to keep size small.

Change the model in Settings or the menu bar.

## Permissions (macOS)

- **Microphone** — required for recording
- **Accessibility** — required to paste into other apps

## Versioning

App version: `app/src-tauri/tauri.conf.json` → `"version"`. Follow [Semantic Versioning](https://semver.org/).

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Pull requests, issues, and stars are all welcome!

- **Report a bug** → [Bug report](https://github.com/utpalsinghdev/wishper-type/issues/new?template=bug_report.yml)
- **Request a feature** → [Feature request](https://github.com/utpalsinghdev/wishper-type/issues/new?template=feature_request.yml)
- **Contribute code** → fork the repo, make changes, open a PR — see [CONTRIBUTING.md](CONTRIBUTING.md)

If WishperType is useful to you, a **star** on GitHub helps others find it.
