import { type Forecast, forecastQuerySchema, formatIsoDate, todayIn } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';

import { parseQuery } from '../lib/validation';
import { requireUser } from '../plugins/auth';
import { collectForecast } from '../services/forecast';

/**
 * La previsione di un anno.
 *
 * Una rotta sola, e restituisce **le righe**: la piega la fa il browser con
 * `foldForecast`, perché le leve del simulatore lavorano sulla singola spesa e
 * un'API che desse già i totali costringerebbe a un giro di rete a ogni spunta.
 *
 * Niente si scrive in tabella. Le righe oltre l'orizzonte di `syncOccurrences`
 * si calcolano e si buttano: sono la risposta a una domanda, non un fatto da
 * registrare, e persisterle vorrebbe dire avere in tabella delle `PLANNED` che
 * nessun promemoria deve mai guardare.
 */
export function registerForecastRoutes(app: FastifyInstance): void {
  const guarded = { preHandler: app.authenticate };

  app.get('/forecast', guarded, async (request) => {
    const user = requireUser(request);
    const { year } = parseQuery(forecastQuerySchema, request.query);

    // `upsert` per la stessa ragione di `/settings` e `/dashboard`: un utente
    // senza riga di impostazioni troverebbe un 500 invece di una previsione.
    const settings = await app.prisma.settings.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
      select: { baseCurrency: true, timezone: true },
    });

    /**
     * «Oggi» è il giorno dell'utente, non quello del server.
     *
     * Qui non è una finezza sull'ora legale: è il confine fra ciò che è
     * successo e ciò che si prevede, e spostarlo di un giorno sposta una
     * scadenza intera da una colonna all'altra. La stessa data torna nella
     * risposta, perché il simulatore nel browser deve tagliare dove ha tagliato
     * il server.
     */
    const today = todayIn(settings.timezone, new Date());

    const { rows, unconverted } = await collectForecast(app.prisma, user.id, year, {
      baseCurrency: settings.baseCurrency,
      today,
    });

    const forecast: Forecast = {
      year,
      baseCurrency: settings.baseCurrency,
      today: formatIsoDate(today),
      rows,
      unconverted,
    };
    return forecast;
  });
}
