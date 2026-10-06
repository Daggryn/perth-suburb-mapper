// Build-time script: downloads the Geoscape Australia WA Suburb/Locality
// Boundaries dataset (GDA2020 Shapefile), filters it to the Greater Perth
// bounding box, reprojects to Web Mercator (EPSG:3857), assigns short stable
// IDs, and writes:
//   - data/perth-suburbs.geojson   (the polygon data the site loads)
//   - data/perth-suburbs.meta.json (attribution, license, bbox, count)
//
// Run with: node scripts/build-suburbs.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import shp from 'shpjs';
import proj4 from 'proj4';

const DATASET_URL =
  'https://data.gov.au/data/dataset/6a0ec945-c880-4882-8a81-4dbcb85e74e5/resource/d88e0e12-a74c-4085-b7e8-31bb2aee080a/download/wa_loc_gda2020.zip';
const DATASET_TITLE =
  'WA Suburb/Locality Boundaries — Geoscape Administrative Boundaries';
const LICENSE = 'Creative Commons Attribution 4.0 International (CC BY 4.0)';
const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
const ATTRIBUTION_TEXT =
  'Administrative Boundaries © Geoscape Australia licensed by the Commonwealth of Australia under Creative Commons Attribution 4.0 International licence (CC BY 4.0).';
const DATASET_PAGE_URL =
  'https://data.gov.au/data/dataset/wa-suburb-locality-boundaries-geoscape-administrative-boundaries';

// Greater Perth bounding box in GDA2020 (degrees).
// Initial range from research ticket 01; refine after a first pass.
const BBOX = { minLng: 115.5, maxLng: 116.2, minLat: -32.5, maxLat: -31.7 };

// GDA2020 (geographic 2D, decimal degrees) and Web Mercator definitions.
proj4.defs(
  'EPSG:7844',
  '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs +type=crs'
);
const PROJECT = proj4('EPSG:7844', 'EPSG:3857');

// Crockford base32 alphabet (no I, L, O, U — easy to read, URL-safe).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockfordFromBytes(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

function shortId(pid) {
  // SHA-256 of the PID, take first 3 bytes (24 bits) → 5 Crockford chars.
  // Collision check at the end of the pipeline handles the birthday-paradox
  // chance for ~350 items.
  const hash = createHash('sha256').update(pid).digest();
  return crockfordFromBytes(hash.subarray(0, 3));
}

function filterInBbox(feature) {
  const g = feature.geometry;
  if (!g) return false;
  const coords = collectCoords(g);
  for (const [lng, lat] of coords) {
    if (
      lng >= BBOX.minLng &&
      lng <= BBOX.maxLng &&
      lat >= BBOX.minLat &&
      lat <= BBOX.maxLat
    )
      return true;
  }
  return false;
}

function collectCoords(geom) {
  const out = [];
  if (geom.type === 'Point') out.push(geom.coordinates);
  else if (geom.type === 'LineString' || geom.type === 'MultiPoint') {
    for (const c of geom.coordinates) out.push(c);
  } else if (geom.type === 'Polygon' || geom.type === 'MultiLineString') {
    for (const ring of geom.coordinates) for (const c of ring) out.push(c);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates)
      for (const ring of poly)
        for (const c of ring) out.push(c);
  }
  return out;
}

function reprojectCoords(coords) {
  if (typeof coords[0] === 'number') {
    const [x, y] = PROJECT.forward([coords[0], coords[1]]);
    // Round to 1 metre (Web Mercator units are metres at the equator). This
    // shrinks the GeoJSON by ~50% vs. preserving source precision, with no
    // visible loss at zoom 11–18.
    return [Math.round(x), Math.round(y)];
  }
  return coords.map(reprojectCoords);
}

function reprojectGeometry(geom) {
  return {
    ...geom,
    coordinates: reprojectCoords(geom.coordinates),
  };
}

function bboxOf(feature) {
  const coords = collectCoords(feature.geometry);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

async function downloadZip(url) {
  const here = dirname(fileURLToPath(import.meta.url));
  const cachePath = resolve(here, '..', '.cache', 'wa_loc_gda2020.zip');
  if (existsSync(cachePath)) {
    console.log(`Using cached ZIP at ${cachePath}`);
    return readFile(cachePath);
  }
  console.log(`Downloading ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, buf);
  console.log(`Cached ${(buf.length / 1024 / 1024).toFixed(2)} MB to ${cachePath}`);
  return buf;
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(here, '..', 'data');
  await mkdir(dataDir, { recursive: true });

  const zipBuf = await downloadZip(DATASET_URL);

  console.log('Parsing Shapefile …');
  const parsed = await shp(bufToArrayBuffer(zipBuf));
  // shpjs returns either a single GeoJSON FeatureCollection or an array of
  // them (when the .dbf describes multiple geometry types). For the WA
  // Suburb/Locality product it returns a single FeatureCollection.
  const fc = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features))
    throw new Error('Unexpected Shpjs output shape');
  console.log(`Loaded ${fc.features.length} features`);

  // Filter to Greater Perth bbox (in source CRS, GDA2020 degrees).
  const filtered = fc.features.filter(filterInBbox);
  console.log(`Filtered to ${filtered.length} features inside bbox`);

  // Assign short stable IDs, with collision detection.
  const idMap = new Map();      // pid → shortId
  const seenIds = new Set();    // shortId → first seen pid
  let collisions = 0;
  for (const f of filtered) {
    const pid = f.properties.LOC_PID;
    let id = shortId(pid);
    if (seenIds.has(id)) {
      // Collision — extend with more hash bytes until unique.
      const fullHash = createHash('sha256').update(pid).digest();
      for (let n = 4; n < fullHash.length; n += 2) {
        id = crockfordFromBytes(fullHash.subarray(0, n));
        if (!seenIds.has(id)) break;
      }
      if (seenIds.has(id)) {
        // Last resort: append a counter.
        let suffix = 2;
        while (seenIds.has(`${id}${CROCKFORD[suffix]}`)) suffix++;
        id = `${id}${CROCKFORD[suffix]}`;
      }
      collisions++;
    }
    seenIds.add(id);
    idMap.set(pid, id);
  }
  if (collisions) console.log(`Resolved ${collisions} short-ID collisions`);

  // Reproject each feature's geometry to Web Mercator, reduce properties.
  const outFeatures = filtered.map((f) => {
    const pid = f.properties.LOC_PID;
    const name = f.properties.LOC_NAME;
    return {
      type: 'Feature',
      properties: { id: idMap.get(pid), pid, name },
      geometry: reprojectGeometry(f.geometry),
    };
  });

  // Compute bbox of the resulting collection (in Web Mercator).
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const f of outFeatures) {
    const [a, b, c, d] = bboxOf(f);
    if (a < xMin) xMin = a;
    if (b < yMin) yMin = b;
    if (c > xMax) xMax = c;
    if (d > yMax) yMax = d;
  }
  const webMercBbox = [xMin, yMin, xMax, yMax];

  // Sanity: distinct locality_pids vs features (multi-part localities).
  const distinctPids = new Set(filtered.map((f) => f.properties.LOC_PID));

  const fcOut = {
    type: 'FeatureCollection',
    features: outFeatures,
  };
  const metaOut = {
    dataset: {
      title: DATASET_TITLE,
      source: DATASET_PAGE_URL,
      license: LICENSE,
      licenseUrl: LICENSE_URL,
      attributionText: ATTRIBUTION_TEXT,
      buildDate: new Date().toISOString(),
    },
    bbox: {
      sourceCrs: 'EPSG:7844',
      sourceUnits: 'degrees',
      source: [BBOX.minLng, BBOX.minLat, BBOX.maxLng, BBOX.maxLat],
      outputCrs: 'EPSG:3857',
      outputUnits: 'meters',
      output: webMercBbox,
    },
    counts: {
      features: outFeatures.length,
      distinctLocalities: distinctPids.size,
      collisions,
    },
  };

  const fcPath = resolve(dataDir, 'perth-suburbs.geojson');
  const metaPath = resolve(dataDir, 'perth-suburbs.meta.json');
  await writeFile(fcPath, JSON.stringify(fcOut));
  await writeFile(metaPath, JSON.stringify(metaOut, null, 2));

  const fcSize = (await readFile(fcPath)).length;
  const metaSize = (await readFile(metaPath)).length;
  console.log(`Wrote ${fcPath} — ${(fcSize / 1024).toFixed(1)} KB`);
  console.log(`Wrote ${metaPath} — ${(metaSize / 1024).toFixed(1)} KB`);
  console.log(`Suburbs: ${distinctPids.size} localities (${outFeatures.length} polygon parts)`);
  console.log(`Web-Mercator bbox: [${webMercBbox.map((n) => n.toFixed(0)).join(', ')}]`);
}

function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});