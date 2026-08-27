/* build-themes.js — compile themes/*.theme.json into index.html.
 *
 *   node build-themes.js            # write generated regions into index.html
 *   node build-themes.js --check    # exit 1 if index.html is out of sync (CI / tests)
 *
 * Merges each theme onto themes/base.theme.json, validates the token contract and
 * WCAG contrast, then replaces the two generated marker regions in index.html:
 *   <style>  … /* THEMES-CSS:START *​/ … /* THEMES-CSS:END *​/ …
 *   <script> … /* THEMES-JS:START *​/ … /* THEMES-JS:END *​/ …
 * Pure Node core, no dependencies. See THEME-SPEC.md.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const THEMES_DIR = path.join(DIR, "themes");
const INDEX = path.join(DIR, "index.html");

/* the locked contract — base.theme.json must define exactly these token keys */
const TOKEN_KEYS = [
  "bg", "bg-elev", "bg-elev-2", "line",
  "text", "text-dim", "text-faint",
  "accent", "accent-ink", "pos", "neg", "warn",
  "shadow", "r-lg", "r-md", "r-sm",
];
const DEFAULT_ID = "midnight";

const die = (msg) => { console.error("build-themes: " + msg); process.exit(1); };

/* ---- WCAG contrast (hex only; other formats skipped) ---- */
function hexRGB(c) {
  if (typeof c !== "string") return null;
  let h = c.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((x) => x + x).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function relLum(rgb) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrast(a, b) {
  const ra = hexRGB(a), rb = hexRGB(b);
  if (!ra || !rb) return null;
  const [hi, lo] = [relLum(ra), relLum(rb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ---- load + validate ---- */
function readTheme(file) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { die(`${path.basename(file)}: invalid JSON — ${e.message}`); }
  return obj;
}

const basePath = path.join(THEMES_DIR, "base.theme.json");
if (!fs.existsSync(basePath)) die("themes/base.theme.json is missing");
const base = readTheme(basePath);
if (base.locked !== true) die("base.theme.json must have \"locked\": true");
{
  const keys = Object.keys(base.tokens || {}).sort();
  const want = TOKEN_KEYS.slice().sort();
  if (keys.join(",") !== want.join(","))
    die(`base.theme.json token keys drifted from the contract.\n  have: ${keys.join(", ")}\n  want: ${want.join(", ")}`);
}
for (const k of TOKEN_KEYS) if (typeof base.tokens[k] !== "string" || !base.tokens[k])
  die(`base.theme.json token "${k}" must be a non-empty string`);

const files = fs.readdirSync(THEMES_DIR)
  .filter((f) => f.endsWith(".theme.json") && f !== "base.theme.json")
  .sort();
if (!files.length) die("no themes/*.theme.json files found");

const themes = files.map((f) => {
  const id = f.replace(/\.theme\.json$/, "");
  const t = readTheme(path.join(THEMES_DIR, f));
  if (t.id !== id) die(`${f}: "id" is "${t.id}" but must equal "${id}"`);
  if (!/^[a-z0-9-]+$/.test(id)) die(`${f}: id must match [a-z0-9-]+`);
  if (!t.name || typeof t.name !== "string") die(`${f}: "name" is required`);
  if (t.scheme !== "light" && t.scheme !== "dark") die(`${f}: "scheme" must be "light" or "dark"`);

  const overrides = t.tokens || {};
  for (const k of Object.keys(overrides))
    if (!TOKEN_KEYS.includes(k)) die(`${f}: unknown token "${k}" (see THEME-SPEC.md)`);
  const tokens = { ...base.tokens, ...overrides };

  const cText = contrast(tokens.bg, tokens.text);
  const cDim = contrast(tokens.bg, tokens["text-dim"]);
  if (cText != null && cText < 4.5) die(`${f}: text vs bg contrast ${cText.toFixed(2)}:1 < 4.5:1`);
  if (cDim != null && cDim < 3) die(`${f}: text-dim vs bg contrast ${cDim.toFixed(2)}:1 < 3:1`);

  const font = { family: null, heading: null, imports: [], ...(base.font || {}), ...(t.font || {}) };
  if (font.imports && !Array.isArray(font.imports)) die(`${f}: font.imports must be an array`);
  for (const u of (font.imports || [])) if (!/^https:\/\//.test(u)) die(`${f}: font import must be https — ${u}`);
  if (font.family != null && !/^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/.test(font.family))
    die(`${f}: font.family must be a plain family name (letters, digits, spaces, hyphens)`);
  // font.family is the canonical single name (drives link-sharing). If heading / imports
  // aren't given explicitly, derive them from the family.
  const googleFontUrl = (fam) =>
    "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(fam).replace(/%20/g, "+") + ":wght@400;600;700&display=swap";
  const fontHeading = font.heading || (font.family ? `"${font.family}", "SF Pro Display", system-ui, sans-serif` : null);
  const fontImports = (font.imports && font.imports.length) ? font.imports : (font.family ? [googleFontUrl(font.family)] : []);

  return {
    id, name: t.name, scheme: t.scheme, tokens,
    fontFamily: font.family || null,
    fontHeading,
    fontImports,
    decorativeCss: typeof t.decorativeCss === "string" ? t.decorativeCss : "",
    contrast: { text: cText && +cText.toFixed(2), dim: cDim && +cDim.toFixed(2) },
  };
});

if (!themes.some((t) => t.id === DEFAULT_ID)) die(`the default theme "${DEFAULT_ID}" has no themes/${DEFAULT_ID}.theme.json`);

/* ---- generate CSS ---- */
const cssVars = (tokens, heading) => {
  const lines = TOKEN_KEYS.map((k) => `  --${k}: ${tokens[k]};`);
  if (heading) lines.push(`  --font-heading: ${heading};`);
  return lines.join("\n");
};
let css = "";
// default theme also answers the bare :root
const def = themes.find((t) => t.id === DEFAULT_ID);
css += `:root, :root[data-theme="${DEFAULT_ID}"]{\n${cssVars(def.tokens, def.fontHeading)}\n}\n`;
for (const t of themes) {
  if (t.id === DEFAULT_ID) continue;
  css += `:root[data-theme="${t.id}"]{\n${cssVars(t.tokens, t.fontHeading)}\n}\n`;
}
for (const t of themes) {
  const d = t.decorativeCss.trim();
  if (d) css += `\n/* ${t.id} decorative */\n${d}\n`;
}

/* ---- generate JS registry (default theme first, then the rest as sorted) ---- */
const ordered = [def, ...themes.filter((t) => t.id !== DEFAULT_ID)];
const registry = {};
for (const t of ordered) registry[t.id] = {
  id: t.id, name: t.name, scheme: t.scheme,
  bg: t.tokens.bg,
  tokens: t.tokens,                 // full resolved 16-token palette (for link sharing)
  fontFamily: t.fontFamily,
  fontImports: t.fontImports,
};
const js =
  `/* generated from themes/*.theme.json by build-themes.js — do not edit here */\n` +
  `const THEMES = ${JSON.stringify(registry, null, 2)};\n` +
  `const THEME_DEFAULT = ${JSON.stringify(DEFAULT_ID)};\n` +
  `const THEME_TOKEN_KEYS = ${JSON.stringify(TOKEN_KEYS)};`;

/* ---- splice into index.html ---- */
function splice(src, startMark, endMark, payload, label) {
  const s = src.indexOf(startMark), e = src.indexOf(endMark);
  if (s === -1 || e === -1 || e < s) die(`index.html is missing the ${label} markers (${startMark} … ${endMark})`);
  return src.slice(0, s + startMark.length) + "\n" + payload.trim() + "\n" + src.slice(e);
}
let html = fs.readFileSync(INDEX, "utf8");
const before = html;
html = splice(html, "/* THEMES-CSS:START */", "/* THEMES-CSS:END */", css, "CSS");
html = splice(html, "/* THEMES-JS:START */", "/* THEMES-JS:END */", js, "JS");

const check = process.argv.includes("--check");
if (check) {
  if (html !== before) die("index.html is out of sync with themes/*.theme.json — run: node build-themes.js");
  console.log("build-themes: index.html is in sync (" + themes.map((t) => t.id).join(", ") + ")");
  process.exit(0);
}
if (html !== before) {
  fs.writeFileSync(INDEX, html);
  console.log("build-themes: wrote index.html");
} else {
  console.log("build-themes: index.html already current");
}
console.log("themes: " + themes.map((t) => `${t.id} (text ${t.contrast.text}:1, dim ${t.contrast.dim}:1)`).join("\n        "));
