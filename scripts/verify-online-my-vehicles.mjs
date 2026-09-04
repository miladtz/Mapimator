import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'my-vehicles-'));
const entry = join(out, 'entry.ts');
writeFileSync(entry, `export * from '${join(root, 'src/core/vehicleStyleLibrary').replaceAll('\\', '/')}';`);
let library;
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      lib: { entry, formats: ['es'], fileName: () => 'module.mjs' },
    },
  });
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  };
  library = await import(pathToFileURL(join(out, 'module.mjs')).href);
} finally {
  rmSync(out, { recursive: true, force: true });
}

const png = 'data:image/png;base64,AA==';
const webp = 'data:image/webp;base64,AA==';
const first = library.saveVehicleStyle('Convoy', png, 'convoy.png');
const second = library.saveVehicleStyle('Ship', webp, 'ship.webp');
assert.equal(library.getVehicleStyles().length, 2);
assert.ok(first.id.startsWith('vehicle-style-'));
library.renameVehicleStyle(first.id, 'Lead Convoy');
assert.equal(library.getVehicleStyles().find((entry) => entry.id === first.id).name, 'Lead Convoy');

// A fresh module read represents application/project restart: storage, not
// React state or the active Project, remains authoritative.
assert.deepEqual(
  library.getVehicleStyles().map((entry) => entry.id),
  [first.id, second.id],
);
library.deleteVehicleStyle(first.id);
assert.deepEqual(
  library.getVehicleStyles().map((entry) => entry.id),
  [second.id],
);
assert.throws(() => library.saveVehicleStyle('Unsafe', 'data:image/svg+xml;base64,AA==', 'x.svg'));

console.log('My Vehicles: persistent app-profile add/list/rename/remove and safe raster validation passed.');
