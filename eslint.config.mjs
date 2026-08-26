import path from "node:path";
import { fileURLToPath } from "node:url";
// Used via js.configs.* - ESLint can mis-detect this as extraneous in flat configs
// eslint-disable-next-line
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import prettierPlugin from "eslint-plugin-prettier";
// eslint-disable-next-line
import globals from "globals";
import tseslint from "typescript-eslint";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));
const nodeGlobals = globals.node;

export default [
  // The website package lints with its own config (see packages/website/README.md).
  { ignores: ["packages/website/**", "**/dist/**"] },
  js.configs.recommended,
  // Base TS rules (apply to all TS files including tests)
  ...tseslint.configs.recommended,
  // Type-checked rules (only for files in tsconfig)
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "test-preload.ts", "bench/**"],
  })),
  prettierConfig,
  nodePlugin.configs["flat/recommended-script"],
  {
    settings: {
      node: {
        version: ">=22.16.0",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", "test-preload.ts", "bench/**"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [],
        },
        tsconfigRootDir,
      },
      globals: {
        ...nodeGlobals,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      // eslint-plugin-n does raw Node resolution and can't see through tsconfig
      // `paths`/`exports`, so both rules misread every "@/core/..."-style same-package
      // self-reference as an unresolvable or undeclared import. tsc -b already checks
      // resolution; a type-aware `import-x` replacement for no-unpublished-import exists
      // but was too slow across this many tsconfigs to be worth it.
      "n/no-missing-import": "off",
      "n/no-unpublished-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-unsupported-features/node-builtins": ["error", { allowExperimental: true }],
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
      "import-x": importPlugin,
    },
    rules: {
      "import-x/order": [
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
    // Benchmarks share the test tsconfig; they print results, so console is fine.
    files: ["bench/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.test.json",
        tsconfigRootDir,
      },
      globals: {
        ...nodeGlobals,
      },
    },
    rules: {
      "no-console": "off",
      "n/no-missing-import": "off",
      "n/no-unpublished-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
    },
  },
  {
    files: ["**/*.test.{ts,tsx}"],
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
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "n/no-missing-import": "off",
      "n/no-unpublished-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
    },
  },
  {
    files: ["evals/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./evals/tsconfig.json",
        tsconfigRootDir,
      },
      globals: {
        ...nodeGlobals,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      // eslint-plugin-n does raw Node resolution and can't see through tsconfig
      // `paths`/`exports`, so both rules misread every "@/core/..."-style same-package
      // self-reference as an unresolvable or undeclared import. tsc -b already checks
      // resolution; a type-aware `import-x` replacement for no-unpublished-import exists
      // but was too slow across this many tsconfigs to be worth it.
      "n/no-missing-import": "off",
      "n/no-unpublished-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
      "n/no-unsupported-features/node-builtins": ["error", { allowExperimental: true }],
      "n/no-process-exit": "off",
    },
  },
  {
    files: ["evals/**/*.test.ts"],
    languageOptions: {
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
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
      "n/no-missing-import": "off",
      "n/no-unsupported-features/es-syntax": "off",
    },
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": "error",
    },
  },
];
