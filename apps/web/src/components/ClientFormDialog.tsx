import type { Client, ClientInput } from '@easygest/shared';
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
import { ApiError } from '@/lib/api';
import { fieldErrors } from '@/lib/resources';

/**
 * Il modulo tiene stringhe, non il tipo dell'API.
 *
 * Una casella vuota è `''` e non `null`, e distinguere i due nello stato del
 * form vorrebbe dire convertire avanti e indietro a ogni tasto. La conversione
 * avviene una volta sola, all'invio: `''` diventa `null` grazie allo schema
 * condiviso, che è lo stesso che l'API applica.
 */
type FormState = Record<Exclude<keyof ClientInput, 'isActive'>, string> & { isActive: boolean };

const EMPTY: FormState = {
  name: '',
  vatNumber: '',
  taxCode: '',
  sdiCode: '',
  pecEmail: '',
  email: '',
  phone: '',
  addressLine: '',
  postalCode: '',
  city: '',
  province: '',
  countryCode: 'IT',
  notes: '',
  isActive: true,
};

function formFrom(client: Client | null): FormState {
  if (client === null) return EMPTY;
  return {
    name: client.name,
    vatNumber: client.vatNumber ?? '',
    taxCode: client.taxCode ?? '',
    sdiCode: client.sdiCode ?? '',
    pecEmail: client.pecEmail ?? '',
    email: client.email ?? '',
    phone: client.phone ?? '',
    addressLine: client.addressLine ?? '',
    postalCode: client.postalCode ?? '',
    city: client.city ?? '',
    province: client.province ?? '',
    countryCode: client.countryCode,
    notes: client.notes ?? '',
    isActive: client.isActive,
  };
}

interface ClientFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` per una creazione. */
  client: Client | null;
  onSubmit: (input: ClientInput) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function ClientFormDialog({
  open,
  onOpenChange,
  client,
  onSubmit,
  pending,
  error,
}: ClientFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => formFrom(client));
  const errors = fieldErrors(error);

  const set = (key: keyof FormState) => (value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  /**
   * Un errore che non riguarda un campo va detto lo stesso: un nome duplicato
   * arriva come 409 senza dettagli, e senza questa riga il salvataggio
   * sembrerebbe non fare niente.
   */
  const generalError =
    error instanceof ApiError && Object.keys(errors).length === 0 ? error.message : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{client === null ? 'Nuovo cliente' : 'Modifica cliente'}</DialogTitle>
          <DialogDescription>
            Solo il nome è obbligatorio. I dati fiscali servono a ritrovare il cliente da una
            fattura in mano, dove spesso il nome commerciale non compare.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit({
              ...form,
              // Il paese non è facoltativo nello schema: una casella svuotata
              // torna al valore predefinito invece di far fallire l'invio con
              // un errore che non aiuterebbe nessuno.
              countryCode: form.countryCode.trim() === '' ? 'IT' : form.countryCode,
            });
          }}
        >
          <TextField
            id="client-name"
            label="Nome"
            value={form.name}
            onChange={set('name')}
            error={errors.name}
            autoFocus
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="client-vat"
              label="Partita IVA"
              value={form.vatNumber}
              onChange={set('vatNumber')}
              error={errors.vatNumber}
              hint="11 cifre. La cifra di controllo viene verificata."
            />
            <TextField
              id="client-tax-code"
              label="Codice fiscale"
              value={form.taxCode}
              onChange={set('taxCode')}
              error={errors.taxCode}
            />
            <TextField
              id="client-sdi"
              label="Codice destinatario (SDI)"
              value={form.sdiCode}
              onChange={set('sdiCode')}
              error={errors.sdiCode}
            />
            <TextField
              id="client-pec"
              label="PEC"
              type="email"
              value={form.pecEmail}
              onChange={set('pecEmail')}
              error={errors.pecEmail}
              hint="Se manca il codice SDI, la fattura elettronica arriva qui."
            />
            <TextField
              id="client-email"
              label="Email"
              type="email"
              value={form.email}
              onChange={set('email')}
              error={errors.email}
            />
            <TextField
              id="client-phone"
              label="Telefono"
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              error={errors.phone}
            />
          </div>

          <TextField
            id="client-address"
            label="Indirizzo"
            value={form.addressLine}
            onChange={set('addressLine')}
            error={errors.addressLine}
          />

          <div className="grid gap-4 sm:grid-cols-4">
            <TextField
              id="client-postal-code"
              label="CAP"
              value={form.postalCode}
              onChange={set('postalCode')}
              error={errors.postalCode}
            />
            <div className="sm:col-span-2">
              <TextField
                id="client-city"
                label="Città"
                value={form.city}
                onChange={set('city')}
                error={errors.city}
              />
            </div>
            <TextField
              id="client-province"
              label="Prov."
              value={form.province}
              onChange={set('province')}
              error={errors.province}
            />
          </div>

          <TextField
            id="client-country"
            label="Paese"
            value={form.countryCode}
            onChange={set('countryCode')}
            error={errors.countryCode}
            hint="Due lettere. I controlli su partita IVA e CAP valgono solo per IT."
          />

          <TextAreaField
            id="client-notes"
            label="Note"
            value={form.notes}
            onChange={set('notes')}
            error={errors.notes}
          />

          <div className="flex items-center gap-2">
            <Checkbox
              id="client-active"
              checked={form.isActive}
              onCheckedChange={(checked) => {
                setForm((previous) => ({ ...previous, isActive: checked === true }));
              }}
            />
            <Label htmlFor="client-active" className="font-normal">
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
