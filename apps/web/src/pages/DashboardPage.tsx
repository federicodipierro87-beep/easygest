import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/use-session';
import { ApiError, apiFetch } from '@/lib/api';
import { env } from '@/lib/env';
import { logout } from '@/lib/session';

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
 * Dashboard provvisoria della Fase 1.
 *
 * Non è decorativa: mostra che la sessione regge una ricarica della pagina e
 * che la catena frontend → proxy → API funziona. La vera dashboard, con spese
 * e scadenze, arriva nella Fase 5.
 */
export function DashboardPage() {
  const session = useSession();
  const [leaving, setLeaving] = useState(false);

  const health = useQuery({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/health'),
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">EasyGest</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Ciao {session.user?.displayName ?? ''}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={leaving}
          onClick={() => {
            setLeaving(true);
            // `logout` azzera comunque la sessione locale, anche se la chiamata
            // fallisce: da lì `RequireAuth` rimanda al login da solo.
            void logout().finally(() => {
              setLeaving(false);
            });
          }}
        >
          {leaving ? 'Uscita…' : 'Esci'}
        </Button>
      </header>

      <section className="rounded-xl border p-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-muted-foreground text-sm font-medium">Stato del backend</h2>
          <code className="text-muted-foreground truncate text-xs">{env.apiUrl}</code>
        </div>

        <div className="mt-4">
          {health.isPending && <p className="text-muted-foreground text-sm">Verifica in corso…</p>}

          {health.isError && (
            <div className="flex items-start gap-3">
              <span aria-hidden className="mt-1.5 size-2.5 shrink-0 rounded-full bg-red-500" />
              <div>
                <p className="font-medium text-red-600">Non raggiungibile</p>
                <p className="text-muted-foreground mt-1 text-sm">
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
                <p className="font-medium text-emerald-600">Operativo</p>
                <p className="text-muted-foreground mt-1 text-sm">
                  Attivo da {formatUptime(health.data.uptimeSeconds)}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <p className="text-muted-foreground text-xs">
        Fase 1 — autenticazione. Anagrafiche e spese ricorrenti arrivano nella Fase 2.
      </p>
    </main>
  );
}
