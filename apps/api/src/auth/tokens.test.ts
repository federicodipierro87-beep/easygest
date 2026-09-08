import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { parseEnv } from '../config/env';
import {
  InvalidAccessTokenError,
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens';

const env = parseEnv({
  DATABASE_URL: 'postgresql://easygest:easygest@localhost:55432/easygest',
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
});

const secret = new TextEncoder().encode(env.JWT_SECRET);

describe('access token', () => {
  it('emette un token che si verifica e riporta l’utente', async () => {
    const token = await signAccessToken('user-1', env);
    await expect(verifyAccessToken(token, env)).resolves.toEqual({ userId: 'user-1' });
  });

  it('rifiuta un token firmato con un’altra chiave', async () => {
    const token = await signAccessToken('user-1', env);
    const otherEnv = { ...env, JWT_SECRET: 'una-chiave-completamente-diversa-ma-lunga' };
    await expect(verifyAccessToken(token, otherEnv)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rifiuta un token manomesso', async () => {
    const token = await signAccessToken('user-1', env);
    // Cambiare un carattere del payload invalida la firma: è il punto di un JWT.
    const [header, payload, signature] = token.split('.');
    const tampered = `${String(header)}.${String(payload).slice(0, -2)}XY.${String(signature)}`;
    await expect(verifyAccessToken(tampered, env)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rifiuta un token scaduto', async () => {
    const expired = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('easygest')
      .setAudience('easygest-web')
      .setIssuedAt(0)
      .setExpirationTime(1)
      .sign(secret);
    await expect(verifyAccessToken(expired, env)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rifiuta un token con audience diversa', async () => {
    // Difende dalla confusione fra token: uno emesso per un altro destinatario,
    // ma con la stessa chiave, non deve valere qui.
    const wrongAudience = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('easygest')
      .setAudience('qualcun-altro')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    await expect(verifyAccessToken(wrongAudience, env)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rifiuta un token senza subject', async () => {
    const noSubject = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('easygest')
      .setAudience('easygest-web')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    await expect(verifyAccessToken(noSubject, env)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rifiuta un token non firmato', async () => {
    // `alg: none` è l'attacco classico ai verificatori scritti male: il token
    // è ben formato e dichiara di non avere firma.
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString(
      'base64url',
    )}.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.`;
    await expect(verifyAccessToken(unsigned, env)).rejects.toThrow(InvalidAccessTokenError);
  });
});

describe('refresh token', () => {
  it('genera token diversi a ogni chiamata', () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });

  it('produce un hash coerente e non reversibile a occhio', () => {
    const { token, tokenHash } = generateRefreshToken();
    expect(hashRefreshToken(token)).toBe(tokenHash);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
  });
});
