import {
  EXPENSE_STATUS_LABELS,
  OCCURRENCE_STATUS_LABELS,
  type Expense,
  type ExpenseOccurrence,
  type Paginated,
} from '@easygest/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';

import {
  ALL,
  DEFAULT_EXPENSE_FILTERS,
  expenseKeys,
  occurrenceKeys,
  type OccurrenceFilters,
} from '@/lib/expenses';
import { isoPlusDays, todayIso } from '@/lib/format';

import { DueDatesPage } from './DueDatesPage';
import { ExpenseDetailPage } from './ExpenseDetailPage';
import { ExpensesPage } from './ExpensesPage';

/**
 * Prove di accensione delle tre pagine delle spese.
 *
 * A differenza delle anagrafiche qui la cache si riempie prima di disegnare.
 * Non è pignoleria: senza righe queste pagine mostrano tre parole e
 * «Caricamento…», e un test che le trova avrebbe verificato l'intestazione di
 * una tabella vuota. Con una riga dentro si prova ciò che si sbaglia davvero —
 * che le etichette vengano dalle costanti condivise, che il badge «Da
 * confermare» compaia dove deve, che il dettaglio legga `useParams`.
 *
 * Quello che resta fuori portata è il contenuto delle tendine: Radix mette le
 * voci di un `Select` in un portale, che in SSR non produce markup. Un test
 * sulle etichette di stato *dei filtri* verificherebbe il vuoto — le stesse
 * etichette si provano quindi sulle righe, dove sono davvero disegnate.
 */

const TODAY = todayIso();

function page<T>(items: T[]): Paginated<T> {
  return { items, total: items.length, page: 1, perPage: 20, totalPages: 1 };
}

const EXPENSE: Expense = {
  id: 'exp-1',
  name: 'Hosting del sito',
  description: null,

  vendorId: 'ven-1',
  categoryId: 'cat-1',
  paymentMethodId: null,
  clientId: 'cli-1',
  vendorName: 'Aruba',
  categoryName: 'Infrastruttura',
  paymentMethodLabel: null,
  clientName: 'Studio Bianchi',

  netCents: 4900,
  vatRateBp: 2200,
  grossCents: 5978,
  currency: 'EUR',

  recurrenceUnit: 'MONTH',
  recurrenceInterval: 1,
  startDate: '2024-01-01',
  endDate: null,

  status: 'ACTIVE',
  autoRenew: true,
  cancellationNoticeDays: 30,
  cancelledAt: null,

  rebillMode: 'MARKUP',
  rebillMarkupBp: 1500,
  rebillAmountCents: null,

  notes: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',

  nextDueDate: isoPlusDays(TODAY, 10),
  nextCancellationDeadline: isoPlusDays(TODAY, -20),
  occurrenceCount: 14,
};

/** Pagata dal cron, che non ha guardato niente: è la riga da controllare. */
const UNCONFIRMED_OCCURRENCE: ExpenseOccurrence = {
  id: 'occ-1',
  expenseId: EXPENSE.id,
  expenseName: EXPENSE.name,
  dueDate: isoPlusDays(TODAY, -3),
  periodStart: null,
  periodEnd: null,

  netCents: 4900,
  vatRateBp: 2200,
  grossCents: 5978,
  currency: 'EUR',
  fxRate: null,
  baseGrossCents: 5978,

  status: 'PAID',
  paidAt: '2026-01-10T09:00:00.000Z',
  confirmedAt: null,
  documentId: null,
  notes: null,
};

/** Gli stessi filtri con cui `DueDatesPage` si apre, per colpirne la chiave. */
const DUE_FILTERS: OccurrenceFilters = {
  q: '',
  page: 1,
  expenseId: ALL,
  status: 'PLANNED',
  from: '',
  to: isoPlusDays(TODAY, 60),
  unconfirmed: false,
  sort: 'dueDate',
  direction: 'asc',
};

/** Quelli di `ExpenseDetailPage`, che fissa la spesa e non filtra lo stato. */
const DETAIL_FILTERS: OccurrenceFilters = {
  q: '',
  page: 1,
  expenseId: EXPENSE.id,
  status: ALL,
  from: '',
  to: '',
  unconfirmed: false,
  sort: 'dueDate',
  direction: 'asc',
};

function html(
  element: ReactElement,
  seed: (client: QueryClient) => void = () => undefined,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed(queryClient);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('elenco delle spese', () => {
  it('mostra i comandi e lo stato di caricamento', () => {
    const markup = html(<ExpensesPage />);

    expect(markup).toContain('Nuova spesa');
    expect(markup).toContain('Caricamento');
    expect(markup).toContain('Azzera i filtri');
  });

  it('disegna una riga con le etichette condivise', () => {
    const markup = html(<ExpensesPage />, (client) => {
      client.setQueryData(expenseKeys.list(DEFAULT_EXPENSE_FILTERS), page([EXPENSE]));
    });

    expect(markup).toContain(EXPENSE.name);
    expect(markup).toContain('Aruba');
    // Presa dalla costante: se la pagina avesse una copia locale delle
    // etichette, rinominare uno stato in `shared` la lascerebbe indietro senza
    // che niente se ne accorga.
    expect(markup).toContain(EXPENSE_STATUS_LABELS.ACTIVE);
    expect(markup).toContain('/spese/exp-1');
  });

  it('avverte quando il termine per disdire è vicino', () => {
    // È il dato per cui l'applicazione esiste, e in una tabella di dieci righe
    // si vede solo se qualcosa lo mette in evidenza.
    const markup = html(<ExpensesPage />, (client) => {
      client.setQueryData(expenseKeys.list(DEFAULT_EXPENSE_FILTERS), page([EXPENSE]));
    });

    expect(markup).toContain('Disdetta entro il');
  });
});

describe('dettaglio della spesa', () => {
  function detail(seed: (client: QueryClient) => void): string {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(queryClient);
    return renderToString(
      <QueryClientProvider client={queryClient}>
        {/*
          Montata dentro la sua rotta, altrimenti `useParams` restituisce un
          oggetto vuoto: il test proverebbe il caso «nessun identificativo»,
          che dall'applicazione non si raggiunge.
        */}
        <MemoryRouter initialEntries={[`/spese/${EXPENSE.id}`]}>
          <Routes>
            <Route path="/spese/:id" element={<ExpenseDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('mette in evidenza la disdetta e i collegamenti', () => {
    const markup = detail((client) => {
      client.setQueryData(expenseKeys.detail(EXPENSE.id), EXPENSE);
      client.setQueryData(occurrenceKeys.list(DETAIL_FILTERS), page([UNCONFIRMED_OCCURRENCE]));
    });

    expect(markup).toContain(EXPENSE.name);
    expect(markup).toContain('Disdetta');
    expect(markup).toContain('Preavviso');
    expect(markup).toContain('Aruba');
    expect(markup).toContain('Studio Bianchi');
  });

  it('mostra il riaddebito solo perché questa spesa ne ha uno', () => {
    const withRebill = detail((client) => {
      client.setQueryData(expenseKeys.detail(EXPENSE.id), EXPENSE);
    });
    const without = detail((client) => {
      client.setQueryData(expenseKeys.detail(EXPENSE.id), {
        ...EXPENSE,
        rebillMode: 'NONE',
        rebillMarkupBp: null,
      } satisfies Expense);
    });

    expect(withRebill).toContain('Riaddebito');
    expect(without).not.toContain('Riaddebito');
  });

  it('elenca le scadenze senza la colonna del nome della spesa', () => {
    // La colonna c'è sull'elenco globale e non qui, dove sarebbe il titolo
    // della pagina ricopiato quattordici volte. Le due asserzioni stanno
    // insieme: da sola, la negativa passerebbe anche se l'intestazione si
    // chiamasse in un altro modo.
    const detailMarkup = detail((client) => {
      client.setQueryData(expenseKeys.detail(EXPENSE.id), EXPENSE);
    });
    const globalMarkup = html(<DueDatesPage />);

    expect(globalMarkup).toContain('>Spesa</th>');
    expect(detailMarkup).not.toContain('>Spesa</th>');
  });
});

describe('scadenze', () => {
  it('non offre di crearne una', () => {
    // Le occorrenze le genera il motore dalla spesa: un pulsante «Nuova»
    // prometterebbe una rotta che l'API non espone.
    const markup = html(<DueDatesPage />);

    expect(markup).toContain('Scadenze');
    expect(markup).not.toContain('Nuova');
  });

  it('segnala le pagate che nessuno ha ancora verificato', () => {
    const markup = html(<DueDatesPage />, (client) => {
      client.setQueryData(occurrenceKeys.list(DUE_FILTERS), page([UNCONFIRMED_OCCURRENCE]));
    });

    expect(markup).toContain(OCCURRENCE_STATUS_LABELS.PAID);
    expect(markup).toContain('Da confermare');
    // Qui la colonna col nome della spesa serve: è l'unico modo di sapere di
    // cosa sia la scadenza.
    expect(markup).toContain(EXPENSE.name);
  });

  it('offre le finestre che si chiedono davvero', () => {
    const markup = html(<DueDatesPage />);

    expect(markup).toContain('Prossimi 30 giorni');
    expect(markup).toContain('Questo mese');
  });
});
