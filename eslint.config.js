// ESLint flat config — TypeScript checking handled by tsc, not eslint.
// This file exists so `npx eslint .` doesn't error on missing config.
export default [
  {
    ignores: ["**/*.ts", "**/*.tsx", "node_modules/**", "dist/**", ".claude/**"],
    rules: {},
  },
];
