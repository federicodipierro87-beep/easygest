import cookie from '@fastify/cookie';
import { AUTH_ERROR_CODES, type AuthenticatedUser } from '@easygest/shared';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import fp from 'fastify-plugin';

import { AuthError } from '../auth/service';
import { verifyAccessToken } from '../auth/tokens';
import type { Env } from '../config/env';

/**
 * Nome del cookie di refresh.
 *
 * Il prefisso `__Host-` sarebbe più solido — impone `Secure`, `Path=/` e vieta
 * `Domain`, quindi un sottodominio compromesso non può sovrascriverlo — ma
 * richiede HTTPS anche in sviluppo, dove il dev server è in chiaro. Il nome
 * cambia quindi con l'ambiente, invece di rinunciare alla protezione in
 * produzione o al funzionamento in locale.
 */
export const REFRESH_COOKIE_NAME = 'easygest_refresh';
export const refreshCookieName = (env: Env): string =>
  env.NODE_ENV === 'production' ? `__Host-${REFRESH_COOKIE_NAME}` : REFRESH_COOKIE_NAME;

/**
 * Opzioni del cookie di refresh.
 *
 * `path: '/'` merita una spiegazione, perché la scelta ovvia sarebbe
 * restringerlo a `/auth`. Non funzionerebbe: il browser confronta l'attributo
 * `Path` con l'URL che vede *lui*, cioè `/api/auth/refresh`, mentre l'API —
 * dietro la rewrite di Netlify che toglie il prefisso — scriverebbe
 * `Path=/auth/refresh`. Il cookie verrebbe salvato e poi non inviato mai più,
 * con un logout apparentemente spontaneo a ogni ricaricamento.
 */
function refreshCookieOptions(env: Env): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
} {
  return {
    // Il token non deve essere leggibile dal JavaScript della pagina: è
    // l'unica difesa che resta se un giorno finisce dentro uno script di terze
    // parti compromesso.
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    // `lax` è sufficiente e va bene proprio grazie al proxy: frontend e API
    // sono same-site, quindi il cookie parte normalmente sulle chiamate della
    // pagina, ma non su una richiesta POST partita da un altro sito. È
    // protezione CSRF senza token aggiuntivi.
    sameSite: 'lax',
    path: '/',
  };
}

export function setRefreshCookie(reply: FastifyReply, env: Env, token: string): void {
  reply.setCookie(refreshCookieName(env), token, {
    ...refreshCookieOptions(env),
    maxAge: env.REFRESH_TOKEN_TTL,
  });
}

export function clearRefreshCookie(reply: FastifyReply, env: Env): void {
  // Le opzioni devono coincidere con quelle di scrittura, `path` compreso:
  // se differiscono il browser cancella un cookie diverso e tiene quello vero.
  reply.clearCookie(refreshCookieName(env), refreshCookieOptions(env));
}

export function readRefreshCookie(request: FastifyRequest, env: Env): string | undefined {
  return request.cookies[refreshCookieName(env)];
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    /** Presente solo nelle rotte protette da `app.authenticate`. */
    currentUser?: AuthenticatedUser;
  }
}

/**
 * Registra il supporto ai cookie e il guardiano delle rotte protette.
 */
export const authPlugin = fp(
  async function authPlugin(app: FastifyInstance, env: Env): Promise<void> {
    await app.register(cookie);

    /**
     * Verifica l'access token e carica l'utente.
     *
     * La lettura dal database a ogni richiesta è una rinuncia deliberata alla
     * statelessness del JWT. Senza, un account disattivato continuerebbe a
     * essere servito fino alla scadenza del token, e «disattiva questo utente»
     * non sarebbe un'azione ma un suggerimento. Il costo è una lettura per
     * chiave primaria.
     */
    const authenticate: preHandlerAsyncHookHandler = async (request) => {
      const header = request.headers.authorization;
      if (header === undefined || !header.startsWith('Bearer ')) {
        throw new AuthError(401, AUTH_ERROR_CODES.unauthenticated, 'Autenticazione richiesta');
      }

      const claims = await verifyAccessToken(header.slice('Bearer '.length), env).catch(() => {
        throw new AuthError(401, AUTH_ERROR_CODES.unauthenticated, 'Sessione scaduta');
      });

      const user = await app.prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, email: true, displayName: true, isActive: true },
      });

      if (!user || !user.isActive) {
        throw new AuthError(401, AUTH_ERROR_CODES.unauthenticated, 'Sessione non valida');
      }

      request.currentUser = { id: user.id, email: user.email, displayName: user.displayName };
    };

    app.decorate('authenticate', authenticate);
    // Dichiarare il decoratore di richiesta con un default evita che Fastify
    // crei una proprietà nuova su ogni oggetto request, cosa che gli impedisce
    // di riusare la stessa forma e rallenta tutto.
    app.decorateRequest('currentUser', undefined);
  },
  { name: 'auth', dependencies: ['prisma'] },
);

/**
 * Legge l'utente autenticato.
 *
 * Esiste per non spargere `?? throw` nelle rotte: dentro un handler protetto
 * `currentUser` c'è sempre, ma il tipo resta opzionale perché nelle rotte
 * pubbliche non c'è. Se manca è un errore di programmazione — la rotta non ha
 * `app.authenticate` — e va visto subito, non trattato come un 401.
 */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.currentUser) {
    throw new Error('Rotta protetta senza preHandler di autenticazione');
  }
  return request.currentUser;
}
