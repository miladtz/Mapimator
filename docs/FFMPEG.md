# Bundled FFmpeg

MapMotion packages FFmpeg application-locally for offline, no-admin H.264 export. It never uses the system PATH or a global FFmpeg installation.

- Provider: BtbN FFmpeg-Builds
- Download alias: BtbN `latest` release asset, accepted only when its content matches the pinned checksum below
- Asset: `ffmpeg-master-latest-win64-gpl-shared.zip`
- SHA-256: `b3a6a580b961bd7aa175cdfc4bfcf010f033943968e9e1f5f4cf4d7f03164713`
- Packaging: GitHub Actions downloads, verifies, extracts `bin` into `src-tauri/resources/ffmpeg`, then Tauri copies it into installed application resources.

This is a GPL build because it includes libx264. Distribution must include the applicable GPL notice and offer corresponding source as required. The moving download alias is never trusted by itself: CI fails if its bytes differ from the recorded SHA-256. Update only after reviewing a new build, its licenses, and its checksum together.
