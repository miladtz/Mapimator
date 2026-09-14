import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const SOURCE_VERSION = 'v6.0.0';
const SOURCE_COMMIT = '1289e40e366c7b320550be1ee0614a9472d572d4';
const MAPSHAPER_VERSION = '0.7.61';
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const sourceDir = positional[0] ?? 'E:/Youmaker/MapData/sources/geoboundaries-v6.0.0-gbopen-adm1';
const workDir = positional[1] ?? 'E:/Youmaker/MapData/processed/geoboundaries-v6.0.0-gbopen-adm1';
const outputDir = positional[2] ?? 'public/map-data/gbopen-adm1-v6';
const processedPath = path.join(workDir, 'adm1.processed.geojson');
const processedCountryDir = path.join(workDir, 'countries');
const execFileAsync = promisify(execFile);

const stableStringify = (value) => JSON.stringify(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const normalizeText = (value) => String(value ?? '').normalize('NFC').trim();
const boundaryId = (properties) =>
  `gbopen-v6-adm1-${normalizeText(properties.shapeGroup).toLowerCase()}-${normalizeText(properties.shapeID).toLowerCase()}`;

const sourceFiles = (await readdir(sourceDir)).filter((name) => name.endsWith('.geojson')).sort();
if (sourceFiles.length !== 198) throw new Error(`Expected 198 pinned ADM1 files, found ${sourceFiles.length}.`);

const rawBySourceId = new Map();
const sourceHasher = createHash('sha256');
let rawBytes = 0;
let sourceVertices = 0;
let sourcePolygons = 0;
let sourceHoles = 0;
let sourceMultipolygons = 0;
for (const name of sourceFiles) {
  const bytes = await readFile(path.join(sourceDir, name));
  sourceHasher.update(name).update('\0').update(bytes);
  rawBytes += bytes.length;
  const collection = JSON.parse(bytes);
  for (const feature of collection.features) {
    rawBySourceId.set(normalizeText(feature.properties.shapeID), feature);
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    if (feature.geometry.type === 'MultiPolygon') sourceMultipolygons++;
    sourcePolygons += polygons.length;
    for (const polygon of polygons) {
      sourceHoles += Math.max(0, polygon.length - 1);
      for (const ring of polygon) sourceVertices += ring.length;
    }
  }
}

if (process.argv.includes('--preprocess')) {
  await mkdir(processedCountryDir, { recursive: true });
  const cli = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  let cursor = 0;
  const worker = async () => {
    while (cursor < sourceFiles.length) {
      const name = sourceFiles[cursor++];
      await execFileAsync(cli, [
        '--yes', `mapshaper@${MAPSHAPER_VERSION}`,
        path.join(sourceDir, name), '-simplify', '30%', 'weighted', 'keep-shapes',
        '-o', 'format=geojson', 'precision=0.00001', path.join(processedCountryDir, name),
      ], { windowsHide: true, shell: process.platform === 'win32', maxBuffer: 10 * 1024 * 1024 });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

const countryOutputs = await readdir(processedCountryDir).catch(() => []);
const processedFeatures = [];
let processedInputBytes = 0;
for (const name of sourceFiles) {
  const source = countryOutputs.includes(name) ? path.join(processedCountryDir, name) : processedPath;
  const bytes = await readFile(source);
  processedInputBytes += bytes.length;
  const collection = JSON.parse(bytes);
  processedFeatures.push(...collection.features);
  if (source === processedPath) break;
}
const processed = { type: 'FeatureCollection', features: processedFeatures };
if (processed.features.length !== rawBySourceId.size)
  throw new Error(`Feature count changed: ${rawBySourceId.size} -> ${processed.features.length}.`);

const normalized = processed.features.map((feature) => {
  const properties = feature.properties ?? {};
  const sourceId = normalizeText(properties.shapeID);
  const geometry = feature.geometry ?? rawBySourceId.get(sourceId)?.geometry;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type))
    throw new Error(`Missing Polygon/MultiPolygon geometry for ${sourceId}.`);
  return {
    id: boundaryId(properties),
    sourceId,
    source: 'geoBoundaries-gbOpen',
    sourceVersion: SOURCE_VERSION,
    countryCode: normalizeText(properties.shapeGroup).toUpperCase(),
    adminLevel: 1,
    name: normalizeText(properties.shapeName),
    iso3166_2: normalizeText(properties.shapeISO) || undefined,
    geometry,
  };
});
normalized.sort((a, b) => a.id.localeCompare(b.id));
if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) throw new Error('Duplicate canonical IDs.');

const countries = new Map();
for (const boundary of normalized) {
  const current = countries.get(boundary.countryCode) ?? [];
  current.push(boundary);
  countries.set(boundary.countryCode, current);
}

await mkdir(path.join(outputDir, 'countries'), { recursive: true });
const index = [];
let runtimeBytes = 0;
let runtimeGzipBytes = 0;
let processedVertices = 0;
let multipolygons = 0;
let holes = 0;
let polygonsCount = 0;
const datelineCases = [];
let largest = { id: '', vertices: 0, bytes: 0 };
for (const [countryCode, boundaries] of [...countries].sort(([a], [b]) => a.localeCompare(b))) {
  for (const boundary of boundaries) {
    const polygons = boundary.geometry.type === 'Polygon' ? [boundary.geometry.coordinates] : boundary.geometry.coordinates;
    if (boundary.geometry.type === 'MultiPolygon') multipolygons++;
    let vertices = 0;
    let minLongitude = 180;
    let maxLongitude = -180;
    polygonsCount += polygons.length;
    for (const polygon of polygons) {
      holes += Math.max(0, polygon.length - 1);
      for (const ring of polygon) {
        vertices += ring.length;
        for (const [longitude] of ring) {
          minLongitude = Math.min(minLongitude, longitude);
          maxLongitude = Math.max(maxLongitude, longitude);
        }
      }
    }
    if (maxLongitude - minLongitude > 180) datelineCases.push(boundary.id);
    processedVertices += vertices;
    const featureBytes = Buffer.byteLength(stableStringify(boundary.geometry));
    if (vertices > largest.vertices) largest = { id: boundary.id, vertices, bytes: featureBytes };
    index.push({
      id: boundary.id,
      sourceId: boundary.sourceId,
      countryCode,
      name: boundary.name,
      iso3166_2: boundary.iso3166_2,
      asset: `countries/${countryCode}.json`,
    });
  }
  const payload = Buffer.from(stableStringify(boundaries));
  runtimeBytes += payload.length;
  runtimeGzipBytes += gzipSync(payload, { level: 9, mtime: 0 }).length;
  await writeFile(path.join(outputDir, 'countries', `${countryCode}.json`), payload);
}

const indexPayload = Buffer.from(stableStringify(index));
runtimeBytes += indexPayload.length;
runtimeGzipBytes += gzipSync(indexPayload, { level: 9, mtime: 0 }).length;
await writeFile(path.join(outputDir, 'index.json'), indexPayload);
const manifest = {
  datasetId: 'mapmotion-gbopen-adm1-v6',
  source: 'geoBoundaries gbOpen',
  sourceVersion: SOURCE_VERSION,
  sourceCommit: SOURCE_COMMIT,
  sourceDate: '2023-09-14',
  sourceUrl: `https://github.com/wmgeolab/geoBoundaries/releases/tag/${SOURCE_VERSION}`,
  license: 'CC BY 4.0',
  attribution: 'Administrative boundaries: geoBoundaries gbOpen (CC BY 4.0).',
  mapshaperVersion: MAPSHAPER_VERSION,
  sourceChecksum: sourceHasher.digest('hex'),
  sourceFiles: sourceFiles.length,
  sourceEntities: rawBySourceId.size,
  processedEntities: normalized.length,
  sourceVertices,
  sourcePolygons,
  sourceHoles,
  sourceMultipolygons,
  processedVertices,
  rawBytes,
  processedInputBytes,
  runtimeBytes,
  runtimeGzipBytes,
  multipolygons,
  polygons: polygonsCount,
  holes,
  datelineCases,
  largest,
  indexSha256: sha256(indexPayload),
};
await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
