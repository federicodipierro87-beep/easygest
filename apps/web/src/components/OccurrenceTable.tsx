import type { ExpenseOccurrence, OccurrencePatch } from '@easygest/shared';
import { Check, Pencil, SkipForward, Undo2 } from 'lucide-react';
import { Link } from 'react-router';

import { OccurrenceStatusBadge } from '@/components/StatusBadges';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { describeDue, formatDay, formatInstant, formatMoney } from '@/lib/format';

/**
 * Le scadenze, in tabella.
 *
 * La stessa da due parti — l'elenco globale e il dettaglio di una spesa —
 * perché è la stessa domanda posta con due filtri diversi, e due tabelle
 * gemelle divergerebbero al primo campo aggiunto. L'unica differenza vera è la
 * colonna col nome della spesa, che sul suo dettaglio ripeterebbe il titolo
 * della pagina su ogni riga.
 *
 * Le azioni sono quelle che lo stato attuale ammette, e non tutte disabilitate:
 * un pulsante grigio non dice perché è grigio, e la risposta — «questa è già
 * pagata» — è già scritta accanto nell'etichetta di stato.
 */

interface OccurrenceTableProps {
  items: ExpenseOccurrence[] | undefined;
  /** Sul dettaglio di una spesa il nome sarebbe il titolo della pagina ripetuto. */
  showExpense: boolean;
  onEdit: (occurrence: ExpenseOccurrence) => void;
  onPatch: (id: string, patch: OccurrencePatch) => void;
  /** Quale riga sta aspettando l'API, per spegnere solo i suoi pulsanti. */
  pendingId: string | null;
  emptyMessage: string;
}

export function OccurrenceTable({
  items,
  showExpense,
  onEdit,
  onPatch,
  pendingId,
  emptyMessage,
}: OccurrenceTableProps) {
  const columns = showExpense ? 6 : 5;

  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scadenza</TableHead>
            {showExpense && <TableHead>Spesa</TableHead>}
            <TableHead className="text-right">Importo</TableHead>
            <TableHead>Stato</TableHead>
            <TableHead>Pagata il</TableHead>
            <TableHead className="w-36" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items === undefined && (
            <TableRow>
              <TableCell colSpan={columns} className="text-muted-foreground py-10 text-center">
                Caricamento…
              </TableCell>
            </TableRow>
          )}

          {items?.length === 0 && (
            <TableRow>
              <TableCell colSpan={columns} className="text-muted-foreground py-10 text-center">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}

          {items?.map((occurrence) => {
            const busy = pendingId === occurrence.id;
            const planned = occurrence.status === 'PLANNED';
            const unconfirmed = occurrence.status === 'PAID' && occurrence.confirmedAt === null;

            return (
              <TableRow key={occurrence.id}>
                <TableCell>
                  <span className="tabular-nums">{formatDay(occurrence.dueDate)}</span>
                  {planned && (
                    <p className="text-muted-foreground text-xs">
                      {describeDue(occurrence.dueDate)}
                    </p>
                  )}
                </TableCell>

                {showExpense && (
                  <TableCell className="font-medium">
                    <Link to={`/spese/${occurrence.expenseId}`} className="hover:underline">
                      {occurrence.expenseName}
                    </Link>
                  </TableCell>
                )}

                <TableCell className="text-right tabular-nums">
                  {formatMoney(occurrence.grossCents, occurrence.currency)}
                  {/*
                    Il convertito si mostra solo quando è un'altra cifra: su una
                    spesa in euro sarebbe la stessa riga scritta due volte.
                  */}
                  {occurrence.currency !== 'EUR' && (
                    <p className="text-muted-foreground text-xs">
                      {formatMoney(occurrence.baseGrossCents)}
                    </p>
                  )}
                </TableCell>

                <TableCell>
                  <OccurrenceStatusBadge
                    status={occurrence.status}
                    confirmedAt={occurrence.confirmedAt}
                  />
                </TableCell>

                <TableCell className="text-muted-foreground text-sm">
                  {formatInstant(occurrence.paidAt)}
                </TableCell>

                <TableCell>
                  <div className="flex justify-end gap-1">
                    {planned && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Segna pagata"
                          disabled={busy}
                          onClick={() => {
                            // Confermata nello stesso gesto: chi preme *sta
                            // guardando*, e `confirmedAt` nullo è precisamente
                            // lo stato che lascia il cron quando nessuno ha
                            // guardato. Lasciarla da confermare vorrebbe dire
                            // chiedere due click per un'unica constatazione.
                            onPatch(occurrence.id, { status: 'PAID', confirmed: true });
                          }}
                        >
                          <Check aria-hidden className="size-4" />
                          <span className="sr-only">
                            Segna pagata la scadenza del {formatDay(occurrence.dueDate)}
                          </span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Salta"
                          disabled={busy}
                          onClick={() => {
                            onPatch(occurrence.id, { status: 'SKIPPED' });
                          }}
                        >
                          <SkipForward aria-hidden className="size-4" />
                          <span className="sr-only">
                            Salta la scadenza del {formatDay(occurrence.dueDate)}
                          </span>
                        </Button>
                      </>
                    )}

                    {unconfirmed && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() => {
                          onPatch(occurrence.id, { confirmed: true });
                        }}
                      >
                        Conferma
                      </Button>
                    )}

                    {!planned && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Rimetti fra le previste"
                        disabled={busy}
                        onClick={() => {
                          onPatch(occurrence.id, { status: 'PLANNED' });
                        }}
                      >
                        <Undo2 aria-hidden className="size-4" />
                        <span className="sr-only">
                          Rimetti fra le previste la scadenza del {formatDay(occurrence.dueDate)}
                        </span>
                      </Button>
                    )}

                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Correggi"
                      disabled={busy}
                      onClick={() => {
                        onEdit(occurrence);
                      }}
                    >
                      <Pencil aria-hidden className="size-4" />
                      <span className="sr-only">
                        Correggi la scadenza del {formatDay(occurrence.dueDate)}
                      </span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
