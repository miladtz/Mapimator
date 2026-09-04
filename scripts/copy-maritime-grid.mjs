import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'node_modules/@arcnautical/maritime-routing/data/ocean-grid.bin.gz');
const dstDir = join(root, 'public/assets');
// Use .bin extension (NOT .gz) to prevent HTTP servers from transparently
// decompressing the response. The package's loadGridFromBuffer() expects
// gzipped bytes and calls gunzipSync() internally.
const dst = join(dstDir, 'ocean-grid.bin');

if (existsSync(src)) {
  mkdirSync(dstDir, { recursive: true });
  if (!existsSync(dst) || !readFileSync(src).equals(readFileSync(dst))) copyFileSync(src, dst);
  console.log('Copied ocean-grid.bin.gz → public/assets/ocean-grid.bin');
} else {
  console.warn('ocean-grid.bin.gz not found in node_modules — skipping copy');
}
