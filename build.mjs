// TV guide data pipeline. Zero dependencies — Node 22+ only.
// Sources: Digiturk (backbone, 1 request/day for all channels) + TV+ (enrichment: images, descriptions, genres).
// Output: static JSON for GitHub Pages:
//   out/tr/index.json        { updatedAt, dates[] }
//   out/tr/channels.json     { channels[] }
//   out/tr/YYYY-MM-DD.json   { date, programs: { [channelId]: Program[] } }
// Program: { s, e, t, sub?, g?, d?, i?, live?, rerun? }  (s/e = unix seconds; sub = "Süper Lig · 9. Hafta", "14. Bölüm")

import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { logoBg } from './build-intl.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.OUT_DIR || join(ROOT, 'out')
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 3) // today + 2
const KEEP_PAST_DAYS = 1 // keep yesterday so "now" works right after midnight
const TZ_OFFSET_H = 3 // Europe/Istanbul is UTC+3 all year (no DST)
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[build]', ...a)

// ---------- time helpers (Istanbul local <-> epoch) ----------
const istDate = (epochMs) => new Date(epochMs + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10)
const toEpoch = (ymd, hh, mm) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d, hh - TZ_OFFSET_H, mm) / 1000)
}
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// ---------- fetch with retry ----------
async function get(url, init = {}, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (err) {
      if (i >= tries) throw err
      await sleep(1500 * i)
    }
  }
}

const decode = (s = '') =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

// ---------- Digiturk title cleanup ----------
// Raw examples:
//   "SUPER LIG (26-27) 9. HAFTA BESIKTAS - BASAKSEHIR - BANT -"  + desc "Beşiktaş - Başakşehir FK"
//   "BSL (26-27) 07.Hafta Trabzonspor - Aliağa Petkim / Bant"
//   "Gamer (26-27) 14.Bölüm" + desc "Gamer"
//   "beIN Sabah 55 DK / Canlı"
const fold = (s) =>
  s.toLocaleLowerCase('tr').replace(/[ıi̇]/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9]/g, '')
const isAllCaps = (s) => /[A-ZÇĞİÖŞÜ]/.test(s) && !/[a-zçğıöşü]/.test(s)
const LEAGUES = {
  'SUPER LIG': 'Süper Lig', 'TFF 1.LIG': 'TFF 1. Lig', 'PREMIER LEAGUE': 'Premier League', 'LIGUE 1': 'Ligue 1',
  'PORTEKIZ LIG': 'Portekiz Ligi', 'BSL': 'Basketbol Süper Ligi', 'LALIGA': 'LaLiga', 'SERIE A': 'Serie A', 'BUNDESLIGA': 'Bundesliga',
}
const titleCaseTr = (s) => s.toLocaleLowerCase('tr').replace(/(^|[\s(-])(\p{L})/gu, (_, a, b) => a + b.toLocaleUpperCase('tr'))

export function cleanDigiturk(rawTitle, rawDesc = '') {
  let t = rawTitle.trim()
  const out = {}
  // broadcast markers
  if (/[-/]\s*bant\s*-?\s*$/i.test(t)) { out.rerun = 1; t = t.replace(/\s*[-/]\s*bant\s*-?\s*$/i, '') }
  if (/[-/]\s*canl[ıi]\s*-?\s*$/i.test(t)) { out.live = 1; t = t.replace(/\s*[-/]\s*canl[ıi]\s*-?\s*$/i, '') }
  t = t.replace(/\s+\d+\s*DK\b/i, '') // "55 DK" slot lengths

  // league match: "<LEAGUE> (26-27) 9. HAFTA <home> - <away>"
  const m = t.match(/^(.+?)\s*\(\d{2}-\d{2}\)\s*0?(\d+)\.\s*hafta\s+(.+\s-\s.+)$/i)
  if (m) {
    const league = LEAGUES[m[1].toLocaleUpperCase('tr').trim()] ?? (isAllCaps(m[1]) ? titleCaseTr(m[1]) : m[1].trim())
    // all-caps team names lose Turkish letters — the description has the proper spelling
    const teams = isAllCaps(m[3]) && rawDesc.includes(' - ') ? rawDesc.trim() : isAllCaps(m[3]) ? titleCaseTr(m[3]) : m[3].trim()
    return { ...out, t: teams, sub: `${league} · ${m[2]}. Hafta`, g: 'Spor' }
  }

  // drop season tags anywhere, then move a trailing episode/week number to the subtitle:
  // "Gamer (26-27) 14.Bölüm", "BSL (26-27) Maç Özetleri 07.Hafta", "Fastzone 23. Bölüm"
  t = t.replace(/\s*\(\d{2}-\d{2}\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const ep = t.match(/^(.+?)\s+0?(\d+)\.\s*(bölüm|hafta)\s*$/i)
  if (ep) { t = ep[1].trim(); out.sub = `${ep[2]}. ${ep[3].toLocaleLowerCase('tr') === 'bölüm' ? 'Bölüm' : 'Hafta'}` }
  if (isAllCaps(t)) t = titleCaseTr(t)

  // drop descriptions that only repeat the title
  const d = rawDesc.trim()
  if (d && !(fold(t).includes(fold(d)) || fold(d).includes(fold(t)))) out.d = d
  return { ...out, t }
}

// ---------- Digiturk: one request per day, all channels ----------
async function digiturkDay(ymd) {
  const [y, m, d] = ymd.split('-')
  const url = `https://www.digiturk.com.tr/Ajax/GetTvGuideFromDigiturk?Day=${encodeURIComponent(`${m}/${d}/${y}`)}+00%3A00%3A00`
  const html = await (await get(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })).text()

  const byChannel = {} // siteId -> { logo, programs[] }
  for (const block of html.split('tvGuideResult-box-whole channel"').slice(1)) {
    const logo = block.match(/<img src="([^"]+)"/)?.[1]
    let prev = -1, dayShift = 0, siteId
    const programs = []
    for (const chunk of block.split('channelDetail"').slice(1)) {
      const hm = chunk.match(/time-hour">(\d{1,2}):(\d{2})</)
      const dur = chunk.match(/totalMinute">\s*-\s*(\d+)\s*dk/)
      const det = chunk.match(/getDetail\('[^']*',\s*(\d+)\)"\s*title="([^"]*)"/)
      if (!hm || !dur || !det) continue
      siteId = det[1]
      const mins = +hm[1] * 60 + +hm[2]
      if (mins < prev) dayShift++ // crossed midnight
      prev = mins
      const s = toEpoch(addDays(ymd, dayShift), +hm[1], +hm[2])
      const desc = decode(chunk.match(/description" title="([^"]*)"/)?.[1]).replace(/\.\.\.$/, '').trim()
      programs.push({ s, e: s + +dur[1] * 60, ...cleanDigiturk(decode(det[2]), desc) })
    }
    if (siteId) byChannel[siteId] = { logo, programs }
  }
  return byChannel
}

// ---------- beIN Sports (own site): full day incl. evening, proper Turkish names ----------
// Digiturk's guide stops around 21:00, which hides the big evening matches on beIN.
// beinsports.com.tr/yayin-akisi/{slug}/{weekday} embeds the schedule as Next.js page data.
const WEEKDAY_TAGS = ['pazar', 'pazartesi', 'sali', 'carsamba', 'persembe', 'cuma', 'cumartesi']

async function beinDay(slug, ymd) {
  const tag = WEEKDAY_TAGS[new Date(ymd + 'T12:00:00Z').getUTCDay()]
  const html = await (await get(`https://beinsports.com.tr/yayin-akisi/${slug}/${tag}`)).text()
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1]
  const data = json && JSON.parse(json)?.props?.pageProps?.data
  // the weekday URL is a rolling week — only trust it when it is the date we asked for
  if (!data?.listTvGuides?.length || data.event_date?.slice(0, 10) !== ymd) return []
  const items = data.listTvGuides
    .map((i) => {
      const [hh, mm] = i.event_time.split(':').map(Number)
      return { s: toEpoch(ymd, hh, mm), t: decode(i.name), ...(i.name.includes(' - ') && { g: 'Spor' }) }
    })
    .sort((a, b) => a.s - b.s)
  // only start times are published: each programme ends when the next one starts
  return items.map((p, i) => ({ ...p, e: items[i + 1]?.s ?? p.s + 90 * 60 }))
}

/** beIN schedule as the base; Digiturk adds rerun/live flags, league subtitle and real end times by start time. */
function overlayDigiturk(bein, dt) {
  return bein.map((p, i) => {
    const m = dt.find((d) => Math.abs(d.s - p.s) <= 10 * 60)
    if (!m) return p
    const last = i === bein.length - 1
    return { ...p, ...(m.sub && { sub: m.sub }), ...(m.g && { g: m.g }), ...(m.d && { d: m.d }), ...(m.live && { live: 1 }), ...(m.rerun && { rerun: 1 }), ...(last && { e: m.e }) }
  })
}

// ---------- TV+: auth once, then one request per channel for the whole range ----------
const TVPLUS = 'https://izmaottvsc14.tvplus.com.tr:33207/EPG/JSON'
async function tvplusSession() {
  const res = await get(`${TVPLUS}/Authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminaltype: 'webtv', osversion: 'Win32', userType: '3', utcEnable: '1', timezone: 'Europe/Istanbul' }),
  })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

const parseTvplusTime = (s) => {
  // "2026-11-12 20:00:00 UTC+03:00"
  const m = s?.match(/(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC([+-])(\d{2}):(\d{2})/)
  if (!m) return null
  const off = (m[5] === '-' ? -1 : 1) * (+m[6] * 60 + +m[7])
  const [y, mo, d] = m[1].split('-').map(Number)
  return Math.floor((Date.UTC(y, mo - 1, d, +m[2], +m[3], +m[4]) - off * 60e3) / 1000)
}

async function tvplusChannel(cookie, channelId, fromYmd, days) {
  const fmt = (ymd) => ymd.replaceAll('-', '') + '000000'
  const res = await get(`${TVPLUS}/PlayBillList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ type: '2', channelid: channelId, begintime: fmt(fromYmd), endtime: fmt(addDays(fromYmd, days)), isFillProgram: 1 }),
  })
  const data = await res.json()
  return (data.playbilllist || [])
    .filter((p) => p.type === 'PROGRAM' && p.gapFiller !== '1')
    .map((p) => {
      const s = parseTvplusTime(p.starttime), e = parseTvplusTime(p.endtime)
      const pic = p.picture || {}
      const img = pic.still || pic.poster || (typeof pic.icon === 'string' ? pic.icon.split(',')[0] : null)
      return {
        s, e,
        t: decode(p.name),
        ...(p.genres && { g: p.genres.split(',')[0].trim() }),
        ...(p.introduce && { d: decode(p.introduce) }),
        ...(img && { i: img.split(',')[0] }),
        ...(p.isLive === '1' && { live: 1 }),
        ...(p.rerun === '1' && { rerun: 1 }),
      }
    })
    .filter((p) => p.s && p.e > p.s && p.t)
}

// ---------- merge & clean ----------
function clean(list) {
  const seen = new Set()
  return list
    .filter((p) => p.e > p.s && p.e - p.s < 12 * 3600 && !seen.has(p.s) && seen.add(p.s))
    .sort((a, b) => a.s - b.s)
}

async function exists(p) { try { await access(p); return true } catch { return false } }

async function downloadLogo(ch, fallbackUrl) {
  const dir = join(ROOT, 'logos')
  await mkdir(dir, { recursive: true })
  for (const ext of ['webp', 'png']) if (await exists(join(dir, `${ch.id}.${ext}`))) return `logos/${ch.id}.${ext}`
  for (const url of [ch.logo, fallbackUrl].filter(Boolean)) {
    try {
      const buf = Buffer.from(await (await get(url, {}, 1)).arrayBuffer())
      const ext = url.toLowerCase().includes('.png') ? 'png' : 'webp'
      await writeFile(join(dir, `${ch.id}.${ext}`), buf)
      return `logos/${ch.id}.${ext}`
    } catch {}
  }
  log(`logo missing for ${ch.id}`)
  return null
}

// ---------- main ----------
async function main() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'channels.tr.json'), 'utf8'))
  const today = istDate(Date.now())
  const dates = Array.from({ length: DAYS_AHEAD + KEEP_PAST_DAYS }, (_, i) => addDays(today, i - KEEP_PAST_DAYS))
  log('dates', dates.join(', '))

  // all programs per channel, across the whole range
  const all = Object.fromEntries(cfg.channels.map((c) => [c.id, { dt: [], tp: [], bein: [] }]))
  const dtLogos = {}

  // 1) Digiturk — one gentle request per day. Digiturk blocks datacenter IPs (GitHub, Oracle…),
  //    so when a live fetch fails we use the relay file pushed from a home connection (see relay()).
  const relayDays = await readRelay()
  for (const ymd of dates) {
    let day = null
    try {
      day = await digiturkDay(ymd)
      log(`digiturk ${ymd}: ${Object.keys(day).length} channels (live)`)
    } catch (err) {
      day = relayDays?.[ymd] ?? null
      log(`digiturk ${ymd} live failed (${err.message}) → ${day ? `relay: ${Object.keys(day).length} channels` : 'no relay data'}`)
    }
    if (day) {
      for (const c of cfg.channels) {
        const hit = day[c.digiturk]
        if (hit) { all[c.id].dt.push(...hit.programs); dtLogos[c.id] ||= hit.logo }
      }
    }
    await sleep(1500)
  }

  // 2) TV+ — authenticate once, then one request per channel (sequential, polite)
  try {
    const cookie = await tvplusSession()
    let ok = 0
    for (const c of cfg.channels.filter((c) => c.tvplus)) {
      try { all[c.id].tp = await tvplusChannel(cookie, c.tvplus, dates[0], dates.length); ok++ }
      catch (err) { log(`tv+ ${c.id} failed: ${err.message}`) }
      await sleep(400)
    }
    log(`tv+: ${ok} channels`)
  } catch (err) { log(`tv+ session FAILED: ${err.message}`) }

  // 3) beIN's own site for beIN channels — one request per channel per day
  let beinOk = 0
  for (const c of cfg.channels.filter((c) => c.bein)) {
    for (const ymd of dates) {
      try { const list = await beinDay(c.bein, ymd); all[c.id].bein.push(...list); if (list.length) beinOk++ }
      catch (err) { log(`bein ${c.id} ${ymd} failed: ${err.message}`) }
      await sleep(500)
    }
  }
  log(`bein: ${beinOk} channel-days`)

  // 4) per channel per day: TV+ (richest) > beIN site + Digiturk overlay > Digiturk alone
  await mkdir(join(OUT, 'tr'), { recursive: true })
  const stats = []
  for (const ymd of dates) {
    const start = toEpoch(ymd, 0, 0), end = start + 86400
    const inDay = (p) => p.s >= start && p.s < end
    const programs = {}
    for (const c of cfg.channels) {
      const tp = clean(all[c.id].tp.filter(inDay))
      const dt = clean(all[c.id].dt.filter(inDay))
      const bein = clean(all[c.id].bein.filter(inDay))
      const [src, pick] = tp.length >= 3 ? ['tv+', tp] : bein.length >= 3 ? ['bein', overlayDigiturk(bein, dt)] : dt.length ? ['digiturk', dt] : ['NONE', []]
      if (pick.length) programs[c.id] = pick
      stats.push({ ymd, id: c.id, src, n: pick.length })
    }
    await writeFile(join(OUT, 'tr', `${ymd}.json`), JSON.stringify({ date: ymd, programs }))
  }

  // 5) channels + logos + index
  const channels = []
  for (const c of cfg.channels) {
    const logo = await downloadLogo(c, dtLogos[c.id])
    const bg = await logoBg(logo)
    channels.push({ id: c.id, name: c.name, group: c.group, ...(logo && { logo }), ...(bg && { logoBg: bg }) })
  }
  await cp(join(ROOT, 'logos'), join(OUT, 'logos'), { recursive: true }).catch(() => {})
  const updatedAt = Math.floor(Date.now() / 1000)
  await writeFile(join(OUT, 'tr', 'channels.json'), JSON.stringify({ country: 'tr', timezone: cfg.timezone, updatedAt, channels }))
  await writeFile(join(OUT, 'tr', 'index.json'), JSON.stringify({ updatedAt, dates }))
  await writeFile(join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><title>TV Guide data</title><p>TV Guide data feed.</p>')

  // 6) report
  const todayStats = stats.filter((s) => s.ymd === today)
  const missing = todayStats.filter((s) => s.src === 'NONE').map((s) => s.id)
  log(`today: ${todayStats.filter((s) => s.src === 'tv+').length} tv+, ${todayStats.filter((s) => s.src === 'bein').length} bein, ${todayStats.filter((s) => s.src === 'digiturk').length} digiturk, missing: ${missing.join(', ') || 'none'}`)
  if (todayStats.length && missing.length > todayStats.length / 2) {
    console.error('More than half the channels have no data today — failing so the previous deploy stays live.')
    process.exit(1)
  }
}

// ---------- relay: Digiturk from a home connection ----------
const RELAY_FILE = process.env.RELAY_FILE || join(ROOT, 'relay', 'digiturk.json')
const RELAY_DAYS = 7 // Digiturk publishes about a week ahead

async function readRelay() {
  try {
    const data = JSON.parse(await readFile(RELAY_FILE, 'utf8'))
    log(`relay file from ${new Date(data.fetchedAt * 1000).toISOString()} (${Object.keys(data.days).length} days)`)
    return data.days
  } catch { return null }
}

/** `node build.mjs --relay`: fetch Digiturk for the next week (our channels only) into RELAY_FILE. */
async function relay() {
  const cfg = JSON.parse(await readFile(join(ROOT, 'channels.tr.json'), 'utf8'))
  const wanted = new Set(cfg.channels.map((c) => c.digiturk).filter(Boolean))
  const today = istDate(Date.now())
  const days = {}
  for (let i = 0; i < RELAY_DAYS; i++) {
    const ymd = addDays(today, i)
    try {
      const day = await digiturkDay(ymd)
      days[ymd] = Object.fromEntries(Object.entries(day).filter(([id]) => wanted.has(id)))
      log(`relay ${ymd}: ${Object.keys(days[ymd]).length} channels`)
    } catch (err) { log(`relay ${ymd} FAILED: ${err.message}`) }
    await sleep(1500)
  }
  if (!Object.keys(days).length) throw new Error('relay fetched nothing')
  await mkdir(dirname(RELAY_FILE), { recursive: true })
  await writeFile(RELAY_FILE, JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000), days }))
  log(`relay written: ${RELAY_FILE}`)
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  ;(process.argv.includes('--relay') ? relay() : main()).catch((err) => { console.error(err); process.exit(1) })
}
