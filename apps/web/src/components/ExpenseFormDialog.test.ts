import { expenseInputSchema } from '@easygest/shared';
import { describe, expect, it } from 'vitest';

import { emptyExpenseForm, toInput, type ExpenseFormState } from './ExpenseFormDialog';

/**
 * Il modulo, provato dove si sbaglia davvero.
 *
 * Non c'è nessun test di rendering, e non è una dimenticanza: il contenuto di
 * un `Dialog` Radix vive in un portale e in SSR non produce alcun markup, per
 * cui `renderToString` restituirebbe una stringa vuota e ogni asserzione su
 * quella stringa passerebbe verificando il nulla. Un test che non può fallire
 * è peggio di nessun test, perché sembra una garanzia.
 *
 * Quello che invece si può sbagliare è `toInput`: ventitré campi da leggere uno
 * per uno, sette conversioni numeriche e cinque caselle che a volte non
 * esistono. È tutto codice puro, e qui si prova contro lo schema vero — se
 * l'oggetto costruito passa `expenseInputSchema`, il server lo accetterà, e se
 * un giorno lo schema cambia questi test se ne accorgono invece di lasciarlo
 * scoprire a un 422.
 */

const BASE: ExpenseFormState = {
  ...emptyExpenseForm('2027-03-15'),
  name: 'Hosting',
  grossCents: '122,00',
};

describe('lettura del modulo', () => {
  it('costruisce un corpo che lo schema accetta', () => {
    const prepared = toInput(BASE);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const parsed = expenseInputSchema.safeParse(prepared.input);
    expect(parsed.success).toBe(true);
  });

  it('converte importi e percentuali come li digita una persona', () => {
    const prepared = toInput({ ...BASE, netCents: '1.234,56', vatRateBp: '22,5' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.input.netCents).toBe(123_456);
    expect(prepared.input.vatRateBp).toBe(2250);
  });

  it('tiene netto e lordo quando ci sono entrambi', () => {
    // Un fornitore che arrotonda l'IVA riga per riga produce un totale che non
    // coincide col conto sull'imponibile: in quel caso ha ragione la fattura.
    const prepared = toInput({ ...BASE, netCents: '100,00', grossCents: '121,99' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.input.netCents).toBe(10_000);
    expect(prepared.input.grossCents).toBe(12_199);
  });
});

describe('caselle che non ci sono', () => {
  it('non manda intervallo, fine e preavviso per una una tantum', () => {
    // Lo stato viene da una spesa mensile e conserva i tre valori: se
    // uscissero lo stesso, il `superRefine` rifiuterebbe il salvataggio
    // lamentando campi che l'utente non vede più.
    const prepared = toInput({
      ...BASE,
      recurrenceUnit: 'ONE_OFF',
      recurrenceInterval: '3',
      endDate: '2028-03-15',
      cancellationNoticeDays: '30',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.input.recurrenceInterval).toBeUndefined();
    expect(prepared.input.endDate).toBeUndefined();
    expect(prepared.input.cancellationNoticeDays).toBeUndefined();
    expect(expenseInputSchema.safeParse(prepared.input).success).toBe(true);
  });

  it('non manda il ricarico quando il riaddebito non lo prevede', () => {
    const prepared = toInput({
      ...BASE,
      clientId: 'c1',
      rebillMode: 'PASSTHROUGH',
      rebillMarkupBp: '10',
      rebillAmountCents: '50,00',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.input.rebillMarkupBp).toBeUndefined();
    expect(prepared.input.rebillAmountCents).toBeUndefined();
    expect(expenseInputSchema.safeParse(prepared.input).success).toBe(true);
  });

  it('manda il ricarico quando invece lo prevede', () => {
    const prepared = toInput({
      ...BASE,
      clientId: 'c1',
      rebillMode: 'MARKUP',
      rebillMarkupBp: '15',
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.input.rebillMarkupBp).toBe(1500);
  });
});

describe('quello che il server non potrebbe vedere', () => {
  it('ferma il testo che non è un numero', () => {
    // All'API arriverebbe `null`, indistinguibile da una casella lasciata
    // vuota: il rifiuto può nascere solo qui.
    const prepared = toInput({ ...BASE, netCents: 'dodici e cinquanta' });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;

    expect(prepared.errors.netCents).toBeDefined();
    expect(prepared.errors.grossCents).toBeUndefined();
  });

  it('tace su una casella sbagliata che non è in pagina', () => {
    // Un ricarico illeggibile rimasto nello stato di un riaddebito spento
    // bloccherebbe il salvataggio indicando un campo che non si vede: si
    // resterebbe fermi senza sapere dove guardare.
    const prepared = toInput({ ...BASE, rebillMode: 'NONE', rebillMarkupBp: 'un quinto' });
    expect(prepared.ok).toBe(true);
  });

  it('lascia passare la casella vuota, che è legittima', () => {
    const prepared = toInput({ ...BASE, netCents: '', cancellationNoticeDays: '' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    expect(prepared.input.netCents).toBeNull();
    expect(prepared.input.cancellationNoticeDays).toBeUndefined();
  });
});
