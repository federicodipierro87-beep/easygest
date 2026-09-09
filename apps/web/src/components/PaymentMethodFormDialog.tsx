import {
  PAYMENT_METHOD_TYPE_LABELS,
  type PaymentMethod,
  type PaymentMethodFormInput,
  type PaymentMethodType,
} from '@easygest/shared';
import { useState } from 'react';

import { TextAreaField, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { fieldErrors } from '@/lib/resources';

/**
 * Mese e anno restano stringhe fino all'invio.
 *
 * Tenerli come numeri costringerebbe a decidere cosa sia una casella vuota già
 * mentre si digita, e l'unica risposta disponibile sarebbe `0` — un mese di
 * scadenza pari a zero, prodotto dal form e non dall'utente. Lo schema
 * condiviso converte la stringa vuota in `null` e il resto in numero, ed è lo
 * stesso schema che applica l'API.
 */
interface FormState {
  label: string;
  type: PaymentMethodType;
  last4: string;
  expiryMonth: string;
  expiryYear: string;
  notes: string;
  isActive: boolean;
}

const EMPTY: FormState = {
  label: '',
  type: 'CARD',
  last4: '',
  expiryMonth: '',
  expiryYear: '',
  notes: '',
  isActive: true,
};

function formFrom(method: PaymentMethod | null): FormState {
  if (method === null) return EMPTY;
  return {
    label: method.label,
    type: method.type,
    last4: method.last4 ?? '',
    expiryMonth: method.expiryMonth === null ? '' : String(method.expiryMonth),
    expiryYear: method.expiryYear === null ? '' : String(method.expiryYear),
    notes: method.notes ?? '',
    isActive: method.isActive,
  };
}

interface PaymentMethodFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` per una creazione. */
  method: PaymentMethod | null;
  onSubmit: (input: PaymentMethodFormInput) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function PaymentMethodFormDialog({
  open,
  onOpenChange,
  method,
  onSubmit,
  pending,
  error,
}: PaymentMethodFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => formFrom(method));
  const errors = fieldErrors(error);

  const set = (key: 'label' | 'last4' | 'expiryMonth' | 'expiryYear' | 'notes') => {
    return (value: string) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    };
  };

  const generalError =
    error instanceof ApiError && Object.keys(errors).length === 0 ? error.message : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {method === null ? 'Nuovo metodo di pagamento' : 'Modifica metodo di pagamento'}
          </DialogTitle>
          <DialogDescription>
            Qui non finiscono credenziali: né numero di carta, né IBAN, né CVV. Servono solo a
            riconoscere la riga sull&rsquo;estratto conto e a sapere quando la carta scade.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(form);
          }}
        >
          <TextField
            id="payment-label"
            label="Nome"
            value={form.label}
            onChange={set('label')}
            error={errors.label}
            hint="Come lo chiami tu: «Carta aziendale», «Conto Fineco»."
            autoFocus
          />

          <div className="grid gap-1.5">
            <Label htmlFor="payment-type">Tipo</Label>
            <Select
              value={form.type}
              onValueChange={(value) => {
                setForm((previous) => ({ ...previous, type: value as PaymentMethodType }));
              }}
            >
              <SelectTrigger id="payment-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PAYMENT_METHOD_TYPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.type !== undefined && <p className="text-sm text-red-600">{errors.type}</p>}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <TextField
              id="payment-last4"
              label="Ultime 4 cifre"
              value={form.last4}
              onChange={set('last4')}
              error={errors.last4}
              hint="Valgono anche per un IBAN."
            />
            <TextField
              id="payment-expiry-month"
              label="Mese scadenza"
              value={form.expiryMonth}
              onChange={set('expiryMonth')}
              error={errors.expiryMonth}
              placeholder="03"
            />
            <TextField
              id="payment-expiry-year"
              label="Anno scadenza"
              value={form.expiryYear}
              onChange={set('expiryYear')}
              error={errors.expiryYear}
              placeholder="2027"
            />
          </div>

          <TextAreaField
            id="payment-notes"
            label="Note"
            value={form.notes}
            onChange={set('notes')}
            error={errors.notes}
          />

          <div className="flex items-center gap-2">
            <Checkbox
              id="payment-active"
              checked={form.isActive}
              onCheckedChange={(checked) => {
                setForm((previous) => ({ ...previous, isActive: checked === true }));
              }}
            />
            <Label htmlFor="payment-active" className="font-normal">
              Attivo
            </Label>
          </div>

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
