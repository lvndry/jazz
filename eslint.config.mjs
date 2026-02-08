import path from "node:path";
import { fileURLToPath } from "node:url";
// Used via js.configs.* - ESLint can mis-detect this as extraneous in flat configs
// eslint-disable-next-line
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import nodePlugin from "eslint-plugin-n";
// Used via globals.node - ESLint doesn't detect property access as usage
// eslint-disable-next-line
import globals from "globals";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));
const nodeGlobals = globals.node;

export default [
  js.configs.recommended,
  // Base TS rules (apply to all TS files including tests)
  ...tseslint.configs.recommended,
  // Type-checked rules (only for files in tsconfig)
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
  })),
  prettierConfig,
  nodePlugin.configs["flat/recommended-script"],
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.build.json"],
        tsconfigRootDir,
      },
      globals: {
        ...nodeGlobals,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "n/no-missing-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-process-exit": "off",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        ...nodeGlobals,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    plugins: {
      import: importPlugin,
    },
    rules: {
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", ["parent", "sibling", "index"], "object"],
          pathGroups: [
            {
              pattern: "@/**",
              group: "internal",
            },
          ],
          pathGroupsExcludedImportTypes: ["builtin"],
          distinctGroup: true,
          "newlines-between": "never",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir,
      },
      globals: {
        ...nodeGlobals,
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "n/no-missing-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
    },
  },
];
