import { describe, expect, it } from 'vitest';

import {
  MAX_OCCURRENCES,
  RecurrenceError,
  addDays,
  addMonths,
  cancellationDeadline,
  differenceInDays,
  firstIndexOnOrAfter,
  formatIsoDate,
  generateSchedule,
  isValidTimeZone,
  isoWeekKey,
  isoWeekday,
  occurrenceDate,
  occurrencePeriod,
  parseIsoDate,
  scheduleHorizon,
  todayIn,
  utcDay,
} from './recurrence';

/** Le date si leggono meglio come stringhe che come oggetti `Date`. */
function iso(dates: Date[]): string[] {
  return dates.map(formatIsoDate);
}

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

describe('giorni di calendario', () => {
  it('rifiuta una data che non esiste invece di farla scivolare', () => {
    // `new Date('2027-02-30')` restituisce il 2 marzo senza dire niente: è il
    // comportamento che questa funzione esiste per non ereditare.
    expect(parseIsoDate('2027-02-30')).toBeNull();
    expect(parseIsoDate('2027-13-01')).toBeNull();
    expect(parseIsoDate('non è una data')).toBeNull();
    expect(parseIsoDate('2024-02-29')).not.toBeNull();
  });

  it('non confonde gli anni a due cifre con il Novecento', () => {
    expect(formatIsoDate(utcDay(99, 1, 1))).toBe('0099-01-01');
  });

  it('conta i giorni fra due date', () => {
    expect(differenceInDays(d('2027-01-01'), d('2027-01-31'))).toBe(30);
    expect(differenceInDays(d('2027-03-01'), d('2027-01-01'))).toBe(-59);
    expect(differenceInDays(d('2024-02-28'), d('2024-03-01'))).toBe(2);
  });

  it('somma giorni attraverso il cambio dell\u2019ora legale', () => {
    // In Europa l'ora legale scatta l'ultima domenica di marzo. A mezzanotte
    // UTC non esiste, ed è esattamente il motivo per cui le date stanno in UTC.
    expect(formatIsoDate(addDays(d('2027-03-27'), 1))).toBe('2027-03-28');
    expect(formatIsoDate(addDays(d('2027-10-30'), 1))).toBe('2027-10-31');
  });
});

describe('settimana ISO', () => {
  it('numera i giorni da luned\u00ec a domenica', () => {
    expect(isoWeekday(d('2027-01-04'))).toBe(1); // lunedì
    expect(isoWeekday(d('2027-01-10'))).toBe(7); // domenica, non zero
  });

  it('attribuisce la settimana all\u2019anno del suo gioved\u00ec', () => {
    // I casi cattivi sono tutti a cavallo di capodanno, e sono due, opposti.
    // Il 1° gennaio 2027 è un venerdì: la sua settimana è cominciata nel 2026 e
    // il suo giovedì è il 31 dicembre, quindi appartiene al 2026.
    expect(isoWeekKey(d('2027-01-01'))).toBe('2026-W53');
    expect(isoWeekKey(d('2027-01-03'))).toBe('2026-W53');
    expect(isoWeekKey(d('2027-01-04'))).toBe('2027-W01');

    // E il rovescio: il 31 dicembre 2029 è un lunedì, il suo giovedì è già nel
    // 2030, quindi la settimana è la prima del 2030.
    expect(isoWeekKey(d('2029-12-31'))).toBe('2030-W01');
    expect(isoWeekKey(d('2029-12-30'))).toBe('2029-W52');
  });

  it('d\u00e0 la stessa chiave a tutti i giorni della stessa settimana', () => {
    // È la proprietà su cui poggia la deduplica del riepilogo: cambiare il
    // giorno di invio non deve produrre un secondo riepilogo.
    const week = ['2027-03-15', '2027-03-17', '2027-03-21'].map((value) => isoWeekKey(d(value)));
    expect(new Set(week).size).toBe(1);
    expect(week[0]).toBe('2027-W11');
  });
});

describe('validit\u00e0 di un fuso', () => {
  it('accetta i fusi veri, `UTC` compreso, e rifiuta il resto', () => {
    expect(isValidTimeZone('Europe/Rome')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/Argentina/Ushuaia')).toBe(true);
    expect(isValidTimeZone('Europa/Roma')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('somma di mesi', () => {
  it('tronca al giorno che esiste', () => {
    expect(formatIsoDate(addMonths(d('2027-01-31'), 1))).toBe('2027-02-28');
    expect(formatIsoDate(addMonths(d('2027-01-31'), 3))).toBe('2027-04-30');
  });

  it('non accumula il troncamento', () => {
    // Il punto di tutto il file: due mesi dopo il 31 gennaio è il 31 marzo.
    // Sommando un mese alla volta si arriverebbe al 28.
    expect(formatIsoDate(addMonths(d('2027-01-31'), 2))).toBe('2027-03-31');
  });

  it('conosce gli anni bisestili', () => {
    expect(formatIsoDate(addMonths(d('2024-01-31'), 1))).toBe('2024-02-29');
    expect(formatIsoDate(addMonths(d('2024-02-29'), 12))).toBe('2025-02-28');
    expect(formatIsoDate(addMonths(d('2024-02-29'), 48))).toBe('2028-02-29');
  });

  it('va anche all\u2019indietro', () => {
    expect(formatIsoDate(addMonths(d('2027-03-31'), -1))).toBe('2027-02-28');
    expect(formatIsoDate(addMonths(d('2027-01-15'), -1))).toBe('2026-12-15');
  });
});

describe('data di una singola occorrenza', () => {
  it('l\u2019occorrenza zero cade sull\u2019ancora', () => {
    expect(formatIsoDate(occurrenceDate(d('2027-03-15'), 'MONTH', 1, 0))).toBe('2027-03-15');
    expect(formatIsoDate(occurrenceDate(d('2027-03-15'), 'ONE_OFF', 1, 0))).toBe('2027-03-15');
  });

  it('rispetta l\u2019intervallo per ogni unit\u00e0', () => {
    const start = d('2027-01-04');
    expect(formatIsoDate(occurrenceDate(start, 'DAY', 10, 3))).toBe('2027-02-03');
    expect(formatIsoDate(occurrenceDate(start, 'WEEK', 2, 3))).toBe('2027-02-15');
    expect(formatIsoDate(occurrenceDate(start, 'MONTH', 3, 2))).toBe('2027-07-04');
    expect(formatIsoDate(occurrenceDate(start, 'YEAR', 1, 2))).toBe('2029-01-04');
  });

  it('una tantum non ha una seconda occorrenza', () => {
    expect(() => occurrenceDate(d('2027-03-15'), 'ONE_OFF', 1, 1)).toThrow(RecurrenceError);
  });

  it('rifiuta intervalli e indici che non hanno senso', () => {
    expect(() => occurrenceDate(d('2027-03-15'), 'MONTH', 0, 1)).toThrow(RecurrenceError);
    expect(() => occurrenceDate(d('2027-03-15'), 'MONTH', 1.5, 1)).toThrow(RecurrenceError);
    expect(() => occurrenceDate(d('2027-03-15'), 'MONTH', 1, -1)).toThrow(RecurrenceError);
  });
});

describe('primo indice utile', () => {
  it('resta a zero se la serie comincia dopo il bersaglio', () => {
    expect(firstIndexOnOrAfter(d('2027-06-01'), 'MONTH', 1, d('2027-01-01'))).toBe(0);
  });

  it('trova l\u2019indice esatto quando il bersaglio \u00e8 un\u2019occorrenza', () => {
    // Il confine è inclusivo: chi cade proprio sul bersaglio è il primo utile.
    expect(firstIndexOnOrAfter(d('2027-01-15'), 'MONTH', 1, d('2027-04-15'))).toBe(3);
  });

  it('salta al giorno dopo un\u2019occorrenza senza sbagliare di uno', () => {
    expect(firstIndexOnOrAfter(d('2027-01-15'), 'MONTH', 1, d('2027-04-16'))).toBe(4);
  });

  it('regge il troncamento di fine mese, dove la stima aritmetica sbaglia', () => {
    // La serie è 31/01, 28/02, 31/03… Il conteggio dei mesi direbbe indice 1
    // per il primo marzo, ma l'occorrenza 1 è il 28 febbraio: è già passata.
    expect(firstIndexOnOrAfter(d('2027-01-31'), 'MONTH', 1, d('2027-03-01'))).toBe(2);
  });

  it('non ha indici utili se l\u2019unica occorrenza \u00e8 passata', () => {
    expect(firstIndexOnOrAfter(d('2027-01-10'), 'ONE_OFF', 1, d('2027-02-01'))).toBe(1);
  });
});

describe('generazione della serie', () => {
  it('genera dall\u2019ancora fino all\u2019orizzonte, estremo incluso', () => {
    const dates = generateSchedule({
      start: d('2027-01-15'),
      unit: 'MONTH',
      interval: 1,
      until: d('2027-04-15'),
    });
    expect(iso(dates)).toEqual(['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15']);
  });

  it('si ferma alla fine del contratto anche se l\u2019orizzonte \u00e8 pi\u00f9 in l\u00e0', () => {
    const dates = generateSchedule({
      start: d('2027-01-15'),
      unit: 'MONTH',
      interval: 1,
      end: d('2027-03-20'),
      until: d('2027-12-31'),
    });
    expect(iso(dates)).toEqual(['2027-01-15', '2027-02-15', '2027-03-15']);
  });

  it('una tantum produce una sola data', () => {
    const dates = generateSchedule({
      start: d('2027-01-15'),
      unit: 'ONE_OFF',
      interval: 1,
      until: d('2029-12-31'),
    });
    expect(iso(dates)).toEqual(['2027-01-15']);
  });

  it('`from` non sposta l\u2019ancora', () => {
    // La proprietà su cui si regge la rigenerazione: chiedere solo il futuro
    // deve restituire le stesse identiche date che avrebbe la serie completa.
    const completa = generateSchedule({
      start: d('2027-01-31'),
      unit: 'MONTH',
      interval: 1,
      until: d('2027-06-30'),
    });
    const parziale = generateSchedule({
      start: d('2027-01-31'),
      unit: 'MONTH',
      interval: 1,
      from: d('2027-04-01'),
      until: d('2027-06-30'),
    });
    expect(iso(parziale)).toEqual(iso(completa).slice(3));
    expect(iso(parziale)).toEqual(['2027-04-30', '2027-05-31', '2027-06-30']);
  });

  it('la serie mensile dal 31 non scivola', () => {
    const dates = generateSchedule({
      start: d('2027-01-31'),
      unit: 'MONTH',
      interval: 1,
      until: d('2027-05-31'),
    });
    expect(iso(dates)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
    ]);
  });

  it('\u00e8 vuota se il contratto \u00e8 gi\u00e0 finito prima della finestra', () => {
    const dates = generateSchedule({
      start: d('2020-01-15'),
      unit: 'MONTH',
      interval: 1,
      end: d('2021-01-15'),
      until: d('2027-12-31'),
      from: d('2027-01-01'),
    });
    expect(dates).toEqual([]);
  });

  it('rifiuta una fine che precede l\u2019inizio', () => {
    expect(() =>
      generateSchedule({
        start: d('2027-06-01'),
        unit: 'MONTH',
        interval: 1,
        end: d('2027-01-01'),
        until: d('2027-12-31'),
      }),
    ).toThrow(RecurrenceError);
  });

  it('protesta invece di troncare una serie troppo lunga', () => {
    expect(() =>
      generateSchedule({
        start: d('2000-01-01'),
        unit: 'DAY',
        interval: 1,
        until: d('2030-01-01'),
      }),
    ).toThrow(new RegExp(String(MAX_OCCURRENCES)));
  });

  it('una spesa vecchissima non costa un giro per ogni giorno passato', () => {
    // Senza `firstIndexOnOrAfter` questa chiamata scorrerebbe novemila
    // occorrenze passate per restituirne tre, e il tetto scatterebbe su una
    // serie perfettamente legittima.
    const dates = generateSchedule({
      start: d('2000-01-01'),
      unit: 'DAY',
      interval: 1,
      from: d('2027-06-01'),
      until: d('2027-06-03'),
    });
    expect(iso(dates)).toEqual(['2027-06-01', '2027-06-02', '2027-06-03']);
  });
});

describe('orizzonte e disdetta', () => {
  it('l\u2019orizzonte predefinito \u00e8 tredici mesi', () => {
    expect(formatIsoDate(scheduleHorizon(d('2027-03-15')))).toBe('2028-04-15');
  });

  it('la scadenza di disdetta anticipa il rinnovo del preavviso', () => {
    expect(formatIsoDate(cancellationDeadline(d('2027-03-15'), 60)!)).toBe('2027-01-14');
    expect(formatIsoDate(cancellationDeadline(d('2027-03-15'), 0)!)).toBe('2027-03-15');
  });

  it('senza preavviso non c\u2019\u00e8 scadenza, che non \u00e8 «scade oggi»', () => {
    expect(cancellationDeadline(d('2027-03-15'), null)).toBeNull();
  });
});

describe('periodo coperto', () => {
  it('finisce il giorno prima della successiva, non lo stesso', () => {
    // Due periodi consecutivi non devono sovrapporsi: se il primo finisse il
    // 15 e il secondo cominciasse il 15, ogni somma per intervallo conterebbe
    // quel giorno due volte.
    const { periodStart, periodEnd } = occurrencePeriod(d('2027-01-15'), 'MONTH', 1, 0);
    expect(formatIsoDate(periodStart)).toBe('2027-01-15');
    expect(formatIsoDate(periodEnd!)).toBe('2027-02-14');
  });

  it('un anno pagato in anticipo copre un anno', () => {
    const { periodStart, periodEnd } = occurrencePeriod(d('2027-01-15'), 'YEAR', 1, 0);
    expect(formatIsoDate(periodStart)).toBe('2027-01-15');
    expect(formatIsoDate(periodEnd!)).toBe('2028-01-14');
  });

  it('una tantum non copre un periodo', () => {
    expect(occurrencePeriod(d('2027-01-15'), 'ONE_OFF', 1, 0).periodEnd).toBeNull();
  });
});

describe('«oggi» secondo il fuso dell\u2019utente', () => {
  it('a mezzanotte e mezza a Roma \u00e8 gi\u00e0 il giorno nuovo, in UTC no', () => {
    // 22:30 UTC del 14 marzo sono le 23:30 a Roma: stesso giorno.
    // 23:30 UTC del 14 marzo sono le 00:30 del 15 a Roma: giorno diverso.
    const notte = new Date('2027-03-14T23:30:00Z');
    expect(formatIsoDate(todayIn('Europe/Rome', notte))).toBe('2027-03-15');
    expect(formatIsoDate(todayIn('UTC', notte))).toBe('2027-03-14');
  });

  it('vale anche dall\u2019altra parte del mondo', () => {
    const mattina = new Date('2027-03-15T02:00:00Z');
    expect(formatIsoDate(todayIn('America/Los_Angeles', mattina))).toBe('2027-03-14');
  });
});
