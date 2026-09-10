import {
  EXPENSE_STATUSES,
  EXPENSE_STATUS_LABELS,
  REBILL_MODES,
  REBILL_MODE_LABELS,
  RECURRENCE_UNITS,
  RECURRENCE_UNIT_LABELS,
  resolveAmount,
  type Expense,
  type ExpenseFormInput,
  type ExpenseStatus,
  type RebillMode,
  type RecurrenceUnit,
} from '@easygest/shared';
import { useState, type ReactNode } from 'react';

import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
  type SelectOption,
} from '@/components/FormField';
import { RelationSelect } from '@/components/RelationSelect';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import {
  euroFromCents,
  formatMoney,
  parseEuro,
  parseInteger,
  parsePercent,
  percentFromBasisPoints,
  todayIso,
  type ParsedNumber,
} from '@/lib/format';
import { useRelationOptions, withMissing } from '@/lib/relations';
import { fieldErrors } from '@/lib/resources';

/**
 * Il modulo di una spesa.
 *
 * Ventitré campi, e nessuno di essi è indipendente da tutti gli altri:
 * l'unità di ricorrenza decide se una data di fine ha senso, il modo di
 * riaddebito decide quale dei due importi accessori serve, e l'importo si può
 * scrivere al netto o al lordo. Il modo in cui questa finestra affronta la cosa
 * è deciso in due righe:
 *
 * **Le regole incrociate si vedono come assenza di caselle.** «Una tantum»
 * toglie intervallo, fine e preavviso; il riaddebito mostra il ricarico solo
 * col ricarico e il forfait solo col forfait. Non è validare: è non proporre
 * una casella che il server rifiuterebbe comunque, e togliere all'utente il
 * lavoro di scoprirlo salvando.
 *
 * **Il client valida solo ciò che il server non può vedere.** Una casella
 * numerica che contiene «dodici e cinquanta» arriva all'API come `null`, e da
 * là dentro non si distingue da una casella lasciata vuota, che è invece
 * legittima. Tutto il resto — comprese le regole incrociate qui sopra, se
 * qualcuno raggiunge lo stesso una combinazione impossibile — resta nel
 * `superRefine` di `expenseInputSchema` e torna indietro già indirizzato al
 * campo giusto da `fieldErrors`.
 */

export interface ExpenseFormState {
  name: string;
  description: string;

  vendorId: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  clientId: string | null;

  /** Importi e percentuali come li digita una persona: «1.234,56», «22,5». */
  netCents: string;
  grossCents: string;
  vatRateBp: string;
  currency: string;

  recurrenceUnit: RecurrenceUnit;
  recurrenceInterval: string;
  startDate: string;
  endDate: string;

  status: ExpenseStatus;
  autoRenew: boolean;
  cancellationNoticeDays: string;
  cancelledAt: string;

  rebillMode: RebillMode;
  rebillMarkupBp: string;
  rebillAmountCents: string;

  notes: string;
}

export function emptyExpenseForm(today: string = todayIso()): ExpenseFormState {
  return {
    name: '',
    description: '',
    vendorId: null,
    categoryId: null,
    paymentMethodId: null,
    clientId: null,
    netCents: '',
    grossCents: '',
    vatRateBp: '22,00',
    currency: 'EUR',
    recurrenceUnit: 'MONTH',
    recurrenceInterval: '1',
    startDate: today,
    endDate: '',
    status: 'ACTIVE',
    autoRenew: true,
    cancellationNoticeDays: '',
    cancelledAt: '',
    rebillMode: 'NONE',
    rebillMarkupBp: '',
    rebillAmountCents: '',
    notes: '',
  };
}

/** La parte di giorno di un istante: una disdetta è un giorno, non un momento. */
function dayOf(instant: string | null): string {
  return instant === null ? '' : instant.slice(0, 10);
}

export function expenseForm(expense: Expense | null): ExpenseFormState {
  if (expense === null) return emptyExpenseForm();
  return {
    name: expense.name,
    description: expense.description ?? '',
    vendorId: expense.vendorId,
    categoryId: expense.categoryId,
    paymentMethodId: expense.paymentMethodId,
    clientId: expense.clientId,
    netCents: euroFromCents(expense.netCents),
    grossCents: euroFromCents(expense.grossCents),
    vatRateBp: percentFromBasisPoints(expense.vatRateBp),
    currency: expense.currency,
    recurrenceUnit: expense.recurrenceUnit,
    recurrenceInterval: String(expense.recurrenceInterval),
    startDate: expense.startDate.slice(0, 10),
    endDate: dayOf(expense.endDate),
    status: expense.status,
    autoRenew: expense.autoRenew,
    cancellationNoticeDays:
      expense.cancellationNoticeDays === null ? '' : String(expense.cancellationNoticeDays),
    cancelledAt: dayOf(expense.cancelledAt),
    rebillMode: expense.rebillMode,
    rebillMarkupBp: percentFromBasisPoints(expense.rebillMarkupBp),
    rebillAmountCents: euroFromCents(expense.rebillAmountCents),
    notes: expense.notes ?? '',
  };
}

/** Quali caselle esistono, data la combinazione scelta. */
export function visibleFields(form: ExpenseFormState) {
  return {
    recurrence: form.recurrenceUnit !== 'ONE_OFF',
    markup: form.rebillMode === 'MARKUP',
    fixed: form.rebillMode === 'FIXED',
  };
}

export type Prepared =
  { ok: true; input: ExpenseFormInput } | { ok: false; errors: Record<string, string> };

const NOT_A_NUMBER = 'Questo non è un numero';

/** Il valore letto, oppure `undefined` per lasciar valere il default dello schema. */
function orDefault(parsed: ParsedNumber): number | undefined {
  return typeof parsed === 'number' ? parsed : undefined;
}

/**
 * Dallo stato del modulo al corpo della richiesta, o agli errori che lo fermano.
 *
 * Una funzione sola e non due — «valida» e «converti» — perché le due
 * farebbero due volte le stesse sette conversioni, e la seconda dovrebbe
 * comunque decidere cosa fare di un `'invalido'` che la prima ha già escluso:
 * un ramo irraggiungibile che il tipo costringerebbe a scrivere.
 *
 * L'oggetto è costruito campo per campo e mai con uno spread dallo stato: lo
 * schema è uno `strictObject`, e una chiave in più — anche solo un residuo di
 * una versione precedente del modulo — verrebbe rifiutata in blocco senza
 * indicare quale. Le caselle non proposte escono `undefined`, che
 * `JSON.stringify` toglie dal corpo: il server applica il suo default, che è
 * esattamente «non è stato scelto niente».
 */
export function toInput(form: ExpenseFormState): Prepared {
  const visible = visibleFields(form);

  const netCents = parseEuro(form.netCents);
  const grossCents = parseEuro(form.grossCents);
  const vatRateBp = parsePercent(form.vatRateBp);
  const recurrenceInterval = parseInteger(form.recurrenceInterval);
  const cancellationNoticeDays = parseInteger(form.cancellationNoticeDays);
  const rebillMarkupBp = parsePercent(form.rebillMarkupBp);
  const rebillAmountCents = parseEuro(form.rebillAmountCents);

  const candidates: [string, ParsedNumber, boolean][] = [
    ['netCents', netCents, true],
    ['grossCents', grossCents, true],
    ['vatRateBp', vatRateBp, true],
    ['recurrenceInterval', recurrenceInterval, visible.recurrence],
    ['cancellationNoticeDays', cancellationNoticeDays, visible.recurrence],
    ['rebillMarkupBp', rebillMarkupBp, visible.markup],
    ['rebillAmountCents', rebillAmountCents, visible.fixed],
  ];

  const errors: Record<string, string> = {};
  for (const [field, parsed, shown] of candidates) {
    if (shown && parsed === 'invalido') errors[field] = NOT_A_NUMBER;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    input: {
      name: form.name,
      description: form.description,

      vendorId: form.vendorId,
      categoryId: form.categoryId,
      paymentMethodId: form.paymentMethodId,
      clientId: form.clientId,

      // Netto e lordo restano quelli scritti: svuotarne uno lo fa ricalcolare
      // dall'aliquota, tenerli entrambi conserva l'arrotondamento della
      // fattura. È la scelta che `resolveAmount` incarna, e il modulo non la
      // contraddice completandone uno per conto suo.
      netCents: typeof netCents === 'number' ? netCents : null,
      grossCents: typeof grossCents === 'number' ? grossCents : null,
      vatRateBp: orDefault(vatRateBp),
      currency: form.currency.trim() === '' ? undefined : form.currency,

      recurrenceUnit: form.recurrenceUnit,
      recurrenceInterval: visible.recurrence ? orDefault(recurrenceInterval) : undefined,
      startDate: form.startDate,
      endDate: visible.recurrence && form.endDate !== '' ? form.endDate : undefined,

      status: form.status,
      autoRenew: form.autoRenew,
      cancellationNoticeDays: visible.recurrence ? orDefault(cancellationNoticeDays) : undefined,
      cancelledAt: form.cancelledAt === '' ? undefined : form.cancelledAt,

      rebillMode: form.rebillMode,
      rebillMarkupBp: visible.markup ? orDefault(rebillMarkupBp) : undefined,
      rebillAmountCents: visible.fixed ? orDefault(rebillAmountCents) : undefined,

      notes: form.notes,
    },
  };
}

function optionsFrom<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): SelectOption[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

const STATUS_OPTIONS = optionsFrom(EXPENSE_STATUSES, EXPENSE_STATUS_LABELS);
const UNIT_OPTIONS = optionsFrom(RECURRENCE_UNITS, RECURRENCE_UNIT_LABELS);
const REBILL_OPTIONS = optionsFrom(REBILL_MODES, REBILL_MODE_LABELS);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Il terzo importo, quello che non si scrive.
 *
 * Chi digita il lordo vuole sapere che imponibile ne esce, e viceversa: farglielo
 * vedere mentre scrive evita il salvataggio fatto per controllare. Non è
 * modificabile perché non è un dato ma un conto, ed è lo stesso conto che farà
 * il server — `resolveAmount` è la funzione che userà anche lui.
 */
function AmountPreview({ form }: { form: ExpenseFormState }) {
  const netCents = parseEuro(form.netCents);
  const grossCents = parseEuro(form.grossCents);
  const vatRateBp = parsePercent(form.vatRateBp);

  if (typeof netCents !== 'number' && typeof grossCents !== 'number') return null;

  const resolved = resolveAmount({
    netCents: typeof netCents === 'number' ? netCents : null,
    grossCents: typeof grossCents === 'number' ? grossCents : null,
    vatRateBp: typeof vatRateBp === 'number' ? vatRateBp : 2200,
  });

  return (
    <p className="text-muted-foreground text-sm">
      Imponibile {formatMoney(resolved.netCents, form.currency)} · IVA{' '}
      {formatMoney(resolved.vatCents, form.currency)} · Totale{' '}
      {formatMoney(resolved.grossCents, form.currency)}
    </p>
  );
}

interface ExpenseFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` per una creazione. */
  expense: Expense | null;
  onSubmit: (input: ExpenseFormInput) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function ExpenseFormDialog({
  open,
  onOpenChange,
  expense,
  onSubmit,
  pending,
  error,
}: ExpenseFormDialogProps) {
  const [form, setForm] = useState<ExpenseFormState>(() => expenseForm(expense));
  const [local, setLocal] = useState<Record<string, string>>({});
  const relations = useRelationOptions();

  const errors = { ...fieldErrors(error), ...local };
  const visible = visibleFields(form);

  const set =
    <K extends keyof ExpenseFormState>(key: K) =>
    (value: ExpenseFormState[K]) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    };

  const generalError =
    error instanceof ApiError && Object.keys(fieldErrors(error)).length === 0
      ? error.message
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{expense === null ? 'Nuova spesa' : 'Modifica spesa'}</DialogTitle>
          <DialogDescription>
            Servono il nome, la data di inizio e uno fra imponibile e totale. Salvando, le scadenze
            future vengono rigenerate da capo.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const prepared = toInput(form);
            if (!prepared.ok) {
              setLocal(prepared.errors);
              return;
            }
            setLocal({});
            void onSubmit(prepared.input);
          }}
        >
          <Section title="Identità">
            <TextField
              id="expense-name"
              label="Nome"
              value={form.name}
              onChange={set('name')}
              error={errors.name}
              autoFocus
            />
            <TextField
              id="expense-description"
              label="Descrizione"
              value={form.description}
              onChange={set('description')}
              error={errors.description}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <RelationSelect
                id="expense-vendor"
                label="Fornitore"
                value={form.vendorId}
                onChange={set('vendorId')}
                options={withMissing(relations.vendors, form.vendorId, expense?.vendorName ?? null)}
                emptyLabel="Nessun fornitore"
                error={errors.vendorId}
                disabled={relations.loading}
              />
              <RelationSelect
                id="expense-category"
                label="Categoria"
                value={form.categoryId}
                onChange={set('categoryId')}
                options={withMissing(
                  relations.categories,
                  form.categoryId,
                  expense?.categoryName ?? null,
                )}
                emptyLabel="Nessuna categoria"
                error={errors.categoryId}
                disabled={relations.loading}
              />
              <RelationSelect
                id="expense-payment-method"
                label="Metodo di pagamento"
                value={form.paymentMethodId}
                onChange={set('paymentMethodId')}
                options={withMissing(
                  relations.paymentMethods,
                  form.paymentMethodId,
                  expense?.paymentMethodLabel ?? null,
                )}
                emptyLabel="Nessun metodo"
                error={errors.paymentMethodId}
                disabled={relations.loading}
              />
            </div>
          </Section>

          <Section title="Importo">
            <div className="grid gap-4 sm:grid-cols-4">
              <TextField
                id="expense-net"
                label="Imponibile"
                value={form.netCents}
                onChange={set('netCents')}
                error={errors.netCents}
                placeholder="0,00"
              />
              <TextField
                id="expense-gross"
                label="Totale"
                value={form.grossCents}
                onChange={set('grossCents')}
                error={errors.grossCents}
                placeholder="0,00"
                hint="Svuotalo per ricalcolarlo dall’aliquota."
              />
              <TextField
                id="expense-vat"
                label="IVA %"
                value={form.vatRateBp}
                onChange={set('vatRateBp')}
                error={errors.vatRateBp}
              />
              <TextField
                id="expense-currency"
                label="Valuta"
                value={form.currency}
                onChange={set('currency')}
                error={errors.currency}
                hint="Codice ISO."
              />
            </div>
            <AmountPreview form={form} />
          </Section>

          <Section title="Ricorrenza">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                id="expense-unit"
                label="Frequenza"
                value={form.recurrenceUnit}
                onChange={(value) => {
                  set('recurrenceUnit')(value as RecurrenceUnit);
                }}
                options={UNIT_OPTIONS}
                error={errors.recurrenceUnit}
              />
              {visible.recurrence && (
                <TextField
                  id="expense-interval"
                  label="Ogni quante"
                  value={form.recurrenceInterval}
                  onChange={set('recurrenceInterval')}
                  error={errors.recurrenceInterval}
                  hint="2 con «Mensile» vuol dire ogni due mesi."
                />
              )}
              <TextField
                id="expense-start"
                label="Data di inizio"
                type="date"
                value={form.startDate}
                onChange={set('startDate')}
                error={errors.startDate}
              />
              {visible.recurrence && (
                <TextField
                  id="expense-end"
                  label="Data di fine"
                  type="date"
                  value={form.endDate}
                  onChange={set('endDate')}
                  error={errors.endDate}
                  hint="Vuota per un abbonamento che continua."
                />
              )}
            </div>
          </Section>

          <Section title="Contratto">
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                id="expense-status"
                label="Stato"
                value={form.status}
                onChange={(value) => {
                  set('status')(value as ExpenseStatus);
                }}
                options={STATUS_OPTIONS}
                error={errors.status}
              />
              {visible.recurrence && (
                <TextField
                  id="expense-notice"
                  label="Preavviso di disdetta (giorni)"
                  value={form.cancellationNoticeDays}
                  onChange={set('cancellationNoticeDays')}
                  error={errors.cancellationNoticeDays}
                  hint="Quanti giorni prima del rinnovo va inviata."
                />
              )}
              <TextField
                id="expense-cancelled-at"
                label="Disdetta inviata il"
                type="date"
                value={form.cancelledAt}
                onChange={set('cancelledAt')}
                error={errors.cancelledAt}
              />
            </div>
            <CheckboxField
              id="expense-auto-renew"
              label="Si rinnova da sola"
              checked={form.autoRenew}
              onChange={set('autoRenew')}
              error={errors.autoRenew}
            />
          </Section>

          <Section title="Riaddebito">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                id="expense-rebill-mode"
                label="Modo"
                value={form.rebillMode}
                onChange={(value) => {
                  set('rebillMode')(value as RebillMode);
                }}
                options={REBILL_OPTIONS}
                error={errors.rebillMode}
              />
              {/*
                Il cliente resta visibile anche senza riaddebito: una spesa può
                riguardare un cliente senza essergli rimessa in conto, e
                nasconderlo qui vorrebbe dire perdere quel collegamento.
              */}
              <RelationSelect
                id="expense-client"
                label="Cliente"
                value={form.clientId}
                onChange={set('clientId')}
                options={withMissing(relations.clients, form.clientId, expense?.clientName ?? null)}
                emptyLabel="Nessun cliente"
                error={errors.clientId}
                disabled={relations.loading}
              />
              {visible.markup && (
                <TextField
                  id="expense-rebill-markup"
                  label="Ricarico %"
                  value={form.rebillMarkupBp}
                  onChange={set('rebillMarkupBp')}
                  error={errors.rebillMarkupBp}
                />
              )}
              {visible.fixed && (
                <TextField
                  id="expense-rebill-amount"
                  label="Importo concordato"
                  value={form.rebillAmountCents}
                  onChange={set('rebillAmountCents')}
                  error={errors.rebillAmountCents}
                  placeholder="0,00"
                />
              )}
            </div>
          </Section>

          <Section title="Note">
            <TextAreaField
              id="expense-notes"
              label="Note"
              value={form.notes}
              onChange={set('notes')}
              error={errors.notes}
            />
          </Section>

          {generalError !== null && <p className="text-sm text-red-600">{generalError}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Annulla
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Salvo…' : 'Salva'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
