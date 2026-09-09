import { z } from 'zod';

/**
 * Campi fiscali e di contatto delle anagrafiche.
 *
 * Stanno qui perché servono identici a due parti: il form li usa per dire
 * subito che una partita IVA è sbagliata, l'API per non fidarsi di quello che
 * riceve. Le regole sono italiane dove devono esserlo — una partita IVA di
 * undici cifre ha senso solo per l'Italia — e permissive dove il mondo è più
 * vario di quanto si vorrebbe.
 */

/**
 * Riduce un identificativo alla sua forma canonica.
 *
 * La stessa partita IVA viene scritta `01234567890`, `IT 01234567890` e
 * `01234567890 ` a seconda di dove è stata copiata. Archiviarne tre versioni
 * diverse significa non ritrovarla più con una ricerca.
 */
export function normalizeFiscalId(value: string): string {
  return value.replace(/[\s.\-/]/g, '').toUpperCase();
}

/**
 * Verifica la cifra di controllo di una partita IVA italiana.
 *
 * L'undicesima cifra non è libera: si calcola dalle altre dieci con un
 * algoritmo di Luhn. Serve esattamente a intercettare gli errori che si fanno
 * copiando a mano — una cifra sbagliata o due invertite — e li prende quasi
 * sempre. Non dice che la partita IVA esista davvero né che sia attiva: per
 * quello ci vorrebbe il servizio VIES, che è un'altra cosa e va in rete.
 */
export function hasValidVatChecksum(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;

  let sum = 0;
  for (let position = 0; position < 11; position += 1) {
    const digit = value.charCodeAt(position) - 48;
    if (position % 2 === 0) {
      // Posizioni dispari contando da uno, cifra di controllo compresa.
      sum += digit;
    } else {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return sum % 10 === 0;
}

/**
 * Forma di un codice fiscale di persona fisica.
 *
 * Dove ci si aspetterebbero cifre l'espressione accetta anche
 * `L M N P Q R S T U V`: è l'omocodia. Quando due persone otterrebbero lo
 * stesso codice, l'Agenzia delle Entrate ne sostituisce le cifre con quelle
 * lettere, secondo una tabella fissa. Un'espressione che pretendesse solo
 * numeri rifiuterebbe codici perfettamente validi.
 *
 * L'ottavo carattere è il mese di nascita, codificato con una lettera scelta
 * fra dodici: A gennaio, B febbraio, C marzo, D aprile, E maggio, H giugno,
 * L luglio, M agosto, P settembre, R ottobre, S novembre, T dicembre.
 */
const PERSON_TAX_CODE =
  /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** Un'azienda ha come codice fiscale le stesse undici cifre della partita IVA. */
const COMPANY_TAX_CODE = /^\d{11}$/;

export function isValidTaxCode(value: string): boolean {
  if (COMPANY_TAX_CODE.test(value)) return hasValidVatChecksum(value);
  return PERSON_TAX_CODE.test(value);
}

/**
 * Campo di testo facoltativo.
 *
 * Un form manda `""` per ogni casella che non è stata toccata. Senza questa
 * conversione la stringa vuota finirebbe nel database: il campo risulterebbe
 * compilato ma vuoto, e nessun controllo su «manca la PEC» funzionerebbe più.
 * Diventa `null`, che è come si scrive «non lo so» in una colonna.
 */
export function optionalText<S extends z.ZodType>(schema: S) {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable(),
  );
}

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Il nome è obbligatorio')
  .max(160, 'Il nome non può superare 160 caratteri');

/**
 * Partita IVA, normalizzata ma non ancora verificata nel merito.
 *
 * Il prefisso `IT` viene tolto perché è il formato VIES della stessa partita
 * IVA, non un dato diverso. La cifra di controllo si verifica più in là, a
 * livello di oggetto: dipende dal paese, e qui il paese non si vede ancora.
 */
export const vatNumberSchema = optionalText(
  z
    .string()
    .transform(normalizeFiscalId)
    .transform((value) => (/^IT\d{11}$/.test(value) ? value.slice(2) : value))
    .pipe(
      z
        .string()
        .min(4, 'Partita IVA troppo corta')
        .max(20, 'Partita IVA troppo lunga')
        .regex(/^[A-Z0-9]+$/, 'La partita IVA può contenere solo lettere e cifre'),
    ),
);

export const taxCodeSchema = optionalText(
  z
    .string()
    .transform(normalizeFiscalId)
    .pipe(
      z
        .string()
        .max(20, 'Codice fiscale troppo lungo')
        .regex(/^[A-Z0-9]+$/, 'Il codice fiscale può contenere solo lettere e cifre'),
    ),
);

/**
 * Codice destinatario per la fatturazione elettronica.
 *
 * Sette caratteri per i privati, sei per le pubbliche amministrazioni. Il
 * valore convenzionale `0000000` significa «non ne ha»: la fattura va
 * recapitata via PEC, oppure il destinatario la scaricherà dal cassetto
 * fiscale.
 */
export const sdiCodeSchema = optionalText(
  z
    .string()
    .transform(normalizeFiscalId)
    .pipe(
      z
        .string()
        .regex(
          /^[A-Z0-9]{6,7}$/,
          'Il codice SDI ha 7 caratteri (6 per la pubblica amministrazione)',
        ),
    ),
);

export const emailFieldSchema = optionalText(
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email('Indirizzo email non valido'))
    .pipe(z.string().max(254)),
);

export const phoneSchema = optionalText(
  z
    .string()
    .trim()
    .max(40, 'Numero di telefono troppo lungo')
    .regex(/^[0-9+().\-\s]+$/, 'Il telefono può contenere solo cifre e i segni + - ( ) .'),
);

/**
 * Indirizzo web.
 *
 * Chi compila scrive `aruba.it`, non `https://aruba.it`: lo schema lo aggiunge
 * invece di rifiutare. Il protocollo è poi vincolato a http o https, e non è
 * pedanteria: questi valori diventano `href` di un collegamento nella pagina,
 * e un `javascript:` salvato qui verrebbe eseguito da chiunque ci clicchi.
 */
export const urlSchema = optionalText(
  z
    .string()
    .trim()
    .transform((value) => (/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`))
    .pipe(z.url({ protocol: /^https?$/, normalize: true }))
    .pipe(z.string().max(500, 'Indirizzo troppo lungo')),
);

/** ISO 3166-1 alpha-2. Due lettere, senza pretendere che esistano davvero. */
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Il paese va indicato con due lettere, per esempio IT'))
  .default('IT');

export const provinceSchema = optionalText(
  z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z.string().regex(/^[A-Z]{2}$/, 'La provincia va indicata con due lettere, per esempio MI'),
    ),
);

export const postalCodeSchema = optionalText(
  z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z
        .string()
        .max(16, 'CAP troppo lungo')
        .regex(/^[A-Z0-9][A-Z0-9\s-]*$/, 'CAP non valido'),
    ),
);

export const addressLineSchema = optionalText(z.string().trim().max(200));
export const citySchema = optionalText(z.string().trim().max(120));
export const notesSchema = optionalText(z.string().trim().max(4000, 'Note troppo lunghe'));

/**
 * Controlli che hanno bisogno di vedere più di un campo alla volta.
 *
 * La cifra di controllo di una partita IVA e la forma di un CAP valgono solo
 * in Italia: applicarle a un fornitore irlandese vorrebbe dire rifiutare dati
 * corretti. Per questo non stanno sui singoli campi ma qui, dove il paese si
 * vede.
 */
export function checkItalianFiscalFields(
  value: {
    countryCode?: string | null;
    vatNumber?: string | null;
    taxCode?: string | null;
    postalCode?: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.countryCode !== 'IT') return;

  if (value.vatNumber != null && !hasValidVatChecksum(value.vatNumber)) {
    ctx.addIssue({
      code: 'custom',
      path: ['vatNumber'],
      message: /^\d{11}$/.test(value.vatNumber)
        ? 'Partita IVA non valida: la cifra di controllo non torna'
        : 'Una partita IVA italiana ha 11 cifre',
    });
  }

  if (value.taxCode != null && !isValidTaxCode(value.taxCode)) {
    ctx.addIssue({
      code: 'custom',
      path: ['taxCode'],
      message: 'Codice fiscale non valido: 16 caratteri per una persona, 11 cifre per un’azienda',
    });
  }

  if (value.postalCode != null && !/^\d{5}$/.test(value.postalCode)) {
    ctx.addIssue({
      code: 'custom',
      path: ['postalCode'],
      message: 'Un CAP italiano ha 5 cifre',
    });
  }
}
