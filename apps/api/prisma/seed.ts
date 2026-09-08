/**
 * Popolamento iniziale del database.
 *
 * Crea il minimo indispensabile per poter entrare nell'applicazione: l'utente,
 * le sue impostazioni fiscali e un insieme di categorie di partenza. I dati
 * dimostrativi (clienti, spese, documenti finti) stanno di proposito altrove:
 * questo file è pensato per essere eseguito anche sul database di produzione.
 *
 * È idempotente. Rieseguirlo non duplica niente e — soprattutto — non
 * sovrascrive la password di un utente che esiste già: un seed lanciato per
 * sbaglio non deve poter cambiare le credenziali di accesso.
 *
 *   npm run seed -w @easygest/api
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';

import { hash } from '@node-rs/bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Costo di bcrypt. Dodici sono circa 250 ms per verifica su hardware
 * ordinario: abbastanza lento da rendere impraticabile provare le password a
 * tappeto, abbastanza veloce da non trasformare il login in un modo per
 * saturare la CPU dell'API.
 */
const BCRYPT_COST = 12;

const DEFAULT_EMAIL = 'federico.dipierro87@gmail.com';

/**
 * Categorie di spesa di partenza, tarate su un consulente informatico.
 *
 * Nascono `isSystem` perché l'interfaccia possa proteggerle dalla
 * cancellazione: restare senza categorie renderebbe inutilizzabili i filtri e i
 * report, e ricrearle a mano una per una è un lavoro che nessuno fa volentieri.
 *
 * Per i documenti non ci sono categorie di sistema: quelli sono già classificati
 * da `DocumentKind`, e una seconda tassonomia parallela creerebbe solo il dubbio
 * su quale delle due usare.
 */
const SYSTEM_CATEGORIES = [
  { name: 'Hosting e server', color: '#2563eb', icon: 'server' },
  { name: 'Domini', color: '#0ea5e9', icon: 'globe' },
  { name: 'Certificati SSL', color: '#14b8a6', icon: 'shield-check' },
  { name: 'Licenze software', color: '#8b5cf6', icon: 'key-round' },
  { name: 'SaaS e abbonamenti', color: '#a855f7', icon: 'repeat' },
  { name: 'Backup e storage', color: '#f59e0b', icon: 'hard-drive' },
  { name: 'Connettività', color: '#22c55e', icon: 'wifi' },
  { name: 'Hardware', color: '#64748b', icon: 'cpu' },
  { name: 'Formazione', color: '#ec4899', icon: 'graduation-cap' },
  { name: 'Consulenze', color: '#f97316', icon: 'users' },
  { name: 'Commissioni bancarie', color: '#ef4444', icon: 'landmark' },
] as const;

/**
 * Password casuale, mostrata una volta sola.
 *
 * `base64url` e non esadecimale: a parità di entropia la stringa è più corta,
 * e non contiene caratteri che una shell interpreti o che si perdano in un
 * copia-incolla.
 */
function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL non impostata: il seed non sa su quale database scrivere.');
  }

  // Client costruito qui invece di riusare quello dell'applicazione: `Env`
  // pretende tutte le variabili dell'API, che a uno script di popolamento non
  // servono. Due connessioni bastano e avanzano.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: 2 }),
  });

  try {
    const email = process.env.SEED_USER_EMAIL ?? DEFAULT_EMAIL;
    const displayName = process.env.SEED_USER_NAME ?? 'Federico';

    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    let userId: string;
    let generatedPassword: string | undefined;

    if (existing === null) {
      const password = process.env.SEED_USER_PASSWORD ?? generatePassword();
      // Se la password è stata generata va mostrata, perché non esiste altrove:
      // in database c'è solo il suo hash, che non è reversibile.
      if (process.env.SEED_USER_PASSWORD === undefined) generatedPassword = password;

      const created = await prisma.user.create({
        data: {
          email,
          displayName,
          passwordHash: await hash(password, BCRYPT_COST),
        },
        select: { id: true },
      });
      userId = created.id;
      console.log(`Utente creato: ${email}`);
    } else {
      userId = existing.id;
      console.log(`Utente già presente: ${email} (password lasciata invariata)`);
    }

    // I default delle impostazioni stanno nello schema, non qui: duplicarli
    // significherebbe avere due verità sull'aliquota da applicare.
    const settings = await prisma.settings.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { taxRegime: true, substituteTaxRateBp: true },
    });
    console.log(
      `Impostazioni: regime ${settings.taxRegime}, imposta sostitutiva ${settings.substituteTaxRateBp / 100}%`,
    );

    const existingNames = new Set(
      (await prisma.category.findMany({ where: { userId }, select: { name: true } })).map(
        (category) => category.name,
      ),
    );

    // In sequenza e non in `Promise.all`: sono undici righe, e un pool da due
    // connessioni renderebbe il parallelismo un'illusione con in più il rischio
    // di conflitti sull'unique `(userId, name)`.
    for (const [index, category] of SYSTEM_CATEGORIES.entries()) {
      await prisma.category.upsert({
        where: { userId_name: { userId, name: category.name } },
        create: {
          userId,
          name: category.name,
          color: category.color,
          icon: category.icon,
          scope: 'EXPENSE',
          isSystem: true,
          sortOrder: index,
        },
        // Solo l'ordinamento si riallinea: nome, colore e icona possono essere
        // stati cambiati dall'utente, e il seed non è autorizzato a disfare le
        // sue modifiche.
        update: { sortOrder: index },
      });
    }

    // Si contano solo quelle di sistema: l'utente può averne create di proprie,
    // e includerle nel totale darebbe un numero di «create» negativo.
    const alreadyPresent = SYSTEM_CATEGORIES.filter((category) =>
      existingNames.has(category.name),
    ).length;
    console.log(
      `Categorie: ${SYSTEM_CATEGORIES.length - alreadyPresent} create, ${alreadyPresent} già presenti`,
    );

    if (generatedPassword !== undefined) {
      console.log('');
      console.log('  Password generata, mostrata solo adesso:');
      console.log(`  ${generatedPassword}`);
      console.log('');
      console.log("  Va salvata subito: in database c'è solo il suo hash.");
      console.log('  Per sceglierla invece che generarla: SEED_USER_PASSWORD=... npm run seed');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  // Uscire con codice diverso da zero è quello che rende il seed utilizzabile
  // in uno script: senza, un fallimento passerebbe per successo.
  process.exit(1);
});
