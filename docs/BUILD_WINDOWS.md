# Building MapMotion Studio on Windows without administrator access

## Current packaging status

The project is a Tauri 2 application: the frontend is built with Vite, and `src-tauri/` contains the Rust application and per-user NSIS configuration. The installer mode is `currentUser`.

## User-space prerequisites

Install or unpack each item beneath a user-writable directory, such as `%LOCALAPPDATA%\MapMotion\toolchain` or a project `tools/` folder. Do not use Program Files or system-wide installation.

- Node.js and npm (already user-installed for this workspace)
- Rust stable under `%USERPROFILE%\.cargo` and `%USERPROFILE%\.rustup`
- A **portable Windows SDK + linker toolchain**. It must provide `link.exe` or a compatible linker plus Windows import libraries including `kernel32.lib`, `userenv.lib`, `ws2_32.lib`, and `dbghelp.lib`. A portable LLVM/Windows-SDK or MinGW toolchain is suitable; Rust's bundled `rust-lld` alone is not sufficient because it does not include those libraries.

Bundled app fonts are emitted with the frontend build. Future FFmpeg binaries must be copied into a project-controlled Tauri resource folder; they must not be installed globally.

## Commands

From the project root, with user-space Node, Rust, linker, and SDK paths prepended to the current process `PATH`:

```powershell
npm install
npm run build
npm run tauri:build
```

The `tauri:build` command runs the production frontend build, then compiles the Rust desktop application and generates an NSIS per-user installer. It never uses `npm run dev`, localhost, or Vite at runtime.

## Expected artifacts

After a successful build:

- Frontend: `dist/`
- Executable: `src-tauri/target/release/mapmotion-studio.exe`
- NSIS installer: `src-tauri/target/release/bundle/nsis/`

## Troubleshooting

- `link.exe not found`: add the portable toolchain's `bin` directory to `PATH` for the build process.
- `kernel32.lib not found`: add the portable Windows SDK library directories through the toolchain environment; do not point Rust at `rust-lld` alone.
- Never substitute a machine-level Build Tools install. Keep toolchains in a user directory and configure their paths only in the build shell or an untracked local environment file.
