// Reachability probe: which guide sources answer from this network? Prints HTTP status + size.
// Run locally and in GitHub Actions to compare residential vs datacenter access.
const d = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10)
const [y, m, dd] = d.split('-')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0 Safari/537.36'
const browser = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' }
const targets = [
  // Turkey
  ['TR digiturk guide (xhr)', `https://www.digiturk.com.tr/Ajax/GetTvGuideFromDigiturk?Day=${m}%2F${dd}%2F${y}+00%3A00%3A00`, { ...browser, 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.digiturk.com.tr/yayin-akisi' }],
  ['TR digiturk homepage', 'https://www.digiturk.com.tr/', browser],
  ['TR beinsports.com.tr', 'https://beinsports.com.tr/yayin-akisi/beinsports', browser],
  ['TR tod.tv', 'https://www.tod.tv/', browser],
  ['TR dsmart api', `https://www.dsmart.com.tr/api/v1/public/epg/schedules?page=1&limit=10&day=${d}`, browser],
  ['TR turksatkablo epg', `https://www.turksatkablo.com.tr/userUpload/EPG/${Number(dd)}.json`, browser],
  ['TR tvplus auth', 'https://izmaottvsc14.tvplus.com.tr:33207/EPG/JSON/Authenticate', browser, 'POST'],
  // Global free API
  ['TVmaze GB', `https://api.tvmaze.com/schedule?country=GB&date=${d}`, browser],
  ['TVmaze US', `https://api.tvmaze.com/schedule?country=US&date=${d}`, browser],
  ['TVmaze DE', `https://api.tvmaze.com/schedule?country=DE&date=${d}`, browser],
  ['TVmaze SE', `https://api.tvmaze.com/schedule?country=SE&date=${d}`, browser],
  ['TVmaze FR', `https://api.tvmaze.com/schedule?country=FR&date=${d}`, browser],
  // Country EPG sites (iptv-org has grabbers for these)
  ['UK freeview', 'https://www.freeview.co.uk/tv-guide', browser],
  ['UK sky epg', 'https://awk.epgsky.com/hawk/linear/services/4101/1', browser],
  ['US tvtv.us', 'https://www.tvtv.us/', browser],
  ['DE magentatv', 'https://web.magentatv.de/', browser],
  ['DE tvspielfilm', 'https://www.tvspielfilm.de/tv-programm/sendungen/', browser],
  ['SE tv.nu', 'https://web-api.tv.nu/channels/svt1/schedule?date=' + d, browser],
  ['SE tv24.se', 'https://tv24.se/', browser],
  ['NL tvgids.nl', 'https://www.tvgids.nl/gids/', browser],
  ['FR programme-tv.net', 'https://www.programme-tv.net/programme/programme-tnt.html', browser],
  ['ES movistarplus', 'https://www.movistarplus.es/programacion-tv', browser],
  ['IT guidatv.sky.it', `https://apid.sky.it/gtv/v1/events?from=${d}T00:00:00Z&to=${d}T23:59:00Z&pageSize=10&pageNum=0&env=DTH&channels=1`, browser],
]
for (const [name, url, headers, method = 'GET'] of targets) {
  try {
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(20000), ...(method === 'POST' && { body: '{}' }) })
    const body = await res.arrayBuffer()
    console.log(`${String(res.status).padEnd(4)} ${String(body.byteLength).padStart(8)}B  ${name}`)
  } catch (e) {
    console.log(`ERR  ${''.padStart(9)}  ${name} — ${e.cause?.code || e.message}`)
  }
}
