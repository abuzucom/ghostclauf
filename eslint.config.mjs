import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    prettierConfig,
    {
        languageOptions: {
            parserOptions: {
                project: ['./tsconfig.eslint.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            'no-console': 'warn',
        },
    },
    {
        files: ['test/**/*.ts'],
        ...tseslint.configs.disableTypeChecked,
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
        },
    },
    {
        // CLI entrypoints: console output is their interface (interactive
        // prompts, or - for checkTokens.ts - stdout that run.sh/run.bat
        // parse line by line), not application logging.
        files: ['src/tools/**/*.ts'],
        rules: {
            'no-console': 'off',
        },
    },
    {
        ignores: ['dist/', 'node_modules/', 'site/', 'test/fixtures/'],
    },
);
