import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const offlineMap = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
const globe = readFileSync(join(root, 'src/components/WebGLGlobe.tsx'), 'utf8');
const renderer = readFileSync(join(root, 'src/core/globeRenderer.ts'), 'utf8');

assert.match(offlineMap, /if \(mapMode !== 'flat'\) return;[\s\S]*ResizeObserver/);
assert.match(offlineMap, /observer\.disconnect\(\)/);
assert.match(offlineMap, /\[cancelActiveCameraInteraction, mapMode\]/);
assert.match(offlineMap, /viewport\.addEventListener\('wheel'[\s\S]*viewport\.removeEventListener\('wheel'/);
assert.match(offlineMap, /mapModeRef\.current = mapMode/);
assert.match(offlineMap, /if \(mapMode === 'globe'\)[\s\S]*<WebGLGlobe/);

assert.match(globe, /getBoundingClientRect\(\)[\s\S]*canvas\.width = measured\.width/);
assert.match(globe, /canvas\.height = measured\.height[\s\S]*new GlobeWebGLRenderer\(canvas\)/);
assert.match(globe, /const forceRender = useCallback[\s\S]*cancelAnimationFrame/);
assert.match(globe, /if \(changed\) forceRender\(\)/);
assert.match(globe, /observer\.disconnect\(\)/);
assert.match(globe, /removeEventListener\('webglcontextlost'/);
assert.match(globe, /removeEventListener\('webglcontextrestored'/);
assert.match(globe, /rendererRef\.current\?\.dispose\(\)/);
assert.match(globe, /dragRef\.current = null/);
assert.match(globe, /Globe renderer unavailable\./);

assert.match(renderer, /canvas\.width <= 1 \|\| this\.canvas\.height <= 1/);
assert.match(renderer, /this\.gl\.isContextLost\(\)/);
assert.match(renderer, /Globe shader compilation failed/);
assert.match(renderer, /Globe shader link failed/);
assert.match(renderer, /gl\.getError\(\)/);
assert.match(renderer, /gl\.viewport\(0, 0, this\.canvas\.width, this\.canvas\.height\)/);
assert.match(renderer, /gl\.clear\(gl\.COLOR_BUFFER_BIT \| gl\.DEPTH_BUFFER_BIT\)/);
assert.match(renderer, /gl\.enable\(gl\.DEPTH_TEST\)/);
assert.match(renderer, /gl\.enable\(gl\.CULL_FACE\)/);

console.log('Globe lifecycle verification passed.');
