# Contributing to WishperType

Thank you for helping make WishperType better! Every bug report, feature idea, doc fix, and pull request matters.

If you find this project useful, consider **giving it a star** on GitHub — it helps others discover it and motivates continued development.

## Before you start

1. **Check existing issues** — someone may already be working on it  
   https://github.com/utpalsinghdev/wishper-type/issues

2. **For large changes**, open an issue first to discuss the approach

3. **Read the setup guide** below so you can run the app locally

## Fork → change → pull request

All contributions go through GitHub pull requests:

```
1. Star the repo (optional but appreciated ⭐)
      https://github.com/utpalsinghdev/wishper-type

2. Fork the repo to your GitHub account
      Click "Fork" on the top-right of the repo page

3. Clone YOUR fork locally
      git clone https://github.com/YOUR_USERNAME/wishper-type.git
      cd wishper-type

4. Add the original repo as "upstream" (to stay in sync)
      git remote add upstream https://github.com/utpalsinghdev/wishper-type.git

5. Create a branch for your work
      git checkout -b fix/my-bug-fix
      # or: feature/my-new-feature

6. Make your changes and test them (see setup below)

7. Commit and push to YOUR fork
      git add .
      git commit -m "Fix: describe what you changed"
      git push origin fix/my-bug-fix

8. Open a Pull Request on GitHub
      Go to your fork → "Compare & pull request"
      Fill in the PR template and submit
```

The maintainer will review your PR, may ask for changes, and merge when ready.

### Keeping your fork up to date

```bash
git fetch upstream
git checkout main
git merge upstream/main
git push origin main
```

## Ways to contribute (no code required)

- **Report bugs** — [open a bug report](https://github.com/utpalsinghdev/wishper-type/issues/new?template=bug_report.yml)
- **Suggest features** — [open a feature request](https://github.com/utpalsinghdev/wishper-type/issues/new?template=feature_request.yml)
- **Ask questions** — [open a question](https://github.com/utpalsinghdev/wishper-type/issues/new?template=question.yml)
- **Improve docs** — fix typos, clarify setup steps, add examples
- **Review pull requests** — test someone else's branch and leave feedback

## Local setup

### Option A — Docker (transcription server only)

Best if you want to skip installing Python, PyTorch, and Whisper on your host. The desktop app still needs Rust and Node.js.

```bash
git clone https://github.com/YOUR_USERNAME/wishper-type.git
cd wishper-type

# Start the transcription API (downloads the model on first run)
docker compose up --build
```

Server health check: http://127.0.0.1:19527/health

Then in another terminal:

```bash
cd app
npm install
export CARGO_TARGET_DIR=/tmp/wishper-type-target   # optional, avoids slow external drives
npm run dev
```

The Tauri app detects the running server on port `19527` and uses it automatically.

### Option B — Full local setup (no Docker)

```bash
git clone https://github.com/YOUR_USERNAME/wishper-type.git
cd wishper-type
chmod +x scripts/setup.sh
./scripts/setup.sh

cd app
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run dev
```

## Prerequisites

| Tool | Version | Required for |
|------|---------|--------------|
| [Rust](https://rustup.rs) | stable | Desktop app |
| [Node.js](https://nodejs.org) | 18+ | Desktop app UI |
| [Python](https://python.org) | 3.9+ | Transcription (skip if using Docker) |
| [Docker](https://docker.com) | any recent | Optional — backend only |

### macOS permissions

Grant **Microphone** and **Accessibility** to WishperType so it can record and paste into other apps.

## Project layout

```
wishper-type/
├── app/                  # Tauri desktop app
├── backend/wispertype/   # Whisper transcription engine
├── poc/                  # API server entrypoint
├── releases/             # Release artifacts (published separately)
├── scripts/              # Setup helpers
└── docker-compose.yml    # Transcription server in Docker
```

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind and constructive.

## Building a release

```bash
cd app
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run build
```

Installers are written to `$CARGO_TARGET_DIR/release/bundle/`.

## Questions?

Open an issue: https://github.com/utpalsinghdev/wishper-type/issues
