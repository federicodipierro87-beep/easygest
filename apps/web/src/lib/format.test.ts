import { describe, expect, it } from 'vitest';

import {
  daysUntil,
  describeDue,
  euroFromCents,
  formatDay,
  isoPlusDays,
  parseEuro,
  parseInteger,
  parsePercent,
  percentFromBasisPoints,
  todayIso,
} from './format';

/**
 * I casi limite della formattazione.
 *
 * Non si prova che `formatCents` sappia mettere il simbolo dell'euro — lo prova
 * già `money.test.ts` — ma le due cose che questo modulo aggiunge davvero: che
 * un giorno di calendario non scivoli indietro di ventiquattro ore, e che una
 * casella vuota non venga scambiata per una casella sbagliata.
 */

describe('giorni di calendario', () => {
  it('non converte mai la data in un istante', () => {
    // È il punto dell'intero modulo: `new Date('2027-03-15')` è mezzanotte
    // UTC, e a ovest di Greenwich `toLocaleDateString` ne stampa il 14.
    // Lavorando sulla stringa il risultato non dipende da dove gira il test.
    expect(formatDay('2027-03-15')).toBe('15/03/2027');
    expect(formatDay('2027-01-01')).toBe('01/01/2027');
  });

  it('prende la parte di data anche da un istante completo', () => {
    expect(formatDay('2027-03-15T23:30:00.000Z')).toBe('15/03/2027');
  });

  it('mostra un trattino invece di niente', () => {
    expect(formatDay(null)).toBe('—');
    expect(formatDay(undefined)).toBe('—');
    expect(formatDay('')).toBe('—');
  });

  it('restituisce l’ingresso quando non è una data', () => {
    // Meglio far vedere il valore vero che un trattino che nasconde il guasto.
    expect(formatDay('domani')).toBe('domani');
  });
});

describe('aritmetica sui giorni', () => {
  it('somma giorni restando nella stessa forma', () => {
    expect(isoPlusDays('2027-03-15', 60)).toBe('2027-05-14');
    expect(isoPlusDays('2027-03-01', -1)).toBe('2027-02-28');
  });

  it('attraversa il 29 febbraio di un bisestile', () => {
    expect(isoPlusDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(isoPlusDays('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('conta i giorni mancanti col segno', () => {
    expect(daysUntil('2027-03-20', '2027-03-15')).toBe(5);
    expect(daysUntil('2027-03-15', '2027-03-15')).toBe(0);
    expect(daysUntil('2027-03-10', '2027-03-15')).toBe(-5);
  });

  it('non inventa una distanza da una data che non esiste', () => {
    expect(daysUntil('2027-02-30', '2027-03-15')).toBeNull();
  });

  it('produce una data leggibile da parseIsoDate', () => {
    // `todayIso` usa i getter locali: il giro completo deve tornare.
    const today = todayIso(new Date(2027, 2, 15, 0, 30));
    expect(today).toBe('2027-03-15');
  });
});

describe('distanza detta a parole', () => {
  it('usa gli avverbi per i tre giorni attorno a oggi', () => {
    expect(describeDue('2027-03-15', '2027-03-15')).toBe('oggi');
    expect(describeDue('2027-03-16', '2027-03-15')).toBe('domani');
    expect(describeDue('2027-03-14', '2027-03-15')).toBe('ieri');
  });

  it('conta i giorni negli altri casi, nel verso giusto', () => {
    expect(describeDue('2027-05-01', '2027-03-15')).toBe('fra 47 giorni');
    expect(describeDue('2027-03-01', '2027-03-15')).toBe('14 giorni fa');
  });
});

describe('lettura delle caselle numeriche', () => {
  it('distingue la casella vuota da quella sbagliata', () => {
    // È la ragione per cui queste funzioni esistono: al server arriva `null`
    // in entrambi i casi, e solo qui si sa quale dei due è.
    expect(parseEuro('')).toBeNull();
    expect(parseEuro('   ')).toBeNull();
    expect(parseEuro('dodici e cinquanta')).toBe('invalido');
  });

  it('accetta le forme che una persona digita davvero', () => {
    expect(parseEuro('1.234,56')).toBe(123_456);
    expect(parseEuro('1234.56')).toBe(123_456);
    expect(parseEuro('€ 49,90')).toBe(4990);
    expect(parseEuro('12')).toBe(1200);
  });

  it('legge una percentuale come legge un importo', () => {
    // Stessa conversione: due decimali su una base intera. 22,5% sono 2250
    // basis point come 22,50 € sono 2250 centesimi.
    expect(parsePercent('22')).toBe(2200);
    expect(parsePercent('22,5')).toBe(2250);
    expect(parsePercent('22,5%')).toBe(2250);
    expect(parsePercent('')).toBeNull();
    expect(parsePercent('un quinto')).toBe('invalido');
  });

  it('vuole un intero e niente altro per i conteggi', () => {
    expect(parseInteger('60')).toBe(60);
    expect(parseInteger('0')).toBe(0);
    expect(parseInteger('')).toBeNull();
    // Un preavviso di due giorni e mezzo non è un preavviso: qui `1,5` è un
    // errore, mentre in una casella di importo sarebbe legittimo.
    expect(parseInteger('1,5')).toBe('invalido');
    expect(parseInteger('-3')).toBe('invalido');
  });
});

describe('scrittura nelle caselle', () => {
  it('rimette il valore nella forma in cui si rilegge', () => {
    expect(euroFromCents(123_456)).toBe('1234,56');
    expect(euroFromCents(4990)).toBe('49,90');
    expect(euroFromCents(null)).toBe('');
    expect(percentFromBasisPoints(2200)).toBe('22,00');
  });

  it('fa il giro completo senza perdere niente', () => {
    for (const cents of [0, 1, 4990, 123_456, 100_000_000]) {
      expect(parseEuro(euroFromCents(cents))).toBe(cents);
    }
  });
});
