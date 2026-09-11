import { type Settings, settingsPatchSchema } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import type { Prisma } from '../generated/prisma/client';
import { parseBody } from '../lib/validation';
import { requireUser } from '../plugins/auth';

/**
 * Le preferenze dell'utente.
 *
 * Due rotte asimmetriche di proposito: `GET` restituisce tutta la riga, perché
 * alla Fase 6 servirà il blocco fiscale intero per calcolare le imposte e
 * aggiungerlo dopo vorrebbe dire cambiare la forma di una risposta già usata;
 * `PATCH` accetta solo i campi degli avvisi, che sono gli unici che questa fase
 * sa salvare senza rompere qualcosa a valle.
 *
 * `baseCurrency` è in lettura e non in scrittura, ed è la sola esclusione che
 * vale la pena di spiegare: il cambio viene congelato su ogni occorrenza nel
 * momento in cui matura, quindi i `baseGrossCents` già scritti sono espressi
 * nella valuta di allora. Cambiarla a metà strada non riconvertirebbe lo
 * storico, lo renderebbe incomparabile — e nessun errore lo segnalerebbe.
 */

const SELECT = {
  taxRegime: true,
  substituteTaxRateBp: true,
  profitabilityCoefficientBp: true,
  inpsRateBp: true,
  defaultVatRateBp: true,
  baseCurrency: true,
  timezone: true,
  reminderDaysBefore: true,
  cancellationReminderDaysBefore: true,
  digestEnabled: true,
  digestDayOfWeek: true,
  updatedAt: true,
} satisfies Prisma.SettingsSelect;

type SettingsRow = Prisma.SettingsGetPayload<{ select: typeof SELECT }>;

function toSettings(row: SettingsRow): Settings {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  /**
   * `upsert` e non `findUnique`, anche in lettura.
   *
   * La riga la crea il seed insieme all'utente, ma un utente arrivato per
   * altra via — un'importazione, una registrazione futura fatta a metà — si
   * ritroverebbe un 500 a ogni apertura della pagina delle impostazioni, cioè
   * proprio dove si va a sistemare le cose. I default sono quelli dello schema.
   */
  app.get('/settings', guarded, async (request, reply) => {
    const user = requireUser(request);
    const row = await app.prisma.settings.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: SELECT,
    });
    return reply.send(toSettings(row));
  });

  /**
   * Salva ciò che è arrivato e restituisce ciò che è rimasto scritto.
   *
   * La risposta è la riga intera e non il solo patch, perché gli anticipi
   * escono **normalizzati**: chi scrive `7, 30, 7` deve rileggere `30, 7`, e
   * senza la riga di ritorno il form continuerebbe a mostrare ciò che l'utente
   * ha digitato invece di ciò che è stato salvato.
   */
  app.patch('/settings', guarded, async (request, reply) => {
    const user = requireUser(request);
    const patch = parseBody(settingsPatchSchema, request.body);

    const row = await app.prisma.settings.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...patch },
      update: patch,
      select: SELECT,
    });
    return reply.send(toSettings(row));
  });
}
