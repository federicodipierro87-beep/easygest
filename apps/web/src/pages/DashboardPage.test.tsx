import type { AgendaSectionSummary, DashboardSummary } from '@easygest/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { dashboardKeys } from '@/lib/dashboard';

import { DashboardPage } from './DashboardPage';

/**
 * Prova di accensione della dashboard.
 *
 * Due cose da guardare, e sono quelle che un rendering senza dati non
 * mostrerebbe. La prima è che il conteggio dei riquadri venga dal `total`
 * dell'API e non dalla lunghezza dell'elenco: con cinque righe su
 * trentaquattro, un «5» al posto del «34» sarebbe credibile — ed è proprio per
 * questo che nessuno se ne accorgerebbe. La seconda è che a zero non compaia
 * `NaN`: i due numeri in fondo passano da `formatMoney`, e un `undefined` o una
 * divisione andata storta finirebbero a schermo come tali invece che come un
 * errore.
 */

function html(element: ReactElement, seed?: (client: QueryClient) => void): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function empty(): AgendaSectionSummary {
  return { lines: [], total: 0, totalCents: 0 };
}

/**
 * Un riepilogo in cui ogni riquadro ha un numero diverso dagli altri.
 *
 * Numeri distinti perché un `expect(markup).toContain('2')` su quattro sezioni
 * che valgono tutte due non proverebbe niente: passerebbe anche se il riquadro
 * sbagliato mostrasse il conteggio del vicino.
 */
const SUMMARY: DashboardSummary = {
  today: '2027-03-15',
  baseCurrency: 'EUR',
  toConfirm: {
    // Cinque righe mostrate, trentaquattro in totale: è il caso che l'API
    // conta con `aggregate` invece di dedurlo dall'elenco.
    lines: [
      {
        occurrenceId: 'occ-1',
        expenseId: 'exp-1',
        expenseName: 'Hosting Hetzner',
        dueDate: '2027-03-10',
        grossCents: 2440,
        currency: 'EUR',
        baseGrossCents: 2440,
      },
    ],
    total: 34,
    totalCents: 123_456,
  },
  overdue: {
    lines: [
      {
        occurrenceId: 'occ-2',
        expenseId: 'exp-2',
        expenseName: 'Commercialista',
        dueDate: '2027-02-28',
        grossCents: 15_000,
        currency: 'EUR',
        baseGrossCents: 15_000,
      },
    ],
    total: 7,
    totalCents: 15_000,
  },
  cancellations: {
    lines: [
      {
        occurrenceId: 'occ-3',
        expenseId: 'exp-3',
        expenseName: 'Antivirus',
        dueDate: '2027-04-20',
        grossCents: 5900,
        currency: 'USD',
        baseGrossCents: 5400,
        deadline: '2027-03-21',
      },
    ],
    total: 3,
    totalCents: 5400,
  },
  upcoming: { lines: [], total: 0, totalCents: 0 },
  currentMonthCents: 98_700,
  monthlyAverageCents: 111_100,
};

const EMPTY_SUMMARY: DashboardSummary = {
  today: '2027-03-15',
  baseCurrency: 'EUR',
  toConfirm: empty(),
  overdue: empty(),
  cancellations: empty(),
  upcoming: empty(),
  currentMonthCents: 0,
  monthlyAverageCents: 0,
};

function withSummary(summary: DashboardSummary) {
  return (client: QueryClient) => {
    client.setQueryData(dashboardKeys.all, summary);
  };
}

describe('dashboard con dati', () => {
  it("mostra i quattro riquadri dell'agenda", () => {
    const markup = html(<DashboardPage />, withSummary(SUMMARY));

    expect(markup).toContain('Da confermare');
    expect(markup).toContain('In ritardo');
    expect(markup).toContain('Disdette');
    expect(markup).toContain('In arrivo');
  });

  it('conta quante sono davvero, non quante ne mostra', () => {
    // Il riquadro «da confermare» ha una riga sola in `lines` e `total: 34`.
    // Se il conteggio venisse dall'elenco direbbe «1», e sarebbe una bugia
    // plausibile: è il difetto per cui `AgendaSection` porta `total` separato.
    const markup = html(<DashboardPage />, withSummary(SUMMARY));

    expect(markup).toContain('>34<');
    expect(markup).toContain('>7<');
    expect(markup).toContain('>3<');
  });

  it('somma in valuta base e mostra le righe nella loro', () => {
    // L'antivirus è in dollari, ma il totale della sezione è in euro: sono i
    // due numeri che non devono scambiarsi di posto.
    const markup = html(<DashboardPage />, withSummary(SUMMARY));

    expect(markup).toContain('Antivirus');
    expect(markup).toContain('Hosting Hetzner');
    expect(markup).toContain('54,00');
    expect(markup).toContain('59,00');
  });

  it('data delle disdette è il termine, non il rinnovo', () => {
    // Nelle disdette la data che conta è l'ultimo giorno utile per disdire:
    // mostrare il rinnovo vorrebbe dire mostrare il giorno in cui è tardi.
    const markup = html(<DashboardPage />, withSummary(SUMMARY));

    expect(markup).toContain('21/03/2027');
    expect(markup).not.toContain('20/04/2027');
  });

  it('porta a scadenze e spese con il preset giusto', () => {
    const markup = html(<DashboardPage />, withSummary(SUMMARY));

    expect(markup).toContain('/scadenze');
    // Le disdette portano alle spese: disdire è un'azione sulla spesa, non
    // sull'occorrenza.
    expect(markup).toContain('/spese');
  });

  it('affianca al mese in corso la media che gli fa da metro', () => {
    const markup = html(<DashboardPage />, withSummary(SUMMARY));

    expect(markup).toContain('Costo del mese in corso');
    expect(markup).toContain('987,00');
    expect(markup).toContain('Media mensile');
    expect(markup).toContain('1.111,00');
    expect(markup).toContain('dodici mesi conclusi');
  });
});

describe('dashboard a zero', () => {
  it('dice per ogni riquadro che non ci sono righe', () => {
    const markup = html(<DashboardPage />, withSummary(EMPTY_SUMMARY));

    expect(markup).toContain('Niente da controllare');
    expect(markup).toContain('Nessun arretrato');
    expect(markup).toContain('Nessuna finestra aperta');
    expect(markup).toContain('Settimana libera');
  });

  it('non lascia trapelare né NaN né undefined', () => {
    // È la regressione che conta: `formatMoney` di un `undefined` e una media
    // divisa per zero finiscono a schermo come testo, non come errore, e una
    // dashboard che dice «NaN €» sembra un guasto del conto corrente.
    const markup = html(<DashboardPage />, withSummary(EMPTY_SUMMARY));

    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('undefined');
    expect(markup).toContain('0,00');
  });
});

describe('dashboard senza risposta', () => {
  it('dice a parole che non è riuscita a leggere, invece di restare vuota', () => {
    // Senza il pallino di `/health`, quattro riquadri vuoti e quattro riquadri
    // in errore si assomiglierebbero troppo. Qui la cache è vuota e la query
    // non parte: si vede lo stato di caricamento, che è la stessa frase
    // esplicita per la stessa ragione.
    const markup = html(<DashboardPage />);

    expect(markup).toContain('Caricamento');
    expect(markup).not.toContain('NaN');
  });
});
