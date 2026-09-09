import { CATEGORY_ICONS, type CategoryIcon } from '@easygest/shared';
import {
  Briefcase,
  Car,
  Cloud,
  Cpu,
  FileText,
  Globe,
  GraduationCap,
  HardDrive,
  KeyRound,
  Landmark,
  type LucideIcon,
  Mail,
  Receipt,
  Repeat,
  Server,
  ShieldCheck,
  Smartphone,
  Tag,
  Users,
  Wifi,
  Wrench,
} from 'lucide-react';

/**
 * Dal nome dell'icona al componente che la disegna.
 *
 * La corrispondenza è scritta a mano, un import per riga, e non risolta a
 * runtime da una stringa. `import * as icons from 'lucide-react'` funzionerebbe
 * ed è il modo in cui di solito si fa, ma porterebbe nel bundle tutte e
 * milleseicento le icone della libreria: il peso della pagina è già l'unico
 * debito aperto sul frontend, e questo lo raddoppierebbe per far scegliere fra
 * venti.
 *
 * Il tipo dell'indice è `CategoryIcon`, cioè l'elenco chiuso dello schema
 * condiviso: aggiungere un nome là senza aggiungerlo qui non compila, invece di
 * produrre una categoria con un buco al posto dell'icona.
 */
export const CATEGORY_ICON_COMPONENTS: Record<CategoryIcon, LucideIcon> = {
  server: Server,
  globe: Globe,
  'shield-check': ShieldCheck,
  'key-round': KeyRound,
  repeat: Repeat,
  'hard-drive': HardDrive,
  wifi: Wifi,
  cpu: Cpu,
  'graduation-cap': GraduationCap,
  users: Users,
  landmark: Landmark,
  'file-text': FileText,
  receipt: Receipt,
  briefcase: Briefcase,
  mail: Mail,
  smartphone: Smartphone,
  cloud: Cloud,
  wrench: Wrench,
  car: Car,
  tag: Tag,
};

/** L'elenco nell'ordine in cui la griglia del modulo lo mostra. */
export const CATEGORY_ICON_LIST: readonly CategoryIcon[] = CATEGORY_ICONS;
