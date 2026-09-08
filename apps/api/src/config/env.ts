import { z } from 'zod';

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
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configurazione non valida:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
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
