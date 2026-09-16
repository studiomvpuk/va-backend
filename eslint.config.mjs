// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      /*
       * Off deliberately. Several interfaces here are async because a future
       * implementation will be (ICredentialCipher against a KMS, for one), not
       * because today's implementation awaits anything. The rule's only remedy
       * is a meaningless `await Promise.resolve()`, which is worse than the
       * thing it is meant to prevent.
       */
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    /*
     * Test doubles legitimately trip these: an in-memory fake implementing an
     * async repository interface has nothing to await, and supertest's response
     * bodies are `any` by design. Keeping the rules strict in src/ is the part
     * that matters; enforcing them in fakes produces noise, not safety.
     */
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Secrets must never reach a log sink. This catches the obvious cases; the
    // enforced redaction formatter arrives in Phase 10.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(log|debug|info|warn)$/] > Identifier[name=/[Pp]assword|[Ss]ecret|[Cc]redential|plaintext/]",
          message:
            'Never pass a credential, secret or plaintext value to a logger.',
        },
      ],
    },
  },
);
