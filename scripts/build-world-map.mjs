import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourceDirectory = process.argv[2] ?? 'dist-portable/natural-earth-50m';
const outputPath = process.argv[3] ?? 'src/data/worldMap.ts';
const DATASET_VERSION = '1.0.0';
const NATURAL_EARTH_VERSION = '5.1.x';
const SOURCE_REVISION = 'ca96624a56bd078437bca8184e78163e5039ad19';

const sources = {
  countries: 'ne_50m_admin_0_countries.geojson',
  borders: 'ne_50m_admin_0_boundary_lines_land.geojson',
  coastlines: 'ne_50m_coastline.geojson',
  lakes: 'ne_50m_lakes.geojson',
  rivers: 'ne_50m_rivers_lake_centerlines_scale_rank.geojson',
  cities: 'ne_50m_populated_places.geojson',
  marine: 'ne_50m_geography_marine_polys.geojson',
};

const legacyIds = {
  AUS: 'australia',
  BRA: 'brazil',
  CAN: 'canada',
  CHN: 'china',
  DEU: 'germany',
  EGY: 'egypt',
  FRA: 'france',
  GBR: 'uk',
  IND: 'india',
  IRN: 'iran',
  IRQ: 'iraq',
  JPN: 'japan',
  MEX: 'mexico',
  NGA: 'nigeria',
  RUS: 'russia',
  SAU: 'saudi',
  TUR: 'turkey',
  USA: 'usa',
  ZAF: 'south-africa',
};

const round = (value) => Number(value.toFixed(1));
const project = ([longitude, latitude]) => [round(((longitude + 180) / 360) * 1000), round(((90 - latitude) / 180) * 560)];
const pointText = (point) => point.join(' ');

const linePath = (coordinates, close = false) => {
  const projected = coordinates.map(project).filter((point, index, points) => index === 0 || pointText(point) !== pointText(points[index - 1]));
  if (projected.length < 2) return '';
  return `M${pointText(projected[0])}${projected.slice(1).map((point) => `L${pointText(point)}`).join('')}${close ? 'Z' : ''}`;
};

const geometryPath = (geometry) => {
  if (!geometry) return '';
  if (geometry.type === 'Polygon') return geometry.coordinates.map((ring) => linePath(ring, true)).join('');
  if (geometry.type === 'MultiPolygon')
    return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => linePath(ring, true))).join('');
  if (geometry.type === 'LineString') return linePath(geometry.coordinates);
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map((line) => linePath(line)).join('');
  throw new Error(`Unsupported Natural Earth geometry: ${geometry.type}`);
};

const coordinatesFor = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') return geometry.coordinates;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
};

const geometryCenter = (geometry) => {
  const coordinates = coordinatesFor(geometry);
  const longitudes = coordinates.map((coordinate) => coordinate[0]);
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  return project([(Math.min(...longitudes) + Math.max(...longitudes)) / 2, (Math.min(...latitudes) + Math.max(...latitudes)) / 2]);
};

const slug = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\w]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

const cleanName = (value, fallback) => {
  const text = String(value ?? '').trim();
  return text && text !== '-99' ? text : fallback;
};

const load = async (filename) => {
  const sourcePath = path.join(sourceDirectory, filename);
  let bytes;
  try {
    bytes = await readFile(sourcePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const response = await fetch(
      `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${SOURCE_REVISION}/geojson/${filename}`,
    );
    if (!response.ok) throw new Error(`Unable to download ${filename}: ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, bytes);
  }
  return {
    json: JSON.parse(bytes.toString('utf8')),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

const loaded = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([key, filename]) => [key, await load(filename)])));

const countries = loaded.countries.json.features
  .map((feature) => {
    const properties = feature.properties;
    const isoA3 = cleanName(properties.ISO_A3, cleanName(properties.ADM0_A3, properties.SOV_A3));
    const name = cleanName(properties.NAME_EN, properties.NAME).toUpperCase();
    const id = legacyIds[isoA3] ?? isoA3.toLowerCase();
    const label = project([Number(properties.LABEL_X), Number(properties.LABEL_Y)]);
    const countryPath = geometryPath(feature.geometry);
    const aliases = [...new Set([id, isoA3, properties.ISO_A2, properties.ADM0_A3, slug(properties.NAME_EN), slug(properties.NAME)])]
      .filter((value) => value && value !== '-99')
      .map(String);
    return {
      id,
      isoA3,
      aliases,
      name,
      nameFa: cleanName(properties.NAME_FA, name),
      label,
      labelRank: Number(properties.LABELRANK ?? 9),
      path:
        countryPath ||
        `M${label[0] - 0.7} ${label[1]}L${label[0]} ${label[1] - 0.7}L${label[0] + 0.7} ${label[1]}L${label[0]} ${label[1] + 0.7}Z`,
    };
  })
  .sort((left, right) => left.id.localeCompare(right.id));

const physicalPath = (collection, predicate = () => true) => collection.features.filter(predicate).map((feature) => geometryPath(feature.geometry)).join('');
const riverRanks = [
  physicalPath(loaded.rivers.json, (feature) => Number(feature.properties.scalerank ?? 99) <= 2),
  physicalPath(loaded.rivers.json, (feature) => Number(feature.properties.scalerank ?? 99) > 2 && Number(feature.properties.scalerank ?? 99) <= 5),
  physicalPath(loaded.rivers.json, (feature) => Number(feature.properties.scalerank ?? 99) > 5 && Number(feature.properties.scalerank ?? 99) <= 7),
];

const cities = loaded.cities.json.features
  .filter((feature) => Number(feature.properties.SCALERANK) <= 1 || (Number(feature.properties.ADM0CAP) === 1 && Number(feature.properties.POP_MAX) >= 1_000_000))
  .map((feature) => {
    const properties = feature.properties;
    const name = cleanName(properties.NAME_EN, properties.NAME);
    return {
      id: String(properties.NE_ID),
      name,
      nameFa: cleanName(properties.NAME_FA, name),
      point: project(feature.geometry.coordinates),
      capital: Number(properties.ADM0CAP) === 1,
      rank: Number(properties.SCALERANK),
    };
  })
  .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));

const marineLabels = loaded.marine.json.features
  .filter((feature) => feature.properties.featurecla === 'ocean' || (['sea', 'gulf', 'bay'].includes(feature.properties.featurecla) && Number(feature.properties.scalerank) <= 3))
  .map((feature) => {
    const properties = feature.properties;
    const name = cleanName(properties.name_en, properties.name).toUpperCase();
    return {
      id: String(properties.ne_id),
      name,
      nameFa: cleanName(properties.name_fa, name),
      point: geometryCenter(feature.geometry),
      kind: properties.featurecla,
      rank: Number(properties.scalerank),
    };
  })
  .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name));

const continentLabels = [
  { id: 'north-america', name: 'NORTH AMERICA', nameFa: 'آمریکای شمالی', point: project([-105, 48]) },
  { id: 'south-america', name: 'SOUTH AMERICA', nameFa: 'آمریکای جنوبی', point: project([-61, -19]) },
  { id: 'europe', name: 'EUROPE', nameFa: 'اروپا', point: project([17, 52]) },
  { id: 'africa', name: 'AFRICA', nameFa: 'آفریقا', point: project([20, 5]) },
  { id: 'asia', name: 'ASIA', nameFa: 'آسیا', point: project([88, 46]) },
  { id: 'oceania', name: 'OCEANIA', nameFa: 'اقیانوسیه', point: project([135, -22]) },
  { id: 'antarctica', name: 'ANTARCTICA', nameFa: 'قطب جنوب', point: project([0, -78]) },
];

const provenance = Object.entries(sources).map(([key, filename]) => ({ key, filename, sha256: loaded[key].sha256 }));
const serialized = (value) => JSON.stringify(value);
const output = `// Generated by scripts/build-world-map.mjs from Natural Earth public-domain 1:50m data.\n// Do not edit by hand; rebuild from the pinned source revision documented in src/data/NATURAL_EARTH.md.\n\nexport const WORLD_MAP_DATASET = ${serialized({ id: 'mapmotion-natural-earth-world', version: DATASET_VERSION, naturalEarthVersion: NATURAL_EARTH_VERSION, sourceRevision: SOURCE_REVISION, scale: '1:50m', license: 'Public domain', provenance })} as const;\n\nexport interface MapCountry { id: string; isoA3: string; aliases: string[]; name: string; nameFa: string; label: [number, number]; labelRank: number; path: string; }\nexport interface MapLabel { id: string; name: string; nameFa: string; point: [number, number]; rank?: number; kind?: string; capital?: boolean; }\n\nexport const COUNTRIES: MapCountry[] = ${serialized(countries)};\nexport const COASTLINE_PATH = ${serialized(physicalPath(loaded.coastlines.json))};\nexport const COUNTRY_BORDER_PATH = ${serialized(physicalPath(loaded.borders.json))};\nexport const LAKE_PATH = ${serialized(physicalPath(loaded.lakes.json))};\nexport const RIVER_PATHS = ${serialized(riverRanks)};\nexport const CITY_LABELS: MapLabel[] = ${serialized(cities)};\nexport const MARINE_LABELS: MapLabel[] = ${serialized(marineLabels)};\nexport const CONTINENT_LABELS: MapLabel[] = ${serialized(continentLabels)};\n\nconst COUNTRY_LOOKUP = new Map(COUNTRIES.flatMap((country) => country.aliases.map((alias) => [alias.toLowerCase(), country] as const)));\nexport const findCountry = (id: string | undefined) => (id ? COUNTRY_LOOKUP.get(id.toLowerCase()) : undefined);\n`;

await writeFile(outputPath, output, 'utf8');
console.log(`Wrote ${outputPath}: ${countries.length} countries, ${cities.length} cities, ${marineLabels.length} marine labels.`);
