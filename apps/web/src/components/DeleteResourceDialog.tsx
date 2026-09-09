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

interface DeleteResourceDialogProps {
  /** Il record da cancellare, oppure `null` quando la finestra è chiusa. */
  target: {
    name: string;
    expenseCount: number;
    /**
     * Facoltativo perché non tutte le risorse ce l'hanno: nessun documento
     * punta a un metodo di pagamento, e passare uno zero costante direbbe
     * «nessun documento collegato» dove la risposta giusta è «i documenti qui
     * non c'entrano».
     */
    documentCount?: number;
    /**
     * Ricreato dal seed a ogni avvio. Blocca la cancellazione da solo, senza
     * storico collegato: è una ragione diversa da `RESOURCE_IN_USE` e va detta
     * diversamente, perché la via d'uscita — archiviare — è la stessa ma il
     * motivo per cui la si prende no.
     */
    isSystem?: boolean;
  } | null;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
  /** «il cliente», «il fornitore»: entra nelle frasi. */
  what: string;
}

function describeHistory(expenses: number, documents: number): string {
  const parts: string[] = [];
  if (expenses > 0) parts.push(expenses === 1 ? 'una spesa' : `${String(expenses)} spese`);
  if (documents > 0) {
    parts.push(documents === 1 ? 'un documento' : `${String(documents)} documenti`);
  }
  return parts.join(' e ');
}

/**
 * Conferma di cancellazione, o spiegazione del perché non si può.
 *
 * I due casi stanno nella stessa finestra perché per l'utente sono lo stesso
 * gesto: ha premuto «elimina». I conteggi arrivano con la riga, quindi il
 * rifiuto si può mostrare subito invece di far premere un pulsante che
 * risponderà 409 — l'API lo rifiuterebbe comunque, ma questa è la differenza
 * fra spiegare prima e correggere dopo.
 */
export function DeleteResourceDialog({
  target,
  onCancel,
  onConfirm,
  pending,
  what,
}: DeleteResourceDialogProps) {
  const documents = target?.documentCount ?? 0;
  const attached = target === null ? 0 : target.expenseCount + documents;
  const isSystem = target?.isSystem ?? false;
  const blocked = isSystem || attached > 0;

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
            {blocked ? 'Non si può eliminare' : `Eliminare ${what}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target === null ? null : isSystem ? (
              <>
                «{target.name}» fa parte delle voci predefinite: verrebbe ricreata al primo riavvio,
                quindi eliminarla non la farebbe sparire davvero. Archiviala per toglierla dagli
                elenchi — quello resta.
              </>
            ) : blocked ? (
              <>
                «{target.name}» è collegato a {describeHistory(target.expenseCount, documents)}.
                Eliminarlo lascerebbe quello storico senza attribuzione: archivialo per toglierlo
                dagli elenchi senza perdere il collegamento.
              </>
            ) : (
              <>
                «{target.name}» verrà eliminato definitivamente. Non ha spese né documenti
                collegati, quindi non si perde nulla e il nome torna disponibile.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{blocked ? 'Chiudi' : 'Annulla'}</AlertDialogCancel>
          {!blocked && (
            <AlertDialogAction
              disabled={pending}
              onClick={(event) => {
                // La finestra si chiude da sé al click: fermarla lascia il
                // «Elimino…» visibile finché l'API non ha risposto, e il
                // rientro dopo un errore non è una finestra riaperta.
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
