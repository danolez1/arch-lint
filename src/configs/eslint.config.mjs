import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import tseslint from "typescript-eslint";
import { loadBiomeCompat } from "./biome-compat.mjs";

export const DEFAULT_IGNORES = [
  "**/node_modules/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.codeflow/**",
  "**/.history/**",
  "**/.venv/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.worktrees/**",
  "**/worktrees/**",
  "**/*.min.js",
  "**/*.d.ts",
];

function readDeps(root) {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) return new Set();
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

// eslint-config-next requires the project's own `next` install; without it fall back to the generic config.
async function loadNextConfig() {
  try {
    return (await import("eslint-config-next")).default;
  } catch (err) {
    process.stderr.write(
      `arch-lint: eslint-config-next unavailable (${err.code ?? err.message}), using the generic config. Install next to enable it.\n`
    );
    return null;
  }
}

// A project config that wraps this still gets biome.json, because that project formats and lints with Biome; `biome: false` opts out.
export async function createConfig({
  root = process.cwd(),
  ignores = [],
  rules = {},
  biome = "auto",
} = {}) {
  const deps = readDeps(root);
  const nextConfig = deps.has("next") ? await loadNextConfig() : null;
  const compat = biome === false ? null : loadBiomeCompat(root);
  const base = [
    {
      ignores: [
        ...new Set([
          ...DEFAULT_IGNORES,
          ...(compat?.eslint.ignores ?? []),
          ...ignores,
        ]),
      ],
    },
  ];

  if (nextConfig) {
    // eslint-config-next already registers the TypeScript, React and hooks plugins, so they are not added again.
    // Core no-unused-vars and no-undef misfire on TypeScript types, so the JS recommended set stays JS-only here.
    base.push(
      { ...js.configs.recommended, files: ["**/*.{js,jsx,mjs,cjs}"] },
      ...nextConfig,
      {
        files: ["**/*.{ts,tsx,mts,cts}"],
        rules: { "@typescript-eslint/no-unused-vars": "warn" },
      },
      {
        // Warnings, not errors, so projects can work through the compiler's findings without a red gate.
        rules: {
          "react-hooks/set-state-in-render": "warn",
          "react-hooks/purity": "warn",
          "react-hooks/immutability": "warn",
          "react-hooks/preserve-manual-memoization": "warn",
          "react-hooks/set-state-in-effect": "warn",
          "react-hooks/static-components": "warn",
          "react-hooks/refs": "warn",
        },
      }
    );
  } else {
    base.push(js.configs.recommended, ...tseslint.configs.recommended, {
      files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
      languageOptions: {
        globals: { ...globals.node, ...globals.browser },
      },
    });
    if (deps.has("react")) {
      base.push(reactHooks.configs.flat.recommended);
    }
  }

  if (compat)
    base.push({ rules: compat.eslint.rules }, ...compat.eslint.overrides);
  base.push({ rules });
  return base;
}

export default await createConfig();
