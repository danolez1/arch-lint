import path from "node:path";
import { PKG_ROOT, resolveBin, run } from "../util.mjs";

const ENTRY = path.join(PKG_ROOT, "src", "arch", "index.ts");

export async function arch(argv, { root }) {
  const tsx = resolveBin("tsx", "dist/cli.mjs");
  return run(process.execPath, [tsx, ENTRY, "--root", root, ...argv], {
    cwd: root,
  });
}
