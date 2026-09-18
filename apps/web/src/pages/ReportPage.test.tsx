import type { ReportSummary } from '@easygest/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { reportKeys } from '@/lib/reports';

import { ReportPage } from './ReportPage';

/**
 * Prova di accensione della pagina dei report.
 *
 * Stesso impianto della dashboard — `renderToString`, cache riempita a mano —
 * con una differenza obbligata: il periodo si semina **nell'URL**, e la chiave
 * da riempire è esattamente `reportKeys.summary({ from, to })` di quel periodo.
 * È anche la dimostrazione che è l'indirizzo a guidare la lettura: seminando
 * una chiave e chiedendone un'altra la pagina resterebbe in caricamento.
 */

const PERIOD = { from: '2027-01-01', to: '2027-03-31' };

function html(at: string, seed?: (client: QueryClient) => void): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <ReportPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function at(period: { from: string; to: string }): string {
  return `/report?from=${period.from}&to=${period.to}`;
}

/**
 * Un riepilogo con numeri tutti diversi fra i gruppi.
 *
 * Se categorie, fornitori e clienti valessero le stesse cifre, un
 * `toContain('700,00')` passerebbe anche se una tabella mostrasse i totali
 * della tabella accanto — che è precisamente il difetto che non si nota.
 */
const SUMMARY: ReportSummary = {
  from: PERIOD.from,
  to: PERIOD.to,
  baseCurrency: 'EUR',
  totalCents: 123_456,
  count: 42,
  foreignCount: 3,
  byCategory: [
    { id: 'cat-1', label: 'Infrastruttura', totalCents: 70_000, count: 10, shareBp: 5670 },
    { id: null, label: 'Senza categoria', totalCents: 53_456, count: 32, shareBp: 4330 },
  ],
  byVendor: [
    { id: 'ven-1', label: 'Aruba', totalCents: 81_100, count: 12, shareBp: 6570 },
    { id: null, label: 'Senza fornitore', totalCents: 42_356, count: 30, shareBp: 3430 },
  ],
  byClient: [
    {
      id: 'cli-1',
      label: 'Rossi srl',
      totalCents: 50_000,
      count: 5,
      shareBp: 4050,
      rebillCents: 62_200,
      theoreticalMarginCents: 12_200,
    },
    {
      id: null,
      label: 'Non riaddebitata',
      totalCents: 73_456,
      count: 37,
      shareBp: 5950,
      rebillCents: 0,
      // Una spesa non riaddebitata ha margine negativo, non assente.
      theoreticalMarginCents: -73_456,
    },
  ],
  byMonth: [
    { month: '2027-01', totalCents: 11_100, count: 4 },
    { month: '2027-02', totalCents: 22_200, count: 8 },
    { month: '2027-03', totalCents: 90_156, count: 30 },
  ],
};

const EMPTY_SUMMARY: ReportSummary = {
  from: PERIOD.from,
  to: PERIOD.to,
  baseCurrency: 'EUR',
  totalCents: 0,
  count: 0,
  foreignCount: 0,
  byCategory: [],
  byVendor: [],
  byClient: [],
  byMonth: [
    { month: '2027-01', totalCents: 0, count: 0 },
    { month: '2027-02', totalCents: 0, count: 0 },
    { month: '2027-03', totalCents: 0, count: 0 },
  ],
};

function withSummary(summary: ReportSummary) {
  return (client: QueryClient) => {
    client.setQueryData(reportKeys.summary(PERIOD), summary);
  };
}

describe('report di un periodo con righe', () => {
  it('mostra i totali e le quattro tabelle', () => {
    const markup = html(at(PERIOD), withSummary(SUMMARY));

    expect(markup).toContain('Totale del periodo');
    expect(markup).toContain('1.234,56');
    expect(markup).toContain('Andamento mensile');
    expect(markup).toContain('Per categoria');
    expect(markup).toContain('Per fornitore');
    expect(markup).toContain('Per cliente');
    // Il mese si scrive dalla stringa `YYYY-MM`, senza costruire un `Date`:
    // stessa ragione di `formatDay`, cioè che a ovest di Greenwich un giorno
    // di calendario letto come istante indietreggia di uno.
    expect(markup).toContain('03/2027');
    // Il margine negativo c'è, e col segno.
    expect(markup).toContain('-734,56');
  });

  it('il periodo è scritto in chiaro, perché un foglio stampato dica di quando parla', () => {
    // Non è `print:hidden`, a differenza della barra dei comandi: è l'unica
    // cosa che rende leggibile da solo un foglio uscito dalla stampante.
    const markup = html(at(PERIOD), withSummary(SUMMARY));

    expect(markup).toContain('01/01/2027');
    expect(markup).toContain('31/03/2027');
  });

  it('non promette mai un totale del 100 %', () => {
    // Le quote sono arrotondate: tre gruppi da un terzo danno 99,99. La riserva
    // è scritta, e da nessuna parte compare un totale delle quote.
    const markup = html(at(PERIOD), withSummary(SUMMARY));

    expect(markup).toContain('Le quote non sommano');
    expect(markup).not.toContain('100%');
  });

  it('le etichette degli scoperti sono quelle, non celle vuote', () => {
    // «Non riaddebitata» è un gruppo, non un buco: nasconderlo farebbe tornare
    // la somma delle righe e sparire una voce di spesa.
    const markup = html(at(PERIOD), withSummary(SUMMARY));

    expect(markup).toContain('Senza categoria');
    expect(markup).toContain('Senza fornitore');
    expect(markup).toContain('Non riaddebitata');
  });

  it('il foglio porta il nome dell’applicazione e la data in cui è uscito', () => {
    // La forma e non il giorno: `todayIso()` legge l'orologio durante il
    // rendering. Il timbro esiste perché le `PLANNED` contano nei totali — due
    // stampe dello stesso periodo a un mese di distanza portano numeri diversi
    // — e perché l'intestazione dell'applicazione, che è `print:hidden`, era
    // l'unico altro punto in cui compariva la parola «EasyGest».
    const markup = html(at(PERIOD), withSummary(SUMMARY));

    expect(markup).toMatch(/EasyGest · generato il \d{2}\/\d{2}\/\d{4}/);
    // Unica volta in cui si guarda una classe, perché qui la classe *è* il
    // comportamento: a schermo il timbro non c'è, sulla carta sì.
    expect(markup).toContain('print:block');
  });

  it('a righe presenti si può sia esportare sia stampare', () => {
    // L'attributo, non la classe: le classi di Tailwind contengono tutte una
    // variante `disabled:`, e cercare la sola parola troverebbe sempre sé
    // stessa su qualunque bottone.
    const markup = html(at(PERIOD), withSummary(SUMMARY));

    expect(markup).toContain('Esporta CSV');
    expect(markup).toContain('Stampa');
    expect(markup).not.toContain('disabled=""');
  });
});

describe('report di un periodo vuoto', () => {
  it('lo dice, invece di mostrare quattro tabelle vuote', () => {
    const markup = html(at(PERIOD), withSummary(EMPTY_SUMMARY));

    expect(markup).toContain('Nessuna scadenza in questo periodo.');
    expect(markup).not.toContain('Andamento mensile');
  });

  it('a conteggio zero si stampa ma non si esporta', () => {
    /**
     * Il file avrebbe solo righe senza costo — saltate e annullate — e un CSV
     * di sole intestazioni aperto in Excel è indistinguibile da
     * un'esportazione andata storta. Un foglio con periodo, timbro e «Nessuna
     * scadenza in questo periodo» è invece un documento vero, ed è quello che
     * si consegna per dire che in quel trimestre non c'era niente.
     *
     * Si contano le occorrenze come in `AppLayout.test.tsx`: con due bottoni,
     * un `toContain` passerebbe anche se fossero spenti entrambi, cioè
     * precisamente il difetto che questa prova esclude.
     */
    const markup = html(at(PERIOD), withSummary(EMPTY_SUMMARY));
    const off = [...markup.matchAll(/disabled=""/g)];

    expect(markup).toContain('Esporta CSV');
    expect(markup).toContain('Stampa');
    expect(off).toHaveLength(1);
  });

  it('non lascia trapelare né NaN né undefined', () => {
    const markup = html(at(PERIOD), withSummary(EMPTY_SUMMARY));

    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('undefined');
  });
});

describe('periodo che il server rifiuterebbe', () => {
  it('non parte nemmeno: c’è il messaggio, non «Caricamento…»', () => {
    // `enabled` spegne la query, e la guardia sul periodo viene prima di
    // quella sul caricamento: una pagina che dicesse «Caricamento…» su un
    // periodo impossibile aspetterebbe una risposta che non arriva mai.
    const markup = html(at({ from: '2020-01-01', to: '2027-01-01' }));

    expect(markup).toContain('Il periodo non può superare tre anni');
    expect(markup).not.toContain('Caricamento');
  });

  it('la data resta quella scritta nell’URL, non una corretta di nascosto', () => {
    const markup = html(at({ from: '2020-01-01', to: '2027-01-01' }));

    expect(markup).toContain('01/01/2020');
  });

  it('non si stampa un messaggio d’errore', () => {
    // Su un periodo rifiutato a schermo c'è il messaggio rosso e nient'altro:
    // un foglio con dentro quello non è un documento, e i due bottoni sono
    // spenti entrambi.
    const markup = html(at({ from: '2020-01-01', to: '2027-01-01' }));
    const off = [...markup.matchAll(/disabled=""/g)];

    expect(off).toHaveLength(2);
  });
});
