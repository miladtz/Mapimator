import assert from 'node:assert/strict';
import { BASEMAP_CAPABILITIES, createProject, MAP_STYLES } from '../src/core/project.ts';
import { validateAndMigrateProject } from '../src/core/projectPersistence.ts';
import {
  CITY_LABELS,
  COASTLINE_PATH,
  CONTINENT_LABELS,
  COUNTRIES,
  COUNTRY_BORDER_PATH,
  findCountry,
  LAKE_PATH,
  MARINE_LABELS,
  RIVER_PATHS,
  WORLD_MAP_DATASET,
} from '../src/data/worldMap.ts';

assert.equal(WORLD_MAP_DATASET.id, 'mapmotion-natural-earth-world');
assert.equal(WORLD_MAP_DATASET.scale, '1:50m');
assert.equal(WORLD_MAP_DATASET.provenance.length, 7);
assert.equal(COUNTRIES.length, 242);
assert.ok(COUNTRIES.every((country) => country.path.startsWith('M') && country.aliases.length >= 2));
assert.equal(findCountry('iran')?.isoA3, 'IRN');
assert.equal(findCountry('IRN')?.id, 'iran');
assert.equal(findCountry('usa')?.isoA3, 'USA');
assert.equal(findCountry('GBR')?.id, 'uk');
assert.equal(findCountry('IRN')?.nameFa, 'ایران');
assert.equal(CITY_LABELS.find((city) => city.name === 'Tehran')?.nameFa, 'تهران');
assert.ok(CITY_LABELS.length >= 100);
assert.equal(CONTINENT_LABELS.length, 7);
assert.ok(MARINE_LABELS.some((label) => label.kind === 'ocean'));
assert.ok(COASTLINE_PATH.length > 100_000);
assert.ok(COUNTRY_BORDER_PATH.length > 50_000);
assert.ok(LAKE_PATH.length > 50_000);
assert.equal(RIVER_PATHS.length, 3);
assert.ok(RIVER_PATHS.every((path) => path.length > 1_000));

assert.deepEqual(
  MAP_STYLES.map((style) => style.id),
  ['documentary-dark', 'documentary-light', 'modern', 'ink', 'terrain'],
);
assert.equal(BASEMAP_CAPABILITIES.find((capability) => capability.id === 'satellite')?.available, false);
for (const style of MAP_STYLES) {
  const project = createProject('Style compatibility');
  project.mapSettings.styleId = style.id;
  assert.equal(validateAndMigrateProject(project).mapSettings.styleId, style.id);
}

console.log(
  `World map validation: ${COUNTRIES.length} countries, ${CITY_LABELS.length} cities, ${MARINE_LABELS.length} marine labels, ${MAP_STYLES.length} styles passed.`,
);
