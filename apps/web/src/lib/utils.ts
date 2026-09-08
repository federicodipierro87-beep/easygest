import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Unisce classi Tailwind facendo vincere l'ultima.
 *
 * Serve perché in CSS conta l'ordine nel foglio di stile, non quello
 * nell'attributo `class`: scrivere `class="p-2 p-4"` non garantisce `p-4`, e un
 * componente che accetta una prop `className` per essere personalizzato non
 * potrebbe mantenere la promessa. `twMerge` scarta le classi che appartengono
 * allo stesso gruppo tenendo solo l'ultima, `clsx` normalizza prima le forme
 * condizionali (array, oggetti, valori falsi).
 *
 * La CLI di shadcn genera qui un riesporto dal pacchetto `cn`, che comprime i
 * due in uno solo. Fa la stessa cosa, ma è appena nato: per una funzione
 * chiamata da ogni componente si preferiscono due librerie note e queste
 * quattro righe leggibili.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
