import { randomUUID } from 'node:crypto';

import { type ForecastRow, parseIsoDate } from '@easygest/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { buildApp } from '../app';
import { type Env, parseEnv } from '../config/env';
import { collectForecast } from './forecast';

/**
 * La regola ibrida, provata dove si può sbagliare in silenzio.
 *
 * Questo file sta accanto al servizio e non accanto alla rotta per una ragione
 * sola, e non è comodità: **«oggi» entra come parametro**. La rotta lo ricava
 * dal fuso dell'utente e dall'orologio, che è giusto in produzione e
 * inservibile in una prova — le stesse otto asserzioni scritte contro il
 * calendario vero direbbero cose diverse il 31 dicembre, e una di esse non
 * avrebbe nemmeno un passato da guardare se girasse il primo gennaio. Qui
 * `today` è il 15 marzo 2027 e ci resta.
 *
 * La prima prova è quella che conta: **lo storico non si inventa**. È la stessa
 * promessa di `services/occurrences.ts`, e se cade la pagina delle previsioni
 * mostra mesi di spese mai esistite con l'aria di essere dati veri.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let app: FastifyInstance;
let alice: string;
let bob: string;

const d = (value: string): Date => {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new Error(`Data di test non valida: ${value}`);
  return parsed;
};

/** Il giorno del taglio. Fisso: la previsione è relativa a «oggi». */
const TODAY = d('2027-03-15');
const YEAR = 2027;

const context = { baseCurrency: 'EUR', today: TODAY };

async function createUser(): Promise<string> {
  const user = await app.prisma.user.create({
    data: {
      email: `previsioni-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: 'non-usato',
      settings: { create: {} },
    },
    select: { id: true },
  });
  return user.id;
}

interface ExpenseOptions {
  userId?: string;
  name?: string;
  startDate: string;
  endDate?: string | null;
  unit?: 'ONE_OFF' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
  interval?: number;
  status?: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'ENDED';
  currency?: string;
  grossCents?: number;
  /** Le occorrenze già in tabella, con lo stato che hanno davvero. */
  occurrences?: { dueDate: string; status?: 'PLANNED' | 'PAID' | 'SKIPPED' | 'CANCELLED' }[];
}

async function anExpense(options: ExpenseOptions): Promise<string> {
  const userId = options.userId ?? alice;
  const gross = options.grossCents ?? 12_200;
  const expense = await app.prisma.expense.create({
    data: {
      userId,
      name: options.name ?? 'Hosting',
      netCents: 10_000,
      vatRateBp: 2200,
      grossCents: gross,
      currency: options.currency ?? 'EUR',
      recurrenceUnit: options.unit ?? 'MONTH',
      recurrenceInterval: options.interval ?? 1,
      startDate: d(options.startDate),
      endDate: options.endDate == null ? null : d(options.endDate),
      status: options.status ?? 'ACTIVE',
      occurrences: {
        create: (options.occurrences ?? []).map((row) => ({
          userId,
          dueDate: d(row.dueDate),
          netCents: 10_000,
          vatRateBp: 2200,
          grossCents: gross,
          currency: options.currency ?? 'EUR',
          baseGrossCents: gross,
          status: row.status ?? 'PLANNED',
        })),
      },
    },
    select: { id: true },
  });
  return expense.id;
}

async function forecast(userId = alice): Promise<ForecastRow[]> {
  return (await collectForecast(app.prisma, userId, YEAR, context)).rows;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  alice = await createUser();
  bob = await createUser();
});

afterEach(async () => {
  await app.prisma.expense.deleteMany({ where: { userId: { in: [alice, bob] } } });
  // Solo la valuta di prova. `XTS` è il codice ISO riservato ai collaudi, ed è
  // qui perché cancellare tutti gli `EUR→*` si porterebbe via i tassi degli
  // altri file di prova, che girano contro lo stesso database.
  await app.prisma.fxRate.deleteMany({ where: { base: 'EUR', quote: 'XTS' } });
});

afterAll(async () => {
  await app.prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await app.close();
});

it('non inventa lo storico: prima di oggi ci sono solo le righe che esistono', async () => {
  // La prova che regge l'intera regola. Un abbonamento registrato a marzo con
  // l'ancora a gennaio ha due mesi di passato che non sono mai esistiti: la
  // regola ingenua — «ogni data generata senza occorrenza reale è una
  // previsione» — li farebbe comparire con l'aria di essere dati veri.
  await anExpense({
    startDate: '2027-01-10',
    occurrences: [{ dueDate: '2027-03-10', status: 'PAID' }],
  });

  const rows = await forecast();
  const passate = rows.filter((row) => row.dueDate < '2027-03-15');

  expect(passate).toHaveLength(1);
  expect(passate[0]?.dueDate).toBe('2027-03-10');
  expect(passate[0]?.source).toBe('reale');
  expect(rows.some((row) => row.dueDate === '2027-01-10')).toBe(false);
  expect(rows.some((row) => row.dueDate === '2027-02-10')).toBe(false);
});

it('l’ancora spostata non produce un doppione nel mese già pagato', async () => {
  // Febbraio è stato pagato il 5; poi l'ancora è passata al 10, e il ricalcolo
  // delle occorrenze non ha toccato il passato — giustamente: la riga del 5 è
  // un pagamento avvenuto. Sintetizzare anche il 10 febbraio perché «la serie
  // lo prevede» conterebbe febbraio due volte, con la stessa spesa.
  await anExpense({
    startDate: '2027-02-10',
    occurrences: [{ dueDate: '2027-02-05', status: 'PAID' }],
  });

  const rows = await forecast();
  const febbraio = rows.filter((row) => row.dueDate.startsWith('2027-02'));

  expect(febbraio).toHaveLength(1);
  expect(febbraio[0]?.dueDate).toBe('2027-02-05');
  expect(febbraio[0]?.source).toBe('reale');
  // Il futuro invece parte dall'ancora nuova, come deve.
  expect(rows.some((row) => row.dueDate === '2027-04-10')).toBe(true);
});

it('sulla stessa data vince la reale, e la riga resta una', async () => {
  // Dentro l'orizzonte di `syncOccurrences` le righe ci sono già tutte: qui la
  // previsione deve limitarsi a riconoscerle, non a raddoppiarle.
  await anExpense({
    startDate: '2027-01-10',
    occurrences: [{ dueDate: '2027-04-10' }, { dueDate: '2027-05-10' }],
  });

  const rows = await forecast();
  const aprile = rows.filter((row) => row.dueDate === '2027-04-10');

  expect(aprile).toHaveLength(1);
  expect(aprile[0]?.source).toBe('reale');
  expect(aprile[0]?.occurrenceId).not.toBeNull();
  // Giugno invece non c'è in tabella: quella la sintetizza.
  const giugno = rows.filter((row) => row.dueDate === '2027-06-10');
  expect(giugno).toHaveLength(1);
  expect(giugno[0]?.source).toBe('previsione');
  expect(giugno[0]?.occurrenceId).toBeNull();
  expect(giugno[0]?.status).toBeNull();
});

it('una spesa in pausa pesa il suo passato e zero futuro', async () => {
  // È la lettura onesta di «sospesa»: quello che è già costato è costato, e
  // quello che verrà non verrà finché non la si riattiva.
  await anExpense({
    startDate: '2027-01-10',
    status: 'PAUSED',
    occurrences: [{ dueDate: '2027-02-10', status: 'PAID' }],
  });

  const rows = await forecast();

  expect(rows).toHaveLength(1);
  expect(rows[0]?.dueDate).toBe('2027-02-10');
  expect(rows.some((row) => row.source === 'previsione')).toBe(false);
});

it('la fine del contratto tronca il futuro a metà anno', async () => {
  await anExpense({ startDate: '2027-01-10', endDate: '2027-06-30' });

  const rows = await forecast();

  expect(rows.map((row) => row.dueDate)).toEqual(['2027-04-10', '2027-05-10', '2027-06-10']);
});

it('una spesa una tantum fuori anno non compare', async () => {
  await anExpense({ name: 'Dominio 2026', startDate: '2026-11-04', unit: 'ONE_OFF' });
  await anExpense({ name: 'Commercialista', startDate: '2027-09-30', unit: 'ONE_OFF' });

  const rows = await forecast();

  expect(rows).toHaveLength(1);
  expect(rows[0]?.expenseName).toBe('Commercialista');
  expect(rows[0]?.dueDate).toBe('2027-09-30');
});

it('converte il futuro in valuta estera con il cambio di oggi', async () => {
  // Non con quello della scadenza: il cambio del 10 dicembre 2027 non esiste, e
  // chiederlo darebbe il tasso di oggi dichiarato vecchio di nove mesi, quindi
  // rifiutato. Il gradino al confine di oggi è un prezzo dichiarato.
  await app.prisma.fxRate.create({
    data: { base: 'EUR', quote: 'XTS', date: d('2027-03-14'), rate: '0.5000000000' },
  });
  await anExpense({ startDate: '2027-01-10', currency: 'XTS', grossCents: 15_000 });

  const rows = await forecast();

  expect(rows).not.toHaveLength(0);
  expect(rows.every((row) => row.baseGrossCents === 7500)).toBe(true);
});

it('senza cambio dichiara la spesa invece di contarla zero', async () => {
  // Un totale che manca si vede; un totale sbagliato per difetto no. La
  // risposta resta valida, e la spesa esce dai totali dicendolo.
  await anExpense({ name: 'Dominio', startDate: '2027-01-10', currency: 'XTS' });

  const { rows, unconverted } = await collectForecast(app.prisma, alice, YEAR, context);

  expect(rows).toHaveLength(0);
  expect(unconverted).toHaveLength(1);
  expect(unconverted[0]?.expenseName).toBe('Dominio');
  expect(unconverted[0]?.currency).toBe('XTS');
});

it('non guarda le spese di un altro utente', async () => {
  await anExpense({ userId: bob, startDate: '2027-01-10' });

  expect(await forecast(alice)).toHaveLength(0);
  expect(await forecast(bob)).not.toHaveLength(0);
});

it('su un anno già chiuso non sintetizza niente', async () => {
  // Il futuro comincia dal più avanti fra oggi e il primo gennaio: sul 2026
  // cade oltre il 31 dicembre, e un anno passato è fatto solo di ciò che è
  // successo.
  await anExpense({
    startDate: '2026-01-10',
    occurrences: [{ dueDate: '2026-02-10', status: 'PAID' }],
  });

  const { rows } = await collectForecast(app.prisma, alice, 2026, context);

  expect(rows).toHaveLength(1);
  expect(rows[0]?.source).toBe('reale');
});
