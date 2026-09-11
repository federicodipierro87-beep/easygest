import {
  DIGEST_DAY_LABELS,
  JOB_COUNTER_LABELS,
  type JobCounters,
  type Settings,
  type SettingsPatch,
  TIMEZONE_CHOICES,
  formatDaysBefore,
  parseDaysBefore,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { CheckboxField, SelectField, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { fieldErrors } from '@/lib/resources';
import { settingsQueryOptions, useJobRun, useSettingsMutations } from '@/lib/settings';

/**
 * Gli avvisi: quando arrivano e in che fuso si conta il giorno.
 *
 * Gli anticipi si scrivono in una casella di testo, con i giorni separati da
 * virgola. Un editor a chip sarebbe più bello ed è molto componente per un
 * campo che si tocca due volte l'anno; `formatDaysBefore` e `parseDaysBefore`
 * si buttano senza toccare l'API il giorno in cui lo si scrive davvero.
 *
 * Il riquadro in fondo esiste per il primo deploy: sapere se i promemoria
 * partono davvero, senza aspettare le sette del mattino dopo.
 */

interface FormState {
  reminderDaysBefore: string;
  cancellationReminderDaysBefore: string;
  digestEnabled: boolean;
  digestDayOfWeek: string;
  timezone: string;
}

function formFrom(settings: Settings): FormState {
  return {
    reminderDaysBefore: formatDaysBefore(settings.reminderDaysBefore),
    cancellationReminderDaysBefore: formatDaysBefore(settings.cancellationReminderDaysBefore),
    digestEnabled: settings.digestEnabled,
    digestDayOfWeek: String(settings.digestDayOfWeek),
    timezone: settings.timezone,
  };
}

const DIGEST_DAY_OPTIONS = Object.entries(DIGEST_DAY_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/**
 * La tendina dei fusi, più quello salvato se non è in elenco.
 *
 * Seicento fusi in una tendina, per un utente che ne ha uno solo corretto, sono
 * più difficili da usare di nove. Ma chi ha un fuso fuori lista — arrivato dal
 * seed o dall'API — non deve vederselo sostituire dal primo della tendina
 * semplicemente aprendo la pagina.
 */
function timezoneOptions(current: string): { value: string; label: string }[] {
  const choices = TIMEZONE_CHOICES.includes(current)
    ? TIMEZONE_CHOICES
    : [...TIMEZONE_CHOICES, current];
  return choices.map((zone) => ({ value: zone, label: zone }));
}

function AlertsForm({ settings }: { settings: Settings }) {
  const [form, setForm] = useState<FormState>(() => formFrom(settings));
  const [local, setLocal] = useState<Record<string, string>>({});
  const { update } = useSettingsMutations();

  const errors = { ...fieldErrors(update.error), ...local };
  const generalError =
    update.error instanceof ApiError && Object.keys(fieldErrors(update.error)).length === 0
      ? update.error.message
      : null;

  const set =
    <K extends keyof FormState>(key: K) =>
    (value: FormState[K]) => {
      setForm((previous) => ({ ...previous, [key]: value }));
    };

  /**
   * La risposta riscrive il modulo, e non è un dettaglio.
   *
   * Gli anticipi escono normalizzati: chi scrive `7, 30, 7` deve rileggere
   * `30, 7`. Senza questa riga il campo continuerebbe a mostrare ciò che è
   * stato digitato invece di ciò che è stato salvato, e la regola resterebbe
   * invisibile.
   */
  const onSubmit = (): void => {
    const reminders = parseDaysBefore(form.reminderDaysBefore);
    const cancellations = parseDaysBefore(form.cancellationReminderDaysBefore);
    const complaints: Record<string, string> = {};
    if (reminders === null) complaints.reminderDaysBefore = 'Servono numeri separati da virgola';
    if (cancellations === null) {
      complaints.cancellationReminderDaysBefore = 'Servono numeri separati da virgola';
    }
    setLocal(complaints);
    if (reminders === null || cancellations === null) return;

    const patch: SettingsPatch = {
      reminderDaysBefore: reminders,
      cancellationReminderDaysBefore: cancellations,
      digestEnabled: form.digestEnabled,
      digestDayOfWeek: Number(form.digestDayOfWeek),
      timezone: form.timezone,
    };
    update.mutate(patch, {
      onSuccess: (saved) => {
        setForm(formFrom(saved));
      },
    });
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
        id="reminderDaysBefore"
        label="Promemoria delle scadenze"
        value={form.reminderDaysBefore}
        onChange={set('reminderDaysBefore')}
        placeholder="30, 7, 1"
        error={errors.reminderDaysBefore}
        hint="Giorni di anticipo, separati da virgola. Arriva un avviso solo, quello con l’anticipo più vicino a quanto manca davvero. Lascia vuoto per spegnerli."
      />

      <TextField
        id="cancellationReminderDaysBefore"
        label="Promemoria delle disdette"
        value={form.cancellationReminderDaysBefore}
        onChange={set('cancellationReminderDaysBefore')}
        placeholder="60, 30, 15"
        error={errors.cancellationReminderDaysBefore}
        hint="Contati dall’ultimo giorno utile per disdire, non dalla scadenza."
      />

      <CheckboxField
        id="digestEnabled"
        label="Manda il riepilogo settimanale"
        checked={form.digestEnabled}
        onChange={set('digestEnabled')}
        hint="Scadenze in arrivo, disdette da decidere, importi da confermare e arretrati."
      />

      <SelectField
        id="digestDayOfWeek"
        label="Giorno del riepilogo"
        value={form.digestDayOfWeek}
        onChange={set('digestDayOfWeek')}
        options={DIGEST_DAY_OPTIONS}
        error={errors.digestDayOfWeek}
        disabled={!form.digestEnabled}
      />

      <SelectField
        id="timezone"
        label="Fuso orario"
        value={form.timezone}
        onChange={set('timezone')}
        options={timezoneOptions(settings.timezone)}
        error={errors.timezone}
        hint="Decide qual è «oggi» quando si contano i giorni che mancano."
      />

      {generalError !== null && <p className="text-sm text-red-600">{generalError}</p>}

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

/**
 * «Esegui adesso».
 *
 * Il giro è idempotente per costruzione, quindi premerlo due volte non manda
 * niente due volte: è la stessa proprietà su cui poggiano il recupero all'avvio
 * e il fatto di non tenere un registro delle esecuzioni. I contatori sono la
 * risposta: un `emailsSent` a zero dove ce se ne aspettava uno è
 * un'informazione, un «fatto» no.
 */
function ManualRun() {
  const run = useJobRun();

  return (
    <section className="grid max-w-lg gap-3 border-t pt-6">
      <div>
        <h2 className="font-medium">Controlli automatici</h2>
        <p className="text-muted-foreground text-sm">
          Ogni mattina alle 07:00 l’applicazione genera le scadenze, marca pagate quelle con rinnovo
          automatico e manda gli avvisi. Puoi farlo partire adesso: rifarlo non rimanda niente di
          già mandato.
        </p>
      </div>

      <div>
        <Button
          type="button"
          variant="outline"
          disabled={run.isPending}
          onClick={() => {
            run.mutate('daily');
          }}
        >
          {run.isPending ? 'In corso…' : 'Esegui adesso'}
        </Button>
      </div>

      {run.isError && (
        <p className="text-sm text-red-600">
          {run.error instanceof ApiError ? run.error.message : 'Il controllo non è partito.'}
        </p>
      )}

      {run.isSuccess && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          {(Object.keys(JOB_COUNTER_LABELS) as (keyof JobCounters)[]).map((key) => (
            <div key={key} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{JOB_COUNTER_LABELS[key]}</dt>
              <dd className="tabular-nums">{run.data.counters[key]}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function AlertsSettingsPage() {
  const settings = useQuery(settingsQueryOptions());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Avvisi</h2>
        <p className="text-muted-foreground text-sm">
          Quando avvisarti delle scadenze e delle disdette, per email e nella campanella.
        </p>
      </div>

      {settings.isPending && <p className="text-muted-foreground text-sm">Caricamento…</p>}
      {settings.isError && (
        <p className="text-sm text-red-600">Non è stato possibile leggere le impostazioni.</p>
      )}
      {settings.data !== undefined && <AlertsForm settings={settings.data} />}

      <ManualRun />
    </div>
  );
}
