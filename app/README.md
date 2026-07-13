# WishperType Desktop

See the [root README](../README.md) for setup, build, and contribution instructions.

## Development

```bash
cd app
npm install
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run dev
```

## Build

```bash
npm run build
```

Artifacts: `src-tauri/target/release/bundle/` (or `$CARGO_TARGET_DIR/release/bundle/`).
