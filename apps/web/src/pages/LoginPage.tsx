import { AUTH_ERROR_CODES, loginSchema } from '@easygest/shared';
import { useId, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { Booting } from '@/components/Booting';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSession } from '@/hooks/use-session';
import { ApiError } from '@/lib/api';
import { login } from '@/lib/session';

type FieldName = 'email' | 'password';

/**
 * Traduce un errore dell'API in una frase per l'utente.
 *
 * Si passa per il `code` e non per il messaggio: il testo del server può
 * cambiare senza preavviso, il codice è un contratto. `INVALID_CREDENTIALS`
 * resta volutamente vago su *quale* dei due sia sbagliato — dire «questa email
 * non esiste» permetterebbe a chiunque di scoprire chi ha un account qui.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Errore imprevisto durante l’accesso.';
  }

  switch (error.code) {
    case AUTH_ERROR_CODES.invalidCredentials:
      return 'Email o password non corretti.';
    case AUTH_ERROR_CODES.accountDisabled:
      return 'Questo account è disattivato.';
    case 'RATE_LIMITED':
    case 'NETWORK_ERROR':
      // Questi due messaggi sono già scritti per essere letti: il primo
      // contiene quanto aspettare, il secondo dove guardare.
      return error.message;
    default:
      return 'Accesso non riuscito. Riprova fra poco.';
  }
}

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  /**
   * Dove andare dopo l'accesso.
   *
   * `RequireAuth` ci ha passato la pagina che l'utente stava cercando di
   * aprire. Viene accettata solo se comincia con una singola barra: un valore
   * come `//altrove.example` sarebbe letto dal browser come un altro host, e
   * il login diventerebbe un trampolino per portare altrove chi si fida del
   * nostro dominio.
   */
  const requested: unknown = (location.state as { from?: unknown } | null)?.from;
  const destination =
    typeof requested === 'string' && /^\/(?!\/)/.test(requested) ? requested : '/';

  // Finché non sappiamo se una sessione c'è, non si mostra niente: chi è già
  // dentro e ricarica `/login` vedrebbe altrimenti il modulo comparire e
  // sparire da solo.
  if (session.status === 'loading') return <Booting />;

  // Chi ha già una sessione non ha niente da fare qui: capita arrivando al
  // login dalla cronologia, o aprendo un secondo pannello.
  if (session.status === 'authenticated') {
    return <Navigate to={destination} replace />;
  }

  async function submit() {
    setFailure(null);

    // Lo stesso schema che valida lato server, importato da `packages/shared`:
    // due copie delle stesse regole finirebbero per divergere, e a divergere
    // sarebbe sempre quella che nessuno guarda.
    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const next: Partial<Record<FieldName, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'email' || field === 'password') next[field] ??= issue.message;
      }
      setFieldErrors(next);
      return;
    }

    setFieldErrors({});
    setPending(true);
    try {
      await login(parsed.data);
      await navigate(destination, { replace: true });
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">EasyGest</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Accedi per gestire spese ricorrenti e documenti
          </p>
        </header>

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              type="email"
              name="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              // Il gestore di password compila e salva le credenziali solo se
              // riconosce i campi: senza questi attributi l'accesso va
              // riscritto a mano ogni volta.
              autoComplete="username"
              autoFocus
              required
              disabled={pending}
              aria-invalid={fieldErrors.email !== undefined}
              aria-describedby={fieldErrors.email === undefined ? undefined : `${emailId}-error`}
            />
            {fieldErrors.email !== undefined && (
              <p id={`${emailId}-error`} className="text-destructive text-sm">
                {fieldErrors.email}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={passwordId}>Password</Label>
            <Input
              id={passwordId}
              type="password"
              name="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              autoComplete="current-password"
              required
              disabled={pending}
              aria-invalid={fieldErrors.password !== undefined}
              aria-describedby={
                fieldErrors.password === undefined ? undefined : `${passwordId}-error`
              }
            />
            {fieldErrors.password !== undefined && (
              <p id={`${passwordId}-error`} className="text-destructive text-sm">
                {fieldErrors.password}
              </p>
            )}
          </div>

          {/*
            La regione esiste sempre, anche vuota: un elemento con `role="alert"`
            aggiunto solo al momento dell'errore a volte non viene annunciato
            dai lettori di schermo, perché non era lì da osservare.
          */}
          <p
            id={errorId}
            role="alert"
            className="text-destructive min-h-5 text-sm empty:min-h-0"
            aria-live="polite"
          >
            {failure}
          </p>

          <Button type="submit" size="lg" disabled={pending} aria-describedby={errorId}>
            {pending ? 'Accesso in corso…' : 'Accedi'}
          </Button>
        </form>
      </div>
    </main>
  );
}
