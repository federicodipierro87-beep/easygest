import { describe, expect, it } from 'vitest';

import { clientInputSchema, clientListQuerySchema } from './clients';

/** Elenco `campo: messaggio`, che è quello che si vuole leggere quando fallisce. */
function problems(value: unknown): string[] {
  const result = clientInputSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('anagrafica cliente', () => {
  it('bastano il nome e nient’altro', () => {
    // Un cliente si annota di corsa con il solo nome, e i dati fiscali
    // arrivano quando arriva la prima fattura. Pretenderli subito
    // significherebbe non farlo annotare.
    const client = clientInputSchema.parse({ name: '  Studio Rossi  ' });

    expect(client.name).toBe('Studio Rossi');
    expect(client.countryCode).toBe('IT');
    expect(client.isActive).toBe(true);
    // I campi assenti escono come `null` e non come `undefined`: è ciò che
    // rende la modifica una sostituzione vera, in cui togliere un dato
    // sbagliato è possibile.
    expect(client.vatNumber).toBe(null);
    expect(client.notes).toBe(null);
  });

  it('rifiuta una partita IVA italiana con la cifra di controllo sbagliata', () => {
    expect(problems({ name: 'Acme', vatNumber: '00743110158' })).toEqual([
      'vatNumber: Partita IVA non valida: la cifra di controllo non torna',
    ]);
  });

  it('non applica la regola italiana a un cliente estero', () => {
    // Una partita IVA irlandese non ha undici cifre né quella cifra di
    // controllo: verificarla con l'algoritmo italiano vorrebbe dire rifiutare
    // un dato corretto.
    const client = clientInputSchema.parse({
      name: 'Acme Ltd',
      countryCode: 'ie',
      vatNumber: 'IE6388047V',
      postalCode: 'D02 XY45',
    });

    expect(client.countryCode).toBe('IE');
    expect(client.vatNumber).toBe('IE6388047V');
  });

  it('pretende cinque cifre nel CAP, ma solo in Italia', () => {
    expect(problems({ name: 'Acme', postalCode: '2010' })).toEqual([
      'postalCode: Un CAP italiano ha 5 cifre',
    ]);
  });

  it('svuota i campi lasciati in bianco invece di riempirli di stringhe vuote', () => {
    const client = clientInputSchema.parse({
      name: 'Acme',
      email: '',
      phone: '   ',
      province: '',
      notes: '',
    });

    expect(client.email).toBe(null);
    expect(client.phone).toBe(null);
    expect(client.province).toBe(null);
    expect(client.notes).toBe(null);
  });

  it('raccoglie tutti gli errori insieme, non uno per volta', () => {
    // Correggere un campo per volta, con un viaggio di rete ciascuno, è il
    // modo peggiore di compilare un modulo.
    expect(problems({ name: '', email: 'a@', province: 'MILANO' })).toHaveLength(3);
  });

  it('rifiuta i campi che non gli appartengono', () => {
    // Il risultato di questa validazione viene passato a Prisma così com'è:
    // un `userId` che passasse di qui permetterebbe di intestare un cliente a
    // qualcun altro. Lo schema è chiuso, e un campo estraneo è un errore
    // esplicito invece che un valore ignorato in silenzio.
    expect(problems({ name: 'Acme', userId: 'altro-utente' })).toEqual([
      ': Unrecognized key: "userId"',
    ]);
  });
});

describe('parametri dell’elenco', () => {
  it('ha valori predefiniti sensati quando non si chiede niente', () => {
    expect(clientListQuerySchema.parse({})).toEqual({
      q: undefined,
      page: 1,
      perPage: 25,
      archived: 'exclude',
      sort: 'name',
      direction: 'asc',
    });
  });

  it('legge i numeri dalla query string, dove tutto è una stringa', () => {
    const query = clientListQuerySchema.parse({ page: '3', perPage: '10', q: '  rossi  ' });

    expect(query.page).toBe(3);
    expect(query.perPage).toBe(10);
    expect(query.q).toBe('rossi');
  });

  it('rifiuta un campo di ordinamento che non è previsto', () => {
    // Il valore finisce nell'`orderBy` di una query: accettare un nome di
    // colonna qualsiasi vorrebbe dire far scegliere a chi chiama su cosa
    // ordinare il database.
    expect(clientListQuerySchema.safeParse({ sort: 'passwordHash' }).success).toBe(false);
  });

  it('mette un tetto alla pagina, per non farsi chiedere tutto in una volta', () => {
    expect(clientListQuerySchema.safeParse({ perPage: '5000' }).success).toBe(false);
  });
});
