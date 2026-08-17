# MapMotion Studio — Product Specification

## Product premise

MapMotion Studio is an offline-first Windows desktop editor for creating professional geopolitical map animations. It is aimed at documentary and YouTube creators, not GIS specialists or motion-graphics experts.

# OFFLINE FIRST

After the initial installation, maps, search, labels, layers, views, previews, saves, and eventual video exports must work with no internet connection. It must not use cloud maps, online geocoding, remote fonts, mandatory accounts, or server-side rendering.

# VIEWS + LAYERS FIRST

The normal workflow is: add layers, arrange the map, create a view, change the scene, create the next view, then let MapMotion animate the transition. Creators make scenes; they should not need to manage keyframes.

## Phase 1 scope (implemented now)

- A Tauri-ready React/TypeScript/Vite editor foundation.
- Compact desktop layout: top bar, project area, map canvas, contextual properties, preview controls, and a future Views strip.
- Offline local vector basemap with country borders and English country labels.
- Pan and zoom, plus dark and light documentary styles.
- Localized UI architecture with English and Persian dictionaries and direction switching.
- New project, local save, and local open foundation.

## Deferred product requirements

Future phases add editable Layers, fully shaped Persian/Arabic text, Views and the ViewCompiler, automatic transitions, geopolitical effects, canvas layouts, deterministic FFmpeg video rendering, portable `.mapmotionpack` archives, templates, and an optional advanced timeline.

## Product constraints

- First desktop target is Windows with a per-user installer; bundled fonts must never be installed system-wide.
- Core project, layer, view, animation, map-state, and layout modules remain platform independent. Native services are accessed through adapters.
- V1 is flat-map only. It supports 1080p-class canvas sizes and no 4K export.
- Standard styles are configuration presets over shared offline map data.
- Project format is versioned `.mapmotion` with migrations from the outset.

## UX principles

The editor must be dark-friendly, compact, clear, and professional. The left panel answers “what exists?”, the center “what does it look like?”, the right “how do I customize it?”, and the bottom “what scenes make up the animation?”. Controls must be useful rather than speculative placeholders.
