/**
 * Configurazione del frontend.
 *
 * Vite inietta queste variabili al momento della build, non a runtime: un
 * valore sbagliato su Netlify si scopre solo aprendo l'app. Per questo il
 * modulo fallisce subito e in modo esplicito invece di lasciare che le
 * chiamate finiscano su `undefined/api/...`.
 */
function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Variabile d'ambiente ${name} mancante. In locale copia apps/web/.env.example ` +
        `in apps/web/.env; su Netlify impostala tra le environment variables del sito.`,
    );
  }
  return value.trim();
}

export const env = {
  /** URL base dell'API, senza slash finale. */
  apiUrl: required('VITE_API_URL', import.meta.env.VITE_API_URL).replace(/\/+$/, ''),
} as const;
