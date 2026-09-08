import { randomUUID } from 'node:crypto';

import { AUTH_ERROR_CODES } from '@easygest/shared';
import { hashSync as bcryptHashSync } from '@node-rs/bcrypt';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type Env, parseEnv } from '../config/env';
import { type AppPrismaClient, createPrismaClient } from '../db/client';
import { AuthError, changePassword, login, logout, refresh } from './service';
import { hashRefreshToken } from './tokens';

/**
 * Test di integrazione contro un PostgreSQL vero.
 *
 * La logica di rotazione dei refresh token vive quasi interamente nei vincoli
 * e nelle transizioni di stato di una riga: un test con un finto client Prisma
 * verificherebbe soltanto che il codice chiama i metodi che il finto client si
 * aspetta, cioè verificherebbe sé stesso. Qui invece un `@@unique` sbagliato o
 * una `updateMany` che non filtra come credo falliscono davvero.
 *
 * Il prezzo è che serve un database. In CI lo fornisce il servizio `postgres`
 * del workflow; in locale lo carica `vitest.setup.ts` da `apps/api/.env`.
 *
 * Ogni test crea il proprio utente con un'email casuale e lo cancella alla
 * fine: nessuna tabella viene svuotata, quindi la suite può girare sul
 * database di sviluppo senza portarsi via i dati che ci sono già.
 */

const env: Env = parseEnv({
  ...process.env,
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

let prisma: AppPrismaClient;
const createdUserIds: string[] = [];

/** Costo minimo di bcrypt: qui interessa il flusso, non la lentezza dell'hash. */
const TEST_BCRYPT_COST = 4;
const PASSWORD = 'password-di-prova-1';

async function createUser(overrides: { isActive?: boolean } = {}): Promise<{
  id: string;
  email: string;
}> {
  const user = await prisma.user.create({
    data: {
      email: `test-${randomUUID()}@easygest.test`,
      displayName: 'Utente di prova',
      passwordHash: bcryptHashSync(PASSWORD, TEST_BCRYPT_COST),
      isActive: overrides.isActive ?? true,
      settings: { create: {} },
    },
    select: { id: true, email: true },
  });
  createdUserIds.push(user.id);
  return user;
}

const noClient = {};

beforeAll(() => {
  prisma = createPrismaClient(env);
});

afterEach(async () => {
  // `onDelete: Cascade` sui refresh token porta via anche quelli.
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('login', () => {
  it('restituisce una sessione e un refresh token con le credenziali giuste', async () => {
    const user = await createUser();
    const deps = { prisma, env };

    const { session, refreshToken } = await login(
      deps,
      { email: user.email, password: PASSWORD },
      noClient,
    );

    expect(session.user.id).toBe(user.id);
    expect(session.accessToken).not.toBe('');
    expect(session.expiresInSeconds).toBe(env.ACCESS_TOKEN_TTL);

    // Nel database c'è solo l'hash: il token in chiaro non deve esistere lì.
    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
    });
    expect(stored).not.toBeNull();
    expect(stored?.revokedAt).toBeNull();
  });

  it('registra il momento dell’ultimo accesso', async () => {
    const user = await createUser();
    await login({ prisma, env }, { email: user.email, password: PASSWORD }, noClient);
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated?.lastLoginAt).not.toBeNull();
  });

  it('rifiuta una password sbagliata', async () => {
    const user = await createUser();
    await expect(
      login({ prisma, env }, { email: user.email, password: 'sbagliata-ma-lunga' }, noClient),
    ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidCredentials, statusCode: 401 });
  });

  it('dà lo stesso errore per un’email inesistente', async () => {
    // Se i due casi si distinguessero, l'endpoint direbbe a un estraneo quali
    // indirizzi hanno un account.
    await expect(
      login(
        { prisma, env },
        { email: 'nessuno@easygest.test', password: 'qualunque-cosa' },
        noClient,
      ),
    ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidCredentials, statusCode: 401 });
  });

  it('rifiuta un account disattivato pur con la password giusta', async () => {
    const user = await createUser({ isActive: false });
    await expect(
      login({ prisma, env }, { email: user.email, password: PASSWORD }, noClient),
    ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.accountDisabled, statusCode: 403 });
  });

  it('cancella i refresh token già scaduti dello stesso utente', async () => {
    const user = await createUser();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(randomUUID()),
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await login({ prisma, env }, { email: user.email, password: PASSWORD }, noClient);

    const remaining = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('refresh', () => {
  it('ruota il token: il vecchio viene consumato, il nuovo funziona', async () => {
    const user = await createUser();
    const deps = { prisma, env };
    const first = await login(deps, { email: user.email, password: PASSWORD }, noClient);

    const second = await refresh(deps, first.refreshToken, noClient);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.session.user.id).toBe(user.id);

    const oldRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(first.refreshToken) },
    });
    expect(oldRow?.revokedAt).not.toBeNull();
  });

  it('mantiene la stessa famiglia lungo la catena di rotazioni', async () => {
    const user = await createUser();
    const deps = { prisma, env };
    const first = await login(deps, { email: user.email, password: PASSWORD }, noClient);
    const second = await refresh(deps, first.refreshToken, noClient);

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    const families = new Set(rows.map((row) => row.familyId));
    expect(rows).toHaveLength(2);
    expect(families.size).toBe(1);
    expect(second.refreshToken).not.toBe(first.refreshToken);
  });

  it('riusando un token già consumato revoca l’intera famiglia', async () => {
    // È lo scenario del cookie rubato: l'attaccante usa la copia, poi il
    // legittimo proprietario ripresenta il proprio — o viceversa. Non è
    // possibile sapere chi sia chi, quindi cadono entrambi.
    const user = await createUser();
    const deps = { prisma, env };
    const first = await login(deps, { email: user.email, password: PASSWORD }, noClient);
    const second = await refresh(deps, first.refreshToken, noClient);

    await expect(refresh(deps, first.refreshToken, noClient)).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.invalidRefreshToken,
    });

    // Anche il token buono, emesso un attimo prima, ora è inutilizzabile.
    await expect(refresh(deps, second.refreshToken, noClient)).rejects.toBeInstanceOf(AuthError);

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('rifiuta un token che non esiste', async () => {
    await expect(refresh({ prisma, env }, 'token-inventato', noClient)).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.invalidRefreshToken,
    });
  });

  it('rifiuta un token scaduto senza revocare la famiglia', async () => {
    const user = await createUser();
    const deps = { prisma, env };
    const { refreshToken } = await login(deps, { email: user.email, password: PASSWORD }, noClient);

    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(refresh(deps, refreshToken, noClient)).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.invalidRefreshToken,
    });

    // Una scadenza è fisiologica, non un sospetto di furto: la riga resta
    // com'è invece di far scattare la revoca dell'intera famiglia.
    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(refreshToken) },
    });
    expect(row?.revokedAt).toBeNull();
  });

  it('rifiuta il refresh di un account disattivato nel frattempo', async () => {
    const user = await createUser();
    const deps = { prisma, env };
    const { refreshToken } = await login(deps, { email: user.email, password: PASSWORD }, noClient);

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    await expect(refresh(deps, refreshToken, noClient)).rejects.toMatchObject({
      code: AUTH_ERROR_CODES.accountDisabled,
    });
  });
});

describe('logout', () => {
  it('revoca la famiglia, rendendo inutile il token successivo', async () => {
    const user = await createUser();
    const deps = { prisma, env };
    const { refreshToken } = await login(deps, { email: user.email, password: PASSWORD }, noClient);

    await logout(deps, refreshToken);

    await expect(refresh(deps, refreshToken, noClient)).rejects.toBeInstanceOf(AuthError);
  });

  it('non fallisce senza cookie o con un token inesistente', async () => {
    const deps = { prisma, env };
    await expect(logout(deps, undefined)).resolves.toBeUndefined();
    await expect(logout(deps, 'mai-emesso')).resolves.toBeUndefined();
  });
});

describe('changePassword', () => {
  it('cambia la password e invalida quella vecchia', async () => {
    const user = await createUser();
    const deps = { prisma, env };

    await changePassword(deps, user.id, PASSWORD, 'nuova-password-lunga', undefined);

    await expect(
      login(deps, { email: user.email, password: PASSWORD }, noClient),
    ).rejects.toBeInstanceOf(AuthError);
    await expect(
      login(deps, { email: user.email, password: 'nuova-password-lunga' }, noClient),
    ).resolves.toBeDefined();
  });

  it('rifiuta un cambio con la password attuale sbagliata', async () => {
    const user = await createUser();
    await expect(
      changePassword({ prisma, env }, user.id, 'non-e-questa', 'nuova-password-lunga', undefined),
    ).rejects.toMatchObject({ code: AUTH_ERROR_CODES.invalidCredentials });
  });

  it('butta fuori le altre sessioni ma lascia viva quella corrente', async () => {
    const user = await createUser();
    const deps = { prisma, env };
    const altroDispositivo = await login(deps, { email: user.email, password: PASSWORD }, noClient);
    const corrente = await login(deps, { email: user.email, password: PASSWORD }, noClient);

    const familyId = (
      await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hashRefreshToken(corrente.refreshToken) },
        select: { familyId: true },
      })
    ).familyId;

    await changePassword(deps, user.id, PASSWORD, 'nuova-password-lunga', familyId);

    await expect(refresh(deps, altroDispositivo.refreshToken, noClient)).rejects.toBeInstanceOf(
      AuthError,
    );
    await expect(refresh(deps, corrente.refreshToken, noClient)).resolves.toBeDefined();
  });
});
