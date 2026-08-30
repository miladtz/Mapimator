import { readFile } from 'node:fs/promises';

const component = await readFile(new URL('../src/components/OnlineOpenFreeMap.tsx', import.meta.url), 'utf8');
const adapter = await readFile(new URL('../src/core/openFreeMapAdapter.ts', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8');
const project = await readFile(new URL('../src/core/project.ts', import.meta.url), 'utf8');

const requireText = (source, text, message) => {
  if (!source.includes(text)) throw new Error(message);
};

for (const style of ['liberty', 'dark', 'bright']) {
  requireText(
    adapter,
    `https://tiles.openfreemap.org/styles/${style}`,
    `Missing official OpenFreeMap ${style} style URL.`,
  );
}
requireText(
  adapter,
  "{ id: '3d', label: 'OpenFreeMap 3D', url: 'https://tiles.openfreemap.org/styles/liberty' }",
  'The official 3D preset must use Liberty with a pitched MapLibre camera, not a nonexistent style URL.',
);
requireText(adapter, 'mapMotionToMapLibreCamera', 'Missing MapMotion-to-MapLibre camera adapter.');
requireText(adapter, 'mapLibreToMapMotionCamera', 'Missing MapLibre-to-MapMotion camera adapter.');
requireText(component, 'attributionControl', 'Required map attribution control is not configured.');
requireText(component, 'Online map unavailable', 'Network failure must have an explicit non-crashing state.');
requireText(app, 'Legacy Map', 'The legacy renderer switch must remain available.');
requireText(app, 'Online OpenFreeMap', 'The experimental online renderer switch is missing.');

requireText(
  project,
  "export type BasemapRenderer = 'legacy' | 'online'",
  'Canonical renderer state is missing.',
);
requireText(project, 'onlineStyleId: OnlineBasemapStyleId', 'Canonical online style state is missing.');

console.log('OpenFreeMap POC architecture verification passed.');
