// Smoke tests for scripts/build-suburbs.mjs.
//
// Run with:  node --test scripts/build-suburbs.test.mjs
// (from the repo root).
//
// These tests are black-box: they read the build script's outputs and assert
// properties that should hold across every successful build. They re-run the
// build script itself for the ID-stability check, so the script's source ZIP
// cache (`.cache/wa_loc_gda2020.zip`) needs to be present — if it isn't, the
// ID-stability test is skipped.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const geojsonPath = resolve(repoRoot, 'data', 'perth-suburbs.geojson');
const metaPath = resolve(repoRoot, 'data', 'perth-suburbs.meta.json');
const cachePath = resolve(repoRoot, '.cache', 'wa_loc_gda2020.zip');

// Crockford base32 alphabet used by the build script. The script URL-encodes
// IDs with this exact set (no I/L/O/U) so the tests use the same set.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_SET = new Set(CROCKFORD);

// Verbatim attribution string the script writes to meta.json — see the
// constant `ATTRIBUTION_TEXT` in scripts/build-suburbs.mjs. If Geoscape
// updates its wording this string must be updated too, and the footer in
// index.html must be re-checked.
const EXPECTED_ATTRIBUTION =
  'Administrative Boundaries © Geoscape Australia licensed by the Commonwealth of Australia under Creative Commons Attribution 4.0 International licence (CC BY 4.0).';
const EXPECTED_LICENSE =
  'Creative Commons Attribution 4.0 International (CC BY 4.0)';

let geojson;
let meta;

before(async () => {
  geojson = JSON.parse(await readFile(geojsonPath, 'utf8'));
  meta = JSON.parse(await readFile(metaPath, 'utf8'));
});

// Traverse every coordinate pair in a Feature's geometry (Polygon /
// MultiPolygon). Returns a flat array of [x, y] pairs.
function flattenCoords(geometry) {
  const out = [];
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      out.push(c);
      return;
    }
    for (const child of c) walk(child);
  };
  walk(geometry.coordinates);
  return out;
}

describe('build-suburbs: output schema', () => {
  it('produces a FeatureCollection', () => {
    assert.equal(geojson.type, 'FeatureCollection');
    assert.ok(Array.isArray(geojson.features));
  });

  it('every feature has properties.id, properties.pid, properties.name', () => {
    for (const f of geojson.features) {
      assert.ok(f.properties, `feature missing properties: ${JSON.stringify(f)}`);
      assert.ok(typeof f.properties.id === 'string', `feature id not a string: ${f.properties.id}`);
      assert.ok(typeof f.properties.pid === 'string', `feature pid not a string: ${f.properties.pid}`);
      assert.ok(typeof f.properties.name === 'string', `feature name not a string: ${f.properties.name}`);
    }
  });

  it('properties.id is Crockford base32 (3–8 chars)', () => {
    // IDs are SHA-256(`pid`) truncated to N bytes then Crockford-encoded.
    // Length is 5 for the common case (3 bytes → up to 5 chars), but hashes
    // with leading zero bytes encode to fewer chars, and the collision
    // resolver extends to 7+ chars. Anything outside [3, 8] is a sign of
    // either a hash bug or runaway collision counter.
    for (const f of geojson.features) {
      const id = f.properties.id;
      assert.ok(id.length >= 3, `id suspiciously short: "${id}"`);
      assert.ok(id.length <= 8, `id suspiciously long: "${id}"`);
      for (const ch of id) {
        assert.ok(
          CROCKFORD_SET.has(ch),
          `id "${id}" contains non-Crockford char "${ch}"`,
        );
      }
    }
  });

  it('properties.id is mostly 5 chars (collision extension is rare)', () => {
    // The default path is 5 chars; collision resolution extends the length.
    // Sanity-check that collision extension is rare (≤ 5% of features).
    let five = 0;
    for (const f of geojson.features) {
      if (f.properties.id.length === 5) five++;
    }
    const ratio = five / geojson.features.length;
    assert.ok(
      ratio >= 0.9,
      `expected ≥ 90% of ids to be 5 chars; got ${(ratio * 100).toFixed(1)}%`,
    );
  });

  it('properties.pid is a 15-char string', () => {
    for (const f of geojson.features) {
      assert.equal(
        f.properties.pid.length,
        15,
        `pid length wrong: "${f.properties.pid}"`,
      );
    }
  });

  it('properties.name is a non-empty string', () => {
    for (const f of geojson.features) {
      assert.ok(f.properties.name.length > 0, 'feature has empty name');
    }
  });

  it('pid ↔ id is a bijection (multi-part suburbs share an id by design)', () => {
    // Multi-part suburbs (e.g. West Perth, Kings Park) emit one GeoJSON
    // feature per polygon part; each part shares the locality's pid and id.
    // The pid→id mapping must still be one-to-one.
    const pidToId = new Map();
    for (const f of geojson.features) {
      const existing = pidToId.get(f.properties.pid);
      if (existing !== undefined) {
        assert.equal(
          existing,
          f.properties.id,
          `pid ${f.properties.pid} mapped to two ids: ${existing}, ${f.properties.id}`,
        );
      } else {
        pidToId.set(f.properties.pid, f.properties.id);
      }
    }
    // And the reverse direction.
    const idToPid = new Map();
    for (const f of geojson.features) {
      const existing = idToPid.get(f.properties.id);
      if (existing !== undefined) {
        assert.equal(
          existing,
          f.properties.pid,
          `id ${f.properties.id} mapped to two pids: ${existing}, ${f.properties.pid}`,
        );
      } else {
        idToPid.set(f.properties.id, f.properties.pid);
      }
    }
  });
});

describe('build-suburbs: coordinates are in Web Mercator', () => {
  it('every x coord is within Greater-Perth Web Mercator range', () => {
    let minX = Infinity, maxX = -Infinity;
    for (const f of geojson.features) {
      for (const [x] of flattenCoords(f.geometry)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    // Spec ticket: x ≈ 1.28e7 to 1.30e7 for Greater Perth.
    assert.ok(minX >= 12_800_000, `minX out of range: ${minX}`);
    assert.ok(maxX <= 13_000_000, `maxX out of range: ${maxX}`);
  });

  it('every y coord is within Greater-Perth Web Mercator range', () => {
    let minY = Infinity, maxY = -Infinity;
    for (const f of geojson.features) {
      for (const [, yy] of flattenCoords(f.geometry)) {
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
    }
    // Spec ticket: y ≈ -3.85e6 to -3.70e6 for Greater Perth.
    assert.ok(minY >= -3_850_000, `minY out of range: ${minY}`);
    assert.ok(maxY <= -3_700_000, `maxY out of range: ${maxY}`);
  });
});

describe('build-suburbs: counts', () => {
  it('has at least 300 features', () => {
    assert.ok(
      geojson.features.length >= 300,
      `only ${geojson.features.length} features — empty bbox filter?`,
    );
  });

  it('has at least 300 distinct pids', () => {
    const distinct = new Set(geojson.features.map((f) => f.properties.pid));
    assert.ok(
      distinct.size >= 300,
      `only ${distinct.size} distinct pids — empty bbox filter?`,
    );
  });
});

describe('build-suburbs: attribution fields', () => {
  it('meta.json has the verbatim Geoscape attribution text', () => {
    assert.equal(
      meta.dataset.attributionText,
      EXPECTED_ATTRIBUTION,
      'attribution text drift — re-check footer + PNG export',
    );
  });

  it('meta.json license is the verbatim CC BY 4.0 string', () => {
    assert.equal(
      meta.dataset.license,
      EXPECTED_LICENSE,
      'license string drift — re-check footer + PNG export',
    );
  });
});

describe('build-suburbs: id stability', () => {
  // Skip when the cache isn't present — downloading the 20 MB source ZIP
  // from data.gov.au shouldn't be a hard dependency for a smoke test.
  const cacheExists = existsSync(cachePath);

  it('re-running the build produces identical ids for every pid', { skip: !cacheExists && 'source ZIP cache missing' }, async () => {
    const pidToIdBefore = new Map(
      geojson.features.map((f) => [f.properties.pid, f.properties.id]),
    );
    // Snapshot the meta.json so we can restore its buildDate after the build
    // re-run leaves a fresh timestamp on disk.
    const metaBefore = readFileSync(metaPath, 'utf8');

    const res = spawnSync(
      process.execPath,
      [resolve(here, 'build-suburbs.mjs')],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    assert.equal(res.status, 0, `build exited ${res.status}\nstderr:\n${res.stderr}`);

    const after = JSON.parse(readFileSync(geojsonPath, 'utf8'));
    const pidToIdAfter = new Map(
      after.features.map((f) => [f.properties.pid, f.properties.id]),
    );

    assert.equal(
      pidToIdAfter.size,
      pidToIdBefore.size,
      'feature count changed across re-run',
    );
    for (const [pid, id] of pidToIdBefore) {
      assert.equal(
        pidToIdAfter.get(pid),
        id,
        `id for pid ${pid} changed: ${id} -> ${pidToIdAfter.get(pid)}`,
      );
    }

    // Restore the original meta.json so running the tests doesn't show up
    // as a "modified" file in `git status`. The build is deterministic, so
    // only buildDate differs.
    writeFileSync(metaPath, metaBefore);
  });
});

describe('build-suburbs: performance', () => {
  it('test file has been running for under 5 s', () => {
    const elapsed = Date.now() - SUITE_START_MS;
    assert.ok(elapsed < 5_000, `suite took ${elapsed} ms`);
  });
});

// Captured at module load so the perf test can measure suite runtime
// without needing each test to record its own start time.
const SUITE_START_MS = Date.now();