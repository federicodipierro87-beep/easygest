/**
 * Infrastruttura Railway come codice.
 *
 * Questo file è la fonte di verità del progetto: `railway config apply`
 * confronta lo stato reale con quanto dichiarato qui e allinea il primo al
 * secondo. Vale la regola **omit means delete**: una risorsa cancellata da
 * questo file viene cancellata su Railway. Prima di applicare, `railway config
 * plan` mostra il diff e le operazioni distruttive richiedono conferma
 * esplicita.
 *
 * Sostituisce `railway.json`, che Railway ha deprecato e non accetta più per i
 * servizi nuovi.
 *
 * Fuori da questo file, perché non esprimibile in IaC: il dominio pubblico
 * generato `*.up.railway.app`, creato via API.
 */
import { defineRailway, github, postgres, project, service, volume } from 'railway/iac';

/**
 * Amsterdam invece del default us-west2: l'utente e i suoi dati stanno in
 * Italia. Sono ~150 ms di latenza in meno per richiesta, ma soprattutto sono
 * documenti fiscali che restano nell'Unione Europea.
 */
const REGION = 'europe-west4';

/**
 * I volumi vivono in una zona specifica, non nella regione generica. Railway
 * normalizza `europe-west4` in `europe-west4-drams3a`: scrivere qui la regione
 * generica farebbe vedere a ogni `plan` una differenza inesistente, e ogni
 * `apply` ricreerebbe il volume — cioè cancellerebbe il database.
 */
const VOLUME_REGION = 'europe-west4-drams3a';

export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: REGION });
  Postgres.networking = { privateNetworkEndpoint: 'postgres' };

  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '80': {}, '95': {}, '100': {} } },
    allowOnlineResize: true,
    region: VOLUME_REGION,
    sizeMB: 5000,
  });

  const api = service('api', {
    source: github('federicodipierro87-beep/easygest', {
      branch: 'main',
      // Railway aspetta l'esito di GitHub Actions prima di costruire: se lint,
      // typecheck o test falliscono, quel commit non arriva in produzione.
      checkSuites: true,
    }),

    build: {
      builder: 'RAILPACK',
      // Solo la build: le dipendenze le ha già installate Railpack nella sua
      // fase di install. Un `npm ci` qui cancellerebbe `node_modules` mentre
      // le cache di build sono montate lì dentro, e fallisce con EBUSY.
      // La build parte dalla radice perché le dipendenze sono gestite da npm
      // workspaces: installarle da `apps/api` romperebbe `packages/shared`.
      buildCommand: 'npm run build -w @easygest/api',
      // Senza questi pattern ogni modifica al frontend farebbe ricostruire e
      // riavviare anche l'API, per niente.
      watchPatterns: [
        'apps/api/**',
        'packages/shared/**',
        'package.json',
        'package-lock.json',
        '.nvmrc',
        '.railway/**',
      ],
    },

    // Le migrazioni girano qui e non nello start command: Railway esegue il
    // preDeploy una volta sola, prima di promuovere la release, e se fallisce
    // annulla il deploy lasciando su il precedente. Nello start command, invece,
    // verrebbero eseguite da ogni replica a ogni riavvio.
    // `migrate deploy` e non `migrate dev`: applica solo le migrazioni già
    // scritte e committate, non ne genera né chiede niente a un terminale.
    preDeploy: 'npm run db:deploy -w @easygest/api',

    start: 'node apps/api/dist/index.js',

    // `/ready` e non `/health`, perché qui la domanda è «questo deploy è in
    // grado di servire?» e non «il processo è vivo?». Railway usa l'healthcheck
    // per decidere se promuovere la nuova release: se `DATABASE_URL` è
    // sbagliata, `/health` risponderebbe 200 lo stesso — non tocca il database —
    // e manderebbe in produzione un'API che fallisce ogni richiesta vera.
    // Fallendo qui, invece, resta in piedi il deploy precedente.
    healthcheck: '/ready',
    healthcheckTimeout: 60,

    replicas: { [REGION]: 1 },

    deploy: {
      // `restartPolicyType` non è dichiarato di proposito. Railway lo applica
      // correttamente (`ON_FAILURE`, che è anche il suo default) ma poi lo
      // rilegge come null, e ogni `plan` mostrerebbe una modifica che non
      // esiste. Un piano che segnala sempre differenze inesistenti abitua a
      // non leggerlo, ed è così che prima o poi si approva una cancellazione.
      restartPolicyMaxRetries: 3,
    },

    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      // Con NODE_ENV=production npm tende a saltare le devDependencies, cioè
      // tsup e TypeScript, che servono proprio a produrre il bundle.
      NPM_CONFIG_INCLUDE: 'dev',
      // Deve contenere l'URL Netlify esatto: il refresh token viaggerà in un
      // cookie e con le credenziali la wildcard `*` è vietata dalla specifica.
      CORS_ORIGINS: 'https://easygest.netlify.app',
      // Riferimento al servizio Postgres: la password non compare mai qui.
      DATABASE_URL: Postgres.env.DATABASE_URL,
    },
  });

  return project('easygest', {
    resources: [Postgres, postgresVolume, api],
  });
});
