import {
  OCCURRENCE_STATUSES,
  OCCURRENCE_STATUS_LABELS,
  type ExpenseOccurrence,
  type OccurrencePatch,
  type OccurrenceStatus,
} from '@easygest/shared';
import { useState } from 'react';

import {
  CheckboxField,
  SelectField,
  TextAreaField,
  TextField,
  type SelectOption,
} from '@/components/FormField';
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
  formatDay,
  parseEuro,
  parsePercent,
  percentFromBasisPoints,
} from '@/lib/format';
import { fieldErrors } from '@/lib/resources';

/**
 * La correzione di una singola scadenza.
 *
 * Serve perché accorgersi che il fornitore ha alzato il prezzo è uno dei motivi
 * per cui l'applicazione esiste, e accorgersene senza poter correggere la cifra
 * sarebbe metà lavoro.
 *
 * **Manda solo quello che è cambiato**, ed è la decisione che fa funzionare la
 * finestra. Il server tratta un campo assente come «lascialo com'è», e quando
 * arrivano insieme netto e lordo li tiene entrambi senza ricalcolare —
 * giustamente, perché una fattura che arrotonda l'IVA riga per riga ha ragione
 * lei. Rispedire sempre la coppia, che è quello che verrebbe naturale
 * costruendo il corpo dallo stato, farebbe sì che correggere la sola aliquota
 * non abbia alcun effetto visibile: i due importi resterebbero quelli di prima
 * e l'aliquota sarebbe l'unica cosa a cambiare, contraddicendo le altre due.
 */

const STATUS_OPTIONS: SelectOption[] = OCCURRENCE_STATUSES.map((status) => ({
  value: status,
  label: OCCURRENCE_STATUS_LABELS[status],
}));

interface FormState {
  netCents: string;
  grossCents: string;
  vatRateBp: string;
  status: OccurrenceStatus;
  confirmed: boolean;
  notes: string;
}

function formFrom(occurrence: ExpenseOccurrence): FormState {
  return {
    netCents: euroFromCents(occurrence.netCents),
    grossCents: euroFromCents(occurrence.grossCents),
    vatRateBp: percentFromBasisPoints(occurrence.vatRateBp),
    status: occurrence.status,
    confirmed: occurrence.confirmedAt !== null,
    notes: occurrence.notes ?? '',
  };
}

export type PreparedPatch =
  { ok: true; patch: OccurrencePatch } | { ok: false; errors: Record<string, string> };

const NOT_A_NUMBER = 'Questo non è un numero';

/**
 * La differenza fra il modulo e la scadenza di partenza.
 *
 * Un corpo vuoto è un risultato legittimo — vuol dire che non si è cambiato
 * niente — e la `PATCH` che ne segue non fa nulla, che è esattamente giusto.
 */
export function toPatch(form: FormState, original: ExpenseOccurrence): PreparedPatch {
  const netCents = parseEuro(form.netCents);
  const grossCents = parseEuro(form.grossCents);
  const vatRateBp = parsePercent(form.vatRateBp);

  if (netCents === 'invalido' || grossCents === 'invalido' || vatRateBp === 'invalido') {
    const errors: Record<string, string> = {};
    if (netCents === 'invalido') errors.netCents = NOT_A_NUMBER;
    if (grossCents === 'invalido') errors.grossCents = NOT_A_NUMBER;
    if (vatRateBp === 'invalido') errors.vatRateBp = NOT_A_NUMBER;
    return { ok: false, errors };
  }

  const patch: OccurrencePatch = {};

  // Il confronto è sul valore letto, non sulla stringa: «49,90» e «49,9» sono
  // la stessa cifra scritta in due modi, e riscriverla non è una correzione.
  if (netCents !== original.netCents) patch.netCents = netCents;
  if (grossCents !== original.grossCents) patch.grossCents = grossCents;
  if (vatRateBp !== original.vatRateBp) patch.vatRateBp = vatRateBp ?? undefined;

  if (form.status !== original.status) patch.status = form.status;
  if (form.confirmed !== (original.confirmedAt !== null)) patch.confirmed = form.confirmed;

  const notes = form.notes.trim() === '' ? null : form.notes;
  if (notes !== original.notes) patch.notes = notes;

  return { ok: true, patch };
}

interface OccurrenceEditDialogProps {
  /** La scadenza da correggere, oppure `null` quando la finestra è chiusa. */
  occurrence: ExpenseOccurrence | null;
  onClose: () => void;
  onSubmit: (patch: OccurrencePatch) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function OccurrenceEditDialog({
  occurrence,
  onClose,
  onSubmit,
  pending,
  error,
}: OccurrenceEditDialogProps) {
  if (occurrence === null) return null;
  return (
    <OccurrenceEditForm
      // Riaprire su un'altra scadenza deve ripartire dai suoi valori, non da
      // quelli lasciati nello stato dalla precedente.
      key={occurrence.id}
      occurrence={occurrence}
      onClose={onClose}
      onSubmit={onSubmit}
      pending={pending}
      error={error}
    />
  );
}

function OccurrenceEditForm({
  occurrence,
  onClose,
  onSubmit,
  pending,
  error,
}: OccurrenceEditDialogProps & { occurrence: ExpenseOccurrence }) {
  const [form, setForm] = useState<FormState>(() => formFrom(occurrence));
  const [local, setLocal] = useState<Record<string, string>>({});

  const errors = { ...fieldErrors(error), ...local };
  const generalError =
    error instanceof ApiError && Object.keys(fieldErrors(error)).length === 0
      ? error.message
      : null;

  const set =
    <K extends keyof FormState>(key: K) =>
    (value: FormState[K]) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Scadenza del {formatDay(occurrence.dueDate)}</DialogTitle>
          <DialogDescription>
            {occurrence.expenseName}. La correzione vale per questa scadenza soltanto: per cambiare
            l’importo di tutte, modifica la spesa.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const prepared = toPatch(form, occurrence);
            if (!prepared.ok) {
              setLocal(prepared.errors);
              return;
            }
            setLocal({});
            void onSubmit(prepared.patch);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              id="occurrence-net"
              label="Imponibile"
              value={form.netCents}
              onChange={set('netCents')}
              error={errors.netCents}
            />
            <TextField
              id="occurrence-gross"
              label="Totale"
              value={form.grossCents}
              onChange={set('grossCents')}
              error={errors.grossCents}
            />
            <TextField
              id="occurrence-vat"
              label="IVA %"
              value={form.vatRateBp}
              onChange={set('vatRateBp')}
              error={errors.vatRateBp}
            />
          </div>

          <SelectField
            id="occurrence-status"
            label="Stato"
            value={form.status}
            onChange={(value) => {
              set('status')(value as OccurrenceStatus);
            }}
            options={STATUS_OPTIONS}
            error={errors.status}
          />

          <CheckboxField
            id="occurrence-confirmed"
            label="Verificata da una persona"
            checked={form.confirmed}
            onChange={set('confirmed')}
            hint="Togli la spunta per rimetterla fra quelle da controllare."
            error={errors.confirmed}
          />

          <TextAreaField
            id="occurrence-notes"
            label="Note"
            value={form.notes}
            onChange={set('notes')}
            error={errors.notes}
          />

          {generalError !== null && <p className="text-sm text-red-600">{generalError}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
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
