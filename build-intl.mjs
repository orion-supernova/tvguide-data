// International TV guide builder. Zero npm dependencies — Node 22+ only.
// Builds every country in countries/<cc>.json (Turkey has its own build.mjs) and writes out/countries.json.
//
//   node build-intl.mjs             all countries
//   node build-intl.mjs gb de       only these
//   node build-intl.mjs --index     only rewrite out/countries.json from what is in out/
//
// Sources (countries/<cc>.json → "source.type"):
//   epg     iptv-org/epg grabber (community-maintained parsers) run on our curated channel list.
//           Needs EPG_DIR = a checkout of github.com/iptv-org/epg with `npm ci` done.
//   tv24    tv24.se channel pages (one request per channel per day; former Sweden source, kept as a fallback).
//   allente Allente EPG (allente.dk/.no/.se): one request per day for every channel.
//   meo     MEO Portugal: one request per channel per day.
//   onet    programtv.onet.pl (Poland): one page per channel per day.
//   movistar  Movistar Plus+ OTT EPG JSON (one request per channel per day).
//   skyit   Sky Italia guide API (one request per channel per day; it has no past days).
//   tvmaze  TVmaze schedule API (one request per day, network = channel; series/shows only).
//
// Output (per country, same contract as Turkey):
//   out/<cc>/index.json        { updatedAt, dates[] }            yesterday … +2, local dates
//   out/<cc>/channels.json     { country, timezone, updatedAt, channels[] }
//   out/<cc>/YYYY-MM-DD.json   { date, programs: { [channelId]: Program[] } }
//   out/logos/<cc>/<id>.<ext>  self-hosted logos (committed under logos/<cc>/)
// A country that fails (or has data for fewer than half its channels today) is skipped and left out
// of countries.json; it never affects the other countries.

import { readFile, writeFile, mkdir, cp, rm, readdir, access, mkdtemp } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.OUT_DIR || join(ROOT, 'out')
const EPG_DIR = process.env.EPG_DIR || join(ROOT, 'epg')
const DAYS_AHEAD = 3 // today + 2
const KEEP_PAST_DAYS = 1 // yesterday
const MAX_DESC = 400 // keep day files small
const ORDER = ['tr', 'gb', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'se', 'dk', 'no', 'us']
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const logger = (cc) => (...a) => console.log(`[${cc}]`, ...a)

// ---------- time zones (real DST via Intl, no hard-coded offsets) ----------
const ymdFmt = new Map()
/** local calendar date (YYYY-MM-DD) of a unix-seconds instant in `tz` */
export function localDate(sec, tz) {
  if (!ymdFmt.has(tz)) ymdFmt.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }))
  return ymdFmt.get(tz).format(new Date(sec * 1000))
}
function offsetMin(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  )
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000) / 60000
}
/** unix seconds of a local wall-clock time in `tz` */
export function zonedEpoch(ymd, hh, mm, tz) {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d, hh, mm)
  let t = guess - offsetMin(guess, tz) * 60e3
  const off2 = offsetMin(t, tz)
  t = guess - off2 * 60e3
  return Math.floor(t / 1000)
}
export const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// ---------- http ----------
async function get(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (err) {
      if (i >= tries) throw err
      await sleep(2000 * i)
    }
  }
}

const decode = (s = '') =>
  String(s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const clip = (s, n = MAX_DESC) => (s && s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s)

/** Program normaliser: trims strings, drops empty optional fields. */
function prog({ s, e, t, sub, g, d, i, live, rerun }) {
  t = decode(t).replace(/^New:\s+/, '') // Sky UK marks premieres in the title
  sub = decode(sub).replace(/^"(.*)"$/, '$1').replace(/^(Ep\. \d+) "(.*)"$/, '$1 · $2')
  d = clip(decode(d))
  g = decode(g)
  if (sub && sub.toLowerCase() === t.toLowerCase()) sub = ''
  if (d && (d.toLowerCase() === t.toLowerCase() || d.toLowerCase() === sub.toLowerCase())) d = ''
  return {
    s, e, t,
    ...(sub && { sub }),
    ...(g && { g }),
    ...(d && { d }),
    ...(typeof i === 'string' && /^https?:\/\//.test(i) && { i }),
    ...(live && { live: 1 }),
    ...(rerun && { rerun: 1 }),
  }
}

/** sorted by start, no duplicates, no overlaps, sane durations */
export function clean(list) {
  const sorted = list
    .filter((p) => p.t && Number.isFinite(p.s) && Number.isFinite(p.e) && p.e > p.s && p.e - p.s <= 12 * 3600)
    .sort((a, b) => a.s - b.s || b.e - a.e)
  const out = []
  for (const p of sorted) {
    const prev = out[out.length - 1]
    if (prev && p.s === prev.s) continue // duplicate start: keep the first (longest)
    if (prev && p.s < prev.e) prev.e = p.s // overlap: the earlier one ends when the next starts
    out.push({ ...p })
  }
  return out
}

// ---------- source: iptv-org/epg grabber ----------
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function run(cmd, args, opts, timeoutMs, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const onData = (buf) => {
      const text = buf.toString()
      tail = (tail + text).slice(-4000)
      for (const line of text.split('\n')) if (/ERR|error|\(0 programs\)/i.test(line)) log('grab:', line.trim())
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => { log('grab timed out, killing'); child.kill('SIGKILL') }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve() : reject(new Error(`grab exited with ${code}: ${tail.slice(-500)}`))
    })
  })
}

async function srcEpg(cfg, dates, log) {
  const { site, lang = 'en', delay = 1000, timeoutMin = 15 } = cfg.source
  await access(join(EPG_DIR, 'package.json')).catch(() => { throw new Error(`EPG_DIR not found: ${EPG_DIR}`) })
  const tmp = await mkdtemp(join(tmpdir(), `epg-${cfg.code}-`))
  const channelsXml = join(tmp, 'channels.xml'), jsonOut = join(tmp, 'guide.json')
  await writeFile(
    channelsXml,
    `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${cfg.channels
      .map((c) => `  <channel site="${site}" site_id="${xmlEsc(c.site_id)}" lang="${lang}" xmltv_id="${xmlEsc(c.id)}">${xmlEsc(c.name)}</channel>`)
      .join('\n')}\n</channels>\n`,
  )
  const args = ['run', 'grab', '--silent', '--', `--channels=${channelsXml}`, `--output=${join(tmp, 'guide.xml')}`, `--json=${jsonOut}`,
    `--days=${dates.length}`, '--maxConnections=1', `--delay=${delay}`, '--timeout=30000']
  // grab day N is CURR_DATE + N (UTC calendar dates); start at our first local date
  await run('npm', args, { cwd: EPG_DIR, env: { ...process.env, CURR_DATE: dates[0] } }, timeoutMin * 60e3, log)

  const data = JSON.parse(await readFile(jsonOut, 'utf8'))
  await rm(tmp, { recursive: true, force: true })
  const bySite = new Map(cfg.channels.map((c) => [c.site_id, c.id]))
  const ids = new Set(cfg.channels.map((c) => c.id))
  const out = {}
  const val = (a) => (Array.isArray(a) && a.length ? a[0].value ?? a[0].src ?? a[0] : '')
  for (const p of data.programs || []) {
    const id = ids.has(p.channel) ? p.channel : bySite.get(p.channel)
    if (!id) continue
    const onscreen = (p.episodeNumbers || []).find((n) => n.system === 'onscreen')?.value || ''
    const ep = onscreen.match(/^S(\d+)E(\d+)$/i)
    const epLabel = ep ? `S${+ep[1]} E${+ep[2]}` : ''
    const subtitle = val(p.subTitles)
    const image = [val(p.images), val(p.icons)].find((u) => typeof u === 'string' && /^https?:\/\//.test(u))
    ;(out[id] ||= []).push(prog({
      s: Math.floor(p.start / 1000),
      e: Math.floor(p.stop / 1000),
      t: val(p.titles),
      sub: [epLabel, subtitle].filter(Boolean).join(' · '),
      g: String(val(p.categories) || '').split('/')[0],
      d: val(p.descriptions),
      i: image,
      rerun: (p.previouslyShown || []).length > 0,
    }))
  }
  return out
}

// ---------- source: tv24.se ----------
async function srcTv24(cfg, dates, log) {
  const out = {}
  // fetch the day before too: its page runs past midnight into our first date
  const fetchDates = [addDays(dates[0], -1), ...dates]
  for (const c of cfg.channels) {
    const list = []
    for (const ymd of fetchDates) {
      try {
        const html = await (await get(`https://tv24.se/x/channel/${c.site_id}/0/${ymd}`)).text()
        let day = ymd, prevMin = -1
        for (const li of html.split('class="program"').slice(1)) {
          const hm = li.match(/class="time">(\d{1,2}):(\d{2})</)
          const title = li.match(/<h3>([\s\S]*?)<\/h3>/)?.[1]
          if (!hm || !title) continue
          const mins = +hm[1] * 60 + +hm[2]
          if (mins < prevMin) day = addDays(day, 1) // page runs past midnight
          prevMin = mins
          list.push({
            s: zonedEpoch(day, +hm[1], +hm[2], cfg.tz),
            t: title,
            sub: li.match(/class="desc">([\s\S]*?)<\/span>/)?.[1],
            d: li.match(/<p>([\s\S]*?)<\/p>/)?.[1],
            live: /class="live"/.test(li),
          })
        }
      } catch (err) { log(`${c.id} ${ymd} failed: ${err.message}`) }
      await sleep(cfg.source.delay ?? 700)
    }
    // pages only give start times: each programme ends when the next starts (dedupe overlapping pages first)
    const uniq = [...new Map(list.map((p) => [p.s, p])).values()].sort((a, b) => a.s - b.s)
    out[c.id] = uniq.slice(0, -1).map((p, i) => prog({ ...p, e: uniq[i + 1].s }))
  }
  return out
}

// ---------- source: Movistar Plus+ ----------
async function srcMovistar(cfg, dates, log) {
  const out = {}
  try { // channel logos (only used for channels without a logo file yet)
    const list = await (await get('https://ottcache.dof6.com/movistarplus/webplayer/OTT/contents/channels?mdrm=true&tlsstream=true&demarcation=18&version=8', {}, 1)).json()
    cfg._logos = {}
    for (const c of cfg.channels) {
      const m = list.find((x) => x.CodCadenaTv === c.site_id)
      const url = m && (m.Logo || m.Logos?.[0]?.uri)
      if (url) cfg._logos[c.id] = url
    }
  } catch (err) { log(`channel list failed: ${err.message}`) }
  for (const c of cfg.channels) {
    const list = []
    for (const ymd of dates) {
      const url = `https://ottcache.dof6.com/movistarplus/webplayer/OTT/epg?from=${ymd}T00:00:00&span=1&channel=${encodeURIComponent(c.site_id)}&version=8&mdrm=true&tlsstream=true&demarcation=18`
      try {
        const data = await (await get(url, { headers: { Accept: 'application/json', Referer: 'https://www.movistarplus.es/programacion-tv' } })).json()
        for (const p of Array.isArray(data) ? data : [data]) {
          if (!p?.FechaHoraInicio || !p.Titulo) continue
          const series = p.TituloSerie && p.TituloSerie !== p.Titulo ? p.TituloSerie : ''
          const img = p.Imagenes?.find((x) => x.id === 'horizontal')?.uri || p.Imagen
          list.push(prog({
            s: Math.floor(+p.FechaHoraInicio / 1000),
            e: Math.floor(+p.FechaHoraFin / 1000),
            t: series || p.Titulo,
            sub: series ? p.Titulo : p.TituloEpisodio,
            g: p.GeneroComAntena,
            i: img,
            live: p.Directo === true,
          }))
        }
      } catch (err) { log(`${c.id} ${ymd} failed: ${err.message}`) }
      await sleep(cfg.source.delay ?? 500)
    }
    out[c.id] = list
  }
  return out
}

// ---------- source: TVmaze ----------
async function srcTvmaze(cfg, dates, log) {
  const byNetwork = new Map()
  for (const c of cfg.channels) for (const n of [c.site_id, ...(c.aliases || [])]) byNetwork.set(n.toLowerCase(), c.id)
  const out = {}
  // schedule dates are the network's local dates; fetch one extra day on each side
  for (const ymd of [addDays(dates[0], -1), ...dates, addDays(dates.at(-1), 1)]) {
    let items = []
    try { items = await (await get(`https://api.tvmaze.com/schedule?country=${cfg.source.country}&date=${ymd}`)).json() }
    catch (err) { log(`tvmaze ${ymd} failed: ${err.message}`); continue }
    for (const ep of items) {
      const id = byNetwork.get(ep.show?.network?.name?.toLowerCase())
      if (!id || !ep.airstamp) continue
      const s = Math.floor(Date.parse(ep.airstamp) / 1000)
      const runtime = ep.runtime || ep.show.runtime || ep.show.averageRuntime
      if (!runtime) continue
      const epLabel = ep.season && ep.number ? `S${ep.season} E${ep.number}` : ''
      const epName = ep.name && ep.name !== ep.show.name ? ep.name : ''
      ;(out[id] ||= []).push(prog({
        s, e: s + runtime * 60,
        t: ep.show.name,
        sub: [epLabel, epName].filter(Boolean).join(' · '),
        g: ep.show.genres?.[0] || ep.show.type,
        d: ep.summary || ep.show.summary,
        i: ep.image?.medium || ep.show.image?.medium,
      }))
    }
    await sleep(600) // TVmaze allows 20 calls / 10 s
  }
  return out
}

// ---------- source: Sky Italia guide API (one request per channel per day) ----------
function skyItTitle(ev) {
  let t = decode(ev.eventTitle), sub = ''
  const epg = decode(ev.epgEventTitle).match(/^S(\d+) Ep(\d+) - (.+)$/) // "S2 Ep98 - Tutto per la mia famiglia"
  if (epg) return { t: epg[3], sub: `S${epg[1]} E${epg[2]}` }
  // "Un posto al sole - Stag. 30 Ep. 7069 - Puntata del 12/11/2026", "Stag. 2026 - Il cavallo e la torre"
  t = t.replace(/^Stag\.\s*\d+\s*-\s*/i, '')
  const m = t.match(/^(.*?)\s+-\s+Stag\.\s*(\d+)\s+Ep\.\s*(\d+)(?:\s+-\s+(.*))?$/i)
  if (m) {
    const rest = (m[4] || '').replace(/\s*-?\s*(Puntata del\s*)?\d{2}\/\d{2}\/\d{4}$/i, '').trim()
    return { t: m[1], sub: [`S${m[2]} E${m[3]}`, rest].filter(Boolean).join(' · ') }
  }
  return { t, sub }
}

async function srcSkyIt(cfg, dates, log) {
  const out = {}
  // one channel per request: multi-channel queries silently drop some channels
  for (const c of cfg.channels) {
    const sid = c.site_id.split('#')[1]
    for (const ymd of dates) {
      // the API works in UTC; ask for the local day with an hour of slack on each side (past days answer 422)
      const from = new Date(zonedEpoch(ymd, 0, 0, cfg.tz) * 1000 - 3600e3).toISOString().slice(0, 19) + 'Z'
      const to = new Date(zonedEpoch(addDays(ymd, 1), 0, 0, cfg.tz) * 1000 + 3600e3).toISOString().slice(0, 19) + 'Z'
      try {
        const data = await (await get(`https://apid.sky.it/gtv/v1/events?from=${from}&to=${to}&pageSize=999&pageNum=0&env=DTH&channels=${sid}`, {}, ymd < dates[1] ? 1 : 3)).json()
        for (const ev of data.events || []) {
          if (ev.channel?.logo) (cfg._logos ||= {})[c.id] ||= new URL(ev.channel.logo, 'https://guidatv.sky.it').href
          const cover = ev.content?.imagesMap?.find((x) => x.key === 'cover')?.img?.url
          ;(out[c.id] ||= []).push(prog({
            s: Math.floor(Date.parse(ev.starttime) / 1000),
            e: Math.floor(Date.parse(ev.endtime) / 1000),
            ...skyItTitle(ev),
            g: ev.content?.genre?.name,
            d: decode(ev.eventSynopsis).replace(/^S\d+ Ep\d+ - /, ''),
            i: cover && `https://guidatv.sky.it${cover}`,
          }))
        }
      } catch (err) { if (ymd >= dates[1]) log(`${c.id} ${ymd} failed: ${err.message}`) }
      await sleep(cfg.source.delay ?? 500)
    }
  }
  return out
}

// ---------- source: Allente (allente.dk / .no / .se): one request per day for every channel ----------
async function srcAllente(cfg, dates, log) {
  const out = {}
  const ids = new Map(cfg.channels.map((c) => [c.site_id, c.id]))
  cfg._logos ||= {}
  // the API serves UTC days; fetch the day before too so our first local day is complete
  for (const ymd of [addDays(dates[0], -1), ...dates]) {
    try {
      const data = await (await get(`https://www.${cfg.source.site}/api/epg/refetch-epg-data?Start=${ymd}`)).json()
      for (const ch of data.channels || []) {
        const id = ids.get(String(ch.id))
        if (!id) continue
        if (ch.image) cfg._logos[id] ||= ch.image
        for (const p of ch.programs || []) {
          const ep = p.seasonNumber > 0 && p.episodeNumber > 0 ? `S${p.seasonNumber} E${p.episodeNumber}` : ''
          // episodes come as "Series: Episode title"; date/time-only episode names ("TV AVISEN: 13.11.2026") are noise
          let t = p.title || '', epName = ''
          const split = (p.seasonNumber > 0 || p.episodeNumber > 0) && t.match(/^(.+?):\s+(.+)$/)
          if (split) { t = split[1]; epName = /^[\d\s.:\-]+\.?$|^(avsnitt|afsnit|episode|episodi?|del)\s*\d+$/i.test(split[2]) ? '' : split[2] }
          ;(out[id] ||= []).push(prog({
            s: Math.floor(Date.parse(p.eventStart) / 1000),
            e: Math.floor(Date.parse(p.eventEnd) / 1000),
            t,
            sub: [ep, epName].filter(Boolean).join(' · '),
            g: p.genres?.[0],
            d: p.shortDescription,
            i: p.splashImageUri,
          }))
        }
      }
    } catch (err) { log(`${ymd} failed: ${err.message}`) }
    await sleep(cfg.source.delay ?? 1500)
  }
  return out
}

// ---------- source: MEO (Portugal): one request per channel per day ----------
async function srcMeo(cfg, dates, log) {
  const out = {}
  const headers = { Origin: 'https://www.meo.pt', Referer: 'https://www.meo.pt/', Accept: 'application/json' }
  for (const c of cfg.channels) {
    for (const ymd of dates) {
      try {
        const data = await (await get(`https://meogouser.apps.meo.pt/Services/GridTv/GridTv.svc/GetLiveChannelProgramsByDate?callLetter=${encodeURIComponent(c.site_id)}&date=${ymd}&userAgent=IPTV_OFR_GTV`, { headers })).json()
        for (const p of data.Result || []) {
          const at = (iso) => { const m = iso?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/); return m && zonedEpoch(m[1], +m[2], +m[3], cfg.tz) }
          // "Fora De Série T2 - Ep. 9"
          const ep = decode(p.Title).match(/^(.*?)\s*(?:-\s*)?(?:T(\d+)\s*-?\s*)?Ep\.\s*(\d+)$/)
          ;(out[c.id] ||= []).push(prog({
            s: at(p.StartDate),
            e: at(p.EndDate),
            t: ep ? ep[1] : p.Title,
            sub: ep ? (ep[2] ? `S${ep[2]} E${ep[3]}` : `E${ep[3]}`) : '',
            d: p.Synopsis,
          }))
        }
      } catch (err) { log(`${c.id} ${ymd} failed: ${err.message}`) }
      await sleep(cfg.source.delay ?? 500)
    }
  }
  return out
}

// ---------- source: programtv.onet.pl (Poland): one page per channel per day ----------
async function srcOnet(cfg, dates, log) {
  const out = {}
  for (const c of cfg.channels) {
    const list = []
    for (let dzien = -1; dzien <= dates.length - 1; dzien++) {
      try {
        const html = await (await get(`https://programtv.onet.pl/program-tv/${c.site_id}?dzien=${dzien}`)).text()
        let day = html.match(/class="dateSwitch">[\s\S]*?<span>(\d{4}-\d{2}-\d{2})<\/span>/)?.[1]
        const body = html.slice(html.indexOf('class="emissions"'))
        if (!day || body.length < 20) continue
        let prevMin = -1
        for (const li of body.split(/<li class="hh/).slice(1)) {
          const hm = li.match(/class="hour">(\d{1,2}):(\d{2})</)
          const title = li.match(/class="titles">\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1]
          if (!hm || !title) continue
          const mins = +hm[1] * 60 + +hm[2]
          if (mins < prevMin) day = addDays(day, 1) // listing runs past midnight
          prevMin = mins
          const odc = decode(title).match(/^(.*?)\s*,\s*(odc\.\s*.+)$/) // "Barwy szczęścia , odc. 3440"
          list.push({
            s: zonedEpoch(day, +hm[1], +hm[2], cfg.tz),
            t: odc ? odc[1] : title,
            sub: odc?.[2],
            g: li.match(/class="type">([\s\S]*?)<\/span>/)?.[1],
            d: li.match(/<p>([\s\S]*?)<\/p>/)?.[1],
          })
        }
      } catch (err) { log(`${c.id} dzien=${dzien} failed: ${err.message}`) }
      await sleep(cfg.source.delay ?? 1500)
    }
    // only start times are published: each programme ends when the next starts
    const uniq = [...new Map(list.map((p) => [p.s, p])).values()].sort((a, b) => a.s - b.s)
    out[c.id] = uniq.slice(0, -1).map((p, i) => prog({ ...p, e: uniq[i + 1].s }))
  }
  return out
}

const SOURCES = { allente: srcAllente, meo: srcMeo, onet: srcOnet, skyit: srcSkyIt, epg: srcEpg, tv24: srcTv24, movistar: srcMovistar, tvmaze: srcTvmaze }

// ---------- logos ----------
let iptvLogos
async function iptvLogo(xmltv) {
  if (!xmltv) return []
  if (!iptvLogos) {
    try { iptvLogos = await (await get('https://iptv-org.github.io/api/logos.json')).json() }
    catch { iptvLogos = [] }
  }
  const fmtRank = { PNG: 0, JPEG: 1, WebP: 2, SVG: 9 }
  return iptvLogos
    .filter((l) => l.channel === xmltv && l.in_use !== false)
    .sort((a, b) => (fmtRank[a.format] ?? 5) - (fmtRank[b.format] ?? 5) || (a.feed ? 1 : 0) - (b.feed ? 1 : 0))
    .map((l) => l.url)
}

const exists = (p) => access(p).then(() => true, () => false)

// logo background hints computed by tools/logo-tones.py (needs Pillow) and cached in logos/tones.json
let tones
/** "light" | "dark" for a logo path like "logos/gb/bbcone.png", if the cache knows this exact file */
export async function logoBg(logo) {
  if (!logo) return null
  if (!tones) tones = JSON.parse(await readFile(join(ROOT, 'logos', 'tones.json'), 'utf8').catch(() => '{}'))
  const hit = tones[logo]
  if (!hit) return null
  const buf = await readFile(join(ROOT, logo)).catch(() => null)
  return buf && createHash('sha1').update(buf).digest('hex') === hit.sha1 ? hit.bg : null
}
const LOGO_EXT = ['png', 'webp', 'jpg']

export async function logoFor(cc, ch, log, extraLogo) {
  const dir = join(ROOT, 'logos', cc)
  for (const ext of LOGO_EXT) if (await exists(join(dir, `${ch.id}.${ext}`))) return `logos/${cc}/${ch.id}.${ext}`
  await mkdir(dir, { recursive: true })
  // Wikimedia SVGs → their PNG renders (apps can't always draw SVG)
  const png = (u) => u.replace(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/[a-z]+)\/([0-9a-f]\/[0-9a-f]{2})\/([^/]+\.svg)$/i, '$1/thumb/$2/$3/500px-$3.png')
  for (const url of [ch.logo, ...(await iptvLogo(ch.xmltv)), extraLogo].filter(Boolean).map(png)) {
    try {
      await sleep(400) // Wikimedia rate-limits bursts
      const res = await get(url, {}, 3)
      const type = res.headers.get('content-type') || ''
      const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('jpeg') ? 'jpg' : null
      if (!ext) continue
      await writeFile(join(dir, `${ch.id}.${ext}`), Buffer.from(await res.arrayBuffer()))
      log(`logo saved for ${ch.id} (${url})`)
      return `logos/${cc}/${ch.id}.${ext}`
    } catch {}
  }
  log(`logo missing for ${ch.id}`)
  return null
}

// ---------- one country ----------
async function buildCountry(cc) {
  const log = logger(cc)
  const cfg = JSON.parse(await readFile(join(ROOT, 'countries', `${cc}.json`), 'utf8'))
  const today = localDate(Date.now() / 1000, cfg.tz)
  const dates = Array.from({ length: DAYS_AHEAD + KEEP_PAST_DAYS }, (_, i) => addDays(today, i - KEEP_PAST_DAYS))
  const t0 = Date.now()
  log(`source ${cfg.source.type}${cfg.source.site ? ` (${cfg.source.site})` : ''}, ${cfg.channels.length} channels, dates ${dates.join(', ')}`)

  const raw = await SOURCES[cfg.source.type](cfg, dates, log)

  // split into local-date files
  const files = Object.fromEntries(dates.map((d) => [d, {}]))
  const withData = []
  for (const c of cfg.channels) {
    const list = clean(raw[c.id] || [])
    let n = 0
    for (const p of list) {
      const day = localDate(p.s, cfg.tz)
      if (!files[day]) continue
      ;(files[day][c.id] ||= []).push(p)
      n++
    }
    if (n) withData.push(c)
  }
  const freshToday = Object.keys(files[today]).length
  // carry over from the live deployment what the source can no longer serve (e.g. yesterday)
  if (process.env.PREVIOUS_URL) {
    for (const d of dates) {
      try {
        const prev = await (await get(`${process.env.PREVIOUS_URL}/${cc}/${d}.json`, {}, 1)).json()
        const filled = []
        for (const c of cfg.channels) if (!files[d][c.id]?.length && prev.programs?.[c.id]?.length) { files[d][c.id] = prev.programs[c.id]; filled.push(c.id) }
        if (filled.length) log(`${d}: carried over ${filled.length} channels from the live site`)
      } catch {}
    }
    for (const c of cfg.channels) if (!withData.includes(c) && dates.some((d) => files[d][c.id])) withData.push(c)
    withData.sort((a, b) => cfg.channels.indexOf(a) - cfg.channels.indexOf(b))
  }
  const todayCount = freshToday
  const empty = cfg.channels.filter((c) => !withData.includes(c)).map((c) => c.id)
  log(`today: ${todayCount}/${cfg.channels.length} channels with data; no data at all: ${empty.join(', ') || 'none'} (${Math.round((Date.now() - t0) / 1000)}s)`)
  if (todayCount < Math.ceil(cfg.channels.length * (cfg.minToday ?? 0.5))) throw new Error(`only ${todayCount}/${cfg.channels.length} channels have data today`)

  // write (only after the country is known good)
  const dir = join(OUT, cc)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  for (const d of dates) await writeFile(join(dir, `${d}.json`), JSON.stringify({ date: d, programs: files[d] }))
  const channels = []
  for (const c of withData) {
    const logo = await logoFor(cc, c, log, cfg._logos?.[c.id])
    const bg = await logoBg(logo)
    channels.push({ id: c.id, name: c.name, group: c.group, ...(logo && { logo }), ...(bg && { logoBg: bg }) })
  }
  if (await exists(join(ROOT, 'logos', cc))) await cp(join(ROOT, 'logos', cc), join(OUT, 'logos', cc), { recursive: true })
  const updatedAt = Math.floor(Date.now() / 1000)
  await writeFile(join(dir, 'channels.json'), JSON.stringify({ country: cc, timezone: cfg.tz, updatedAt, channels }))
  await writeFile(join(dir, 'index.json'), JSON.stringify({ updatedAt, dates }))
  log(`ok: ${channels.length} channels written`)
  return channels.length
}

// ---------- countries.json ----------
async function countryMeta(cc) {
  if (cc === 'tr') {
    const c = JSON.parse(await readFile(join(ROOT, 'channels.tr.json'), 'utf8'))
    return { name: c.name, nameEn: c.nameEn, tz: c.timezone }
  }
  const c = JSON.parse(await readFile(join(ROOT, 'countries', `${cc}.json`), 'utf8'))
  return { name: c.name, nameEn: c.nameEn, tz: c.tz }
}

async function writeIndex(only) {
  const dirs = (await readdir(OUT, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && /^[a-z]{2}$/.test(d.name)).map((d) => d.name)
  const countries = []
  for (const cc of dirs.sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99))) {
    if (only && !only.has(cc)) continue
    try {
      const ch = JSON.parse(await readFile(join(OUT, cc, 'channels.json'), 'utf8'))
      await access(join(OUT, cc, 'index.json'))
      countries.push({ code: cc, ...(await countryMeta(cc)), channels: ch.channels.length })
    } catch (err) { console.log(`[index] skipping ${cc}: ${err.message}`) }
  }
  await writeFile(join(OUT, 'countries.json'), JSON.stringify({ updatedAt: Math.floor(Date.now() / 1000), countries }))
  console.log(`[index] countries.json: ${countries.map((c) => `${c.code}(${c.channels})`).join(' ') || 'none'}`)
  return countries.length
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--index')) return void (await writeIndex())
  const all = (await readdir(join(ROOT, 'countries'))).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  const wanted = args.length ? args : all
  await mkdir(OUT, { recursive: true })
  // countries use different sources, so they run in parallel; each source is sequential and polite
  const results = await Promise.allSettled(wanted.map((cc) => buildCountry(cc)))
  const failed = []
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push(wanted[i])
      console.log(`[${wanted[i]}] FAILED: ${r.reason?.message || r.reason}`)
    }
  })
  for (const cc of failed) await rm(join(OUT, cc), { recursive: true, force: true }) // never ship a broken country
  const n = await writeIndex()
  console.log(`[build-intl] done; failed: ${failed.join(', ') || 'none'}`)
  if (!n) { console.error('No country built — failing so the previous deploy stays live.'); process.exit(1) }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(err); process.exit(1) })
}
