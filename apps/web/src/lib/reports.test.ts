import { LEDGER_MAX_ROWS, type ReportRow } from '@easygest/shared';
import { describe, expect, it } from 'vitest';

import {
  activePreset,
  exportRefusal,
  periodError,
  periodFromParams,
  presetPeriod,
  reportKeys,
} from './reports';

/**
 * Le regole del periodo, provate dove si sbaglia davvero.
 *
 * `today` è sempre passato a mano: un test che leggesse l'orologio passerebbe
 * oggi e fallirebbe il primo dell'anno, che è esattamente il giorno in cui
 * nessuno guarda la CI. Le `queryOptions` non si provano — sarebbe provare
 * TanStack Query — tranne per il fatto che le due chiavi non collidano.
 */

describe('finestre dei preset', () => {
  it('il mese non finisce mai il 31 per forza', () => {
    // Il 28 e il 29 vengono dal calendario, non da una tabella di lunghezze
    // scritta a mano: è il motivo per cui si passa da `addMonths`.
    expect(presetPeriod('mese', '2027-02-10')).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(presetPeriod('mese', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('il trimestre è quello di calendario', () => {
    // Non «gli ultimi novanta giorni»: una finestra mobile dà un numero che
    // cambia ogni mattina e che non si confronta con quello di ieri.
    expect(presetPeriod('trimestre', '2027-03-15')).toEqual({
      from: '2027-01-01',
      to: '2027-03-31',
    });
    expect(presetPeriod('trimestre', '2027-11-02')).toEqual({
      from: '2027-10-01',
      to: '2027-12-31',
    });
  });

  it('l’anno in corso arriva a dicembre, non a oggi', () => {
    // Le `PLANNED` contano nei totali: il numero è metà consuntivo e metà
    // impegno preso, e fermarlo a oggi lo renderebbe un consuntivo parziale
    // spacciato per un anno intero.
    expect(presetPeriod('anno', '2027-03-15')).toEqual({ from: '2027-01-01', to: '2027-12-31' });
  });

  it('l’anno scorso è l’anno intero precedente', () => {
    expect(presetPeriod('annoScorso', '2027-03-15')).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
    });
  });

  it('riconosce il preset che descrive un periodo, e solo quello', () => {
    expect(activePreset({ from: '2027-01-01', to: '2027-12-31' }, '2027-03-15')).toBe('anno');
    // Un giorno di differenza non è più nessun preset: evidenziare comunque il
    // bottone direbbe che si sta guardando una finestra che non è quella.
    expect(activePreset({ from: '2027-01-01', to: '2027-12-30' }, '2027-03-15')).toBeNull();
  });
});

describe('periodo letto dall’URL', () => {
  it('senza parametri si apre sull’anno in corso', () => {
    // Non sul mese: un report di un mese solo ha una serie mensile di una
    // riga, e il costo del mese è già in dashboard.
    expect(periodFromParams(new URLSearchParams(), '2027-03-15')).toEqual({
      from: '2027-01-01',
      to: '2027-12-31',
    });
  });

  it('con un parametro solo non si inventa l’altro', () => {
    // Mezzo periodo è una domanda ambigua: completarlo vorrebbe dire scegliere
    // al posto di chi ha scritto l'indirizzo, e mostrare numeri veri
    // attribuiti a un periodo che nessuno ha chiesto.
    expect(periodFromParams(new URLSearchParams('from=2027-05-01'), '2027-03-15')).toEqual({
      from: '2027-01-01',
      to: '2027-12-31',
    });
  });

  it('una data scritta male resta nell’URL e viene rifiutata, non corretta', () => {
    const period = periodFromParams(new URLSearchParams('from=ieri&to=2027-03-31'), '2027-03-15');

    expect(period.from).toBe('ieri');
    expect(periodError(period)).not.toBeNull();
  });
});

describe('rifiuti', () => {
  it('il periodo oltre i tre anni porta il messaggio del server, parola per parola', () => {
    // Il messaggio non è riscritto qui: viene da `reportQuerySchema`, cioè
    // dallo stesso schema con cui l'API rifiuterebbe la query. Due
    // formulazioni della stessa regola divergerebbero alla prima modifica.
    expect(periodError({ from: '2020-01-01', to: '2027-01-01' })).toBe(
      'Il periodo non può superare tre anni',
    );
  });

  it('una fine che precede l’inizio è rifiutata prima di partire', () => {
    expect(periodError({ from: '2027-03-31', to: '2027-01-01' })).toBe(
      'La fine del periodo non può precedere l’inizio',
    );
  });

  it('un periodo buono non ha niente da dire', () => {
    expect(periodError({ from: '2027-01-01', to: '2027-03-31' })).toBeNull();
  });

  it('un dettaglio tagliato non produce un file, produce un rifiuto', () => {
    // Un CSV tagliato in silenzio è peggio di nessun CSV: chi lo apre somma
    // una colonna incompleta e non ha modo di accorgersene.
    const rows: ReportRow[] = [];

    expect(exportRefusal({ rows, truncated: false })).toBeNull();

    const refusal = exportRefusal({ rows, truncated: true });
    expect(refusal).toContain(String(LEDGER_MAX_ROWS));
    // Dice anche cosa fare: un rifiuto senza via d'uscita è un vicolo cieco.
    expect(refusal).toContain('restringi il periodo');
  });
});

describe('chiavi di cache', () => {
  it('riepilogo e dettaglio dello stesso periodo sono due chiavi diverse', () => {
    // Sono due rotte, due forme e due momenti: una chiave sola farebbe sì che
    // il ledger scritto da `fetchQuery` sovrascrivesse il riepilogo a schermo.
    const period = { from: '2027-01-01', to: '2027-03-31' };

    expect(reportKeys.summary(period)).not.toEqual(reportKeys.ledger(period));
    // Entrambe stanno sotto la radice che le mutazioni invalidano.
    expect(reportKeys.summary(period)[0]).toBe(reportKeys.all[0]);
    expect(reportKeys.ledger(period)[0]).toBe(reportKeys.all[0]);
  });

  it('due periodi diversi sono due chiavi diverse', () => {
    expect(reportKeys.summary({ from: '2027-01-01', to: '2027-03-31' })).not.toEqual(
      reportKeys.summary({ from: '2027-04-01', to: '2027-06-30' }),
    );
  });
});
