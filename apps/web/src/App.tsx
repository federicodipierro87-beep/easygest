import { useQuery } from '@tanstack/react-query';

import { ApiError, apiFetch } from '@/lib/api';
import { env } from '@/lib/env';

interface HealthResponse {
  status: string;
  uptimeSeconds: number;
  timestamp: string;
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${String(rest)}s`;
  return `${String(rest)}s`;
}

/**
 * Pagina di verifica della Fase 0.
 *
 * Non è un placeholder decorativo: esercita l'intera catena frontend → CORS →
 * API, che è esattamente ciò che si rompe per primo al deploy su Netlify e
 * Railway. Verrà sostituita dalla dashboard nella Fase 5.
 */
export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/health'),
    refetchInterval: 10_000,
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">EasyGest</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Spese ricorrenti, abbonamenti e documenti fiscali
        </p>
      </header>

      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-medium text-neutral-500">Stato del backend</h2>
          <code className="truncate text-xs text-neutral-400">{env.apiUrl}</code>
        </div>

        <div className="mt-4">
          {health.isPending && <p className="text-sm text-neutral-500">Verifica in corso…</p>}

          {health.isError && (
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full bg-red-500" />
              <div>
                <p className="font-medium text-red-600 dark:text-red-400">Non raggiungibile</p>
                <p className="mt-1 text-sm text-neutral-500">
                  {health.error instanceof ApiError
                    ? health.error.message
                    : 'Errore imprevisto durante la chiamata.'}
                </p>
              </div>
            </div>
          )}

          {health.isSuccess && (
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full bg-emerald-500" />
              <div>
                <p className="font-medium text-emerald-600 dark:text-emerald-400">Operativo</p>
                <p className="mt-1 text-sm text-neutral-500">
                  Attivo da {formatUptime(health.data.uptimeSeconds)}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <p className="text-xs text-neutral-400">
        Fase 0 — scaffolding. Autenticazione e anagrafiche arrivano nella Fase 1.
      </p>
    </main>
  );
}
