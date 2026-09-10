import { SelectField, type SelectOption } from '@/components/FormField';
import type { RelationOption } from '@/lib/relations';

/**
 * La tendina di un collegamento facoltativo.
 *
 * Tutte e quattro le relazioni di una spesa possono restare vuote, e «vuoto» va
 * potuto scegliere: senza una voce apposta, chi ha collegato per sbaglio un
 * fornitore non ha modo di tornare indietro se non ricreando la spesa.
 *
 * Il valore di quella voce è `'none'` e non la stringa vuota per la stessa
 * ragione per cui il filtro usa `'all'`: Radix riserva `value=""` per «nessuna
 * scelta» e rifiuta con un errore a runtime un `SelectItem` che la usi. Le due
 * sentinelle restano distinte perché dicono cose diverse — «non filtrare» non è
 * «non collegare» — e confonderle manderebbe `all` come `vendorId`.
 */

export const NONE = 'none';

interface RelationSelectProps {
  id: string;
  label: string;
  /** L'identificativo collegato, oppure `null` se non c'è. */
  value: string | null;
  onChange: (id: string | null) => void;
  options: readonly RelationOption[];
  /** Il testo della voce vuota: «Nessun fornitore» dice più di «Nessuno». */
  emptyLabel: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
}

export function RelationSelect({
  id,
  label,
  value,
  onChange,
  options,
  emptyLabel,
  error,
  hint,
  disabled,
}: RelationSelectProps) {
  const items: SelectOption[] = [
    { value: NONE, label: emptyLabel },
    ...options.map((option) => ({ value: option.id, label: option.name })),
  ];

  return (
    <SelectField
      id={id}
      label={label}
      value={value ?? NONE}
      onChange={(next) => {
        onChange(next === NONE ? null : next);
      }}
      options={items}
      error={error}
      hint={hint}
      disabled={disabled}
    />
  );
}
