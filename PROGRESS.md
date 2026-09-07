# Stato del progetto e decisioni tecniche

Questo file serve a ricostruire il contesto se il progetto resta fermo qualche
settimana. Contiene **cosa è fatto** e soprattutto **perché è fatto così**.

---

## Stato delle fasi

| Fase | Contenuto                                                           | Stato         |
| ---- | ------------------------------------------------------------------- | ------------- |
| 0    | Scaffolding monorepo, config, CI, Docker locale, health check       | ✅ Completata |
| 1    | Auth, schema DB, migrazioni, seed, CRUD clienti/fornitori/categorie | ⬜ Da fare    |
| 2    | CRUD spese, motore ricorrenze, generazione occorrenze, test         | ⬜ Da fare    |
| 3    | Frontend: lista e dettaglio spese, filtri, form                     | ⬜ Da fare    |
| 4    | Cron, email promemoria, digest settimanale, notifiche in-app        | ⬜ Da fare    |
| 5    | Dashboard, report, export CSV e PDF                                 | ⬜ Da fare    |
| 6    | Previsioni e simulatore what-if                                     | ⬜ Da fare    |
| 7    | Archivio documenti: upload R2, ricerca full-text, export ZIP        | ⬜ Da fare    |
| 8    | Deploy Railway e Netlify, documentazione finale                     | ⬜ Da fare    |

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
- **`/health` non interroga il database.** Se Postgres ha un singhiozzo,
  riavviare l'API trasforma un disservizio breve in uno lungo. La readiness
  probe, che invece verifica le dipendenze, arriva con Prisma nella Fase 1.
- **CORS come lista esplicita di URL**, non wildcard: il refresh token viaggerà
  in un cookie httpOnly e le richieste con credenziali vietano `*` per
  specifica.
- **Un unico formato di errore** `{ error: { code, message, requestId } }`. I
  messaggi dei 500 restano nei log e non escono nella risposta.
- **L'error handler non assume che l'errore sia un `Error`**: in JavaScript si
  può lanciare qualsiasi valore, e una libreria che facesse `throw 'boom'`
  farebbe esplodere l'handler stesso.

### Frontend

- **Tailwind v4 tramite plugin Vite**: niente `postcss.config` né
  `tailwind.config.js`, il tema si dichiara in CSS con `@theme`.
- **Alias `@/`** già configurato in Vite e in `tsconfig`, così `npx shadcn add`
  funzionerà senza reimpostare gli import.
- **`VITE_API_URL` tipizzata `string | undefined`** in `vite-env.d.ts`: con
  l'index signature `any` di Vite, un refuso nel nome della variabile passerebbe
  il typecheck e si romperebbe solo in produzione.

### Infrastruttura locale

- **Postgres sulla porta 5433**, per non collidere con un'installazione locale.
- **MinIO al posto di R2 in sviluppo**: è S3-compatible, quindi il codice
  applicativo è identico e si sviluppa senza account esterni e senza rete.
- **Il cron sarà un secondo servizio Railway sulla stessa immagine dell'API**,
  con start command diverso: nessuna duplicazione del client Prisma, una sola
  build, e log separati da quelli delle richieste HTTP.

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
- La CI non ha ancora un database: verrà aggiunto un service Postgres nel
  workflow quando arriveranno i test di integrazione, nella Fase 1.
