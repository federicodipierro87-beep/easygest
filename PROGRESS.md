# Stato del progetto e decisioni tecniche

Questo file serve a ricostruire il contesto se il progetto resta fermo qualche
settimana. Contiene **cosa è fatto** e soprattutto **perché è fatto così**.

---

## Stato delle fasi

| Fase | Contenuto                                                           | Stato         |
| ---- | ------------------------------------------------------------------- | ------------- |
| 0    | Scaffolding monorepo, config, CI, Docker locale, health check       | ✅ Completata |
| 0.5  | Deploy anticipato: Netlify + Railway + Postgres gestito             | ✅ Completata |
| 1    | Auth, schema DB, migrazioni, seed, CRUD clienti/fornitori/categorie | ✅ Completata |
| 2    | CRUD spese, motore ricorrenze, generazione occorrenze, test         | ✅ Completata |
| 3    | Frontend: lista e dettaglio spese, filtri, form                     | ✅ Completata |
| 4    | Cron, email promemoria, digest settimanale, notifiche in-app        | ✅ Completata |
| 5    | Dashboard, report, export CSV e PDF                                 | ⬜ Da fare    |
| 6    | Previsioni e simulatore what-if                                     | ⬜ Da fare    |
| 7    | Archivio documenti: upload R2, ricerca full-text, export ZIP        | ⬜ Da fare    |
| 8    | Rifinitura, documentazione finale, hardening                        | ⬜ Da fare    |

La Fase 8 era «deploy». È stata anticipata a **0.5**: il committente non lavora
in locale e vuole provare ogni fase su un URL. Rimandare il deploy alla fine
avrebbe significato scoprire solo all'ultimo i problemi che si vedono unicamente
in produzione — CORS, cookie cross-site, variabili d'ambiente, build in CI.

La Fase 1 è chiusa: schema, migrazioni, seed, autenticazione, anagrafiche di
clienti e fornitori, categorie e metodi di pagamento sono fatti, API e pagine.

La Fase 2 è chiusa ed è **solo backend**, come da roadmap: motore delle
ricorrenze, spese, occorrenze, cambi e `seed:demo`. Non c'è niente da cliccare —
si verifica con `curl` — ed è voluto: la Fase 3 disegna le pagine partendo da un
elenco già pieno invece che da uno vuoto. Il fetch dei cambi è stato **anticipato
dalla Fase 4** perché senza tasso una spesa in valuta non si può nemmeno creare.

La Fase 3 è chiusa e ha aggiunto tre pagine: l'elenco delle spese, il dettaglio
di una spesa su `/spese/:id` e l'elenco globale delle scadenze su `/scadenze`.
Quest'ultima non era nella roadmap ed è stata aggiunta perché il dettaglio
risponde a «cosa pago per questo servizio» ma non a «cosa devo pagare», che è la
domanda quotidiana. Il backend non è stato toccato: la Fase 2 esponeva già tutto
il necessario, e l'unica riga aggiunta a `packages/shared` è il tipo dei dettagli
del rifiuto di cancellazione.

La Fase 4 è chiusa ed è la prima che fa qualcosa **senza che nessuno apra
l'applicazione**: un cron in-process alle 07:00 estende l'orizzonte delle
occorrenze, marca pagate le arretrate con rinnovo automatico, manda i promemoria
per email e in-app, e il lunedì il riepilogo settimanale. Non ha richiesto
migrazioni: `ReminderLog`, `Notification` e i campi di `Settings` erano già stati
disegnati per lei nella migrazione iniziale. Chiude anche il debito delle
occorrenze che si materializzavano solo toccando la spesa.

Due cose sono cambiate rispetto al piano originale e sono spiegate più sotto: il
cron **non** è un secondo servizio Railway, e i promemoria hanno una regola di
scatto («l'anticipo più vicino») invece di mandarne uno per ogni anticipo
configurato.

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

| Tema                | Decisione                                                                                                                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regime fiscale      | **Forfettario**, nei primi 5 anni: imposta sostitutiva 5%, coefficiente di redditività 67% (ATECO 62.0x), INPS gestione separata 26,07%. Tutti modificabili da `Settings`, così al sesto anno si cambia il 5 in 15 senza toccare codice.                                                                                               |
| Costo reale         | In forfettario **l'IVA sulle fatture passive non è detraibile**: il costo di una spesa è il **totale**, non l'imponibile. Dashboard, report e previsioni ragionano sul lordo; l'imponibile resta solo dato documentale.                                                                                                                |
| Margine per cliente | Due viste distinte: **margine sui riaddebiti** (teorico, dai markup) e **margine effettivo** (fatture attive del cliente meno spese a lui imputate). La seconda serve anche ad accorgersi di un riaddebito dimenticato.                                                                                                                |
| Valute              | Multi-valuta attivo. Il tasso di cambio viene **congelato sull'occorrenza**, mai ricalcolato: altrimenti i report storici cambierebbero ogni giorno. Fonte: Frankfurter (tassi BCE), sync notturno, fallback all'ultimo tasso utile, override manuale.                                                                                 |
| Pagamento spese     | Il cron marca `PAID` le occorrenze scadute con `autoRenew = true`, ma lascia `confirmedAt` a null: la dashboard le mostra come "da confermare". Serve ad accorgersi degli aumenti di prezzo del fornitore, che è uno dei motivi per cui esiste l'app.                                                                                  |
| Fatture attive      | Emesse altrove, archiviate qui con inserimento manuale degli importi. Oggi sono PDF sparsi sul filesystem: la Fase 7 prevede un **import massivo di una cartella** con compilazione assistita dei metadati.                                                                                                                            |
| Seed                | `npm run seed -w @easygest/api` crea utente, categorie e impostazioni reali. `npm run seed:demo -w @easygest/api` aggiunge i dati finti (14 fornitori, 5 clienti, 27 spese e il loro storico), così non finiscono mai in produzione per distrazione. È idempotente per nome e ha un `--reset` che cancella solo ciò che ha creato lui. |

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
- **Gli errori di validazione escono con l'elenco completo dei campi sbagliati**,
  non con il primo: un form che si corregge un campo alla volta è la ragione per
  cui `parseBody` restituisce tutti gli issue di Zod.
- **Il 429 del rate limit ha un `code` suo, `RATE_LIMITED`.** Il messaggio
  predefinito di `@fastify/rate-limit` è in inglese e senza codice: usciva come
  `INTERNAL_ERROR`, cioè indistinguibile da un guasto del server proprio quando
  la risposta giusta è «aspetta e riprova». Attenzione al contratto di
  `errorResponseBuilder`: il valore che restituisce viene **lanciato**, quindi
  deve essere un `Error` annotato con `statusCode`, non l'involucro
  `{ error: ... }` della risposta. Restituire un oggetto semplice degrada il 429
  a 500, che è peggio del problema di partenza. Bloccato da un test in
  `app.test.ts`.

### Anagrafiche (clienti e fornitori)

- **Cancella se inutilizzato, altrimenti rifiuta e suggerisci l'archiviazione.**
  Una cancellazione che sopravvive a spese e documenti collegati li lascerebbe
  senza attribuzione, e il report per cliente diventerebbe una somma di righe
  orfane; ma impedirla sempre significherebbe convivere per anni con l'errore di
  battitura fatto il primo giorno. La `DELETE` conta i riferimenti: se sono zero
  cancella davvero — e il nome torna disponibile, cosa che un archivio non fa —
  altrimenti risponde 409 con `details: { expenses, documents }`.
- **I conteggi viaggiano su ogni riga dell'elenco** (`_count` di Prisma), quindi
  l'interfaccia sa già _prima_ di chiedere che quella cancellazione verrà
  rifiutata, e lo spiega invece di far premere un pulsante per scoprirlo. L'API
  ricontrolla comunque: il 409 è il vincolo, il conteggio in tabella è solo
  cortesia.
- **`satisfies Prisma.ClientSelect`, non `as const`.** Sembrano intercambiabili —
  entrambi trattengono i tipi letterali — ma `as const` rende l'oggetto
  profondamente `readonly`, e a quel punto Prisma non lo riconosce più come una
  selezione valida: ripiega silenziosamente sulla selezione di default, `_count`
  sparisce dal tipo della riga e l'errore che compare parla di proprietà mancanti
  senza mai nominare la causa. Vale identico per i `where`, dove in più
  `mode: 'insensitive'` degrada a `string` e smette di combaciare con `QueryMode`.
- **La proprietà si verifica dentro la stessa query che modifica**, con
  `where: { id, userId }` su `update` e `delete` — legale perché
  `ClientWhereUniqueInput` è un `AtLeast<..., 'id' | 'userId_name'>`. Non è solo
  una query risparmiata: leggere prima e scrivere poi lascia una finestra fra i
  due momenti, e soprattutto un record altrui risponde `404` esattamente come uno
  inesistente. Chiedere id a caso non dice a nessuno quali esistono.
- **I campi opzionali usano `.default(null)`, non `.optional()`.** Con
  `.optional()` un campo omesso resterebbe al valore precedente e la `PUT`
  diventerebbe una `PATCH` mascherata: svuotare la partita IVA di un cliente
  sarebbe impossibile dal form, perché il campo vuoto non arriverebbe mai. Con il
  default a `null` la `PUT` è una sostituzione completa, che è ciò che il verbo
  promette.
- **La partita IVA si valida col check digit, il codice fiscale solo di
  formato.** Le undici cifre italiane hanno un algoritmo di controllo (Luhn a
  pesi alterni) che intercetta la cifra sbagliata o le due invertite, cioè
  l'errore vero di chi trascrive da una fattura. Il codice fiscale ha anch'esso
  un carattere di controllo, ma è calcolato su nome, data e comune di nascita:
  verificarlo richiederebbe dati che qui non si raccolgono. Il controllo vale
  solo per `countryCode === 'IT'`.
- **I valori fiscali si normalizzano prima di validare** (`IT 007 431 101 57` →
  `00743110157`): il formato in cui un dato viene copiato non è il formato in cui
  va confrontato, e rifiutare uno spazio incollato è un modo gratuito di far
  sembrare l'applicazione ostile.
- **Le rotte di clienti e fornitori sono due file quasi identici, di proposito.**
  Astrarle oggi costerebbe un livello di indirezione per risparmiare duplicazione
  che è destinata a divergere: i fornitori hanno pannello e numero cliente, i
  clienti codice destinatario e PEC, e la Fase 2 aggiungerà a questi ultimi il
  margine. La duplicazione è però esattamente ciò che sbaglia in silenzio — una
  query rimasta su `client` dentro il file dei fornitori compila benissimo — e
  per questo il file di test dei fornitori, pur molto più corto, verifica
  isolamento e ricerca sui campi propri.
- **I test delle rotte firmano il token con `signAccessToken` invece di passare
  da `/auth/login`.** Il limite di 5 tentativi è per IP e non si azzera fra un
  test e l'altro: dalla sesta chiamata la suite fallirebbe per un motivo che non
  ha niente a che vedere con ciò che sta provando. In più ogni file crea **due**
  utenti, perché metà di quello che c'è da verificare è che il secondo non veda né
  possa toccare i dati del primo.

### Categorie e metodi di pagamento

- **Le categorie hanno preso `isActive` con una migrazione additiva.** Erano
  l'unica anagrafica senza archiviazione, e la mancanza si sarebbe vista solo
  al primo tentativo di togliere dai menù una categoria con dello storico
  attaccato: senza archiviazione l'unica uscita sarebbe stata cancellarla, che
  è proprio ciò che l'API rifiuta. Il valore di default è `true`, quindi le
  righe esistenti restano attive e la migrazione non tocca nulla.
- **`isSystem` blocca la cancellazione, non la modifica.** Le categorie del seed
  si rinominano, si ricolorano e si archiviano; non si eliminano, perché il seed
  fa `upsert` per nome e le ricreerebbe al primo riavvio. Non è una protezione
  dall'utente: è che la cancellazione _riuscirebbe_ e poi si disferebbe da sola,
  il che è peggio di un rifiuto. Il codice d'errore dedicato è
  `RESOURCE_IS_SYSTEM`, distinto da `RESOURCE_IN_USE` perché la via d'uscita è
  la stessa — archiviare — ma il motivo no.
- **Il seed non tocca `isActive` nell'`update` dell'upsert.** È la contropartita
  della regola precedente: riattivare le categorie di sistema a ogni avvio
  trasformerebbe l'unica alternativa rimasta alla cancellazione in un giro a
  vuoto, e la voce archiviata ricomparirebbe a ogni deploy. L'`update`
  riallinea solo `sortOrder`.
- **`isSystem` e `sortOrder` non sono nello schema di input.** Lo schema è
  `strictObject`, quindi mandarli è un errore di validazione e non un campo
  ignorato: è ciò che impedisce a una `PUT` costruita a mano di togliersi da
  sola il flag che blocca la cancellazione. Il corollario è che il `toInput` del
  frontend deve spogliarli, altrimenti ogni archiviazione fallirebbe con un 400.
- **Il filtro dell'elenco si chiama `usableFor`, non `scope`.**
  `usableFor=EXPENSE` restituisce le categorie `EXPENSE` **e** quelle `BOTH`,
  perché è la domanda che fa chi deve riempire un menù a tendina. Un confronto
  secco su `scope` darebbe un elenco a cui manca metà delle voci senza sembrare
  sbagliato, ed è il difetto tipico che nessuno segnala perché non si vede: il
  nome diverso serve proprio a non far pensare a un'uguaglianza.
- **`sortOrder` lo assegna il server**, come `max + 1`, perché è l'unico che sa
  cosa c'è già. Due creazioni simultanee otterrebbero lo stesso numero: non è un
  problema, la colonna non è unica e l'ordinamento ha `id` come secondo criterio,
  quindi le due categorie finiscono affiancate in ordine stabile. L'ordinamento
  predefinito dell'elenco è quello manuale e non l'alfabetico, perché il seed
  numera per frequenza d'uso.
- **Le icone sono un elenco chiuso di venti nomi**, e la corrispondenza
  nome→componente è scritta a mano nel frontend. `lucide-react` ne esporta oltre
  milleseicento: risolvere un nome qualsiasi a runtime richiederebbe
  `import * as icons`, che porta l'intera libreria nel bundle. Il tipo
  `CategoryIcon` è quello con cui è scritto anche il seed, quindi togliere un
  nome dall'elenco non compila invece di produrre categorie senza icona.
- **Il colore viene normalizzato, non solo validato**: `#ABC` diventa `#aabbcc`
  e `2563eb` diventa `#2563eb`. La colonna è `varchar(7)`, e due scritture dello
  stesso colore non devono risultare due colori diversi.
- **La scadenza di un metodo di pagamento è un dato a due campi, valido solo
  intero.** Un mese senza anno passerebbe la validazione — è un numero legale in
  un campo facoltativo — si salverebbe, e il promemoria della Fase 4 non saprebbe
  che farsene senza che nessuno abbia mai visto un errore. Un `superRefine`
  rifiuta le due metà. L'anno non viene invece confrontato con oggi: registrare
  una carta appena scaduta, per sapere quali abbonamenti spostare, è un uso
  legittimo.
- **Il confine della scadenza è l'inizio del mese _successivo_.** Una carta
  03/2027 funziona per tutto marzo: calcolarlo con `month` invece di `month + 1`
  la dichiarerebbe scaduta con trenta giorni d'anticipo, e il promemoria
  arriverebbe mentre la carta funziona ancora. Vive in `expiresBefore()`, nel
  pacchetto condiviso, perché lo useranno sia la pagina sia il cron.
- **`last4` non è vincolato al tipo `CARD`**: le ultime quattro cifre di un IBAN
  identificano un addebito SEPA allo stesso modo, e rifiutarle costringerebbe a
  scriverle nelle note, dove nessuna ricerca le troverebbe. Sono infatti un
  criterio di ricerca vero, accanto al nome: ci si arriva da una riga
  dell'estratto conto, dove il nome che hai dato tu alla carta non compare.
- **I numeri facoltativi passano da un `optionalNumber` e non da
  `z.coerce.number()` nudo.** Una casella non compilata arriva come `''`, che
  `z.coerce` convertirebbe volentieri in `0`: un mese di scadenza pari a zero,
  salvato senza che nessuno protesti.
- **Un metodo di pagamento non ha `documentCount`**, perché nessun documento vi
  punta. Il campo manca dalla risposta invece di essere uno zero costante che
  sembrerebbe un dato; nei dettagli del 409 invece c'è, a zero, perché il
  formato di `RESOURCE_IN_USE` è uno solo e un frontend che lo trovasse assente
  stamperebbe «undefined documenti».
- **`PaymentMethodFormInput` è `z.input`, non `z.infer`.** È l'unica entità in
  cui i due tipi divergono — `expiryMonth` esce numero ed entra come la stringa
  che una casella produce — e dichiarare il tipo d'ingresso evita di forzare
  quello d'uscita con un doppio cast, cioè di dire a TypeScript una cosa falsa.

### Ricorrenze e occorrenze

- **Le date si contano dall'inizio, non dalla precedente.** L'occorrenza numero
  _n_ è `startDate + n × intervallo`, mai «l'ultima più un mese». Incatenandole,
  un mensile che parte il 31 gennaio scivolerebbe al 28 febbraio e poi al 28
  marzo, e da lì in avanti sarebbe un abbonamento del 28: l'errore del mese corto
  diventerebbe permanente. Con l'ancora fissa il 28 febbraio è un'eccezione che
  si richiude da sola il 31 marzo.
- **L'orizzonte è 13 mesi, non 12.** Un rinnovo annuale con 60 giorni di
  preavviso va visto _insieme_ alla sua finestra di disdetta: a 12 mesi la
  scadenza del prossimo anno entra nell'elenco lo stesso giorno in cui è già
  troppo tardi per disdirla.
- **La sincronizzazione tocca solo il futuro.** `syncOccurrences` lavora
  esclusivamente su `dueDate >= oggi`: le righe `PAID`, `SKIPPED` e `CANCELLED`
  non vengono mai riscritte. È la sola parte del backend in cui un errore
  _distrugge_ dati invece di mostrare un numero sbagliato, e per questo la regola
  è una riga sola invece che una serie di casi.
- **Un aumento di prezzo vale da qui in avanti.** Modificare una spesa aggiorna
  le occorrenze future ancora `PLANNED` e lascia intatte quelle già pagate al
  vecchio prezzo. Se le riscrivesse tutte, lo storico direbbe che si è sempre
  pagato l'importo di oggi.
- **Le occorrenze future superstiti si aggiornano, non si rifanno.** Cancellare e
  ricreare sarebbe più semplice, ma porterebbe via note e documenti allegati a
  una scadenza futura — cioè proprio il lavoro che l'utente ha già fatto. Si
  cancellano solo le righe la cui data è uscita dal calendario.
- **Lo storico anteriore all'inserimento non si inventa.** Registrare oggi un
  abbonamento del 2020 non genera sessanta righe `PLANNED`: sarebbero scadenze
  già pagate con lo stato sbagliato, e un giornaliero di qualche anno sfonderebbe
  da solo il tetto delle mille occorrenze. Importare lo storico è un lavoro
  diverso, e infatti `seed:demo` lo fa a parte.
- **Le occorrenze si leggono e si correggono, non si creano.** Non esiste una
  `POST /occurrences`: le righe le produce il motore. La `PATCH` è l'unico punto
  dell'API in cui una persona riscrive un numero generato.
- **Una spesa con dello storico non si cancella** (409 `RESOURCE_IN_USE` con il
  conteggio): le occorrenze cadrebbero in cascata portandosi via quanto è stato
  pagato, e nessun report se ne accorgerebbe. Sospenderla toglie invece le
  scadenze future e tiene il passato.
- **La `PATCH` di un'occorrenza rifà i conti che dipendono da ciò che cambia.**
  Correggere il totale rideriva l'imponibile; cambiare la sola aliquota tiene
  fermo l'imponibile — è il dato letto sulla fattura — e ricalcola il totale.
  Riportare una riga a `PLANNED` azzera `paidAt`, altrimenti resterebbe una
  scadenza «non pagata» con sopra il giorno in cui è stata pagata.

### Cambi (anticipati dalla Fase 4)

- **Il tasso di un'occorrenza futura è quello di oggi, e si rinfresca da sé.**
  Il cambio del 15 marzo dell'anno prossimo non esiste; chiederlo con la data di
  scadenza restituirebbe comunque quello odierno, ma dichiarato vecchio di un
  anno e quindi rifiutato dal controllo di obsolescenza. Per una scadenza futura
  il cambio è una **stima**, riscritta a ogni sincronizzazione; quello vero si
  congela alla maturazione. Il corollario pratico è che una sincronizzazione
  intera richiede una sola conversione, non una per riga.
- **Senza tasso ci si ferma con un 422, non si converte alla pari.** Un cambio
  1:1 inventato produrrebbe un report sbagliato che nessuno andrebbe mai a
  controllare; un errore esplicito si vede subito.
- **Un tasso più vecchio di dieci giorni non è un tasso.** Il fine settimana e le
  feste chiudono la BCE per due o tre giorni, mai per dieci: oltre quella soglia
  la sincronizzazione è ferma, e usare l'ultimo valore noto significherebbe
  scrivere numeri plausibili e falsi.
- **Frankfurter pubblica «un euro vale 1,25 dollari», noi salviamo l'inverso.**
  La conversione moltiplica, quindi la colonna contiene già il fattore giusto:
  rovesciarlo a ogni lettura sarebbe una divisione ripetuta in giro per il
  codice, cioè un punto in cui sbagliare verso.
- **Ogni moltiplicazione per un tasso passa da `applyRate`**, che usa `Decimal`
  con arrotondamento half-up. È l'unico modo per tenere la regola «mai virgola
  mobile sul denaro» scritta in un posto solo invece che ricordata a ogni
  chiamata.

### Promemoria e notifiche

- **Il motore dei promemoria è puro e sta in `packages/shared/src/reminders.ts`**,
  nello stesso rapporto in cui `recurrence.ts` sta a `services/occurrences.ts`:
  non conosce Prisma e non legge l'orologio, riceve `{ today, settings,
occurrences, paymentMethods }` e restituisce `PlannedReminder[]`. Le query e la
  mappatura delle righe stanno in `apps/api/src/jobs/collect.ts`. È il file più
  provato della fase, e può esserlo perché non ha bisogno di un database.
- **Scatta l'anticipo più vicino, non tutti quelli che soddisfano.** Con gli
  anticipi `30, 7, 1` si sceglie il più piccolo ancora maggiore o uguale ai giorni
  che mancano davvero. Le due alternative ovvie sbagliano entrambe: «tutti quelli
  che soddisfano» manderebbe tre email insieme per una spesa inserita due giorni
  prima della scadenza; «esattamente uguale» perderebbe il promemoria per sempre
  se il processo è spento quel giorno. Col minimo applicabile un giro saltato si
  fonde nel successivo, con una chiave di deduplica diversa. È anche la regola
  meno indovinabile guardando l'interfaccia, per questo la pagina degli avvisi la
  scrive a parole sotto il campo.
- **La deduplica è una riga di database, non una decisione del codice.**
  `ReminderLog.dedupeKey` è unica, la grammatica è
  `GENERE:soggetto:qualificatore:CANALE` e un `P2002` è la risposta normale, non
  un errore. Le chiavi delle scadenze sono ancorate all'**occorrenza** e non alla
  spesa, così cambiare la ricorrenza — che rigenera le occorrenze future —
  produce identità nuove, che è la risposta giusta. `CARD_EXPIRING` porta dentro
  anche il mese, altrimenti correggere la scadenza di una carta da 03/2027 a
  03/2029 non farebbe mai più avvisare quella carta. Il digest usa la **settimana
  ISO**: con la data, spostare `digestDayOfWeek` da lunedì a mercoledì manderebbe
  due riepiloghi nella stessa settimana.
- **Il formato delle chiavi è provato con stringhe scritte a mano.** Sembra un
  test fragile ed è voluto che lo sia: cambiare un separatore rende irriconoscibili
  tutte le chiavi già scritte, cioè **rimanda tutte le email già inviate**. Meglio
  un test che si lamenta.
- **L'email si prenota prima di essere inviata.** Tre passi: si scrive il
  `ReminderLog` con `succeeded: false`, si manda, si annota l'esito. L'ordine
  inverso — scrivere dopo l'invio — sbaglia in modo peggiore: un crash a metà
  rimanda la stessa email, e chi riceve due promemoria identici per la stessa
  scadenza smette di fidarsi dei dati. Così invece se ne può perdere una, ma la
  riga `succeeded = false` resta lì a raccontarlo e la notifica in-app è già stata
  scritta prima. Fra «due volte» e «zero volte», zero è il danno minore ed è
  l'unico recuperabile.
- **In-app ed email non sono alternative: ogni avviso produce entrambi.** La
  notifica è una riga in tabella, non può fallire e non dipende da nessun servizio
  esterno, quindi è la rete di sicurezza se Resend è giù. L'email è il motivo per
  cui l'applicazione esiste: avvisare quando non la si sta guardando. Non c'è un
  interruttore per canale — chi non vuole le email svuota la lista degli anticipi,
  che è più onesto di un interruttore che lascia credere che qualcosa stia ancora
  arrivando.
- **Tutta la pipeline è idempotente per costruzione, e ci si appoggia tre volte:**
  per il recupero all'avvio (si rifà il giro a ogni deploy, senza tenere un
  registro di «l'ho già fatto oggi»), per il pulsante «Esegui adesso» (premerlo
  due volte non manda niente due volte) e per non doversi fidare del fatto che il
  cron sia partito una volta sola. Il test che vale la fase è due `runDailyJob` di
  fila con gli stessi argomenti e `expect(mailer.sent).toHaveLength(1)`.
- **Lo scheduler parte in `index.ts`, non in `buildApp`.** `buildApp` è chiamata
  da una ventina di test di integrazione: un cron avviato lì dentro sarebbe una
  corsa contro la suite, e marcherebbe `PAID` occorrenze di prova mentre un test
  le conta. Un flag non sarebbe una garanzia, perché `vitest.setup.ts` legge
  `apps/api/.env`; così invece la garanzia è strutturale, i test non eseguono mai
  quel file. Il **mailer** sta dentro `buildApp`, perché serve anche alla rotta
  manuale e nei test dev'essere sostituibile.
- **`CRON_TIMEZONE` e `Settings.timezone` sono due cose diverse.** La prima decide
  _a che ora_ arriva l'email, la seconda _quale giorno è_ per i conti: ogni utente
  viene elaborato con il proprio `occurrenceContext`. Se divergessero l'unico
  effetto sarebbe un'email a un'ora strana, mai una scadenza contata nel giorno
  sbagliato.
- **Lo sweep gira prima dei promemoria, e l'ordine è vincolato**: `fx` → sweep →
  promemoria → digest → potatura. È lo sweep a materializzare le occorrenze su cui
  gli avvisi scattano; invertendoli, il giorno in cui l'orizzonte si estende la
  scadenza appena nata non riceverebbe il suo avviso a 30 giorni.
  `syncOccurrences` ha un `try/catch` **per singola spesa**, perché un
  `MISSING_FX_RATE` su una spesa in corone non deve fermare le altre ventisei.
- **Le auto-pagate mettono `paidAt = dueDate`, non «adesso».** Il pagamento è
  avvenuto il giorno della scadenza, non quello in cui il cron se n'è accorto: per
  questo è un ciclo di `update` e non un `updateMany`, che non sa copiare una
  colonna in un'altra. **`confirmedAt` non si tocca mai**: è il meccanismo con cui
  ci si accorge degli aumenti di prezzo, e riempirlo da codice lo spegnerebbe.
- **Il digest vuoto non si manda, ma la riga di deduplica si scrive lo stesso.**
  Senza, ogni riavvio dello stesso giorno ci riproverebbe. Le quattro sezioni sono
  scadenze dei prossimi 7 giorni, finestre di disdetta entro 30, **da confermare**
  e in ritardo: la terza è quella che dà al riepilogo una ragione d'esistere oltre
  ai promemoria, perché nessun altro avviso la nomina.
- **Nessun avviso di disdetta se `cancelledAt` è valorizzato**, e solo sulla
  **prima** occorrenza `PLANNED` della spesa. Insistere su una disdetta già
  inviata è peggio del silenzio; e senza il vincolo sulla prima, un mensile con 60
  giorni di preavviso farebbe scattare due o tre occorrenze insieme. Passato il
  termine non si avvisa più: sarebbe un rimprovero, non un'azione.
- **Nessun avviso per una carta in scadenza che non paga più niente.** Serve
  almeno una spesa `ACTIVE` agganciata: avvisare per una carta inutilizzata
  insegna a ignorare gli avvisi, ed è il danno più caro di tutti.
- **Resend senza SDK**, una `POST` con `fetch` e la risposta validata da Zod,
  esattamente come `services/frankfurter.ts` fa con la BCE. Una dipendenza in meno
  e coerenza con l'unico altro servizio esterno del progetto. Su un non-2xx
  l'errore porta lo stato e i primi 200 caratteri del corpo, perché «422» da solo
  non dice se il problema è il mittente non verificato o il destinatario.
- **`MAIL_TRANSPORT` ha tre valori e il default lo decide `createMailer`, non lo
  schema Zod**: `production → resend`, `test → memory`, altrimenti `log`.
  Scriverlo anche nello schema significherebbe avere la stessa regola in due
  posti, e il secondo prima o poi diverge. Nello schema resta solo il
  `superRefine` che rifiuta `resend` senza chiave.
- **I testi delle email stanno in `packages/shared`**, come funzioni pure
  `PlannedReminder[] → { subject, title, text }`, così si provano con gli stessi
  test del motore. Niente MJML né React Email: template literal per il testo e
  venti righe per l'HTML. La parte `text` non è un ripiego — è quella che si legge
  nell'anteprima del telefono, ed è la stessa che finisce in `Notification.body`.
- **Il conteggio delle non lette ha una rotta sua**, `/notifications/unread-count`.
  È quella che il frontend interroga ogni minuto: dev'essere un `count`
  sull'indice già esistente, e infilarlo nella lista romperebbe la forma di
  `Paginated<T>`, che è uguale per tutte le risorse.
- **`POST /notifications/:id/read` e non `PATCH`.** È un'azione idempotente senza
  corpo, e il parser del corpo vuoto esiste già, scritto per `/auth/refresh`. Un
  `PATCH { read: true }` aprirebbe subito la domanda «e `read: false`?», che non
  serve a nessuno.
- **Gli anticipi si salvano deduplicati e ordinati**, dal `transform` dello schema.
  `[7, 30, 7]` e `[30, 7]` sono la stessa configurazione: salvarle diverse
  renderebbe diverse due chiavi di deduplica che devono coincidere. È anche il
  motivo per cui la pagina riscrive il modulo con la risposta del server — chi
  scrive `7, 30, 7` deve rileggere `30, 7`, altrimenti la normalizzazione resta
  invisibile.
- **La lista delle notifiche si carica solo all'apertura del popover**
  (`enabled: open`): a campanella chiusa viaggia solo il conteggio. I sessanta
  secondi di `refetchInterval` non sono di meno perché i dati sotto cambiano una
  volta al giorno, e non di più perché dopo un «Esegui adesso» il badge deve
  reagire entro un tempo che sembri una conseguenza del clic.
  `refetchIntervalInBackground` resta `false`, così una scheda dimenticata non
  interroga l'API tutta la notte.
- **Il badge dice il numero anche a parole**, nell'`aria-label`: un pallino rosso
  non si legge con lo screen reader, e l'unica informazione che porta dev'essere
  anche nell'etichetta.
- **`PATCH /settings` non accetta `baseCurrency`.** I cambi sono congelati sulle
  occorrenze nel momento in cui nascono: cambiare la valuta base a metà strada
  renderebbe incomparabili tutti i `baseGrossCents` già scritti, senza che niente
  lo segnali. `GET` invece restituisce tutta la riga, perché alla Fase 6 serve il
  regime fiscale.
- **`upsert` e non `update` sulle impostazioni**, così un utente senza riga si
  autoripara invece di ricevere 500 a ogni chiamata.
- **La tendina dei fusi ha nove voci più quella salvata se è fuori elenco.**
  Seicento fusi, per un utente che ne ha uno solo corretto, sono più difficili da
  usare di nove; ma chi ha un fuso arrivato dal seed o dall'API non deve vederselo
  sostituire dal primo della tendina semplicemente aprendo la pagina. La
  validazione usa `isValidTimeZone`, che prova a costruire un
  `Intl.DateTimeFormat` e guarda se esplode: `Intl.supportedValuesOf` sarebbe più
  severo ma alloca seicento stringhe a ogni chiamata e rifiuterebbe `UTC`, mentre
  il `try/catch` accetta esattamente ciò che poi funzionerà a valle.
- **`POST /jobs/:name/run` è protetto dalla sessione, non da un token condiviso.**
  Un secondo sistema di credenziali da custodire, per un endpoint che non fa nulla
  che l'utente non possa già fare sui propri dati, sarebbe costo senza guadagno.
  Ha un limite di 5 al minuto, e questo vincola il test: `app.inject` arriva
  sempre dallo stesso IP, quindi quel file ne usa esattamente tre.
- **Risponde con i contatori del giro, non con un «fatto».** `{ fxRates,
occurrencesSynced, markedPaid, remindersPlanned, emailsSent,
notificationsCreated, failures }` è esattamente ciò che si vuole leggere per
  capire se in produzione funziona: un `emailsSent` a zero dove ce se ne aspettava
  uno è un'informazione, «fatto» no. Per questo `JobResult` e `JobCounters` stanno
  in `packages/shared` e non in `apps/api`: sono la forma di una risposta HTTP che
  il frontend legge, come `Settings` e `Notification`.

### Autenticazione

- **Access token JWT di breve durata (15 min) + refresh token opaco in cookie
  httpOnly (30 giorni).** L'access token non è revocabile: la sua durata è la
  finestra in cui uno rubato resta utilizzabile. Il refresh invece è una riga di
  database, quindi si può invalidare davvero.
- **`jose` invece di `jsonwebtoken`**, e la verifica passa un elenco esplicito di
  algoritmi (`algorithms: ['HS256']`) oltre a `issuer` e `audience`. Senza quella
  lista un token con `alg: none` verrebbe accettato: c'è un test apposta.
- **I refresh token in database sono solo hash SHA-256.** Sono valori casuali da
  32 byte, non password: non serve bcrypt (nessun attacco a dizionario ha senso
  su un valore casuale), serve che una lettura del database non consegni sessioni
  utilizzabili. Il valore in chiaro esiste solo nel cookie.
- **Rotazione con rilevamento del riuso, per famiglia.** Ogni refresh consuma il
  token e ne emette uno nuovo con lo stesso `familyId`. Se un token già consumato
  viene ripresentato, l'unica spiegazione è che qualcuno ne ha una copia: viene
  revocata **l'intera famiglia**, buttando fuori sia il ladro sia il legittimo
  proprietario. Un token semplicemente scaduto invece non revoca niente, altrimenti
  basterebbe tornare su una scheda del browser lasciata aperta per perdere la
  sessione.
- **Email sconosciuta e password sbagliata danno lo stesso errore e impiegano lo
  stesso tempo.** Rispondere «utente inesistente» significa regalare un
  verificatore di indirizzi; rispondere identicamente ma in un decimo del tempo
  significa regalarlo lo stesso, misurando. Da qui il confronto bcrypt contro un
  hash fittizio quando l'utente non esiste.
- **`authenticate` rilegge l'utente dal database a ogni richiesta**, invece di
  fidarsi dei claim del token. Costa una query, ma è ciò che rende immediata la
  disattivazione di un account: altrimenti resterebbe operativo fino alla
  scadenza dell'access token.
- **Limite di 5 tentativi di login ogni 15 minuti**, separato dal tetto generale
  di 300/minuto. Il tetto generale protegge dai loop del frontend, questo dal
  provare password.
- **Il limite di bcrypt è di 72 _byte_, non 72 caratteri**, e oltre quella soglia
  tronca in silenzio — una password lunga di soli caratteri accentati verrebbe
  accettata e poi mutilata. La validazione conta i byte UTF-8, con un test sul
  confine esatto.
- **`packages/shared` non ha accesso né a Node né al DOM** (`"types": []`), quindi
  il conteggio dei byte è scritto a mano invece di usare `TextEncoder`. È la
  frontiera che garantisce che quel pacchetto compili identico sui due lati.
- **`REGISTRATION_ENABLED` è un enum `'true' | 'false'`, non un booleano
  convertito.** `Boolean('false')` vale `true`: una conversione ingenua aprirebbe
  le registrazioni proprio scrivendo che si vogliono chiuse. Il default è
  `false` e un valore ambiguo fa fallire l'avvio.
- **Il cookie di refresh ha `Path=/`, non `/auth/refresh`.** Sembra un
  allargamento gratuito ed è invece obbligatorio: il browser confronta `Path` con
  l'URL che vede lui (`/api/auth/refresh`), non con quello riscritto dal proxy
  Netlify. Con un path più stretto il cookie non verrebbe mai inviato. In
  produzione il nome prende il prefisso `__Host-`, che impone comunque `Secure` e
  `Path=/`.
- **Il `changePassword` revoca tutte le famiglie tranne quella corrente**: cambiare
  password deve buttare fuori gli altri dispositivi, non anche quello da cui la
  si sta cambiando.
- **I test del servizio girano contro un PostgreSQL vero.** La rotazione dei
  token vive nei vincoli di unicità e nelle transizioni di stato di una riga: con
  un finto client Prisma il test verificherebbe soltanto sé stesso. Ogni test crea
  un utente con email casuale e lo cancella, così la suite può girare sul database
  di sviluppo senza portarsi via i dati esistenti.
- **I cambi si isolano per valuta, perché non hanno un proprietario.** Ogni altra
  tabella si separa per `userId`: `FxRate` no, è una sola per tutti. Tre file di
  test ci scrivevano e ripulivano con un `deleteMany()` senza filtro, quindi in
  parallelo si portavano via a vicenda le righe su cui stavano asserendo — un
  fallimento che compariva solo nella suite intera e mai lanciando il singolo
  file. Ora ogni file dichiara in testa le valute che possiede e cancella solo
  quelle; sono corone, yen e dollari canadesi perché la suite gira sullo stesso
  database dello sviluppo e `seed:demo` usa dollari, sterline e franchi, che
  altrimenti sparirebbero a ogni `npm test`.

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
- **Ciò che esiste solo come SQL grezzo dentro una migrazione, Prisma lo
  cancella alla migrazione successiva.** È una lezione pagata, e va scritta per
  intero perché il modo in cui si manifesta non porta a sospettarne la causa.
  La colonna `tsvector` generata e i quattro indici GIN/trigram del documento
  erano stati creati a mano nella migrazione iniziale, ma non erano dichiarati
  nello `schema.prisma`. Il confronto schema↔database li vede quindi come
  oggetti di troppo: la prima `migrate dev` successiva — una banale aggiunta di
  colonna — ha generato un file che si apriva con quattro `DROP INDEX` e
  proseguiva con `ALTER COLUMN "searchVector" DROP DEFAULT`. Quest'ultima
  fallisce, perché su una colonna generata non si può fare, e la migrazione si è
  fermata con un `P3018`.
- **Una migrazione fallita non viene annullata: le istruzioni già eseguite
  restano.** I quattro `DROP INDEX` erano prima dell'istruzione che ha fallito,
  quindi gli indici della ricerca full-text erano stati persi davvero — sul
  database di sviluppo, per fortuna. Il recupero è stato
  `prisma migrate resolve --rolled-back`, la rimozione della cartella della
  migrazione e la ricreazione a mano degli indici; ma la lezione è che
  `migrate dev` non è un'operazione atomica su cui contare.
- **La cura è dichiarare quegli oggetti nello schema**, non ricrearli ogni volta:
  `@default(dbgenerated())` senza argomento sulla colonna generata (è il modo
  documentato di dire «questo valore lo decide il database, non provo a
  descrivertelo»), e i quattro indici come `@@index([...], type: Gin)` con
  `ops: raw("gin_trgm_ops")` dove serve. Il `map:` sui due trigram tiene i nomi
  originali, che altrimenti Prisma normalizzerebbe in `Document_title_idx` —
  perdendo l'informazione che non si tratta di un btree. La verifica che la cura
  funzioni è generare una migrazione a vuoto: se il file esce vuoto, non c'è più
  deriva.

### Frontend

- **Tailwind v4 tramite plugin Vite**: niente `postcss.config` né
  `tailwind.config.js`, il tema si dichiara in CSS con `@theme`.
- **Alias `@/`** configurato in Vite, in `tsconfig` e — separatamente — in
  `vitest.config.ts`: Vitest legge quest'ultimo e non quello di `apps/web`,
  quindi senza ripeterlo i test dei componenti non risolvono `@/components/...`.
- **L'access token vive solo in memoria.** Non in `localStorage`, che è leggibile
  da qualunque script finisca nella pagina e sopravvive alla chiusura della
  scheda. Non serve nemmeno: la sessione si ricostruisce dal cookie httpOnly a
  ogni avvio, quindi un token rubato dura al massimo quanto la scheda aperta.
- **Rinnovo a singolo volo.** È il vincolo che detta la forma dello store.
  L'API ruota i refresh token e tratta il riuso di uno già consumato come un
  furto, revocando l'intera famiglia: se tre query scadessero insieme e ognuna
  chiamasse `/auth/refresh`, la prima consumerebbe il cookie e le altre due lo
  ripresenterebbero, chiudendo la sessione. Chi arriva mentre un rinnovo è in
  corso aspetta quello. E una richiesta che incassa un 401 dopo che qualcun
  altro ha già rinnovato riprova col token in memoria invece di bruciare un
  altro giro di rotazione.
- **Tre stati di sessione, non due.** `loading` esiste perché all'avvio non
  sappiamo ancora se una sessione c'è — la risposta sta in un cookie che il
  JavaScript non può leggere. Trattare l'ignoto come «non autenticato» farebbe
  comparire e sparire il modulo di accesso a ogni ricarica.
- **Il ripristino parte prima del primo rendering**, in `main.tsx`, non da un
  effetto: è il momento più presto possibile, e aspettare che l'albero sia
  montato ritarderebbe la richiesta per niente.
- **Nessun context di React per la sessione.** Lo store è già unico per
  l'applicazione e si legge con `useSyncExternalStore`; un provider
  aggiungerebbe solo un livello. Il vantaggio vero è che lo store è privo di
  React, quindi la concorrenza si prova come logica pura invece che montando
  componenti.
- **La destinazione dopo il login è accettata solo se comincia con una singola
  barra.** Un valore come `//altrove.example` verrebbe letto dal browser come un
  altro host, e il login diventerebbe un trampolino per chi si fida del dominio.
- **Errori mappati per `code`, mai per messaggio**: il testo del server può
  cambiare senza preavviso, il codice è un contratto. `INVALID_CREDENTIALS`
  resta vago su quale dei due campi sia sbagliato, per non permettere di
  scoprire chi ha un account.
- **shadcn/ui con preset `nova` su base Radix.** I componenti generati importano
  `cn` dall'omonimo pacchetto — pubblicato dallo stesso autore dei componenti —
  invece della vecchia coppia `clsx` + `tailwind-merge`: riscrivere quegli
  import a ogni `shadcn add` sarebbe una tassa ricorrente. `@/lib/utils` lo
  riesporta perché l'alias dichiarato in `components.json` resti valido.
- **`color-scheme: light`, non `light dark`.** La tavolozza scura è generata ma
  nessuno applica la classe che l'attiva: dichiarare entrambe farebbe disegnare
  al browser scrollbar e controlli nativi in scuro sopra una pagina bianca.
- **I componenti si provano con `renderToString`**, senza DOM finto. Un hook
  usato male, un componente di React Router fuori dal suo router o uno snapshot
  mancante in `useSyncExternalStore` non li vede né TypeScript né ESLint:
  compaiono al primo rendering, e per farli emergere non serve un ambiente
  jsdom più lento per tutta la suite.
- **`VITE_API_URL` tipizzata `string | undefined`** in `vite-env.d.ts`: con
  l'index signature `any` di Vite, un refuso nel nome della variabile passerebbe
  il typecheck e si romperebbe solo in produzione.
- **Il livello dati delle anagrafiche è invece condiviso** (`lib/resources.ts`),
  al contrario delle rotte che restano due. Non è un'incoerenza: qui dentro non
  compare un solo nome di campo, cambia unicamente la stringa del percorso.
  Elenco paginato, mutazioni con invalidazione e lettura degli errori per campo
  sono identici per definizione, e lo resteranno anche quando i due modelli
  divergeranno.
- **Ogni mutazione invalida la chiave radice della risorsa**, non la singola
  query. La lista è filtrata, ordinata e paginata: dopo una modifica il record
  può cambiare pagina o uscire dal filtro, e indovinare quali chiavi toccare
  costerebbe più della rilettura.
- **`placeholderData: (previous) => previous` sulle liste.** Cambiare pagina o
  digitare nella ricerca sostituirebbe altrimenti la tabella con «Caricamento…»
  a ogni tasto: tenere i dati precedenti finché non arrivano i nuovi è ciò che
  distingue un filtro da un lampeggio.
- **La ricerca è ritardata di 300 ms**, così una parola di otto lettere è una
  richiesta invece di otto.
- **I parametri ai valori di default non finiscono nella query string.** Non è
  estetica dell'URL: `?page=1&archived=exclude` e la stringa vuota sono due
  chiavi di cache diverse per la stessa identica lista, e senza questa
  normalizzazione la prima schermata verrebbe scaricata due volte.
- **Il form tiene tutti i campi come stringhe, anche quelli opzionali**, e
  converte solo al momento dell'invio. Un `input` controllato con `value={null}`
  passa a non controllato e React lo segnala a runtime; e la stringa vuota è
  proprio ciò che serve per svuotare un campo, dato che la `PUT` sostituisce
  tutto.
- **Il dialogo del form ha `key={editing?.id ?? 'nuovo'}`.** Lo stato iniziale si
  calcola una volta sola con `useState(() => ...)`: senza la chiave, aprire la
  modifica di un secondo cliente riproporrebbe i valori del primo.
- **La conferma di cancellazione non si chiude al click.** L'azione di Radix
  chiude di suo; `preventDefault()` la trattiene, così «Elimino…» resta visibile
  finché l'API non risponde e un rifiuto non costringe a riaprire la finestra per
  leggerne il motivo.
- **`aria-describedby` sta sul controllo, non sul contenitore.** Il primo
  tentativo era un involucro che avvolgeva `<Input>`: l'attributo finiva su un
  `div` e nessun lettore di schermo lo avrebbe mai letto. `TextField` genera da sé
  il proprio controllo, che è l'unico modo per garantire che `id`, descrizione ed
  errore restino collegati.
- **`end` solo sulla voce di menù della radice.** Ogni percorso comincia con `/`,
  quindi senza `end` le tre voci risulterebbero attive tutte insieme e il menù
  smetterebbe di dire dove si è. È verificato contando le occorrenze di
  `aria-current="page"` nel markup.
- **I collegamenti a siti e pannelli dei fornitori hanno
  `rel="noopener noreferrer"`.** `noopener` impedisce alla pagina aperta di
  manovrare la scheda che l'ha aperta, `noreferrer` di sapere da dove arriva. Che
  lo schema sia `http` o `https` — e non `javascript:` — è invece garantito a
  monte dallo schema condiviso, che è la ragione per cui l'`href` si costruisce
  senza altri controlli.
- **Le impostazioni sono una rotta annidata con menù a sinistra**, non delle
  schede in cima. `/impostazioni` da sola reindirizza a `/impostazioni/categorie`
  con `replace`, così il tasto «indietro» non rimbalza fra le due. Il menù è una
  colonna perché l'elenco crescerà — la Fase 6 porta qui il regime fiscale — e
  delle schede che vanno a capo sono peggio di una colonna. La voce nella barra
  principale non ha `end`, ed è proprio quello che la tiene evidenziata su
  entrambe le sottopagine.
- **La corrispondenza nome→icona è scritta a mano.** `lucide-react` esporta oltre
  milleseicento componenti: un `import * as icons` per risolvere venti nomi a
  runtime porterebbe l'intera libreria nel bundle, perché nessun bundler può
  sapere quali servono. Un `Record<CategoryIcon, LucideIcon>` con venti import
  nominali costa quello che usa, e se domani si aggiunge un nome alla lista
  condivisa il tipo non compila finché la mappa non lo copre. Il conto torna: la
  build passa da ~560 kB a 587 kB per venti icone, due pagine, due finestre e un
  layout.
- **Il pulsante «elimina» resta attivo anche sulle categorie predefinite.** Un
  pulsante disattivato non risponde alla domanda «perché no?»; la finestra sì.
  `DeleteResourceDialog` ha quindi tre stati invece di due — predefinita, in uso,
  eliminabile — e la prima spiega che la voce verrebbe ricreata al riavvio, cosa
  che non ha niente a che vedere con lo storico collegato.
- **`documentCount` nel dialogo è facoltativo, non zero.** Nessun documento punta
  a un metodo di pagamento: passare uno zero costante direbbe «nessun documento
  collegato» dove la risposta giusta è «i documenti qui non c'entrano», e la
  frase generata cambierebbe di conseguenza.
- **Il colore della categoria è un pallino accanto al nome**, non lo sfondo della
  riga. Undici righe colorate sono una tabella illeggibile; undici pallini sono
  undici categorie che si distinguono con la coda dell'occhio.
- **La scadenza di una carta diventa rossa dal mese _dopo_.** Il confine è
  `Date.UTC(anno, mese, 1)` — con `mese` non decrementato — perché una carta
  03/2027 funziona per tutto marzo, e segnarla in rosso il primo del mese sarebbe
  un allarme con trenta giorni d'anticipo.
- **Il form dei metodi di pagamento è tipizzato con `z.input`, non con un cast.**
  È l'unica entità in cui il tipo d'ingresso e quello d'uscita divergono:
  `expiryMonth` esce numero ma entra come la stringa che una casella produce.
  `as unknown as PaymentMethodInput` avrebbe zittito il compilatore dicendogli una
  cosa falsa; `z.input<typeof paymentMethodInputSchema>` gli dice quella vera, e
  continuerebbe a funzionare se un domani un campo cambiasse forma. Che il tipo
  non sia degenerato in `any` è stato verificato: rifiuta `label: 42` e
  `type: 'CHEQUE'`, accetta `expiryMonth: '03'`.
- **Spese e scadenze hanno un livello dati proprio** (`lib/expenses.ts`), non
  `lib/resources.ts` allargato. Le due ragioni sono tecniche. La prima: **le
  invalidazioni sono incrociate**. Scrivere una spesa fa girare `syncOccurrences`
  sul server, e una `PATCH` su un'occorrenza cambia `nextDueDate` e
  `occurrenceCount` della spesa: ogni mutazione deve rileggere **due** radici,
  mentre `useResourceMutations` ne invalida una per costruzione — ed è giusto
  così, un cliente salvato non tocca nient'altro. La seconda: **manca un verbo**.
  Le occorrenze non si creano e non si cancellano, hanno solo `PATCH`, e
  aggiungerlo al modulo condiviso darebbe alle quattro anagrafiche un metodo che
  il loro server non espone. Di davvero comune resta `queryString`, che infatti
  non nomina nessun campo.
- **La sentinella dei filtri è `'all'`, non la stringa vuota.** Radix riserva
  `value=""` per «nessuna scelta» e **rifiuta a runtime** un `SelectItem` che la
  usi. Per lo stesso motivo la tendina delle relazioni usa `'none'`.
- **Il client valida solo ciò che il server non può vedere.** Cioè una cosa sola:
  che una casella numerica contenga un numero. Il server riceve `netCents: null`
  e non sa se la casella era vuota — legittimo, l'imponibile si può omettere se
  c'è il totale — o se conteneva «dodici e cinquanta». Tutte le regole incrociate
  restano nel `superRefine` di `expenseInputSchema` e tornano indietro già
  indirizzate al campo giusto: duplicarle nel client vorrebbe dire due copie che
  divergono, e la copia sbagliata sarebbe quella che l'utente vede per prima.
- **Le regole incrociate si vedono come assenza di caselle.** `ONE_OFF` nasconde
  intervallo, data di fine e preavviso; `rebillMode === 'NONE'` nasconde ricarico
  e forfait. Non è validare, è non proporre: una casella che il server
  rifiuterebbe comunque è un invito a sbagliare.
- **L'oggetto da inviare si costruisce campo per campo, mai con uno spread dallo
  stato.** `JSON.stringify` elimina le chiavi `undefined`, quindi un campo non
  raccolto semplicemente non esiste nel corpo e lo `strictObject` del server è
  contento; uno spread ci farebbe invece finire dentro tutto lo stato del form,
  comprese le stringhe grezze delle caselle. È la stessa ragione per cui `toData`
  sul server è scritto a mano.
- **Un giorno di calendario si formatta sulla stringa, senza passare da `Date`.**
  `new Date('2027-03-15')` è mezzanotte UTC, e a ovest di Greenwich
  `toLocaleDateString('it-IT')` stampa il **14**. `formatInstant` parte invece da
  un `Date` vero, perché `paidAt` _è_ un istante e mostrarlo nel fuso di chi
  guarda è la cosa giusta. Per lo stesso motivo `todayIso` usa i getter locali:
  con quelli UTC una scadenza dovuta oggi risulterebbe futura per mezz'ora ogni
  notte.
- **Percentuali e importi condividono la conversione.** `22,5%` → `2250` basis
  point è la stessa trasformazione di `22,50 €` → `2250` centesimi, e
  `parsePercent` chiama `parseEuro`. Riscriverla vorrebbe dire due idee di cosa
  sia `1.234` — milleduecentotrentaquattro in Italia, uno virgola due tre quattro
  in inglese.
- **La `PATCH` di un'occorrenza manda solo i campi cambiati.** Il server tratta un
  campo assente come «lascialo com'è», e quando arrivano insieme netto e lordo li
  tiene entrambi senza ricalcolare — giustamente, perché una fattura che
  arrotonda l'IVA riga per riga ha ragione lei. Rispedire sempre la coppia, che è
  quello che verrebbe naturale costruendo il corpo dallo stato, farebbe sì che
  **correggere la sola aliquota non abbia alcun effetto visibile**.
- **«Segna pagata» conferma nello stesso gesto** (`{status:'PAID',
confirmed:true}`). Chi preme _sta guardando_, e `confirmedAt` nullo è
  precisamente lo stato che lascia il cron quando nessuno ha guardato: lasciarla
  da confermare chiederebbe due click per un'unica constatazione.
- **«Da confermare» è una voce della tendina degli stati, non una casella
  accanto.** Sul server `unconfirmed` sovrascrive `status`, quindi due controlli
  indipendenti lascerebbero comporre «Prevista + solo da confermare» e
  restituirebbero delle pagate. Come quinta scelta della stessa tendina la
  combinazione impossibile non si può nemmeno esprimere.
- **Le spese hanno un dialogo di cancellazione proprio.** `DELETE /expenses/:id`
  conta le occorrenze con `status: { not: 'PLANNED' }`, mentre
  `Expense.occurrenceCount` è il totale: dalla riga dell'elenco **non si può
  sapere in anticipo** se la cancellazione passerà, e `DeleteResourceDialog` è
  costruito tutto sul «lo so già dai conteggi». Il dialogo delle spese ha quindi
  due stati — prima del tentativo e dopo il rifiuto — e il secondo è l'unico
  posto in cui compare la via d'uscita vera: sospendere invece di cancellare.
- **`/spese` non ha `end`**, così resta evidenziata anche sul dettaglio di una
  spesa: da lì non si è usciti dalla sezione, ci si è entrati dentro. È l'inverso
  della regola della radice.
- **Un dettaglio inesistente non reindirizza.** Il rimbalzo sull'elenco farebbe
  sparire l'indirizzo sbagliato dalla barra prima che qualcuno possa leggerlo, e
  chi è arrivato da un segnalibro vecchio si ritroverebbe altrove senza sapere
  perché. La frase resta e il collegamento lo porta via lui. La query non
  ritenta: un identificativo inesistente resterà inesistente al terzo tentativo.
- **Il modulo della spesa non ha un test di rendering.** Il contenuto di un
  `Dialog` Radix vive in un portale, e in SSR un portale non produce markup: il
  test passerebbe verificando il vuoto. Si prova `toInput`, cioè la conversione
  da sette caselle di testo al corpo della richiesta, che è dove si sbaglia
  davvero — e la si prova **contro `expenseInputSchema`**, non contro una copia
  delle sue regole.
- **I test delle pagine riempiono la cache prima di disegnare.** Senza righe
  queste pagine mostrano tre parole e «Caricamento…», e un test che le trova
  avrebbe verificato l'intestazione di una tabella vuota. Con
  `queryClient.setQueryData` si prova ciò che conta: che le etichette vengano
  dalle costanti condivise e non da una copia locale, che «Da confermare»
  compaia sulle pagate mai verificate, che il dettaglio legga `useParams` —
  ed è per questo che va montato dentro `<Route path="/spese/:id">`, altrimenti
  `useParams` restituisce un oggetto vuoto e il test prova un caso che
  dall'applicazione non si raggiunge.

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
- **Il cron era previsto come secondo servizio Railway; è finito dentro l'API.**
  L'idea era la stessa immagine con uno start command diverso, per avere log
  separati da quelli delle richieste HTTP. Non regge il confronto con il costo:
  un container acceso ventiquattr'ore per lavorare due minuti al giorno
  raddoppia la spesa e la superficie da tenere aggiornata, per
  un'applicazione con un utente. E l'argomento a favore — i log distinti — si
  ottiene con `app.log.child({ job })`, che li marca tutti senza un secondo
  processo. La scelta ha una condizione, ed è l'unica che la invaliderebbe:
  «App Sleeping» dev'essere spento sul servizio `api`, perché un processo
  addormentato alle 07:00 non gira. Con più di una replica servirebbe invece il
  `pg_try_advisory_lock` dichiarato in `runner.ts`.

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
- **La rewrite di Netlify aggiunge un `Content-Type` ai POST che il browser manda
  senza.** È costato un 415 su `/auth/refresh`, cioè una sessione che non si
  sarebbe rinnovata mai. Il dettaglio che lo rende istruttivo: la stessa identica
  richiesta mandata direttamente a Railway rispondeva 401, quindi in sviluppo non
  si vedeva niente. È esattamente il tipo di difetto per cui il deploy è stato
  anticipato alla Fase 0.5. La correzione è un parser che accetta il corpo vuoto
  qualunque tipo dichiari e rifiuta tutto il resto.
- **`JWT_SECRET` è dichiarata in `railway.ts` con `preserve()`**, che afferma che
  la variabile deve esistere senza scriverne il valore. Non è una raffinatezza:
  varrebbe «omit means delete», quindi non nominarla significherebbe che il primo
  `apply` la cancella e l'API non parte più. Il valore vero sta solo nella
  dashboard, impostato via `variable set --stdin` per non farlo comparire fra gli
  argomenti del processo. È diverso da quello di sviluppo.
- **Il seed di produzione si lancia dentro il container**, con
  `railway ssh --service api` seguito da `npm run seed -w @easygest/api`.
  Il container ha il sorgente e le devDependencies
  (`NPM_CONFIG_INCLUDE=dev`), quindi non serve esporre Postgres su internet: il
  servizio non ha un `DATABASE_PUBLIC_URL` e aggiungerne uno solo per il seed
  sarebbe una superficie di attacco permanente in cambio di un comando.
  Prerequisiti scoperti sul campo: serve una chiave SSH locale **registrata**
  presso Railway (`railway ssh keys add`), e su Windows il percorso della chiave
  va passato con i backslash, perché con le barre normali la CLI non la trova.
- **Railway non pubblica il fingerprint della chiave host di `ssh.railway.com`.**
  Al primo collegamento appare una finestra di conferma che blocca ogni comando
  non interattivo. Quello osservato — `SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g`
  — coincide con l'unico riportato in modo indipendente sul forum di Railway, ma
  **nessuno dello staff l'ha mai confermato**, e altri utenti riferiscono
  fingerprint diversi, segno che i server SSH sono più d'uno. È fissato in
  `~/.ssh/known_hosts`: se un giorno ne comparisse un altro, prima di accettarlo
  va verificato, non liquidato come «sarà l'altro server».

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
- **React Router è fermo alla 7.** La 8 dichiara `engines: node >= 22.22.0` e in
  locale gira la 22.18: npm risolve alla 7.18.3 senza dirlo. Il lockfile la
  fissa, quindi CI e locale sono identici; da rivedere aggiornando Node.
- **Un guasto di rete all'avvio manda alla pagina di accesso.** Non potendo
  sapere se una sessione esista, l'app mostra il login; il tentativo fallirà a
  sua volta, ma con un messaggio che spiega che l'API non risponde. Distinguere
  davvero i due casi richiederebbe di ritentare il ripristino, che per ora non
  vale la complessità.
- **Il tema scuro è generato ma non raggiungibile**: mancano l'interruttore e la
  persistenza della scelta. Da fare quando ci sarà una pagina di impostazioni.
- **I test hanno bisogno di un database in esecuzione.** Da quando esistono i test
  di integrazione sull'autenticazione, `npm test` fallisce se Postgres non è su:
  in locale lo avvia `npm run infra:up` e `vitest.setup.ts` legge `apps/api/.env`,
  in CI lo fornisce il servizio `postgres` del workflow. Il setup non usa
  `override`, così le variabili del job in CI vincono sul file.
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
  attraverso il proxy. Non è un problema di autorizzazione — quella la fa il
  token — ma **lo è per il rate limiting sul login**, ed è il debito più concreto
  aperto oggi. Le richieste che arrivano dal proxy hanno tutte l'IP di Netlify:
  il conteggio per IP le tratta come un unico client, quindi cinque tentativi
  falliti da chiunque bloccherebbero il login a tutti. `trustProxy` è già attivo
  in produzione, ma la catena `X-Forwarded-For` passa da Netlify _e_ dal proxy di
  Railway: va verificato sul campo quale IP arriva davvero in `req.ip` prima di
  fidarsi del limite. Con un solo utente reale la conseguenza pratica è nulla,
  ma il limite va provato in produzione, non dedotto.
- **Il contatore del rate limit sta in memoria**, quindi si azzera a ogni riavvio
  del processo — cioè a ogni deploy, e in locale a ogni ricarica di `tsx watch`.
  Per un limite anti-forza-bruta su un'applicazione a un solo utente va bene;
  diventerebbe un problema con più repliche, dove servirebbe un Redis condiviso.
- **Il bundle del frontend è un unico file da 633 kB (186 kB gzip)**, e Vite lo
  segnala. È tutto in una volta perché non c'è ancora nessuno `React.lazy`: le
  candidate naturali sono Recharts (Fase 5) e le pagine dietro il login, che chi
  arriva alla schermata di accesso non deve scaricare. Da affrontare quando
  entrerà la prima libreria pesante, non prima: dividere adesso sposterebbe
  soltanto il peso. Le pagine delle impostazioni erano costate 26 kB in tutto,
  icone comprese; le tre delle spese altri 46: la crescita resta proporzionata a
  ciò che si aggiunge.
- **`testTimeout` e `hookTimeout` di Vitest sono alzati a 20 s.** Il primo
  sintomo è stato un test del frontend che passava da solo e scadeva a 5 s
  insieme agli altri: fa `vi.resetModules()` e reimporta l'intero grafo di React,
  e con tredici worker che si contendono la macchina non è più un'operazione
  istantanea. I due limiti sono separati — 5 s e 10 s di default — e infatti dopo
  aver alzato il primo la suite ha ricominciato a fallire nell'`afterAll` che
  ripulisce il database. Non è nascondere un problema: il limite predefinito
  misura la contesa fra worker, non la correttezza.
- **`useResourceMutations` non fa aggiornamento ottimistico.** Archiviare un
  record aspetta la risposta prima di aggiornare la tabella. Con una lista
  paginata e filtrata l'ottimismo richiederebbe di riscrivere a mano cache che
  potrebbero non contenere più quel record; da valutare se la latenza reale
  diventa fastidiosa.
- **L'ordine delle categorie non si può cambiare dall'interfaccia.** Il campo
  `sortOrder` esiste, il server lo assegna e la lista lo rispetta, ma non c'è
  modo di trascinare una riga: riordinare richiede una `PATCH` dedicata che
  riscriva più righe in una transazione, e con undici voci predefinite il
  problema non si pone ancora. Da fare quando le categorie saranno tante
  abbastanza da rendere l'ordine alfabetico insufficiente.
- **`sortOrder` ha una corsa benigna.** Il server legge il massimo e ci somma
  uno: due creazioni simultanee otterrebbero lo stesso numero. La conseguenza è
  due categorie affiancate in ordine arbitrario, non un errore, e per un'app a
  un solo utente non vale una transazione serializzabile.
- **La finestra di modifica non avvisa se si chiude con modifiche non salvate.**
  Vale per tutte e quattro le anagrafiche, non solo per le nuove pagine: un clic
  fuori dal riquadro perde quel che si stava scrivendo. Da risolvere una volta
  per tutte nel componente condiviso, non finestra per finestra.
- **I test delle pagine sono prove di accensione, non di comportamento.**
  `renderToString` verifica che l'albero si costruisca e che certe frasi ci
  siano; non clicca niente. Serve a intercettare le rotture strutturali — una
  voce mancante nella mappa delle icone, per esempio, che non si vedrebbe fino
  al primo rendering di una categoria che la usa — ma non sostituisce dei test
  d'interazione, che arriveranno se e quando la logica del client crescerà.
- ~~**Le occorrenze si materializzano solo quando la spesa viene toccata.**~~
  Chiuso dalla Fase 4: lo sweep del giro giornaliero rilancia `syncOccurrences`
  su tutte le spese attive, con un `try/catch` per singola spesa. Resta vero che
  senza il cron acceso l'orizzonte non si estende da sé, ed è il motivo per cui
  `CRON_ENABLED` in produzione è dichiarata in `railway.ts` invece di essere
  lasciata al default.
- **Lo storico anteriore all'inserimento va importato a mano.** Il motore non lo
  genera di proposito; oggi lo scrive solo `seed:demo`, per i dati finti.
  Registrare una spesa che esiste da anni e volerne il passato richiede un
  importatore che non c'è.
- **Il tasso di cambio non è correggibile a mano.** Le scelte di dominio lo
  prevedono («override manuale»), ma la `PATCH` di un'occorrenza accetta gli
  importi e non `fxRate`: chi paga a un cambio diverso da quello BCE — una carta
  con commissione, per esempio — può solo correggere il totale convertito. Da
  fare quando servirà davvero.
- **`seed:demo` scrive lo storico con il cambio di oggi.** Le occorrenze passate
  dei dati dimostrativi usano tutte lo stesso tasso invece di quello del loro
  giorno: è una semplificazione voluta — richiederebbe un anno di tassi veri per
  tre valute — ma rende i report storici in valuta dei dati finti meno
  realistici del resto.
- **Due funzioni per due forme dello stesso `RESOURCE_IN_USE`.** `inUseDetails`
  legge i due conteggi delle anagrafiche, `occurrencesInUse` l'unico delle spese.
  Il codice d'errore è lo stesso, i dettagli no. Una funzione sola restituirebbe
  un tipo su cui chi chiama dovrebbe comunque fare una domanda in più; se un
  terzo modello arrivasse con una terza forma, converrebbe invece un
  discriminante dentro `details`.
- **I filtri non stanno nell'indirizzo.** Vale per tutte le liste: una vista
  costruita a fatica — stato, fornitore, finestra di scadenza — non si può
  mandare a nessuno né ritrovare col tasto «indietro». Da fare per tutti gli
  elenchi insieme, altrimenti si finisce con due modi diversi di leggere la barra
  degli indirizzi.
- **Il totale di `/scadenze` è quello della pagina, non del filtro.** Il client ha
  in mano venti righe su duecento: sommare tutto richiederebbe un endpoint che lo
  faccia. Per ora la pagina lo dichiara («In questa pagina: …»), perché un numero
  senza la riserva sembrerebbe il conto del mese.
- **Le azioni sulle occorrenze non sono ottimistiche.** «Segna pagata» aspetta la
  risposta, e ogni mutazione invalida due radici: su una tabella lunga si vede.
  Stessa ragione di `useResourceMutations` — con liste paginate e filtrate
  l'ottimismo richiederebbe di riscrivere a mano cache che potrebbero non
  contenere più quella riga.
- **`documentId` non è raggiungibile dall'interfaccia.** La `PATCH` di
  un'occorrenza lo accetta, ma non c'è nulla da collegare finché la Fase 7 non
  porta l'archivio documenti. Il campo resta scoperto dai test del client.
- **Il bundle va rimisurato a ogni fase.** Le tre pagine delle spese l'hanno
  portato da 587 a 633 kB (186 kB gzip); la campanella, il popover e la pagina
  degli avvisi da 633 a **655 kB (191 kB gzip)**, misurati, contro i ~660
  stimati. La crescita resta proporzionata, ma oltre i 700 kB conviene
  anticipare il primo `React.lazy` invece di aspettare Recharts.
- **Un'email fallita non viene mai ritentata.** La riga `ReminderLog` resta con
  `succeeded = false` e il giro successivo la salta, perché la chiave esiste già.
  È voluto — è la scelta che garantisce «al massimo una volta» — ma significa che
  per riprovare bisogna cancellare quella riga a mano in `psql`. Un secondo
  tentativo automatico richiederebbe di distinguere gli errori temporanei da
  quelli permanenti, e sbagliando quella distinzione si rimanda tutto.
- **Le scadute senza rinnovo automatico non ricevono nessun avviso.** Lo sweep
  non le tocca — giustamente, perché non sono state pagate — ma nemmeno i
  promemoria le nominano, dato che quelli guardano avanti e non indietro.
  Compaiono solo nella sezione «in ritardo» del riepilogo settimanale, cioè fino
  a sei giorni dopo. Un avviso «scaduta e non pagata» il giorno stesso sarebbe la
  cosa giusta, e va disegnato con la sua regola di ripetizione, perché una spesa
  arretrata per due mesi non deve produrre sessanta email.
- **`DOCUMENT_DUE` è un genere senza produttore.** L'enum lo prevede, il motore
  non lo emette: servirà alla Fase 7, quando esisteranno documenti con una
  scadenza. Finché non c'è, resta un valore che comparirebbe solo se qualcuno
  scrivesse a mano una riga in tabella.
- **Le notifiche non si cancellano dall'interfaccia.** Si possono solo segnare
  lette, singolarmente o tutte. Le lette spariscono da sole dopo
  `NOTIFICATION_RETENTION_DAYS` (180); le non lette non si potano mai, perché
  sono cose che l'utente non ha ancora visto e cancellarle sarebbe decidere al
  posto suo.
- **`GET /notifications` filtra solo per «non lette».** Non c'è modo di chiedere
  «solo le carte in scadenza» o «solo le disdette»: il genere è in tabella e
  l'indice c'è, manca il parametro. Con una decina di notifiche al mese il
  problema non si pone.
- **Il badge può restare vecchio fino a un minuto.** È un `refetchInterval`, non
  un push: niente SSE né WebSocket per un numero che cambia una volta al giorno.
  `refetchOnWindowFocus` copre il caso vero — si torna sulla scheda la mattina e
  il numero è già giusto.
- **Il single-flight dei lavori sta in memoria.** `runner.ts` tiene una
  `Map<JobName, Promise>` e chi arriva secondo riceve il risultato del primo
  invece di un errore; insieme a `protect: true` di croner basta per un processo
  solo. Con più repliche servirebbe il `pg_try_advisory_lock`, che è dichiarato
  nel commento ma non implementato: due processi che partono insieme alle 07:00
  manderebbero le email una volta sola comunque, grazie ai vincoli di unicità,
  ma sprecherebbero un giro intero di query e potrebbero prendersi un deadlock
  sullo sweep.
- **Resend scrive solo al titolare dell'account.** Il mittente è il dominio
  condiviso `onboarding@resend.dev`, che funziona senza toccare i DNS ma ha due
  conseguenze: un secondo destinatario non riceverebbe niente, e le prime email
  finiscono facilmente nella posta indesiderata, perché il dominio è condiviso e
  senza DKIM proprio. Si risolve verificando un dominio, che richiede di
  possederne uno.
- **Lo scheduler non è coperto da test.** Si prova la pipeline che chiama, non la
  pianificazione: quella è responsabilità di croner, e provarla significherebbe
  o aspettare le 07:00 o simulare l'orologio, che è esattamente ciò che tutto il
  resto della fase è stato scritto per non dover fare.
- **Un test di integrazione è fallito una volta su cinque esecuzioni** e non è
  stato possibile identificarlo: l'output era già stato troncato. Le tre
  esecuzioni successive sono state verdi. Se ricapita va catturato l'output
  intero (`npm test > file 2>&1`) prima di guardarlo: il sospetto è la contesa
  fra worker sullo stesso database, che è la stessa causa per cui `testTimeout`
  è stato alzato a 20 s.
