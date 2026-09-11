import { describe, expect, it } from 'vitest';

import { formatIsoDate, parseIsoDate } from './recurrence';
import {
  CARD_EXPIRING_DAYS_BEFORE,
  type OccurrenceView,
  type PaymentMethodView,
  type PlanRemindersInput,
  REMINDER_KINDS,
  REMINDER_KIND_LABELS,
  REMINDER_TARGET_KINDS,
  autoPaidKey,
  cancellationWindowKey,
  cardExpiringKey,
  digestKey,
  expenseDueKey,
  lastValidDay,
  pickDaysBefore,
  planReminders,
} from './reminders';

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

/**
 * Le chiavi sono confrontate con stringhe scritte a mano, e non ricomposte
 * chiamando le stesse funzioni che si stanno provando.
 *
 * È deliberato, ed è la ragione per cui questo blocco esiste. Un test che
 * ricostruisse la chiave attesa con `joinKey` passerebbe qualunque cosa succeda
 * al formato, mentre cambiare il formato **rimanda tutte le email già inviate**:
 * nessuna chiave nuova corrisponde a una riga in tabella, quindi ogni avviso
 * risulta mai dato. Se una di queste asserzioni fallisce, la domanda da farsi
 * non è «come aggiorno il test» ma «cosa succede alle righe già scritte».
 */
describe('chiavi di deduplica', () => {
  it('mette il canale sempre in fondo', () => {
    expect(expenseDueKey('cl123', 7, 'EMAIL')).toBe('EXPENSE_DUE:cl123:7:EMAIL');
    expect(expenseDueKey('cl123', 7, 'IN_APP')).toBe('EXPENSE_DUE:cl123:7:IN_APP');
    expect(cancellationWindowKey('cl123', 30, 'EMAIL')).toBe('CANCELLATION_WINDOW:cl123:30:EMAIL');
  });

  it('distingue i due canali e i due generi sullo stesso soggetto', () => {
    // Ogni avviso produce due `ReminderLog`: se le due chiavi coincidessero, la
    // seconda scrittura fallirebbe e uno dei due canali resterebbe muto.
    const keys = new Set([
      expenseDueKey('cl123', 7, 'EMAIL'),
      expenseDueKey('cl123', 7, 'IN_APP'),
      cancellationWindowKey('cl123', 7, 'EMAIL'),
      cancellationWindowKey('cl123', 7, 'IN_APP'),
    ]);
    expect(keys.size).toBe(4);
  });

  it('cambia chiave a ogni anticipo', () => {
    // È ciò che permette a un promemoria a 30 giorni e a uno a 7 di convivere
    // sulla stessa scadenza.
    expect(expenseDueKey('cl123', 30, 'EMAIL')).not.toBe(expenseDueKey('cl123', 7, 'EMAIL'));
  });

  it('porta il mese nella chiave della carta', () => {
    expect(cardExpiringKey('pm1', { month: 3, year: 2027 }, 30, 'EMAIL')).toBe(
      'CARD_EXPIRING:pm1:2027-03:30:EMAIL',
    );
    // Il mese va a due cifre: senza, `2027-3` e `2027-12` si ordinerebbero in
    // modo strano nelle query fatte a mano durante un'indagine.
    expect(cardExpiringKey('pm1', { month: 12, year: 2027 }, 7, 'IN_APP')).toBe(
      'CARD_EXPIRING:pm1:2027-12:7:IN_APP',
    );
    // Sostituire la carta scaduta sulla stessa riga deve tornare a produrre
    // avvisi: è il motivo per cui il mese sta nella chiave.
    expect(cardExpiringKey('pm1', { month: 3, year: 2029 }, 30, 'EMAIL')).not.toBe(
      cardExpiringKey('pm1', { month: 3, year: 2027 }, 30, 'EMAIL'),
    );
  });

  it('lega le auto-pagate al giorno del giro', () => {
    expect(autoPaidKey('u1', d('2027-03-15'))).toBe('EXPENSE_DUE:autopaid:u1:2027-03-15:IN_APP');
    // Due giri nello stesso giorno: stessa chiave, quindi una sola notifica.
    expect(autoPaidKey('u1', d('2027-03-15'))).toBe(autoPaidKey('u1', d('2027-03-15')));
    expect(autoPaidKey('u1', d('2027-03-16'))).not.toBe(autoPaidKey('u1', d('2027-03-15')));
  });

  it('lega il riepilogo alla settimana e non al giorno', () => {
    expect(digestKey('u1', d('2027-03-15'))).toBe('DIGEST:u1:2027-W11:EMAIL');
    // Lunedì e mercoledì della stessa settimana: spostare il giorno di invio
    // non deve produrre un secondo riepilogo.
    expect(digestKey('u1', d('2027-03-17'))).toBe(digestKey('u1', d('2027-03-15')));
    expect(digestKey('u1', d('2027-03-22'))).not.toBe(digestKey('u1', d('2027-03-15')));
  });

  it('tiene separati due utenti', () => {
    expect(digestKey('u2', d('2027-03-15'))).not.toBe(digestKey('u1', d('2027-03-15')));
    expect(autoPaidKey('u2', d('2027-03-15'))).not.toBe(autoPaidKey('u1', d('2027-03-15')));
  });
});

describe('generi e canali', () => {
  it('ha un\u2019etichetta per ogni genere', () => {
    // `Record<ReminderKind, string>` lo garantisce a compilazione, ma l'enum di
    // Prisma no: questo controlla che l'elenco non sia rimasto indietro.
    for (const kind of REMINDER_KINDS) {
      expect(REMINDER_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  it('i generi con un produttore sono un sottoinsieme di quelli dichiarati', () => {
    for (const kind of REMINDER_TARGET_KINDS) {
      expect(REMINDER_KINDS).toContain(kind);
    }
    // `DOCUMENT_DUE` esiste nello schema ma non ha ancora chi lo produce, e
    // `DIGEST` non scatta su un anticipo.
    expect(REMINDER_TARGET_KINDS).not.toContain('DOCUMENT_DUE');
    expect(REMINDER_TARGET_KINDS).not.toContain('DIGEST');
  });

  it('avvisa della carta a trenta e a sette giorni', () => {
    expect([...CARD_EXPIRING_DAYS_BEFORE]).toEqual([30, 7]);
  });
});

const SETTINGS = {
  reminderDaysBefore: [30, 7, 1],
  cancellationReminderDaysBefore: [60, 30, 15],
};

function anOccurrence(
  dueDate: string,
  over: Partial<Omit<OccurrenceView, 'dueDate' | 'expense'>> & {
    expense?: Partial<OccurrenceView['expense']>;
  } = {},
): OccurrenceView {
  const { expense, ...rest } = over;
  return {
    id: 'occ1',
    dueDate: d(dueDate),
    status: 'PLANNED',
    grossCents: 1200,
    currency: 'EUR',
    expenseId: 'exp1',
    expenseName: 'Hosting',
    ...rest,
    expense: {
      status: 'ACTIVE',
      autoRenew: true,
      cancellationNoticeDays: null,
      cancelledAt: null,
      ...expense,
    },
  };
}

function aCard(over: Partial<PaymentMethodView> = {}): PaymentMethodView {
  return {
    id: 'pm1',
    label: 'Carta aziendale',
    expiryMonth: 3,
    expiryYear: 2027,
    isActive: true,
    activeExpenseCount: 2,
    ...over,
  };
}

function plan(today: string, over: Partial<Omit<PlanRemindersInput, 'today'>> = {}) {
  return planReminders({
    today: d(today),
    settings: SETTINGS,
    occurrences: [],
    paymentMethods: [],
    ...over,
  });
}

describe('scelta dell\u2019anticipo', () => {
  it('prende il pi\u00f9 piccolo fra quelli che coprono ancora i giorni che mancano', () => {
    expect(pickDaysBefore(30, [30, 7, 1])).toBe(30);
    expect(pickDaysBefore(29, [30, 7, 1])).toBe(30);
    expect(pickDaysBefore(8, [30, 7, 1])).toBe(30);
    expect(pickDaysBefore(7, [30, 7, 1])).toBe(7);
    expect(pickDaysBefore(2, [30, 7, 1])).toBe(7);
    expect(pickDaysBefore(1, [30, 7, 1])).toBe(1);
    // Il giorno stesso non apre un gradino nuovo: l'avviso a un giorno è già
    // partito ieri, e ripeterlo oggi sarebbe la seconda email che nessuno vuole.
    expect(pickDaysBefore(0, [30, 7, 1])).toBe(1);
  });

  it('non dipende dall\u2019ordine della lista', () => {
    expect(pickDaysBefore(2, [1, 30, 7])).toBe(7);
    expect(pickDaysBefore(2, [7, 1, 30])).toBe(7);
  });

  it('tace prima del primo gradino e dopo la scadenza', () => {
    expect(pickDaysBefore(31, [30, 7, 1])).toBeNull();
    expect(pickDaysBefore(-1, [30, 7, 1])).toBeNull();
    // Lista vuota: è il modo di spegnere quel promemoria.
    expect(pickDaysBefore(3, [])).toBeNull();
  });
});

describe('promemoria delle scadenze', () => {
  it('scatta una volta per gradino, e non una volta al giorno', () => {
    // Il 15 marzo con anticipi [30, 7, 1]: tre avvisi in tutto, non trenta.
    const days = [
      '2027-02-12',
      '2027-02-13',
      '2027-02-20',
      '2027-03-08',
      '2027-03-12',
      '2027-03-14',
      '2027-03-15',
      '2027-03-16',
    ];
    const keys = days.map((day) => {
      const [first] = plan(day, { occurrences: [anOccurrence('2027-03-15')] });
      return first?.keys.EMAIL ?? null;
    });

    expect(keys).toEqual([
      null, // 31 giorni: troppo presto
      'EXPENSE_DUE:occ1:30:EMAIL',
      'EXPENSE_DUE:occ1:30:EMAIL',
      'EXPENSE_DUE:occ1:7:EMAIL',
      'EXPENSE_DUE:occ1:7:EMAIL',
      'EXPENSE_DUE:occ1:1:EMAIL',
      'EXPENSE_DUE:occ1:1:EMAIL',
      null, // scaduta: non è più un promemoria, è un rimprovero
    ]);
    // Tre chiavi distinte su otto giorni, quindi tre avvisi.
    expect(new Set(keys.filter((key) => key !== null)).size).toBe(3);
  });

  it('non perde l\u2019avviso se il giro salta un giorno', () => {
    // Il processo è spento il 13 febbraio, cioè il giorno esatto del gradino.
    // Il giorno dopo l'avviso parte comunque, con la stessa chiave che avrebbe
    // avuto ieri: il giro saltato si fonde nel successivo.
    const [missed] = plan('2027-02-14', { occurrences: [anOccurrence('2027-03-15')] });
    expect(missed?.keys.EMAIL).toBe('EXPENSE_DUE:occ1:30:EMAIL');
    expect(missed?.daysRemaining).toBe(29);
    expect(missed?.daysBefore).toBe(30);
  });

  it('ignora quelle che non sono pi\u00f9 previste', () => {
    for (const status of ['PAID', 'SKIPPED', 'CANCELLED'] as const) {
      expect(plan('2027-03-08', { occurrences: [anOccurrence('2027-03-15', { status })] })).toEqual(
        [],
      );
    }
  });

  it('porta con s\u00e9 quello che serve a scrivere il testo', () => {
    const [reminder] = plan('2027-03-08', {
      occurrences: [anOccurrence('2027-03-15', { grossCents: 4990, currency: 'USD' })],
    });
    expect(reminder?.kind).toBe('EXPENSE_DUE');
    expect(reminder?.label).toBe('Hosting');
    expect(reminder?.grossCents).toBe(4990);
    expect(reminder?.currency).toBe('USD');
    expect(reminder?.expenseId).toBe('exp1');
    expect(formatIsoDate(reminder?.referenceDate ?? new Date(0))).toBe('2027-03-15');
  });
});

describe('promemoria di disdetta', () => {
  /** Rinnovo il 15 marzo con 60 giorni di preavviso: si disdice entro il 14 gennaio. */
  const renewing = (over: Partial<OccurrenceView['expense']> = {}): OccurrenceView =>
    anOccurrence('2027-03-15', {
      expense: { cancellationNoticeDays: 60, ...over },
    });

  it('conta i giorni dal termine di disdetta, non dal rinnovo', () => {
    const [reminder] = plan('2026-12-15', { occurrences: [renewing()] });
    expect(reminder?.kind).toBe('CANCELLATION_WINDOW');
    expect(formatIsoDate(reminder?.referenceDate ?? new Date(0))).toBe('2027-01-14');
    expect(formatIsoDate(reminder?.dueDate ?? new Date(0))).toBe('2027-03-15');
    expect(reminder?.daysRemaining).toBe(30);
    expect(reminder?.keys.EMAIL).toBe('CANCELLATION_WINDOW:occ1:30:EMAIL');
  });

  it('tace quando non c\u2019\u00e8 niente da disdire', () => {
    // Senza preavviso dichiarato non si sa entro quando, e inventare una data
    // sarebbe peggio del silenzio.
    expect(plan('2026-12-15', { occurrences: [anOccurrence('2027-03-15')] })).toEqual([]);
    // Senza rinnovo automatico il contratto finisce da solo.
    expect(
      plan('2026-12-15', { occurrences: [renewing({ autoRenew: false })] }).map((r) => r.kind),
    ).not.toContain('CANCELLATION_WINDOW');
    // Sospesa o già disdetta: insistere lascerebbe il dubbio di non aver
    // mandato davvero la disdetta.
    expect(
      plan('2026-12-15', { occurrences: [renewing({ status: 'PAUSED' })] }).map((r) => r.kind),
    ).not.toContain('CANCELLATION_WINDOW');
    expect(
      plan('2026-12-15', { occurrences: [renewing({ cancelledAt: d('2026-12-01') })] }).map(
        (r) => r.kind,
      ),
    ).not.toContain('CANCELLATION_WINDOW');
  });

  it('tace anche dopo il termine, mentre la scadenza continua', () => {
    // L'8 marzo il termine del 14 gennaio è passato da un pezzo: la disdetta
    // non è più un'azione possibile, ma la spesa si paga ancora e va ricordata.
    const kinds = plan('2027-03-08', { occurrences: [renewing()] }).map((r) => r.kind);
    expect(kinds).toEqual(['EXPENSE_DUE']);
  });

  it('avvisa solo sulla prima occorrenza prevista della spesa', () => {
    // Un mensile con sessanta giorni di preavviso ha tre finestre aperte
    // insieme: senza questo vincolo partirebbero tre avvisi per una disdetta
    // che si manda una volta sola.
    const monthly = ['2027-03-15', '2027-04-15', '2027-05-15'].map((due, index) =>
      anOccurrence(due, { id: `occ${String(index + 1)}`, expense: { cancellationNoticeDays: 60 } }),
    );
    const cancellations = plan('2027-01-10', { occurrences: monthly }).filter(
      (r) => r.kind === 'CANCELLATION_WINDOW',
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.occurrenceId).toBe('occ1');
  });

  it('non si fa ingannare dall\u2019ordine delle righe', () => {
    // «La prima» è la più vicina per data, non la prima che arriva dal database.
    const shuffled = [
      anOccurrence('2027-05-15', { id: 'occ3', expense: { cancellationNoticeDays: 60 } }),
      anOccurrence('2027-03-15', { id: 'occ1', expense: { cancellationNoticeDays: 60 } }),
      anOccurrence('2027-04-15', { id: 'occ2', expense: { cancellationNoticeDays: 60 } }),
    ];
    const [cancellation] = plan('2027-01-10', { occurrences: shuffled }).filter(
      (r) => r.kind === 'CANCELLATION_WINDOW',
    );
    expect(cancellation?.occurrenceId).toBe('occ1');
  });
});

describe('carta in scadenza', () => {
  it('considera valida tutta l\u2019ultima mensilit\u00e0', () => {
    // Una carta 03/2027 funziona fino al 31 marzo compreso. Contarla scaduta il
    // 1° marzo manderebbe l'avviso mentre la carta paga ancora.
    expect(formatIsoDate(lastValidDay(3, 2027))).toBe('2027-03-31');
    expect(formatIsoDate(lastValidDay(12, 2027))).toBe('2027-12-31');
  });

  it('avvisa a trenta e a sette giorni dall\u2019ultimo giorno valido', () => {
    const at = (today: string): string | null =>
      plan(today, { paymentMethods: [aCard()] })[0]?.keys.EMAIL ?? null;

    expect(at('2027-02-28')).toBeNull(); // 31 giorni: troppo presto
    expect(at('2027-03-01')).toBe('CARD_EXPIRING:pm1:2027-03:30:EMAIL');
    expect(at('2027-03-23')).toBe('CARD_EXPIRING:pm1:2027-03:30:EMAIL');
    expect(at('2027-03-24')).toBe('CARD_EXPIRING:pm1:2027-03:7:EMAIL');
    expect(at('2027-03-31')).toBe('CARD_EXPIRING:pm1:2027-03:7:EMAIL');
    expect(at('2027-04-01')).toBeNull(); // scaduta: ormai è un fatto, non un avviso
  });

  it('tace per una carta che non paga pi\u00f9 niente', () => {
    // Avvisare per una carta senza spese attive insegna a ignorare gli avvisi.
    expect(plan('2027-03-01', { paymentMethods: [aCard({ activeExpenseCount: 0 })] })).toEqual([]);
    expect(plan('2027-03-01', { paymentMethods: [aCard({ isActive: false })] })).toEqual([]);
    // Un contante o un bonifico non hanno scadenza da ricordare.
    expect(
      plan('2027-03-01', { paymentMethods: [aCard({ expiryMonth: null, expiryYear: null })] }),
    ).toEqual([]);
  });
});

describe('ordine dell\u2019uscita', () => {
  it('mette davanti le date pi\u00f9 vicine', () => {
    // Il testo dell'email elenca gli avvisi in fila: se l'ordine dipendesse da
    // come Postgres ha restituito le righe, due giri identici produrrebbero due
    // email diverse.
    const reminders = plan('2027-03-01', {
      occurrences: [
        anOccurrence('2027-03-28', { id: 'occ2', expenseName: 'Dominio' }),
        anOccurrence('2027-03-02', { id: 'occ1', expenseName: 'Hosting' }),
      ],
      paymentMethods: [aCard()],
    });
    expect(reminders.map((r) => r.label)).toEqual(['Hosting', 'Dominio', 'Carta aziendale']);
  });
});

