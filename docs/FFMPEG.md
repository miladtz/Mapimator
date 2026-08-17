# Bundled FFmpeg

MapMotion packages FFmpeg application-locally for offline, no-admin H.264 export. It never uses the system PATH or a global FFmpeg installation.

- Provider: BtbN FFmpeg-Builds
- Pinned release: `autobuild-2026-07-29-13-36`
- Asset: `ffmpeg-master-latest-win64-gpl-shared.zip`
- SHA-256: `9211f801f2ee31f30cc343df7791ffee866a4053a5145b07191b280d2fb48f46`
- Packaging: GitHub Actions downloads, verifies, extracts `bin` into `src-tauri/resources/ffmpeg`, then Tauri copies it into installed application resources.

This is a GPL build because it includes libx264. Distribution must include the applicable GPL notice and offer corresponding source as required. Update only by selecting a new immutable release asset, recording its checksum, reviewing its included licenses, and updating this document and workflow together.
