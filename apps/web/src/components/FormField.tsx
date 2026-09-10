import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * I campi dei moduli.
 *
 * Il componente rende anche il controllo, invece di limitarsi a incorniciare
 * quello che gli passi: `id`, `aria-describedby` e il messaggio d'errore vanno
 * collegati fra loro, e a ripeterlo a mano su dodici caselle prima o poi uno
 * si scorda. Su una casella senza `aria-describedby` un lettore di schermo
 * annuncia l'etichetta e il valore, ma non il motivo per cui è rossa.
 *
 * L'errore sta sotto il campo che lo ha causato, non in fondo al modulo:
 * «Dati non validi» in coda costringerebbe a cercare a occhio quale delle
 * dodici caselle riscrivere.
 *
 * Tendine e caselle da spuntare arrivano qui adesso e non prima: nelle
 * anagrafiche il blocco compariva tre volte, nel modulo della spesa tornerebbe
 * otto, e ognuna delle otto sarebbe un'occasione per scordare il collegamento.
 */

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Messaggio dell'API per questo campo, quando c'è. */
  error?: string;
  hint?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel' | 'url' | 'date';
  autoFocus?: boolean;
}

function describedBy(id: string, error: string | undefined, hint: string | undefined) {
  if (error !== undefined) return `${id}-error`;
  if (hint !== undefined) return `${id}-hint`;
  return undefined;
}

function Messages({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  if (error !== undefined) {
    return (
      <p id={`${id}-error`} className="text-sm text-red-600">
        {error}
      </p>
    );
  }
  if (hint !== undefined) {
    return (
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        {hint}
      </p>
    );
  }
  return null;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  placeholder,
  type = 'text',
  autoFocus,
}: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, error, hint)}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

export function TextAreaField({ id, label, value, onChange, error, hint }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        rows={3}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, error, hint)}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectFieldProps extends Omit<FieldProps, 'type' | 'autoFocus'> {
  options: readonly SelectOption[];
  disabled?: boolean;
}

/**
 * Una tendina, con l'etichetta e l'errore collegati come sulle caselle.
 *
 * `onValueChange` arriva da Radix tipizzato `string`, e resta `string` anche
 * qui: chi chiama sa in quale enum ricade il valore, questo componente no. Il
 * restringimento avviene una volta sola nel gestore di chi ha scritto le
 * opzioni, invece che dentro a un componente che dovrebbe accettarne quattro
 * enum diversi.
 */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  error,
  hint,
  placeholder,
  disabled,
}: SelectFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy(id, error, hint)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}

interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  error?: string;
}

/**
 * Una casella da spuntare, con l'etichetta accanto e non sopra.
 *
 * L'etichetta è cliccabile perché `htmlFor` punta alla casella: su un
 * quadratino di sedici pixel è la differenza fra spuntarlo e mancarlo.
 * `onCheckedChange` di Radix può valere anche `'indeterminate'`, che qui non
 * si usa: il confronto con `true` lo riduce a un booleano senza bugie.
 */
export function CheckboxField({ id, label, checked, onChange, hint, error }: CheckboxFieldProps) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={checked}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy(id, error, hint)}
          onCheckedChange={(next) => {
            onChange(next === true);
          }}
        />
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
      </div>
      <Messages id={id} error={error} hint={hint} />
    </div>
  );
}
