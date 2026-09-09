import type { Vendor, VendorInput } from '@easygest/shared';
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

type FormState = Record<Exclude<keyof VendorInput, 'isActive'>, string> & { isActive: boolean };

const EMPTY: FormState = {
  name: '',
  website: '',
  supportEmail: '',
  accountRef: '',
  portalUrl: '',
  vatNumber: '',
  countryCode: 'IT',
  notes: '',
  isActive: true,
};

function formFrom(vendor: Vendor | null): FormState {
  if (vendor === null) return EMPTY;
  return {
    name: vendor.name,
    website: vendor.website ?? '',
    supportEmail: vendor.supportEmail ?? '',
    accountRef: vendor.accountRef ?? '',
    portalUrl: vendor.portalUrl ?? '',
    vatNumber: vendor.vatNumber ?? '',
    countryCode: vendor.countryCode,
    notes: vendor.notes ?? '',
    isActive: vendor.isActive,
  };
}

interface VendorFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: Vendor | null;
  onSubmit: (input: VendorInput) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function VendorFormDialog({
  open,
  onOpenChange,
  vendor,
  onSubmit,
  pending,
  error,
}: VendorFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => formFrom(vendor));
  const errors = fieldErrors(error);

  const set = (key: keyof FormState) => (value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const generalError =
    error instanceof ApiError && Object.keys(errors).length === 0 ? error.message : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{vendor === null ? 'Nuovo fornitore' : 'Modifica fornitore'}</DialogTitle>
          <DialogDescription>
            Il numero cliente e la pagina del pannello sono i due campi che servono davvero quando
            c&rsquo;è da disdire in fretta.
          </DialogDescription>
        </DialogHeader>

        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit({
              ...form,
              countryCode: form.countryCode.trim() === '' ? 'IT' : form.countryCode,
            });
          }}
        >
          <TextField
            id="vendor-name"
            label="Nome"
            value={form.name}
            onChange={set('name')}
            error={errors.name}
            autoFocus
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="vendor-website"
              label="Sito"
              type="url"
              value={form.website}
              onChange={set('website')}
              error={errors.website}
              hint="Basta il dominio: «https://» viene aggiunto."
            />
            <TextField
              id="vendor-portal"
              label="Pannello di controllo"
              type="url"
              value={form.portalUrl}
              onChange={set('portalUrl')}
              error={errors.portalUrl}
            />
            <TextField
              id="vendor-account-ref"
              label="Numero cliente"
              value={form.accountRef}
              onChange={set('accountRef')}
              error={errors.accountRef}
              hint="L’identificativo del contratto presso il fornitore."
            />
            <TextField
              id="vendor-support-email"
              label="Email assistenza"
              type="email"
              value={form.supportEmail}
              onChange={set('supportEmail')}
              error={errors.supportEmail}
            />
            <TextField
              id="vendor-vat"
              label="Partita IVA"
              value={form.vatNumber}
              onChange={set('vatNumber')}
              error={errors.vatNumber}
            />
            <TextField
              id="vendor-country"
              label="Paese"
              value={form.countryCode}
              onChange={set('countryCode')}
              error={errors.countryCode}
              hint="Due lettere. Il controllo sulla partita IVA vale solo per IT."
            />
          </div>

          <TextAreaField
            id="vendor-notes"
            label="Note"
            value={form.notes}
            onChange={set('notes')}
            error={errors.notes}
          />

          <div className="flex items-center gap-2">
            <Checkbox
              id="vendor-active"
              checked={form.isActive}
              onCheckedChange={(checked) => {
                setForm((previous) => ({ ...previous, isActive: checked === true }));
              }}
            />
            <Label htmlFor="vendor-active" className="font-normal">
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
