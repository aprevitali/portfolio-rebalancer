// Web Worker (modulo): esegue il motore Python con Pyodide, fuori dal thread dell'interfaccia.
import { loadPyodide } from './pyodide/pyodide.mjs';

const base = new URL('./', import.meta.url).href;
let bridge;

const ready = (async () => {
  const py = await loadPyodide({ indexURL: base + 'pyodide/' });
  const list = await (await fetch(base + 'engine/index.json')).json();
  py.FS.mkdirTree('/app/engine');
  await Promise.all(list.map(async (f) => py.FS.writeFile('/app/engine/' + f, await (await fetch(base + 'engine/' + f)).text())));
  py.FS.writeFile('/app/bridge.py', await (await fetch(base + 'bridge.py')).text());
  py.runPython("import sys\nsys.path.insert(0, '/app')");
  bridge = py.pyimport('bridge');
  bridge.set_profiles(await (await fetch(base + 'brokers.json')).text());
})();
ready.catch(() => {});

self.onmessage = async (e) => {
  const { id, method, arg } = e.data;
  try {
    await ready;
    self.postMessage({ id, result: bridge[method](arg) });
  } catch (err) {
    const lines = String((err && err.message) || err).trim().split('\n');
    self.postMessage({ id, error: lines[lines.length - 1] });
  }
};
