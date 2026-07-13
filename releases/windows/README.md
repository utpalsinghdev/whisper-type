# Windows releases

Installers for Windows (x64) land here:

| File | Description |
|------|-------------|
| `WishperType_*_x64-setup.exe` | NSIS installer (recommended) |
| `WishperType_*_x64_en-US.msi` | MSI installer (if produced) |

## Why this folder may be empty on your Mac

WishperType is a Tauri app. A real Windows `.exe` must be built **on Windows** (WebView2 + NSIS). You cannot produce it with `npm run build` on macOS.

## How to get a Windows build

### Option A — GitHub Actions (recommended)

1. Push this repo to GitHub.
2. Open **Actions** → **Build Windows** → **Run workflow**.
3. Download the `wishpertype-windows-x64` artifact when it finishes.
4. Optionally copy the `.exe` into this folder for local distribution.

### Option B — Build on a Windows PC

```bat
cd app
npm install
npm run build
```

Output:

- `src-tauri\target\release\bundle\nsis\WishperType_*_x64-setup.exe`

## Runtime note

The desktop shell still needs the Python transcription backend (local `.venv` / Docker on port `19527`), same as macOS.
