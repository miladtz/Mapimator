import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = (path) => readFileSync(join(root, path), 'utf8');
const interactive = source('src/components/OnlineOpenFreeMap.tsx');
const viewport = source('src/core/projectRenderViewport.ts');
const styles = source('src/styles/global.css');
const renderer = source('src/core/onlineMapFrameRenderer.ts');

assert.match(viewport, /width: 960/);
assert.match(viewport, /height: 540/);
assert.match(interactive, /className="online-map-display-frame"/);
assert.match(interactive, /display\.style\.width = `\$\{fit\.displayWidth\}px`/);
assert.match(interactive, /display\.style\.height = `\$\{fit\.displayHeight\}px`/);
assert.match(interactive, /container\.style\.transform = `scale\(\$\{scale\}\)`/);
assert.match(styles, /\.online-map-display-frame\s*\{[\s\S]*?overflow: hidden/);
assert.match(styles, /\.online-map-poc\s*\{[\s\S]*?align-items: center[\s\S]*?justify-content: center/);
assert.match(
  styles,
  /\.online-map-navigation\s*\{[\s\S]*?position: absolute[\s\S]*?top: 10px[\s\S]*?right: 10px/,
);
assert.match(interactive, /aria-label="Zoom in"/);
assert.match(interactive, /aria-label="Zoom out"/);
assert.match(interactive, /lastFitSignature/);
assert.match(interactive, /value\.toFixed\(3\)/, 'Resize feedback uses a stable epsilon signature.');
assert.doesNotMatch(
  interactive.slice(
    interactive.indexOf('const resizeObserver'),
    interactive.indexOf('return () =>', interactive.indexOf('const resizeObserver')),
  ),
  /map\.resize|jumpTo|onCameraChange/,
  'Display-only resize does not mutate MapLibre logical layout or camera.',
);
assert.match(interactive, /interactivePixelRatioForDisplay/);
assert.match(interactive, /displayScale \* devicePixelRatio/);
assert.match(interactive, /ONLINE_INTERACTIVE_MIN_PIXEL_RATIO = 0\.75/);
assert.match(interactive, /ONLINE_INTERACTIVE_MAX_PIXEL_RATIO = 1\.25/);
assert.match(interactive, /requestAnimationFrame/);
assert.match(interactive, /CAMERA_SYNC_INTERVAL_MS = 32/);
assert.match(interactive, /map\.on\('moveend', finishCameraSync\)/);
assert.match(interactive, /nativeCameraSignaturesRef/);
assert.match(interactive, /nativeCameraSignaturesRef\.current\.delete\(signature\)/);
assert.match(
  interactive,
  /if \(nativeCameraSignaturesRef\.current\.delete\(signature\)\) \{[\s\S]*?return;/,
  'MapLibre-originated telemetry is consumed before the external jumpTo path.',
);
assert.match(interactive, /cameraRef\.current\.bearing/);
assert.match(styles, /\.online-map-status\s*\{[\s\S]*?pointer-events: none/);
assert.doesNotMatch(styles, /\.online-map-display-frame\s*\{[^}]*pointer-events: none/);
assert.match(
  renderer,
  /projectRenderViewport\(project\)/,
  'Locked Export canonical scene remains project viewport based.',
);
assert.match(renderer, /ONLINE_EXPORT_PIXEL_RATIO = 1\.5/);

console.log(
  'Online interactive layout/performance: fixed 960x540 logical scene, fitted outer wrapper, contained transform, screen-space controls, stable resize, adaptive DPR, coalesced camera sync, and locked Export contract passed.',
);
