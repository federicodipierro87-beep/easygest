import {
  type Category,
  type CategoryIcon,
  type CategoryInput,
  type CategoryScope,
} from '@easygest/shared';
import { useState } from 'react';

import { TextField } from '@/components/FormField';
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
import { CATEGORY_ICON_COMPONENTS, CATEGORY_ICON_LIST } from '@/lib/category-icons';
import { fieldErrors } from '@/lib/resources';
import { cn } from '@/lib/utils';

/**
 * Come per le altre anagrafiche il modulo tiene stringhe, non il tipo
 * dell'API: la conversione avviene una volta sola, all'invio, e la fa lo schema
 * condiviso.
 *
 * `scope` e `icon` fanno eccezione perché non arrivano da una casella di testo
 * ma da una scelta fra valori noti: tenerli come stringhe libere vorrebbe dire
 * poter mettere lo stato in una configurazione che l'utente non può produrre.
 */
interface FormState {
  name: string;
  scope: CategoryScope;
  color: string;
  icon: CategoryIcon | null;
  isActive: boolean;
}

const EMPTY: FormState = {
  name: '',
  scope: 'BOTH',
  color: '',
  icon: null,
  isActive: true,
};

const SCOPE_LABELS: Record<CategoryScope, string> = {
  BOTH: 'Spese e documenti',
  EXPENSE: 'Solo spese',
  DOCUMENT: 'Solo documenti',
};

function formFrom(category: Category | null): FormState {
  if (category === null) return EMPTY;
  return {
    name: category.name,
    scope: category.scope,
    color: category.color ?? '',
    icon: category.icon,
    isActive: category.isActive,
  };
}

interface CategoryFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` per una creazione. */
  category: Category | null;
  onSubmit: (input: CategoryInput) => Promise<void>;
  pending: boolean;
  error: unknown;
}

export function CategoryFormDialog({
  open,
  onOpenChange,
  category,
  onSubmit,
  pending,
  error,
}: CategoryFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => formFrom(category));
  const errors = fieldErrors(error);

  const generalError =
    error instanceof ApiError && Object.keys(errors).length === 0 ? error.message : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{category === null ? 'Nuova categoria' : 'Modifica categoria'}</DialogTitle>
          <DialogDescription>
            L&rsquo;ambito decide in quali menù a tendina la categoria comparirà. Colore e icona
            servono solo a ritrovarla a colpo d&rsquo;occhio in un elenco lungo.
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
            id="category-name"
            label="Nome"
            value={form.name}
            onChange={(value) => {
              setForm((previous) => ({ ...previous, name: value }));
            }}
            error={errors.name}
            autoFocus
          />

          <div className="grid gap-1.5">
            <Label htmlFor="category-scope">Ambito</Label>
            <Select
              value={form.scope}
              onValueChange={(value) => {
                setForm((previous) => ({ ...previous, scope: value as CategoryScope }));
              }}
            >
              <SelectTrigger id="category-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SCOPE_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.scope !== undefined && <p className="text-sm text-red-600">{errors.scope}</p>}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="category-color">Colore</Label>
            <div className="flex items-center gap-2">
              {/*
                Due controlli sullo stesso valore: il selettore nativo per
                sceglierlo a occhio, la casella di testo per incollare un
                esadecimale preso da altrove. Il selettore nativo non sa
                rappresentare «nessun colore», quindi quando il campo è vuoto
                mostra il grigio del testo secondario senza scriverlo nello
                stato: è ciò che tiene distinto «non ho scelto» da «ho scelto
                proprio questo grigio».
              */}
              <input
                type="color"
                aria-label="Scegli il colore"
                value={form.color === '' ? '#64748b' : form.color}
                onChange={(event) => {
                  setForm((previous) => ({ ...previous, color: event.target.value }));
                }}
                className="border-input size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
              />
              <input
                id="category-color"
                type="text"
                value={form.color}
                placeholder="#2563eb"
                aria-invalid={errors.color !== undefined}
                aria-describedby={errors.color === undefined ? undefined : 'category-color-error'}
                onChange={(event) => {
                  setForm((previous) => ({ ...previous, color: event.target.value }));
                }}
                className="border-input placeholder:text-muted-foreground focus-visible:ring-ring h-9 w-full rounded-md border bg-transparent px-3 py-1 font-mono text-sm shadow-xs focus-visible:ring-1 focus-visible:outline-none"
              />
              {form.color !== '' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setForm((previous) => ({ ...previous, color: '' }));
                  }}
                >
                  Togli
                </Button>
              )}
            </div>
            {errors.color !== undefined && (
              <p id="category-color-error" className="text-sm text-red-600">
                {errors.color}
              </p>
            )}
          </div>

          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Icona</legend>
            {/*
              Una griglia e non una casella di testo: i nomi delle icone sono
              un elenco chiuso, e farli scrivere significherebbe far indovinare
              «shield-check» a chi cerca uno scudo.
            */}
            <div className="flex flex-wrap gap-1.5">
              {CATEGORY_ICON_LIST.map((name) => {
                const Icon = CATEGORY_ICON_COMPONENTS[name];
                const selected = form.icon === name;
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    aria-pressed={selected}
                    onClick={() => {
                      // Ripremere l'icona già scelta la toglie: senza, una
                      // categoria non potrebbe più tornare senza icona dopo
                      // averne avuta una.
                      setForm((previous) => ({ ...previous, icon: selected ? null : name }));
                    }}
                    className={cn(
                      'hover:bg-muted flex size-9 items-center justify-center rounded-md border transition-colors',
                      selected ? 'border-foreground bg-muted' : 'border-transparent',
                    )}
                  >
                    <Icon aria-hidden className="size-4" />
                    <span className="sr-only">{name}</span>
                  </button>
                );
              })}
            </div>
            {errors.icon !== undefined && <p className="text-sm text-red-600">{errors.icon}</p>}
          </fieldset>

          <div className="flex items-center gap-2">
            <Checkbox
              id="category-active"
              checked={form.isActive}
              onCheckedChange={(checked) => {
                setForm((previous) => ({ ...previous, isActive: checked === true }));
              }}
            />
            <Label htmlFor="category-active" className="font-normal">
              Attiva
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
