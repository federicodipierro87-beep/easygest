import type { ArchivedFilter } from '@easygest/shared';
import { Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * I comandi in cima e in fondo a un elenco.
 *
 * Ricerca, filtri e impaginazione non sanno cosa stanno filtrando: dipendono
 * dalla forma della risposta dell'API e non dai campi della riga.
 *
 * La frase sopra era vera a metà finché la barra teneva dentro il filtro degli
 * archiviati, che è un campo — `isActive` — e che le spese non hanno: quelle
 * cambiano stato, e i quattro stati non si riducono a un booleano. Ora i filtri
 * entrano come figli, e la barra torna a sapere soltanto che ce ne sono.
 */

interface ToolbarProps {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  onCreate: () => void;
  createLabel: string;
  /** I filtri propri di questo elenco, fra la ricerca e il pulsante. */
  children?: ReactNode;
}

export function ResourceToolbar({
  query,
  onQueryChange,
  placeholder,
  onCreate,
  createLabel,
  children,
}: ToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-56 flex-1">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
          }}
          placeholder={placeholder}
          aria-label="Cerca"
          className="pl-9"
        />
      </div>

      {children}

      <Button onClick={onCreate}>
        <Plus aria-hidden className="size-4" />
        {createLabel}
      </Button>
    </div>
  );
}

interface ArchivedSelectProps {
  value: ArchivedFilter;
  onChange: (value: ArchivedFilter) => void;
}

/**
 * Il filtro degli archiviati, per le quattro anagrafiche che ce l'hanno.
 *
 * Tre valori e non una casella da spuntare: la vista normale li nasconde, un
 * «tutti» li aggiunge, e serve anche poterli vedere da soli per ripescarne uno.
 */
export function ArchivedSelect({ value, onChange }: ArchivedSelectProps) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        onChange(next as ArchivedFilter);
      }}
    >
      <SelectTrigger className="w-40" aria-label="Filtro archiviati">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="exclude">Attivi</SelectItem>
        <SelectItem value="include">Tutti</SelectItem>
        <SelectItem value="only">Archiviati</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function ResourcePagination({ page, totalPages, total, onPageChange }: PaginationProps) {
  // Con una pagina sola i comandi direbbero soltanto «1 di 1»: il totale
  // invece serve sempre, ed è già scritto sopra la tabella.
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <p className="text-muted-foreground">
        Pagina {page} di {totalPages} — {total} in tutto
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          Precedente
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          Successiva
        </Button>
      </div>
    </div>
  );
}
