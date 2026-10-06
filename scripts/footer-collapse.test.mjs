// Tests for the mobile footer auto-collapse behaviour locked by ticket 15.
//
// The footer (defined in index.html) carries the required attributions and
// would dominate the small viewport on a phone. On viewports below 600 px
// it auto-collapses to a small "i" (info) button 2 s after page load;
// tapping "i" expands it again for 5 s before re-collapsing. At >= 600 px
// the footer stays expanded.
//
// We can't drive a browser from Node, so we test the static parts: the
// HTML has the right structure, the CSS has the right rules, and the JS
// carries the timer/click logic that implements the behaviour.
//
// Run with:  node --test scripts/footer-collapse.test.mjs  (from the repo root).

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
let script;

before(() => {
  html = readFileSync(indexPath, 'utf8');

  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  assert.ok(styleMatch, 'index.html must contain a <style> block');
  css = styleMatch[1];

  const scriptMatch = html.match(
    /<script\s+type=["']module["'][\s\S]*?<\/script>/i,
  );
  assert.ok(scriptMatch, 'index.html must contain a <script type="module"> block');
  script = scriptMatch[0];
});

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

function selectorListAt(snippet, openIdx) {
  // Walk back to the previous `;`, `}`, or the START of a CSS comment
  // (`/*`). Walking backward, the comment opener looks like `/*` in
  // reverse — i.e. `*` followed by `/` going forward — but the END of
  // a preceding comment looks like `*/`, i.e. `*` then `/` going
  // backward. Stop at the END of the previous comment (so the slice
  // includes the `/* ... */` block, not a trailing dangling `*/`).
  let i = openIdx - 1;
  while (
    i >= 1 &&
    snippet[i] !== ';' &&
    snippet[i] !== '}' &&
    !(snippet[i - 1] === '*' && snippet[i] === '/')
  ) i--;
  const raw = snippet.slice(i + 1, openIdx).trim();
  return stripTrailingComments(raw).trim();
}

// Strip `/* ... */` blocks from a selector-list string. We use this so
// a rule preceded by a comment (e.g. `/* ticket 15: ... */\n.foo`)
// still resolves to `.foo` instead of the comment-prefixed blob.
function stripTrailingComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

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

function mediaBody(feature) {
  const re = /@media\b([^{]*)\{/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    if (m[1].includes(feature)) {
      return blockBodyAt(css, re.lastIndex - 1);
    }
  }
  return null;
}

function decl(body, property) {
  const re = new RegExp(
    `(?:^|[;{])\\s*${property}\\s*:\\s*([^;]+?)\\s*(?:;|$)`,
  );
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

// Pull the body of the inline `<script type="module">` so tests can inspect it.
function scriptBody() {
  const open = script.indexOf('>') + 1;
  const close = script.lastIndexOf('</script>');
  return script.slice(open, close);
}

describe('footer auto-collapse (ticket 15)', () => {
  describe('DOM structure', () => {
    it('the footer wrapper contains both an info button and the attribution text', () => {
      // The footer must expose both states at once (visible content +
      // collapsed "i" button) and let CSS+JS toggle between them — that
      // is what avoids a resize/layout flash.
      const footerMatch = html.match(/<div\s+class=["']footer["'][\s\S]*?<\/div>\s*(?=<noscript|<script)/);
      assert.ok(footerMatch, 'expected a .footer div before the <noscript>/<script> tags');
      const footer = footerMatch[0];
      assert.match(
        footer,
        /<button[\s\S]*?id=["']footer-info["']/,
        'footer must contain a <button id="footer-info">',
      );
      assert.match(
        footer,
        /Geoscape Australia|OpenStreetMap/,
        'footer must still carry the OSM / Geoscape attribution text (license requirement)',
      );
    });

    it('the info button is a real <button> with a single "i" glyph', () => {
      const btnMatch = html.match(/<button[^>]*id=["']footer-info["'][\s\S]*?<\/button>/);
      assert.ok(btnMatch, 'expected a <button id="footer-info"> ... </button>');
      const innerText = btnMatch[0]
        .replace(/<[^>]+>/g, '')
        .trim();
      assert.equal(innerText, 'i', `info button text must be the single character "i", got "${innerText}"`);
    });

    it('the footer is exactly one element on the page (no desktop/mobile duplicates)', () => {
      const footerCount = (html.match(/<div\s+class=["']footer["']/g) || []).length;
      const infoCount = (html.match(/id=["']footer-info["']/g) || []).length;
      assert.equal(footerCount, 1, 'expected exactly one .footer element');
      assert.equal(infoCount, 1, 'expected exactly one #footer-info button');
    });
  });

  describe('CSS — desktop (>= 600 px): footer stays expanded, info button hidden', () => {
    it('the info button is hidden by default in the base stylesheet', () => {
      const btnBody = ruleBody('.footer-info');
      assert.ok(btnBody, 'expected a .footer-info { ... } rule in the base stylesheet');
      const display = decl(btnBody, 'display');
      assert.equal(
        display,
        'none',
        `info button must default to display: none on desktop, got "${display}"`,
      );
    });

    it('the footer content is visible by default in the base stylesheet', () => {
      // The attribution text sits inside the footer; we just assert the
      // footer itself is rendered (display not none) at base width.
      const footerBody = ruleBody('.footer');
      assert.ok(footerBody, 'expected a .footer { ... } rule in the base stylesheet');
      const display = decl(footerBody, 'display');
      assert.notEqual(
        display,
        'none',
        `.footer must not be display:none in the base stylesheet (got "${display}")`,
      );
    });
  });

  describe('CSS — mobile (< 600 px): collapsed/expanded states are styled', () => {
    const mobile = mediaBody('max-width: 599px');

    it('declares a media query at the 600 px breakpoint (same as ticket 14)', () => {
      assert.ok(
        mobile,
        'expected a `@media (max-width: 599px) { ... }` block — ticket 14 locks the breakpoint at < 600 px and 15 inherits it',
      );
    });

    it('mobile block makes the info button visible when the footer is collapsed', () => {
      assert.ok(mobile, 'mobile media block missing');
      // When collapsed (`data-collapsed="true"`), the button must be
      // visible — this is the rule that surfaces the "i" affordance.
      // CSS for the expanded state is the default, so we don't pin it.
      const collapsedRule = ruleBody(
        '.footer[data-collapsed="true"] .footer-info',
        mobile,
      );
      assert.ok(
        collapsedRule,
        'mobile block must include a `.footer[data-collapsed="true"] .footer-info` rule',
      );
      const display = decl(collapsedRule, 'display');
      assert.notEqual(
        display,
        'none',
        `info button must not be display:none in the collapsed mobile rule (got "${display}")`,
      );
      const minH = decl(collapsedRule, 'min-height');
      const minW = decl(collapsedRule, 'min-width');
      const parsePx = (s) => {
        const m = /^(\d+(?:\.\d+)?)\s*px$/.exec(s || '');
        return m ? Number(m[1]) : NaN;
      };
      // Either an explicit min-* height or the 28px declared in the base
      // stylesheet (inherited) gives a usable touch target. We just need
      // a non-zero button — `28px` width/height is the locked styling.
      const wH = decl(collapsedRule, 'width') || decl(ruleBody('.footer-info'), 'width');
      const hH = decl(collapsedRule, 'height') || decl(ruleBody('.footer-info'), 'height');
      assert.ok(
        parsePx(minH) >= 24 || parsePx(minW) >= 24 || parsePx(wH) >= 24 || parsePx(hH) >= 24,
        `info button must have a usable touch target on mobile (got min-height="${minH}", min-width="${minW}", width="${wH}", height="${hH}")`,
      );
    });

    it('mobile block hides the footer content when the footer is collapsed', () => {
      assert.ok(mobile, 'mobile media block missing');
      const collapsedRule = ruleBody(
        '.footer[data-collapsed="true"] .footer-content',
        mobile,
      );
      assert.ok(
        collapsedRule,
        'mobile block must include a `.footer[data-collapsed="true"] .footer-content` rule that hides the attribution text',
      );
      const display = decl(collapsedRule, 'display');
      assert.equal(
        display,
        'none',
        `footer content must be display:none when collapsed on mobile (got "${display}")`,
      );
    });
  });

  describe('JS — auto-collapse schedule', () => {
    it('uses 2000 ms as the initial auto-collapse delay', () => {
      const body = scriptBody();
      // The implementation may store the delay in a constant and pass it
      // to setTimeout indirectly. Look for the literal value (2000,
      // 2_000, or 2 * 1000) somewhere in the script — that's the
      // 2 s delay the ticket requires.
      assert.match(
        body,
        /\b(?:2000|2_000|2\s*\*\s*1000)\b/,
        'expected a literal 2000 ms (or equivalent) to appear in the script as the initial auto-collapse delay',
      );
    });

    it('uses 5000 ms as the re-collapse delay after a tap', () => {
      const body = scriptBody();
      assert.match(
        body,
        /\b(?:5000|5_000|5\s*\*\s*1000)\b/,
        'expected a literal 5000 ms (or equivalent) to appear in the script as the re-collapse delay after a tap',
      );
    });

    it('wires a click listener on #footer-info that expands the footer', () => {
      const body = scriptBody();
      assert.match(
        body,
        /footer-info[\s\S]*?addEventListener\(\s*['"]click['"]/,
        'expected an addEventListener("click", ...) on the #footer-info element',
      );
    });

    it('gates the auto-collapse on viewport width < 600 px (no collapse on desktop)', () => {
      const body = scriptBody();
      // The JS must reference a width-based breakpoint somewhere —
      // matchMedia, innerWidth, or a named constant — proving the
      // desktop case is opted out of the auto-collapse. We accept
      // either a direct width comparison or a media query string (the
      // breakpoint value can be interpolated from a constant).
      const usesMediaQuery = /matchMedia\s*\([^)]*max-width/i.test(body);
      const usesInnerWidth =
        /innerWidth[^&|]*[<>=!][^&|]*(?:600|599)\b/.test(body);
      const definesBreakpointConstant =
        /(?:const|let|var)\s+\w*(?:BREAKPOINT|WIDTH|MAX)\w*\s*=\s*(?:600|599)\b/i.test(
          body,
        );
      assert.ok(
        usesMediaQuery || usesInnerWidth || definesBreakpointConstant,
        'expected the JS to gate the auto-collapse on the 600 px (or 599 px) breakpoint',
      );
    });

    it('cancels any pending collapse timer when the user taps the info button', () => {
      const body = scriptBody();
      // The "tap to expand" handler must clearTimeout the previously
      // scheduled collapse so a fast tap doesn't get an immediate
      // re-collapse.
      assert.match(
        body,
        /clearTimeout/,
        'expected at least one clearTimeout call (to cancel a pending collapse when the user taps)',
      );
    });
  });
});