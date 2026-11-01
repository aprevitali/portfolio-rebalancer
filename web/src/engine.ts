// Client del motore Python (Pyodide) che gira in un Web Worker.
import type { Config, Plan, Row } from './api';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { res: (s: string) => void; rej: (e: Error) => void }>();

function boot(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('worker.js', document.baseURI), { type: 'module' });
  w.onmessage = (e: MessageEvent<{ id: number; result?: string; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p.rej(new Error(e.data.error)); else p.res(e.data.result as string);
  };
  w.onerror = (e) => {
    const err = new Error(e.message || 'engine worker failed');
    pending.forEach((p) => p.rej(err));
    pending.clear();
    worker = null;
  };
  worker = w;
  return w;
}

function call<T>(method: string, arg: unknown): Promise<T> {
  const w = boot();
  return new Promise<T>((res, rej) => {
    const id = ++seq;
    pending.set(id, { res: (s) => res(JSON.parse(s) as T), rej });
    w.postMessage({ id, method, arg: typeof arg === 'string' ? arg : JSON.stringify(arg) });
  });
}

export const getConfig = () => call<Config>('config', '');
export const plan = (req: unknown) => call<Plan>('plan', req);
export const importCsv = (text: string) => call<{ portfolio: Row[] }>('import_csv', text);
export const importWorkspace = (text: string) =>
  call<{ portfolio: Row[]; targets: Record<string, number>; settings: Record<string, unknown> }>('import_workspace', text);
