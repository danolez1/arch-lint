import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { runRules } from "../../src/arch/run";
import { check, type CheckOptions } from "./helpers";

const APP_FILE = "apps/provider-portal/src/components/demo.tsx";
const WEB_FILE = "apps/web/src/components/demo.tsx";
const PRIMITIVE_FILE = "packages/ui/src/primitives/demo.tsx";
const NON_UI_FILE = "services/core/src/routes/demo.tsx";
const NON_TSX_FILE = "apps/web/src/lib/demo.ts";

const UI_SCOPE = {
  include: [
    "apps/web/src/",
    "apps/provider-portal/src/",
    "apps/admin/src/",
    "apps/developer/src/",
    "packages/ui/src/",
  ],
};
const APPS_SCOPE = {
  include: ["apps/web/src/", "apps/provider-portal/src/", "apps/admin/src/"],
};

const touch = (path: string, src: string, options?: Record<string, unknown>) =>
  check("min-touch-target", path, src, { settings: UI_SCOPE, options });

test("min-touch-target: flags raw button with no size classes", async () => {
  const v = await touch(APP_FILE, `<button onClick={save}>Save</button>`);
  assert.equal(v.length, 1);
  assert.equal(v[0]?.rule, "min-touch-target");
  assert.ok(v[0]?.message.includes("no Tailwind size classes"));
});

test("min-touch-target: flags button below 48px (h-6 w-6)", async () => {
  const v = await touch(
    APP_FILE,
    `<button className="h-6 w-6 rounded" onClick={x} />`
  );
  assert.equal(v.length, 1);
  assert.ok(v[0]?.message.includes("24x24px"));
});

test("min-touch-target: passes h-12 w-12 (exactly 48px)", async () => {
  assert.equal(
    (
      await touch(
        APP_FILE,
        `<button className="h-12 w-12 rounded" onClick={x} />`
      )
    ).length,
    0
  );
});

test("min-touch-target: passes larger size (h-14 w-14)", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="h-14 w-14" onClick={x} />`))
      .length,
    0
  );
});

test("min-touch-target: passes min-h-12 min-w-12 floor", async () => {
  assert.equal(
    (
      await touch(
        APP_FILE,
        `<button className="min-h-12 min-w-12 px-4" onClick={x} />`
      )
    ).length,
    0
  );
});

test("min-touch-target: passes padding that doubles to 48px (p-6)", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="p-6" onClick={x}>Go</button>`))
      .length,
    0
  );
});

test("min-touch-target: flags only p-2 (16px box)", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="p-2" onClick={x}>Go</button>`))
      .length,
    1
  );
});

test("min-touch-target: passes arbitrary h-[48px] w-[48px]", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="h-[48px] w-[48px]" />`)).length,
    0
  );
});

test("min-touch-target: flags arbitrary h-[40px] w-[40px]", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="h-[40px] w-[40px]" />`)).length,
    1
  );
});

test("min-touch-target: reads rem arbitrary values", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="h-[3rem] w-[3rem]" />`)).length,
    0
  );
  assert.equal(
    (await touch(APP_FILE, `<button className="h-[2rem] w-[2rem]" />`)).length,
    1
  );
});

test("min-touch-target: passes a with href and size-12 shorthand", async () => {
  assert.equal(
    (await touch(APP_FILE, `<a href="/x" className="size-12" />`)).length,
    0
  );
});

test("min-touch-target: flags a with href and size-8 shorthand", async () => {
  assert.equal(
    (await touch(APP_FILE, `<a href="/x" className="size-8" />`)).length,
    1
  );
});

test("min-touch-target: skips a without href", async () => {
  assert.equal(
    (await touch(APP_FILE, `<a className="text-primary">label</a>`)).length,
    0
  );
});

test("min-touch-target: per-line override comment", async () => {
  const v = await touch(
    APP_FILE,
    `<button className="h-6 w-6" /> {/* arch-lint: min-touch-target-ok */}`
  );
  assert.equal(v.length, 0);
});

test("min-touch-target: preceding-line override comment", async () => {
  const v = await touch(
    APP_FILE,
    `// arch-lint: min-touch-target-ok\n<button className="h-6 w-6" />`
  );
  assert.equal(v.length, 0);
});

test("min-touch-target: skips aria-hidden true elements", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button aria-hidden="true" className="h-6 w-6" />`))
      .length,
    0
  );
});

test("min-touch-target: skips sr-only elements", async () => {
  assert.equal(
    (await touch(APP_FILE, `<button className="sr-only">Skip</button>`)).length,
    0
  );
});

test("min-touch-target: skips text input", async () => {
  assert.equal(
    (await touch(APP_FILE, `<input type="text" className="w-full" />`)).length,
    0
  );
});

test("min-touch-target: flags small checkbox input", async () => {
  assert.equal(
    (await touch(APP_FILE, `<input type="checkbox" className="h-4 w-4" />`))
      .length,
    1
  );
});

test("min-touch-target: passes 48px checkbox input", async () => {
  assert.equal(
    (await touch(APP_FILE, `<input type="checkbox" className="h-12 w-12" />`))
      .length,
    0
  );
});

test("min-touch-target: multi-line opening tag with sufficient classes", async () => {
  const src = `<button\n  type="button"\n  className="h-12 w-12 rounded-full"\n  onClick={save}\n>`;
  assert.equal((await touch(APP_FILE, src)).length, 0);
});

test("min-touch-target: multi-line opening tag with undersized classes", async () => {
  const src = `<button\n  type="button"\n  className="h-8 w-8 rounded"\n  onClick={save}\n>`;
  const v = await touch(APP_FILE, src);
  assert.equal(v.length, 1);
  assert.ok(v[0]?.message.includes("32x32px"));
});

test("min-touch-target: scans the web app file", async () => {
  assert.equal(
    (await touch(WEB_FILE, `<button className="h-4 w-4" />`)).length,
    1
  );
});

test("min-touch-target: scans shared primitives", async () => {
  assert.equal(
    (await touch(PRIMITIVE_FILE, `<button className="h-6 w-6" />`)).length,
    1
  );
});

test("min-touch-target: include keeps files outside the scope out", async () => {
  assert.equal(
    (await touch(NON_UI_FILE, `<button className="h-2 w-2" />`)).length,
    0
  );
});

test("min-touch-target: skips non-tsx files", async () => {
  assert.equal(
    (await touch(NON_TSX_FILE, `<button className="h-2 w-2" />`)).length,
    0
  );
});

test("min-touch-target: flags several buttons on distinct lines", async () => {
  const v = await touch(
    APP_FILE,
    `<button className="h-4 w-4" />\n<button className="h-2 w-2" />`
  );
  assert.equal(v.length, 2);
  assert.equal(v[0]?.line, 1);
  assert.equal(v[1]?.line, 2);
});

test("min-touch-target: does not match abbr or article", async () => {
  assert.equal(
    (
      await touch(
        APP_FILE,
        `<article className="text-sm"><abbr>x</abbr></article>`
      )
    ).length,
    0
  );
});

test("min-touch-target: does not match capitalized components", async () => {
  assert.equal(
    (await touch(APP_FILE, `<Button className="h-4 w-4" />`)).length,
    0
  );
});

test("min-touch-target: cn() helper with a sufficient sizing string", async () => {
  const src = `<button className={cn("h-12 w-12", isActive && "ring-2")} />`;
  assert.equal((await touch(APP_FILE, src)).length, 0);
});

test("min-touch-target: cn() helper with an undersized sizing string", async () => {
  const src = `<button className={cn("h-6 w-6", isActive && "ring-2")} />`;
  assert.equal((await touch(APP_FILE, src)).length, 1);
});

test("min-touch-target: option minSize changes the threshold and the message", async () => {
  const src = `<button className="h-11 w-11" />`;
  assert.equal((await touch(APP_FILE, src)).length, 1);
  assert.equal((await touch(APP_FILE, src, { minSize: 44 })).length, 0);
  const v = await touch(APP_FILE, `<button className="h-8 w-8" />`, {
    minSize: 44,
  });
  assert.ok(v[0]?.message.includes("44x44px"));
});

test("min-touch-target: option marker replaces the opt-out comment", async () => {
  const src = `// touch-ok\n<button className="h-6 w-6" />`;
  assert.equal((await touch(APP_FILE, src)).length, 1);
  assert.equal((await touch(APP_FILE, src, { marker: "touch-ok" })).length, 0);
  const old = `// arch-lint: min-touch-target-ok\n<button className="h-6 w-6" />`;
  assert.equal((await touch(APP_FILE, old, { marker: "touch-ok" })).length, 1);
});

test("min-touch-target: option inputTypes widens the checked input types", async () => {
  const src = `<input type="text" className="h-4 w-4" />`;
  assert.equal((await touch(APP_FILE, src)).length, 0);
  assert.equal(
    (await touch(APP_FILE, src, { inputTypes: ["text"] })).length,
    1
  );
  assert.equal(
    (
      await touch(APP_FILE, `<input type="checkbox" className="h-4 w-4" />`, {
        inputTypes: ["text"],
      })
    ).length,
    0
  );
});

test("min-touch-target: input without a type is checked", async () => {
  assert.equal(
    (await touch(APP_FILE, `<input className="h-4 w-4" />`)).length,
    1
  );
});

test("min-touch-target: options.message replaces both messages", async () => {
  const v = await touch(
    APP_FILE,
    `<button>x</button>\n<button className="h-4 w-4" />`,
    { message: "too small" }
  );
  assert.deepEqual(
    v.map((x) => x.message),
    ["too small", "too small"]
  );
});

test("min-touch-target: comment lines are skipped", async () => {
  assert.equal(
    (await touch(APP_FILE, `// <button className="h-2 w-2" />`)).length,
    0
  );
});

test("min-touch-target: layer limits the rule, default layer is frontend", async () => {
  const config = {
    layers: { frontend: ["apps/web/"], other: ["apps/provider-portal/"] },
  };
  const src = `<button className="h-4 w-4" />`;
  assert.equal(
    (await check("min-touch-target", WEB_FILE, src, { config })).length,
    1
  );
  assert.equal(
    (await check("min-touch-target", APP_FILE, src, { config })).length,
    0
  );
  assert.equal(
    (
      await check("min-touch-target", APP_FILE, src, {
        config,
        settings: { layer: "other" },
      })
    ).length,
    1
  );
});

test("min-touch-target: exempt files and dirs", async () => {
  const src = `<button className="h-4 w-4" />`;
  const files = await check("min-touch-target", WEB_FILE, src, {
    settings: { exempt: { files: [WEB_FILE] } },
  });
  assert.equal(files.length, 0);
  const dirs = await check("min-touch-target", WEB_FILE, src, {
    settings: { exempt: { dirs: ["apps/web/src/components/"] } },
  });
  assert.equal(dirs.length, 0);
});

const RESP_FILE = "apps/web/src/components/demo.tsx";
const resp = (
  path: string,
  src: string,
  options?: Record<string, unknown>,
  settings = APPS_SCOPE
) => check("require-responsive-layout", path, src, { settings, options });

test("require-responsive-layout: flags grid-cols-N with no responsive prefix", async () => {
  const v = await resp(RESP_FILE, `<div className="grid grid-cols-3 gap-4" />`);
  assert.equal(v.length, 1);
  assert.equal(v[0]?.rule, "require-responsive-layout");
  assert.ok(v[0]?.message.includes("grid-cols-*"));
});

test("require-responsive-layout: allows a responsive variant on the same line", async () => {
  const v = await resp(
    RESP_FILE,
    `<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" />`
  );
  assert.equal(v.length, 0);
});

test("require-responsive-layout: allows a responsive variant within the 3 line window", async () => {
  const src = `<div\n  className={cn(\n    "grid grid-cols-1 gap-4",\n    "sm:grid-cols-2",\n  )} />`;
  assert.equal((await resp(RESP_FILE, src)).length, 0);
});

test("require-responsive-layout: flags flex-row with no breakpoint", async () => {
  const v = await resp(
    RESP_FILE,
    `<div className="flex flex-row items-center" />`
  );
  assert.equal(v.length, 1);
  assert.ok(v[0]?.message.includes("flex-row"));
});

test("require-responsive-layout: flags fixed w-80 without breakpoint", async () => {
  const v = await resp(RESP_FILE, `<aside className="flex w-80 flex-col" />`);
  assert.equal(v.length, 1);
  assert.ok(v[0]?.message.includes("w-{64,72,80,96}"));
});

test("require-responsive-layout: allows w-80 when md:w-96 is present", async () => {
  assert.equal(
    (await resp(RESP_FILE, `<aside className="w-80 md:w-96" />`)).length,
    0
  );
});

test("require-responsive-layout: flags arbitrary px widths of 3 or more digits", async () => {
  const v = await resp(RESP_FILE, `<div className="w-[480px] p-4" />`);
  assert.equal(v.length, 1);
  assert.ok(v[0]?.message.includes("w-[Npx]"));
});

test("require-responsive-layout: ignores arbitrary px widths below 3 digits", async () => {
  assert.equal(
    (await resp(RESP_FILE, `<div className="w-[50px] p-4" />`)).length,
    0
  );
});

test("require-responsive-layout: include keeps shared primitives out", async () => {
  assert.equal(
    (await resp(PRIMITIVE_FILE, `<div className="grid grid-cols-3" />`)).length,
    0
  );
});

test("require-responsive-layout: skips non-tsx files", async () => {
  assert.equal(
    (await resp(NON_TSX_FILE, `const x = "grid grid-cols-3";`)).length,
    0
  );
});

test("require-responsive-layout: skips comment lines", async () => {
  assert.equal(
    (await resp(RESP_FILE, `// className="grid grid-cols-3"`)).length,
    0
  );
});

test("require-responsive-layout: catches class strings in ternaries", async () => {
  const src = `<aside\n  className={cn(\n    "flex flex-col",\n    collapsed ? "w-12" : "w-80"\n  )}\n/>`;
  const v = await resp(RESP_FILE, src);
  assert.ok(v.length > 0);
  assert.ok(v.some((x) => x.message.includes("w-{64,72,80,96}")));
});

test("require-responsive-layout: allows a ternary when a prefix is in the same block", async () => {
  const src = `<aside\n  className={cn(\n    "flex flex-col",\n    collapsed ? "w-12 md:w-16" : "w-full md:w-80"\n  )}\n/>`;
  assert.equal((await resp(RESP_FILE, src)).length, 0);
});

test("require-responsive-layout: one violation per line even with several triggers", async () => {
  assert.equal(
    (
      await resp(
        RESP_FILE,
        `<div className="grid grid-cols-3 flex-row w-80" />`
      )
    ).length,
    1
  );
});

test("require-responsive-layout: distinct violations across separate elements", async () => {
  const v = await resp(
    RESP_FILE,
    `<div className="grid grid-cols-3" />\n<aside className="w-80" />`
  );
  assert.equal(v.length, 2);
  assert.equal(v[0]?.line, 1);
  assert.equal(v[1]?.line, 2);
});

test("require-responsive-layout: lines without a string literal are skipped", async () => {
  assert.equal((await resp(RESP_FILE, `const grid-cols-3 = 1;`)).length, 0);
});

test("require-responsive-layout: option triggers replaces the trigger list", async () => {
  const triggers = [{ pattern: "\\bflex-nowrap\\b", label: "flex-nowrap" }];
  const src = `<div className="grid grid-cols-3 flex-nowrap" />`;
  const v = await resp(RESP_FILE, src, { triggers });
  assert.equal(v.length, 1);
  assert.ok(v[0]?.message.includes("flex-nowrap"));
  assert.equal(
    (
      await resp(RESP_FILE, `<div className="grid grid-cols-3" />`, {
        triggers,
      })
    ).length,
    0
  );
});

test("require-responsive-layout: option breakpoints changes what counts as responsive", async () => {
  const src = `<div className="grid grid-cols-3 sm:grid-cols-2" />`;
  assert.equal((await resp(RESP_FILE, src)).length, 0);
  assert.equal(
    (await resp(RESP_FILE, src, { breakpoints: ["lg", "xl"] })).length,
    1
  );
  const message =
    (await resp(RESP_FILE, src, { breakpoints: ["lg", "xl"] }))[0]?.message ??
    "";
  assert.ok(message.includes("lg:/xl:"));
});

test("require-responsive-layout: option window changes the lookaround", async () => {
  const src = `<div className="grid grid-cols-3" />\n\n\n\n<p className="sm:block" />`;
  assert.equal((await resp(RESP_FILE, src)).length, 1);
  assert.equal((await resp(RESP_FILE, src, { window: 4 })).length, 0);
  assert.equal((await resp(RESP_FILE, src, { window: 0 })).length, 1);
});

test("require-responsive-layout: options.message replaces the text", async () => {
  const v = await resp(RESP_FILE, `<div className="flex-row" />`, {
    message: "add a breakpoint",
  });
  assert.equal(v[0]?.message, "add a breakpoint");
});

test("require-responsive-layout: exempt files", async () => {
  const v = await check(
    "require-responsive-layout",
    RESP_FILE,
    `<div className="flex-row" />`,
    {
      settings: { exempt: { files: [RESP_FILE] } },
    }
  );
  assert.equal(v.length, 0);
});

const hex = (
  src: string,
  path = "src/app/page.tsx",
  extra: CheckOptions = {}
) => check("no-hardcoded-hex", path, src, extra);

test("no-hardcoded-hex: flags quoted hex colors of 3 to 8 digits", async () => {
  for (const literal of ['"#fff"', "'#a1b2c3'", "`#a1b2c3d4`"]) {
    const v = await hex(`const c = ${literal};`);
    assert.equal(v.length, 1, literal);
    assert.equal(v[0]?.rule, "no-hardcoded-hex");
  }
});

test("no-hardcoded-hex: flags a color inside an object property", async () => {
  assert.equal((await hex(`const s = { color: "#ff0000" };`)).length, 1);
});

test("no-hardcoded-hex: ignores hex-like text that is not a whole quoted color", async () => {
  assert.equal((await hex(`const c = "#12";`)).length, 0);
  assert.equal((await hex(`const c = "color #fff";`)).length, 0);
  assert.equal((await hex(`const c = "#ggg";`)).length, 0);
  assert.equal((await hex(`const c = "#123456789";`)).length, 0);
});

test("no-hardcoded-hex: skips comments and import lines", async () => {
  assert.equal((await hex(`// const c = "#fff";`)).length, 0);
  assert.equal((await hex(`import x from "#fff";`)).length, 0);
});

test("no-hardcoded-hex: skips theme-color and color-scheme lines by default", async () => {
  assert.equal(
    (await hex(`export const viewport = { themeColor: "#ffffff" };`)).length,
    0
  );
  assert.equal(
    (
      await hex(
        `  { media: "(prefers-color-scheme: dark)", color: "#000000" },`
      )
    ).length,
    0
  );
});

test("no-hardcoded-hex: option skipLines replaces the skip list", async () => {
  const line = `export const viewport = { themeColor: "#ffffff" };`;
  assert.equal(
    (await hex(line, undefined, { options: { skipLines: [] } })).length,
    1
  );
  assert.equal(
    (
      await hex(`const c = "#fff"; // keep`, undefined, {
        options: { skipLines: ["keep"] },
      })
    ).length,
    0
  );
});

test("no-hardcoded-hex: only tsx files", async () => {
  assert.equal((await hex(`const c = "#fff";`, "src/theme.ts")).length, 0);
});

test("no-hardcoded-hex: exempt dir covers the 3D scene package", async () => {
  const extra = { settings: { exempt: { dirs: ["packages/renderer/"] } } };
  assert.equal(
    (await hex(`const c = "#fff";`, "packages/renderer/src/mat.tsx", extra))
      .length,
    0
  );
  assert.equal(
    (await hex(`const c = "#fff";`, "apps/web/src/a.tsx", extra)).length,
    1
  );
});

test("no-hardcoded-hex: line numbers and options.message", async () => {
  const v = await hex(`const a = 1;\nconst c = "#fff";`, undefined, {
    options: { message: "use tokens" },
  });
  assert.equal(v[0]?.line, 2);
  assert.equal(v[0]?.message, "use tokens");
});

const inline = (
  src: string,
  path = "src/app/page.tsx",
  extra: CheckOptions = {}
) => check("no-inline-styles", path, src, extra);

test("no-inline-styles: flags style={{ on a tsx line", async () => {
  const v = await inline(`<div style={{ width: 10 }} />`);
  assert.equal(v.length, 1);
  assert.equal(v[0]?.rule, "no-inline-styles");
  assert.equal(v[0]?.line, 1);
});

test("no-inline-styles: allows a style object passed by reference", async () => {
  assert.equal((await inline(`<div style={styles.box} />`)).length, 0);
});

test("no-inline-styles: skips comments and non-tsx files", async () => {
  assert.equal((await inline(`// <div style={{ width: 1 }} />`)).length, 0);
  assert.equal(
    (await inline(`const x = <div style={{ a: 1 }} />;`, "src/a.ts")).length,
    0
  );
});

test("no-inline-styles: exempt files and dirs", async () => {
  const src = `<td style={{ padding: 0 }} />`;
  const files = {
    settings: { exempt: { files: ["src/components/list.tsx"] } },
  };
  assert.equal((await inline(src, "src/components/list.tsx", files)).length, 0);
  const dirs = {
    settings: { exempt: { dirs: ["packages/email/src/components/"] } },
  };
  assert.equal(
    (await inline(src, "packages/email/src/components/row.tsx", dirs)).length,
    0
  );
  assert.equal((await inline(src, "src/components/other.tsx", dirs)).length, 1);
});

test("no-inline-styles: options.message", async () => {
  const v = await inline(`<div style={{ a: 1 }} />`, undefined, {
    options: { message: "use classes" },
  });
  assert.equal(v[0]?.message, "use classes");
});

const BASIC = { quotes: "double", ignoreBraces: true, onePerLine: true };
const attr = (
  path: string,
  src: string,
  options?: Record<string, unknown>,
  settings?: CheckOptions["settings"]
) => check("no-hardcoded-attr-text", path, src, { options, settings });

test("no-hardcoded-attr-text: basic variant flags tsx literals and allows expressions", async () => {
  assert.equal(
    (
      await attr(
        "components/a.tsx",
        '<input placeholder="Search courses" />',
        BASIC
      )
    ).length,
    1
  );
  assert.equal(
    (await attr("components/a.tsx", "<input placeholder={t.search} />", BASIC))
      .length,
    0
  );
});

test("no-hardcoded-attr-text: only tsx files", async () => {
  assert.equal(
    (await attr("lib/a.ts", 'const p = { placeholder: "x" }', BASIC)).length,
    0
  );
  assert.equal(
    (
      await attr(
        "app/o/opengraph-image.tsx",
        'export const alt = "Site name";',
        BASIC
      )
    ).length,
    0
  );
});

test("no-hardcoded-attr-text: default attributes are aria-label, placeholder, title and alt", async () => {
  for (const name of ["aria-label", "placeholder", "title", "alt"]) {
    const v = await attr("a.tsx", `<img ${name}="Hello there" />`);
    assert.equal(v.length, 1, name);
    assert.equal(v[0]?.rule, "no-hardcoded-attr-text");
    assert.ok(v[0]?.message.includes(name));
  }
  assert.equal((await attr("a.tsx", `<img data-x="Hello there" />`)).length, 0);
});

test("no-hardcoded-attr-text: values without two letters are allowed", async () => {
  assert.equal((await attr("a.tsx", `<i aria-label="X" />`)).length, 0);
  assert.equal((await attr("a.tsx", `<i aria-label="12:30" />`)).length, 0);
  assert.equal((await attr("a.tsx", `<i aria-label="" />`)).length, 0);
});

test("no-hardcoded-attr-text: option attributes limits the list", async () => {
  const options = { attributes: ["aria-label", "placeholder"] };
  assert.equal(
    (await attr("a.tsx", `<img title="Hello there" />`, options)).length,
    0
  );
  assert.equal(
    (await attr("a.tsx", `<img alt="Hello there" />`, options)).length,
    0
  );
  assert.equal(
    (await attr("a.tsx", `<input placeholder="Hello there" />`, options))
      .length,
    1
  );
});

test("no-hardcoded-attr-text: option attributes can name other attributes", async () => {
  assert.equal(
    (
      await attr("a.tsx", `<p aria-description="Hello there" />`, {
        attributes: ["aria-description"],
      })
    ).length,
    1
  );
});

test("no-hardcoded-attr-text: quotes any accepts single quotes and a space after the equals sign", async () => {
  assert.equal((await attr("a.tsx", `<i aria-label='Open menu' />`)).length, 1);
  assert.equal(
    (await attr("a.tsx", `<i aria-label= "Open menu" />`)).length,
    1
  );
  assert.equal(
    (await attr("a.tsx", `<i aria-label='Open menu' />`, { quotes: "double" }))
      .length,
    0
  );
  assert.equal(
    (await attr("a.tsx", `<i aria-label= "Open menu" />`, { quotes: "double" }))
      .length,
    0
  );
});

test("no-hardcoded-attr-text: ignoreBraces skips values that carry braces", async () => {
  const src = `<i aria-label="Item {n} of list" />`;
  assert.equal((await attr("a.tsx", src)).length, 1);
  assert.equal((await attr("a.tsx", src, { ignoreBraces: true })).length, 0);
});

test("no-hardcoded-attr-text: double quote mode needs a word boundary before the name", async () => {
  assert.equal(
    (
      await attr("a.tsx", `<i myplaceholder="Hello there" />`, {
        quotes: "double",
      })
    ).length,
    0
  );
  assert.equal(
    (await attr("a.tsx", `<i myplaceholder="Hello there" />`)).length,
    1
  );
});

test("no-hardcoded-attr-text: one violation per matching attribute unless onePerLine", async () => {
  const src = `<input aria-label="Search box" placeholder="Search here" />`;
  const each = await attr("a.tsx", src, {
    attributes: ["aria-label", "placeholder"],
  });
  assert.equal(each.length, 2);
  assert.ok(
    each[0]?.message.includes("aria-label") &&
      each[1]?.message.includes("placeholder")
  );
  const one = await attr("a.tsx", src, {
    attributes: ["aria-label", "placeholder"],
    onePerLine: true,
  });
  assert.equal(one.length, 1);
});

test("no-hardcoded-attr-text: skips comment lines and reports the right line", async () => {
  const src = `// <i title="Hello there" />\n<i title="Hello there" />`;
  const v = await attr("a.tsx", src);
  assert.deepEqual(
    v.map((x) => x.line),
    [2]
  );
});

test("no-hardcoded-attr-text: options.message replaces the text", async () => {
  const v = await attr("a.tsx", `<i title="Hello there" />`, {
    message: "User-facing text belongs in the intl layer",
  });
  assert.equal(v[0]?.message, "User-facing text belongs in the intl layer");
});

test("no-hardcoded-attr-text: scope through include limits it to app files", async () => {
  const options = { attributes: ["aria-label", "placeholder"], quotes: "any" };
  const settings = { include: ["apps/"] };
  assert.equal(
    (
      await attr(
        "apps/web/src/a.tsx",
        `<i aria-label="Open menu" />`,
        options,
        settings
      )
    ).length,
    1
  );
  assert.equal(
    (
      await attr(
        "packages/ui/src/a.tsx",
        `<i aria-label="Open menu" />`,
        options,
        settings
      )
    ).length,
    0
  );
});

test("no-hardcoded-attr-text: settings under the old id no-hardcoded-jsx-string still apply", async () => {
  const fs = memoryFileSystem({
    "apps/a.tsx": `<i aria-label="Open menu" title="Hello there" />`,
    "apps/b.tsx": `<i aria-label="Open menu" />`,
  });
  const run = (options: Record<string, unknown>) =>
    runRules({
      root: "/virtual",
      fs,
      config: resolveConfig({
        rules: {
          "no-hardcoded-jsx-string": {
            options,
            exempt: { files: ["apps/b.tsx"] },
          },
        },
      }),
      only: ["no-hardcoded-jsx-string"],
    });
  const aria = await run({ attributes: ["aria-label"] });
  assert.deepEqual(
    aria.violations.map((x) => `${x.file}:${x.rule}`),
    ["apps/a.tsx:no-hardcoded-attr-text"]
  );
  const none = await run({ attributes: ["placeholder"] });
  assert.equal(none.violations.length, 0);
});

test("no-hardcoded-attr-text: the stricter shape (aria-label and placeholder, any quote, one per attribute)", async () => {
  const options = {
    attributes: ["aria-label", "placeholder"],
    quotes: "any",
    ignoreBraces: false,
    onePerLine: false,
  };
  const settings = { include: ["apps/"] };
  const v = await attr(
    "apps/web/src/a.tsx",
    `<input aria-label='Open' placeholder="Type here" title="Skipped" />`,
    options,
    settings
  );
  assert.equal(v.length, 2);
});

test("ui rules are registered under their canonical ids", async () => {
  const { findRule } = await import("../../src/arch/registry");
  for (const id of [
    "no-hardcoded-attr-text",
    "no-hardcoded-hex",
    "no-inline-styles",
    "min-touch-target",
    "require-responsive-layout",
  ]) {
    assert.equal(findRule(id)?.id, id);
  }
  assert.equal(
    findRule("no-hardcoded-jsx-string")?.id,
    "no-hardcoded-attr-text"
  );
});
