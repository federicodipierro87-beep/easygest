import { useEffect, useState } from 'react';

/**
 * Ritarda la propagazione di un valore che cambia a ogni tasto.
 *
 * Serve alla casella di ricerca: senza, «assicurazione» sono tredici richieste
 * all'API, dodici delle quali già inutili quando arriva la risposta. Il valore
 * mostrato resta immediato — è quello che *scatena la lettura* ad aspettare —
 * quindi la casella non sembra lenta.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
