# Price service on Cloudflare Workers

[English](README.md) · [Italiano](README.it.md)

Provides the app with prices and instrument search through `GET /health`, `GET /search?q=`, `POST /quotes` and `POST /figi`.
It receives only tickers, search text and ISINs; the portfolio never leaves the browser.

The Worker is called `prezzi` (see `wrangler.toml`) and answers at `https://prezzi.andrea-dev.workers.dev`.

## Manual deployment
```bash
cd worker
npx wrangler login
npx wrangler deploy
```

## Local testing
```bash
cd worker
npx wrangler dev   # http://localhost:8787
```

## Using it in the app
- The Pages workflow already uses it as the default service.
- For a different address: in **Settings → Price & search services** paste the address and press *Test*, or set the repo variable `SERVICE_URL` (Settings → Variables → Actions) and re-run the Pages deployment.

## Automatic deployment from GitHub
The `.github/workflows/worker.yml` workflow publishes the Worker on every change to `worker/`. Two repo secrets are required:
`CLOUDFLARE_API_TOKEN` ("Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`.

## Limits to be aware of
- Free plan: 100,000 requests per day, 10 ms of CPU and 50 subrequests per request. For this reason `/quotes` processes at most 40 tickers per request; the rest are returned in `missing` and the app asks the next service for them.
- Yahoo may reject datacenter IPs: in that case prices come back missing and the app falls back to the next service or to manual prices.
- These are public, undocumented Yahoo endpoints: they may change without notice.
