/**
 * Schermata di attesa iniziale.
 *
 * Appare finché non sappiamo se esiste una sessione: la risposta sta in un
 * cookie httpOnly, e va chiesta all'API. Dura quanto una chiamata, quindi
 * riempirla di scheletri la renderebbe più fastidiosa del nulla che
 * sostituisce.
 */
export function Booting() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <p className="text-muted-foreground text-sm" role="status">
        Caricamento…
      </p>
    </div>
  );
}
