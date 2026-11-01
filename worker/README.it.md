# Servizio prezzi su Cloudflare Workers

[English](README.md) · **Italiano**

Fornisce all'app prezzi e ricerca titoli con gli endpoint `GET /health`, `GET /search?q=`, `POST /quotes` e `POST /figi`.
Riceve solo ticker, testo di ricerca e ISIN; il portafoglio non lascia mai il browser.

Il Worker si chiama `prezzi` (vedi `wrangler.toml`) e risponde su `https://prezzi.andrea-dev.workers.dev`.

## Distribuzione manuale
```bash
cd worker
npx wrangler login
npx wrangler deploy
```

## Prova in locale
```bash
cd worker
npx wrangler dev   # http://localhost:8787
```

## Come usarlo nell'app
- Il workflow di Pages lo usa già come servizio predefinito.
- Per un altro indirizzo: in **Impostazioni → Servizi prezzi e ricerca** incolla l'indirizzo e premi *Prova*, oppure imposta la variabile del repo `SERVICE_URL` (Settings → Variables → Actions) e rilancia il deploy di Pages.

## Distribuzione automatica da GitHub
Il workflow `.github/workflows/worker.yml` pubblica il Worker a ogni modifica di `worker/`. Servono due secret del repo:
`CLOUDFLARE_API_TOKEN` (modello "Edit Cloudflare Workers") e `CLOUDFLARE_ACCOUNT_ID`.

## Limiti da conoscere
- Piano gratuito: 100.000 richieste al giorno, 10 ms di CPU e 50 chiamate esterne per richiesta. Per questo `/quotes` elabora al massimo 40 ticker per richiesta; gli altri tornano in `missing` e l'app li chiede al servizio successivo.
- Yahoo può rifiutare gli IP dei datacenter: in quel caso i prezzi risultano mancanti e l'app passa al servizio successivo o ai prezzi manuali.
- Sono endpoint pubblici non documentati di Yahoo: possono cambiare senza preavviso.
