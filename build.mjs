// TV guide data pipeline. Zero dependencies — Node 22+ only.
// Sources: Digiturk (backbone, 1 request/day for all channels) + TV+ (enrichment: images, descriptions, genres).
// Output: static JSON for GitHub Pages:
//   out/tr/index.json        { updatedAt, dates[] }
//   out/tr/channels.json     { channels[] }
//   out/tr/YYYY-MM-DD.json   { date, programs: { [channelId]: Program[] } }
// Program: { s, e, t, g?, d?, i?, live?, rerun? }  (s/e = unix seconds)

import { readFile, writeFile, mkdir, cp, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      programs.push({ s, e: s + +dur[1] * 60, t: decode(det[2]), ...(desc && { d: desc }) })
    }
    if (siteId) byChannel[siteId] = { logo, programs }
  }
  return byChannel
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
  const all = Object.fromEntries(cfg.channels.map((c) => [c.id, { dt: [], tp: [] }]))
  const dtLogos = {}

  // 1) Digiturk — one gentle request per day
  for (const ymd of dates) {
    try {
      const day = await digiturkDay(ymd)
      for (const c of cfg.channels) {
        const hit = day[c.digiturk]
        if (hit) { all[c.id].dt.push(...hit.programs); dtLogos[c.id] ||= hit.logo }
      }
      log(`digiturk ${ymd}: ${Object.keys(day).length} channels`)
    } catch (err) { log(`digiturk ${ymd} FAILED: ${err.message}`) }
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

  // 3) per channel per day: prefer TV+ (richer) when it has a real schedule, else Digiturk
  await mkdir(join(OUT, 'tr'), { recursive: true })
  const stats = []
  for (const ymd of dates) {
    const start = toEpoch(ymd, 0, 0), end = start + 86400
    const inDay = (p) => p.s >= start && p.s < end
    const programs = {}
    for (const c of cfg.channels) {
      const tp = clean(all[c.id].tp.filter(inDay))
      const dt = clean(all[c.id].dt.filter(inDay))
      const pick = tp.length >= 3 ? tp : dt
      if (pick.length) programs[c.id] = pick
      stats.push({ ymd, id: c.id, src: tp.length >= 3 ? 'tv+' : dt.length ? 'digiturk' : 'NONE', n: pick.length })
    }
    await writeFile(join(OUT, 'tr', `${ymd}.json`), JSON.stringify({ date: ymd, programs }))
  }

  // 4) channels + logos + index
  const channels = []
  for (const c of cfg.channels) {
    const logo = await downloadLogo(c, dtLogos[c.id])
    channels.push({ id: c.id, name: c.name, group: c.group, ...(logo && { logo }) })
  }
  await cp(join(ROOT, 'logos'), join(OUT, 'logos'), { recursive: true }).catch(() => {})
  const updatedAt = Math.floor(Date.now() / 1000)
  await writeFile(join(OUT, 'tr', 'channels.json'), JSON.stringify({ country: 'tr', timezone: cfg.timezone, updatedAt, channels }))
  await writeFile(join(OUT, 'tr', 'index.json'), JSON.stringify({ updatedAt, dates }))
  await writeFile(join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8"><title>TV Rehberi data</title><p>TV Rehberi data feed.</p>')

  // 5) report
  const todayStats = stats.filter((s) => s.ymd === today)
  const missing = todayStats.filter((s) => s.src === 'NONE').map((s) => s.id)
  log(`today: ${todayStats.filter((s) => s.src === 'tv+').length} tv+, ${todayStats.filter((s) => s.src === 'digiturk').length} digiturk, missing: ${missing.join(', ') || 'none'}`)
  if (todayStats.length && missing.length > todayStats.length / 2) {
    console.error('More than half the channels have no data today — failing so the previous deploy stays live.')
    process.exit(1)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
