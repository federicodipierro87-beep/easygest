/**
 * Aritmetica monetaria su interi.
 *
 * Regola non negoziabile del progetto: nessun importo transita mai come
 * `float`. Gli importi sono interi in centesimi, le aliquote sono interi in
 * basis point (`2200` = 22,00%). Tutti gli arrotondamenti passano da qui, così
 * esiste un unico posto da testare e un unico comportamento da spiegare al
 * commercialista.
 */

/** Importo intero in centesimi della sua valuta. */
export type Cents = number;

/** Percentuale intera in centesimi di punto: 2200 = 22,00%, 6700 = 67,00%. */
export type BasisPoints = number;

export const BP_SCALE = 10_000;

/**
 * Il valore massimo gestibile senza perdere precisione negli interi IEEE-754.
 * Con 1e13 centesimi (100 miliardi di euro) i prodotti intermedi restano
 * abbondantemente sotto Number.MAX_SAFE_INTEGER anche moltiplicando per
 * BP_SCALE, quindi non serve BigInt.
 */
export const MAX_SAFE_CENTS = 1e13;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} deve essere un intero, ricevuto ${String(value)}`);
  }
  if (Math.abs(value) > MAX_SAFE_CENTS) {
    throw new MoneyError(`${label} fuori scala: ${String(value)}`);
  }
}

/**
 * Divisione intera con arrotondamento half-up "away from zero".
 *
 * `Math.round` arrotonda verso +Infinito, quindi su un rimborso di -2,5
 * centesimi restituirebbe -2 invece di -3: una nota di credito e la fattura
 * corrispondente non tornerebbero. Qui il segno è simmetrico.
 */
export function divideRoundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new MoneyError('Divisione per zero');
  }
  const negative = numerator < 0 !== denominator < 0;
  const absNumerator = Math.abs(numerator);
  const absDenominator = Math.abs(denominator);
  const magnitude = Math.floor((2 * absNumerator + absDenominator) / (2 * absDenominator));
  // `magnitude === 0` va restituito come +0: un -0 supererebbe `=== 0` ma
  // fallirebbe `Object.is` e comparirebbe come "-0,00" nei report.
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}

/** Applica un'aliquota in basis point a un importo, arrotondando half-up. */
export function applyBasisPoints(amount: Cents, bp: BasisPoints): Cents {
  assertSafeInteger(amount, 'Importo');
  assertSafeInteger(bp, 'Aliquota in basis point');
  return divideRoundHalfUp(amount * bp, BP_SCALE);
}

/** IVA calcolata su un imponibile. */
export function vatFromNet(netCents: Cents, vatRateBp: BasisPoints): Cents {
  return applyBasisPoints(netCents, vatRateBp);
}

/** Totale documento a partire dall'imponibile. */
export function grossFromNet(netCents: Cents, vatRateBp: BasisPoints): Cents {
  return netCents + vatFromNet(netCents, vatRateBp);
}

/**
 * Scorporo dell'IVA da un totale.
 *
 * Serve spesso: molti fornitori SaaS espongono solo l'importo addebitato sulla
 * carta. Il risultato è garantito coerente, cioè `net + vat === grossCents`
 * anche quando l'arrotondamento non è esatto.
 */
export function splitGross(
  grossCents: Cents,
  vatRateBp: BasisPoints,
): { netCents: Cents; vatCents: Cents } {
  assertSafeInteger(grossCents, 'Totale');
  assertSafeInteger(vatRateBp, 'Aliquota in basis point');
  const netCents = divideRoundHalfUp(grossCents * BP_SCALE, BP_SCALE + vatRateBp);
  return { netCents, vatCents: grossCents - netCents };
}

/** Somma di importi, con verifica che nessun addendo sia sporco. */
export function sumCents(amounts: readonly Cents[]): Cents {
  let total = 0;
  for (const amount of amounts) {
    assertSafeInteger(amount, 'Importo');
    total += amount;
  }
  return total;
}

/**
 * Interpreta un importo scritto a mano.
 *
 * Accetta le forme che una persona digita davvero in un form italiano:
 * `1.234,56`, `1234,56`, `1234.56`, `€ 1 234,56`, `-12`. Restituisce `null`
 * quando la stringa non è un importo, così chi chiama decide se è un errore di
 * validazione o un campo vuoto.
 */
export function parseAmountToCents(raw: string): Cents | null {
  const cleaned = raw
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/[€$£]/g, '')
    .trim();
  if (cleaned === '') return null;

  const match = /^([+-]?)(\d*)(?:([.,])(\d*))?$/.exec(normalizeSeparators(cleaned));
  if (!match) return null;

  const [, sign, integerPart = '', , decimalPart] = match;
  if (integerPart === '' && (decimalPart === undefined || decimalPart === '')) return null;
  if (decimalPart !== undefined && decimalPart.length > 2) return null;

  const units = integerPart === '' ? 0 : Number(integerPart);
  const fraction = decimalPart === undefined ? 0 : Number(decimalPart.padEnd(2, '0'));
  const magnitude = units * 100 + fraction;
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Riduce una stringa numerica a un solo separatore decimale.
 *
 * L'ambiguità vera è `1.234`: in Italia sono milleduecentotrentaquattro, in
 * inglese sono uno virgola due tre quattro. La disambiguazione usa la regola
 * che un separatore di migliaia raggruppa sempre esattamente tre cifre.
 */
function normalizeSeparators(input: string): string {
  const lastComma = input.lastIndexOf(',');
  const lastDot = input.lastIndexOf('.');

  if (lastComma === -1 && lastDot === -1) return input;

  if (lastComma !== -1 && lastDot !== -1) {
    // Entrambi presenti: l'ultimo che compare è il separatore decimale.
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    const [head = '', ...rest] = input.split(decimalSeparator);
    if (rest.length > 1) return input; // due separatori decimali: non è un numero
    const units = stripThousands(head, thousandsSeparator);
    return units === null ? input : `${units}${decimalSeparator}${rest[0] ?? ''}`;
  }

  const separator = lastComma !== -1 ? ',' : '.';
  const groups = input.split(separator);

  if (groups.length > 2) {
    // Più separatori dello stesso tipo: o sono migliaia ben formate, o è
    // spazzatura e la lasciamo fallire nella validazione successiva.
    return stripThousands(input, separator) ?? input;
  }

  // Un solo separatore è ambiguo. Il punto seguito da esattamente tre cifre lo
  // trattiamo come migliaia perché "1.234" in Italia è milleduecentotrentaquattro;
  // la virgola resta sempre decimale.
  const head = groups[0] ?? '';
  const tail = groups[1] ?? '';
  if (separator === '.' && /^\d{3}$/.test(tail) && /^[+-]?\d{1,3}$/.test(head)) {
    return head + tail;
  }
  return input;
}

/**
 * Rimuove i separatori di migliaia solo se raggruppano davvero tre cifre.
 * Restituisce `null` se il raggruppamento non è valido, per non trasformare
 * `1,2,3` in `123`.
 */
function stripThousands(input: string, separator: string): string | null {
  const groups = input.split(separator);
  if (groups.length === 1) return input;
  if (!/^[+-]?\d{1,3}$/.test(groups[0] ?? '')) return null;
  for (const group of groups.slice(1)) {
    if (!/^\d{3}$/.test(group)) return null;
  }
  return groups.join('');
}

/** Rappresentazione decimale non localizzata, adatta a CSV e log. */
export function centsToDecimalString(cents: Cents): string {
  assertSafeInteger(cents, 'Importo');
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const units = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  return `${negative ? '-' : ''}${String(units)}.${String(fraction).padStart(2, '0')}`;
}

/** Formattazione per l'interfaccia, con simbolo di valuta e separatori locali. */
export function formatCents(
  cents: Cents,
  options: { currency?: string; locale?: string; showSymbol?: boolean } = {},
): string {
  const { currency = 'EUR', locale = 'it-IT', showSymbol = true } = options;
  assertSafeInteger(cents, 'Importo');
  return new Intl.NumberFormat(locale, {
    style: showSymbol ? 'currency' : 'decimal',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    // CLDR per l'italiano raggruppa solo da cinque cifre, quindi mille‑duecento
    // uscirebbe come "1234,56". In un gestionale di spese la leggibilità della
    // cifra conta più dell'aderenza alla regola tipografica: raggruppiamo sempre.
    useGrouping: true,
  }).format(cents / 100);
}

/** Formattazione di un'aliquota: 2200 -> "22%", 2650 -> "26,5%". */
export function formatBasisPoints(bp: BasisPoints, locale = 'it-IT'): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(bp / BP_SCALE);
}
