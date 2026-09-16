import type { AgendaSectionSummary } from '@easygest/shared';
import { Link } from 'react-router';

import { formatDay, formatMoney } from '@/lib/format';

/**
 * Un riquadro dell'agenda.
 *
 * Quattro istanze con dati diversi e una sola forma: conteggio, totale in
 * valuta base, fino a cinque righe e un collegamento all'elenco già filtrato.
 *
 * **Gli stati d'errore sono espliciti, non scheletri muti.** È il prezzo
 * dichiarato di aver tolto il pallino di `/health` dalla pagina: senza, «API
 * irraggiungibile» e «non c'è niente in scadenza» si assomiglierebbero
 * troppo — quattro riquadri vuoti e nessun modo di distinguere la quiete dal
 * guasto. Un riquadro che dice di non essere riuscito a leggere lo dice più
 * forte di quanto facesse un pallino verde in un angolo.
 */

export interface AgendaPanelProps {
  title: string;
  /** Cosa si sta guardando, quando il titolo da solo è ambiguo. */
  hint?: string;
  section: AgendaSectionSummary | undefined;
  baseCurrency: string;
  isPending: boolean;
  isError: boolean;
  /** Dove si va per vederle tutte, e con quale filtro già impostato. */
  to: string;
  linkState?: unknown;
  linkLabel: string;
  /** Cosa si scrive quando non ce n'è nessuna. Una buona notizia, di solito. */
  emptyLabel: string;
  /** Nelle disdette la data da mostrare è il termine, non il rinnovo. */
  useDeadline?: boolean;
  /** Colora il conteggio quando non è una sezione neutra. */
  tone?: 'neutral' | 'warning' | 'danger';
}

const TONES: Record<'neutral' | 'warning' | 'danger', string> = {
  neutral: 'text-foreground',
  warning: 'text-amber-600',
  danger: 'text-red-600',
};

export function AgendaPanel({
  title,
  hint,
  section,
  baseCurrency,
  isPending,
  isError,
  to,
  linkState,
  linkLabel,
  emptyLabel,
  useDeadline = false,
  tone = 'neutral',
}: AgendaPanelProps) {
  return (
    <section className="flex flex-col rounded-xl border p-5 break-inside-avoid">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {section !== undefined && (
          <span className={`text-2xl font-semibold tabular-nums ${TONES[tone]}`}>
            {section.total}
          </span>
        )}
      </header>

      {hint !== undefined && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}

      {isPending && <p className="text-muted-foreground mt-4 text-sm">Caricamento…</p>}

      {isError && (
        <p className="mt-4 text-sm text-red-600">
          Non è stato possibile leggere questa sezione. Ricarica la pagina.
        </p>
      )}

      {section !== undefined && (
        <>
          <p className="text-muted-foreground mt-1 text-sm tabular-nums">
            {formatMoney(section.totalCents, baseCurrency)}
          </p>

          {section.lines.length === 0 ? (
            <p className="text-muted-foreground mt-4 text-sm">{emptyLabel}</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2">
              {section.lines.map((line) => (
                <li
                  key={line.occurrenceId}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <span className="truncate">{line.expenseName}</span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {formatDay(useDeadline ? (line.deadline ?? line.dueDate) : line.dueDate)}
                    {' · '}
                    {formatMoney(line.grossCents, line.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/*
            Il collegamento c'è anche quando le righe sono cinque su cinque:
            è l'unico modo di raggiungere la sesta, e nasconderlo quando la
            sezione è piena sarebbe nasconderlo proprio quando serve.
          */}
          <Link
            to={to}
            state={linkState}
            className="text-muted-foreground hover:text-foreground mt-4 self-start text-xs underline underline-offset-4 print:hidden"
          >
            {linkLabel}
          </Link>
        </>
      )}
    </section>
  );
}
