import { randomUUID } from 'node:crypto';

import {
  AUTH_ERROR_CODES,
  type AuthErrorCode,
  type AuthSession,
  type AuthenticatedUser,
  type LoginInput,
  type RegisterInput,
} from '@easygest/shared';
import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';

import type { Env } from '../config/env';
import type { AppPrismaClient } from '../db/client';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './tokens';

/**
 * Costo di bcrypt. 12 è il compromesso corrente fra resistenza al brute force
 * offline e latenza del login: circa 250 ms sull'hardware di Railway. Va
 * rivisto verso l'alto ogni paio d'anni, non verso il basso.
 */
const BCRYPT_COST = 12;

/**
 * Errore di autenticazione con codice e stato HTTP.
 *
 * `statusCode` e `code` sono i due campi che l'error handler in `app.ts` legge
 * da un errore annotato: definirli qui evita un blocco di traduzione nelle
 * rotte, e garantisce che il frontend riceva sempre la stessa forma.
 */
export class AuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Dati del client, allegati al refresh token.
 *
 * Servono a rendere leggibile l'elenco delle sessioni attive e, soprattutto, a
 * capire cosa è successo se scatta il rilevamento di riuso: senza, resterebbe
 * solo «qualcuno ha ripresentato un token vecchio», senza sapere da dove.
 */
export interface ClientInfo {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface AuthDeps {
  prisma: AppPrismaClient;
  env: Env;
}

function toAuthenticatedUser(user: {
  id: string;
  email: string;
  displayName: string;
}): AuthenticatedUser {
  return { id: user.id, email: user.email, displayName: user.displayName };
}

/**
 * Hash di confronto usato quando l'email non esiste.
 *
 * Senza, un login con email inesistente risponderebbe molto più in fretta di
 * uno con email valida e password sbagliata: la differenza è misurabile da
 * fuori e permette di scoprire quali indirizzi sono registrati. Confrontando
 * comunque contro un hash reale, i due casi costano lo stesso.
 *
 * È calcolato una volta sola alla prima richiesta e tenuto in memoria: rifarlo
 * a ogni tentativo raddoppierebbe il costo del login legittimo.
 */
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= bcryptHash(randomUUID(), BCRYPT_COST);
  return dummyHashPromise;
}

async function issueSession(
  { prisma, env }: AuthDeps,
  user: { id: string; email: string; displayName: string },
  familyId: string,
  client: ClientInfo,
): Promise<{ session: AuthSession; refreshToken: string }> {
  const { token, tokenHash } = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash,
      familyId,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
      userAgent: client.userAgent ?? null,
      ipAddress: client.ipAddress ?? null,
    },
  });

  return {
    session: {
      accessToken: await signAccessToken(user.id, env),
      expiresInSeconds: env.ACCESS_TOKEN_TTL,
      user: toAuthenticatedUser(user),
    },
    refreshToken: token,
  };
}

export async function login(
  deps: AuthDeps,
  input: LoginInput,
  client: ClientInfo,
): Promise<{ session: AuthSession; refreshToken: string }> {
  const user = await deps.prisma.user.findUnique({ where: { email: input.email } });

  // Il confronto avviene anche senza utente, e il messaggio d'errore è identico
  // nei due casi: chi prova non deve poter distinguere «email sconosciuta» da
  // «password sbagliata», altrimenti l'endpoint diventa un modo per verificare
  // se un indirizzo è registrato.
  const passwordOk = await bcryptVerify(input.password, user?.passwordHash ?? (await dummyHash()));

  if (!user || !passwordOk) {
    throw new AuthError(401, AUTH_ERROR_CODES.invalidCredentials, 'Email o password non corretti');
  }
  if (!user.isActive) {
    throw new AuthError(403, AUTH_ERROR_CODES.accountDisabled, 'Account disattivato');
  }

  await deps.prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  // Occasione buona per liberare le righe scadute: sono inutilizzabili e
  // crescono a ogni login. Toglierle qui evita un job apposta.
  await deps.prisma.refreshToken.deleteMany({
    where: { userId: user.id, expiresAt: { lt: new Date() } },
  });

  return issueSession(deps, user, randomUUID(), client);
}

/**
 * Ruota il refresh token.
 *
 * La rotazione è il punto delicato dell'intero sistema. Ogni uso consuma il
 * token e ne emette uno nuovo nella stessa famiglia; se ricompare un token già
 * consumato ci sono solo due spiegazioni — qualcuno ne ha una copia, oppure il
 * client ha perso la risposta e sta riprovando — e non è possibile
 * distinguerle dall'esterno. Si sceglie la lettura pessimista: si revoca tutta
 * la famiglia, costringendo al login. Il costo di sbagliare in questa
 * direzione è un login in più; sbagliare nell'altra significa lasciare aperta
 * la sessione di chi ha rubato il cookie.
 */
export async function refresh(
  deps: AuthDeps,
  rawToken: string,
  client: ClientInfo,
): Promise<{ session: AuthSession; refreshToken: string }> {
  const existing = await deps.prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    include: { user: true },
  });

  if (!existing) {
    throw new AuthError(401, AUTH_ERROR_CODES.invalidRefreshToken, 'Sessione non valida');
  }

  if (existing.revokedAt !== null) {
    await revokeFamily(deps, existing.userId, existing.familyId);
    throw new AuthError(
      401,
      AUTH_ERROR_CODES.invalidRefreshToken,
      'Sessione non valida: effettua di nuovo il login',
    );
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new AuthError(401, AUTH_ERROR_CODES.invalidRefreshToken, 'Sessione scaduta');
  }

  if (!existing.user.isActive) {
    throw new AuthError(403, AUTH_ERROR_CODES.accountDisabled, 'Account disattivato');
  }

  await deps.prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });

  return issueSession(deps, existing.user, existing.familyId, client);
}

/** Revoca tutti i token nati dallo stesso login. */
async function revokeFamily({ prisma }: AuthDeps, userId: string, familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Chiude la sessione.
 *
 * Revoca l'intera famiglia e non il solo token presentato: «esci» deve
 * terminare quella sessione per intero, compresi i token che una rotazione
 * appena avvenuta potrebbe aver lasciato validi.
 *
 * Non fallisce mai: un logout con un cookie già scaduto o inventato ha
 * comunque ottenuto ciò che voleva, cioè una sessione chiusa.
 */
export async function logout(deps: AuthDeps, rawToken: string | undefined): Promise<void> {
  if (rawToken === undefined || rawToken === '') return;

  const existing = await deps.prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawToken) },
    select: { userId: true, familyId: true },
  });
  if (!existing) return;

  await revokeFamily(deps, existing.userId, existing.familyId);
}

export async function register(
  deps: AuthDeps,
  input: RegisterInput,
  client: ClientInfo,
): Promise<{ session: AuthSession; refreshToken: string }> {
  if (!deps.env.REGISTRATION_ENABLED) {
    throw new AuthError(403, AUTH_ERROR_CODES.registrationDisabled, 'Le registrazioni sono chiuse');
  }

  const existing = await deps.prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) {
    throw new AuthError(409, AUTH_ERROR_CODES.emailAlreadyUsed, 'Email già registrata');
  }

  const user = await deps.prisma.user.create({
    data: {
      email: input.email,
      displayName: input.displayName,
      passwordHash: await bcryptHash(input.password, BCRYPT_COST),
      // Le impostazioni nascono insieme all'utente: i valori di default stanno
      // nello schema, quindi qui non va ripetuto nulla. Senza questa riga il
      // primo accesso troverebbe `settings` a null e andrebbe gestito ovunque.
      settings: { create: {} },
    },
  });

  return issueSession(deps, user, randomUUID(), client);
}

/**
 * Cambio password.
 *
 * Revoca tutte le sessioni tranne quella corrente: cambiare password è la cosa
 * che si fa proprio quando si sospetta che qualcun altro sia entrato, e
 * lasciargli il cookie valido renderebbe l'operazione inutile.
 */
export async function changePassword(
  deps: AuthDeps,
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepFamilyId: string | undefined,
): Promise<void> {
  const user = await deps.prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AuthError(401, AUTH_ERROR_CODES.unauthenticated, 'Sessione non valida');
  }

  if (!(await bcryptVerify(currentPassword, user.passwordHash))) {
    throw new AuthError(
      401,
      AUTH_ERROR_CODES.invalidCredentials,
      'La password attuale non è corretta',
    );
  }

  await deps.prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcryptHash(newPassword, BCRYPT_COST) },
  });

  await deps.prisma.refreshToken.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepFamilyId === undefined ? {} : { familyId: { not: keepFamilyId } }),
    },
    data: { revokedAt: new Date() },
  });
}
