import { describe, expect, it } from 'vitest';

import { parseIsoDate } from './recurrence';
import {
  CARD_EXPIRING_DAYS_BEFORE,
  REMINDER_KINDS,
  REMINDER_KIND_LABELS,
  REMINDER_TARGET_KINDS,
  autoPaidKey,
  cancellationWindowKey,
  cardExpiringKey,
  digestKey,
  expenseDueKey,
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

  it('avvisa della carta in ordine decrescente', () => {
    // L'ordine conta: il motore sceglie il primo anticipo applicabile scorrendo
    // dal più lontano, e una lista disordinata darebbe la chiave sbagliata.
    expect([...CARD_EXPIRING_DAYS_BEFORE]).toEqual([30, 7]);
  });
});
