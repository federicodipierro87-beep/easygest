# Stato del progetto e decisioni tecniche

Questo file serve a ricostruire il contesto se il progetto resta fermo qualche
settimana. Contiene **cosa è fatto** e soprattutto **perché è fatto così**.

---

## Stato delle fasi

| Fase | Contenuto                                                           | Stato         |
| ---- | ------------------------------------------------------------------- | ------------- |
| 0    | Scaffolding monorepo, config, CI, Docker locale, health check       | ✅ Completata |
| 0.5  | Deploy anticipato: Netlify + Railway + Postgres gestito             | ✅ Completata |
| 1    | Auth, schema DB, migrazioni, seed, CRUD clienti/fornitori/categorie | 🟡 In corso   |
| 2    | CRUD spese, motore ricorrenze, generazione occorrenze, test         | ⬜ Da fare    |
| 3    | Frontend: lista e dettaglio spese, filtri, form                     | ⬜ Da fare    |
| 4    | Cron, email promemoria, digest settimanale, notifiche in-app        | ⬜ Da fare    |
| 5    | Dashboard, report, export CSV e PDF                                 | ⬜ Da fare    |
| 6    | Previsioni e simulatore what-if                                     | ⬜ Da fare    |
| 7    | Archivio documenti: upload R2, ricerca full-text, export ZIP        | ⬜ Da fare    |
| 8    | Rifinitura, documentazione finale, hardening                        | ⬜ Da fare    |

La Fase 8 era «deploy». È stata anticipata a **0.5**: il committente non lavora
in locale e vuole provare ogni fase su un URL. Rimandare il deploy alla fine
avrebbe significato scoprire solo all'ultimo i problemi che si vedono unicamente
in produzione — CORS, cookie cross-site, variabili d'ambiente, build in CI.

---

## Flusso di lavoro

Lo sviluppo è **online-first**: il locale serve solo a me per verificare prima
di pubblicare, l'ambiente di riferimento è quello deployato.

| Ambiente   | Dove                              | A cosa serve                                                    |
| ---------- | --------------------------------- | --------------------------------------------------------------- |
| Locale     | Docker Compose (Postgres, MinIO)  | Verifica delle modifiche prima del push                         |
| Produzione | Railway (API + Postgres), Netlify | L'ambiente che il committente usa e in cui inserisce dati reali |

Gli URL pubblici sono in [`README.md`](./README.md#ambiente-pubblico).

I due database sono **separati di proposito**: una migrazione sbagliata provata
in locale non tocca i dati già inseriti in produzione.

Ciclo: commit → push su `main` → CI (lint, typecheck, test, build) → deploy
automatico su Railway e Netlify → verifica sull'URL pubblico.

---

## Scelte di dominio concordate

| Tema                | Decisione                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Regime fiscale      | **Forfettario**, nei primi 5 anni: imposta sostitutiva 5%, coefficiente di redditività 67% (ATECO 62.0x), INPS gestione separata 26,07%. Tutti modificabili da `Settings`, così al sesto anno si cambia il 5 in 15 senza toccare codice.               |
| Costo reale         | In forfettario **l'IVA sulle fatture passive non è detraibile**: il costo di una spesa è il **totale**, non l'imponibile. Dashboard, report e previsioni ragionano sul lordo; l'imponibile resta solo dato documentale.                                |
| Margine per cliente | Due viste distinte: **margine sui riaddebiti** (teorico, dai markup) e **margine effettivo** (fatture attive del cliente meno spese a lui imputate). La seconda serve anche ad accorgersi di un riaddebito dimenticato.                                |
| Valute              | Multi-valuta attivo. Il tasso di cambio viene **congelato sull'occorrenza**, mai ricalcolato: altrimenti i report storici cambierebbero ogni giorno. Fonte: Frankfurter (tassi BCE), sync notturno, fallback all'ultimo tasso utile, override manuale. |
| Pagamento spese     | Il cron marca `PAID` le occorrenze scadute con `autoRenew = true`, ma lascia `confirmedAt` a null: la dashboard le mostra come "da confermare". Serve ad accorgersi degli aumenti di prezzo del fornitore, che è uno dei motivi per cui esiste l'app.  |
| Fatture attive      | Emesse altrove, archiviate qui con inserimento manuale degli importi. Oggi sono PDF sparsi sul filesystem: la Fase 7 prevede un **import massivo di una cartella** con compilazione assistita dei metadati.                                            |
| Seed                | `npm run seed` crea utente, categorie e impostazioni reali. `npm run seed:demo` aggiunge i dati finti (5 clienti, 25 spese, 40 documenti), così non finiscono mai in produzione per distrazione.                                                       |

---

## Decisioni tecniche

### Trasversali

- **Node 22 LTS** ovunque (`.nvmrc`, CI, Railway). Allineato alla versione già
  installata in locale per non avere divergenze fra sviluppo e produzione.
- **Importi in centesimi interi, aliquote in basis point interi** (`2200` =
  22,00%). Nessun `float` tocca mai un importo o una percentuale.
- **Date di business su colonne `DATE`** (senza ora), timestamp in `DateTime`
  UTC. Una scadenza è un giorno, non un istante: modellarla come `DATE` elimina
  alla radice i bug di ora legale, invece di doverli correggere con conversioni.
- **`packages/shared` è pubblicato come sorgente TypeScript**, senza build
  propria: viene compilato da tsup (API) e da Vite (web). Un artefatto in meno
  da tenere allineato e nessun passo di build da orchestrare.
- **ESLint type-aware fin da subito.** `no-floating-promises` e
  `no-misused-promises` intercettano la classe di errori che rompe
  silenziosamente handler Fastify e job schedulati.

### Backend

- **Fastify 5** invece di Express o NestJS: tipi migliori, plugin ufficiali per
  helmet/cors/rate-limit/multipart, e nessun boilerplate a moduli inutile per un
  monolite single-user.
- **Configurazione validata da Zod in un unico punto** (`config/env.ts`). Il
  processo esce con codice 78 (`EX_CONFIG`) e un messaggio leggibile se una
  variabile manca o è malformata, invece di propagare `undefined`.
- **`/health` non interroga il database, `/ready` sì.** Sono due domande diverse
  e chi le pone reagisce in modo opposto: a un fallimento di liveness si riavvia
  il processo, a uno di readiness ci si limita a non mandarci traffico. Se
  Postgres ha un singhiozzo, riavviare l'API trasforma un disservizio breve in
  uno lungo.
- **L'healthcheck di Railway punta a `/ready`.** Al deploy la domanda è «questa
  release è in grado di servire?»: con `/health` un deploy con `DATABASE_URL`
  sbagliata risponderebbe 200 — non tocca il database — e andrebbe in produzione
  a fallire ogni richiesta vera. Fallendo su `/ready` resta su il deploy
  precedente.
- **CORS come lista esplicita di URL**, non wildcard: il refresh token viaggerà
  in un cookie httpOnly e le richieste con credenziali vietano `*` per
  specifica.
- **Un unico formato di errore** `{ error: { code, message, requestId } }`. I
  messaggi dei 500 restano nei log e non escono nella risposta.
- **L'error handler non assume che l'errore sia un `Error`**: in JavaScript si
  può lanciare qualsiasi valore, e una libreria che facesse `throw 'boom'`
  farebbe esplodere l'handler stesso.

### Dati e persistenza

- **Prisma 7**, che rispetto alla 6 cambia tre cose non negoziabili: l'URL non
  sta più in `schema.prisma` ma in `prisma.config.ts`, il file `.env` non viene
  più caricato da solo (serve `dotenv/config` esplicito), e il client richiede un
  **driver adapter** — qui `@prisma/adapter-pg`, cioè un pool `pg` vero.
- **Il pool è configurato a mano** (`max` da env, `statement_timeout` 30s,
  `lock_timeout` 10s). Railway limita le connessioni del piano gestito e API e
  cron attingono allo stesso Postgres: esaurire il pool si manifesta come
  un'applicazione che si blocca senza errori.
- **`prisma.config.ts` legge `process.env.DATABASE_URL` e non l'helper `env()`**,
  che solleverebbe un'eccezione al solo caricamento del file: `prisma generate`
  gira anche in `postinstall`, dove il database non serve e spesso non c'è.
- **Il client generato finisce in `src/generated/` ed è escluso da git**, da
  Prettier e da ESLint. È un artefatto: si rigenera in `postinstall` e in `build`.
- **Il tipo del client si deriva con `ReturnType`, non si scrive a mano.**
  `PrismaClient` senza parametri perde la configurazione dei log e con essa la
  conoscenza di quali eventi esistono; il sintomo è un `$on('query')` che non
  compila lamentando `never`, senza dire dove sia il problema.
- **Tutti i log di Prisma escono come eventi, nessuno su stdout.** Quello che
  Prisma scrive da sé è testo libero e non JSON di pino, quindi su Railway
  finirebbe fuori dall'indice dei log proprio quando lo stai cercando. Le query
  si registrano solo in sviluppo: il loro testo contiene i dati dei clienti.
- **Ricerca full-text con colonna `tsvector` generata e indice GIN**, più indici
  trigram (`pg_trgm`) su titolo e numero per le ricerche parziali o con refuso.
  I tag sono fuori dal `tsvector` e hanno un GIN loro: `array_to_string` è STABLE
  e non IMMUTABLE, quindi Postgres rifiuta l'espressione generata — ma è anche
  giusto così, un tag è un'etichetta esatta, non prosa da lemmatizzare.
- **Il seed crea solo l'indispensabile per entrare** — utente, impostazioni,
  categorie di sistema — ed è pensato per poter girare anche in produzione. I
  dati dimostrativi staranno in uno script separato, così non possono finire sul
  database vero per distrazione.
- **Il seed non sovrascrive mai la password di un utente esistente.** Un seed
  lanciato per sbaglio non deve poter cambiare le credenziali di accesso. Se non
  gliene si passa una, ne genera una casuale e la stampa una volta sola: in
  database c'è solo l'hash bcrypt, che non è reversibile.
- **`@node-rs/bcrypt` invece di `bcrypt`**: stesso algoritmo, ma binari
  precompilati per ogni piattaforma. `bcrypt` è un addon node-gyp che, quando
  non trova un prebuild adatto, ripiega sulla compilazione dai sorgenti in fase
  di deploy — un modo classico di rompere una release.
- **L'idempotenza sta nei vincoli, non nel codice del job**: `@@unique` su
  `(expenseId, dueDate)` per le occorrenze e su `dedupeKey` per i promemoria. Un
  cron che parte due volte è un caso normale, non un incidente.

### Frontend

- **Tailwind v4 tramite plugin Vite**: niente `postcss.config` né
  `tailwind.config.js`, il tema si dichiara in CSS con `@theme`.
- **Alias `@/`** già configurato in Vite e in `tsconfig`, così `npx shadcn add`
  funzionerà senza reimpostare gli import.
- **`VITE_API_URL` tipizzata `string | undefined`** in `vite-env.d.ts`: con
  l'index signature `any` di Vite, un refuso nel nome della variabile passerebbe
  il typecheck e si romperebbe solo in produzione.

### Infrastruttura locale

- **Postgres sulla porta 55432**, volutamente alta e improbabile. La 5432 era
  occupata da un container di un altro progetto e la 5433 da un Postgres nativo
  di Windows — che però ascoltava _insieme_ al container, senza che nessuno dei
  due segnalasse un conflitto. Il sintomo era un'autenticazione fallita contro un
  server che sembrava il proprio e non lo era: sono servite ore per trovarlo, e
  `netstat -ano` che mostra due PID sulla stessa porta è l'unico modo per vederlo.
- **Il volume di Postgres è montato su `/var/lib/postgresql`**, non più su
  `.../data`: dalla major 18 l'immagine ufficiale vuole così, e col percorso
  vecchio il container entra in loop di riavvio.
- **Locale, CI e produzione sono tutti su PostgreSQL 18** (18.6 in locale e su
  Railway, `postgres:18-alpine` in CI). Verificato e non dato per scontato: una
  major diversa in produzione accetterebbe o rifiuterebbe in modo diverso la
  colonna generata e `pg_trgm`, e lo si scoprirebbe al deploy. Railway monta il
  volume su `/var/lib/postgresql/data`, che è il layout pre-18, ma è una
  convenzione della loro immagine e non indica la versione.
- **MinIO al posto di R2 in sviluppo**: è S3-compatible, quindi il codice
  applicativo è identico e si sviluppa senza account esterni e senza rete.
- **Il cron sarà un secondo servizio Railway sulla stessa immagine dell'API**,
  con start command diverso: nessuna duplicazione del client Prisma, una sola
  build, e log separati da quelli delle richieste HTTP.

### Deploy

- **Configurazione come codice**, non come click: `netlify.toml` e
  `.railway/railway.ts` stanno nel repository. Se un giorno il progetto va
  ricreato da zero, le impostazioni di build non vanno ricostruite a memoria.
- **Railway usa Infrastructure as Code, non `railway.json`.** Il primo tentativo
  è stato con `railway.api.json`: Railway lo ha rifiutato, perché ha deprecato
  quel formato e non lo accetta più per i servizi nuovi (i vecchi smettono di
  essere letti il 2026-12-01). Il file è stato riscritto come
  `.railway/railway.ts`.
- **L'IaC è dichiarativo e distruttivo per omissione**: ciò che non è nel file
  viene cancellato. Per questo il file è stato importato dallo stato reale con
  un `pull`, e non scritto a mano: un file parziale applicato per errore
  avrebbe cancellato il database. Il `plan` mostra sempre il diff prima
  dell'`apply`.
- **Regione `europe-west4` (Amsterdam), non il default `us-west2`.** Sono
  documenti fiscali di un professionista italiano: restano nell'Unione Europea,
  e per giunta con ~150 ms di latenza in meno. Spostare la regione ricrea il
  volume, quindi andava fatto adesso che il database è vuoto.
- **Il `plan` deve poter risultare vuoto.** Due dichiarazioni mostravano una
  differenza a ogni esecuzione pur essendo già applicate: la regione del volume,
  che Railway normalizza in `europe-west4-drams3a`, e `restartPolicyType`, che
  viene applicato ma riletto `null`. La prima è stata allineata alla zona reale,
  la seconda tolta. Non è cosmesi: la regione del volume compariva fra le
  modifiche **distruttive**, e un piano che segnala sempre differenze
  inesistenti abitua a non leggerlo — ed è così che prima o poi si conferma una
  cancellazione vera.
- **Railway attende l'esito di GitHub Actions prima di costruire**
  (`checkSuites: true`): se lint, typecheck o test falliscono, quel commit non
  arriva in produzione.
- **`watchPatterns` limita le build dell'API alle cartelle che la riguardano.**
  In un monorepo, senza, ogni modifica al frontend farebbe ricostruire e
  riavviare anche il backend.
- **Il build command non installa le dipendenze**, le installa Railpack nella
  sua fase di install. Il primo tentativo anteponeva un `npm ci`: cancellava
  `node_modules` mentre le cache di build sono montate lì dentro, e la build
  falliva con `EBUSY`. Le devDependencies — tsup e TypeScript, cioè proprio
  quelle che producono il bundle — sono garantite da `NPM_CONFIG_INCLUDE=dev`,
  perché con `NODE_ENV=production` npm le salterebbe.
- **Netlify builda dalla radice del repository, non da `apps/web`.** Le
  dipendenze sono gestite da npm workspaces: installare dalla sottocartella
  romperebbe il collegamento con `packages/shared`.
- **Il browser non chiama mai Railway: una rewrite di Netlify inoltra `/api/*`.**
  È la scelta che rende il cookie di refresh **first-party**. `easygest.netlify.app`
  e `api-production-d716.up.railway.app` sono domini registrabili diversi: una
  chiamata diretta avrebbe richiesto `SameSite=None; Secure`, che Safari blocca
  già oggi e Chrome restringe sempre di più — cioè un login che funziona sul mio
  browser e non sul telefono del committente. L'alternativa era comprare un
  dominio e usare `api.easygest.it`; il proxy costa zero, si fa subito e resta
  valido anche dopo, perché sposterebbe solo l'URL scritto in `netlify.toml`.
  La rewrite ha `status = 200`: è un proxy lato server, non un redirect, quindi
  il browser non vede mai l'altro host.
- **La rewrite `/api/*` deve stare prima della regola SPA `/*`.** Netlify applica
  la prima che combacia, e la catch-all restituirebbe `index.html` alle chiamate
  API: un errore di parsing JSON che non dice niente sulla causa vera.
- **Lo stesso proxy esiste nel dev server di Vite.** Non è comodità: senza, in
  locale il cookie sarebbe cross-origin e in produzione no, e i problemi di
  autenticazione si vedrebbero solo dopo il deploy.
- **`VITE_API_URL` vale `/api` ovunque**, ed è sostituita a build time, non letta
  a runtime: cambiarla richiede un nuovo deploy del frontend, non il riavvio. Per
  la stessa ragione lì dentro non può finire nulla di segreto. Essendo un
  percorso relativo, l'URL di Railway compare in un solo posto: `netlify.toml`.
- **`CORS_ORIGINS` non è più sulla strada del login**, dato che nessuna richiesta
  del browser è cross-origin. Resta impostata con l'URL Netlify esatto perché
  l'API risponde comunque al suo URL Railway, e senza lista esplicita accetterebbe
  chiamate da qualunque pagina. La wildcard `*` resta comunque vietata dalla
  specifica quando si inviano credenziali.
- **Sourcemap pubblicate anche in produzione.** Un bundle client è comunque
  leggibile e non contiene segreti; in cambio un errore in produzione si legge
  con lo stack originale invece che su codice minificato.

---

## Debiti tecnici e note

- **Advisory `esbuild` (low, GHSA-g7r4-m6w7-qqqr)**: riguarda il _dev server_ di
  esbuild su Windows, che non viene mai avviato (esbuild è usato solo come
  bundler da tsup, tsx e Vite). Nessuna fix non-breaking disponibile.
  Da rivalutare quando tsup aggiornerà la dipendenza.
- **Quirk di npm workspaces**: il primo `npm install -w <workspace>` eseguito
  subito dopo aver creato il `package.json` non scrive le dipendenze runtime nel
  file. Va rilanciato una seconda volta. Non è un problema del progetto, ma fa
  perdere tempo se non lo si sa.
- **`exactOptionalPropertyTypes` è disattivato.** Con Prisma e Zod produce più
  attrito che valore; da rivalutare a schema stabile.
- **La CI ha un Postgres, ma non ci sono ancora test di integrazione.** Per ora
  serve solo ad applicare le migrazioni da zero: è l'unico posto dove il SQL
  scritto a mano nella migrazione iniziale viene provato su un database vuoto.
- **Nuove advisory dev-only introdotte dalla CLI di Prisma**: `deepmerge-ts`
  (dentro `@prisma/config`) e `mysql2` — la CLI impacchetta tutti i driver, e
  quello MySQL non viene mai caricato dato che il provider è PostgreSQL. Entrambe
  toccano solo il tempo di build; la «fix» proposta da npm è un downgrade a
  Prisma 6.
- **`npm install -w <ws> -D <pkg>` può fallire con
  `Cannot read properties of null (reading 'edgesOut')`**, un bug di arborist.
  Si aggira scrivendo la dipendenza a mano nel `package.json` e lanciando
  `npm install` dalla radice.
- **La CLI Netlify rileva il monorepo e chiede da terminale quale workspace
  usare**, bloccando qualunque comando non interattivo. Va sempre passato
  `--filter @easygest/web`. Riguarda solo la CLI: le build da Git leggono
  `netlify.toml` e non fanno domande.
- **Il controllo di versione di `railway/iac` è rotto su Windows**, e rifiuta
  una CLI 5.49 dicendo che ne serve una ≥ 5.42.1. Fallisce due volte per due
  motivi diversi: cerca l'eseguibile in `process.env._`, che su Windows non è
  valorizzata e ripiega su `railway`, che nel PATH è uno script `.ps1` non
  avviabile da `execFileSync`; e se si punta `_` a `node.exe` la regex
  `\b(\d+)\.(\d+)\.(\d+)\b` non matcha `v22.18.0`, perché fra `v` e `2` non c'è
  confine di parola. La soluzione è `.railway/run.ps1`, che punta `_`
  all'eseguibile nativo `@railway/cli/bin/railway.exe`; si usa via
  `npm run railway:plan` e `npm run railway:apply`.
- **Un dominio Railway generato prima di un cambio di regione smette di
  funzionare.** Dopo lo spostamento in `europe-west4` il dominio creato quando
  il servizio era ancora in `us-west2` rispondeva `404 Application not found`
  dal proxy, mentre il deploy era `SUCCESS` e i log applicativi mostravano
  richieste servite regolarmente. Né impostare la `targetPort` né un redeploy
  hanno risolto: il routing sul bordo era rimasto legato alla vecchia regione.
  È bastato cancellare e ricreare il dominio, ed è il motivo per cui l'host
  dell'API contiene `d716` e non il suffisso assegnato la prima volta. Se
  ricapita: prima di cercare il problema nell'applicazione, ricreare il dominio.
- **Netlify ricostruisce a ogni push, anche per una modifica alla sola
  documentazione**, perché non ha un equivalente dei `watchPatterns` di Railway.
  Si può limitare con un comando `ignore` in `netlify.toml`, ma è un
  interruttore che se sbagliato salta build che servivano: da valutare solo se i
  minuti di build diventano stretti.
- **Il volume Postgres locale va ricreato** dopo il passaggio da 17 a 18:
  Postgres non avvia una data directory di una major precedente. Non essendoci
  ancora schema né dati, basta `npm run infra:reset`.
- **L'API resta raggiungibile anche al suo URL Railway diretto**, oltre che
  attraverso il proxy. Non è un problema — l'autorizzazione la farà il token, non
  l'irraggiungibilità — ma va ricordato quando si valuterà il rate limiting: le
  richieste che passano dal proxy arrivano tutte dagli IP di Netlify, quindi il
  conteggio per IP le tratterebbe come un unico client. Andrà usato
  `X-Forwarded-For`, con `trustProxy` configurato di conseguenza.
