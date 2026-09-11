import { type Notification, notificationHref } from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { BellIcon } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatInstant } from '@/lib/format';
import {
  notificationListQueryOptions,
  unreadCountQueryOptions,
  useNotificationMutations,
} from '@/lib/notifications';
import { cn } from '@/lib/utils';

/**
 * La campanella.
 *
 * A popover chiuso viaggia un solo intero, una volta al minuto; l'elenco parte
 * all'apertura (`enabled: open`). È la ragione per cui il conteggio ha una
 * rotta sua: caricare venticinque righe per mostrarne il numero sarebbe
 * venticinque volte il traffico necessario, tutto il giorno.
 */

/** Oltre questo il numero non si legge più in un cerchietto di quattro millimetri. */
const MAX_BADGE = 9;

function badgeLabel(count: number): string {
  return count > MAX_BADGE ? `${String(MAX_BADGE)}+` : String(count);
}

/**
 * Il numero detto a parole, per chi non vede il pallino rosso.
 *
 * Un `aria-label` che dicesse solo «Notifiche» lascerebbe fuori l'unica
 * informazione che il badge porta.
 */
function bellLabel(count: number): string {
  if (count === 0) return 'Notifiche: nessuna da leggere';
  if (count === 1) return 'Notifiche: una da leggere';
  return `Notifiche: ${String(count)} da leggere`;
}

function NotificationRow({
  notification,
  onOpen,
}: {
  notification: Notification;
  onOpen: (notification: Notification) => void;
}) {
  const unread = notification.readAt === null;

  return (
    <button
      type="button"
      onClick={() => {
        onOpen(notification);
      }}
      className="hover:bg-muted/60 w-full rounded-md px-2 py-2 text-left transition-colors"
    >
      <span className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            'mt-1.5 size-1.5 shrink-0 rounded-full',
            unread ? 'bg-primary' : 'bg-transparent',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', unread && 'font-medium')}>
            {notification.title}
          </span>
          <span className="text-muted-foreground block truncate text-xs">{notification.body}</span>
          <span className="text-muted-foreground block text-xs">
            {formatInstant(notification.createdAt)}
          </span>
        </span>
      </span>
    </button>
  );
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { markRead, markAllRead } = useNotificationMutations();

  const unread = useQuery(unreadCountQueryOptions());
  const list = useQuery({ ...notificationListQueryOptions(false), enabled: open });

  const count = unread.data?.count ?? 0;
  const items = list.data?.items ?? [];

  /**
   * Un clic fa tre cose, e l'ordine non conta.
   *
   * Il popover si chiude subito e la navigazione parte: `markRead` viaggia per
   * conto suo, perché aspettarne la risposta per cambiare pagina farebbe
   * sembrare lenta l'applicazione per un aggiornamento che l'utente non sta
   * guardando. Se fallisce, la riga resta non letta — che è il difetto giusto
   * dalla parte giusta.
   */
  const openNotification = (notification: Notification): void => {
    setOpen(false);
    if (notification.readAt === null) markRead.mutate(notification.id);
    void navigate(notificationHref(notification));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={bellLabel(count)} className="relative">
          <BellIcon className="size-4" />
          {count > 0 && (
            <span
              aria-hidden
              className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-medium"
            >
              {badgeLabel(count)}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-88 p-2">
        <div className="flex items-center justify-between px-2 pt-1 pb-2">
          <span className="text-sm font-medium">Notifiche</span>
          <Link
            to="/impostazioni/avvisi"
            onClick={() => {
              setOpen(false);
            }}
            className="text-muted-foreground hover:text-foreground text-xs"
          >
            Impostazioni
          </Link>
        </div>

        {list.isPending && <p className="text-muted-foreground px-2 py-6 text-sm">Caricamento…</p>}
        {list.isError && (
          <p className="text-muted-foreground px-2 py-6 text-sm">
            Non è stato possibile leggere le notifiche.
          </p>
        )}
        {!list.isPending && !list.isError && items.length === 0 && (
          // Il vuoto qui è la normalità, non un guasto: il giro gira una volta
          // al giorno e la maggior parte dei giorni non c'è niente da dire.
          <p className="text-muted-foreground px-2 py-6 text-sm">Nessuna notifica.</p>
        )}

        <div className="max-h-96 overflow-y-auto">
          {items.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              onOpen={openNotification}
            />
          ))}
        </div>

        <div className="mt-1 border-t pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center"
            disabled={count === 0 || markAllRead.isPending}
            onClick={() => {
              markAllRead.mutate();
            }}
          >
            Segna tutte come lette
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
