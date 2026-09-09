import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/**
 * I campi di testo dei moduli delle anagrafiche.
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
  type?: 'text' | 'email' | 'tel' | 'url';
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
