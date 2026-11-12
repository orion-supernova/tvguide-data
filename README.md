# tvguide-data

Static TV listings (JSON) for the TV Guide app, rebuilt every 4 hours by GitHub Actions and served from GitHub Pages.

- `build.mjs` — Turkey (`tr`). Dependency-free Node 22 fetcher. Sources: Digiturk (backbone), TV+ (images, descriptions, genres), beIN Sports (full evening schedule for beIN channels). Channels: `channels.tr.json`.
- `build-intl.mjs` — every other country, one curated channel list per country in `countries/<cc>.json`:

  | Country | Source |
  |---|---|
  | gb United Kingdom | sky.com via [iptv-org/epg](https://github.com/iptv-org/epg) |
  | de Germany | web.magentatv.de via iptv-org/epg |
  | fr France | programme-tv.net via iptv-org/epg |
  | nl Netherlands | tvgids.nl via iptv-org/epg |
  | it Italy | Sky Italia guide API (guidatv.sky.it) |
  | es Spain | Movistar Plus+ EPG |
  | se Sweden | tv24.se |
  | us United States | TVmaze schedule API (series/shows only) |

  iptv-org/epg is checked out in CI at a pinned commit (`EPG_SHA` in the workflow); locally set `EPG_DIR` to a checkout with `npm ci` done. A country that fails is left out of `countries.json` without affecting the others.

Output:
- `/countries.json` — `{ updatedAt, countries: [{ code, name, nameEn, tz, channels }] }`
- `/<cc>/index.json`, `/<cc>/channels.json`, `/<cc>/YYYY-MM-DD.json` (yesterday … +2, local dates)
- `/logos/*` (Turkey), `/logos/<cc>/*` (other countries; committed under `logos/`)

Run locally: `node build.mjs && EPG_DIR=../epg node build-intl.mjs` → `out/`.

Listings are compiled from publicly available schedule pages and may change.
