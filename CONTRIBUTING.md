# Contributing to Cable Atlas

Thanks for your interest! This is a small, dependency-light project — the
whole app is three files plus bake scripts.

## Setup

```bash
npm install
npm run vendor   # copies the maplibre worker into public/vendor (needed once)
npm run dev      # Vite dev server
npm run build    # production build into dist/
```

Node 20+ recommended. No API keys needed — all data is baked into
`public/data/`.

## Code layout

| Path | What lives there |
|---|---|
| `src/main.js` | the 3D globe app: cables shader, satellites, routing, tour, search, panels |
| `src/map2d.js` | the 2D MapLibre view (lazy-loaded), kept in sync with 3D state |
| `src/style.css` | all UI styling (dark theme, HUD, panels) |
| `index.html` | HUD markup |
| `scripts/fetch-*.mjs` | data bake scripts (TeleGeography, Natural Earth, CelesTrak) |
| `deploy/` | nginx config + Kubernetes manifest |

## Principles

1. **Everything on screen is real data** — no decorative fake geography,
   invented routes, or made-up satellites. If a feature can't be backed by a
   public dataset, it gets an explicit "illustrative" label (see routing).
2. **Static and self-contained** — no backends, no API keys, no external
   requests at runtime. New data goes through a bake script into
   `public/data/`.
3. **One draw call beats a hundred** — the cable layer is a single merged
   geometry driven by one shader. Follow that pattern for new bulk visuals.
4. **Verify visually** — screenshot your change (any headless browser that
   renders WebGL, e.g. Playwright) before opening a PR.

## Data refresh

TeleGeography adds cables continuously; a PR that just re-runs the bake
scripts and commits fresh JSON is welcome anytime.

## Commit style

Plain imperative subject lines, body explaining why. No AI co-author
trailers.
