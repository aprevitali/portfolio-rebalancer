# Portfolio Rebalancer

[English](README.md) · **Italiano**

Ribilancia il portafoglio tenendo conto di tasse italiane, commissioni e quote intere. Funziona interamente nel browser: il motore di calcolo (`engine/`, Python) gira con Pyodide e l'interfaccia è un'app statica su **GitHub Pages**.

Il portafoglio non lascia mai il dispositivo. Un piccolo **Cloudflare Worker** riceve solo ticker, testo di ricerca e ISIN per fornire prezzi e ricerca titoli.

App pubblicata: https://aprevitali.github.io/portfolio-rebalancer/

## Struttura
- `engine/`: motore Python (piani, tasse, commissioni, allocazione). Usa solo la libreria standard.
- `web/`: interfaccia (TypeScript + Vite). `web/python/bridge.py` collega JavaScript al motore; `web/public/worker.js` lo esegue in un Web Worker.
- `brokers/`: profili broker in `.yaml` (vedi `brokers/README.it.md`), convertiti in JSON in fase di build.
- `worker/`: servizio prezzi e ricerca su Cloudflare Workers (vedi `worker/README.it.md`).

## Sviluppo in locale
```bash
cd web
npm install
npm run dev        # http://localhost:5173 (copia in automatico engine/ e brokers/ in public/)
```
Per usare un Worker locale invece di quello pubblicato, in un secondo terminale:
```bash
cd worker
npx wrangler dev   # http://localhost:8787
```
Da `localhost` l'app include già `http://localhost:8787` tra i servizi. Per provare la versione di produzione (Service Worker e uso offline): `npm run build` e `npm run preview`.

## Pubblicazione
1. **Servizio prezzi**: `cd worker`, poi `npx wrangler login` e `npx wrangler deploy`. Il Worker si chiama `prezzi` e risponde su `https://prezzi.andrea-dev.workers.dev`: controlla che `/health` risponda.
2. **Repository**: fai push su `main` di un repo pubblico su GitHub (non caricare file con dati personali).
3. **Pagine**: *Settings → Pages → Source: GitHub Actions*, poi lancia il workflow *Deploy to GitHub Pages*. Il motore pesa circa 13 MB e viene scaricato solo alla prima visita.

Il workflow di Pages usa come servizio predefinito `https://prezzi.andrea-dev.workers.dev`. Per usare un altro indirizzo imposta la variabile `SERVICE_URL` (*Settings → Secrets and variables → Actions → Variables*), senza `/` finale.

Il workflow `worker.yml` pubblica il Worker a ogni modifica di `worker/` (secret `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`).
Con un dominio personalizzato, aggiungilo alla variabile `ALLOWED_ORIGINS` del Worker (separati da virgola); `*.github.io` e `localhost` sono già ammessi.

## Servizi prezzi nell'app
In **Impostazioni → Servizi prezzi e ricerca** ogni utente può aggiungere, provare, rimuovere servizi o ripristinare quelli predefiniti. Vengono provati in ordine: se uno non risponde o non ha il prezzo di un ticker, si passa al successivo.
I browser bloccano gli indirizzi `http://` su internet; `http://localhost` è ammesso.

## Importazione
Dalla scheda Impostazioni si importano il workspace JSON (`version: 2`) e il CSV. L'import CSV accetta anche il separatore `;` e i decimali con la virgola.

## Limiti noti
- La prima apertura scarica circa 13 MB (motore Python); poi parte dalla cache.
- I dati del portafoglio stanno nel browser: se si cancellano i dati del sito vanno persi. Usa l'esportazione JSON come backup.
- Yahoo Finance non è un servizio ufficiale e può bloccare gli IP dei datacenter: se i prezzi mancano l'app lo segnala e restano modificabili a mano. I suoi dati sono pensati per uso personale: verifica i termini prima di un uso commerciale.
- Il caricamento di Pyodide in un Web Worker è stato provato in Node, non ancora in un browser reale: verifica la prima apertura su Chrome e Safari.

## Licenza
Rilasciato con licenza **GNU Affero General Public License v3.0** (AGPL-3.0-only). Vedi [LICENSE](LICENSE). Se esegui una versione modificata come servizio in rete, l'AGPL ti obbliga a offrirne il codice sorgente agli utenti di quel servizio.

## Supporto
Se l'app ti è utile, puoi [offrirmi un caffè](https://buymeacoffee.com/aprevitali).
