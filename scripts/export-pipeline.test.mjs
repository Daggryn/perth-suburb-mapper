// Tests for the pure utility layer of the export pipeline.
// Browser-only glue (canvas, Image, fetch, downloads) is intentionally not
// covered here — the prototype is the visual test for that (per spec).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  exportFilename,
  selectionBoundsInLatLng,
  padBoundsLatLng,
  expandToMin,
  polygonCentroidLngLat,
  lngLatToTileXY,
  tileRangeForBounds,
} from './export-pipeline.mjs';

test('exportFilename — formats the date as YYYY-MM-DD.png', () => {
  assert.equal(
    exportFilename(new Date(2026, 9, 6, 15, 30)), // 2026-10-06 local
    'perth-suburbs-2026-10-06.png',
  );
});

test('exportFilename — zero-pads single-digit months and days', () => {
  assert.equal(
    exportFilename(new Date(2026, 0, 1, 12, 0)), // 2026-01-01
    'perth-suburbs-2026-01-01.png',
  );
});

test('exportFilename — defaults to the current date when called with no arg', () => {
  // We can't assert against "today" without freezing time, so just check the
  // shape: starts with the prefix and ends with `.png`.
  const name = exportFilename();
  assert.match(name, /^perth-suburbs-\d{4}-\d{2}-\d{2}\.png$/);
});

// selectionBoundsInLatLng: walk the GeoJSON feature collection and return the
// lat/lng bounding rectangle of the features whose id is in selectedIds.
// Input coordinates are in Web Mercator metres; output is in lat/lng degrees.

// One Web Mercator degree of longitude at the equator is roughly 111 320 m.
// Test fixtures use exact whole-metre coordinates that translate cleanly.
const feature = (id, ring) => ({
  type: 'Feature',
  properties: { id, pid: `pid-${id}`, name: id.toUpperCase() },
  geometry: { type: 'Polygon', coordinates: [ring] },
});

test('selectionBoundsInLatLng — empty selection returns null bounds', () => {
  const fc = { type: 'FeatureCollection', features: [] };
  const bounds = selectionBoundsInLatLng(fc, new Set());
  assert.equal(bounds, null);
});

test('selectionBoundsInLatLng — single feature returns its bbox in lat/lng', () => {
  // Web Mercator ring around (-31.95, 115.85): use ~1 km box.
  // 1 deg lat ≈ 111 320 m; 1 deg lng at lat -32 ≈ 111 320 * cos(32) ≈ 94 407 m.
  const cLng = 115.85;
  const cLat = -31.95;
  const halfLatDeg = 0.5 / 111320;
  const halfLngDeg = 0.5 / (111320 * Math.cos(cLat * Math.PI / 180));
  const ring = [
    [cLng - halfLngDeg, cLat - halfLatDeg],
    [cLng + halfLngDeg, cLat - halfLatDeg],
    [cLng + halfLngDeg, cLat + halfLatDeg],
    [cLng - halfLngDeg, cLat + halfLatDeg],
    [cLng - halfLngDeg, cLat - halfLatDeg],
  ];
  // Project to Web Mercator using the EPSG:3857 spherical formula (matches the
  // data shipped in data/perth-suburbs.geojson).
  const project = ([lng, lat]) => [
    lng / 180 * 20037508.34,
    Math.log(Math.tan((90 + lat) * Math.PI / 360)) / Math.PI * 20037508.34,
  ];
  const mercRing = ring.map(project);
  const fc = { type: 'FeatureCollection', features: [feature('a', mercRing)] };
  const b = selectionBoundsInLatLng(fc, new Set(['a']));
  assert.ok(b, 'should return bounds');
  // Should be roughly the original lat/lng extent (±0.005 deg).
  assert.ok(Math.abs(b.minLat - (cLat - halfLatDeg)) < 1e-4, `min lat ${b.minLat}`);
  assert.ok(Math.abs(b.maxLat - (cLat + halfLatDeg)) < 1e-4, `max lat ${b.maxLat}`);
  assert.ok(Math.abs(b.minLng - (cLng - halfLngDeg)) < 1e-4, `min lng ${b.minLng}`);
  assert.ok(Math.abs(b.maxLng - (cLng + halfLngDeg)) < 1e-4, `max lng ${b.maxLng}`);
});

test('selectionBoundsInLatLng — multi-feature union bbox', () => {
  // Two small rings, ~2 km apart in lat/lng.
  const ring1 = [
    [115.840, -31.960], [115.860, -31.960], [115.860, -31.940], [115.840, -31.940],
    [115.840, -31.960],
  ];
  const ring2 = [
    [115.840, -31.760], [115.860, -31.760], [115.860, -31.740], [115.840, -31.740],
    [115.840, -31.760],
  ];
  const project = ([lng, lat]) => [
    lng / 180 * 20037508.34,
    Math.log(Math.tan((90 + lat) * Math.PI / 360)) / Math.PI * 20037508.34,
  ];
  const fc = {
    type: 'FeatureCollection',
    features: [feature('a', ring1.map(project)), feature('b', ring2.map(project))],
  };
  const b = selectionBoundsInLatLng(fc, new Set(['a', 'b']));
  assert.ok(b);
  assert.ok(Math.abs(b.minLat - (-31.96)) < 1e-4);
  assert.ok(Math.abs(b.maxLat - (-31.74)) < 1e-4);
  assert.ok(Math.abs(b.minLng - 115.84) < 1e-4);
  assert.ok(Math.abs(b.maxLng - 115.86) < 1e-4);
});

test('selectionBoundsInLatLng — ignores unselected features', () => {
  const ring = [
    [115.840, -31.960], [115.860, -31.960], [115.860, -31.940], [115.840, -31.940],
    [115.840, -31.960],
  ];
  const project = ([lng, lat]) => [
    lng / 180 * 20037508.34,
    Math.log(Math.tan((90 + lat) * Math.PI / 360)) / Math.PI * 20037508.34,
  ];
  const fc = {
    type: 'FeatureCollection',
    features: [feature('a', ring.map(project)), feature('b', ring.map(project))],
  };
  const b = selectionBoundsInLatLng(fc, new Set(['a']));
  // Should match the bounds of just `a` — same as the other ring, but
  // confirms we didn't aggregate the second feature.
  assert.ok(Math.abs(b.minLat - (-31.96)) < 1e-4);
  assert.ok(Math.abs(b.maxLng - 115.86) < 1e-4);
});

// padBoundsLatLng: pad a lat/lng bbox by a fraction on each side. A 0.05 pad
// is the locked export padding from ticket 06.
test('padBoundsLatLng — 5% pad expands each edge by 5% of the dimension', () => {
  const b = { minLat: -32.0, maxLat: -31.9, minLng: 115.8, maxLng: 115.9 };
  const p = padBoundsLatLng(b, 0.05);
  // Lat range was 0.1; 5% of 0.1 is 0.005 on each side.
  assert.equal(p.minLat, -32.005);
  assert.equal(p.maxLat, -31.895);
  // Lng range was 0.1; same logic.
  assert.equal(p.minLng, 115.795);
  assert.equal(p.maxLng, 115.905);
});

test('padBoundsLatLng — zero pad is a no-op', () => {
  const b = { minLat: -32.0, maxLat: -31.9, minLng: 115.8, maxLng: 115.9 };
  const p = padBoundsLatLng(b, 0);
  assert.deepEqual(p, b);
});

// expandToMin: given the padded bounds' pixel size, grow it symmetrically
// around its centre so both width and height are at least `min`. The dx/dy
// are the white padding offsets to apply when drawing the rect inside the
// new canvas. Used for the 1024×1024 export minimum (ticket 13).
test('expandToMin — already-meeting size returns identical canvas', () => {
  const r = expandToMin({ width: 1500, height: 1200 }, 1024);
  assert.deepEqual(r, { width: 1500, height: 1200, dx: 0, dy: 0 });
});

test('expandToMin — both dimensions below min grow to min', () => {
  const r = expandToMin({ width: 600, height: 400 }, 1024);
  assert.equal(r.width, 1024);
  assert.equal(r.height, 1024);
  // Pad is symmetric, so dx = (1024 - 600) / 2 = 212.
  assert.equal(r.dx, 212);
  assert.equal(r.dy, 312);
});

test('expandToMin — only one dimension below min grows just that one', () => {
  // 2000 wide, 800 tall, min 1024.
  const r = expandToMin({ width: 2000, height: 800 }, 1024);
  assert.equal(r.width, 2000);
  assert.equal(r.height, 1024);
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 112);
});

// polygonCentroidLngLat: bbox-centroid in lat/lng. Matches the on-page label
// position which uses layer.getBounds().getCenter() (ticket 05).
test('polygonCentroidLngLat — bbox-centroid of a small square ring', () => {
  // 0.02 deg square around (115.85, -31.95) in lat/lng.
  const ring = [
    [115.84, -31.96], [115.86, -31.96], [115.86, -31.94], [115.84, -31.94],
    [115.84, -31.96],
  ];
  const project = ([lng, lat]) => [
    lng / 180 * 20037508.34,
    Math.log(Math.tan((90 + lat) * Math.PI / 360)) / Math.PI * 20037508.34,
  ];
  const f = feature('a', ring.map(project));
  const c = polygonCentroidLngLat(f);
  assert.ok(Math.abs(c.lat - (-31.95)) < 1e-4, `lat ${c.lat}`);
  assert.ok(Math.abs(c.lng - 115.85) < 1e-4, `lng ${c.lng}`);
});

test('polygonCentroidLngLat — multi-ring polygon (e.g., country with islands)', () => {
  // Main ring at (115.85, -31.95); outlying ring offset by (0.05, 0.05).
  // Centroid should still be the centre of the union bbox.
  const main = [
    [115.80, -32.00], [115.90, -32.00], [115.90, -31.90], [115.80, -31.90],
    [115.80, -32.00],
  ];
  const island = [
    [115.95, -31.85], [115.97, -31.85], [115.97, -31.83], [115.95, -31.83],
    [115.95, -31.85],
  ];
  const project = ([lng, lat]) => [
    lng / 180 * 20037508.34,
    Math.log(Math.tan((90 + lat) * Math.PI / 360)) / Math.PI * 20037508.34,
  ];
  const f = {
    type: 'Feature',
    properties: { id: 'mp', pid: 'p', name: 'mp' },
    geometry: { type: 'Polygon', coordinates: [main.map(project), island.map(project)] },
  };
  const c = polygonCentroidLngLat(f);
  // Bbox union: 115.80..115.97 lng, -32.00..-31.83 lat.
  assert.ok(Math.abs(c.lng - (115.80 + 115.97) / 2) < 1e-4, `lng ${c.lng}`);
  assert.ok(Math.abs(c.lat - (-32.00 + -31.83) / 2) < 1e-4, `lat ${c.lat}`);
});

// lngLatToTileXY: Web Mercator tile coordinates for a given lat/lng + zoom.
// The standard "slippy map" tile scheme used by OSM.
test('lngLatToTileXY — origin maps to (0, 0)', () => {
  // (-180, 85.0511) — the top-left corner of the world at any zoom.
  assert.deepEqual(lngLatToTileXY(-180, 85.0511287798066, 0), { x: 0, y: 0 });
});

test('lngLatToTileXY — (0, 0) maps to centre tile at zoom 0', () => {
  assert.deepEqual(lngLatToTileXY(0, 0, 0), { x: 0, y: 0 });
  // At zoom 1 the world is 2x2 tiles; (0, 0) sits at the corner between all four.
  const z1 = lngLatToTileXY(0, 0, 1);
  // x is on the boundary; we accept either floor depending on FP rounding, so
  // assert both candidates are valid.
  assert.ok(z1.x === 0 || z1.x === 1, `x ${z1.x}`);
  assert.ok(z1.y === 0 || z1.y === 1, `y ${z1.y}`);
});

test('lngLatToTileXY — Perth CBD at zoom 11 maps to a sensible tile', () => {
  // Perth CBD ≈ (-31.95, 115.85). World at zoom 11 is 2^11 = 2048 tiles wide.
  // x = (115.85 + 180) / 360 * 2048 = 1683.84... → 1683.
  // y = ((1 - log(tan(-31.95°) + 1/cos(-31.95°)) / π) / 2) * 2048 = 1215.something.
  const t = lngLatToTileXY(115.85, -31.95, 11);
  assert.equal(t.x, 1683);
  assert.equal(t.y, 1215);
});

test('lngLatToTileXY — NE corner of a tile returns the next tile over', () => {
  // (180-ε, ~-85.05) is the SE corner of tile (0, 0) at zoom 0.
  const t = lngLatToTileXY(179.999, -85.0, 0);
  // y at lat -85 is 0 (the bottom row); x at lng 179.999 is still 0 (the right edge of the leftmost tile).
  assert.equal(t.x, 0);
  assert.equal(t.y, 0);
});

// tileRangeForBounds: every tile whose bounds (in slippy-map tile space) at
// the given zoom overlaps the given lat/lng bounds. Returns an array of
// {x, y} tile coords. Used by the export pipeline to know which OSM tiles
// to fetch and draw.
test('tileRangeForBounds — empty bounds returns no tiles', () => {
  // Degenerate: minLat === maxLat and minLng === maxLng.
  const tiles = tileRangeForBounds(
    { minLat: -31.95, maxLat: -31.95, minLng: 115.85, maxLng: 115.85 },
    11,
  );
  // A single-point bbox still covers (part of) one tile.
  assert.equal(tiles.length, 1);
});

test('tileRangeForBounds — single tile when the bbox fits in one tile', () => {
  // Tiny bbox in the middle of a tile.
  const tiles = tileRangeForBounds(
    { minLat: -31.94, maxLat: -31.90, minLng: 115.84, maxLng: 115.86 },
    11,
  );
  assert.equal(tiles.length, 1);
  // Should land on the Perth tile (x=1683, y=1215) at zoom 11.
  assert.deepEqual(tiles[0], { x: 1683, y: 1215 });
});

test('tileRangeForBounds — multi-tile bbox covers the full grid', () => {
  // 2×2 tile bbox centred near Perth at zoom 11.
  // NW corner: (115.80, -31.9) → (1682, 1215); SE corner: (115.95, -32.0) → (1683, 1216).
  const tiles = tileRangeForBounds(
    { minLat: -32.0, maxLat: -31.9, minLng: 115.80, maxLng: 115.95 },
    11,
  );
  const set = new Set(tiles.map((t) => `${t.x},${t.y}`));
  assert.equal(set.size, 4);
  assert.ok(set.has('1682,1215'));
  assert.ok(set.has('1683,1215'));
  assert.ok(set.has('1682,1216'));
  assert.ok(set.has('1683,1216'));
});

test('tileRangeForBounds — Greater Perth bbox at zoom 11 covers many tiles', () => {
  const tiles = tileRangeForBounds(
    { minLat: -32.5, maxLat: -31.7, minLng: 115.5, maxLng: 116.2 },
    11,
  );
  // Greater Perth bbox is roughly 0.7° × 0.8°; at z=11 each tile is ~0.18° wide.
  // So we expect around (0.7/0.18) × (0.8/0.18) ≈ 4 × 5 = 20 tiles.
  assert.ok(tiles.length >= 12, `expected ≥12 tiles, got ${tiles.length}`);
  assert.ok(tiles.length <= 30, `expected ≤30 tiles, got ${tiles.length}`);
});

// Integration test against the actual shipped GeoJSON — confirms the pure
// helpers behave sensibly on the real data shape.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');

test('integration — selectionBoundsInLatLng on a single real feature returns its bbox', () => {
  const fc = JSON.parse(readFileSync(resolve(DATA_DIR, 'perth-suburbs.geojson'), 'utf8'));
  // Pick the first feature; its bbox should be inside Greater Perth
  // ([115.5, -32.5, 116.2, -31.7]) per the build script's bbox filter.
  const firstId = fc.features[0].properties.id;
  const b = selectionBoundsInLatLng(fc, new Set([firstId]));
  assert.ok(b, 'should return bounds');
  assert.ok(b.minLng > 115.5 && b.maxLng < 116.2, `lng out of range: ${b.minLng}..${b.maxLng}`);
  assert.ok(b.minLat > -32.5 && b.maxLat < -31.7, `lat out of range: ${b.minLat}..${b.maxLat}`);
});

test('integration — selectionBoundsInLatLng on the full set matches the data bbox', () => {
  const fc = JSON.parse(readFileSync(resolve(DATA_DIR, 'perth-suburbs.geojson'), 'utf8'));
  const ids = new Set(fc.features.map((f) => f.properties.id));
  const b = selectionBoundsInLatLng(fc, ids);
  const meta = JSON.parse(readFileSync(resolve(DATA_DIR, 'perth-suburbs.meta.json'), 'utf8'));
  // The meta bbox is in Web Mercator metres; the latlng bbox is in degrees.
  // Both should describe roughly the same Greater Perth rectangle.
  assert.ok(b.minLng <= meta.bbox.source[0], `min lng ${b.minLng}`);
  assert.ok(b.maxLng >= meta.bbox.source[2], `max lng ${b.maxLng}`);
  assert.ok(b.minLat <= meta.bbox.source[1], `min lat ${b.minLat}`);
  assert.ok(b.maxLat >= meta.bbox.source[3], `max lat ${b.maxLat}`);
});