import { AUTH_ERROR_CODES, type AuthenticatedUser } from '@easygest/shared';
import { useState } from 'react';

import { TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { useSession } from '@/hooks/use-session';
import { ApiError } from '@/lib/api';
import { useProfileMutations } from '@/lib/profile';
import { fieldErrors } from '@/lib/resources';

/**
 * Il proprio profilo: nome, indirizzo, password.
 *
 * Due `<form>` separati e non uno solo, perché sono due richieste a due rotte
 * diverse, con due esiti e due errori: un pulsante unico dovrebbe decidere cosa
 * fare quando la prima riesce e la seconda no, e qualunque cosa decidesse
 * sarebbe una bugia in uno dei due casi.
 *
 * Le caselle di conferma e la password compaiono solo quando l'indirizzo
 * cambia davvero. La comparsa progressiva è il punto dell'intera pagina: chi
 * sta correggendo il proprio nome non deve vedersi chiedere la password.
 */

/**
 * Gli errori che hanno un codice invece di un campo.
 *
 * Senza questa mappa un indirizzo già preso comparirebbe come riga rossa
 * generica in fondo al modulo, invece che sotto la casella da riscrivere.
 */
function errorByCode(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  if (error.code === AUTH_ERROR_CODES.invalidCredentials) {
    return { currentPassword: error.message };
  }
  if (error.code === AUTH_ERROR_CODES.emailAlreadyUsed) {
    return { email: error.message };
  }
  return {};
}

/** La riga rossa in fondo resta per ciò che non si sa attribuire a un campo. */
function generalError(error: unknown, attributed: Record<string, string>): string | null {
  if (!(error instanceof ApiError) || Object.keys(attributed).length > 0) return null;
  return error.message;
}

function IdentityForm({ user }: { user: AuthenticatedUser }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email);
  const [emailConfirm, setEmailConfirm] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const { update } = useProfileMutations();

  const changingEmail = email.trim().toLowerCase() !== user.email;

  const fromApi = { ...fieldErrors(update.error), ...errorByCode(update.error) };
  const errors = { ...fromApi, ...local };
  const general = generalError(update.error, fromApi);

  const onSubmit = (): void => {
    // Il confronto fra le due caselle è un controllo del browser, come le
    // complaint locali degli avvisi: è una regola dell'interfaccia, e un
    // secondo schema nel pacchetto condiviso sarebbe peso morto nel bundle
    // dell'API e una seconda verità sul formato del patch.
    const complaints: Record<string, string> = {};
    if (changingEmail && emailConfirm.trim().toLowerCase() !== email.trim().toLowerCase()) {
      complaints.emailConfirm = 'I due indirizzi non coincidono';
    }
    setLocal(complaints);
    if (Object.keys(complaints).length > 0) return;

    update.mutate(
      {
        displayName,
        ...(changingEmail ? { email, currentPassword } : {}),
      },
      {
        // La risposta riscrive il modulo: l'email esce normalizzata, quindi chi
        // ha digitato `Mario@Gmail.com` deve rileggere `mario@gmail.com`.
        onSuccess: (saved) => {
          setDisplayName(saved.displayName);
          setEmail(saved.email);
          setEmailConfirm('');
          setCurrentPassword('');
        },
      },
    );
  };

  return (
    <form
      className="grid max-w-lg gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <TextField
        id="displayName"
        label="Nome"
        value={displayName}
        onChange={setDisplayName}
        autoComplete="name"
        error={errors.displayName}
        hint="Compare nell’intestazione e in fondo alle email che ricevi."
      />

      <TextField
        id="email"
        label="Indirizzo email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        error={errors.email}
        hint="È l’indirizzo con cui accedi e quello a cui arrivano gli avvisi."
      />

      {changingEmail && (
        <>
          <TextField
            id="emailConfirm"
            label="Ripeti il nuovo indirizzo"
            type="email"
            value={emailConfirm}
            onChange={setEmailConfirm}
            autoComplete="off"
            error={errors.emailConfirm}
            hint="Non viene mandata nessuna email di conferma: un refuso qui si corregge solo rientrando con l’indirizzo sbagliato."
          />

          <TextField
            id="currentPassword"
            label="Password attuale"
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            error={errors.currentPassword}
            hint="Serve solo per cambiare indirizzo, non per cambiare nome."
          />
        </>
      )}

      {general !== null && <p className="text-sm text-red-600">{general}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Salvataggio…' : 'Salva'}
        </Button>
        {update.isSuccess && Object.keys(local).length === 0 && (
          <span className="text-muted-foreground text-sm">Salvato.</span>
        )}
      </div>
    </form>
  );
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const { changePassword } = useProfileMutations();

  const fromApi = {
    ...fieldErrors(changePassword.error),
    ...errorByCode(changePassword.error),
  };
  const errors = { ...fromApi, ...local };
  const general = generalError(changePassword.error, fromApi);

  const onSubmit = (): void => {
    const complaints: Record<string, string> = {};
    if (newPasswordConfirm !== newPassword) {
      complaints.newPasswordConfirm = 'Le due password non coincidono';
    }
    setLocal(complaints);
    if (Object.keys(complaints).length > 0) return;

    changePassword.mutate(
      { currentPassword, newPassword },
      {
        onSuccess: () => {
          setCurrentPassword('');
          setNewPassword('');
          setNewPasswordConfirm('');
        },
      },
    );
  };

  return (
    <form
      className="grid max-w-lg gap-4 border-t pt-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div>
        <h2 className="font-medium">Password</h2>
        <p className="text-muted-foreground text-sm">
          Cambiandola vengono chiuse tutte le altre sessioni: se l’hai cambiata perché temevi che
          qualcun altro fosse entrato, da quel momento non lo è più.
        </p>
      </div>

      <TextField
        id="passwordAttuale"
        label="Password attuale"
        type="password"
        value={currentPassword}
        onChange={setCurrentPassword}
        autoComplete="current-password"
        error={errors.currentPassword}
      />

      <TextField
        id="newPassword"
        label="Nuova password"
        type="password"
        value={newPassword}
        onChange={setNewPassword}
        autoComplete="new-password"
        error={errors.newPassword}
      />

      <TextField
        id="newPasswordConfirm"
        label="Ripeti la nuova password"
        type="password"
        value={newPasswordConfirm}
        onChange={setNewPasswordConfirm}
        autoComplete="new-password"
        error={errors.newPasswordConfirm}
      />

      {general !== null && <p className="text-sm text-red-600">{general}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={changePassword.isPending}>
          {changePassword.isPending ? 'Salvataggio…' : 'Cambia password'}
        </Button>
        {changePassword.isSuccess && Object.keys(local).length === 0 && (
          <span className="text-muted-foreground text-sm">
            Password aggiornata. Le altre sessioni sono state chiuse.
          </span>
        )}
      </div>
    </form>
  );
}

export function ProfileSettingsPage() {
  const session = useSession();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Profilo</h2>
        <p className="text-muted-foreground text-sm">
          Il nome che compare nell’intestazione, l’indirizzo con cui accedi e la password.
        </p>
      </div>

      {/* L'utente arriva dallo store di sessione, non da una query: dentro
          `RequireAuth` c'è sempre, ma il tipo resta nullabile perché lo stesso
          store serve anche la pagina di login. */}
      {session.user !== null && <IdentityForm user={session.user} />}

      <PasswordForm />
    </div>
  );
}
