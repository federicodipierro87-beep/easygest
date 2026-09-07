# EasyGest

Gestionale personale per spese ricorrenti, abbonamenti e documenti fiscali di un
consulente informatico con partita IVA.

Fa due cose:

1. **Spese e abbonamenti** — censimento delle spese ricorrenti, promemoria prima
   delle scadenze e delle finestre di disdetta, report, previsioni e margine per
   cliente (quanto paghi contro quanto riaddebiti).
2. **Archivio documenti fiscali** — fatture attive e passive, F24, contratti e
   comunicazioni del commercialista, ricercabili ed esportabili per periodo.

> **EasyGest non emette fatture elettroniche.** È un archivio e un gestionale
> interno: non dialoga con lo SDI e non produce documenti fiscalmente validi.

## Stack

| Livello  | Tecnologie                                                           | Deploy  |
| -------- | -------------------------------------------------------------------- | ------- |
| Backend  | Node 22, TypeScript, Fastify 5, Prisma, PostgreSQL 18                | Railway |
| Frontend | React 19, Vite, Tailwind v4, shadcn/ui, TanStack Query, Recharts     | Netlify |
| File     | Storage S3-compatible (Cloudflare R2 in produzione, MinIO in locale) | —       |
| Email    | Resend, dietro un'interfaccia `NotificationChannel`                  | —       |
| Job      | Servizio cron Railway separato, idempotente                          | Railway |

## Struttura

```
easygest/
├─ apps/
│  ├─ api/       API Fastify, schema Prisma, job schedulati
│  └─ web/       applicazione React
├─ packages/
│  └─ shared/    logica di dominio pura e schemi Zod condivisi
└─ docker-compose.yml   Postgres e MinIO per lo sviluppo locale
```

`packages/shared` non ha dipendenze da Prisma né da Fastify: contiene solo
funzioni pure (denaro, ricorrenze, margini, imposte) ed è dove vive la maggior
parte dei test.

## Setup locale

Servono **Node 22+** e **Docker**.

```bash
git clone <url-del-repo>
cd easygest
npm install

# Postgres su 5433 e MinIO su 9000 (console su 9001)
npm run infra:up

cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

npm run dev
```

- API: <http://localhost:3001> (health check su `/health`)
- Frontend: <http://localhost:5173>
- Console MinIO: <http://localhost:9001> — utente `easygest`, password `easygest-dev-secret`

Postgres è esposto sulla porta **5433** e non sulla 5432, così non entra in
conflitto con un'eventuale installazione già presente sulla macchina.

## Comandi

| Comando               | Cosa fa                                                 |
| --------------------- | ------------------------------------------------------- |
| `npm run dev`         | Avvia API e frontend insieme                            |
| `npm run dev:api`     | Solo il backend, con ricarica automatica                |
| `npm run dev:web`     | Solo il frontend                                        |
| `npm run build`       | Build di produzione di entrambi                         |
| `npm test`            | Vitest, una sola esecuzione                             |
| `npm run test:watch`  | Vitest in watch                                         |
| `npm run typecheck`   | `tsc --noEmit` su tutti i workspace                     |
| `npm run lint`        | ESLint con regole type-aware                            |
| `npm run format`      | Prettier in scrittura                                   |
| `npm run infra:up`    | Avvia Postgres e MinIO                                  |
| `npm run infra:down`  | Ferma i container, mantenendo i dati                    |
| `npm run infra:reset` | Ferma i container **cancellando i volumi**, poi riavvia |

## Deploy

Ogni push su `main` passa dalla CI (lint, typecheck, test, build) e viene poi
pubblicato automaticamente: il frontend su Netlify, l'API su Railway.

| Componente | Piattaforma | Configurazione        |
| ---------- | ----------- | --------------------- |
| Frontend   | Netlify     | `netlify.toml`        |
| API        | Railway     | `.railway/railway.ts` |
| Postgres   | Railway     | `.railway/railway.ts` |

Le impostazioni di build stanno in quei due file, versionati: non vanno
reimpostate a mano se il progetto viene ricreato.

`.railway/railway.ts` è **dichiarativo e distruttivo per omissione**: una
risorsa tolta dal file viene cancellata su Railway. Non va mai applicato alla
cieca.

```bash
npx railway config plan    # mostra il diff, non tocca nulla
npx railway config apply   # applica, chiedendo conferma
```

Le variabili d'ambiente vanno invece impostate sulle rispettive piattaforme.
Sono documentate una per una, con significato e valore di produzione, in
`apps/api/.env.example` e `apps/web/.env.example`. Le due che collegano fra loro
i due deploy:

- su Railway, `CORS_ORIGINS` deve contenere l'URL Netlify esatto;
- su Netlify, `VITE_API_URL` deve contenere l'URL Railway.

`VITE_API_URL` viene sostituita **a build time**: cambiarla richiede un nuovo
deploy del frontend, non basta riavviare. Per lo stesso motivo non può
contenere segreti.

## Stato del progetto

Lo stato delle fasi e le decisioni tecniche prese, con le relative motivazioni,
sono in [`PROGRESS.md`](./PROGRESS.md).

## Fuori scope nella v1

Volutamente non implementati, in ordine di probabile utilità futura:

- **OCR sui PDF** per compilare da solo i metadati dei documenti caricati.
- **Notifiche Telegram**, già previste dall'astrazione `NotificationChannel`.
- **Fatturazione elettronica verso SDI**: richiede un intermediario accreditato
  e responsabilità di conservazione sostitutiva; resta compito del gestionale
  con cui emetti le fatture.
- **Integrazione bancaria / PSD2** per la riconciliazione automatica dei
  pagamenti.
- **App mobile nativa**: il frontend è responsive e usabile da telefono.
- **Multi-utente reale**: lo schema è già predisposto (ogni entità ha `userId`),
  ma mancano inviti, ruoli e isolamento a livello di riga.
