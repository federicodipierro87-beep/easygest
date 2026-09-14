import { isValidTimeZone } from '@easygest/shared';
import { z } from 'zod';

import type { MailTransport } from '../mail/types';

/**
 * Configurazione dell'API.
 *
 * L'unico punto in cui si legge `process.env`. Il processo non parte se
 * manca o è malformata una variabile: meglio un crash immediato e leggibile
 * al deploy che un `undefined` che si manifesta in produzione tre giorni dopo.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  /**
   * Connessione a PostgreSQL. Volutamente senza default: un valore di comodo
   * qui significherebbe puntare in silenzio al database sbagliato invece di
   * fermarsi e dirlo.
   */
  DATABASE_URL: z.string().min(1),

  /** Connessioni massime nel pool, per processo. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Origini ammesse dal browser, separate da virgola. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(z.url()).min(1)),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().min(1).default('1 minute'),

  /**
   * Chiave di firma degli access token, HMAC-SHA256.
   *
   * Senza default, come `DATABASE_URL` e per la stessa ragione: un valore di
   * comodo qui significherebbe firmare in produzione con una chiave scritta su
   * GitHub, cioè permettere a chiunque di fabbricarsi un token valido.
   * Il minimo di 32 caratteri corrisponde ai 256 bit dell'algoritmo: una chiave
   * più corta non renderebbe HS256 più debole in modo evidente, ma non c'è
   * nessuna ragione per accettarla.
   */
  JWT_SECRET: z.string().min(32, 'deve essere lunga almeno 32 caratteri'),

  /**
   * Durata dell'access token, in secondi.
   *
   * Breve di proposito: un access token non è revocabile, quindi la finestra in
   * cui uno rubato resta utile è esattamente questa. Il costo di accorciarla è
   * solo qualche chiamata a `/auth/refresh` in più.
   */
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900), // 15 minuti

  /**
   * Durata del refresh token, in secondi. È il tempo dopo cui va rifatto il
   * login se non si usa l'applicazione.
   */
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(2_592_000), // 30 giorni

  /**
   * Apre o chiude `/auth/register`.
   *
   * Il default è `false`: l'applicazione è a uso personale, e un endpoint di
   * registrazione aperto per distrazione è il modo più semplice per ritrovarsi
   * account altrui nel proprio gestionale.
   */
  REGISTRATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Accende il giro notturno.
   *
   * Il default è `false` — e in locale va lasciato lì — perché a differenza di
   * tutto il resto della configurazione questo giro **scrive**: marca `PAID` le
   * scadenze arretrate, crea notifiche, manda email. Un cron acceso per
   * distrazione su una copia del database di produzione farebbe danni veri e
   * silenziosi.
   */
  CRON_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /**
   * Fuso in cui si interpretano gli orari del cron.
   *
   * Non è `Settings.timezone`, e le due cose vanno tenute distinte: questa
   * decide *a che ora arriva l'email*, quella decide *quale giorno è* per i
   * conti. Ogni utente viene elaborato con il proprio `occurrenceContext`,
   * quindi se divergessero l'unico effetto sarebbe un'email a un'ora strana,
   * mai una scadenza contata nel giorno sbagliato.
   */
  CRON_TIMEZONE: z
    .string()
    .min(1)
    .default('Europe/Rome')
    .refine(isValidTimeZone, 'fuso orario sconosciuto'),

  /**
   * Quanto si aspetta, dall'avvio, prima del giro di recupero.
   *
   * A ogni avvio si rifà il giro giornaliero: la pipeline è idempotente per
   * costruzione, quindi tre deploy in un pomeriggio producono tre giri e zero
   * effetti, e in cambio un rilascio alle 07:05 non salta la giornata. I venti
   * secondi servono a non far competere il primo giro con l'healthcheck
   * `/ready`, che è ciò che decide se promuovere la release.
   */
  CRON_CATCHUP_DELAY_MS: z.coerce.number().int().min(0).max(600_000).default(20_000),

  /**
   * Come partono le email.
   *
   * Facoltativa: se manca, il trasporto lo deduce `resolveMailTransport` qui
   * sotto a partire da `NODE_ENV`. Darle un default nello schema sarebbe la
   * stessa regola scritta due volte, e la seconda finirebbe per divergere.
   */
  MAIL_TRANSPORT: z.enum(['resend', 'log', 'memory']).optional(),

  /**
   * Chiave di Resend. Obbligatoria quando il trasporto **risolto** è `resend`,
   * che non è la stessa cosa che averlo scritto in `MAIL_TRANSPORT`: vedi il
   * `superRefine` in fondo allo schema.
   */
  RESEND_API_KEY: z.string().min(1).optional(),

  /**
   * Mittente delle email.
   *
   * Il default è `easysolution-dp.com`, dominio verificato su Resend e quindi
   * firmato DKIM. Prima era il dominio condiviso `onboarding@resend.dev`, che
   * non richiede DNS ma ha due difetti scoperti provandolo: scrive **solo** al
   * titolare dell'account — un secondo destinatario non riceve niente, e la
   * cosa non si vede finché l'unico utente è il titolare — e senza firma
   * propria finisce facilmente in posta indesiderata. Per un promemoria è un
   * guaio silenzioso: non viene ritentato, e la sua chiave di deduplica resta
   * bruciata comunque.
   *
   * Entrambi i mittenti sono stati provati e consegnati; si tiene quello che
   * non ha il limite. Resta comunque dichiarato in `railway.ts`, perché il
   * default serve allo sviluppo e la produzione non deve dipendere da lui.
   */
  MAIL_FROM: z.string().min(1).default('EasyGest <no-reply@easysolution-dp.com>'),

  /** Radice dei link dentro le email. Punta al frontend, non a questa API. */
  APP_BASE_URL: z.url().default('http://localhost:5173'),

  /**
   * Dopo quanti giorni si potano le notifiche **lette**.
   *
   * Solo quelle: una non letta è una cosa che l'utente non ha ancora visto, e
   * cancellarla significherebbe decidere al posto suo. I `ReminderLog` non si
   * potano mai, perché sono la memoria della deduplica: buttarli rimanderebbe
   * email già inviate.
   */
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
});

/**
 * Quale trasporto, se nessuno lo impone.
 *
 * Sta qui, nella configurazione, e non accanto al mailer, per una ragione
 * imparata sul campo: la regola serve a **due** lettori, `createMailer` e la
 * validazione qui sotto, e finché ne conosceva uno solo la validazione
 * guardava la variabile grezza. In produzione, dove `MAIL_TRANSPORT` non era
 * impostata e il trasporto veniva dedotto da `NODE_ENV`, il controllo non
 * scattava: il processo partiva con un mailer Resend senza chiave e lo
 * scopriva al primo invio — cioè troppo tardi, perché un promemoria fallito
 * non viene mai ritentato.
 */
export function resolveMailTransport(env: Env): MailTransport {
  if (env.MAIL_TRANSPORT !== undefined) return env.MAIL_TRANSPORT;
  if (env.NODE_ENV === 'production') return 'resend';
  if (env.NODE_ENV === 'test') return 'memory';
  return 'log';
}

const envSchemaWithRules = envSchema.superRefine((value, ctx) => {
  // Il controllo sta qui e non in `RESEND_API_KEY` perché dipende da altri due
  // campi. Fallire all'avvio è il punto: senza, l'applicazione parte, lavora
  // tutto il giorno e scopre di non poter mandare niente alle sette del
  // mattino, quando nessuno legge i log.
  //
  // Si guarda il trasporto **risolto** e non `value.MAIL_TRANSPORT`: sono la
  // stessa cosa solo quando la variabile è impostata, ed è proprio il caso in
  // cui non lo è — la produzione — quello in cui sbagliare costa.
  if (resolveMailTransport(value) === 'resend' && value.RESEND_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['RESEND_API_KEY'],
      message: 'obbligatoria quando le email partono da Resend',
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configurazione non valida:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchemaWithRules.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => {
        const path = issue.path.join('.') || '(root)';
        return `${path}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}

export const isProduction = (env: Env): boolean => env.NODE_ENV === 'production';
