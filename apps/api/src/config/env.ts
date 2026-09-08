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
