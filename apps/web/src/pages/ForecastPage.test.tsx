import type { Forecast, Settings } from '@easygest/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { forecastKeys } from '@/lib/forecast';
import { settingsKeys } from '@/lib/settings';

import { ForecastPage } from './ForecastPage';

/**
 * Prova di accensione del simulatore, guidata dall'indirizzo.
 *
 * Le leve stanno nell'URL apposta perché una prova possa muoverle: in
 * `environment: 'node'` un cursore non si può né rendere né trascinare, mentre
 * `?escluse=hosting` si scrive in una riga. Quello che si verifica qui non è la
 * grafica ma la catena — indirizzo, `simulate`, numeri a schermo — e in
 * particolare il fatto di dominio: **spuntando via una spesa il netto sale e i
 * contributi restano dove sono**.
 *
 * I numeri sono quelli di `taxes.test.ts` e `simulator.test.ts`, così una cifra
 * che cambia qui si ritrova là con la sua riga di conto.
 */

const YEAR = 2027;

const SETTINGS: Settings = {
  taxRegime: 'FORFETTARIO',
  substituteTaxRateBp: 500,
  profitabilityCoefficientBp: 6700,
  inpsRateBp: 2607,
  defaultVatRateBp: 2200,
  baseCurrency: 'EUR',
  timezone: 'Europe/Rome',
  reminderDaysBefore: [7],
  cancellationReminderDaysBefore: [30],
  digestEnabled: true,
  digestDayOfWeek: 1,
  updatedAt: '2027-03-15T08:00:00.000Z',
};

/** Cento euro già pagati a febbraio, duecento previsti ad aprile. */
const FORECAST: Forecast = {
  year: YEAR,
  baseCurrency: 'EUR',
  today: '2027-03-15',
  rows: [
    {
      occurrenceId: 'occ-1',
      expenseId: 'hosting',
      expenseName: 'Hosting',
      vendorName: null,
      categoryName: null,
      dueDate: '2027-02-10',
      baseGrossCents: 10_000,
      source: 'reale',
      status: 'PAID',
    },
    {
      occurrenceId: null,
      expenseId: 'hosting',
      expenseName: 'Hosting',
      vendorName: null,
      categoryName: null,
      dueDate: '2027-04-10',
      baseGrossCents: 20_000,
      source: 'previsione',
      status: null,
    },
  ],
  unconverted: [],
};

function html(at: string, overrides: { settings?: Settings; forecast?: Forecast } = {}): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(settingsKeys.all, overrides.settings ?? SETTINGS);
  queryClient.setQueryData(forecastKeys.year(YEAR), overrides.forecast ?? FORECAST);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <ForecastPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Cinquantamila di fatturato, leve ferme. */
const BASE = `/previsioni?anno=${String(YEAR)}&fatturato=50000`;

describe('il conto a schermo', () => {
  it('mostra imponibile, contributi, imposta e netto in tasca', () => {
    const markup = html(BASE);

    expect(markup).toContain('33.500,00'); // imponibile, 67 %
    expect(markup).toContain('8.733,45'); // contributi INPS
    expect(markup).toContain('1.238,33'); // imposta sostitutiva
    expect(markup).toContain('39.728,22'); // 50.000 − 9.971,78 − 300
    expect(markup).toContain('Netto in tasca');
  });

  it('scrive accanto al netto che i costi non riducono le imposte', () => {
    // È l'unica frase della pagina che qualcuno leggerà due volte, ed è il
    // motivo per cui la pagina esiste.
    expect(html(BASE)).toContain('i costi non riducono le imposte');
  });

  it('togliendo una spesa il netto sale e i contributi non si muovono', () => {
    // Il fatto di dominio numero uno, provato attraverso l'indirizzo: se un
    // giorno qualcuno «corregge» il conto facendo dedurre le spese, la seconda
    // asserzione è quella che se ne accorge.
    const markup = html(`${BASE}&escluse=hosting`);

    expect(markup).toContain('40.028,22'); // 50.000 − 9.971,78, senza costi
    expect(markup).not.toContain('39.728,22');
    expect(markup).toContain('8.733,45');
    expect(markup).toContain('1.238,33');
  });

  it('la percentuale sui costi tocca solo aprile, non febbraio', () => {
    // Al 200 %: i 200 € di aprile diventano 400, i 100 € di febbraio restano
    // 100. Un totale di 500 e non di 600.
    const markup = html(`${BASE}&costi=200`);

    expect(markup).toContain('39.528,22'); // 50.000 − 9.971,78 − 500
  });

  it('le aliquote scritte nell’indirizzo vincono su quelle salvate', () => {
    const markup = html(`${BASE}&coefficiente=78`);

    expect(markup).toContain('39.000,00'); // imponibile al 78 %
    expect(markup).not.toContain('33.500,00');
  });
});

describe('quello che la pagina si rifiuta di dire', () => {
  it('in ordinario non mostra nessun numero e manda alle impostazioni', () => {
    // Un conto del forfettario mostrato a chi è in ordinario sarebbe credibile
    // e falso, ed è peggio di nessun conto.
    const markup = html(BASE, { settings: { ...SETTINGS, taxRegime: 'ORDINARIO' } });

    expect(markup).toContain('scaglioni');
    expect(markup).toContain('/impostazioni/fisco');
    expect(markup).not.toContain('39.728,22');
    expect(markup).not.toContain('Netto in tasca');
  });

  it('senza un cambio nasconde il netto invece di mostrarne uno per difetto', () => {
    const markup = html(BASE, {
      forecast: {
        ...FORECAST,
        unconverted: [{ expenseId: 'aws', expenseName: 'AWS', currency: 'USD' }],
      },
    });

    expect(markup).toContain('Non calcolabile');
    expect(markup).not.toContain('39.728,22');
    expect(markup).toContain('AWS');
  });
});

describe('gli avvisi di soglia', () => {
  it('oltre 85.000 € dice che si esce dall’anno prossimo', () => {
    const markup = html(`/previsioni?anno=${String(YEAR)}&fatturato=90000`);

    expect(markup).toContain('dal 1° gennaio');
    // I numeri di quest'anno restano validi, quindi restano a schermo.
    expect(markup).toContain('Netto in tasca');
  });

  it('oltre 100.000 € dice che la decadenza è immediata', () => {
    const markup = html(`/previsioni?anno=${String(YEAR)}&fatturato=110000`);

    expect(markup).toContain('non valgono più');
  });
});

describe('l’elenco delle spese da togliere', () => {
  it('continua a elencare una spesa già tolta', () => {
    // Si costruisce dalle righe non filtrate: prendendolo dal risultato della
    // simulazione, una spesa spuntata sparirebbe dall'elenco e non ci sarebbe
    // più modo di rimetterla.
    expect(html(`${BASE}&escluse=hosting`)).toContain('escludi-hosting');
  });
});
