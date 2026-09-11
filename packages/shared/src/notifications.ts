import { z } from 'zod';

import { MAX_PER_PAGE, DEFAULT_PER_PAGE } from './resources';
import type { ReminderKind } from './reminders';

/**
 * Le notifiche in-app.
 *
 * Sono la rete di sicurezza degli avvisi: una riga in tabella non dipende da
 * nessun servizio esterno, quindi c'è anche nei giorni in cui l'email non
 * parte. Per questo vengono scritte *prima* dell'invio e per questo l'elenco
 * qui sotto non ha un filtro per genere — chi guarda la campanella vuole
 * sapere cosa è successo, non cercare fra i generi.
 */

/**
 * A cosa può puntare una notifica.
 *
 * `entityType` non è una foreign key nello schema, perché punta a tabelle
 * diverse; l'elenco chiuso qui è ciò che tiene onesto il campo, e serve al
 * frontend per costruire il link senza un `switch` su stringhe libere.
 */
export const NOTIFICATION_ENTITY_TYPES = ['occurrence', 'expense', 'paymentMethod'] as const;
export const notificationEntityTypeSchema = z.enum(NOTIFICATION_ENTITY_TYPES);
export type NotificationEntityType = z.infer<typeof notificationEntityTypeSchema>;

export interface Notification {
  id: string;
  kind: ReminderKind;
  title: string;
  body: string;
  entityType: NotificationEntityType | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Dove porta il clic su una notifica.
 *
 * `entityId` può essere nullo con `entityType` valorizzato: è il caso della
 * notifica raggruppata delle scadenze marcate pagate, che parla di N
 * occorrenze e quindi non può puntarne una. Il tipo da solo basta a scegliere
 * l'elenco giusto, ed è meglio di un link assente.
 */
export function notificationHref(notification: {
  entityType: NotificationEntityType | null;
  entityId: string | null;
}): string {
  switch (notification.entityType) {
    case 'occurrence':
      return '/scadenze';
    case 'expense':
      return notification.entityId === null ? '/spese' : `/spese/${notification.entityId}`;
    case 'paymentMethod':
      return '/impostazioni/metodi-di-pagamento';
    case null:
      return '/scadenze';
  }
}

/**
 * I parametri dell'elenco.
 *
 * Scritto a mano invece di passare da `buildListQuerySchema`: le notifiche non
 * si cercano per testo, non si archiviano e hanno un ordinamento solo — dalla
 * più recente. Ereditare `q`, `archived`, `sort` e `direction` significherebbe
 * accettarli e poi ignorarli, che è il modo più rapido di far credere a chi
 * chiama che funzionino.
 */
export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE),
  /** Assente vale «tutte», non «solo lette». */
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

/**
 * Il badge: solo un numero, su una rotta sua.
 *
 * Il frontend lo chiede ogni minuto; infilarlo nell'elenco significherebbe
 * caricare venticinque righe per mostrarne il conteggio, e rompere la forma di
 * `Paginated<T>`, che è uguale per tutte le risorse.
 */
export interface UnreadCount {
  count: number;
}
