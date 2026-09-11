import { describe, expect, it } from 'vitest';

import {
  DIGEST_DAY_LABELS,
  MAX_REMINDER_DAYS_BEFORE,
  TIMEZONE_CHOICES,
  formatDaysBefore,
  parseDaysBefore,
  settingsPatchSchema,
} from './settings';

describe('normalizzazione degli anticipi', () => {
  it('toglie i doppioni e ordina dal pi\u00f9 lontano al pi\u00f9 vicino', () => {
    // È il comportamento che tiene in piedi la deduplica: due liste che
    // descrivono la stessa configurazione devono produrre le stesse chiavi.
    const parsed = settingsPatchSchema.parse({ reminderDaysBefore: [7, 30, 7] });
    expect(parsed.reminderDaysBefore).toEqual([30, 7]);
  });

  it('riordina anche una lista scritta al contrario', () => {
    const parsed = settingsPatchSchema.parse({ reminderDaysBefore: [1, 7, 30] });
    expect(parsed.reminderDaysBefore).toEqual([30, 7, 1]);
  });

  it('accetta la lista vuota, che \u00e8 il modo di spegnere il promemoria', () => {
    const parsed = settingsPatchSchema.parse({ reminderDaysBefore: [] });
    expect(parsed.reminderDaysBefore).toEqual([]);
  });

  it('accetta lo zero: avvisare il giorno stesso \u00e8 legittimo', () => {
    const parsed = settingsPatchSchema.parse({ reminderDaysBefore: [0] });
    expect(parsed.reminderDaysBefore).toEqual([0]);
  });

  it('rifiuta i giorni negativi', () => {
    expect(settingsPatchSchema.safeParse({ reminderDaysBefore: [-1] }).success).toBe(false);
  });

  it('rifiuta i giorni non interi', () => {
    expect(settingsPatchSchema.safeParse({ reminderDaysBefore: [7.5] }).success).toBe(false);
  });

  it('ferma le scadenze oltre l\u2019anno', () => {
    expect(settingsPatchSchema.safeParse({ reminderDaysBefore: [365] }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ reminderDaysBefore: [366] }).success).toBe(false);
  });

  it('lascia le disdette arrivare a due anni', () => {
    // Coerente con `cancellationNoticeDays` sulla spesa: se si può registrare
    // un preavviso di due anni, si deve poterne chiedere l'avviso.
    expect(settingsPatchSchema.safeParse({ cancellationReminderDaysBefore: [730] }).success).toBe(
      true,
    );
    expect(settingsPatchSchema.safeParse({ cancellationReminderDaysBefore: [731] }).success).toBe(
      false,
    );
  });

  it('non accetta pi\u00f9 di sei anticipi', () => {
    const six = [180, 90, 60, 30, 7, 1];
    expect(six).toHaveLength(MAX_REMINDER_DAYS_BEFORE);
    expect(settingsPatchSchema.safeParse({ reminderDaysBefore: six }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ reminderDaysBefore: [...six, 0] }).success).toBe(false);
  });
});

describe('fuso orario', () => {
  it('accetta i fusi che il motore sa poi usare davvero', () => {
    for (const zone of TIMEZONE_CHOICES) {
      expect(settingsPatchSchema.safeParse({ timezone: zone }).success).toBe(true);
    }
  });

  it('rifiuta un fuso inventato', () => {
    expect(settingsPatchSchema.safeParse({ timezone: 'Europe/Atlantide' }).success).toBe(false);
  });

  it('rifiuta la stringa vuota', () => {
    expect(settingsPatchSchema.safeParse({ timezone: '' }).success).toBe(false);
  });
});

describe('giorno del riepilogo', () => {
  it('va da luned\u00ec a domenica, come ISO', () => {
    expect(settingsPatchSchema.safeParse({ digestDayOfWeek: 1 }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ digestDayOfWeek: 7 }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ digestDayOfWeek: 0 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ digestDayOfWeek: 8 }).success).toBe(false);
  });

  it('ha un\u2019etichetta per ogni giorno valido', () => {
    for (let day = 1; day <= 7; day += 1) {
      expect(DIGEST_DAY_LABELS[day]).toBeTruthy();
    }
  });
});

describe('forma della modifica', () => {
  it('lascia passare un oggetto vuoto', () => {
    // Un `PATCH` senza campi non è un errore: è una chiamata che non cambia
    // niente, e rifiutarla costringerebbe il form a saperlo prima di inviare.
    expect(settingsPatchSchema.parse({})).toEqual({});
  });

  it('rifiuta i campi che non esistono', () => {
    // `strictObject`: `digestDay` invece di `digestDayOfWeek` verrebbe
    // ignorato in silenzio, e il salvataggio sembrerebbe riuscito.
    expect(settingsPatchSchema.safeParse({ digestDay: 3 }).success).toBe(false);
  });

  it('non lascia cambiare la valuta di riferimento', () => {
    // I cambi sono congelati sulle occorrenze: cambiarla renderebbe
    // incomparabili i `baseGrossCents` già scritti, senza alcun errore.
    expect(settingsPatchSchema.safeParse({ baseCurrency: 'USD' }).success).toBe(false);
  });
});

describe('anticipi come testo', () => {
  it('legge una lista separata da virgole', () => {
    expect(parseDaysBefore('30, 7, 1')).toEqual([30, 7, 1]);
  });

  it('tollera spazi in eccesso ma non parole', () => {
    expect(parseDaysBefore('  30 ,7 ')).toEqual([30, 7]);
    expect(parseDaysBefore('30, sette')).toBeNull();
  });

  it('legge la casella vuota come nessun anticipo', () => {
    expect(parseDaysBefore('   ')).toEqual([]);
  });

  it('rifiuta una virgola penzolante invece di indovinare', () => {
    expect(parseDaysBefore('30,')).toBeNull();
  });

  it('riscrive quello che lo schema ha normalizzato', () => {
    const parsed = settingsPatchSchema.parse({ reminderDaysBefore: [7, 30, 7] });
    expect(formatDaysBefore(parsed.reminderDaysBefore ?? [])).toBe('30, 7');
  });
});
