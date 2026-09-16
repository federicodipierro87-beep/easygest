import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';

import { AgendaPanel } from '@/components/AgendaPanel';
import { useSession } from '@/hooks/use-session';
import { dashboardSummaryQueryOptions } from '@/lib/dashboard';
import { formatDay, formatMoney } from '@/lib/format';

/**
 * L'agenda del giorno.
 *
 * Quattro riquadri e due numeri. Nessun selettore di periodo: quello è un
 * report, e i report hanno una pagina loro — mescolarli darebbe una pagina che
 * risponde male a due domande invece che bene a una.
 *
 * **Il riquadro che giustifica la pagina è «Da confermare».** Il cron marca
 * pagate le scadenze con rinnovo automatico ma lascia `confirmedAt` a nullo, e
 * questo è l'unico posto in cui quelle righe si vedono tutte insieme: è il
 * modo in cui ci si accorge che un fornitore ha alzato il prezzo. Senza,
 * l'aumento passerebbe come un addebito qualunque.
 *
 * **Il pallino di `/health` non c'è più.** Era impalcatura della Fase 1, e
 * costava una richiesta ogni trenta secondi per un'informazione che nessuno
 * guardava. Il prezzo è dichiarato: si perde l'unico modo di distinguere «API
 * giù» da «non c'è niente in scadenza», ed è per questo che gli stati d'errore
 * dei riquadri sono frasi esplicite e non scheletri grigi.
 */

/**
 * I preset dei collegamenti verso `/scadenze`.
 *
 * Viaggiano nello stato della navigazione e non nell'URL. È una scelta al
 * ribasso e va detta: il filtro non sopravvive a un ricaricamento né alla
 * condivisione del collegamento. Metterlo nell'URL richiederebbe di portare
 * *tutti* i filtri delle liste nella query string — un debito noto, che vale
 * la pena di pagare una volta sola per tutte le pagine invece che a metà per
 * questa.
 */
export type DuePreset = 'unconfirmed' | 'overdue' | 'upcoming';

export function DashboardPage() {
  const session = useSession();
  const summary = useQuery(dashboardSummaryQueryOptions());

  const data = summary.data;
  const baseCurrency = data?.baseCurrency ?? 'EUR';

  const shared = {
    baseCurrency,
    isPending: summary.isPending,
    isError: summary.isError,
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Ciao {session.user?.displayName ?? ''}
        </h1>
        {data !== undefined && (
          <p className="text-muted-foreground text-sm">Agenda del {formatDay(data.today)}</p>
        )}
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AgendaPanel
          {...shared}
          title="Da confermare"
          hint="Marcate pagate dal rinnovo automatico"
          section={data?.toConfirm}
          tone="warning"
          to="/scadenze"
          linkState={{ preset: 'unconfirmed' satisfies DuePreset }}
          linkLabel="Controllale tutte"
          emptyLabel="Niente da controllare."
        />

        <AgendaPanel
          {...shared}
          title="In ritardo"
          hint="Previste e già scadute"
          section={data?.overdue}
          tone="danger"
          to="/scadenze"
          linkState={{ preset: 'overdue' satisfies DuePreset }}
          linkLabel="Vedile tutte"
          emptyLabel="Nessun arretrato."
        />

        <AgendaPanel
          {...shared}
          title="Disdette"
          hint="Entro trenta giorni"
          section={data?.cancellations}
          useDeadline
          tone="warning"
          /*
           * Le disdette portano alle spese e non alle scadenze, perché
           * disdire è un'azione sulla spesa: è lì che stanno `autoRenew` e il
           * preavviso. Mandare all'occorrenza vorrebbe dire far tornare
           * indietro di un clic.
           */
          to="/spese"
          linkLabel="Vai alle spese"
          emptyLabel="Nessuna finestra aperta."
        />

        <AgendaPanel
          {...shared}
          title="In arrivo"
          hint="Nei prossimi sette giorni"
          section={data?.upcoming}
          to="/scadenze"
          linkState={{ preset: 'upcoming' satisfies DuePreset }}
          linkLabel="Vedile tutte"
          emptyLabel="Settimana libera."
        />
      </div>

      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <section className="rounded-xl border p-5">
          <h2 className="text-muted-foreground text-sm font-medium">Costo del mese in corso</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {data === undefined ? '—' : formatMoney(data.currentMonthCents, baseCurrency)}
          </p>
        </section>

        <section className="rounded-xl border p-5">
          <h2 className="text-muted-foreground text-sm font-medium">Media mensile</h2>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {data === undefined ? '—' : formatMoney(data.monthlyAverageCents, baseCurrency)}
          </p>
          {/*
            Il metro di paragone del numero accanto. Senza, un mese a metà
            sembra sempre basso: dirne il periodo è ciò che rende il confronto
            leggibile invece che ingannevole.
          */}
          <p className="text-muted-foreground mt-1 text-xs">Sui dodici mesi conclusi</p>
        </section>
      </div>

      <p className="text-muted-foreground text-sm print:hidden">
        Apri i{' '}
        <Link to="/report" className="text-foreground underline underline-offset-4">
          report
        </Link>{' '}
        per i totali per periodo, categoria e cliente.
      </p>
    </div>
  );
}
