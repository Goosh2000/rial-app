# Rial theme file spec

A **theme** is a JSON file at `themes/<id>.theme.json`. `build-themes.js` merges each
one onto `themes/base.theme.json`, generates the CSS + a JS registry, and injects both
into `index.html` between generated markers. The app never fetches these files at
runtime — everything ships inside the single `index.html`.

**To add a theme:** create `themes/<id>.theme.json`, run `node build-themes.js`,
commit `index.html` + the new file. Nothing else changes — the scheduler, the settings
picker, and the tests all read the generated registry.

---

## File format

```jsonc
{
  "id": "monarch",              // REQUIRED. must equal the filename (<id>.theme.json), [a-z0-9-]+
  "name": "Monarch",            // REQUIRED. shown in Settings
  "scheme": "dark",             // REQUIRED. "light" | "dark" — used by the "Match system" scheduler mode
  "tokens": {                   // OPTIONAL. overrides merged onto base.theme.json's tokens.
    "bg": "#0a0e1a",            //   Any key not listed here inherits from base.
    "accent": "#4d8dff"         //   Unknown keys are a build error. Values are raw CSS.
  },
  "font": {                     // OPTIONAL
    "heading": "\"Orbitron\", \"Rajdhani\", system-ui, sans-serif",  // sets --font-heading; falls back to --font
    "imports": [                // stylesheet URLs injected as <link> when this theme is active,
      "https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&display=swap"
    ]                           // cached by the service worker after first online use (works offline after)
  },
  "font": {
    "family": "Orbitron",       // OPTIONAL. plain family name (letters/digits/spaces/hyphens).
                                //   Drives --font-heading and the Google-Fonts URL automatically,
                                //   AND is the only font field that survives link sharing.
    "heading": "\"Orbitron\", \"Rajdhani\", system-ui",  // OPTIONAL explicit stack (overrides the auto one)
    "imports": ["https://..."]  // OPTIONAL explicit stylesheet URLs (overrides the auto Google-Fonts URL)
  },
  "decorativeCss": "..."        // OPTIONAL. raw CSS appended to the stylesheet. MUST self-scope every rule
                                //   with [data-theme="<id>"]. Prefix @keyframes names with <id>- .
}
```

### Token contract (defined by `base.theme.json`, which is **locked**)

Every token below exists on `:root` with base's value; a theme may override any subset.
The build fails if `base.theme.json` is missing a token, adds an unknown one, or has
`"locked"` set to anything but `true`.

| token key      | CSS var         | meaning |
|----------------|-----------------|---------|
| `bg`           | `--bg`          | app background |
| `bg-elev`      | `--bg-elev`     | card / sheet surface |
| `bg-elev-2`    | `--bg-elev-2`   | inset controls, chips, tracks |
| `line`         | `--line`        | hairline borders / dividers |
| `text`         | `--text`        | primary text |
| `text-dim`     | `--text-dim`    | secondary text (must stay ≥ 3:1 on `bg`) |
| `text-faint`   | `--text-faint`  | tertiary text / hints |
| `accent`       | `--accent`      | primary action colour |
| `accent-ink`   | `--accent-ink`  | text/icon on top of `accent` |
| `pos`          | `--pos`         | positive money / success |
| `neg`          | `--neg`         | negative money / danger |
| `warn`         | `--warn`        | warnings / at-pace |
| `shadow`       | `--shadow`      | elevation shadow (full CSS value) |
| `r-lg`         | `--r-lg`        | large radius (cards, sheets) |
| `r-md`         | `--r-md`        | medium radius (buttons, fields) |
| `r-sm`         | `--r-sm`        | small radius |

Not themeable (stay global on `:root`): `--font`, `--sat`, `--sab`, `--tap`, `--spring`.

### Readability bar

`build-themes.js` computes WCAG contrast for every theme and **fails the build** if
`text` vs `bg` < 4.5:1 or `text-dim` vs `bg` < 3:1. `test-browser.mjs` re-checks this
against a real browser render.

### Generated regions in `index.html` (do not hand-edit)

```
/* THEMES-CSS:START */ … /* THEMES-CSS:END */     inside <style>
/* THEMES-JS:START */  … /* THEMES-JS:END */      inside <script>
```

`test.mjs` re-runs the build in memory and fails if these regions are stale
(i.e. a `.theme.json` was edited without rebuilding).

---

## Link sharing (`Settings › Theme › Copy share link` / `Show QR`)

A theme can be shared as `https://<pages-url>/#theme=<payload>`. The payload lives in
the **URL fragment**, so it never reaches a server. `<payload>` is
`<marker><url-safe-base64>` where marker `d` = `deflate-raw`-compressed JSON, `r` = raw
JSON. On import it is decoded, then validated **strictly** against a v1 schema; **any**
deviation rejects the whole link and leaves the app on its current theme.

### What a shared theme is

```jsonc
{ "v": 1, "id": "<a-z0-9->", "name": "…", "author": "…"?, "scheme": "light|dark",
  "tokens": { "<tokenKey>": "<value>", … }, "font": "<Family Name>"? }
```

### What survives vs. what is stripped

| field | shared? | notes |
|---|---|---|
| `id`, `name`, `scheme` | ✅ | `id` re-slugged to `<id>-shared` if it collides with a built-in |
| `author` | ✅ (optional) | plain text, ≤ 40 chars, no markup |
| `tokens` (the 16 palette/shadow/radius tokens) | ✅ | each value must pass a **strict** pattern (see below) or the link is rejected |
| `font.family` | ✅ (optional) | plain name only (`[A-Za-z0-9][A-Za-z0-9 -]{0,39}`); loaded from Google Fonts **by name** — the sender's `font.imports` URLs are **never** used |
| `font.heading`, `font.imports` | ❌ stripped | recipient's stack/URL is rebuilt locally from `font.family` |
| `decorativeCss` | ❌ **stripped** | scanlines, System-window borders, `::before`, `@keyframes`, extra glows — none of it travels |
| any audio / `music` / `sound` field | ❌ **rejected** | an unknown key; the import preview states "Audio is not included in shared themes." |
| any other key | ❌ **rejected** | unknown top-level or token keys fail the whole link |

### Value rules (reject, never sanitise)

* Every string value is gated for `<` `>` `url(` `expression` `javascript:` `@import`
  `/*` `\` `` ` `` `{` `}` `;` `data:` `-moz-binding` … — presence = reject.
* Colour tokens: `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`, `rgb()/rgba()`,
  `hsl()/hsla()`, or a name from a fixed keyword list. `color-mix()`, `var()`,
  `calc()`, `currentColor` → rejected.
* `shadow`: up to 4 comma-separated `[inset] <len> <len> [<len>] [<len>] [<color>]`
  layers, colours restricted to `#hex` / `rgb[a]()` / `hsl[a]()`.
* `r-lg` / `r-md` / `r-sm`: a single `<number>[px|rem|em|%]` or `0`.

### Limits & failure

* Fragment payload ≤ 2800 chars; decoded JSON ≤ 4096 bytes → otherwise "too large".
* Malformed base64 / bad marker / non-JSON / oversized → a readable toast, app untouched,
  fragment cleared.
* Import **always** shows a preview (name, author, live mini-preview, the strip notes)
  with explicit **Import / Cancel** — a link is never auto-applied.
* Imported themes are stored in the `userThemes` meta array (in the JSON backup),
  are deletable in Settings, and can never overwrite a built-in.
* The **QR code** is generated on-device (`QR` — a condensed Nayuki byte-mode encoder);
  if the link is too long to encode, the QR screen says so and offers Copy link.
