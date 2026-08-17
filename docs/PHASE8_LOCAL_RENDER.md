# Phase 8 local renderer handoff

Use the admin-capable Windows laptop for the native renderer development loop. GitHub Actions remains the clean packaging check, not the primary iteration environment.

## Development prerequisites

- Rust stable MSVC toolchain and the Visual Studio C++ build tools.
- Node 24 and project dependencies (`npm ci`).
- No global FFmpeg is required by MapMotion. The production runtime uses the bundled resource assembled by the workflow.

## Commands

```powershell
npm run dev
npm run tauri -- build --bundles nsis
```

## Current Phase 8 state

The installed current-user bundle resolves bundled FFmpeg and proves a 10-second 1920x1080@30 raw RGBA to H.264 stream. The current smoke-test frames are intentionally uniform; replacing them with deterministic map, Layer, text, and effect frames is the next task.

The portable artifact is now assembled as `dist-portable/MapMotion Studio/` with `mapmotion-studio.exe` and its required `resources/` folder together. Never launch a copied EXE without that adjacent folder.

## Remaining acceptance work

1. Render deterministic project states into RGBA frames.
2. Stream those frames to FFmpeg with progress and cancellation.
3. Verify 10-second and 30-second 1080p30 MP4 output, including Persian text.
4. Confirm installed and portable artifacts on a clean offline machine.
