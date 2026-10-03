import { fileURLToPath } from "node:url";

const organizeImports = fileURLToPath(
  import.meta.resolve("prettier-plugin-organize-imports")
);

/** @type {import("prettier").Config} */
export default {
  semi: true,
  trailingComma: "es5",
  singleQuote: false,
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  arrowParens: "always",
  endOfLine: "lf",
  plugins: [organizeImports],
};
