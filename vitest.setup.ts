import { config } from 'dotenv';

/**
 * Rende disponibile `apps/api/.env` ai test che parlano con il database.
 *
 * L'API in sviluppo carica il file da sé (`tsx --env-file-if-exists`), ma
 * Vitest no: senza questo, i test di integrazione fallirebbero in locale e
 * passerebbero in CI, dove `DATABASE_URL` arriva dalle variabili del job.
 *
 * `override` resta al valore predefinito, cioè falso: una variabile già
 * presente nell'ambiente vince sul file. È ciò che permette alla CI — e a un
 * eventuale database di prova indicato a mano — di avere la precedenza.
 */
config({ path: 'apps/api/.env', quiet: true });
