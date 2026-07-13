# macOS releases

| File | Description |
|------|-------------|
| `WishperType_*_aarch64.dmg` | Apple Silicon installer |
| `WishperType_*_x64.dmg` | Intel Mac installer |

DMG binaries are gitignored. Build locally:

```bash
cd app
export CARGO_TARGET_DIR=/tmp/wishper-type-target
npm run build
cp "$CARGO_TARGET_DIR/release/bundle/dmg/"*.dmg ../releases/mac/
```
