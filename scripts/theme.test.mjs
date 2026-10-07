// Tests for the design-token sheet in theme.css.
//
// We don't try to evaluate the CSS — Node has no CSS parser. Instead we
// verify the structural contract: the file exists, links from index.html,
// declares the variables the runtime actually reads, and the on-map label
// class references the font variables rather than a hard-coded stack.
// The runtime behaviour (variables actually take effect) is covered by the
// e2e loop in scripts/click-loop.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const themePath = resolve(repoRoot, 'theme.css');
const indexPath = resolve(repoRoot, 'index.html');

test('theme.css exists at the repo root', () => {
  assert.ok(existsSync(themePath), `expected ${themePath}`);
});

test('index.html links theme.css before the inline <style>', () => {
  const html = readFileSync(indexPath, 'utf8');
  const linkIdx = html.indexOf('href="theme.css"');
  const styleIdx = html.indexOf('<style>');
  assert.ok(linkIdx > 0, 'index.html must contain <link rel="stylesheet" href="theme.css">');
  assert.ok(styleIdx > 0, 'index.html must still contain the inline <style> block');
  assert.ok(linkIdx < styleIdx, 'theme.css link must come before the inline <style>');
});

test('index.html no longer hard-codes a :root { --pink-* } block', () => {
  const html = readFileSync(indexPath, 'utf8');
  // The old block lived inside the inline <style>. After the move it should
  // not appear there.
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  assert.ok(style, 'inline <style> must still exist');
  assert.equal(/:root\s*\{/.test(style[1]), false, 'no :root { ... } block in inline CSS — they live in theme.css');
});

test('theme.css declares every variable the runtime reads', () => {
  const css = readFileSync(themePath, 'utf8');
  // What the page actually reads at runtime, including the constants in the
  // export pipeline and the polygon style helpers.
  const required = [
    '--pink-fill',
    '--pink-fill-hover',
    '--pink-border',
    '--pink-edit',
    '--label-fg',
    '--label-halo',
    '--label-font-family',
    '--label-font-size',
    '--label-line-height',
    '--bg-footer',
    '--fg-footer',
    '--fg-link',
    '--control-bg',
    '--control-fg',
    '--body-font',
    '--footer-info-font',
  ];
  for (const v of required) {
    assert.match(css, new RegExp(`${v}\\s*:`), `theme.css must declare ${v}`);
  }
});

test('inline CSS no longer hard-codes the suburb-label font stack', () => {
  const html = readFileSync(indexPath, 'utf8');
  const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  assert.ok(style, 'inline <style> must still exist');
  // The old line was `font: 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;`
  // inside `.suburb-label { ... }`. Now it must reference the CSS variables.
  const suburbLabelBlock = style[1].match(/\.suburb-label\s*\{([^}]*)\}/);
  assert.ok(suburbLabelBlock, '.suburb-label rule must still exist');
  assert.match(suburbLabelBlock[1], /var\(--label-font-family\)/, 'must reference --label-font-family');
  assert.match(suburbLabelBlock[1], /var\(--label-font-size\)/,   'must reference --label-font-size');
  assert.equal(/Segoe UI/.test(suburbLabelBlock[1]), false, 'no hard-coded "Segoe UI" in the suburb-label block');
});

test('inline JS no longer hard-codes a font in the canvas export helpers', () => {
  const html = readFileSync(indexPath, 'utf8');
  // The old line lived in `drawLabel` and `drawAttribution`:
  //   `\`${...}px system-ui, -apple-system, "Segoe UI", sans-serif\``
  // The new helpers use `readCssVar('--label-font-family', ...)` instead.
  assert.equal(
    /\$\{[^}]*\}px system-ui/.test(html),
    false,
    'no template-literal font shorthand should remain in the inline JS — the export reads --label-font-family from theme.css',
  );
  assert.match(html, /readCssVar\(['"]--label-font-family['"]/, 'drawLabel must read --label-font-family from CSS');
  assert.match(html, /readCssVar\(['"]--label-fg['"]/,           'drawLabel must read --label-fg from CSS');
  assert.match(html, /readCssVar\(['"]--label-halo['"]/,         'drawLabel must read --label-halo from CSS');
});

test('inline JS no longer hard-codes PINK_FILL / PINK_BORDER hex values', () => {
  const html = readFileSync(indexPath, 'utf8');
  // The old constants were `const PINK_FILL = '#f472b6';` etc. They should
  // now be derived from CSS variables with a fallback only.
  assert.equal(
    /const PINK_FILL\s*=\s*'#/.test(html),
    false,
    'PINK_FILL must be derived from --pink-fill, not hard-coded as a hex literal',
  );
  assert.match(html, /cssVar\(['"]--pink-fill['"]/, 'PINK_FILL must read --pink-fill from CSS');
  assert.match(html, /cssVar\(['"]--pink-border['"]/, 'PINK_BORDER must read --pink-border from CSS');
});
