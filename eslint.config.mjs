// Flat ESLint config for ESLint v9+
import importPlugin from 'eslint-plugin-import'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import tseslint from 'typescript-eslint'

export default [
    {
        ignores: ['dist', 'node_modules', '.eslintrc.cjs', 'tests/**', 'scripts/**']
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: './tsconfig.eslint.json',
                sourceType: 'module',
                ecmaVersion: 2022
            }
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin,
            import: importPlugin,
            'simple-import-sort': simpleImportSort
        },
        rules: {
            'import/order': 'off',
            'simple-import-sort/imports': 'error',
            'simple-import-sort/exports': 'error',
            'import/newline-after-import': 'error',
            'import/no-unresolved': 'off'
        }
    }
]
