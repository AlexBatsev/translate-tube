import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions }
    },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] }
  },
  {
    files: ['src/content/**/*.js'],
    languageOptions: { sourceType: 'script' }
  },
  {
    files: ['tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } }
  }
];
