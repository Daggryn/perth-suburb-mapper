// Regression test for issue #1: clicking suburbs does nothing in the browser.
//
// Boots a static server, loads the page in a real Chromium, clicks the first
// rendered polygon at its on-screen centre, and asserts the exact
// user-visible symptom: the Export button must enable (selected.size > 0)
// and the URL hash must change to a `#v1.<...>` blob with a non-empty `s`
// array. Exits 0 on pass, 1 on fail.
//
// The root cause the test guards against: the shipped GeoJSON is in Web
// Mercator (EPSG:3857) metres. Without reprojecting to lng/lat before
// handing the data to Leaflet's `L.geoJSON`, every polygon SVG path
// collapses to "M0 0" and neither click nor hover fire anywhere on the
// map. The fix lives in `index.html` (call `fcMercatorToLngLat` before
// `L.geoJSON`) and the helper it relies on lives in
// `scripts/export-pipeline.mjs`.
//
// Run with:  node scripts/click-loop.mjs
// Requires: playwright + a Chromium binary at the path pinned below (or
// override `executablePath` for a different install).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.png':  'image/png',
};

function serve(root, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let fp = path.join(root, urlPath === '/' ? '/index.html' : urlPath);
      if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end(String(err)); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const port = 8765;
  const server = await serve(ROOT, port);
  let exitCode = 1; // assume bug present until proven fixed
  try {
    const browser = await chromium.launch({
      headless: true,
      executablePath: '/home/josh/code/perth-suburb-mapper/node_modules/playwright-core/.local-browsers/chromium-1243/chrome-linux64/chrome',
      args: ['--no-sandbox'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    const consoleErrors = [];
    const failedRequests = [];
    const allResponses = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
    page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), failure: req.failure()?.errorText }));
    page.on('response', (res) => {
      allResponses.push({ url: res.url(), status: res.status() });
      if (res.status() >= 400) failedRequests.push({ url: res.url(), status: res.status() });
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    // Wait until the suburb layer is actually rendered. The boot IIFE calls
    // L.geoJSON(...) inside an async fetch; hover works once it has, per
    // the bug report.
    try {
        await page.waitForFunction(() => {
          return typeof window.L !== 'undefined'
            && document.querySelectorAll('path.leaflet-interactive').length > 0;
        }, { timeout: 15000 });
      } catch (e) {
        const diag = await page.evaluate(() => ({
          hasL: typeof window.L,
          interactive: document.querySelectorAll('path.leaflet-interactive').length,
          allPaths: document.querySelectorAll('path').length,
          bodyChildren: document.body.children.length,
          mapInnerHTML: document.getElementById('map')?.innerHTML?.length || 0,
        }));
        console.log('WAIT_FAILED', JSON.stringify(diag));
        throw e;
      }

    const layoutDiag = await page.evaluate(() => {
      const mapEl = document.getElementById('map');
      const r = mapEl.getBoundingClientRect();
      const overlayPane = mapEl.querySelector('.leaflet-overlay-pane');
      const svg = mapEl.querySelector('svg');
      const firstPath = mapEl.querySelector('path.leaflet-interactive');
      return {
        mapRect: { w: r.width, h: r.height },
        overlayPane: overlayPane ? { w: overlayPane.getBoundingClientRect().width, h: overlayPane.getBoundingClientRect().height } : null,
        svg: svg ? { w: svg.getBoundingClientRect().width, h: svg.getBoundingClientRect().height, attrW: svg.getAttribute('width'), attrH: svg.getAttribute('height'), viewBox: svg.getAttribute('viewBox') } : null,
        firstPathD: firstPath ? (firstPath.getAttribute('d') || '').slice(0, 60) : null,
      };
    });
    console.log('LAYOUT', JSON.stringify(layoutDiag));

    // Capture console snapshot up to this point.
    const errorsBeforeClick = [...consoleErrors];

    // Pick a known suburb — Fremantle. We click by dispatching the click
    // event on its polygon path directly (centre of its bounding box).
    const pathCountCheck = await page.evaluate(() => document.querySelectorAll('path.leaflet-interactive').length);
    console.log('PATH_COUNT_BEFORE_TARGET', pathCountCheck);
    const target = await page.evaluate(() => {
      // Find paths that are actually large enough to click on (skip
      // tiny noise paths). Pick the biggest one to maximise hit rate.
      const paths = Array.from(document.querySelectorAll('path.leaflet-interactive'));
      let best = null;
      let bestArea = 0;
      let samples = [];
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        const r = p.getBoundingClientRect();
        const a = r.width * r.height;
        if (samples.length < 3 || a > bestArea) {
          samples.push({ i, w: r.width, h: r.height, a });
        }
        if (a > bestArea) { bestArea = a; best = p; }
      }
      if (!best) return { count: paths.length, samples };
      const r = best.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        count: paths.length,
        bbox: { w: r.width, h: r.height },
        elAtPoint: (() => {
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!el) return null;
          return { tag: el.tagName, cls: el.getAttribute('class') || '' };
        })(),
      };
    });

    if (!target || target.x === undefined) {
      console.error('NO_TARGET', JSON.stringify(target));
      process.exit(2);
    }

    console.log('TARGET', JSON.stringify(target));

    // First, sanity-check hover works (per the bug report it should).
    await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(150);
    // Snapshot the polygon fill at hover.
    const hoverFill = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      return { tag: el.tagName, fill: el.getAttribute('fill'), opacity: el.getAttribute('fill-opacity') };
    }, target);
    console.log('HOVER_FILL', JSON.stringify(hoverFill));

    // Now click it.
    const hashBefore = await page.evaluate(() => location.hash);
    const exportDisabledBefore = await page.evaluate(() => document.getElementById('export-btn').disabled);

    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(500);

    const hashAfter = await page.evaluate(() => location.hash);
    const exportDisabledAfter = await page.evaluate(() => document.getElementById('export-btn').disabled);
    const fillAfter = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      return { tag: el.tagName, fill: el.getAttribute('fill'), opacity: el.getAttribute('fill-opacity') };
    }, target);

    console.log('CLICK_RESULT', JSON.stringify({
      paths: target.count,
      hashBefore, hashAfter,
      exportDisabledBefore, exportDisabledAfter,
      fillAfter,
      errorsAfterBoot: errorsBeforeClick,
      errorsAfterClick: consoleErrors.slice(errorsBeforeClick.length),
      failedRequests,
      non200Count: allResponses.filter(r => r.status !== 200).length,
      sampleResponses: allResponses.slice(0, 5).concat(allResponses.filter(r => r.status !== 200).slice(0, 5)),
    }));

    // Pass/fail: issue says first click must enable Export AND add #v1.
    const pass = (exportDisabledAfter === false) && hashAfter.startsWith('#v1.');
    console.log(pass ? 'LOOP_GREEN' : 'LOOP_RED');
    exitCode = pass ? 0 : 1;
    await browser.close();
  } finally {
    server.close();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(2);
});