import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * Allowed-imports matrix shared with `scripts/package-layering.test.ts`: per package, the workspace
 * packages its production code may import and the extra ones its tests may. Plugins form one row.
 */
const LAYERING_MATRIX = JSON.parse(
  readFileSync(path.join(tsconfigRootDir, "scripts", "package-layering.matrix.json"), "utf8"),
);
const WORKSPACE_PACKAGES = Object.keys(LAYERING_MATRIX.packages);
const PLATFORM_SCOPE = "@jazz";
const WORKSPACE_SCOPES = new Set(
  ["packages", "plugins"].flatMap((area) =>
    readdirSync(path.join(tsconfigRootDir, area)).flatMap((entry) => {
      const manifestPath = path.join(tsconfigRootDir, area, entry, "package.json");
      return existsSync(manifestPath)
        ? [JSON.parse(readFileSync(manifestPath, "utf8")).name.split("/")[0]]
        : [];
    }),
  ),
);
const PLUGIN_SCOPES = [...WORKSPACE_SCOPES].filter((scope) => scope !== PLATFORM_SCOPE);
const TEST_FILE_GLOBS = ["**/*.test.ts", "**/*.test.tsx"];

function forbiddenImportPatterns(allowedPackages, packageName) {
  const pluginPatterns = PLUGIN_SCOPES.map((scope) => ({
    group: [`${scope}/*`],
    message: `${packageName} may not import ${scope}/* plugin packages: plugins are loaded, never imported.`,
  }));
  return pluginPatterns.concat(
    WORKSPACE_PACKAGES.filter(
      (candidate) => candidate !== packageName && !allowedPackages.includes(candidate),
    ).map((candidate) => ({
      group: [`@jazz/${candidate}`, `@jazz/${candidate}/*`, `@/${candidate}/*`],
      message: `${packageName} may not import @jazz/${candidate}: see scripts/package-layering.matrix.json. Move the shared piece down into a package it may import, or change the matrix on purpose.`,
    })),
  );
}

const PACKAGE_LAYERING_CONFIGS = Object.entries(LAYERING_MATRIX.packages).flatMap(
  ([packageName, row]) => {
    const testImports = row.testImports ?? [];
    const sourceFiles = [`packages/${packageName}/**/*.{ts,tsx}`];
    const productionPatterns = forbiddenImportPatterns(row.imports, packageName);
    const testPatterns = forbiddenImportPatterns([...row.imports, ...testImports], packageName);
    return [
      {
        files: sourceFiles,
        ignores: TEST_FILE_GLOBS.map((glob) => `packages/${packageName}/${glob}`),
        rules: { "no-restricted-imports": ["error", { patterns: productionPatterns }] },
      },
      {
        files: TEST_FILE_GLOBS.map((glob) => `packages/${packageName}/${glob}`),
        rules: { "no-restricted-imports": ["error", { patterns: testPatterns }] },
      },
    ];
  },
);

const PLUGIN_LAYERING_CONFIG = {
  files: ["plugins/**/*.{ts,tsx}"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              ...[...WORKSPACE_SCOPES].map((scope) => `${scope}/*`),
              ...LAYERING_MATRIX.plugins.imports.flatMap((allowed) => [
                `!${PLATFORM_SCOPE}/${allowed}`,
                `!${PLATFORM_SCOPE}/${allowed}/*`,
              ]),
              "@/*",
            ],
            message:
              "Plugins import only @jazz/plugin-sdk (not core, adapters or another plugin), so they stay publishable against the SDK alone.",
          },
        ],
      },
    ],
  },
};

export default [
  // The website package lints with its own config (see packages/website/README.md).
  { ignores: ["packages/website/**", "**/dist/**", "**/release/**"] },
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
  ...PACKAGE_LAYERING_CONFIGS,
  PLUGIN_LAYERING_CONFIG,
  {
    /**
     * Every package's source, and every test and benchmark below, is linted in the one TypeScript
     * program `tsconfig.eslint.json` describes. A program per package tsconfig would load each
     * dependency's sources again (cli alone pulls in core, adapters and daemon), so typed lint
     * memory would grow with every package added.
     */
    files: ["packages/*/src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: "./tsconfig.eslint.json",
        tsconfigRootDir,
      },
    },
  },
  {
    // Benchmarks share the test tsconfig; they print results, so console is fine.
    files: ["bench/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
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
    files: ["**/*.test.{ts,tsx}", "test-preload.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
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
        projectService: false,
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
    /**
     * Scripts, benchmarks and evals run on Bun, which defines `import.meta.main` (true only for the
     * entry module); eslint-plugin-n knows it only as an experimental Node 24 feature and flags
     * every entry-point guard, so that one name is ignored here.
     */
    files: ["scripts/**/*.ts", "bench/**/*.ts", "evals/**/*.ts"],
    rules: {
      "n/no-unsupported-features/node-builtins": [
        "error",
        { allowExperimental: true, ignores: ["import.meta.main"] },
      ],
    },
  },
  {
    /**
     * Code conventions enforced per identifier and per statement, with no suppressions. `_` is the
     * one single-character name allowed: it marks an intentionally unused parameter, which
     * `no-unused-vars` already requires to start with an underscore.
     */
    files: ["**/*.{js,mjs,ts,tsx}"],
    rules: {
      curly: ["error", "all"],
      "id-length": ["error", { min: 2, exceptions: ["_"], properties: "never" }],
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
