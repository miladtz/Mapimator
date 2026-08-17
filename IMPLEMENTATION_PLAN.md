# MapMotion Studio — Implementation Plan

# OFFLINE FIRST

# VIEWS + LAYERS FIRST

## Environment inspection (2026-08-17)

| Check                       | Result                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| OS                          | Windows 10 Enterprise, version 2009                                                                 |
| Node / npm / pnpm           | 24.17.0 / 11.13.0 / 11.19.0                                                                         |
| Rust / Cargo                | Not installed                                                                                       |
| Tauri CLI / C++ build tools | Not found                                                                                           |
| FFmpeg                      | Not installed                                                                                       |
| GPU / NVENC / RAM           | Cannot be queried in this managed environment; `nvidia-smi` and CIM hardware access are unavailable |
| Disk                        | Drive free-space counters are unavailable in the sandbox                                            |
| Git                         | Empty repository on `master`; no commits                                                            |

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

## Native packaging verification (GitHub Actions)

Local development uses the current user's Windows environment and does not require elevation. Production Windows packaging uses a GitHub Actions `windows-latest` runner through `.github/workflows/build-windows.yml`. The workflow builds the actual Tauri NSIS `currentUser` bundle, verifies both executable outputs, and uploads `MapMotion-Windows`. Lack of local administrator access does not block release packaging.

**Packaging gate: complete.** GitHub Actions run `32009851437` successfully produced the `MapMotion-Windows` artifact. The artifact was downloaded and user-verified on the target laptop: the Tauri desktop application launched without an administrator prompt or development server, and the offline map loaded successfully. Future UI polish can proceed independently of the validated packaging pipeline.

## Phase 4 completion report

# PHASE 4 COMPLETE

**Implemented:** serializable View model; scene capture of layer state and camera state; Add View; static View cards; active View preview; Update View; duplicate, rename, and delete controls; clear in-editor distinction between updating a View and saving a Project.

**Tests:** `npm run build` completes successfully.

**Manual verification:** created a View, added a Layer, updated the active View, and confirmed no browser console errors.

**Known limitations:** View thumbnails are compact generated placeholders; hold duration is stored at the default 3 seconds but not yet edited in the UI; transitions, interpolation, and preview playback remain intentionally deferred to Phase 5.

**Next proposed phase:** Phase 5 — ViewCompiler, layer diffing, automatic camera/layer transitions, and preview.

## Phase 5 completion report

# PHASE 5 COMPLETE

**Implemented:** platform-independent `ViewCompiler`; explicit ENTER/EXIT/UPDATE/HOLD layer diff classification; automatic camera, position, opacity, visibility, and route-endpoint interpolation between consecutive Views; per-View hold, transition duration, and easing controls; and editor preview playback using the same evaluator intended for later export work.

**Tests:** `npm run build` completes successfully. Interactive verification created two Views, enabled Preview, entered playback, and reported no browser console errors.

**Known limitations:** this phase previews the compiled sequence only; deterministic export rendering remains reserved for Phase 8. View thumbnails remain intentionally lightweight.

**Next proposed phase:** Phase 6 — editorial effects and controls.

## Phase 6 progress report — core effects group 1

**Implemented:** a serializable `Geo Effect` Layer and offline SVG renderers for Impact Pulse, Strike Marker, Smoke Plume, and Missile Arc. Effects support color, opacity, size, duration, repeat state, and capture correctly with View layer state. Existing Arrow Layers continue to cover Advance and Retreat primitives.

**Tests:** `npm run build` completes successfully. Manual local verification added an Impact Pulse through the editor, confirmed its synchronized Project Layers entry and rendered SVG effect, and found no browser-console errors.

**Phase status:** in progress. The remaining conflict, control, movement, and boundary effect groups must be delivered and verified before Phase 6 is marked complete.

## Phase 6 completion report

# PHASE 6 COMPLETE

**Implemented:** offline, symbolic editorial Geo Effect Layers for Impact Pulse, Strike Marker, Smoke Plume, Missile Arc, Advance/Retreat Arrow primitives, Front Line, Territory Expansion, Hotspot, Control Zone, Refugee Flow, Blockade Line, Disputed Border, and Influence Zone. All effects are serializable layer data, selectable on the canvas, View-capturable, and evaluated by the existing shared preview path.

**Tests:** `npm run build` completes successfully. Interactive verification added all twelve Geo Effect presets in a clean editor session and confirmed twelve rendered effects, twelve synchronized Layer rows, and no browser-console errors.

**Known limitations:** the current effect tool cycles through the compact starter preset library; dedicated per-effect inspector controls, richer multi-point paths, and advanced per-effect timing controls are follow-up refinement work rather than separate rendering systems.

**Next proposed phase:** Phase 7 — canvas layouts, safe areas, and Auto Reframe.
