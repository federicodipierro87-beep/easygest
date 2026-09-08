import { createHash, randomBytes } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import type { Env } from '../config/env';

/**
 * Emissione e verifica dei token.
 *
 * I due token del sistema hanno nature opposte, ed è voluto:
 *
 * - l'**access token** è un JWT firmato, verificabile senza toccare il
 *   database. Dura poco proprio perché non è revocabile: una volta emesso
 *   resta valido fino alla scadenza, qualunque cosa succeda.
 * - il **refresh token** è opaco, cioè una sequenza casuale senza significato.
 *   Vale solo perché esiste una riga nel database, quindi si può revocare in
 *   qualsiasi momento — che è esattamente ciò che serve per invalidare una
 *   sessione rubata.
 */

const ISSUER = 'easygest';
const AUDIENCE = 'easygest-web';

/** Contenuto dell'access token, una volta verificato. */
export interface AccessTokenClaims {
  userId: string;
}

export class InvalidAccessTokenError extends Error {
  constructor(cause?: unknown) {
    super('Access token non valido o scaduto');
    this.name = 'InvalidAccessTokenError';
    this.cause = cause;
  }
}

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signAccessToken(userId: string, env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + env.ACCESS_TOKEN_TTL)
    .sign(secretKey(env));
}

/**
 * Verifica firma, scadenza, emittente e destinatario.
 *
 * `issuer` e `audience` non sono formalità: senza, un token emesso da un altro
 * sistema che per caso condividesse la chiave — o un token pensato per un
 * pubblico diverso — verrebbe accettato qui. Costano una riga e chiudono una
 * intera categoria di confusioni.
 */
export async function verifyAccessToken(token: string, env: Env): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Lista esplicita: senza, un token con `alg: none` o firmato con un
      // algoritmo più debole potrebbe essere accettato.
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new InvalidAccessTokenError('subject mancante');
    }
    return { userId: payload.sub };
  } catch (error) {
    if (error instanceof InvalidAccessTokenError) throw error;
    throw new InvalidAccessTokenError(error);
  }
}

/**
 * Genera un refresh token e il suo hash.
 *
 * 32 byte casuali: non c'è niente da indovinare e niente da derivare, quindi
 * non serve un hash lento come bcrypt. SHA-256 basta perché l'input ha già
 * 256 bit di entropia — un attacco a dizionario non ha dizionario possibile.
 *
 * Nel database finisce solo `tokenHash`: chi legge una copia del database non
 * può impersonare nessuno, che è il motivo per cui non salviamo il token.
 */
export function generateRefreshToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
