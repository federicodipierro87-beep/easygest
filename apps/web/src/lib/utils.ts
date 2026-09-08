/**
 * Unisce classi Tailwind facendo vincere l'ultima.
 *
 * Serve perché in CSS conta l'ordine nel foglio di stile, non quello
 * nell'attributo `class`: scrivere `class="p-2 p-4"` non garantisce `p-4`, e un
 * componente che accetta una prop `className` per essere personalizzato non
 * potrebbe mantenere la promessa.
 *
 * Il pacchetto `cn` è la versione compilata della vecchia coppia
 * `clsx` + `tailwind-merge`, ed è quello che la CLI di shadcn importa nei
 * componenti che genera. Riscrivere quegli import a ogni `shadcn add` sarebbe
 * una tassa ricorrente in cambio di niente: è pubblicato dallo stesso autore
 * dei componenti.
 */
export { cn } from 'cn';
