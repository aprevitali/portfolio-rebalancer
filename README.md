# Portfolio Rebalancer

[English](README.md) · [Italiano](README.it.md)

Rebalance your portfolio taking Italian taxes, fees and whole-share orders into account. Everything runs in the browser: the calculation engine (`engine/`, Python) runs with Pyodide and the interface is a static app on **GitHub Pages**.

Your portfolio never leaves your device. A small **Cloudflare Worker** receives only tickers, search text and ISINs to provide prices and instrument search.

Live app: https://aprevitali.github.io/portfolio-rebalancer/

## Structure
- `engine/`: Python engine (plans, taxes, fees, allocation). Standard library only.
- `web/`: interface (TypeScript + Vite). `web/python/bridge.py` connects JavaScript to the engine; `web/public/worker.js` runs it in a Web Worker.
- `brokers/`: broker profiles as `.yaml` files (see `brokers/README.md`), converted to JSON at build time.
- `worker/`: price and search service on Cloudflare Workers (see `worker/README.md`).

## Local development
```bash
cd web
npm install
npm run dev        # http://localhost:5173 (automatically copies engine/ and brokers/ into public/)
```
To use a local Worker instead of the published one, in a second terminal:
```bash
cd worker
npx wrangler dev   # http://localhost:8787
```
When served from `localhost`, the app already includes `http://localhost:8787` among its services. To try the production build (Service Worker and offline use): `npm run build` and `npm run preview`.

## Deployment
1. **Price service**: `cd worker`, then `npx wrangler login` and `npx wrangler deploy`. The Worker is called `prezzi` and answers at `https://prezzi.andrea-dev.workers.dev`: check that `/health` responds.
2. **Repository**: push to `main` of a public GitHub repo (do not commit files with personal data).
3. **Pages**: *Settings → Pages → Source: GitHub Actions*, then run the *Deploy to GitHub Pages* workflow. The engine is about 13 MB and is downloaded only on the first visit.

The Pages workflow uses `https://prezzi.andrea-dev.workers.dev` as the default service. To use a different address, set the `SERVICE_URL` variable (*Settings → Secrets and variables → Actions → Variables*), without a trailing `/`.

The `worker.yml` workflow publishes the Worker on every change to `worker/` (secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
For a custom domain, add it to the Worker's `ALLOWED_ORIGINS` variable (comma-separated); `*.github.io` and `localhost` are already allowed.

## Price services in the app
In **Settings → Price & search services** each user can add, test and remove services, or restore the defaults. They are tried in order: if one is down or has no price for a ticker, the next one is used.
Browsers block `http://` addresses on the internet; `http://localhost` is allowed.

## Import
From the Settings tab you can import a workspace JSON (`version: 2`) or a CSV. CSV import also accepts the `;` separator and decimal commas.

## Known limitations
- The first load downloads about 13 MB (Python engine); afterwards it starts from the cache.
- Portfolio data lives in the browser: clearing the site data deletes it. Use the JSON export as a backup.
- Yahoo Finance is not an official service and may block datacenter IPs: if prices are missing the app says so and they can be edited by hand. Its data is intended for personal use: check the terms before any commercial use.
- Loading Pyodide in a Web Worker has been tested in Node, not yet in a real browser: check the first load on Chrome and Safari.

## License
Released under the **GNU Affero General Public License v3.0** (AGPL-3.0-only). See [LICENSE](LICENSE). If you run a modified version as a network service, the AGPL requires you to offer its source code to the users of that service.

## Support
If the app is useful to you, you can [buy me a coffee](https://buymeacoffee.com/aprevitali).
