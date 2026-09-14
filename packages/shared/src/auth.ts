import { z } from 'zod';

/**
 * Contratto di autenticazione, condiviso fra API e frontend.
 *
 * Sta qui e non nell'API perché le stesse regole servono due volte: il
 * frontend le usa per validare il form prima di inviarlo, l'API per non
 * fidarsi di quello che riceve. Duplicarle significherebbe, prima o poi,
 * un form che accetta una password che il server rifiuta.
 */

/**
 * Limite reale di bcrypt: **72 byte**, non 72 caratteri.
 *
 * Oltre quella soglia bcrypt tronca in silenzio, e due password diverse che
 * condividono i primi 72 byte diventano equivalenti. Meglio rifiutare in
 * validazione che accettare una password che vale meno di quanto sembra.
 * Il conteggio è in byte perché una lettera accentata ne occupa due: `à`
 * consuma il doppio di `a`.
 */
export const PASSWORD_MAX_BYTES = 72;

/** Sotto questa lunghezza una password non ha abbastanza entropia. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Lunghezza in byte della codifica UTF-8, senza `TextEncoder`.
 *
 * Questo pacchetto è compilato con `"types": []` e la sola libreria `ES2023`,
 * perché deve valere identico su Node e sul browser: `TextEncoder` esiste in
 * entrambi, ma tiparlo qui significherebbe far entrare le definizioni di una
 * piattaforma in codice che di piattaforme non deve saperne nulla.
 *
 * L'iterazione con `for...of` procede per code point e non per unità UTF-16,
 * quindi un'emoji viene contata una volta sola come 4 byte invece di due volte
 * come 3 — che è poi il conteggio che fa bcrypt.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `La password deve avere almeno ${String(PASSWORD_MIN_LENGTH)} caratteri`,
  )
  .refine((value) => utf8ByteLength(value) <= PASSWORD_MAX_BYTES, {
    message: `La password non può superare ${String(PASSWORD_MAX_BYTES)} byte (le lettere accentate ne occupano due)`,
  });

/**
 * L'email è normalizzata qui, non nelle rotte.
 *
 * Chi si registra come `Federico@Gmail.com` deve poter entrare scrivendo
 * `federico@gmail.com`: senza normalizzazione l'unicità nel database sarebbe
 * sensibile alle maiuscole e si creerebbero due account per la stessa persona.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Indirizzo email non valido'))
  .pipe(z.string().max(254));

export const loginSchema = z.object({
  email: emailSchema,
  // In login la password non viene validata per lunghezza: le regole possono
  // cambiare nel tempo, e una password vecchia ma corretta deve continuare a
  // funzionare. A rifiutarla, semmai, è il confronto con l'hash.
  password: z.string().min(1, 'La password è obbligatoria'),
});
export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Il nome mostrato, estratto dalla registrazione perché ora serve due volte.
 *
 * Il `trim` non è cosmetico: senza, uno spazio in coda passerebbe il `min(1)` e
 * l'intestazione mostrerebbe un nome che sembra identico a un altro.
 */
const displayNameSchema = z.string().trim().min(1, 'Il nome è obbligatorio').max(120);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'La password attuale è obbligatoria'),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Cosa si può cambiare del proprio profilo.
 *
 * `strictObject` come in `settingsPatchSchema`, per la stessa ragione: un campo
 * scritto male dev'essere un 400 e non un silenzio che finge di aver salvato.
 *
 * La password attuale è obbligatoria solo per l'email, non per il nome. Il nome
 * non è una credenziale, e chiedere la password per correggere un refuso nel
 * cognome insegna a digitarla senza motivo — che è esattamente l'abitudine su
 * cui conta il phishing.
 *
 * Il `path: ['currentPassword']` della seconda regola non è decorativo: senza,
 * il messaggio uscirebbe con il campo vuoto e il frontend lo mostrerebbe come
 * riga rossa generica in fondo al modulo, invece che sotto la casella che
 * manca.
 */
export const profilePatchSchema = z
  .strictObject({
    displayName: displayNameSchema.optional(),
    email: emailSchema.optional(),
    currentPassword: z.string().min(1, 'La password attuale è obbligatoria').optional(),
  })
  .refine((v) => v.displayName !== undefined || v.email !== undefined, {
    message: 'Non c’è niente da salvare',
  })
  .refine((v) => v.email === undefined || v.currentPassword !== undefined, {
    message: 'Serve la password attuale per cambiare indirizzo',
    path: ['currentPassword'],
  });
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

/** Utente come lo vede il frontend: mai l'hash, mai i campi interni. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Risposta di login e di refresh.
 *
 * Il refresh token non compare: viaggia in un cookie httpOnly, quindi il
 * JavaScript della pagina non deve poterlo leggere nemmeno per sbaglio.
 * `expiresInSeconds` serve al frontend per rinnovare l'access token prima
 * della scadenza invece di aspettare il primo 401.
 */
export interface AuthSession {
  accessToken: string;
  expiresInSeconds: number;
  user: AuthenticatedUser;
}

/** Codici di errore dell'autenticazione, stabili e usabili in uno `switch`. */
export const AUTH_ERROR_CODES = {
  invalidCredentials: 'INVALID_CREDENTIALS',
  accountDisabled: 'ACCOUNT_DISABLED',
  registrationDisabled: 'REGISTRATION_DISABLED',
  emailAlreadyUsed: 'EMAIL_ALREADY_USED',
  missingRefreshToken: 'MISSING_REFRESH_TOKEN',
  invalidRefreshToken: 'INVALID_REFRESH_TOKEN',
  unauthenticated: 'UNAUTHENTICATED',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];
