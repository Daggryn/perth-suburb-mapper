// Pure utility layer for the export PNG pipeline.
//
// Browser-only glue (canvas drawing, tile Image loading, blob download)
// lives in index.html; the math, geometry, and filename logic lives here
// so it can be exercised under node --test.

export function exportFilename(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `perth-suburbs-${yyyy}-${mm}-${dd}.png`;
}

// Web Mercator → lat/lng (degrees). Mirrors the spherical EPSG:3857 inverse
// used by the Geoscape data shipped in data/perth-suburbs.geojson.
export const WEB_MERCATOR_R = 6378137; // Earth equatorial radius (metres)
export const WEB_MERCATOR_HALF_CIRC = Math.PI * WEB_MERCATOR_R; // ~20037508.34

export function mercatorToLngLat(x, y) {
  const lng = (x / WEB_MERCATOR_HALF_CIRC) * 180;
  const latRad = 2 * Math.atan(Math.exp(y / WEB_MERCATOR_R)) - Math.PI / 2;
  const lat = latRad * 180 / Math.PI;
  return [lng, lat];
}

function* iterFeatureCoords(feature) {
  const g = feature.geometry;
  if (!g) return;
  const rings =
    g.type === 'Polygon' ? g.coordinates :
    g.type === 'MultiPolygon' ? g.coordinates.flat() :
    null;
  if (!rings) return;
  for (const ring of rings) {
    for (const pt of ring) yield pt;
  }
}

// Public re-export so the browser-side glue can iterate a (Multi)Polygon's
// vertices in the same order the pure helpers do.
export { iterFeatureCoords };

// Returns {minLat, maxLat, minLng, maxLng} for the union of the features whose
// `properties.id` is in `selectedIds`. The features must be in Web Mercator
// (EPSG:3857) — i.e. coordinates in metres — which is the format shipped in
// data/perth-suburbs.geojson. Returns null when the selection is empty.
export function selectionBoundsInLatLng(featureCollection, selectedIds) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  let any = false;
  for (const f of featureCollection.features) {
    if (!selectedIds.has(f.properties.id)) continue;
    for (const pt of iterFeatureCoords(f)) {
      const [lng, lat] = mercatorToLngLat(pt[0], pt[1]);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      any = true;
    }
  }
  return any ? { minLat, maxLat, minLng, maxLng } : null;
}

// Pad a lat/lng bbox by `fraction` on each side. Used for the 5% export margin
// (ticket 06 / ticket 13). Inputs are absolute; the pad is symmetric.
export function padBoundsLatLng(b, fraction) {
  if (fraction === 0) return { minLat: b.minLat, maxLat: b.maxLat, minLng: b.minLng, maxLng: b.maxLng };
  const dLat = (b.maxLat - b.minLat) * fraction;
  const dLng = (b.maxLng - b.minLng) * fraction;
  return {
    minLat: b.minLat - dLat,
    maxLat: b.maxLat + dLat,
    minLng: b.minLng - dLng,
    maxLng: b.maxLng + dLng,
  };
}

// Grow the padded bounds' pixel size symmetrically around its centre so both
// width and height are at least `min`. The dx/dy are the white padding offsets
// to apply when drawing the rect inside the new canvas. Used for the
// 1024×1024 export minimum (ticket 13).
export function expandToMin(size, min) {
  if (size.width >= min && size.height >= min) {
    return { width: size.width, height: size.height, dx: 0, dy: 0 };
  }
  const w = Math.max(size.width, min);
  const h = Math.max(size.height, min);
  return {
    width: w,
    height: h,
    dx: (w - size.width) / 2,
    dy: (h - size.height) / 2,
  };
}

// Bbox-centroid of a (Multi)Polygon feature in lat/lng. Matches the on-page
// label position (layer.getBounds().getCenter(), ticket 05). Coordinates are
// in Web Mercator (EPSG:3857) — i.e. metres — which is the format shipped
// in data/perth-suburbs.geojson.
export function polygonCentroidLngLat(feature) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const pt of iterFeatureCoords(feature)) {
    const [lng, lat] = mercatorToLngLat(pt[0], pt[1]);
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return {
    lat: (minLat + maxLat) / 2,
    lng: (minLng + maxLng) / 2,
  };
}

// Standard "slippy map" tile coords (https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames).
// Returns floor(x), floor(y) — the tile that contains the given lat/lng.
// Clamps to [0, n-1] in y to absorb floating-point noise at the polar edges;
// Greater Perth latitudes never hit the clamp.
export function lngLatToTileXY(lng, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = (lat * Math.PI) / 180;
  const yFloat = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const y = Math.max(0, Math.min(n - 1, Math.floor(yFloat)));
  return { x, y };
}

// Every tile whose bounds (in slippy-map tile space) at the given zoom
// overlaps the given lat/lng bounds. Returns an array of {x, y}. Used by
// the export pipeline to know which OSM tiles to fetch and draw.
export function tileRangeForBounds(b, zoom) {
  const nw = lngLatToTileXY(b.minLng, b.maxLat, zoom);
  const se = lngLatToTileXY(b.maxLng, b.minLat, zoom);
  const out = [];
  for (let x = nw.x; x <= se.x; x++) {
    for (let y = nw.y; y <= se.y; y++) {
      out.push({ x, y });
    }
  }
  return out;
}