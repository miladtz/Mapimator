# MapMotion Studio — Codex Instructions

## Scope

This file defines persistent engineering rules for the MapMotion Studio online experiment.

Repository:
`E:\Youmaker\Mapimator2-online`

Branch:
`experiment/openfreemap-online`

Legacy/protected worktree:
`E:\Youmaker\Mapimator2`

Protected branch:
`main`

Current Route work may be substantially uncommitted. Current source is authoritative.

---

## Git / Safety Rules

Do not:

- reset
- clean
- stash
- broadly restore
- checkout away uncommitted work
- re-clone
- merge main
- modify main
- delete intentional untracked work
- intentionally touch `.freebuff/`
- commit
- push

unless the human explicitly authorizes it.

Never commit or push before human acceptance of the current milestone.

Preserve intentional accumulated O1.17 Route work.

---

## General Working Style

Before modifying a subsystem:

1. inspect the current implementation,
2. understand existing architecture,
3. make the smallest coherent change,
4. preserve accepted behavior outside the milestone.

Do not trust old implementation reports over current source/runtime behavior.

Do not redesign unrelated features unless required to make the requested feature correct.

Prefer stable IDs over array indexes.

Prefer pure model operations for state mutations where practical.

Avoid silent fallbacks that hide failures unless the product specification explicitly requires fallback behavior.

---

## Tech Stack

- Tauri 2
- React
- TypeScript
- Rust
- MapLibre GL JS
- OpenFreeMap
- FFmpeg

Large map data remains outside Git.

---

## Canonical Rendering Architecture

Preserve the accepted canonical logical scene architecture.

Do not reintroduce viewport-dependent rendering/export behavior.

Editor, Preview, Playback, thumbnails, and Export should use equivalent canonical geographic/project state.

Do not create editor-only visual behavior that diverges from export.

Preserve:

- frame formats
- deep zoom
- Bearing
- Pitch
- native MapLibre gesture ownership
- style reload behavior
- full-world fit
- antimeridian correctness

---

## Route Product Model

One Route = one Project Layer.

A Route Point is:

- Source
- Stop
- Destination

A Section is exactly the path between two consecutive Route Points.

For N Route Points:
`Section count = N - 1`

Use user-facing term:
`Section`

Do not introduce a second canonical meaning for Segment/Section.

Internals may retain legacy `RouteSegment` naming only where migration makes it necessary.

---

## Route Identity

RoutePoint IDs are stable.

Section IDs must be based on stable adjacent RoutePoint identity, not array index.

Preferred/current strategy:
`route-section-${startPointId}-${endPointId}`

Examples:

A → B → C
Sections:

- AB
- BC

Insert X:
A → X → B → C

- AB removed
- AX new
- XB new
- BC preserved

Delete B:
A → C

- AB removed
- BC removed
- AC new

Changing coordinates preserves RoutePoint ID.

Changing geometry-generation method preserves Section ID when adjacency is unchanged.

---

## Route Planner vs Accepted Route

Route Planner / Edit Route define geometry.

`Use Route` accepts geometry into the canonical Route Layer.

After acceptance:

- rendering uses stored accepted geometry
- project appearance is separate from geometry generation
- timeline behavior is separate from geometry generation

Do not reroute during:

- Preview
- Playback
- thumbnail generation
- Export
- project load

---

## Path Types

Exactly four Planner Path Types:

- Road
- Maritime
- Air
- Custom

Path Type exists only to define how Section geometry is created.

After acceptance, Path Type must not restrict:

- line style
- arrows
- vehicles
- timeline behavior
- rendering

Do not reintroduce canonical:

- Car
- Truck
- Plane
- Vessel
- Train
- Flow
- Physical Route
- Abstract Flow

---

## Road

Road routing uses the existing OpenRouteService architecture:

React
→ Tauri invoke
→ Rust reqwest
→ ORS
→ normalized geometry

Preserve:

- native credential handling
- no frontend ORS fetch
- no API key in project files
- no API key in logs
- no rerouting during output

Do not rewrite working ORS architecture without a proven reason.

---

## Maritime

Normal Maritime behavior is intentionally approximate.

Use the raw/local ArcNautical maritime route as a reference generator.

Normal Maritime calculation should not depend on:

- OpenFreeMap coastline refinement
- coastal tile fetching
- local detailed A*
- land-crossing validation
- naturalness optimization

It is acceptable for raw Maritime geometry to:

- be angular
- cross small land/islands
- hug coastlines
- be approximate

UI should communicate:
`Maritime — Approximate`

Maritime can be converted to Custom for manual correction.

Do not re-enter maritime refinement R&D unless explicitly requested.

---

## Maritime → Custom

Conversion:

- preserves Route Layer ID
- preserves Section ID
- preserves Source/Destination
- changes Path Type to Custom
- creates editable Custom control points
- keeps the broad visible route shape

Do not expose every dense Maritime sample as an editable control.

Use deterministic simplification/control extraction.

---

## Custom Path

Custom is user-authored geometry.

Supported:

- Exact
- Smooth
- Draw/Edit/Clear
- control-point drag
- control-point insert/delete
- Backspace
- Escape cancel
- Finish
- antimeridian-safe geometry
- persistence

Custom intermediate points are geographic `[longitude, latitude]`.

Source and Destination are authoritative Section endpoints.

Custom must not run Maritime land validation.

A Custom path may intentionally cross land or represent abstract/storytelling movement.

---

## Custom Points as Stops

Custom authored intermediate control points may be promoted to canonical Route Stops.

Promoted Custom control point and RoutePoint must have a stable relationship.

Once promoted:

- RoutePoint coordinate is authoritative
- Custom geometry uses that RoutePoint at the boundary

Removing a promoted Stop should restore the position as an ordinary Custom control point where applicable.

Adding Stops from a Custom path must preserve overall visible route geometry as closely as possible.

Stops are inserted in path order, not checkbox click order.

---

## Air

Air supports:

- Great Circle
- Direct

Great Circle:

- true spherical interpolation
- deterministic
- exact endpoints
- antimeridian-safe
- visually arcs appropriately on Mercator

Direct:

- intentional simple storytelling connection
- not a fallback

No external API is required for Air.

---

## Edit Route

Accepted Route Properties exposes:
`Edit Route`

Edit Route:

- reconstructs Planner from persisted RouteDefinition
- works on an isolated draft
- keeps accepted canonical Route unchanged until `Use Route`

Cancel:

- discards draft
- leaves canonical project state unchanged

Use Route:

- updates the SAME Route Layer ID
- preserves layer ordering
- preserves selection
- preserves unchanged Section IDs
- preserves unchanged Section metadata/timeline usage

Do not duplicate Route Layers during repeated Edit → Use cycles.

---

## Route Appearance

Project-level fixed appearance belongs to Sections.

Each Section may independently own:

- line color
- width
- opacity
- line style
- arrow style
- future fixed appearance properties

Appearance must be PathType-independent.

Project-level `Apply to all sections` copies only fixed appearance.

It must never copy:

- geometry
- Path Type
- generator settings
- timeline properties

---

## Route Timeline — Future/Separate Concern

Do not mix project appearance with timeline behavior.

Section timeline behavior is handled separately.

Future/current timeline concepts include:

- Section existence
- Appear
- Draw Route
- Vehicle
- Wipe Out
- timing
- timeline Apply to All

Do not introduce these into project-level appearance unless the milestone explicitly asks for them.

---

## Section Existence Rule

When the timeline milestone is implemented:

`RouteExists = any(SectionExists)`

Parent Route checkbox behavior:

- check parent → all Sections true
- explicitly uncheck parent → all Sections false
- turning off one Section keeps Route true while any Section remains true
- final Section off → parent Route false

Do not implement this early unless explicitly requested.

---

## Vehicles

Vehicles belong only to View/Transition timeline usage.

Vehicle choice must not depend on original Path Type.

Do not place Vehicle controls in project-level Route appearance.

---

## Persistence

Persist:

- RouteDefinition
- stable RoutePoints
- stable Section definitions
- accepted Section geometry
- Custom control points
- promoted Stop relationships
- Air generation settings
- relevant project appearance
- timeline usage in its proper model

Save/reload must not regenerate accepted geometry.

---

## Regression Philosophy

Existing accepted behavior is regression-locked.

For each milestone:

- add focused tests for new behavior
- add tests for dangerous invariants
- run relevant existing suites

Do not create huge test matrices unless the milestone genuinely needs them.

Prioritize explicit regression tests for:

- stable IDs
- canonical geometry persistence
- no duplicate Route Layer
- no unexpected project mutation
- output parity
- parent/child timeline synchronization
- deterministic animation/timing

---

## Standard Validation

Unless the milestone says otherwise, run:

- `npm run format`
- `npm run build`
- focused tests for touched subsystem
- relevant existing Route/render/persistence regressions
- `cargo check`
- `cargo test`
- `git diff --check`

Do not run unrelated expensive tests merely to satisfy a generic checklist if existing focused/regression coverage is sufficient.

---

## Human Acceptance

Automated tests do not replace human visual review for:

- map geometry quality
- styling
- interaction UX
- animation
- export parity

Leave the native app ready for human review when practical.

Do not call a visual milestone accepted before human confirmation.

---

## Milestone Completion

At the end of a milestone:

STOP.

Do not commit.
Do not push.

Report concisely:

- what changed
- architecture decisions
- key validation results
- files changed
- blockers
- HEAD
- confirmation: no commit/push/main modification
- whether native app is ready for human review

Do not continue into the next milestone automatically.
