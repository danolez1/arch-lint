import { fileURLToPath } from "node:url";
import { loadBiomeCompat } from "./biome-compat.mjs";

const organizeImports = fileURLToPath(
  import.meta.resolve("prettier-plugin-organize-imports")
);

const DEFAULTS = {
  semi: true,
  trailingComma: "es5",
  singleQuote: false,
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  arrowParens: "always",
  endOfLine: "lf",
};

// A project config that wraps this still gets biome.json, because that project formats with Biome; `biome: false` opts out.
export function createConfig({ root = process.cwd(), biome = "auto" } = {}) {
  const compat = biome === false ? null : loadBiomeCompat(root);
  return {
    ...DEFAULTS,
    ...compat?.prettier,
    plugins: compat?.organizeImports === false ? [] : [organizeImports],
  };
}

export default createConfig();
