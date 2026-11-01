import './style.css';
import * as engine from './engine';
import * as service from './service';
import type { Config, Plan, Row, Suggestion } from './api';
import { t, getLang, setLang, locale, type Key, type Lang } from './i18n';

type Mode = 'contribution' | 'decumulation' | 'rebalance';
type Tab = 'portfolio' | 'plan' | 'settings';
interface Opts { mode: Mode; cash: number; net: number; strategy: string; maxDrift: number; priority: string[]; bandAbs: number; bandRel: number }
interface State {
  tab: Tab; classes: { name: string; pct: number }[]; portfolio: Row[]; opts: Opts; broker: string;
  allowFrac: boolean | null; services: string[]; carry: number; feeOverride: boolean | null; fees: { fixed: number; percent: number; min: number; max: number };
}

const KEY = 'portfolio-rebalancer:ws3';
const COLORS = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68'];
const COLUMNS = ['asset_class', 'ticker', 'name', 'quantity', 'price', 'avg_cost', 'instrument_type', 'target_weight_in_class', 'currency', 'manual', 'price_updated_at'] as const;

let cfg: Config = {
  profiles: [{ name: 'Custom', verified_on: null, fractional_shares_default: true, fees_configured: false, fees: { fixed: null, percent: null, min: null, max: null } }],
  instrument_types: ['etf', 'etc', 'stock', 'bond_other', 'bond_govt'], strategies: ['pro_rata', 'towards_target', 'min_tax', 'priority_order'],
  tax_rates: { etf: 0.26, etc: 0.26, stock: 0.26, bond_other: 0.26, bond_govt: 0.125 },
};
let serverOk = true;
let engineState: 'loading' | 'ready' | 'error' = 'loading';
let engineError = '';

const defaultClasses = () => [{ name: t('def.stocks'), pct: 80 }, { name: t('def.bonds'), pct: 10 }, { name: t('def.alternatives'), pct: 10 }];
const defaults = (): State => ({
  tab: 'portfolio', classes: defaultClasses(), portfolio: [],
  opts: { mode: 'contribution', cash: 1000, net: 1000, strategy: 'pro_rata', maxDrift: 5, priority: [], bandAbs: 5, bandRel: 25 },
  broker: 'Custom', allowFrac: null, services: service.defaultServices(), carry: 0, feeOverride: null, fees: { fixed: 0, percent: 0, min: 0, max: 0 },
});
function load(): State {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<State> & { serviceUrl?: string };
      const merged = { ...d, ...s, opts: { ...d.opts, ...s.opts }, fees: { ...d.fees, ...s.fees } } as State & { serviceUrl?: string };
      if (!Array.isArray(s.services)) {   // salvataggi precedenti: un solo URL facoltativo
        const old = service.parseUrl(s.serviceUrl ?? '');
        merged.services = old ? [old, ...d.services.filter((u) => u !== old)] : d.services;
      }
      delete merged.serviceUrl;
      return merged;
    }
  } catch { /* storage non disponibile o corrotto */ }
  return d;
}
let state = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignora */ } };

// stato effimero dell'interfaccia
interface Form { mode: 'search' | 'manual'; q: string; cat: string; qty: number; cost: number; ident: string; name: string; type: string; pmode: 'unit' | 'percent'; mqty: number; mprice: number; mcost: number; nominal: number; lot: number; pricePct: number; costPct: number; date: string }
const today = () => new Date().toISOString().slice(0, 10);
const form: Form = { mode: 'search', q: '', cat: '', qty: 1, cost: 0, ident: '', name: '', type: 'etf', pmode: 'unit', mqty: 1, mprice: 0, mcost: 0, nominal: 1000, lot: 1000, pricePct: 100, costPct: 0, date: today() };
let chosen: Suggestion | null = null;
let sg: Suggestion[] = [];
let sgMsg = '';
let sgTimer = 0;
let figiMsg: { ok: boolean; text: string } | null = null;
let addMsg = '';
let importMsg: { ok: boolean; text: string } | null = null;
let priceMissing: string[] = [];
let srvStatus: Record<string, 'wait' | 'ok' | 'bad'> = {};
let srvMsg = '';
let updating = false;
let planResult: Plan | null = null;
let planError = '';
let planSeq = 0;
let planTimer = 0;
let addOpen = false;
let feesOpen: boolean | null = null;
let openSet = new Set<number>();

// ---------- utilità ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const eur = (n: number) => n.toLocaleString(locale(), { style: 'currency', currency: 'EUR' });
const eur0 = (n: number) => n.toLocaleString(locale(), { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const num = (n: number, d = 2) => n.toLocaleString(locale(), { maximumFractionDigits: d });
const pct = (n: number) => `${num(n, 1)}%`;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const value = (r: Row) => r.quantity * r.price;
const total = () => sum(state.portfolio.map(value));
const app = document.getElementById('app') as HTMLElement;
const $ = (sel: string) => app.querySelector(sel) as HTMLElement | null;
const nval = (el: HTMLInputElement | HTMLSelectElement) => { const v = (el as HTMLInputElement).valueAsNumber; return Number.isFinite(v) ? v : 0; };
const nullable = (el: HTMLInputElement | HTMLSelectElement) => { const v = (el as HTMLInputElement).valueAsNumber; return Number.isFinite(v) ? v : null; };
const profile = () => cfg.profiles.find((p) => p.name === state.broker) ?? cfg.profiles[0];
const services = () => state.services.filter(Boolean);
const hasService = () => services().length > 0;
const fractional = () => state.allowFrac ?? profile().fractional_shares_default;
const feeOverrideOn = () => state.feeOverride ?? !profile().fees_configured;
const classList = () => [...new Set([...state.classes.map((c) => c.name), ...state.portfolio.map((r) => r.asset_class)])];
const colorOf = (name: string) => COLORS[Math.max(0, classList().indexOf(name)) % COLORS.length];
const targetsDict = () => Object.fromEntries(state.classes.filter((c) => c.name.trim()).map((c) => [c.name, c.pct]));
function priorityList(): string[] {
  const cls = state.classes.map((c) => c.name);
  const cur = state.opts.priority.filter((x) => cls.includes(x));
  return [...cur, ...cls.filter((x) => !cur.includes(x))];
}
function isStale(ts: string | null): boolean {
  if (!ts) return false;
  const d = new Date(ts.length > 10 ? `${ts.replace(' ', 'T')}Z` : ts);
  return Number.isFinite(d.getTime()) && Date.now() - d.getTime() > 7 * 864e5;
}
function classStats() {
  const tot = total();
  return classList().map((name) => {
    const v = sum(state.portfolio.filter((r) => r.asset_class === name).map(value));
    return { name, now: tot > 0 ? (v / tot) * 100 : 0, tgt: state.classes.find((c) => c.name === name)?.pct ?? 0, color: colorOf(name) };
  });
}
function targetsValid() {
  const names = state.classes.map((c) => c.name.trim());
  return Math.abs(sum(state.classes.map((c) => c.pct)) - 100) < 0.05 && names.every(Boolean) && new Set(names).size === names.length;
}
function ring(parts: { p: number; color: string }[], r: number, w: number, cls = ''): string {
  const C = 2 * Math.PI * r;
  let off = 0;
  const segs = parts.filter((x) => x.p > 0.001).map((x) => {
    const len = (Math.min(100, x.p) * C) / 100;
    const el = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${x.color}" stroke-width="${w}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)"/>`;
    off += len;
    return el;
  }).join('');
  return `<g class="${cls}"><circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--fill)" stroke-width="${w}"/>${segs}</g>`;
}
const field = (label: string, input: string, wide = false) => `<label class="field${wide ? ' wide' : ''}">${label}${input}</label>`;
const numIn = (attrs: string, v: number | string) => `<input type="number" step="any" inputmode="decimal" ${attrs} value="${v}" />`;
const typeOptions = (sel: string) => cfg.instrument_types.map((x) => `<option value="${x}"${x === sel ? ' selected' : ''}>${t(`type.${x}` as Key)}</option>`).join('');

// ---------- scheda Portafoglio ----------
function holdingCard(r: Row, i: number): string {
  const tot = total(), v = value(r), w = tot > 0 ? (v / tot) * 100 : 0;
  const gain = r.avg_cost != null && r.price > 0 ? ((r.price - r.avg_cost) / r.price) * 100 : null;
  const classes = classList().map((c) => `<option value="${esc(c)}"${c === r.asset_class ? ' selected' : ''}>${esc(c)}</option>`).join('');
  return `
  <article class="card">
    <div class="h-main">
      <div class="h-id"><b><i class="dot" style="background:${colorOf(r.asset_class)}"></i>${esc(r.ticker)}</b><span>${esc(r.name)}</span></div>
      <div class="h-val"><b class="num">${eur(v)}</b><span class="num">${pct(w)}${gain != null ? ` · ${gain >= 0 ? '+' : ''}${num(gain, 1)}%` : ''}</span></div>
    </div>
    <div class="meter" aria-hidden="true"><i style="width:${Math.min(100, w)}%"></i></div>
    <p class="small muted">${esc(r.asset_class)} · ${isStale(r.price_updated_at) ? `<span title="${esc(t('holdings.stale'))}">⚠️</span> ` : ''}${esc(r.price_updated_at || '–')}</p>
    <details class="edit" data-edit="${i}"${openSet.has(i) ? ' open' : ''}>
      <summary>${t('holdings.edit')}</summary>
      <div class="fields">
        ${field(t('f.assetClass'), `<select data-row="${i}" data-f="asset_class">${classes}</select>`)}
        ${field(t('f.type'), `<select data-row="${i}" data-f="instrument_type">${typeOptions(r.instrument_type)}</select>`)}
        ${field(t('f.ticker'), `<input data-row="${i}" data-f="ticker" value="${esc(r.ticker)}" autocapitalize="characters" autocomplete="off" />`)}
        ${field(t('f.name'), `<input data-row="${i}" data-f="name" value="${esc(r.name)}" />`)}
        ${field(t('f.qty'), numIn(`data-row="${i}" data-f="quantity" min="0"`, r.quantity))}
        ${field(t('f.price'), numIn(`data-row="${i}" data-f="price" min="0"`, r.price))}
        ${field(t('f.avgCost'), numIn(`data-row="${i}" data-f="avg_cost" min="0"`, r.avg_cost ?? ''))}
        ${field(t('f.weight'), numIn(`data-row="${i}" data-f="target_weight_in_class" min="0" max="100" placeholder="${esc(t('f.weightPh'))}"`, r.target_weight_in_class ?? ''))}
        <button class="del" data-act="delrow" data-i="${i}">${t('holdings.remove')}</button>
      </div>
    </details>
  </article>`;
}

function sgHtml(): string {
  if (sgMsg) return `<p class="note">${esc(sgMsg)}</p>`;
  return sg.map((s, k) => `<button class="sg-item" data-act="pick" data-k="${k}"><b>${esc(s.symbol)}</b><span>${esc(s.name)}</span><small>${esc(s.exchange)} · ${esc(s.type)}${s.isin && s.isin !== 'N/A' ? ` · ${esc(s.isin)}` : ''}</small></button>`).join('');
}

function addPanel(): string {
  const classes = classList();
  if (!classes.includes(form.cat)) form.cat = classes[0] ?? '';
  const cat = field(t('f.assetClass'), `<select data-fm="cat">${classes.map((c) => `<option value="${esc(c)}"${c === form.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`, true);
  const search = `
    ${hasService() ? '' : `<p class="note">${t('srv.none')}</p>`}
    ${field(t('add.searchLabel'), `<input data-fm="q" value="${esc(form.q)}" autocomplete="off" spellcheck="false" />`, true)}
    <div class="sglist" id="sg">${sgHtml()}</div>
    ${chosen ? `<p class="small">✓ ${t('add.selected')}: <b>${esc(chosen.symbol)}</b> — ${esc(chosen.name)}</p>` : ''}
    <div class="fields">
      ${field(t('add.qty'), numIn('data-fm="qty" min="0"', form.qty))}
      ${field(t('add.cost'), numIn('data-fm="cost" min="0"', form.cost))}
    </div>
    <button class="primary" id="addbtn" data-act="addsearch"${chosen ? '' : ' disabled'}>${t('add.button')}</button>`;
  const unit = form.pmode === 'unit';
  const manual = `
    <div class="fields">
      ${field(t('man.ident'), `<input data-fm="ident" value="${esc(form.ident)}" autocomplete="off" autocapitalize="characters" />`)}
      ${field(t('f.name'), `<input data-fm="name" value="${esc(form.name)}" />`)}
      ${field(t('f.type'), `<select data-fm="type">${typeOptions(form.type)}</select>`)}
      <div class="field"><span>&nbsp;</span><button data-act="figi">${t('man.figi')}</button></div>
    </div>
    ${figiMsg ? `<p class="${figiMsg.ok ? 'small' : 'note'}">${esc(figiMsg.text)}</p>` : ''}
    <div class="seg two" role="group">
      <button data-act="pmode" data-v="unit" aria-pressed="${unit}">${t('man.unit')}</button>
      <button data-act="pmode" data-v="percent" aria-pressed="${!unit}">${t('man.percent')}</button>
    </div>
    <div class="fields">
      ${unit
        ? `${field(t('add.qty'), numIn('data-fm="mqty" min="0"', form.mqty))}${field(t('f.price'), numIn('data-fm="mprice" min="0"', form.mprice))}${field(t('f.avgCost'), numIn('data-fm="mcost" min="0"', form.mcost))}`
        : `${field(t('man.nominal'), numIn('data-fm="nominal" min="0"', form.nominal))}${field(t('man.lot'), numIn('data-fm="lot" min="1"', form.lot))}${field(t('man.pricePct'), numIn('data-fm="pricePct" min="0"', form.pricePct))}${field(t('man.costPct'), numIn('data-fm="costPct" min="0"', form.costPct))}`}
      ${field(t('man.date'), `<input type="date" data-fm="date" value="${esc(form.date)}" />`)}
    </div>
    ${!unit && form.ident.trim().length === 12 ? `<p class="small"><a href="https://www.borsaitaliana.it/borsa/obbligazioni/mot/euro-obbligazioni/scheda/${esc(form.ident.trim().toUpperCase())}-MOTX.html" target="_blank" rel="noopener">🔗 ${t('man.link')}</a></p>` : ''}
    <button class="primary" data-act="addmanual">${t('man.add')}</button>`;
  return `
  <details class="panel addp" data-addp${addOpen || state.portfolio.length === 0 ? ' open' : ''}>
    <summary>${t('add.title')}</summary>
    <div class="seg two" role="group">
      <button data-act="addmode" data-v="search" aria-pressed="${form.mode === 'search'}">${t('add.search')}</button>
      <button data-act="addmode" data-v="manual" aria-pressed="${form.mode === 'manual'}">${t('add.manual')}</button>
    </div>
    ${cat}
    ${form.mode === 'search' ? search : manual}
    ${addMsg ? `<p class="note">${esc(addMsg)}</p>` : ''}
  </details>`;
}

function portfolioTab(): string {
  const stats = classStats();
  const tot = total();
  const maxImb = stats.length ? Math.max(...stats.map((x) => Math.abs(x.now - x.tgt))) : 0;
  const valid = targetsValid();
  const tsum = sum(state.classes.map((c) => c.pct));
  const unknown = [...new Set(state.portfolio.map((r) => r.asset_class))].filter((c) => !state.classes.some((k) => k.name === c));
  const rows = state.classes.map((c, i) => {
    const s = stats.find((x) => x.name === c.name);
    const d = (s?.now ?? 0) - c.pct;
    return `<div class="arow">
      <i class="dot" style="background:${colorOf(c.name)}"></i>
      <input class="nm" data-cn="${i}" value="${esc(c.name)}" aria-label="${t('f.assetClass')}" />
      <span class="r num muted">${pct(s?.now ?? 0)}</span>
      ${numIn(`data-cp="${i}" min="0" max="100"`, c.pct)}
      <span class="r num drift${Math.abs(d) >= 2 ? ' off' : ''}">${d > 0 ? '+' : d < 0 ? '−' : ''}${num(Math.abs(d), 1)}</span>
      <button class="x" data-act="delclass" data-i="${i}" aria-label="${t('targets.remove')}">✕</button>
    </div>`;
  }).join('');
  return `
  <section class="hero">
    <div class="donut">
      <svg viewBox="0 0 120 120" role="img" aria-label="${t('hero.total')}">${ring(stats.map((x) => ({ p: x.now, color: x.color })), 50, 12)}${ring(stats.map((x) => ({ p: x.tgt, color: x.color })), 34, 8, 'ring-in')}</svg>
      <div class="donut-c"><b class="num">${eur0(tot)}</b><span>${t('hero.total')}</span></div>
    </div>
    <div class="chips">${stats.filter((x) => x.now > 0 || x.tgt > 0).map((x) => `<span class="chip"><i class="dot" style="background:${x.color}"></i>${esc(x.name)} <b class="num">${pct(x.now)}</b></span>`).join('')}</div>
    <p class="legend-note">${t('hero.legend')}</p>
    <div class="stats two"><div class="stat"><b class="num">${state.portfolio.length}</b><span>${t('hero.items')}</span></div><div class="stat"><b class="num">${num(maxImb, 1)}%</b><span>${t('hero.imbalance')}</span></div></div>
  </section>

  <section class="panel">
    <div class="section-head"><h2>${t('targets.title')}</h2><button class="link" data-act="addclass">${t('targets.add')}</button></div>
    <div class="arow head"><span></span><span></span><span class="r">${t('targets.now')}</span><span class="r">${t('targets.target')}</span><span class="r">${t('targets.diff')}</span><span></span></div>
    ${rows}
    <div class="row-between"><span><b class="num">${t('targets.total')}: ${num(tsum, 1)}%</b> <span class="${valid ? 'ok' : 'bad'}">${valid ? '✓ ' + t('targets.valid') : t('targets.invalid')}</span></span>
      <button data-act="normalize"${tsum > 0 ? '' : ' disabled'}>${t('targets.normalize')}</button></div>
  </section>

  <section>
    <div class="section-head"><h2>${t('holdings.title')}</h2><button class="link" id="upd" data-act="refresh"${updating ? ' disabled' : ''}>${updating ? t('holdings.updating') : t('holdings.update')}</button></div>
    ${hasService() ? '' : `<p class="note">${t('srv.none')}</p>`}
    ${priceMissing.length ? `<p class="note">${esc(t('holdings.missing', { list: priceMissing.join(', ') }))}</p>` : ''}
    ${unknown.length ? `<p class="note">${esc(t('holdings.unknown', { list: unknown.join(', ') }))}</p>` : ''}
    ${state.portfolio.length
      ? state.portfolio.map(holdingCard).join('')
      : `<div class="card empty-card"><span>${t('holdings.empty')}</span><button class="ghost" data-act="example">${t('holdings.example')}</button></div>`}
  </section>
  ${addPanel()}`;
}

// ---------- scheda Piano ----------
function planTab(): string {
  const o = state.opts, p = profile();
  const modes: Mode[] = ['contribution', 'decumulation', 'rebalance'];
  const brokers = cfg.profiles.map((x) => `<option value="${esc(x.name)}"${x.name === p.name ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const ovr = feeOverrideOn();
  const f = state.fees;
  const feeBox = `
    <details class="adv" data-fees${(feesOpen ?? !p.fees_configured) ? ' open' : ''}>
      <summary>${t('plan.fees')}${p.fees_configured ? '' : ' ⚠️'}</summary>
      ${p.fees_configured ? '' : `<p class="note">${t('plan.feesWarn')}</p>`}
      <label class="switch"><span>${t('plan.feesOverride')}</span><input type="checkbox" data-sel="feeOverride"${ovr ? ' checked' : ''} /></label>
      ${ovr ? `<div class="fields">${(['fixed', 'percent', 'min', 'max'] as const).map((k) => field(t(`fee.${k}` as Key), numIn(`data-fee="${k}" min="0"`, f[k]))).join('')}</div>` : ''}
    </details>`;
  let specific = '';
  if (o.mode === 'contribution') {
    specific = `<div class="amount-wrap"><p class="eyebrow">${t('plan.cash')}</p><label class="amount"><span>€</span>${numIn('data-o="cash" min="0"', o.cash)}</label></div>`;
  } else if (o.mode === 'decumulation') {
    specific = `<div class="amount-wrap"><p class="eyebrow">${t('plan.net')}</p><label class="amount"><span>€</span>${numIn('data-o="net" min="0"', o.net)}</label></div>
      <div class="fields">${field(t('plan.strategy'), `<select data-sel="strategy">${cfg.strategies.map((s) => `<option value="${s}"${s === o.strategy ? ' selected' : ''}>${t(`strat.${s}` as Key)}</option>`).join('')}</select>`, o.strategy !== 'min_tax')}
      ${o.strategy === 'min_tax' ? field(t('plan.maxDrift'), numIn('data-o="maxDrift" min="0.5" max="20"', o.maxDrift)) : ''}</div>
      ${o.strategy === 'priority_order' ? `<p class="small muted">${t('plan.priority')}</p><div class="prio">${priorityList().map((n, i) => `<div class="prow"><span>${i + 1}. ${esc(n)}</span><span><button class="x" data-act="pup" data-i="${i}">↑</button><button class="x" data-act="pdown" data-i="${i}">↓</button></span></div>`).join('')}</div>` : ''}`;
  } else {
    specific = `<div class="fields">${field(t('plan.bandAbs'), numIn('data-o="bandAbs" min="0"', o.bandAbs))}${field(t('plan.bandRel'), numIn('data-o="bandRel" min="0"', o.bandRel))}</div>`;
  }
  return `
  <section class="panel">
    <div class="seg" role="group" aria-label="${t('plan.goal')}">${modes.map((m) => `<button data-act="mode" data-mode="${m}" aria-pressed="${o.mode === m}">${t(`mode.${m}` as Key)}</button>`).join('')}</div>
    <div class="fields top-gap">
      ${field(t('plan.broker'), `<select data-sel="broker">${brokers}</select>`)}
      ${field(t('plan.carry'), numIn('data-s="carry" min="0"', state.carry))}
    </div>
    <div class="row-between"><label class="switch"><span>${t('plan.fractional')}</span><input type="checkbox" data-sel="allowFrac"${fractional() ? ' checked' : ''} /></label></div>
    ${p.verified_on === null && p.name !== 'Custom' ? `<p class="small muted">ℹ️ ${t('plan.unverified')}</p>` : ''}
    ${feeBox}
    ${specific}
  </section>
  <div id="result">${resultHtml()}</div>`;
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function resultHtml(): string {
  const holdings = state.portfolio.filter((r) => r.ticker.trim() && r.asset_class);
  if (!holdings.length) return `<p class="muted center">${t('plan.noHoldings')}</p>`;
  if (planError) return `<p class="note">${esc(t('plan.error', { error: planError }))}</p>`;
  const p = planResult;
  if (engineState === 'error') return `<p class="note">${esc(t('engine.error', { error: engineError }))}</p>`;
  if (!p || p.mode !== state.opts.mode) return `<p class="muted center">${t(engineState === 'loading' ? 'engine.loading' : 'plan.calculating')}</p>`;
  const tot = total();
  const stat = (v: string, l: string, sub = '') => `<div class="stat"><b class="num">${v}</b><span>${l}</span>${sub ? `<small class="num">${sub}</small>` : ''}</div>`;
  const gross = sum(p.trades.map((x) => x.gross));
  let stats = '';
  if (p.mode === 'contribution') stats = stat(eur(gross), t('m.invested')) + stat(eur(p.total_fees), t('m.fees')) + stat(eur(p.leftover_cash), t('m.cash')) + stat(eur(0), t('m.tax'));
  else if (p.mode === 'decumulation') stats = stat(eur(p.net_obtained), t('m.netObtained'), `${p.net_obtained - p.net_target >= 0 ? '+' : ''}${num(p.net_obtained - p.net_target)}`) + stat(eur(gross), t('m.gross')) + stat(eur(p.total_tax), t('m.tax')) + stat(eur(p.total_fees), t('m.fees'));
  else if (p.triggered) stats = stat(eur(p.total_tax), t('m.tax')) + stat(eur(p.total_fees), t('m.fees')) + stat(eur(p.total_cost), t('m.totalCost'), tot > 0 ? `${num((p.total_cost / tot) * 100)}% ${t('m.ofPortfolio')}` : '') + stat(eur(p.leftover_cash), t('m.cash'));
  const warns = p.warnings.map((w) => `<p class="note">${esc(t(`warn.${w.code}` as Key, { arg: w.arg }))}</p>`).join('');
  const carry = p.mode !== 'contribution' && (state.carry || p.carryforward_after) ? `<p class="small muted">${esc(t('carry.after', { before: eur(p.carryforward_before), after: eur(p.carryforward_after) }))}</p>` : '';
  const trades = p.trades.map((x, k) => `
    <div class="trade" style="animation-delay:${k * 40}ms">
      <span class="pill ${x.action}">${t(x.action === 'buy' ? 'action.buy' : 'action.sell')}</span>
      <div><b>${num(x.quantity, 4)} × ${esc(x.ticker)}</b><small>${esc(x.name)} · ${esc(x.asset_class)}</small>
        <small class="num">${t('o.fee')} ${eur(x.fee)}${x.action === 'sell' ? ` · ${t('o.tax')} ${x.tax_known ? eur(x.tax) : '–'}` : ''} · ${t('o.net')} ${x.net_cash >= 0 ? '+' : ''}${eur(x.net_cash)}</small></div>
      <b class="num">${eur(x.gross)}</b>
    </div>`).join('');
  const cls = Object.keys(p.targets);
  const cmp = cls.map((c) => {
    const b = p.allocation_before[c] ?? 0, a = p.allocation_after[c] ?? 0, tg = p.targets[c] ?? 0, d = a - tg;
    return `<div class="cmp"><span class="cn"><i class="dot" style="background:${colorOf(c)}"></i>${esc(c)}</span>
      <div class="bars"><div class="meter b"><i style="width:${Math.min(100, b)}%"></i><u style="left:${Math.min(100, tg)}%"></u></div><div class="meter"><i style="width:${Math.min(100, a)}%"></i><u style="left:${Math.min(100, tg)}%"></u></div></div>
      <span class="r num small">${pct(a)} <span class="muted">/ ${pct(tg)}</span> ${Math.abs(d) < 1 ? '✅' : d > 0 ? '🔼' : '🔽'}</span></div>`;
  }).join('');
  return `
  <section class="panel">
    <h2>${t(`result.${p.mode}` as Key)}</h2>
    ${warns}
    ${p.mode === 'rebalance' && !p.triggered ? `<p class="ok">✓ ${t('within')}</p>` : `<div class="stats">${stats}</div>${carry}`}
    ${p.trades.length ? `<h3>${t('orders')}</h3>${trades}<button class="ghost wide-btn" data-act="dlorders">${t('o.download')}</button>` : (p.triggered ? `<p class="muted">${t('noTrades')}</p>` : '')}
    <h3>${t('alloc.title')}</h3>
    <p class="legend-note left">${t('before')} ▬ · ${t('after')} ▬ · ${t('target')} |</p>
    ${cmp}
    <p class="small muted">${t('disclaimer')}</p>
  </section>`;
}
function paintResult() { const el = document.getElementById('result'); if (el) el.innerHTML = resultHtml(); }

async function runPlan() {
  const my = ++planSeq;
  const holdings = state.portfolio.filter((r) => r.ticker.trim() && r.asset_class);
  if (!holdings.length) { planResult = null; planError = ''; paintResult(); return; }
  const o = state.opts, f = state.fees;
  try {
    const p = await engine.plan({
      mode: o.mode, holdings, targets: targetsDict(), broker: profile().name,
      fees: feeOverrideOn() ? { fixed: f.fixed, percent: f.percent, min: f.min, max: f.max } : null,
      allow_fractional: fractional(), carryforward: state.carry, cash: o.cash, net: o.net, strategy: o.strategy,
      max_drift: o.maxDrift, priority_order: priorityList(), band_abs: o.bandAbs, band_rel: o.bandRel,
    });
    if (my !== planSeq) return;
    planResult = p; planError = ''; serverOk = true;
  } catch (e) {
    if (my !== planSeq) return;
    planError = (e as Error).message;
  }
  paintResult();
}
function scheduleCalc(delay = 300) { window.clearTimeout(planTimer); planTimer = window.setTimeout(() => void runPlan(), delay); }

// ---------- scheda Impostazioni ----------
function srvRow(u: string, i: number): string {
  const st = srvStatus[u];
  const label = st === 'wait' ? '…' : st === 'ok' ? t('srv.ok') : st === 'bad' ? t('srv.bad') : '';
  return `<div class="srv"><span class="srv-url" title="${esc(u)}">${esc(u)}</span><span class="${st === 'ok' ? 'ok' : st === 'bad' ? 'bad' : 'muted'} srv-st">${label}</span>
    <button class="srv-btn" data-act="testsrv" data-i="${i}">${t('srv.test')}</button><button class="x" data-act="delsrv" data-i="${i}" aria-label="${esc(t('srv.remove'))}">✕</button></div>`;
}
function settingsTab(): string {
  const lang = getLang();
  return `
  <section class="panel">
    <h2>${t('set.language')}</h2>
    <div class="seg two"><button data-act="lang" data-lang="en" aria-pressed="${lang === 'en'}">English</button><button data-act="lang" data-lang="it" aria-pressed="${lang === 'it'}">Italiano</button></div>
  </section>
  <section class="panel">
    <h2>${t('set.services')}</h2>
    <p class="small muted">${t('set.serviceHelp')}</p>
    <div class="srv-list">${state.services.map((u, i) => srvRow(u, i)).join('') || `<p class="note">${t('srv.none')}</p>`}</div>
    ${srvMsg ? `<p class="note">${esc(srvMsg)}</p>` : ''}
    <div class="srv-add"><input id="srvnew" type="url" inputmode="url" autocomplete="off" placeholder="${esc(t('srv.placeholder'))}" /><button data-act="addsrv">${t('srv.add')}</button></div>
    <button class="link" data-act="resetsrv">${t('srv.reset')}</button>
    <p class="small muted">${t('srv.order')}</p>
  </section>
  <section class="panel">
    <h2>${t('set.data')}</h2>
    ${importMsg ? `<p class="${importMsg.ok ? 'ok' : 'note'}">${esc(importMsg.text)}</p>` : ''}
    <div class="stack">
      <button data-act="import">${t('set.import')}</button>
      <button data-act="exportjson">${t('set.save')}</button>
      <button data-act="exportcsv">${t('set.exportCsv')}</button>
      <button data-act="template">${t('set.template')}</button>
    </div>
    <div class="stack danger">
      <button data-act="clearpf">${t('set.clearPf')}</button>
      <button data-act="resettargets">${t('set.resetTargets')}</button>
      <button data-act="resetall">${t('set.resetAll')}</button>
    </div>
    <p class="small muted">${t('set.about')}</p>
  </section>`;
}

// ---------- shell ----------
function render() {
  document.documentElement.lang = getLang();
  const tabs: Tab[] = ['portfolio', 'plan', 'settings'];
  const body = state.tab === 'portfolio' ? portfolioTab() : state.tab === 'plan' ? planTab() : settingsTab();
  app.innerHTML = `
  <main>
    <header class="top"><h1>Rebalancer</h1><button class="ghost" data-act="lang" data-lang="${getLang() === 'en' ? 'it' : 'en'}">${getLang() === 'en' ? 'IT' : 'EN'}</button></header>
    ${serverOk ? '' : `<p class="banner">${t('srv.down')}</p>`}
    <nav class="tabs" role="tablist">${tabs.map((k) => `<button data-act="tab" data-tab="${k}" aria-pressed="${state.tab === k}">${t(`tab.${k}` as Key)}</button>`).join('')}</nav>
    ${body}
    <p class="foot">${t('foot')}</p>
    <input id="file" type="file" accept=".csv,.json,text/csv,application/json" hidden />
  </main>`;
  if (state.tab === 'plan') scheduleCalc(0);
}

// ---------- azioni ----------
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  URL.revokeObjectURL(url);
}
const csvOf = (rows: Row[]) => [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
const exampleRows = (): Row[] => {
  const [s, b, a] = defaultClasses().map((c) => c.name);
  const mk = (asset_class: string, ticker: string, name: string, quantity: number, price: number, avg_cost: number, instrument_type: string): Row =>
    ({ asset_class, ticker, name, quantity, price, avg_cost, instrument_type, target_weight_in_class: null, currency: 'EUR', manual: false, price_updated_at: today() });
  return [mk(s, 'VWCE.MI', 'FTSE All-World', 40, 120, 100, 'etf'), mk(b, 'AGGH.MI', 'Global Aggregate Bond', 60, 50, 52, 'etf'), mk(a, 'SGLD.MI', 'Physical Gold', 10, 60, 45, 'etc')];
};

function addRow(r: Row) { state.portfolio.push(r); save(); render(); }

async function updatePrices() {
  const tickers = [...new Set(state.portfolio.filter((r) => !r.manual && r.ticker.trim()).map((r) => r.ticker.trim()))];
  if (!tickers.length || !hasService()) return;
  updating = true; render();
  try {
    const res = await service.quotes(services(), tickers);
    state.portfolio.forEach((r) => { const q = res.quotes[r.ticker.trim()]; if (q) { r.price = q.price; r.currency = q.currency; r.price_updated_at = q.updated_at; } });
    priceMissing = res.missing; serverOk = true;
  } catch { priceMissing = []; serverOk = false; }
  updating = false; save(); render();
}

async function addFromSearch() {
  if (!chosen) return;
  const c = chosen;
  try {
    const res = await service.quotes(services(), [c.symbol]);
    const q = res.quotes[c.symbol];
    if (!q) { addMsg = t('add.priceError'); render(); return; }
    chosen = null; form.q = ''; sg = []; addMsg = '';
    addRow({ asset_class: form.cat, ticker: c.symbol, name: c.name || c.symbol, quantity: form.qty, price: q.price, avg_cost: form.cost || null, instrument_type: c.known_type || 'etf', target_weight_in_class: null, currency: q.currency, manual: false, price_updated_at: q.updated_at });
  } catch { addMsg = t('add.priceError'); render(); }
}

function addManual() {
  const ident = form.ident.trim();
  const unit = form.pmode === 'unit';
  const price = unit ? form.mprice : (form.pricePct / 100) * form.lot;
  if (!ident || !form.cat || !(price > 0)) return;
  const cost = unit ? form.mcost || null : form.costPct ? (form.costPct / 100) * form.lot : null;
  addMsg = '';
  addRow({ asset_class: form.cat, ticker: ident, name: form.name || ident, quantity: unit ? form.mqty : form.nominal / form.lot, price, avg_cost: cost, instrument_type: form.type, target_weight_in_class: null, currency: 'EUR', manual: true, price_updated_at: form.date });
}

async function importFile(text: string) {
  try {
    if (text.trim().startsWith('{')) {
      const r = await engine.importWorkspace(text);
      state.classes = Object.entries(r.targets).map(([name, pct]) => ({ name, pct }));
      state.portfolio = r.portfolio;
      const st = r.settings as { allow_fractional?: boolean; broker?: string };
      if (typeof st.allow_fractional === 'boolean') state.allowFrac = st.allow_fractional;
      if (st.broker && cfg.profiles.some((p) => p.name === st.broker)) state.broker = st.broker;
      importMsg = { ok: true, text: t('set.imported', { n: r.portfolio.length }) };
    } else {
      const r = await engine.importCsv(text);
      state.portfolio = r.portfolio;
      const missing = [...new Set(r.portfolio.map((x) => x.asset_class))].filter((c) => c && !state.classes.some((k) => k.name === c));
      missing.forEach((name) => state.classes.push({ name, pct: 0 }));
      importMsg = { ok: true, text: t('set.imported', { n: r.portfolio.length }) };
    }
    openSet.clear();
    save();
  } catch (e) { importMsg = { ok: false, text: t('set.importError', { error: (e as Error).message }) }; }
  render();
}

function onSearchInput() {
  window.clearTimeout(sgTimer);
  chosen = null;
  const q = form.q.trim();
  const paint = () => { const el = $('#sg'); if (el) el.innerHTML = sgHtml(); const b = $('#addbtn') as HTMLButtonElement | null; if (b) b.disabled = !chosen; };
  if (q.length < 3) { sg = []; sgMsg = ''; paint(); return; }
  if (!hasService()) { sg = []; sgMsg = t('srv.none'); paint(); return; }
  sgTimer = window.setTimeout(async () => {
    try { const r = await service.search(services(), q); if (form.q.trim() !== q) return; sg = r; sgMsg = r.length ? '' : t('add.noResults'); serverOk = true; }
    catch { sg = []; sgMsg = t('add.searchError'); serverOk = false; }
    paint();
  }, 300);
}

app.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const d = el.dataset;
  if (d.fm) {
    (form as unknown as Record<string, unknown>)[d.fm] = el.type === 'number' ? nval(el) : el.value;
    if (d.fm === 'q') onSearchInput();
  } else if (d.o) {
    (state.opts as unknown as Record<string, unknown>)[d.o] = Math.max(0, nval(el)); save(); scheduleCalc();
  } else if (d.s === 'carry') { state.carry = Math.max(0, nval(el)); save(); scheduleCalc(); }
  else if (d.fee) { (state.fees as unknown as Record<string, number>)[d.fee] = Math.max(0, nval(el)); save(); scheduleCalc(); }
});

app.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const d = el.dataset;
  if (d.row !== undefined && d.f) {
    const r = state.portfolio[Number(d.row)] as unknown as Record<string, unknown>;
    r[d.f] = ['target_weight_in_class', 'avg_cost'].includes(d.f) ? nullable(el) : ['quantity', 'price'].includes(d.f) ? Math.max(0, nval(el)) : el.value;
    if (d.f === 'price' || d.f === 'ticker') { r.manual = d.f === 'price' ? true : r.manual; }
    save(); render();
  } else if (d.fm === 'ident') { render(); }
  else if (d.cn !== undefined) {
    const i = Number(d.cn), old = state.classes[i].name, nv = el.value.trim();
    if (!nv || state.classes.some((c, k) => k !== i && c.name === nv)) { render(); return; }
    state.classes[i].name = nv;
    state.portfolio.forEach((r) => { if (r.asset_class === old) r.asset_class = nv; });
    state.opts.priority = state.opts.priority.map((x) => (x === old ? nv : x));
    save(); render();
  } else if (d.cp !== undefined) { state.classes[Number(d.cp)].pct = Math.max(0, nval(el)); save(); render(); }
  else if (d.sel) {
    const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    if (d.sel === 'broker') { state.broker = String(v); state.allowFrac = null; state.feeOverride = null; feesOpen = null; }
    else if (d.sel === 'strategy') state.opts.strategy = String(v);
    else if (d.sel === 'allowFrac') state.allowFrac = Boolean(v);
    else if (d.sel === 'feeOverride') { state.feeOverride = Boolean(v); feesOpen = true; }
    save(); render();
  } else if (el.id === 'file' && (el as HTMLInputElement).files?.[0]) {
    void (el as HTMLInputElement).files![0].text().then(importFile);
    (el as HTMLInputElement).value = '';
  }
});

app.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
  if (!btn) return;
  const act = btn.dataset.act, d = btn.dataset;
  const sure = () => confirm(t('set.confirm'));
  switch (act) {
    case 'tab': state.tab = d.tab as Tab; break;
    case 'lang': setLang(d.lang as Lang); break;
    case 'mode': state.opts.mode = d.mode as Mode; break;
    case 'addclass': { const n = (prompt(t('targets.newName')) ?? '').trim(); if (!n || state.classes.some((c) => c.name === n)) return; state.classes.push({ name: n, pct: 0 }); break; }
    case 'delclass': state.classes.splice(Number(d.i), 1); break;
    case 'normalize': { const s = sum(state.classes.map((c) => c.pct)); if (s > 0) state.classes.forEach((c) => { c.pct = Math.round((c.pct / s) * 1e4) / 100; }); break; }
    case 'delrow': { const i = Number(d.i); state.portfolio.splice(i, 1); openSet = new Set([...openSet].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k))); break; }
    case 'example': state.classes = defaultClasses(); state.portfolio = exampleRows(); break;
    case 'addsrv': {
      const input = document.getElementById('srvnew') as HTMLInputElement | null;
      const u = service.parseUrl(input?.value ?? '');
      if (!u) { srvMsg = t('srv.invalid'); break; }
      if (state.services.includes(u)) { srvMsg = t('srv.dup'); break; }
      state.services.push(u); srvMsg = ''; serverOk = true; break;
    }
    case 'delsrv': state.services.splice(Number(d.i), 1); srvMsg = ''; break;
    case 'resetsrv': state.services = service.defaultServices(); srvStatus = {}; srvMsg = ''; serverOk = true; break;
    case 'testsrv': {
      const u = state.services[Number(d.i)];
      if (!u) return;
      srvStatus[u] = 'wait'; render();
      void service.health(u).then((ok) => { srvStatus[u] = ok ? 'ok' : 'bad'; render(); });
      return;
    }
    case 'refresh': void updatePrices(); return;
    case 'addmode': form.mode = d.v as 'search' | 'manual'; addOpen = true; break;
    case 'pmode': form.pmode = d.v as 'unit' | 'percent'; addOpen = true; break;
    case 'pick': { const s = sg[Number(d.k)]; if (!s) return; chosen = s; form.q = s.symbol; sg = []; sgMsg = ''; addOpen = true; break; }
    case 'addsearch': void addFromSearch(); return;
    case 'addmanual': addManual(); return;
    case 'figi': {
      const isin = form.ident.trim().toUpperCase();
      if (isin.length !== 12) { figiMsg = { ok: false, text: t('man.figiNeed') }; break; }
      if (!hasService()) { figiMsg = { ok: false, text: t('srv.none') }; break; }
      void service.figi(services(), isin).then((r) => {
        if (r.type) { form.type = r.type; figiMsg = { ok: true, text: t('man.figiOk', { type: r.type, name: r.name }) }; } else figiMsg = { ok: false, text: t('man.figiNone') };
        render();
      }).catch(() => { figiMsg = { ok: false, text: t('man.figiNone') }; render(); });
      return;
    }
    case 'pup': case 'pdown': {
      const list = priorityList(), i = Number(d.i), j = act === 'pup' ? i - 1 : i + 1;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]]; state.opts.priority = list; break;
    }
    case 'dlorders': {
      if (!planResult) return;
      const head = ['action', 'ticker', 'name', 'category', 'quantity', 'price_eur', 'value', 'fees', 'tax', 'net_cash'];
      const rows = planResult.trades.map((x) => [x.action, x.ticker, x.name, x.asset_class, x.quantity, x.price, x.gross, x.fee, x.action === 'sell' ? x.tax : '', x.net_cash].map(csvCell).join(','));
      download('orders.csv', [head.join(','), ...rows].join('\n') + '\n', 'text/csv');
      return;
    }
    case 'import': (document.getElementById('file') as HTMLInputElement).click(); return;
    case 'exportjson': {
      const ws = { version: 2, targets: targetsDict(), settings: { allow_fractional: fractional(), broker: profile().name }, portfolio: state.portfolio };
      download('portfolio_workspace.json', JSON.stringify(ws, null, 2), 'application/json');
      return;
    }
    case 'exportcsv': download('portfolio.csv', csvOf(state.portfolio), 'text/csv'); return;
    case 'template': download('portfolio-template.csv', csvOf(exampleRows()), 'text/csv'); return;
    case 'clearpf': if (!sure()) return; state.portfolio = []; openSet.clear(); break;
    case 'resettargets': if (!sure()) return; state.classes = defaultClasses(); break;
    case 'resetall': if (!sure()) return; state = defaults(); openSet.clear(); planResult = null; importMsg = null; break;
    default: return;
  }
  save();
  render();
});

app.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (e.key === 'Enter' && el.id === 'srvnew') { e.preventDefault(); (app.querySelector('button[data-act="addsrv"]') as HTMLButtonElement | null)?.click(); }
});

app.addEventListener('toggle', (e) => {
  const dt = e.target as HTMLDetailsElement;
  if (dt.dataset.edit !== undefined) { const k = Number(dt.dataset.edit); if (dt.open) openSet.add(k); else openSet.delete(k); }
  else if (dt.dataset.addp !== undefined) addOpen = dt.open;
  else if (dt.dataset.fees !== undefined) feesOpen = dt.open;
}, true);

render();
engine.getConfig().then((c) => { cfg = c; engineState = 'ready'; if (!cfg.profiles.some((p) => p.name === state.broker)) state.broker = cfg.profiles[0].name; render(); })
  .catch((e: Error) => { engineState = 'error'; engineError = e.message; render(); });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
