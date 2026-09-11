import { describe, expect, it } from 'vitest';

import { parseEnv } from '../config/env';
import { createMailer, resolveMailTransport } from './index';
import { createMemoryMailer } from './memory';
import { escapeHtml, renderHtml } from './render';
import { MailDeliveryError, RESEND_ENDPOINT, createResendMailer } from './resend';
import type { MailMessage } from './types';

const required = {
  DATABASE_URL: 'postgresql://easygest:easygest@localhost:55432/easygest',
  JWT_SECRET: 'chiave-di-test-lunga-almeno-trentadue-caratteri',
};

const nowhere = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof createMailer>[1];

function aMessage(over: Partial<MailMessage> = {}): MailMessage {
  return { to: 'utente@example.com', subject: 'Scadenza', text: 'Hosting il 15/03', ...over };
}

describe('scelta del trasporto', () => {
  it('segue NODE_ENV quando nessuno lo impone', () => {
    expect(resolveMailTransport(parseEnv(required))).toBe('log');
    expect(resolveMailTransport(parseEnv({ ...required, NODE_ENV: 'test' }))).toBe('memory');
    expect(
      resolveMailTransport(
        parseEnv({ ...required, NODE_ENV: 'production', RESEND_API_KEY: 're_x' }),
      ),
    ).toBe('resend');
  });

  it('lascia che la variabile abbia l’ultima parola', () => {
    // Serve a guardare i testi veri in sviluppo senza mandarli, e a mandarli
    // davvero da un ambiente che non è `production` quando si vuole provare.
    const env = parseEnv({ ...required, NODE_ENV: 'production', MAIL_TRANSPORT: 'log' });
    expect(resolveMailTransport(env)).toBe('log');
  });

  it('costruisce un mailer per ogni trasporto', () => {
    for (const transport of ['log', 'memory'] as const) {
      const env = parseEnv({ ...required, MAIL_TRANSPORT: transport });
      expect(typeof createMailer(env, nowhere).send).toBe('function');
    }
  });
});

describe('mailer in memoria', () => {
  it('accumula invece di inviare', async () => {
    const mailer = createMemoryMailer();
    await mailer.send(aMessage());
    await mailer.send(aMessage({ subject: 'Disdetta' }));
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Scadenza', 'Disdetta']);
  });

  it('fa fallire un invio solo, non tutti quelli dopo', async () => {
    // È la forma che serve al test della consegna: un invio fallito deve
    // lasciare `succeeded = false` senza compromettere il resto del giro.
    const mailer = createMemoryMailer();
    mailer.failNext();
    await expect(mailer.send(aMessage())).rejects.toBeInstanceOf(MailDeliveryError);
    await mailer.send(aMessage());
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('Resend', () => {
  it('manda oggetto, testo e HTML all’endpoint giusto', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'EasyGest <no-reply@example.com>',
      fetcher: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(Response.json({ id: 'msg_1' }));
      },
    });

    await mailer.send(aMessage());

    const call = calls[0];
    expect(call?.url).toBe(RESEND_ENDPOINT);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    // Il corpo è una stringa JSON, non uno stream: `createResendMailer` lo
    // costruisce con `JSON.stringify`, e il test lo verifica invece di darlo
    // per scontato con un cast.
    const raw = call?.init.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as Record<string, unknown>;
    expect(body.to).toEqual(['utente@example.com']);
    expect(body.text).toBe('Hosting il 15/03');
    expect(String(body.html)).toContain('Hosting il 15/03');
  });

  it('porta stato e corpo dentro l’errore', async () => {
    // «422» da solo non dice se il problema è il mittente non verificato o il
    // destinatario che non è il titolare dell'account, che sono i due modi in
    // cui questa integrazione fallisce la prima volta.
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'EasyGest <no-reply@example.com>',
      fetcher: () =>
        Promise.resolve(new Response('{"message":"domain is not verified"}', { status: 422 })),
    });

    await expect(mailer.send(aMessage())).rejects.toThrow(/422.*domain is not verified/);
  });

  it('non accetta un 200 con un corpo inatteso', async () => {
    // Senza questo controllo un cambio di forma dell'API si manifesterebbe
    // come email che risultano inviate e non arrivano.
    const mailer = createResendMailer({
      apiKey: 're_test',
      from: 'EasyGest <no-reply@example.com>',
      fetcher: () => Promise.resolve(Response.json({ ok: true })),
    });

    await expect(mailer.send(aMessage())).rejects.toBeInstanceOf(MailDeliveryError);
  });
});

describe('HTML', () => {
  it('non lascia che il nome di una spesa riscriva il messaggio', () => {
    expect(escapeHtml('<b>Hosting & "co"')).toBe('&lt;b&gt;Hosting &amp; &quot;co&quot;');
    expect(renderHtml('<b>Hosting')).toContain('&lt;b&gt;Hosting');
  });

  it('trasforma in link gli URL che il testo contiene già', () => {
    expect(renderHtml('Apri http://localhost:5173/scadenze')).toContain(
      'href="http://localhost:5173/scadenze"',
    );
  });

  it('tiene le righe separate', () => {
    // È tutto ciò che l'HTML deve comprare: senza, alcuni client mostrano il
    // messaggio appiccicato su una riga sola.
    const html = renderHtml('Prima\nSeconda');
    expect(html).toContain('Prima');
    expect(html).toContain('Seconda');
    expect(html.indexOf('Prima')).toBeLessThan(html.indexOf('Seconda'));
  });
});
