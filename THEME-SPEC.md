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
