import assert from 'node:assert/strict';
import {
  compareSemanticVersions,
  evaluatePortableProjectCompatibility,
  parseSemanticVersion,
} from '../src/core/compatibility.ts';

const dataset = (version = '0.1.0', installed = true) => ({
  id: 'mapmotion-offline-starter-world',
  version,
  displayName: 'MapMotion Offline Starter World',
  required: true,
  installed,
});
const manifest = (patch = {}) => ({
  packageVersion: '2.0.0',
  projectSchemaVersion: '1.0.0',
  requiredDataPackages: [{ id: 'mapmotion-offline-starter-world', version: '0.1.0', required: true }],
  extensions: [],
  ...patch,
});
const evaluate = (patch = {}, datasets = [dataset()], extensions = []) =>
  evaluatePortableProjectCompatibility(manifest(patch), datasets, extensions);
const has = (result, code) => result.diagnostics.some((diagnostic) => diagnostic.code === code);

assert.equal(evaluate().category, 'COMPATIBLE');
assert.equal(evaluate({ packageVersion: 1 }).category, 'COMPATIBLE_WITH_WARNING');
assert.ok(has(evaluate({ packageVersion: 1 }), 'LEGACY_PACKAGE_VERSION'));
assert.ok(has(evaluate({ packageVersion: '2.1.0' }), 'NEWER_PACKAGE_MINOR'));
assert.equal(evaluate({}, [dataset('0.2.0')]).category, 'COMPATIBLE_WITH_WARNING');
assert.ok(has(evaluate({}, [dataset('0.2.0')]), 'INSTALLED_DATASET_NEWER'));
assert.equal(
  evaluate({ requiredDataPackages: [{ id: dataset().id, version: '0.2.0', required: true }] }).category,
  'INCOMPATIBLE',
);
assert.equal(evaluate({}, []).category, 'INCOMPATIBLE');
assert.ok(has(evaluate({}, []), 'MISSING_REQUIRED_DATASET'));
assert.equal(
  evaluate({ requiredDataPackages: [{ id: 'optional-history', version: '1.0.0', required: false }] }, [])
    .category,
  'COMPATIBLE_WITH_WARNING',
);
assert.ok(
  has(
    evaluate({ requiredDataPackages: [{ id: 'optional-history', version: '1.0.0', required: false }] }, []),
    'MISSING_OPTIONAL_DATASET',
  ),
);
assert.ok(has(evaluate({ projectSchemaVersion: '2.0.0' }), 'UNSUPPORTED_PROJECT_SCHEMA_MAJOR'));
assert.ok(has(evaluate({ packageVersion: '3.0.0' }), 'UNSUPPORTED_PACKAGE_MAJOR'));
assert.equal(
  evaluate({ extensions: [{ id: 'optional-future', version: '1.0.0', required: false }] }).category,
  'COMPATIBLE_WITH_WARNING',
);
assert.ok(
  has(
    evaluate({ extensions: [{ id: 'optional-future', version: '1.0.0', required: false }] }),
    'MISSING_OPTIONAL_EXTENSION',
  ),
);
assert.equal(
  evaluate({ extensions: [{ id: 'mandatory-future', version: '1.0.0', required: true }] }).category,
  'INCOMPATIBLE',
);
assert.equal(evaluate({ packageVersion: 'not-semver' }).category, 'UNKNOWN');
assert.equal(compareSemanticVersions(parseSemanticVersion('1.10.0'), parseSemanticVersion('1.2.0')), 1);
assert.equal(
  compareSemanticVersions(parseSemanticVersion('1.0.0-beta.2'), parseSemanticVersion('1.0.0-beta.11')),
  -1,
);
assert.equal(parseSemanticVersion('1.0.0-beta.01'), null);

console.log('Compatibility matrix: 13 scenarios passed.');
