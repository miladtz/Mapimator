# GitHub Actions Windows Build

## Official production packaging method

MapMotion's production Windows installer is built by GitHub Actions, not by the original developer laptop. This removes the need for local administrator access, a local Windows SDK, or local MSVC Build Tools.

The workflow is [`.github/workflows/build-windows.yml`](../.github/workflows/build-windows.yml). It runs on GitHub-hosted `windows-latest`, installs Node dependencies from `package-lock.json`, configures stable Rust for `x86_64-pc-windows-msvc`, and invokes the official Tauri action to create the NSIS bundle.

## Trigger a build

1. Push to `main`, or open **GitHub → Actions → Build MapMotion Windows → Run workflow**.
2. Wait for the `Build current-user Windows installer` job to finish.
3. Download the **MapMotion-Windows** artifact from that workflow run.

The artifact contains the standalone executable, NSIS installer, and build configuration. The workflow fails if either executable is missing; it does not treat the Vite build alone as a release build.

## Artifact locations in the Windows runner

- Standalone executable: `src-tauri/target/release/mapmotion-studio.exe`
- Per-user NSIS installer: `src-tauri/target/release/bundle/nsis/*.exe`

Tauri is configured with `installMode: currentUser`, so installation does not require elevation and should not use Program Files.

## Test the downloaded artifact

1. Stop local Vite and Node development servers.
2. Extract the GitHub artifact to a user-writable folder.
3. Run the installer or standalone executable.
4. Confirm the editor launches without localhost, a dev server, VS Code, or Codex.
5. Confirm the offline map loads, pan/zoom works, current Layers work, Persian/English text renders, and local Save/Open works.

## Local development

Local development continues to use `npm install` and `npm run dev`. A local native package build is optional and requires a complete Windows MSVC + SDK environment. It is not the release pipeline.

## Bundled resources

Application fonts are emitted into the frontend bundle. Future FFmpeg binaries must be added as Tauri resources under source control or downloaded during CI from a verified source, subject to licensing; they must never be installed system-wide.

## Common failures

- **`npm ci` fails:** update and commit `package-lock.json` alongside dependency changes.
- **Tauri bundle fails:** inspect the Windows Actions log; the job intentionally fails before artifact upload.
- **No artifact appears:** the explicit artifact check requires both the NSIS installer and standalone EXE.
