# TV Rehberi — guide data

Static TV listings (JSON) for the TV Rehberi app, rebuilt every 4 hours by GitHub Actions and served from GitHub Pages.

- `build.mjs` — dependency-free Node 22 fetcher. Sources: Digiturk (backbone), TV+ (images, descriptions, genres), beIN Sports (full evening schedule for beIN channels).
- `channels.tr.json` — curated channel list and source IDs.
- Output: `/tr/index.json`, `/tr/channels.json`, `/tr/YYYY-MM-DD.json`, `/logos/*`.

Run locally: `node build.mjs` → `out/`.

Listings are compiled from publicly available schedule pages and may change.
