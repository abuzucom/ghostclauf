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
        // Jazzer.js CLI does not directly execute TypeScript, so fuzz targets
        // and their runner are plain JavaScript. Keep non-type-aware ESLint
        // checks; disable type-aware parser options only.
        files: ['fuzz/**/*.js', 'scripts/run-fuzz.js'],
        ...tseslint.configs.disableTypeChecked,
        languageOptions: {
            globals: {
                Buffer: 'readonly',
                console: 'readonly',
                process: 'readonly',
            },
        },
        rules: {
            ...tseslint.configs.disableTypeChecked.rules,
            'no-console': 'off',
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
