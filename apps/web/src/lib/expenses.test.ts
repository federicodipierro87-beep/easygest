import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import {
  ALL,
  DEFAULT_EXPENSE_FILTERS,
  type OccurrenceFilters,
  expenseQueryString,
  occurrenceQueryString,
  occurrencesInUse,
} from './expenses';
import { inUseDetails } from './resources';

/**
 * Il livello dati, provato dove si sbaglia davvero.
 *
 * Due cose: che la query string non porti in giro i valori di default — sono
 * chiavi di cache diverse per la stessa identica lista — e che le due forme di
 * `RESOURCE_IN_USE` non si scambino di posto. Le mutazioni e le invalidazioni
 * hanno bisogno di React e di un server, e provarle qui vorrebbe dire provare
 * TanStack Query.
 */

const DEFAULT_OCCURRENCE_FILTERS: OccurrenceFilters = {
  q: '',
  page: 1,
  expenseId: ALL,
  status: ALL,
  from: '',
  to: '',
  unconfirmed: false,
  sort: 'dueDate',
  direction: 'asc',
};

describe('query string delle spese', () => {
  it('non manda niente quando non si è scelto niente', () => {
    expect(expenseQueryString(DEFAULT_EXPENSE_FILTERS)).toBe('');
  });

  it('manda solo i filtri toccati', () => {
    const query = expenseQueryString({
      ...DEFAULT_EXPENSE_FILTERS,
      status: 'ACTIVE',
      vendorId: 'v1',
      page: 3,
    });

    const params = new URLSearchParams(query);
    expect(params.get('status')).toBe('ACTIVE');
    expect(params.get('vendorId')).toBe('v1');
    expect(params.get('page')).toBe('3');
    // Le tendine lasciate su «Tutti» non compaiono: `all` non è un valore che
    // l'API conosca, e mandarlo sarebbe un 422.
    expect(params.has('categoryId')).toBe(false);
    expect(params.has('clientId')).toBe(false);
    expect(params.has('sort')).toBe(false);
  });

  it('manda la finestra di scadenza solo se ha almeno un estremo', () => {
    const query = expenseQueryString({ ...DEFAULT_EXPENSE_FILTERS, dueTo: '2027-05-31' });

    const params = new URLSearchParams(query);
    expect(params.get('dueTo')).toBe('2027-05-31');
    expect(params.has('dueFrom')).toBe(false);
  });
});

describe('query string delle scadenze', () => {
  it('non manda niente quando non si è scelto niente', () => {
    expect(occurrenceQueryString(DEFAULT_OCCURRENCE_FILTERS)).toBe('');
  });

  it('manda «da confermare» solo quando è acceso', () => {
    // Lo schema dell'API confronta la stringa con `'true'`: `unconfirmed=false`
    // direbbe esattamente quanto dice non mandarlo, e sarebbe una chiave di
    // cache in più per la stessa lista.
    expect(occurrenceQueryString(DEFAULT_OCCURRENCE_FILTERS)).not.toContain('unconfirmed');

    const query = occurrenceQueryString({ ...DEFAULT_OCCURRENCE_FILTERS, unconfirmed: true });
    expect(new URLSearchParams(query).get('unconfirmed')).toBe('true');
  });

  it('porta la finestra e lo stato quando ci sono', () => {
    const query = occurrenceQueryString({
      ...DEFAULT_OCCURRENCE_FILTERS,
      status: 'PLANNED',
      to: '2027-05-14',
    });

    const params = new URLSearchParams(query);
    expect(params.get('status')).toBe('PLANNED');
    expect(params.get('to')).toBe('2027-05-14');
    // Lo scaduto non pagato deve restare visibile: `from` vuoto è una scelta,
    // non una dimenticanza.
    expect(params.has('from')).toBe(false);
  });
});

describe('le due forme di RESOURCE_IN_USE', () => {
  const expenseRefusal = new ApiError(409, 'RESOURCE_IN_USE', 'La spesa ha dello storico', 'r1', {
    occurrences: 7,
  });
  const clientRefusal = new ApiError(409, 'RESOURCE_IN_USE', 'Il cliente ha dello storico', 'r2', {
    expenses: 2,
    documents: 0,
  });

  it('legge il conteggio delle occorrenze', () => {
    expect(occurrencesInUse(expenseRefusal)).toEqual({ occurrences: 7 });
  });

  it('non scambia una forma per l’altra', () => {
    // Stesso codice, dettagli diversi: senza il controllo sul tipo dei campi,
    // il dialogo delle spese direbbe «0 scadenze registrate» sul rifiuto di un
    // cliente, che è una frase falsa su un errore che non lo riguarda.
    expect(occurrencesInUse(clientRefusal)).toBeNull();
    expect(inUseDetails(expenseRefusal)).toBeNull();
  });

  it('tace su un errore che non è un rifiuto di cancellazione', () => {
    expect(occurrencesInUse(new ApiError(500, 'UNEXPECTED_ERROR', 'Errore 500'))).toBeNull();
    expect(occurrencesInUse(new Error('rete'))).toBeNull();
    expect(occurrencesInUse(null)).toBeNull();
  });
});
