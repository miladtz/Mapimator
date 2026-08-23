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

## Phase 7 completion report

# PHASE 7 COMPLETE

**Implemented:** selectable 16:9, 9:16, 1:1, 4:5, 4:3, and custom canvas layouts; persisted canvas settings; editor-only safe-area guide with toggle; and Auto Reframe for visible Layers.

**Tests:** `npm run format` and `npm run build` pass. Interactive verification switched to Portrait, toggled safe-area guides off/on, applied Auto Reframe, added a Text Layer, and created a View with no console errors.

**Next proposed phase:** Phase 8 — deterministic video export.

## Phase 8 completion report

# PHASE 8 COMPLETE

**Implemented:** deterministic rendering of evaluated project frames through the shared preview/export evaluator; direct target-layout rendering; sequential raw RGBA streaming without multi-frame buffering; application-packaged FFmpeg and companion libraries; H.264 MP4 output; automatic NVIDIA NVENC selection with libx264 fallback; progress and clean cancellation; native save dialog; and 1080p30, 1080p60, Shorts, square, portrait, and existing project-layout export support.

**Tests:** clean `npm ci`; `npm run format`; `npm run build`; `cargo check`; `cargo test`; native Tauri release build; NSIS current-user bundle; ffprobe codec, dimensions, frame-rate, duration, frame-count, and pixel-format checks; packaged NVENC initialization; controlled automatic libx264 fallback; cancellation cleanup; recovery export; and saved-project restart/reopen verification all pass.

**Manual verification:** installed the NSIS package without administrator privileges; launched the installed executable without Vite or development tooling; validated the editor with application-scoped offline hostname resolution; created and saved a representative project through the normal UI with multiple Views, Region, Arrow, English and Persian text, Impact Pulse, and camera transition; previewed before and after application restart; exported H.264 from the installed UI using its native Save dialog; visually inspected landscape and portrait frames; and confirmed the installed application used its packaged FFmpeg resources.

**Known limitations:** no 4K; H.264 MP4 only; deterministic rendering is slower than real time; automatic encoder policy is NVENC then libx264; portrait projects may require the existing layout and Auto Reframe workflow; and the current Windows installer is not code-signed.

**Next proposed phase:** Phase 9 — Portable Project Export.

# PHASE 9 COMPLETE

**Implemented:** deterministic `.mapmotionpack` export and staged import; canonical project serialization; content-addressed project-owned image packaging; semantic package and project-schema versions; installed dataset and extension compatibility registries; compatible, warning, and blocking negotiation; structured diagnostics; bounded native ZIP validation; unsafe-path protection; asset size and SHA-256 verification; transactional asset commit; and atomic project replacement after complete validation.

**Tests:** representative project save/restart/reopen and portable round-trip; canonical project equality; layer and View ordering; deterministic repeated package hashes; manifest, project, asset, dataset, and extension declarations; Milestone 1–4 package import compatibility; compatible, warning, and blocking negotiation; missing manifest; unsupported package major version; missing required dataset; missing required extension; malformed project; malformed manifest; unsafe archive path; same-size asset hash mismatch; atomic failure behavior; landscape and portrait H.264 regression exports; renderer startup; and the full frontend and native quality gates.

**Manual verification:** created a representative project with two Views, Region, Arrow, project-owned Image, English `Iraq`, Persian `ایران`, bilingual map labels, Impact Pulse, and distinct View cameras; previewed and saved it; restarted the native application and reopened it; exported, imported, and previewed the portable package; visually inspected decoded landscape and portrait video frames; confirmed correct Persian shaping, English text, image content, effect rendering, camera transitions, and absence of editor chrome; and confirmed the current project remained unchanged after every rejected import.

**Known limitations:** package compatibility currently covers the bundled starter-world dataset and has no installed optional extensions; unknown optional extensions are reported but not interpreted; portable packages contain project-owned images only; H.264 output and portrait composition retain the Phase 8 limitations; portrait projects require the existing portrait layout and composition/Auto Reframe workflow; deterministic rendering remains slower than real time; and Windows release installers remain unsigned.

**Future work:** Phase 10 may add Templates & Presets on top of the stable portable-project and deterministic-rendering foundations. Any future package schema, dataset, asset-kind, or extension changes must use the existing semantic compatibility and staged-import pipeline rather than bypassing it.

## Phase 10 progress — Milestone 1: Professional Offline Map Foundation

**Implemented:** a pinned, reproducible Natural Earth 1:50m offline world dataset with 242 country geometries, admin-0 borders, coastlines, lakes, ranked rivers, 134 major-city labels, 68 marine labels, seven continent labels, and English/Persian names where Natural Earth provides them; ranked label decluttering; legacy country-ID aliases; Dark, Light, Modern, Ink, and Terrain vector styles; and an explicit unavailable capability for satellite imagery rather than a network fallback.

**Compatibility:** existing project schema, camera state, View state, preview evaluation, deterministic renderer, H.264 exporter, saved projects, and portable package format are unchanged. The legacy starter dataset remains registered as installed for older portable packages, while new packages declare `mapmotion-natural-earth-world@1.0.0`.

**Validation:** deterministic dataset rebuild; focused map-data assertions; frontend build; compatibility matrix; Cargo check and tests; native preview/save/restart/open; Milestone 1–3 portable imports; portable round-trip and repeated package hashes; repeated PNG frame hashes; all five styles; Persian/English labels; legacy and ISO Region identifiers; and representative 1920×1080 H.264 export all pass.

**Limitations:** satellite imagery needs a separately licensed, versioned, size-bounded offline imagery pyramid; Terrain is a deterministic vector cartographic treatment rather than elevation raster relief; global-detail rendering is slower than the starter geometry; and the generated map module increases the main application bundle enough to trigger Vite's chunk-size advisory.

## Phase 10 Milestone 2 COMPLETE — Professional Camera & Navigation System

**Completed:** a professional Flat camera and navigation foundation with cursor-centered exponential wheel and touchpad zoom, click-drag panning with inertia, world constraints and edge resistance, double-click and keyboard navigation, Home-to-world, animated fit-world/country/selection/layer operations, high-precision camera state, and centralized lifecycle recovery after resize, focus loss, interrupted pointers, native dialogs, preview, and export. Camera interpolation is shared by deterministic Preview and Export through `evaluateProjectAtTime(project, time)` and supports Linear, Smooth, Cinematic, Ease In, Ease Out, Ease In-Out, and Bezier transitions.

**Views and timeline:** the fixed timeline toolbar and status bar frame a scalable horizontally scrollable View viewport with drag-and-drop ordering, explicit rename/duplicate/delete actions, exact hold and transition durations, proportional transition regions, a deterministic timeline playhead, automatic playhead scrolling, and a single Play/Pause/Stop transport state machine. Preview selection and frame evaluation use the same compiled View sequence as export.

**Workspace and input:** Layers is a true workspace toggle that removes or restores its grid column so the map resizes immediately. Map, Layers, Properties, and timeline wheel input have strict pointer-target ownership, with timeline Ctrl+wheel reserved for future timeline zoom. Responsive deterministic label LOD provides ranked collision avoidance and independent continent, ocean, country, capital, city, river, and lake visibility and styling.

**Compatibility and validation:** existing saved and portable projects remain valid because the camera state and package formats are unchanged. Flat/Globe mode selection, Preview, deterministic frame rendering, H.264 export, project-owned images, multilingual labels, Views, transitions, and effects remain integrated. Human acceptance passed, including the camera lifecycle and stuck-zoom regression. Formatting, frontend build, offline map-data validation, portable compatibility validation, Cargo check and tests, and diff validation pass on the native Windows toolchain.

**Known limitation:** Globe mode remains Beta. The current Globe implementation is a deterministic SVG orthographic renderer and is not intended to provide final GPU or Google-Earth-grade rendering and interaction performance. A future GPU-based Globe renderer remains planned behind the existing unified camera and map-mode architecture.
