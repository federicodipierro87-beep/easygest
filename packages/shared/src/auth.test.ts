import { describe, expect, it } from 'vitest';

import {
  PASSWORD_MAX_BYTES,
  changePasswordSchema,
  loginSchema,
  registerSchema,
  utf8ByteLength,
} from './auth';

describe('utf8ByteLength', () => {
  it('conta un byte per carattere ASCII', () => {
    expect(utf8ByteLength('password')).toBe(8);
  });

  it('conta due byte per una lettera accentata', () => {
    // È la ragione per cui il limite di bcrypt si misura in byte: "però" sono
    // quattro caratteri ma cinque byte.
    expect(utf8ByteLength('però')).toBe(5);
  });

  it('conta quattro byte per un carattere fuori dal piano base', () => {
    // Un'emoji occupa due unità UTF-16: contando `.length` risulterebbe 2,
    // contando le unità come caratteri risulterebbe 6. Sono 4.
    expect(utf8ByteLength('🔐')).toBe(4);
  });
});

describe('loginSchema', () => {
  it('normalizza l’email in minuscolo e toglie gli spazi', () => {
    // Senza, chi si registra come "Federico@Gmail.com" non entrerebbe più
    // scrivendo il proprio indirizzo in minuscolo.
    const parsed = loginSchema.parse({ email: '  Federico@Gmail.COM ', password: 'qualunque' });
    expect(parsed.email).toBe('federico@gmail.com');
  });

  it('rifiuta un’email malformata', () => {
    expect(() => loginSchema.parse({ email: 'non-una-email', password: 'x' })).toThrow();
  });

  it('non impone la lunghezza minima alla password', () => {
    // In login la regola di robustezza non va applicata: una password vecchia
    // e corta deve continuare a funzionare finché non viene cambiata.
    expect(() => loginSchema.parse({ email: 'a@b.it', password: 'corta' })).not.toThrow();
  });
});

describe('registerSchema', () => {
  it('accetta una password valida', () => {
    const parsed = registerSchema.parse({
      email: 'a@b.it',
      password: 'password-abbastanza-lunga',
      displayName: '  Federico  ',
    });
    expect(parsed.displayName).toBe('Federico');
  });

  it('rifiuta una password troppo corta', () => {
    expect(() =>
      registerSchema.parse({ email: 'a@b.it', password: 'corta', displayName: 'F' }),
    ).toThrow();
  });

  it('rifiuta una password oltre il limite di byte di bcrypt', () => {
    // Oltre 72 byte bcrypt tronca in silenzio: due password diverse che
    // condividono il prefisso diventerebbero la stessa password.
    const tooLong = 'à'.repeat(PASSWORD_MAX_BYTES); // 2 byte ciascuna
    expect(utf8ByteLength(tooLong)).toBeGreaterThan(PASSWORD_MAX_BYTES);
    expect(() =>
      registerSchema.parse({ email: 'a@b.it', password: tooLong, displayName: 'F' }),
    ).toThrow();
  });

  it('accetta esattamente 72 byte', () => {
    const exact = 'a'.repeat(PASSWORD_MAX_BYTES);
    expect(() =>
      registerSchema.parse({ email: 'a@b.it', password: exact, displayName: 'F' }),
    ).not.toThrow();
  });

  it('rifiuta un nome vuoto o fatto di soli spazi', () => {
    expect(() =>
      registerSchema.parse({ email: 'a@b.it', password: 'password-lunga-ok', displayName: '   ' }),
    ).toThrow();
  });
});

describe('changePasswordSchema', () => {
  it('applica le regole di robustezza solo alla password nuova', () => {
    expect(() =>
      changePasswordSchema.parse({ currentPassword: 'x', newPassword: 'password-lunga-ok' }),
    ).not.toThrow();
    expect(() =>
      changePasswordSchema.parse({ currentPassword: 'x', newPassword: 'corta' }),
    ).toThrow();
  });
});
