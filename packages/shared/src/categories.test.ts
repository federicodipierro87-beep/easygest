import { describe, expect, it } from 'vitest';

import { CATEGORY_ICONS, categoryInputSchema, categoryListQuerySchema } from './categories';

describe('colore di una categoria', () => {
  it('accetta la forma breve espandendola', () => {
    /**
     * `#abc` e `#aabbcc` sono lo stesso colore per il browser ma due stringhe
     * diverse per la colonna, che è `varchar(7)`. Senza l'espansione la forma
     * breve entrerebbe nel database così com'è, e due categorie dello stesso
     * colore risulterebbero diverse in ogni confronto e in ogni legenda.
     */
    const parsed = categoryInputSchema.parse({ name: 'Test', color: '#AbC' });

    expect(parsed.color).toBe('#aabbcc');
  });

  it('aggiunge il cancelletto e abbassa il maiuscolo', () => {
    expect(categoryInputSchema.parse({ name: 'Test', color: '2563EB' }).color).toBe('#2563eb');
  });

  it('rifiuta ciò che non è esadecimale', () => {
    expect(() => categoryInputSchema.parse({ name: 'Test', color: 'rosso' })).toThrow();
    expect(() => categoryInputSchema.parse({ name: 'Test', color: '#12345' })).toThrow();
  });

  it('tratta la casella vuota come «nessun colore»', () => {
    // Un form manda `""` per ogni campo non toccato: senza questa conversione
    // la colonna risulterebbe compilata con una stringa vuota, che non è un
    // colore e non è nemmeno l'assenza di uno.
    expect(categoryInputSchema.parse({ name: 'Test', color: '' }).color).toBeNull();
  });
});

describe('icona di una categoria', () => {
  it('accetta solo i nomi dell’elenco chiuso', () => {
    expect(categoryInputSchema.parse({ name: 'Test', icon: 'server' }).icon).toBe('server');
    // Un nome plausibile ma assente dall'elenco è esattamente il caso da
    // fermare: passerebbe, e il frontend non avrebbe niente da disegnare.
    expect(() => categoryInputSchema.parse({ name: 'Test', icon: 'rocket' })).toThrow();
  });

  it('contiene tutte le icone usate dal seed', () => {
    // Il seed è tipizzato su `CategoryIcon`, quindi questo è già garantito a
    // compilazione; il test serve a spiegare il vincolo a chi tocca l'elenco.
    const usedBySeed = [
      'server',
      'globe',
      'shield-check',
      'key-round',
      'repeat',
      'hard-drive',
      'wifi',
      'cpu',
      'graduation-cap',
      'users',
      'landmark',
    ];

    expect(CATEGORY_ICONS).toEqual(expect.arrayContaining(usedBySeed));
  });
});

describe('valori che l’utente non decide', () => {
  it('rifiuta isSystem e sortOrder nel corpo', () => {
    /**
     * Sono i due campi che reggono le regole: `isSystem` decide se la
     * cancellazione è permessa, `sortOrder` l'ordine dei menù. Se `strictObject`
     * non li rifiutasse, una `PUT` costruita a mano potrebbe promuovere una
     * categoria a «di sistema» o retrocederla, cioè aggirare il rifiuto.
     */
    expect(() => categoryInputSchema.parse({ name: 'Test', isSystem: true })).toThrow();
    expect(() => categoryInputSchema.parse({ name: 'Test', sortOrder: 0 })).toThrow();
  });

  it('vale per tutti e due gli ambiti quando non si sceglie', () => {
    expect(categoryInputSchema.parse({ name: 'Test' }).scope).toBe('BOTH');
  });
});

describe('filtro per uso', () => {
  it('non ammette BOTH, che come domanda non vuol dire niente', () => {
    /**
     * `usableFor` chiede «quali posso usare qui», e i due posti sono le spese e
     * i documenti. `usableFor=BOTH` sembrerebbe legittimo e non avrebbe
     * risposta sensata: le categorie usabili sia di qua sia di là non sono un
     * elenco che serva a qualcuno.
     */
    expect(categoryListQuerySchema.parse({ usableFor: 'EXPENSE' }).usableFor).toBe('EXPENSE');
    expect(() => categoryListQuerySchema.parse({ usableFor: 'BOTH' })).toThrow();
  });

  it('ordina per posizione manuale quando non si chiede altro', () => {
    expect(categoryListQuerySchema.parse({}).sort).toBe('sortOrder');
  });
});
