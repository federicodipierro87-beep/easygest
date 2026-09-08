import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/api/prisma/migrations/**',
      // Client Prisma generato: non è codice che scriviamo noi e non ha senso
      // sottoporlo a regole di stile.
      'apps/api/src/generated/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // `projectService` usa il tsconfig più vicino al file, senza doverli elencare
        // uno per uno: indispensabile in un monorepo con più workspace.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Una promise dimenticata in un handler Fastify diventa un errore invisibile:
      // queste due regole sono il motivo per cui il lint è type-aware.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // I file di configurazione in JS puro non hanno informazioni di tipo.
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
