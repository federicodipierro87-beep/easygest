import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from '@/App';
import { restoreSession } from '@/lib/session';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // I dati di un gestionale personale cambiano solo quando li cambi tu:
      // un minuto di staleness evita refetch continui senza mai mostrare
      // numeri davvero vecchi.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Elemento #root assente in index.html');
}

/**
 * La sessione si ricostruisce dal cookie httpOnly, e il cookie il JavaScript
 * non può leggerlo: bisogna chiedere all'API. La richiesta parte qui, prima
 * del primo rendering, perché è il momento più presto possibile — attendere un
 * effetto di React vorrebbe dire aspettare che l'albero sia montato per
 * cominciare. Nessun `await`: l'app parte nello stato `loading` e si aggiorna
 * da sé quando la risposta arriva.
 */
void restoreSession();

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
