import {
  type Settings,
  type SettingsPatch,
  TAX_REGIME_LABELS,
  type TaxRegime,
  formatBasisPoints,
} from '@easygest/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { SelectField, TextField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { type ParsedNumber, parsePercent, percentFromBasisPoints } from '@/lib/format';
import { fieldErrors } from '@/lib/resources';
import { settingsQueryOptions, useSettingsMutations } from '@/lib/settings';

/**
 * Il regime fiscale e le tre aliquote da cui le previsioni prendono il conto.
 *
 * Ricalca `AlertsSettingsPage` riga per riga — `formFrom` nello stato iniziale,
 * reclami locali uniti a quelli dell'API, risposta che riscrive il modulo — con
 * una differenza sul perché dell'ultimo punto: là la riga di ritorno serve
 * perché gli anticipi escono normalizzati, qui perché il regime salvato decide
 * cosa la pagina delle previsioni saprà fare, e un modulo che mostra un regime
 * diverso da quello con cui si faranno i conti è una bugia a una riga di
 * distanza.
 *
 * Le aliquote si scrivono in percentuale — `5`, `26,07`, `67` — e si salvano in
 * punti base. La coppia `parsePercent` / `percentFromBasisPoints` è la stessa
 * del modulo della spesa: rifiuta invece di riparare, e non ha bisogno di una
 * terza idea di cosa sia `22,5`.
 */

interface FormState {
  taxRegime: TaxRegime;
  substituteTaxRateBp: string;
  profitabilityCoefficientBp: string;
  inpsRateBp: string;
}

function formFrom(settings: Settings): FormState {
  return {
    taxRegime: settings.taxRegime,
    substituteTaxRateBp: percentFromBasisPoints(settings.substituteTaxRateBp),
    profitabilityCoefficientBp: percentFromBasisPoints(settings.profitabilityCoefficientBp),
    inpsRateBp: percentFromBasisPoints(settings.inpsRateBp),
  };
}

const REGIME_OPTIONS = Object.entries(TAX_REGIME_LABELS).map(([value, label]) => ({
  value,
  label,
}));

type CheckedRate = { ok: true; bp: number } | { ok: false; complaint: string };

/**
 * L'unico controllo che il client fa da sé, e solo perché il server non può.
 *
 * Una casella vuota e una con dentro «sei per cento» arriverebbero all'API
 * nello stesso modo — il campo semplicemente non c'è — e `.partial()` le
 * leggerebbe entrambe come «su questa aliquota non chiedo niente»: salvataggio
 * riuscito, aliquota invariata, nessun errore. È lo stesso motivo per cui
 * `parseEuro` distingue `null` da `'invalido'`.
 *
 * Il resto — l'intervallo 0..100% — resta al server e non si riscrive qui: due
 * formulazioni della stessa regola divergono alla prima modifica di una sola
 * delle due, e `fieldErrors` fa già atterrare il messaggio sotto la casella
 * giusta.
 */
function checkRate(parsed: ParsedNumber): CheckedRate {
  if (parsed === null) return { ok: false, complaint: 'Serve un’aliquota' };
  if (parsed === 'invalido') {
    return { ok: false, complaint: 'Scrivi una percentuale, per esempio 26,07' };
  }
  return { ok: true, bp: parsed };
}

function TaxForm({ settings }: { settings: Settings }) {
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

  const onSubmit = (): void => {
    const checked = {
      profitabilityCoefficientBp: checkRate(parsePercent(form.profitabilityCoefficientBp)),
      inpsRateBp: checkRate(parsePercent(form.inpsRateBp)),
      substituteTaxRateBp: checkRate(parsePercent(form.substituteTaxRateBp)),
    };

    const complaints: Record<string, string> = {};
    for (const [field, result] of Object.entries(checked)) {
      if (!result.ok) complaints[field] = result.complaint;
    }
    setLocal(complaints);
    if (
      !checked.profitabilityCoefficientBp.ok ||
      !checked.inpsRateBp.ok ||
      !checked.substituteTaxRateBp.ok
    ) {
      return;
    }

    const patch: SettingsPatch = {
      taxRegime: form.taxRegime,
      profitabilityCoefficientBp: checked.profitabilityCoefficientBp.bp,
      inpsRateBp: checked.inpsRateBp.bp,
      substituteTaxRateBp: checked.substituteTaxRateBp.bp,
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
      <SelectField
        id="taxRegime"
        label="Regime fiscale"
        value={form.taxRegime}
        onChange={(value) => {
          set('taxRegime')(value as TaxRegime);
        }}
        options={REGIME_OPTIONS}
        error={errors.taxRegime}
        hint="Le previsioni sanno fare il conto solo del forfettario. In ordinario lo dicono, invece di approssimarlo."
      />

      <TextField
        id="profitabilityCoefficientBp"
        label="Coefficiente di redditività"
        value={form.profitabilityCoefficientBp}
        onChange={set('profitabilityCoefficientBp')}
        placeholder="67"
        error={errors.profitabilityCoefficientBp}
        hint="La quota di fatturato che diventa imponibile, decisa dal codice ATECO: 78% per i professionisti, 67% per molte attività di servizi, 40% per il commercio."
      />

      <TextField
        id="inpsRateBp"
        label="Aliquota contributiva INPS"
        value={form.inpsRateBp}
        onChange={set('inpsRateBp')}
        placeholder="26,07"
        error={errors.inpsRateBp}
        hint="Gestione separata, oppure l’aliquota della tua cassa. Si applica all’imponibile, non al fatturato."
      />

      <TextField
        id="substituteTaxRateBp"
        label="Imposta sostitutiva"
        value={form.substituteTaxRateBp}
        onChange={set('substituteTaxRateBp')}
        placeholder="5"
        error={errors.substituteTaxRateBp}
        hint="5% nei primi cinque anni di attività, 15% dopo."
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
 * Cosa comporta il regime, sotto il modulo.
 *
 * Sta qui e non solo nelle previsioni perché è qui che la si legge **prima** di
 * simulare. È il fatto più controintuitivo del programma: nel forfettario una
 * spesa riduce quanto resta in tasca e non muove di un centesimo l'imposta,
 * perché la quota che il coefficiente lascia fuori *è già* la deduzione
 * forfettaria di tutti i costi.
 *
 * La percentuale si scrive da `settings` e non è un 33 battuto a mano: con un
 * coefficiente del 78% la deduzione forfettaria è il 22%, e una frase che
 * dicesse comunque «33%» sarebbe falsa proprio per chi ha appena cambiato il
 * numero qui sopra.
 */
function RegimeNote({ settings }: { settings: Settings }) {
  if (settings.taxRegime === 'ORDINARIO') {
    return (
      <section className="grid max-w-lg gap-2 border-t pt-6 text-sm">
        <h3 className="font-medium">Cosa comporta il regime ordinario</h3>
        <p className="text-muted-foreground">
          I costi si deducono davvero, ma l’imposta si calcola a scaglioni IRPEF con addizionali
          regionali e comunali. Le previsioni questo conto non lo sanno fare, e lo dichiarano invece
          di approssimarlo.
        </p>
      </section>
    );
  }

  return (
    <section className="grid max-w-lg gap-2 border-t pt-6 text-sm">
      <h3 className="font-medium">Cosa comporta il regime forfettario</h3>
      <p className="text-muted-foreground">
        {`L’imponibile è il ${formatBasisPoints(settings.profitabilityCoefficientBp)} del fatturato, e basta: nel forfettario i costi non si deducono. Il ${formatBasisPoints(10_000 - settings.profitabilityCoefficientBp)} che il coefficiente lascia fuori è già la deduzione forfettaria di tutte le spese.`}
      </p>
      <p className="text-muted-foreground">
        Vuol dire che una spesa in più riduce quanto ti resta in tasca, ma non l’imposta né i
        contributi. È controintuitivo, ed è la ragione per cui le previsioni tengono le due cose in
        due righe separate.
      </p>
    </section>
  );
}

export function TaxSettingsPage() {
  const settings = useQuery(settingsQueryOptions());

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium">Fisco</h2>
        <p className="text-muted-foreground text-sm">
          Il regime e le aliquote con cui le previsioni calcolano imposte e contributi.
        </p>
      </div>

      {settings.isPending && <p className="text-muted-foreground text-sm">Caricamento…</p>}
      {settings.isError && (
        <p className="text-sm text-red-600">Non è stato possibile leggere le impostazioni.</p>
      )}
      {settings.data !== undefined && (
        <>
          <TaxForm settings={settings.data} />
          <RegimeNote settings={settings.data} />
        </>
      )}
    </div>
  );
}
