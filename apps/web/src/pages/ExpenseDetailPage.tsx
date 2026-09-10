import {
  rebilledAmount,
  REBILL_MODE_LABELS,
  type Expense,
  type ExpenseFormInput,
  type ExpenseOccurrence,
  type OccurrencePatch,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { DeleteExpenseDialog } from '@/components/DeleteExpenseDialog';
import { ExpenseFormDialog } from '@/components/ExpenseFormDialog';
import { OccurrenceEditDialog } from '@/components/OccurrenceEditDialog';
import { OccurrenceTable } from '@/components/OccurrenceTable';
import { ExpenseStatusBadge } from '@/components/StatusBadges';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import {
  ALL,
  expenseQueryOptions,
  isNotFound,
  occurrenceListQueryOptions,
  useExpenseMutations,
  useOccurrenceMutations,
  type OccurrenceFilters,
} from '@/lib/expenses';
import {
  daysUntil,
  describeDue,
  describeRecurrence,
  formatDay,
  formatMoney,
  percentFromBasisPoints,
} from '@/lib/format';

/**
 * Il dettaglio di una spesa, e le sue scadenze.
 *
 * Quattro riquadri e poi la tabella. Il quarto — la disdetta — è quello per cui
 * questa pagina esiste: `nextCancellationDeadline` è l'ultimo giorno utile per
 * disdire prima del prossimo rinnovo, ed è l'unico dato dell'applicazione che
 * ha una scadenza sua, nel senso che saperlo il giorno dopo non serve a niente.
 * Gli altri tre raccontano quello che si è inserito; questo dice cosa fare.
 */

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border p-4">
      <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h2>
      <dl className="mt-3 grid gap-1.5 text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** Sotto questa soglia la disdetta è una cosa da fare, non da sapere. */
const DEADLINE_WARNING_DAYS = 45;

export function ExpenseDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [correcting, setCorrecting] = useState<ExpenseOccurrence | null>(null);

  const detail = useQuery(expenseQueryOptions(id));

  const filters: OccurrenceFilters = {
    q: '',
    page: 1,
    expenseId: id,
    status: ALL,
    from: '',
    to: '',
    unconfirmed: false,
    sort: 'dueDate',
    direction: 'asc',
  };
  const occurrences = useQuery({
    ...occurrenceListQueryOptions(filters),
    // Senza la spesa non c'è nulla di cui elencare le scadenze, e con un
    // identificativo inesistente sarebbe una seconda richiesta per ottenere
    // una seconda volta lo stesso 404.
    enabled: detail.isSuccess,
  });

  const { update, remove } = useExpenseMutations();
  const { patch } = useOccurrenceMutations();

  /**
   * Un identificativo sconosciuto non rimanda all'elenco.
   *
   * Il rimbalzo farebbe sparire l'indirizzo sbagliato dalla barra prima che
   * qualcuno possa leggerlo, e chi è arrivato qui da un segnalibro vecchio si
   * ritroverebbe sull'elenco senza sapere perché. La frase resta, e il
   * collegamento lo porta via lui.
   */
  if (isNotFound(detail.error)) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Spesa non trovata</h1>
        <p className="text-muted-foreground text-sm">
          Questa spesa non esiste più, oppure non è tua. Può essere stata eliminata da un’altra
          scheda.
        </p>
        <Link to="/spese" className="text-sm underline">
          Torna all’elenco delle spese
        </Link>
      </div>
    );
  }

  if (detail.isPending) {
    return <p className="text-muted-foreground text-sm">Caricamento…</p>;
  }

  if (detail.isError) {
    return (
      <p className="text-sm text-red-600">
        {detail.error instanceof ApiError
          ? detail.error.message
          : 'Errore imprevisto durante la lettura.'}
      </p>
    );
  }

  const expense = detail.data;
  const deadline = expense.nextCancellationDeadline;
  const toDeadline = deadline === null ? null : daysUntil(deadline);
  const urgent = toDeadline !== null && toDeadline <= DEADLINE_WARNING_DAYS;
  const rebilled = rebilledAmount(expense, expense.grossCents);

  async function submit(input: ExpenseFormInput): Promise<void> {
    await update.mutateAsync({ id, input });
    setFormOpen(false);
  }

  function correct(occurrenceId: string, body: OccurrencePatch) {
    void patch.mutateAsync({ id: occurrenceId, patch: body }).then(
      () => {
        setCorrecting(null);
      },
      () => {
        // Il messaggio esce dalla finestra di correzione, che resta aperta.
        // Dai pulsanti della tabella un rifiuto è raro — sono transizioni che
        // l'API ammette sempre — e la riga non cambia: si vede che non è
        // successo niente.
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/spese" className="text-muted-foreground text-sm hover:underline">
            ← Spese
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{expense.name}</h1>
            <ExpenseStatusBadge status={expense.status} />
          </div>
          {expense.description !== null && (
            <p className="text-muted-foreground mt-1 text-sm">{expense.description}</p>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              update.reset();
              setFormOpen(true);
            }}
          >
            <Pencil aria-hidden className="size-4" />
            Modifica
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              remove.reset();
              setDeleting(expense);
            }}
          >
            <Trash2 aria-hidden className="size-4" />
            Elimina
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Importo">
          <Row label="Imponibile">{formatMoney(expense.netCents, expense.currency)}</Row>
          <Row label="IVA">{percentFromBasisPoints(expense.vatRateBp)}%</Row>
          <Row label="Totale">
            <span className="font-medium">{formatMoney(expense.grossCents, expense.currency)}</span>
          </Row>
          <Row label="Valuta">{expense.currency}</Row>
        </Panel>

        <Panel title="Ricorrenza">
          <Row label="Frequenza">
            {describeRecurrence(expense.recurrenceUnit, expense.recurrenceInterval)}
          </Row>
          <Row label="Inizio">{formatDay(expense.startDate)}</Row>
          <Row label="Fine">{formatDay(expense.endDate)}</Row>
          <Row label="Prossima scadenza">
            {expense.nextDueDate === null ? (
              '—'
            ) : (
              <>
                {formatDay(expense.nextDueDate)}{' '}
                <span className="text-muted-foreground">({describeDue(expense.nextDueDate)})</span>
              </>
            )}
          </Row>
        </Panel>

        <Panel title="Collegamenti">
          <Row label="Fornitore">{expense.vendorName ?? '—'}</Row>
          <Row label="Categoria">{expense.categoryName ?? '—'}</Row>
          <Row label="Metodo di pagamento">{expense.paymentMethodLabel ?? '—'}</Row>
          <Row label="Cliente">{expense.clientName ?? '—'}</Row>
        </Panel>

        <Panel title="Disdetta">
          <Row label="Si rinnova da sola">{expense.autoRenew ? 'Sì' : 'No'}</Row>
          <Row label="Preavviso">
            {expense.cancellationNoticeDays === null
              ? '—'
              : `${String(expense.cancellationNoticeDays)} giorni`}
          </Row>
          <Row label="Disdetta inviata il">{formatDay(expense.cancelledAt)}</Row>
          <Row label="Ultimo giorno utile">
            {deadline === null ? (
              '—'
            ) : urgent ? (
              <Badge variant="destructive">
                {formatDay(deadline)} · {describeDue(deadline)}
              </Badge>
            ) : (
              <>
                {formatDay(deadline)}{' '}
                <span className="text-muted-foreground">({describeDue(deadline)})</span>
              </>
            )}
          </Row>
        </Panel>

        {/*
          Il riquadro del riaddebito compare solo quando c'è: su una spesa che
          non si riaddebita direbbe «Non riaddebitata» e tre trattini.
        */}
        {expense.rebillMode !== 'NONE' && (
          <Panel title="Riaddebito">
            <Row label="Modo">{REBILL_MODE_LABELS[expense.rebillMode]}</Row>
            {expense.rebillMode === 'MARKUP' && (
              <Row label="Ricarico">{percentFromBasisPoints(expense.rebillMarkupBp)}%</Row>
            )}
            <Row label="Riaddebitato">
              {rebilled === null ? '—' : formatMoney(rebilled, expense.currency)}
            </Row>
            <Row label="Margine">
              {rebilled === null
                ? '—'
                : formatMoney(rebilled - expense.grossCents, expense.currency)}
            </Row>
          </Panel>
        )}

        {expense.notes !== null && (
          <Panel title="Note">
            <p className="whitespace-pre-wrap">{expense.notes}</p>
          </Panel>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Scadenze</h2>
        <OccurrenceTable
          items={occurrences.data?.items}
          showExpense={false}
          onEdit={setCorrecting}
          onPatch={correct}
          pendingId={patch.isPending ? (patch.variables?.id ?? null) : null}
          emptyMessage="Nessuna scadenza. Una spesa disdetta o conclusa non ne genera di nuove."
        />
        {occurrences.data !== undefined && occurrences.data.totalPages > 1 && (
          <p className="text-muted-foreground text-sm">
            Le prime {occurrences.data.items.length} di {occurrences.data.total}.
          </p>
        )}
      </section>

      {/*
        La `key` legata all'apertura rigenera lo stato del modulo ogni volta
        che si apre: senza, riaprirlo dopo un salvataggio mostrerebbe quello
        che si era scritto invece di quello che il server ha normalizzato.
      */}
      <ExpenseFormDialog
        key={formOpen ? 'aperto' : 'chiuso'}
        open={formOpen}
        onOpenChange={setFormOpen}
        expense={expense}
        onSubmit={submit}
        pending={update.isPending}
        error={update.error}
      />

      <DeleteExpenseDialog
        target={deleting}
        pending={remove.isPending}
        error={remove.error}
        onCancel={() => {
          setDeleting(null);
          remove.reset();
        }}
        onConfirm={() => {
          void remove.mutateAsync(expense.id).then(
            () => {
              // Qui il rimbalzo ci vuole: la pagina che si sta guardando non
              // esiste più, e restarci mostrerebbe il 404 di una spesa che si
              // è appena eliminata di proposito.
              void navigate('/spese', { replace: true });
            },
            () => {
              // Il rifiuto lo legge la finestra da `remove.error`.
            },
          );
        }}
      />

      <OccurrenceEditDialog
        occurrence={correcting}
        onClose={() => {
          setCorrecting(null);
          patch.reset();
        }}
        onSubmit={(body) =>
          patch.mutateAsync({ id: correcting?.id ?? '', patch: body }).then(
            () => {
              setCorrecting(null);
            },
            () => {
              // Il messaggio resta nella finestra, che resta aperta: quello
              // che si stava correggendo è ancora lì da correggere.
            },
          )
        }
        pending={patch.isPending}
        error={patch.error}
      />
    </div>
  );
}
