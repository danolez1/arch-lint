import path from "node:path";
import { PKG_ROOT, resolveBin, run } from "../util.mjs";

const ENTRY = path.join(PKG_ROOT, "src", "arch", "index.ts");

export async function arch(argv, { root }) {
  const loader = resolveBin("tsx", "dist/loader.mjs");
  return run(
    process.execPath,
    ["--import", loader, ENTRY, "--root", root, ...argv],
    { cwd: root }
  );
}
