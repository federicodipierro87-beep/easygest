import {
  EXPENSE_STATUS_LABELS,
  OCCURRENCE_STATUS_LABELS,
  type ExpenseStatus,
  type OccurrenceStatus,
} from '@easygest/shared';

import { Badge } from '@/components/ui/badge';

/**
 * Gli stati, detti a parole e colorati.
 *
 * Le etichette arrivano da `shared` e non da una copia locale: sono le stesse
 * che l'API usa nei messaggi d'errore, e vederne due versioni diverse della
 * stessa parola nella stessa schermata è peggio che vederla in inglese.
 *
 * Il colore invece è una decisione di questa parte, e non ha un posto in
 * `shared`: il server non disegna niente.
 */

const EXPENSE_VARIANTS: Record<ExpenseStatus, 'default' | 'secondary' | 'outline'> = {
  ACTIVE: 'default',
  PAUSED: 'secondary',
  CANCELLED: 'outline',
  ENDED: 'outline',
};

export function ExpenseStatusBadge({ status }: { status: ExpenseStatus }) {
  return <Badge variant={EXPENSE_VARIANTS[status]}>{EXPENSE_STATUS_LABELS[status]}</Badge>;
}

const OCCURRENCE_VARIANTS: Record<OccurrenceStatus, 'default' | 'secondary' | 'outline'> = {
  PLANNED: 'secondary',
  PAID: 'default',
  SKIPPED: 'outline',
  CANCELLED: 'outline',
};

interface OccurrenceBadgeProps {
  status: OccurrenceStatus;
  /** Quando è `null` su una pagata, l'ha data per pagata il cron. */
  confirmedAt: string | null;
}

/**
 * Lo stato di una scadenza, più l'avviso che nessuno l'ha guardata.
 *
 * «Pagata» da sola non distingue il pagamento che qualcuno ha visto arrivare da
 * quello che il cron ha dato per fatto alla scadenza. È la distinzione per cui
 * `confirmedAt` esiste, e nasconderla renderebbe il campo inutile: due etichette
 * accanto, non una sola che tace.
 */
export function OccurrenceStatusBadge({ status, confirmedAt }: OccurrenceBadgeProps) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge variant={OCCURRENCE_VARIANTS[status]}>{OCCURRENCE_STATUS_LABELS[status]}</Badge>
      {status === 'PAID' && confirmedAt === null ? (
        <Badge variant="destructive">Da confermare</Badge>
      ) : null}
    </span>
  );
}
