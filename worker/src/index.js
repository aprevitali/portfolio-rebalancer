// Servizio prezzi e ricerca per Portfolio Rebalancer, versione Cloudflare Worker.
// Endpoint: GET /health, GET /search, POST /quotes, POST /figi.
// Non riceve mai il portafoglio: solo ticker, testo di ricerca e ISIN. Usa direttamente gli endpoint pubblici di Yahoo Finance e OpenFIGI.

const TICKER = /^[A-Za-z0-9.^=-]{1,25}$/;
const ORIGIN_OK = /^(https:\/\/[a-z0-9-]+\.github\.io|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const UA = { 'User-Agent': 'Mozilla/5.0' };
// Il piano gratuito ammette 50 chiamate esterne per richiesta: 40 ticker + al massimo 8 cambi valuta restano sotto il limite.
const MAX_TICKERS = 40;
const MAX_FX = 8;

// Valute quotate in sottounità: [valuta principale, divisore]
const SUBUNIT = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };
const KNOWN_TYPES = { IE00B579F325: 'etc', SGLD: 'etc' };   // override per ETC/ETN noti (ISIN o ticker senza suffisso di borsa)

const knownType = (x) => KNOWN_TYPES[(x || '').toUpperCase().split('.')[0]] ?? null;
const normalize = (price, cur) => (SUBUNIT[cur] ? [price / SUBUNIT[cur][1], SUBUNIT[cur][0]] : [price, cur]);
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

function cors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const extra = (env?.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = ORIGIN_OK.test(origin) || extra.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null', 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400',
  };
}

const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

async function yahoo(url, ttl) {
  const r = await fetch(url, { headers: UA, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  return r.json();
}

/** Ultimo prezzo e valuta di un ticker, oppure null (nessun 0 silenzioso). */
async function chart(symbol) {
  try {
    const d = await yahoo(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, 60);
    const res = d?.chart?.result?.[0];
    if (!res) return null;
    const closes = (res.indicators?.quote?.[0]?.close || []).filter((x) => typeof x === 'number' && x > 0);
    const price = closes.length ? closes[closes.length - 1] : res.meta?.regularMarketPrice;
    const currency = res.meta?.currency;
    return price > 0 && currency ? { price, currency } : null;
  } catch { return null; }
}

async function quotes(tickersIn) {
  const tickers = [...new Set(tickersIn.map((t) => String(t).trim()).filter(Boolean))];
  if (tickers.some((t) => !TICKER.test(t))) return { error: 'ticker non valido' };
  const asked = tickers.slice(0, MAX_TICKERS);   // gli altri finiscono in "missing" e il browser li chiede al servizio successivo
  const raw = await Promise.all(asked.map(chart));
  const found = {};
  asked.forEach((t, i) => { if (raw[i]) { const [p, c] = normalize(raw[i].price, raw[i].currency); found[t] = { price: p, currency: c }; } });
  const cur = [...new Set(Object.values(found).map((q) => q.currency).filter((c) => c !== 'EUR'))].slice(0, MAX_FX);
  const fx = {};
  await Promise.all(cur.map(async (c) => { const q = await chart(`EUR${c}=X`); if (q) fx[c] = q.price; }));
  const ts = now();
  const out = {};
  for (const [t, q] of Object.entries(found)) {
    const eur = q.currency === 'EUR' ? q.price : fx[q.currency] > 0 ? q.price / fx[q.currency] : null;
    if (eur !== null) out[t] = { price: eur, currency: q.currency, updated_at: ts };
  }
  return { quotes: out, missing: tickers.filter((t) => !(t in out)) };
}

async function search(q) {
  q = q.trim();
  if (q.length < 2 || q.length > 60) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`;
  const d = await yahoo(url, 3600);
  return (d.quotes || []).filter((x) => ['EQUITY', 'ETF', 'MUTUALFUND'].includes(x.quoteType)).map((x) => ({
    symbol: x.symbol || '', name: x.longname || x.shortname || '', exchange: x.exchDisp || x.exchange || '',
    type: x.typeDisp || '', isin: x.isin || 'N/A', known_type: knownType(x.symbol) || knownType(x.isin),
  }));
}

function classifyFigi(rec) {
  if (!rec) return null;
  const sector = (rec.marketSector || '').toLowerCase();
  const stype = (rec.securityType2 || rec.securityType || '').toLowerCase();
  if (sector === 'govt') return 'bond_govt';
  if (sector === 'corp') return 'bond_other';
  if (sector === 'comdty') return 'etc';
  if (sector === 'equity') return /etp|etf|fund/.test(stype) ? 'etf' : 'stock';
  return null;
}

async function figi(isinIn) {
  const isin = String(isinIn).trim().toUpperCase();
  if (isin.length !== 12) return { error: 'ISIN di 12 caratteri richiesto' };
  let rec = null;
  try {
    const r = await fetch('https://api.openfigi.com/v3/mapping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ idType: 'ID_ISIN', idValue: isin }]) });
    if (r.ok) rec = (await r.json())?.[0]?.data?.[0] ?? null;
  } catch { rec = null; }
  return { type: knownType(isin) || classifyFigi(rec), name: rec?.name || '' };
}

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true }, 200, h);
      if (req.method === 'GET' && url.pathname === '/search') return json(await search(url.searchParams.get('q') || ''), 200, h);
      if (req.method === 'POST' && url.pathname === '/quotes') {
        const body = await req.json().catch(() => null);
        if (!body || !Array.isArray(body.tickers)) return json({ detail: 'richiesta non valida' }, 422, h);
        const r = await quotes(body.tickers);
        return r.error ? json({ detail: r.error }, 422, h) : json(r, 200, h);
      }
      if (req.method === 'POST' && url.pathname === '/figi') {
        const body = await req.json().catch(() => null);
        const r = await figi(body?.isin ?? '');
        return r.error ? json({ detail: r.error }, 422, h) : json(r, 200, h);
      }
      return json({ detail: 'not found' }, 404, h);
    } catch (e) {
      return json({ detail: String(e?.message || e) }, 502, h);
    }
  },
};
