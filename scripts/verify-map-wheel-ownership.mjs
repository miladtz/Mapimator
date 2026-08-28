import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const map = readFileSync(join(root, 'src/components/OfflineMap.tsx'), 'utf8');
const globe = readFileSync(join(root, 'src/components/WebGLGlobe.tsx'), 'utf8');
const widget = readFileSync(join(root, 'src/components/CameraOrbitControl.tsx'), 'utf8');

assert.match(map, /className="map-navigation-viewport"/);
assert.match(map, /ref=\{viewportRef\}/);
assert.match(map, /viewport\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/);
assert.equal((map.match(/addEventListener\('wheel'/g) ?? []).length, 1, 'one persistent wheel listener');
assert.doesNotMatch(globe, /addEventListener\('wheel'/, 'renderer owns no competing wheel listener');
assert.match(map, /mapModeRef\.current/);
assert.match(map, /mode === 'globe'/);
assert.match(map, /event\.ctrlKey \|\| event\.altKey/);
assert.match(map, /event\.preventDefault\(\)/);
assert.match(map, /event\.stopPropagation\(\)/);
assert.match(map, /input, select, textarea, \[data-map-wheel-exempt="true"\]/);
assert.match(widget, /data-map-wheel-exempt="true"/);
assert.doesNotMatch(map, /activeElement|mapHasFocus|hasFocus/);
assert.match(map, /cursor: interactionEnabled \? 'grab' : 'default'/);
assert.match(map, /style\.cursor = 'grabbing'/);
assert.match(globe, /cursor: interactionEnabled \? 'grab' : 'default'/);
assert.match(globe, /style\.cursor = 'grabbing'/);

console.log('Persistent focusless map wheel ownership verification passed.');
