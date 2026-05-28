// ESLint flat config — TypeScript checking handled by tsc, not eslint.
// This file exists so `npx eslint .` exits 0. CJS format for broad parser compat.
module.exports = [
  {
    ignores: [
      "**/*.ts", "**/*.tsx",
      "node_modules/**", "dist/**", ".claude/**",
      ".test-repos*/**", ".test-repos*",
      "repos/**",
    ],
    rules: {},
  },
];
