import { parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { ResourceError } from '../lib/resources';
import { syncFxRates } from './frankfurter';
import { MAX_RATE_STALENESS_DAYS, convertToBase, findRate } from './fx';

/**
 * I cambi si provano contro il database vero, non contro un finto.
 *
 * La regola che conta — «il tasso più recente non successivo alla data» — è una
 * query con un `orderBy` e un `lte`, cioè esattamente il genere di cosa che un
 * doppio in memoria confermerebbe anche se la query fosse sbagliata.
 *
 * La rete invece è finta, e deve esserlo: una suite che chiama la BCE fallisce
 * quando la BCE è giù, e sarebbe un test di Frankfurter, non nostro.
 *
 * I cambi sono l'unica tabella senza proprietario: non c'è un `userId` da cui
 * partire, quindi l'isolamento fra file che girano in parallelo non può essere
 * la riga come altrove — dev'essere la valuta. Questo file possiede quelle
 * dichiarate qui sotto, nessun altro file le nomina, e sia la pulizia sia i
 * conteggi si fermano a quelle. Senza, il `deleteMany` di un file porterebbe
 * via a metà corsa i tassi su cui un altro sta facendo le sue asserzioni.
 *
 * Sono corone e yen e non dollari perché la suite gira sullo stesso database
 * dello sviluppo: `seed:demo` scrive dollari, sterline e franchi, e una pulizia
 * che li comprendesse svuoterebbe i cambi dei dati dimostrativi a ogni `npm
 * test`. Quale valuta sia non cambia niente a ciò che si prova qui — il verso
 * della divisione e l'arrotondamento sono gli stessi per tutte.
 */

/** Le valute di questo file. Chi ne aggiunge una la aggiunge anche qui. */
const OWNED = ['SEK', 'NOK', 'JPY'];

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
});

afterEach(async () => {
  await app.prisma.fxRate.deleteMany({ where: { quote: { in: OWNED } } });
});

afterAll(async () => {
  await app.close();
});

async function seedRate(quote: string, date: string, rate: string): Promise<void> {
  await app.prisma.fxRate.create({
    data: { base: 'EUR', quote, date: d(date), rate, source: 'test' },
  });
}

describe('ricerca del tasso', () => {
  it('la stessa valuta vale uno senza cercare niente', async () => {
    // Non c'è nessuna riga in tabella: se andasse a cercarla, fallirebbe.
    const resolved = await findRate(app.prisma, 'EUR', 'EUR', d('2027-03-15'));
    expect(resolved?.rate).toBe('1');
  });

  it('prende il tasso del giorno quando c\u2019\u00e8', async () => {
    await seedRate('SEK', '2027-03-15', '0.9200000000');
    const resolved = await findRate(app.prisma, 'EUR', 'SEK', d('2027-03-15'));
    expect(resolved?.rate).toBe('0.92');
  });

  it('per un giorno festivo guarda indietro, non avanti', async () => {
    // Il 13 marzo 2027 è un sabato: il tasso buono è quello di venerdì.
    // Quello di lunedì esiste già in tabella e non dev'essere scelto: a
    // sabato non era ancora stato pubblicato.
    await seedRate('SEK', '2027-03-12', '0.9100000000');
    await seedRate('SEK', '2027-03-15', '0.9300000000');

    const resolved = await findRate(app.prisma, 'EUR', 'SEK', d('2027-03-13'));
    expect(resolved?.rate).toBe('0.91');
  });

  it('rinuncia se l\u2019unico tasso \u00e8 troppo vecchio', async () => {
    await seedRate('SEK', '2027-01-01', '0.9200000000');
    const resolved = await findRate(app.prisma, 'EUR', 'SEK', d('2027-01-01'));
    expect(resolved).not.toBeNull();

    const tooOld = new Date(d('2027-01-01'));
    tooOld.setUTCDate(tooOld.getUTCDate() + MAX_RATE_STALENESS_DAYS + 1);
    expect(await findRate(app.prisma, 'EUR', 'SEK', tooOld)).toBeNull();
  });

  it('non trova niente per una valuta mai sincronizzata', async () => {
    await seedRate('SEK', '2027-03-15', '0.9200000000');
    expect(await findRate(app.prisma, 'EUR', 'JPY', d('2027-03-15'))).toBeNull();
  });
});

describe('conversione', () => {
  it('nella valuta base non converte e non scrive un tasso', async () => {
    // `null` e non `1`: dire «cambio 1» farebbe credere a una conversione
    // che non è avvenuta.
    const result = await convertToBase(app.prisma, 12_200, 'EUR', 'EUR', d('2027-03-15'));
    expect(result).toEqual({ baseCents: 12_200, fxRate: null });
  });

  it('converte e restituisce il tasso da congelare', async () => {
    await seedRate('SEK', '2027-03-15', '0.9200000000');
    const result = await convertToBase(app.prisma, 10_000, 'SEK', 'EUR', d('2027-03-15'));
    expect(result.baseCents).toBe(9_200);
    expect(result.fxRate).toBe('0.92');
  });

  it('arrotonda half-up, non tronca', async () => {
    // 10000 × 0,9250505050 = 9250,50505 → 9251 se si arrotonda, 9250 se si
    // tronca. Il mezzo centesimo esiste e va da qualche parte.
    await seedRate('SEK', '2027-03-15', '0.9250505050');
    const result = await convertToBase(app.prisma, 10_001, 'SEK', 'EUR', d('2027-03-15'));
    expect(result.baseCents).toBe(9_251);
  });

  it('protesta invece di fingere un cambio alla pari', async () => {
    // Il fallimento è il punto: convertire a 1:1 produrrebbe un report
    // sbagliato che nessuno andrebbe mai a controllare.
    await expect(
      convertToBase(app.prisma, 10_000, 'SEK', 'EUR', d('2027-03-15')),
    ).rejects.toBeInstanceOf(ResourceError);
  });
});

describe('sincronizzazione da Frankfurter', () => {
  /** La risposta vera del servizio, nel verso in cui la pubblica lui. */
  const respond = (date: string, rates: Record<string, number>) => () =>
    Promise.resolve({ amount: 1, base: 'EUR', date, rates });

  it('rovescia il tasso nel verso che serve alla conversione', async () => {
    // Frankfurter dice «un euro vale 1,25 corone»; a noi serve «una corona
    // vale 0,8 euro», che è il fattore per cui si moltiplica.
    await syncFxRates(app.prisma, {
      currencies: ['SEK'],
      on: d('2027-03-15'),
      fetcher: respond('2027-03-15', { SEK: 1.25 }),
    });

    const resolved = await findRate(app.prisma, 'EUR', 'SEK', d('2027-03-15'));
    expect(resolved?.rate).toBe('0.8');
  });

  it('rilanciata due volte non duplica e non fallisce', async () => {
    const fetcher = respond('2027-03-15', { SEK: 1.25, NOK: 0.85 });
    const first = await syncFxRates(app.prisma, {
      currencies: ['SEK', 'NOK'],
      on: d('2027-03-15'),
      fetcher,
    });
    const second = await syncFxRates(app.prisma, {
      currencies: ['SEK', 'NOK'],
      on: d('2027-03-15'),
      fetcher,
    });

    expect(first.written).toBe(2);
    expect(second.written).toBe(0);
    expect(await app.prisma.fxRate.count({ where: { quote: { in: OWNED } } })).toBe(2);
  });

  it('registra il giorno che dice la risposta, non quello richiesto', async () => {
    // Chiedere i tassi di domenica restituisce quelli di venerdì: scriverli
    // sotto domenica farebbe credere che siano stati pubblicati quel giorno.
    const result = await syncFxRates(app.prisma, {
      currencies: ['SEK'],
      on: d('2027-03-14'),
      fetcher: respond('2027-03-12', { SEK: 1.25 }),
    });

    expect(result.date).toEqual(d('2027-03-12'));
    const row = await app.prisma.fxRate.findFirst({
      where: { quote: 'SEK' },
      select: { date: true },
    });
    expect(row?.date).toEqual(d('2027-03-12'));
  });

  it('non chiede la valuta base a s\u00e9 stessa', async () => {
    const result = await syncFxRates(app.prisma, {
      currencies: ['EUR'],
      on: d('2027-03-15'),
      fetcher: () => Promise.reject(new Error('non doveva chiamare la rete')),
    });
    expect(result.written).toBe(0);
  });

  it('si ferma se la risposta non ha la forma attesa', async () => {
    await expect(
      syncFxRates(app.prisma, {
        currencies: ['SEK'],
        on: d('2027-03-15'),
        fetcher: () => Promise.resolve({ messaggio: 'servizio in manutenzione' }),
      }),
    ).rejects.toThrow(/non riconosciuta/);
  });
});
