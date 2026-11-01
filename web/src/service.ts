// Servizi remoti per prezzi e ricerca (Yahoo Finance + OpenFIGI): ricevono solo ticker e testo di ricerca, mai il portafoglio.
// L'utente può avere più servizi: vengono provati nell'ordine in cui sono elencati.
import type { Suggestion } from './api';

type Quote = { price: number; currency: string; updated_at: string };
type Quotes = { quotes: Record<string, Quote>; missing: string[] };

const ENV = ((import.meta.env.VITE_SERVICE_URL as string | undefined) ?? '').trim();
const LOCAL = 'http://localhost:8787';                              // Worker avviato in locale con `npx wrangler dev`
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

export const norm = (u: string) => u.trim().replace(/\/+$/, '');

/** Elenco predefinito: il servizio locale quando la pagina gira su localhost, più l'URL impostato in fase di build (VITE_SERVICE_URL) se c'è. */
export function defaultServices(): string[] {
  const list: string[] = [];
  if (isLocal) list.push(LOCAL);
  if (ENV) list.push(norm(ENV));
  return list;
}

/** Restituisce l'URL normalizzato, oppure null se non è un indirizzo http(s) valido. */
export function parseUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? norm(u.href) : null;
  } catch { return null; }
}

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${norm(base)}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Prova ogni servizio in ordine: i ticker senza prezzo passano a quello successivo. Errore solo se nessuno risponde. */
export async function quotes(bases: string[], tickers: string[]): Promise<Quotes> {
  const out: Quotes = { quotes: {}, missing: [...tickers] };
  let answered = false;
  let last: unknown = new Error('no service');
  for (const b of bases) {
    if (!out.missing.length) break;
    try {
      const r = await call<Quotes>(b, '/quotes', { tickers: out.missing });
      Object.assign(out.quotes, r.quotes);
      out.missing = out.missing.filter((t) => !(t in out.quotes));
      answered = true;
    } catch (e) { last = e; }
  }
  if (!answered) throw last;
  return out;
}

export async function search(bases: string[], q: string): Promise<Suggestion[]> {
  let answered = false;
  let last: unknown = new Error('no service');
  for (const b of bases) {
    try {
      const r = await call<Suggestion[]>(b, `/search?q=${encodeURIComponent(q)}`);
      if (r.length) return r;
      answered = true;
    } catch (e) { last = e; }
  }
  if (answered) return [];
  throw last;
}

export async function figi(bases: string[], isin: string): Promise<{ type: string | null; name: string }> {
  let found: { type: string | null; name: string } | null = null;
  let last: unknown = new Error('no service');
  for (const b of bases) {
    try {
      const r = await call<{ type: string | null; name: string }>(b, '/figi', { isin });
      if (r.type) return r;
      found = r;
    } catch (e) { last = e; }
  }
  if (found) return found;
  throw last;
}

/** Controllo di raggiungibilità per il pulsante «Prova» nelle impostazioni. */
export async function health(base: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 8000);
  try { const res = await fetch(`${norm(base)}/health`, { signal: ctl.signal }); return res.ok; }
  catch { return false; }
  finally { window.clearTimeout(timer); }
}
