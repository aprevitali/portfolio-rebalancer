// Prepara gli asset che l'app carica nel browser: Pyodide (self-hosted), il motore Python, il ponte e i profili broker.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(web, '..');
const pub = join(web, 'public');
const fresh = (dir) => { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); return dir; };

// 1) Pyodide: solo i file del nucleo (niente pacchetti esterni: il motore usa la libreria standard)
const pyDir = join(web, 'node_modules', 'pyodide');
const pyOut = fresh(join(pub, 'pyodide'));
for (const f of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) cpSync(join(pyDir, f), join(pyOut, f));

// 2) Il motore (cartella engine/ del repository, invariata) e il ponte JS <-> Python
const engOut = fresh(join(pub, 'engine'));
const files = readdirSync(join(root, 'engine')).filter((f) => f.endsWith('.py')).sort();
for (const f of files) cpSync(join(root, 'engine', f), join(engOut, f));
writeFileSync(join(engOut, 'index.json'), JSON.stringify(files));
cpSync(join(web, 'python', 'bridge.py'), join(pub, 'bridge.py'));

// 3) Profili broker: YAML -> JSON (il parsing avviene qui, non nel browser)
const bdir = join(root, 'brokers');
const profiles = existsSync(bdir)
  ? readdirSync(bdir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => parse(readFileSync(join(bdir, f), 'utf8')) || {})
  : [];
writeFileSync(join(pub, 'brokers.json'), JSON.stringify(profiles));
console.log(`assets pronti: ${files.length} moduli engine, ${profiles.length} profili broker`);
