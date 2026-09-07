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

export default defineRailway(() => {
  const Postgres = postgres('Postgres', { region: REGION });
  Postgres.networking = { privateNetworkEndpoint: 'postgres' };

  const postgresVolume = volume('postgres-volume', {
    alerts: { usage: { '80': {}, '95': {}, '100': {} } },
    allowOnlineResize: true,
    region: REGION,
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
      // `--include=dev` è obbligatorio: NODE_ENV vale `production` e senza il
      // flag npm salterebbe le devDependencies, cioè tsup e TypeScript, e la
      // build fallirebbe. La build parte dalla radice perché le dipendenze
      // sono gestite da npm workspaces.
      buildCommand: 'npm ci --include=dev && npm run build -w @easygest/api',
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

    start: 'node apps/api/dist/index.js',

    // `/health` non interroga il database: se Postgres ha un singhiozzo,
    // Railway non deve riavviare in loop anche l'API.
    healthcheck: '/health',
    healthcheckTimeout: 60,

    replicas: { [REGION]: 1 },

    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
    },

    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
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
