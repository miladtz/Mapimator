# MapMotion Studio — Implementation Plan

# OFFLINE FIRST

# VIEWS + LAYERS FIRST

## Environment inspection (2026-08-17)

| Check | Result |
| --- | --- |
| OS | Windows 10 Enterprise, version 2009 |
| Node / npm / pnpm | 24.17.0 / 11.13.0 / 11.19.0 |
| Rust / Cargo | Not installed |
| Tauri CLI / C++ build tools | Not found |
| FFmpeg | Not installed |
| GPU / NVENC / RAM | Cannot be queried in this managed environment; `nvidia-smi` and CIM hardware access are unavailable |
| Disk | Drive free-space counters are unavailable in the sandbox |
| Git | Empty repository on `master`; no commits |

The missing Rust and Windows build prerequisites block packaging a Tauri binary in this environment. Phase 1 therefore ships and verifies the platform-independent React application; the supplied adapters preserve a clean future Tauri integration point.

## Architecture

- **UI:** React + TypeScript + Vite, styled with purpose-built CSS in this initial foundation.
- **State:** a small central project store; Zustand is added with the layer/view phase when mutation history starts.
- **Map:** local SVG vector geometry for the Phase 1 offline basemap. The `OfflineMap` component owns projection, camera, drag and wheel interactions. MapLibre with packaged vector tiles remains the production-data replacement once the data package is prepared.
- **Core:** `src/core` contains serializable project contracts, style presets, i18n contracts, and adapters without React or Tauri imports.
- **Persistence:** `BrowserFileSystemAdapter` uses localStorage for the browser prototype; a future `TauriFileSystemAdapter` implements the same interface for `.mapmotion` files.

## Directory structure

```text
src/
  app/                 application composition
  components/          editor and offline-map UI
  core/                platform-independent data contracts and adapters
  data/                versioned, bundled starter basemap data
  styles/              global visual system
```

## Data model

`Project` begins versioned and includes metadata, canvas, map settings, layers, views, assets, animation, and export settings. Phase 1 only operates on metadata/canvas/map settings, while retaining the durable shape required by later phases.

## Future core designs

- **Layers:** discriminated `Layer` union, global and per-view state, ordered in the project model.
- **Views:** camera plus visible-layer and property overrides. A view captures a scene separately from project persistence.
- **ViewCompiler:** `compileViews(views, layers)` creates an `AnimationSequence`; `diffLayerState(previous,next)` returns ENTER, EXIT, UPDATE, HOLD, or NONE. `evaluateProjectAtTime(project,time)` is shared by preview and export.
- **Offline data:** modular, versioned Natural Earth-derived political packages, separate English/Persian label tables, local search index, and style configuration over one shared source set.
- **Persian/RTL:** UI direction and translation dictionaries now; Phase 3 adds Vazirmatn/Noto bundling, script detection, Unicode normalization, bidi/shaping-safe text rendering, and Persian digit formatting.
- **Video:** Phase 8 streams deterministically rendered frames to FFmpeg, detects NVENC/QSV/AMF, then falls back to software H.264.

## Performance and testing

Avoid duplicated geometry and full-resolution buffers. Keep preview and exporter powered by the same animation evaluator. Unit-test serializable core logic and view diffs; add interaction tests for editing workflows. Manually check offline launch, pan/zoom, style change, save, open, and language direction each phase.

## Risks

- A production Tauri build requires Rust, MSVC build tools, WebView2, and Tauri CLI.
- Full world political data, disputed boundaries, and Persian labels require deliberate data licensing/versioning work.
- Export parity needs a deterministic renderer rather than editor screen capture.

## Milestones

1. **Phase 1 (current):** offline editor/map/save foundation.
2. Phase 2: static core Layers.
3. Phase 3: complete Persian/English text.
4. Phase 4–5: Views, compiler, and automatic transitions.
5. Phase 6–7: editorial effects and layout reframe.
6. Phase 8–11: deterministic export, portability, templates, advanced timeline.

## Phase completion report

# PHASE 1 COMPLETE

**Implemented:** offline local vector map canvas; dark/light documentary style presets; pan/zoom; English country labels; editor layout; English/Persian direction and dictionary foundation; versioned project model; browser-prototype save/open adapter.

**Tests:** `npm run build` completes successfully (TypeScript + Vite production bundle).

**Manual verification:** local editor launched successfully; map and labels displayed; style change worked; RTL switch worked; save then open restored the project; browser console had no errors.

**Known limitations:** this environment lacks Rust/Cargo, Tauri build tooling, and FFmpeg, so it cannot package a Windows Tauri binary or verify video capabilities. The starter geometry deliberately covers a compact political world overview only; it is not yet the full versioned Natural Earth data package. `.mapmotion` disk files, Layers, Views, rendering, and effects remain correctly deferred to later phases.

**Files changed:** root project configuration, `src/`, `PRODUCT_SPEC.md`, and this plan.

**Next proposed phase:** Phase 2 — static core Layers, only after installing the native Windows/Tauri prerequisites if a desktop binary is required for the next verification cycle.

## Phase 2 completion report

# PHASE 2 COMPLETE

**Implemented:** serializable Region, Pin, Text, Shape, Arrow, Image placeholder, and Route layer data; floating add toolbar; synchronized Project Layers panel and canvas selection; contextual inspector; live name/content/color/opacity controls; visibility and lock controls; direct map dragging; duplication, deletion, search, and stacking-order controls.

**Tests:** `npm run build` completes successfully.

**Manual verification:** launched local app; created Region, Text, and Arrow Layers; confirmed three synchronized layer rows and an active inspector; duplicated then deleted the selected Layer; verified no browser-console errors.

**Known limitations:** Region selection is presently a compact bundled-country lookup (Iran default); Image is an intentionally labeled visual placeholder pending project-controlled asset import; routes are simple visual paths. Grouping and full rich per-layer inspectors are future refinements. Views remain excluded by contract until Phase 4.

**Next proposed phase:** Phase 3 — Persian/English text correctness, bundled font strategy, full RTL/LTR support, and multilingual map labels.

## Phase 3 completion report

# PHASE 3 COMPLETE

**Implemented:** bundled offline Inter and Vazirmatn web fonts; text language, direction, number-style, and font-size properties in the project model; Persian/Arabic script detection; explicit RTL/LTR overrides; Persian-digit conversion; Unicode bidi-safe SVG text rendering; text inspector controls; and English, Persian, bilingual, or hidden country-label modes.

**Tests:** `npm run build` completes successfully, including locally emitted Vazirmatn Arabic and Inter font assets.

**Manual verification:** created a text Layer, entered `رشد ۵۰٪ در سال 2026`, selected Persian numbers, and confirmed it rendered as `رشد ۵۰٪ در سال ۲۰۲۶`; confirmed bilingual map labels include `ایران`; browser console was error-free.

**Known limitations:** the UI translation dictionary from the early prototype needs a full cleanup pass for every Phase 2 control; city labels and installed-Windows-font selection remain future work. The bundled political dataset is intentionally compact, but its label model is now multilingual.

**Next proposed phase:** Phase 4 — View model and static scene-state operations, without transitions or timeline work.

## Native packaging verification (in progress)

Tauri packaging configuration has been added under `src-tauri/`, including a Windows per-user NSIS target and `npm run tauri:build`. The frontend production build succeeds. The native build correctly reached Rust compilation, where it reported the missing Microsoft MSVC linker (`link.exe`). Rust is installed and working; the Visual Studio 2022 Build Tools C++ workload installer was started to supply that linker. No `.exe` or installer artifact exists yet, so Phase 4 must not begin until the installer completes and the native build is rerun successfully.

## User-space development policy

This project must build, test, and package without administrator access. The NSIS installer remains `currentUser` only. Development dependencies, build toolchains, caches, generated artifacts, bundled fonts, and future FFmpeg binaries must stay within user-writable locations. The project must not install fonts system-wide, add services/drivers, write into Program Files, or require elevation. The attempted machine-level Visual Studio Build Tools route is discontinued; native packaging will use a portable user-space linker/toolchain alternative.
