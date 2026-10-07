// Regression test for issues #2 and #3.
//
// Issue #2: the dark pink-700 stroke on selected suburbs is invisible in
// the browser, even though the in-browser `styleFor()` claims to set
// `weight: 2, color: PINK_BORDER`. The exported PNG renders the stroke
// fine — so the bug is specific to the live `L.geoJSON` rendering. The
// user-visible symptom we assert on is: after selecting a suburb, the
// polygon's rendered `<path>` must carry a non-transparent stroke at the
// locked 2px width, both as an SVG attribute and as a computed style.
//
// Issue #3: the label text inside `.suburb-label` is left-aligned inside
// its `L.divIcon` box, so it visually trails off the centroid. The
// user-visible symptom: the computed `text-align` of the `<span
// class="suburb-label">` for a selected suburb must be `center`.
//
// One harness asserts both. Exits 0 if both pass, 1 if either fails.
//
// Run with:  node scripts/style-loop.mjs
// Requires:  playwright + a Chromium binary at the path pinned below.

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

function isTransparentStroke(stroke) {
  if (!stroke) return true;
  const s = String(stroke).trim().toLowerCase();
  if (s === '' || s === 'none' || s === 'transparent') return true;
  return false;
}

async function main() {
  const port = 8766;
  const server = await serve(ROOT, port);
  let exitCode = 1;
  try {
    const browser = await chromium.launch({
      headless: true,
      executablePath: '/home/josh/code/perth-suburb-mapper/node_modules/playwright-core/.local-browsers/chromium-1243/chrome-linux64/chrome',
      args: ['--no-sandbox'],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });

    // Wait for the suburb layer to render.
    try {
      await page.waitForFunction(() => {
        return typeof window.L !== 'undefined'
          && document.querySelectorAll('path.leaflet-interactive').length > 0;
      }, { timeout: 15000 });
    } catch (e) {
      const diag = await page.evaluate(() => ({
        hasL: typeof window.L,
        interactive: document.querySelectorAll('path.leaflet-interactive').length,
      }));
      console.log('WAIT_FAILED', JSON.stringify(diag));
      throw e;
    }

    // Pick the biggest rendered polygon. We will click near the top-left
    // corner of its bounding box, not on the centre — the suburb label
    // marker (L.marker) is anchored at `getBounds().getCenter()` and
    // would otherwise swallow the click and put the label into edit
    // mode instead of selecting the polygon.
    const target = await page.evaluate(() => {
      const paths = Array.from(document.querySelectorAll('path.leaflet-interactive'));
      let best = null, bestArea = 0;
      for (const p of paths) {
        const r = p.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > bestArea) { bestArea = a; best = p; }
      }
      if (!best) return null;
      const r = best.getBoundingClientRect();
      // Click 6px in from the bbox top-left. For the biggest polygons
      // (which are usually rectangular-ish) this is still inside the path.
      return { x: r.left + 6, y: r.top + 6 };
    });

    if (!target) { console.error('NO_TARGET'); process.exit(2); }
    console.log('TARGET', JSON.stringify(target));

    // Move the mouse off the polygon first so the hover handler doesn't
    // override the style between click and assertion.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(100);

    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(400);

    // Move the mouse away again so any selected-hover fill-opacity=0.85
    // reverts to the settled 0.6, and a non-selected hover tint doesn't
    // sit on top of the click target.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);

    // Sanity: confirm we actually selected something before probing.
    const selectedCount = await page.evaluate(() => {
      const sel = document.querySelectorAll('path.leaflet-interactive[fill-opacity="0.6"]');
      return sel.length;
    });
    console.log('SELECTED_COUNT', selectedCount);
    if (selectedCount === 0) {
      console.log('LOOP_RED', JSON.stringify({ why: 'click did not select any polygon' }));
      process.exit(1);
    }

    // ---- Issue #2 probe ----
    // Probe the *selected* polygon directly by querying all paths and
    // finding the one with fill-opacity=0.6 (the settled selected style).
    // elementFromPoint is no good once the marker has rendered.
    //
    // We check more than just stroke colour: a coloured stroke with
    // stroke-opacity=0 is invisible (this is exactly the original bug —
    // the idle style set opacity:0 and Leaflet's setStyle merges, so
    // the option leaked into the selected style and Leaflet's SVG
    // renderer set stroke-opacity="0" from it).
    const borderProbe = await page.evaluate(() => {
      const sel = document.querySelectorAll('path.leaflet-interactive[fill-opacity="0.6"]');
      const el = sel[0];
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        attrStroke: el.getAttribute('stroke'),
        attrStrokeOpacity: el.getAttribute('stroke-opacity'),
        attrStrokeWidth: el.getAttribute('stroke-width'),
        attrFill: el.getAttribute('fill'),
        attrFillOpacity: el.getAttribute('fill-opacity'),
        attrClass: el.getAttribute('class'),
        cssStroke: cs.stroke,
        cssStrokeOpacity: cs.strokeOpacity,
        cssStrokeWidth: cs.strokeWidth,
        cssFill: cs.fill,
        cssFillOpacity: cs.fillOpacity,
      };
    });
    console.log('BORDER_PROBE', JSON.stringify(borderProbe));

    // ---- Issue #3 probe ----
    // Locate any rendered suburb label.
    const labelProbe = await page.evaluate(() => {
      const span = document.querySelector('span.suburb-label');
      if (!span) return null;
      const cs = window.getComputedStyle(span);
      return {
        text: (span.textContent || '').slice(0, 30),
        cssTextAlign: cs.textAlign,
        attrTextAlign: span.getAttribute('style') || '',
        // Bounding box relative to its L.marker icon container so we can
        // sanity-check the centroid relationship.
        rect: (() => {
          const r = span.getBoundingClientRect();
          return { left: r.left, top: r.top, w: r.width, h: r.height };
        })(),
      };
    });
    console.log('LABEL_PROBE', JSON.stringify(labelProbe));

    // ---- Pass / fail ----
    // Issue #2: the SVG stroke must be a non-transparent colour at >=2 px,
    // AND the stroke must not be fully transparent (stroke-opacity must not
    // be "0"). The original bug had stroke="#be185d" + width="2" but
    // stroke-opacity="0" because the idle style set opacity:0 and
    // Leaflet's setStyle merges instead of replacing.
    const strokeAttr = borderProbe?.attrStroke;
    const strokeCss  = borderProbe?.cssStroke;
    const widthAttr  = parseFloat(borderProbe?.attrStrokeWidth || '0');
    const widthCss   = parseFloat(borderProbe?.cssStrokeWidth || '0');
    const strokeOpacityAttr = borderProbe?.attrStrokeOpacity;
    // Accept either attribute unset/null (treated as default 1) or
    // explicitly "1". Anything else (especially "0") is a fail.
    const strokeOpacityOk =
      strokeOpacityAttr === null
      || strokeOpacityAttr === ''
      || strokeOpacityAttr === '1';

    const issue2Pass = !isTransparentStroke(strokeAttr)
      && !isTransparentStroke(strokeCss)
      && widthAttr >= 2
      && strokeOpacityOk;

    // Issue #3: computed text-align of the span must be centre.
    const issue3Pass = labelProbe?.cssTextAlign === 'center';

    console.log('RESULT', JSON.stringify({
        issue2Pass,
        issue3Pass,
        consoleErrors,
      }));

    if (issue2Pass && issue3Pass) {
      console.log('LOOP_GREEN');
      exitCode = 0;
    } else {
      console.log('LOOP_RED', JSON.stringify({
        why: {
          issue2: issue2Pass ? null : {
            strokeAttr, strokeCss, widthAttr, widthCss, strokeOpacityAttr,
          },
          issue3: issue3Pass ? null : { cssTextAlign: labelProbe?.cssTextAlign },
        },
      }));
      exitCode = 1;
    }
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