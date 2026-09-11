import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_ENTITY_TYPES,
  notificationHref,
  notificationListQuerySchema,
} from './notifications';

describe('destinazione di una notifica', () => {
  it('porta al dettaglio della spesa quando sa quale', () => {
    expect(notificationHref({ entityType: 'expense', entityId: 'exp1' })).toBe('/spese/exp1');
  });

  it('porta all\u2019elenco quando parla di pi\u00f9 occorrenze insieme', () => {
    // È il caso della notifica raggruppata delle scadenze marcate pagate: ha
    // un tipo ma non un identificativo, e un link all'elenco è meglio di
    // nessun link.
    expect(notificationHref({ entityType: 'occurrence', entityId: null })).toBe('/scadenze');
    expect(notificationHref({ entityType: 'expense', entityId: null })).toBe('/spese');
  });

  it('manda la carta in scadenza dove la si corregge', () => {
    expect(notificationHref({ entityType: 'paymentMethod', entityId: 'pm1' })).toBe(
      '/impostazioni/metodi-di-pagamento',
    );
  });

  it('ha una destinazione per ogni tipo dichiarato', () => {
    for (const entityType of NOTIFICATION_ENTITY_TYPES) {
      expect(notificationHref({ entityType, entityId: 'x' })).toMatch(/^\//);
    }
    expect(notificationHref({ entityType: null, entityId: null })).toMatch(/^\//);
  });
});

describe('parametri dell\u2019elenco', () => {
  it('impagina dalla prima pagina', () => {
    const parsed = notificationListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.unread).toBeUndefined();
  });

  it('legge `unread` come booleano, non come stringa', () => {
    expect(notificationListQuerySchema.parse({ unread: 'true' }).unread).toBe(true);
    expect(notificationListQuerySchema.parse({ unread: 'false' }).unread).toBe(false);
  });

  it('rifiuta un `unread` che non sia s\u00ec o no', () => {
    // Senza l'enum, `unread=1` diventerebbe `false` in silenzio e l'utente
    // vedrebbe tutte le notifiche credendo di vedere solo le non lette.
    expect(notificationListQuerySchema.safeParse({ unread: '1' }).success).toBe(false);
  });

  it('mette un tetto a `perPage`', () => {
    expect(notificationListQuerySchema.safeParse({ perPage: '1000' }).success).toBe(false);
  });
});
