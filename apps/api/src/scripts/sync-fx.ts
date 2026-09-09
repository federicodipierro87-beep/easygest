import { formatIsoDate } from '@easygest/shared';

import { loadEnv } from '../config/env';
import { createPrismaClient } from '../db/client';
import { TRACKED_CURRENCIES, syncFxRates } from '../services/frankfurter';

/**
 * Sincronizza i tassi di cambio, a mano.
 *
 * `npm run fx:sync -w @easygest/api`, oppure con una data:
 * `npm run fx:sync -w @easygest/api -- 2027-03-15`.
 *
 * In Fase 4 la stessa funzione verrà chiamata dal servizio cron a orario. Lo
 * script resta comunque, perché riempire un buco lasciato da qualche giorno di
 * disservizio è un'operazione che si fa a mano e che non vale la pena di
 * inventare quel giorno lì.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const prisma = createPrismaClient(env);

  const requested = process.argv[2];
  const on = requested === undefined ? undefined : new Date(`${requested}T00:00:00Z`);
  if (on !== undefined && Number.isNaN(on.getTime())) {
    throw new Error(`Data non valida: ${requested}. Attesa nella forma 2027-03-15.`);
  }

  try {
    const result = await syncFxRates(prisma, { on, currencies: TRACKED_CURRENCIES });
    console.log(
      `Tassi del ${formatIsoDate(result.date)}: ${String(result.written)} nuovi su ${String(TRACKED_CURRENCIES.length)} valute seguite.`,
    );
    if (result.written === 0) {
      console.log('Nessuna scrittura: erano già tutti presenti.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
