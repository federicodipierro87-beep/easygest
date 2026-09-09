/**
 * Dati dimostrativi: fornitori, clienti, carte e una trentina di spese vere.
 *
 * Separato da `seed.ts` di proposito. Quello crea il minimo per entrare
 * nell'applicazione ed è pensato per girare anche in produzione; questo riempie
 * il database di roba inventata, e i due non devono poter essere confusi.
 *
 *   npm run seed:demo -w @easygest/api
 *
 * È idempotente per nome: una spesa che c'è già non viene ricreata né
 * modificata, così rilanciarlo dopo aver sistemato qualcosa a mano non disfa il
 * lavoro. Per ripartire da zero c'è `--reset`, che cancella **solo** le spese
 * di questo file.
 *
 * Lo storico invece viene scritto qui, non generato dal motore. Non è una
 * scorciatoia: `syncOccurrences` non materializza il passato di proposito,
 * perché per una spesa vera quelle righe sarebbero debiti mai pagati. In una
 * dimostrazione il passato serve — senza, ogni report è vuoto — e importarlo è
 * appunto il lavoro che il motore lascia a chi ha i dati.
 */
import 'dotenv/config';

import {
  type ExpenseStatus,
  type RebillMode,
  type RecurrenceUnit,
  addDays,
  generateSchedule,
  occurrencePeriod,
  resolveAmount,
  startOfUtcDay,
} from '@easygest/shared';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';
import { convertToBase } from '../src/services/fx';
import { occurrenceContext, syncOccurrences } from '../src/services/occurrences';

const DEFAULT_EMAIL = 'federico.dipierro87@gmail.com';

/**
 * Cambi di comodo, scritti solo se non ce ne sono già.
 *
 * Sono verosimili, non veri. Quelli veri si prendono con `npm run fx:sync`, e
 * se sono già stati presi vincono loro: `skipDuplicates` sul vincolo
 * `(base, quote, date)` fa sì che questo seed non li sovrascriva.
 */
const DEMO_RATES = [
  { quote: 'USD', rate: '0.9200000000' },
  { quote: 'GBP', rate: '1.1800000000' },
  { quote: 'CHF', rate: '1.0500000000' },
] as const;

const VENDORS = [
  'Hetzner',
  'Aruba',
  'Cloudflare',
  'JetBrains',
  'GitHub',
  'Adobe',
  'Google',
  'Microsoft',
  'Backblaze',
  'Fastweb',
  'Zoom',
  'TeamViewer',
  'Namecheap',
  'Poste Italiane',
] as const;

const CLIENTS = [
  { name: 'Studio Legale Marchetti', city: 'Bologna', vatNumber: '02654180376' },
  { name: 'Ferretti Impianti', city: 'Modena', vatNumber: '02347560368' },
  { name: 'Cooperativa Sole', city: 'Reggio Emilia', vatNumber: '01598430351' },
  { name: 'Bianchi Costruzioni', city: 'Parma', vatNumber: '02128790344' },
  { name: 'NovaTech', city: 'Milano', vatNumber: '09876540961' },
] as const;

const PAYMENT_METHODS = [
  { label: 'Visa Business ***4821', type: 'CARD', last4: '4821', expiryMonth: 7, expiryYear: 2029 },
  { label: 'Revolut ***9032', type: 'CARD', last4: '9032', expiryMonth: 3, expiryYear: 2028 },
  { label: 'Bonifico SEPA', type: 'BANK_TRANSFER' },
  { label: 'Addebito diretto SDD', type: 'SEPA_DIRECT_DEBIT' },
] as const;

/**
 * Una spesa da creare, con il giorno d'inizio espresso in mesi da oggi.
 *
 * Relativo e non assoluto perché il seed deve produrre gli stessi dati fra un
 * anno: date fisse renderebbero «scaduta da tre mesi» una cosa che col tempo
 * diventa «scaduta da tre anni», e l'ultima colonna del calendario resterebbe
 * vuota.
 */
interface Spec {
  name: string;
  /** Mesi da oggi: negativo nel passato. */
  startsIn: number;
  /** Mesi da oggi in cui il contratto finisce, se finisce. */
  endsIn?: number;

  vendor?: (typeof VENDORS)[number];
  category?: string;
  client?: (typeof CLIENTS)[number]['name'];
  payment?: (typeof PAYMENT_METHODS)[number]['label'];

  netCents?: number;
  grossCents?: number;
  vatRateBp?: number;
  currency?: string;

  recurrenceUnit?: RecurrenceUnit;
  recurrenceInterval?: number;

  status?: ExpenseStatus;
  cancellationNoticeDays?: number;
  /** Disdetta già inviata: ferma i promemoria senza chiudere la spesa. */
  cancelled?: boolean;

  rebillMode?: RebillMode;
  rebillMarkupBp?: number;
  rebillAmountCents?: number;

  notes?: string;
}

const EXPENSES: readonly Spec[] = [
  // ── Infrastruttura, il grosso del ricorrente mensile ────────────────────
  {
    name: 'Server dedicato AX41',
    startsIn: -26,
    vendor: 'Hetzner',
    category: 'Hosting e server',
    payment: 'Visa Business ***4821',
    grossCents: 4_490,
    vatRateBp: 0,
    notes: 'IVA non applicata: reverse charge intracomunitario.',
  },
  {
    name: 'Hosting condiviso clienti',
    startsIn: -19,
    vendor: 'Aruba',
    category: 'Hosting e server',
    payment: 'Bonifico SEPA',
    netCents: 24_900,
    client: 'Studio Legale Marchetti',
    rebillMode: 'MARKUP',
    rebillMarkupBp: 2000,
  },
  {
    name: 'Cloudflare Pro',
    startsIn: -14,
    vendor: 'Cloudflare',
    category: 'Hosting e server',
    payment: 'Revolut ***9032',
    grossCents: 2_000,
    currency: 'USD',
    vatRateBp: 0,
    client: 'NovaTech',
    rebillMode: 'PASSTHROUGH',
  },
  {
    name: 'Backup offsite B2',
    startsIn: -22,
    vendor: 'Backblaze',
    category: 'Backup e storage',
    payment: 'Revolut ***9032',
    grossCents: 1_150,
    currency: 'USD',
    vatRateBp: 0,
  },
  {
    name: 'Google Workspace',
    startsIn: -31,
    vendor: 'Google',
    category: 'SaaS e abbonamenti',
    payment: 'Visa Business ***4821',
    netCents: 1_150,
  },
  {
    name: 'Microsoft 365 Business',
    startsIn: -11,
    vendor: 'Microsoft',
    category: 'Licenze software',
    payment: 'Visa Business ***4821',
    netCents: 1_030,
  },
  {
    name: 'GitHub Team',
    startsIn: -8,
    vendor: 'GitHub',
    category: 'SaaS e abbonamenti',
    payment: 'Revolut ***9032',
    grossCents: 800,
    currency: 'USD',
    vatRateBp: 0,
  },
  {
    name: 'Adobe Creative Cloud',
    startsIn: -5,
    vendor: 'Adobe',
    category: 'Licenze software',
    payment: 'Visa Business ***4821',
    netCents: 6_099,
    status: 'PAUSED',
    notes: 'Sospeso finché non riparte il lavoro grafico.',
  },
  {
    name: 'Zoom Pro',
    startsIn: -13,
    vendor: 'Zoom',
    category: 'SaaS e abbonamenti',
    payment: 'Revolut ***9032',
    grossCents: 1_599,
    currency: 'USD',
    vatRateBp: 0,
    status: 'CANCELLED',
    cancelled: true,
    notes: 'Disdetto: si usa Meet, incluso in Workspace.',
  },
  {
    name: 'Fibra studio 1 Gbps',
    startsIn: -29,
    vendor: 'Fastweb',
    category: 'Connettività',
    payment: 'Addebito diretto SDD',
    grossCents: 3_990,
    cancellationNoticeDays: 30,
  },

  // ── Annuali, dove il preavviso di disdetta conta ─────────────────────────
  {
    name: 'JetBrains All Products Pack',
    startsIn: -7,
    vendor: 'JetBrains',
    category: 'Licenze software',
    payment: 'Visa Business ***4821',
    recurrenceUnit: 'YEAR',
    netCents: 28_900,
    cancellationNoticeDays: 30,
  },
  {
    name: 'Dominio easygest.it',
    startsIn: -4,
    vendor: 'Aruba',
    category: 'Domini',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'YEAR',
    netCents: 1_490,
    cancellationNoticeDays: 15,
  },
  {
    name: 'Domini clienti (pacchetto)',
    startsIn: -2,
    vendor: 'Namecheap',
    category: 'Domini',
    payment: 'Revolut ***9032',
    recurrenceUnit: 'YEAR',
    grossCents: 24_600,
    currency: 'USD',
    vatRateBp: 0,
    client: 'Ferretti Impianti',
    rebillMode: 'FIXED',
    rebillAmountCents: 30_000,
  },
  {
    name: 'Certificato wildcard',
    startsIn: 2,
    vendor: 'Aruba',
    category: 'Certificati SSL',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'YEAR',
    netCents: 12_000,
    client: 'Bianchi Costruzioni',
    rebillMode: 'PASSTHROUGH',
    cancellationNoticeDays: 60,
  },
  {
    name: 'TeamViewer Business',
    startsIn: -9,
    vendor: 'TeamViewer',
    category: 'Licenze software',
    payment: 'Visa Business ***4821',
    recurrenceUnit: 'YEAR',
    netCents: 41_880,
    cancellationNoticeDays: 60,
    notes: 'Rinnovo tacito: la finestra di disdetta è quella che conta.',
  },
  {
    name: 'PEC e firma digitale',
    startsIn: -16,
    vendor: 'Poste Italiane',
    category: 'SaaS e abbonamenti',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'YEAR',
    netCents: 4_500,
  },
  {
    name: 'Licenza monitoraggio CHF',
    startsIn: -3,
    vendor: 'Hetzner',
    category: 'SaaS e abbonamenti',
    payment: 'Revolut ***9032',
    recurrenceUnit: 'YEAR',
    grossCents: 19_000,
    currency: 'CHF',
    vatRateBp: 0,
  },
  {
    name: 'Assistenza remota UK',
    startsIn: -6,
    vendor: 'TeamViewer',
    category: 'Consulenze',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'YEAR',
    grossCents: 15_000,
    currency: 'GBP',
    vatRateBp: 0,
    client: 'NovaTech',
    rebillMode: 'MARKUP',
    rebillMarkupBp: 1500,
  },

  // ── Ritmi diversi dal mensile ────────────────────────────────────────────
  {
    name: 'Sopralluogo settimanale sede',
    startsIn: -3,
    category: 'Consulenze',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'WEEK',
    netCents: 8_000,
    client: 'Ferretti Impianti',
    rebillMode: 'PASSTHROUGH',
  },
  {
    name: 'Noleggio workstation a giorni',
    startsIn: 0,
    // Con una fine, altrimenti tredici mesi di quotidiano sono quattrocento
    // righe che non raccontano niente in più delle prime venti.
    endsIn: 1,
    category: 'Hardware',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'DAY',
    netCents: 4_500,
    client: 'Bianchi Costruzioni',
    rebillMode: 'MARKUP',
    rebillMarkupBp: 1000,
    notes: 'Solo per la durata del cantiere.',
  },
  {
    name: 'Manutenzione trimestrale',
    startsIn: -12,
    category: 'Consulenze',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'MONTH',
    recurrenceInterval: 3,
    netCents: 45_000,
    client: 'Cooperativa Sole',
    rebillMode: 'FIXED',
    rebillAmountCents: 60_000,
  },
  {
    name: 'Revisione semestrale backup',
    startsIn: -18,
    category: 'Backup e storage',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'MONTH',
    recurrenceInterval: 6,
    netCents: 22_000,
  },

  // ── Una tantum ───────────────────────────────────────────────────────────
  {
    name: 'MacBook Pro 14"',
    startsIn: -10,
    category: 'Hardware',
    payment: 'Visa Business ***4821',
    recurrenceUnit: 'ONE_OFF',
    netCents: 249_900,
  },
  {
    name: 'Monitor 27" 4K',
    startsIn: -10,
    category: 'Hardware',
    payment: 'Visa Business ***4821',
    recurrenceUnit: 'ONE_OFF',
    netCents: 54_900,
  },
  {
    name: 'Corso Kubernetes',
    startsIn: -21,
    category: 'Formazione',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'ONE_OFF',
    netCents: 129_000,
  },
  {
    name: 'Consulenza fiscale straordinaria',
    startsIn: 1,
    category: 'Consulenze',
    payment: 'Bonifico SEPA',
    recurrenceUnit: 'ONE_OFF',
    netCents: 80_000,
  },
  {
    name: 'Commissioni conto business',
    startsIn: -30,
    category: 'Commissioni bancarie',
    payment: 'Addebito diretto SDD',
    grossCents: 600,
    vatRateBp: 0,
  },
] as const;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL non impostata: il seed non sa su quale database scrivere.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: 2 }),
  });

  try {
    const email = process.env.SEED_USER_EMAIL ?? DEFAULT_EMAIL;
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user === null) {
      throw new Error(`Nessun utente ${email}: lancia prima «npm run seed -w @easygest/api».`);
    }
    const userId = user.id;

    if (process.argv.includes('--reset')) {
      const names = EXPENSES.map((spec) => spec.name);
      const { count } = await prisma.expense.deleteMany({ where: { userId, name: { in: names } } });
      console.log(`Cancellate ${String(count)} spese dimostrative precedenti.`);
    }

    const context = await occurrenceContext(prisma, userId);
    const today = context.today;

    await prisma.fxRate.createMany({
      data: DEMO_RATES.map((entry) => ({
        base: 'EUR',
        quote: entry.quote,
        date: today,
        rate: entry.rate,
        source: 'demo',
      })),
      skipDuplicates: true,
    });

    const vendors = await upsertVendors(prisma, userId);
    const clients = await upsertClients(prisma, userId);
    const payments = await upsertPaymentMethods(prisma, userId);
    const categories = new Map(
      (await prisma.category.findMany({ where: { userId }, select: { id: true, name: true } })).map(
        (row) => [row.name, row.id],
      ),
    );

    let created = 0;
    let skipped = 0;
    let backfilled = 0;
    let scheduled = 0;

    for (const spec of EXPENSES) {
      const already = await prisma.expense.findFirst({
        where: { userId, name: spec.name },
        select: { id: true },
      });
      if (already !== null) {
        skipped += 1;
        continue;
      }

      const startDate = startOfUtcDay(addMonthsFromToday(today, spec.startsIn));
      const vatRateBp = spec.vatRateBp ?? 2200;
      const amount = resolveAmount({
        netCents: spec.netCents,
        grossCents: spec.grossCents,
        vatRateBp,
      });

      const expense = await prisma.expense.create({
        data: {
          userId,
          name: spec.name,
          notes: spec.notes ?? null,
          vendorId: spec.vendor === undefined ? null : (vendors.get(spec.vendor) ?? null),
          categoryId: spec.category === undefined ? null : (categories.get(spec.category) ?? null),
          clientId: spec.client === undefined ? null : (clients.get(spec.client) ?? null),
          paymentMethodId: spec.payment === undefined ? null : (payments.get(spec.payment) ?? null),
          netCents: amount.netCents,
          grossCents: amount.grossCents,
          vatRateBp,
          currency: spec.currency ?? 'EUR',
          recurrenceUnit: spec.recurrenceUnit ?? 'MONTH',
          recurrenceInterval: spec.recurrenceInterval ?? 1,
          startDate,
          endDate:
            spec.endsIn === undefined
              ? null
              : startOfUtcDay(addMonthsFromToday(today, spec.endsIn)),
          status: spec.status ?? 'ACTIVE',
          cancellationNoticeDays: spec.cancellationNoticeDays ?? null,
          cancelledAt: spec.cancelled === true ? today : null,
          rebillMode: spec.rebillMode ?? 'NONE',
          rebillMarkupBp: spec.rebillMarkupBp ?? null,
          rebillAmountCents: spec.rebillAmountCents ?? null,
        },
      });

      backfilled += await importHistory(prisma, expense, context);
      const sync = await syncOccurrences(prisma, expense, context);
      scheduled += sync.created;
      created += 1;
    }

    console.log(
      `Spese: ${String(created)} create, ${String(skipped)} già presenti. ` +
        `Occorrenze: ${String(backfilled)} di storico, ${String(scheduled)} previste.`,
    );
    console.log(`Anagrafiche: ${String(vendors.size)} fornitori, ${String(clients.size)} clienti.`);
    console.log('Per ripartire da zero: npm run seed:demo -w @easygest/api -- --reset');
  } finally {
    await prisma.$disconnect();
  }
}

/** Il giorno di oggi spostato di `months`, senza toccare l'orologio. */
function addMonthsFromToday(today: Date, months: number): Date {
  const moved = new Date(today);
  moved.setUTCMonth(moved.getUTCMonth() + months);
  return moved;
}

/**
 * Scrive le occorrenze anteriori a oggi, già pagate e confermate.
 *
 * Il cambio è quello di oggi anche per le rate di due anni fa. In una
 * dimostrazione va bene e va detto: i cambi storici veri si prendono con
 * `fx:sync` giorno per giorno, e ricostruirne due anni per far tornare dei dati
 * inventati sarebbe lavoro speso male.
 */
async function importHistory(
  prisma: PrismaClient,
  expense: {
    id: string;
    userId: string;
    startDate: Date;
    endDate: Date | null;
    recurrenceUnit: 'ONE_OFF' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
    recurrenceInterval: number;
    netCents: number;
    vatRateBp: number;
    grossCents: number;
    currency: string;
  },
  context: { baseCurrency: string; today: Date },
): Promise<number> {
  const yesterday = addDays(context.today, -1);
  if (expense.startDate > yesterday) return 0;

  const dates = generateSchedule({
    start: expense.startDate,
    unit: expense.recurrenceUnit,
    interval: expense.recurrenceInterval,
    end: expense.endDate,
    until: yesterday,
  });
  if (dates.length === 0) return 0;

  const money = await convertToBase(
    prisma,
    expense.grossCents,
    expense.currency,
    context.baseCurrency,
    context.today,
  );

  const result = await prisma.expenseOccurrence.createMany({
    data: dates.map((dueDate, index) => {
      const period = occurrencePeriod(
        expense.startDate,
        expense.recurrenceUnit,
        expense.recurrenceInterval,
        index,
      );
      return {
        userId: expense.userId,
        expenseId: expense.id,
        dueDate,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        netCents: expense.netCents,
        vatRateBp: expense.vatRateBp,
        grossCents: expense.grossCents,
        currency: expense.currency,
        fxRate: money.fxRate,
        baseGrossCents: money.baseCents,
        status: 'PAID' as const,
        paidAt: dueDate,
        confirmedAt: dueDate,
      };
    }),
    skipDuplicates: true,
  });

  return result.count;
}

async function upsertVendors(prisma: PrismaClient, userId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const name of VENDORS) {
    const row = await prisma.vendor.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name },
      update: {},
      select: { id: true },
    });
    map.set(name, row.id);
  }
  return map;
}

async function upsertClients(prisma: PrismaClient, userId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const client of CLIENTS) {
    const row = await prisma.client.upsert({
      where: { userId_name: { userId, name: client.name } },
      create: { userId, ...client, countryCode: 'IT' },
      update: {},
      select: { id: true },
    });
    map.set(client.name, row.id);
  }
  return map;
}

async function upsertPaymentMethods(
  prisma: PrismaClient,
  userId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const method of PAYMENT_METHODS) {
    const row = await prisma.paymentMethod.upsert({
      where: { userId_label: { userId, label: method.label } },
      create: { userId, ...method },
      update: {},
      select: { id: true },
    });
    map.set(method.label, row.id);
  }
  return map;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
