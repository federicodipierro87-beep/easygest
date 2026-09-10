import type { Expense } from '@easygest/shared';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { occurrencesInUse } from '@/lib/expenses';

/**
 * Cancellare una spesa: chiedere, e poi spiegare il rifiuto.
 *
 * `DeleteResourceDialog` non va bene qui, e la ragione non è il testo. Quella
 * finestra è costruita tutta sul «lo so già dai conteggi»: la riga di un
 * cliente porta con sé `expenseCount` e `documentCount`, quindi il rifiuto si
 * può mostrare prima ancora di premere.
 *
 * Una spesa no. `occurrenceCount` è il totale delle occorrenze, ma l'API
 * rifiuta la cancellazione contando solo quelle il cui stato **non** è
 * «prevista» — una spesa con dodici scadenze tutte future si cancella senza
 * problemi, e una con una sola scadenza pagata no. Dalla riga i due casi sono
 * indistinguibili, e indovinare vorrebbe dire o spaventare chi poteva
 * procedere o promettere a chi non può.
 *
 * Quindi due stati: prima si chiede, e se il server rifiuta la finestra resta
 * aperta e cambia contenuto, offrendo le due vie d'uscita che restano —
 * sospenderla o disdirla, che sono il modo giusto di smettere di pagare
 * qualcosa di cui esiste uno storico.
 */

interface DeleteExpenseDialogProps {
  /** La spesa da cancellare, oppure `null` quando la finestra è chiusa. */
  target: Expense | null;
  onCancel: () => void;
  onConfirm: () => void;
  /** L'errore dell'ultimo tentativo, se c'è stato. */
  error: unknown;
  pending: boolean;
}

export function DeleteExpenseDialog({
  target,
  onCancel,
  onConfirm,
  error,
  pending,
}: DeleteExpenseDialogProps) {
  const refused = occurrencesInUse(error);

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {refused === null ? 'Eliminare la spesa?' : 'Non si può eliminare'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target === null ? null : refused === null ? (
              <>
                «{target.name}» verrà eliminata insieme alle sue scadenze future. Se ne esiste
                qualcuna già pagata o saltata, l’operazione verrà rifiutata: quello storico è la
                prova di ciò che hai speso.
              </>
            ) : (
              <>
                «{target.name}» ha {refused.occurrences === 1 ? 'una scadenza' : 'delle scadenze'}{' '}
                già registrate ({refused.occurrences}): eliminarla cancellerebbe la traccia di
                pagamenti avvenuti. Per smettere di pagarla senza perdere lo storico, mettila in
                pausa o segnala come disdetta dal modulo di modifica.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{refused === null ? 'Annulla' : 'Chiudi'}</AlertDialogCancel>
          {refused === null && (
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                // Senza questo la finestra si chiuderebbe al click, e il
                // rifiuto arriverebbe su una finestra che non c'è più.
                event.preventDefault();
                onConfirm();
              }}
            >
              {pending ? 'Elimino…' : 'Elimina'}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
