// Tests for the responsive mobile bottom-bar layout locked by ticket 14.
//
// The page's responsive layout is implemented in plain CSS inside the
// `<style>` block of index.html. We can't render the page from Node, so we
// verify the CSS rules that produce the layout — a media query at the
// 600 px breakpoint with the right flexbox `order` swaps so the controls
// render between the map and the footer on narrow viewports, and the
// button touch targets are at least 44 × 44 px.
//
// Run with:  node --test scripts/layout.test.mjs  (from the repo root).

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const indexPath = resolve(repoRoot, 'index.html');

let html;
let css;

before(() => {
  html = readFileSync(indexPath, 'utf8');
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  assert.ok(styleMatch, 'index.html must contain a <style> block');
  css = styleMatch[1];
});

// Body of the balanced brace block starting at `openIdx` (an index of `{`)
// in `snippet`. Returns the contents between the braces.
function blockBodyAt(snippet, openIdx) {
  let j = openIdx + 1;
  let depth = 1;
  while (j < snippet.length && depth > 0) {
    const ch = snippet[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    j++;
  }
  return snippet.slice(openIdx + 1, j - 1);
}

// Selector list (text immediately before an open brace) — we strip
// whitespace and require it to equal `selector` exactly so comma-list
// entries like `html, body` don't match a `body` lookup.
function selectorListAt(snippet, openIdx) {
  let i = openIdx - 1;
  while (i >= 0 && snippet[i] !== ';' && snippet[i] !== '}') i--;
  return snippet.slice(i + 1, openIdx).trim();
}

// Body of the first CSS rule in `snippet` whose selector list equals
// `selector`. `snippet` defaults to the whole stylesheet.
function ruleBody(selector, snippet = css) {
  const re = /\{/g;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    if (selectorListAt(snippet, m.index) === selector) {
      return blockBodyAt(snippet, m.index);
    }
  }
  return null;
}

// Body of the first @media query whose query list contains `feature`
// (e.g. "max-width: 599px").
function mediaBody(feature) {
  const re = /@media\b([^{]*)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (m[1].includes(feature)) {
      // The match is `@media <feature> {` — the `{` sits at the end.
      return blockBodyAt(css, re.lastIndex - 1);
    }
  }
  return null;
}

// Trimmed value of a top-level `property: value` declaration in `body`, or
// null when missing.
function decl(body, property) {
  const re = new RegExp(
    `(?:^|[;{])\\s*${property}\\s*:\\s*([^;]+?)\\s*(?:;|$)`,
  );
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

// Parse "44px" → 44. Anything else returns NaN.
function parsePx(s) {
  const m = /^(\d+(?:\.\d+)?)\s*px$/.exec(s || '');
  return m ? Number(m[1]) : NaN;
}

describe('mobile bottom-bar layout (ticket 14)', () => {
  describe('DOM structure', () => {
    it('body has direct children for controls, map, and footer in source order', () => {
      // DOM order stays stable across the breakpoint; the mobile layout
      // reorders visually via flexbox `order`. That's what avoids the
      // resize flash.
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      assert.ok(bodyMatch, 'index.html must have a <body> element');
      const body = bodyMatch[1];
      const controlsIdx = body.search(/<div\s+class=["']controls["']/);
      const mapIdx = body.search(/<div\s+id=["']map["']/);
      const footerIdx = body.search(/<div\s+class=["']footer["']/);
      assert.ok(controlsIdx > -1, 'expected <div class="controls">');
      assert.ok(mapIdx > -1, 'expected <div id="map">');
      assert.ok(footerIdx > -1, 'expected <div class="footer">');
      assert.ok(controlsIdx < mapIdx, 'controls must precede map in source');
      assert.ok(mapIdx < footerIdx, 'map must precede footer in source');
    });

    it('controls contain an Export PNG button and a Clear button', () => {
      const controlsMatch = html.match(
        /<div\s+class=["']controls["'][\s\S]*?<\/div>\s*(?=<div\s+id=["']map)/,
      );
      assert.ok(controlsMatch, 'expected controls div before map');
      assert.match(controlsMatch[0], /id=["']export-btn["']/);
      assert.match(controlsMatch[0], /id=["']clear-btn["']/);
    });
  });

  describe('CSS — base layout (>= 600 px)', () => {
    it('body lays out its children as a vertical flex stack', () => {
      const body = ruleBody('body');
      assert.ok(body, 'expected a body { ... } rule');
      assert.match(body, /flex\s*-direction\s*:\s*column/);
    });

    it('#map takes the flexible middle slot', () => {
      const map = ruleBody('#map');
      assert.ok(map, 'expected a #map { ... } rule');
      assert.match(map, /flex\s*:\s*1\s+1/);
    });

    it('footer and controls are flex-shrink-0 so they keep their natural size', () => {
      for (const sel of ['.controls', '.footer']) {
        const body = ruleBody(sel);
        assert.ok(body, `expected a ${sel} { ... } rule`);
        assert.match(
          body,
          /flex\s*-shrink\s*:\s*0/,
          `${sel} must have flex-shrink: 0`,
        );
      }
    });
  });

  describe('CSS — mobile layout (< 600 px)', () => {
    const mobile = mediaBody('max-width: 599px');

    it('declares a media query at the 600 px breakpoint', () => {
      assert.ok(
        mobile,
        'expected a `@media (max-width: 599px) { ... }` block — ticket 14 locks the breakpoint at < 600 px',
      );
    });

    it('moves the map to the top of the visual stack on mobile', () => {
      assert.ok(mobile, 'mobile media block missing');
      const mapBody = ruleBody('#map', mobile);
      assert.ok(mapBody, 'mobile block must include a `#map` rule');
      const mapOrder = decl(mapBody, 'order');
      assert.ok(mapOrder !== null, '#map.order must be set in mobile block');
      assert.ok(Number.isFinite(Number(mapOrder)), `#map.order must be a number, got "${mapOrder}"`);
    });

    it('moves the controls below the map on mobile (controls.order > map.order)', () => {
      assert.ok(mobile, 'mobile media block missing');
      assert.ok(ruleBody('.controls', mobile), 'mobile block must include a `.controls` rule');
      const mapOrder = decl(ruleBody('#map', mobile), 'order');
      const ctrlOrder = decl(ruleBody('.controls', mobile), 'order');
      assert.ok(Number.isFinite(Number(mapOrder)), `map.order must be a number, got "${mapOrder}"`);
      assert.ok(Number.isFinite(Number(ctrlOrder)), `controls.order must be a number, got "${ctrlOrder}"`);
      assert.ok(
        Number(ctrlOrder) > Number(mapOrder),
        `controls.order (${ctrlOrder}) must be greater than map.order (${mapOrder}) so controls render below the map`,
      );
    });

    it('keeps the footer at the bottom on mobile', () => {
      assert.ok(mobile, 'mobile media block missing');
      // The footer must be explicitly reordered past the controls on
      // mobile; with default `order: 0` it would render BEFORE the
      // controls (controls.order > 0).
      const footerBody = ruleBody('.footer', mobile);
      assert.ok(
        footerBody,
        'mobile block must include a `.footer` rule so the footer renders below the controls',
      );
      const footerOrder = Number(decl(footerBody, 'order'));
      const ctrlOrder = Number(decl(ruleBody('.controls', mobile), 'order'));
      assert.ok(
        footerOrder > ctrlOrder,
        `footer.order (${footerOrder}) must be greater than controls.order (${ctrlOrder})`,
      );
    });

    it('gives the buttons a 44 × 44 px touch target on mobile', () => {
      assert.ok(mobile, 'mobile media block missing');
      const btnBody = ruleBody('.controls button', mobile);
      assert.ok(btnBody, 'mobile block must include a `.controls button` rule');
      const minH = decl(btnBody, 'min-height');
      const minW = decl(btnBody, 'min-width');
      assert.ok(parsePx(minH) >= 44, `min-height must be >= 44px on mobile, got ${minH}`);
      assert.ok(parsePx(minW) >= 44, `min-width must be >= 44px on mobile, got ${minW}`);
    });
  });

  describe('CSS — no resize flash across the breakpoint', () => {
    it('does not duplicate the controls / map / footer as separate mobile-only DOM nodes', () => {
      // A common anti-pattern is re-rendering the controls on resize,
      // which flashes. There must be exactly one of each.
      const controlsCount = (html.match(/<div\s+class=["']controls["']/g) || []).length;
      const mapCount = (html.match(/<div\s+id=["']map["']/g) || []).length;
      const footerCount = (html.match(/<div\s+class=["']footer["']/g) || []).length;
      assert.equal(controlsCount, 1, 'expected exactly one .controls element');
      assert.equal(mapCount, 1, 'expected exactly one #map element');
      assert.equal(footerCount, 1, 'expected exactly one .footer element');
    });
  });
});