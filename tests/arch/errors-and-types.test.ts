import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigs, resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { findRule } from "../../src/arch/registry";
import { runRules } from "../../src/arch/run";
import { check, checkProject } from "./helpers";

const lines = (...parts: string[]) => parts.join("\n");
const where = (found: { file: string; line: number }[]) =>
  found.map((v) => `${v.file}:${v.line}`);

const basicBackend = { layers: { backend: ["services/", "packages/"] } };
const wideBackend = {
  layers: { backend: ["services/", "packages/", "plugins/"] },
};

test("no-raw-throw flags a raw Error in backend source", async () => {
  const found = await check(
    "no-raw-throw",
    "services/api/src/x.ts",
    'throw new Error("boom");',
    { config: basicBackend }
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, "no-raw-throw");
  assert.equal(found[0]?.line, 1);
});

test("no-raw-throw allows subclasses, comments and files outside the backend layer", async () => {
  const opts = { config: basicBackend };
  assert.equal(
    (
      await check(
        "no-raw-throw",
        "services/api/src/x.ts",
        'throw new ConflictError("x");',
        opts
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "no-raw-throw",
        "services/api/src/x.ts",
        "// throw new Error(x)",
        opts
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "no-raw-throw",
        "apps/admin/src/x.ts",
        'throw new Error("x");',
        opts
      )
    ).length,
    0
  );
});

test("no-raw-throw skips block comment and star lines", async () => {
  const text = lines(
    "/* throw new Error(x) */",
    "/**",
    " * throw new Error(y)",
    " */",
    "throw new Error(z);"
  );
  assert.deepEqual(
    where(await check("no-raw-throw", "packages/a/src/x.ts", text)),
    ["packages/a/src/x.ts:5"]
  );
});

test("no-raw-throw layer decides scope and an undefined layer matches everything", async () => {
  const text = 'throw new Error("x");';
  assert.equal(
    (
      await check("no-raw-throw", "plugins/a/src/x.ts", text, {
        config: basicBackend,
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("no-raw-throw", "plugins/a/src/x.ts", text, {
        config: wideBackend,
      })
    ).length,
    1
  );
  assert.equal(
    (await check("no-raw-throw", "apps/web/src/x.ts", text)).length,
    1
  );
});

test("no-raw-throw exemptions and message option", async () => {
  const text = 'throw new Error("x");';
  const exempt = {
    exempt: { files: ["packages/env/src/create.ts"], dirs: ["tools/cli/"] },
  };
  assert.equal(
    (
      await check("no-raw-throw", "packages/env/src/create.ts", text, {
        settings: exempt,
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("no-raw-throw", "tools/cli/src/a.ts", text, {
        settings: exempt,
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("no-raw-throw", "packages/env/src/other.ts", text, {
        settings: exempt,
      })
    ).length,
    1
  );
  const custom = await check("no-raw-throw", "a.ts", text, {
    options: { message: "use AppError" },
  });
  assert.equal(custom[0]?.message, "use AppError");
});

test("no-unsafe-error-cast flags the cast and reads the layer", async () => {
  const opts = { config: basicBackend };
  assert.equal(
    (
      await check(
        "no-unsafe-error-cast",
        "services/a/src/x.ts",
        "log((e as Error).message);",
        opts
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-unsafe-error-cast",
        "services/a/src/x.ts",
        "log(( err as Error ) . message);",
        opts
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-unsafe-error-cast",
        "apps/web/src/x.ts",
        "log((e as Error).message);",
        opts
      )
    ).length,
    0
  );
});

test("no-unsafe-error-cast ignores narrowing, other properties and comments", async () => {
  const opts = { config: basicBackend };
  const text = lines(
    "if (e instanceof Error) log(e.message);",
    "log((e as Error).stack);",
    "log((e as HttpError).message);",
    "// (e as Error).message"
  );
  assert.equal(
    (await check("no-unsafe-error-cast", "services/a/src/x.ts", text, opts))
      .length,
    0
  );
});

test("err-requires-error-code flags err() without a code, including wrapped calls", async () => {
  const opts = { config: basicBackend };
  const path = "packages/db/src/models/x.ts";
  assert.equal(
    (await check("err-requires-error-code", path, 'return err("nope");', opts))
      .length,
    1
  );
  const wrapped = lines(
    "return err(",
    '  "nope",',
    "  ErrorCode.NOT_FOUND,",
    ");"
  );
  assert.equal(
    (await check("err-requires-error-code", path, wrapped, opts)).length,
    0
  );
});

test("err-requires-error-code searches the opening line and four more", async () => {
  const filler = (n: number) => Array.from({ length: n }, () => "  x,");
  const inside = lines("return err(", ...filler(3), "  ErrorCode.X,", ");");
  const outside = lines("return err(", ...filler(4), "  ErrorCode.X,", ");");
  assert.equal(
    (await check("err-requires-error-code", "a.ts", inside)).length,
    0
  );
  assert.deepEqual(
    (await check("err-requires-error-code", "a.ts", outside)).map(
      (v) => v.line
    ),
    [1]
  );
});

test("err-requires-error-code options: callee, codeName, lookahead", async () => {
  const text = "return fail(\n  1,\n  2,\n  Code.X,\n);";
  assert.equal(
    (await check("err-requires-error-code", "a.ts", text)).length,
    0
  );
  assert.equal(
    (
      await check("err-requires-error-code", "a.ts", text, {
        options: { callee: "fail", codeName: "Code" },
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("err-requires-error-code", "a.ts", text, {
        options: { callee: "fail", codeName: "ErrorCode" },
      })
    ).length,
    1
  );
  assert.equal(
    (
      await check("err-requires-error-code", "a.ts", text, {
        options: { callee: "fail", codeName: "Code", lookahead: 1 },
      })
    ).length,
    1
  );
  assert.equal(
    (
      await check("err-requires-error-code", "a.ts", 'return err("x");', {
        options: { callee: "fail" },
      })
    ).length,
    0
  );
});

test("err-requires-error-code skips comment lines and non-backend files", async () => {
  assert.equal(
    (
      await check(
        "err-requires-error-code",
        "services/a/x.ts",
        '// return err("x");',
        { config: basicBackend }
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "err-requires-error-code",
        "apps/a/x.ts",
        'return err("x");',
        { config: basicBackend }
      )
    ).length,
    0
  );
});

test("no-empty-catch flags empty and comment-only blocks and empty catch callbacks", async () => {
  assert.equal(
    (await check("no-empty-catch", "lib/a.ts", "try { a(); } catch {}")).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-empty-catch",
        "lib/a.ts",
        "try { a(); } catch (e) {\n  // ignore\n}"
      )
    ).length,
    1
  );
  assert.equal(
    (await check("no-empty-catch", "lib/a.ts", "p.catch(() => {})")).length,
    1
  );
});

test("no-empty-catch allows handled errors", async () => {
  assert.equal(
    (
      await check(
        "no-empty-catch",
        "lib/a.ts",
        "try { a(); } catch (e) { log(e); }"
      )
    ).length,
    0
  );
  assert.equal(
    (await check("no-empty-catch", "lib/a.ts", "p.catch((e) => { log(e); })"))
      .length,
    0
  );
});

test("no-empty-catch reports the line of the catch and handles block comments", async () => {
  const text = lines(
    "const a = 1;",
    "try {",
    "  go();",
    "} catch (e) {",
    "  /* nothing */",
    "}"
  );
  assert.deepEqual(
    (await check("no-empty-catch", "lib/a.ts", text)).map((v) => v.line),
    [4]
  );
});

test("no-empty-catch callbacks option", async () => {
  const text = lines(
    "p.catch(() => {});",
    "p.catch(e => {});",
    "try { a(); } catch {}"
  );
  assert.deepEqual(
    (await check("no-empty-catch", "lib/a.ts", text)).map((v) => v.line),
    [1, 2, 3]
  );
  const blocksOnly = await check("no-empty-catch", "lib/a.ts", text, {
    options: { callbacks: false },
  });
  assert.deepEqual(
    blocksOnly.map((v) => v.line),
    [3]
  );
});

test("no-any strict variant flags as, annotations, generic arguments and arrays", async () => {
  assert.equal(
    (await check("no-any", "lib/a.ts", "const x = y as any;")).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "function f(a: any) {}")).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const m: Record<string, any> = {};"))
      .length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const p: Promise<any> = f();")).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const l: any[] = [];")).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const many = 1;")).length,
    0
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const m: many[] = [];")).length,
    0
  );
});

test("no-any is strict by default and basic variant limits the forms", async () => {
  const basic = { options: { variant: "basic" } };
  assert.equal(
    (await check("no-any", "lib/a.ts", "const x = y as any;", basic)).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "function f(a: any) {}", basic)).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const p: Promise<any> = f();", basic))
      .length,
    1
  );
  assert.equal(
    (
      await check(
        "no-any",
        "lib/a.ts",
        "const m: Record<string, any> = {};",
        basic
      )
    ).length,
    0
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "const l: any[] = [];", basic)).length,
    1
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "type List = any[];", basic)).length,
    0
  );
  assert.equal(
    (await check("no-any", "lib/a.ts", "type List = any[];")).length,
    1
  );
  assert.equal(
    (
      await check("no-any", "lib/a.ts", "const m: Record<string, any> = {};", {
        options: {},
      })
    ).length,
    1
  );
});

test("no-any skips import lines, and export-from lines only in the strict variant", async () => {
  const text = 'export { x as any } from "./a";';
  assert.equal((await check("no-any", "lib/a.ts", text)).length, 0);
  assert.equal(
    (await check("no-any", "lib/a.ts", text, { options: { variant: "basic" } }))
      .length,
    1
  );
  for (const variant of ["basic", "strict"]) {
    assert.equal(
      (
        await check(
          "no-any",
          "lib/a.ts",
          'import { any as foo } from "x"; // as any',
          { options: { variant } }
        )
      ).length,
      0
    );
    assert.equal(
      (
        await check("no-any", "lib/a.ts", "// y as any\n * z: any", {
          options: { variant },
        })
      ).length,
      0
    );
  }
});

test("no-any exemptions and message", async () => {
  const text = "const x: any = 1;";
  const settings = { exempt: { dirs: ["packages/db/src/schema/"] } };
  assert.equal(
    (await check("no-any", "packages/db/src/schema/a.ts", text, { settings }))
      .length,
    0
  );
  assert.equal(
    (await check("no-any", "packages/db/src/models/a.ts", text, { settings }))
      .length,
    1
  );
  assert.equal(
    (await check("no-any", "a.ts", text, { options: { message: "no any" } }))[0]
      ?.message,
    "no any"
  );
});

test("types-in-types-folder flags exported interfaces and aliases outside the folder", async () => {
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/a.ts",
        "export interface Foo {}"
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/a.ts",
        "export type Foo<T> = T[];"
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/a.ts",
        "export type Foo = string;"
      )
    ).length,
    1
  );
  assert.equal(
    (await check("types-in-types-folder", "lib/a.ts", "interface Local {}"))
      .length,
    0
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/a.ts",
        'export type { Foo } from "@/types/a";'
      )
    ).length,
    0
  );
  assert.equal(
    (await check("types-in-types-folder", "lib/a.ts", "export const a = 1;"))
      .length,
    0
  );
});

test("types-in-types-folder allows any types directory by default", async () => {
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "types/a.ts",
        "export interface Foo {}"
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/types/a.ts",
        "export interface Foo {}"
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/mytypes/a.ts",
        "export interface Foo {}"
      )
    ).length,
    1
  );
});

test("types-in-types-folder typesDirs option replaces the default directories", async () => {
  const options = { typesDirs: ["types/", "lib/types/"] };
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "types/a.ts",
        "export interface Foo {}",
        { options }
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/types/a.ts",
        "export interface Foo {}",
        { options }
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "src/types/a.ts",
        "export interface Foo {}",
        { options }
      )
    ).length,
    1
  );
  const exempt = { exempt: { dirs: ["types/", "lib/types/", "lib/enums/"] } };
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/enums/a.ts",
        "export type A = 1;",
        { options, settings: exempt }
      )
    ).length,
    0
  );
  const onlyExempt = { options: { typesDirs: [] }, settings: exempt };
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/types/a.ts",
        "export type A = 1;",
        onlyExempt
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "types-in-types-folder",
        "lib/x/types/a.ts",
        "export type A = 1;",
        onlyExempt
      )
    ).length,
    1
  );
});

const SERVICES = {
  config: { layers: { services: ["services/"] } },
  settings: { layer: "services" },
};
const NAMED = {
  superadmin: "AdminRole",
  grantor: "GrantParticipantRole",
  opted_in: "ConsentStatus",
  single_use: "ExpiryMode",
};
const STRICT_CONTEXTS = ["comparison", "case", "schema"];

test("enum-literal-bypass flags comparisons, case labels and schema literals from a named list", async () => {
  const options = { values: NAMED, contexts: STRICT_CONTEXTS };
  const text = lines(
    'if (role === "superadmin") {}',
    "switch (x) {",
    '  case "grantor":',
    "}",
    'const schema = t.Literal("opted_in");',
    "if (mode !== 'single_use') {}"
  );
  const found = await check(
    "enum-literal-bypass",
    "services/a/src/x.ts",
    text,
    { ...SERVICES, options }
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 3, 5, 6]
  );
  assert.equal(found[0]?.rule, "enum-literal-bypass");
  assert.equal(
    found[0]?.message,
    'Raw enum literal "superadmin", use the AdminRole enum member instead'
  );
});

test("enum-literal-bypass ignores assignments, arrays and comments", async () => {
  const options = { values: NAMED, contexts: STRICT_CONTEXTS };
  const text = lines(
    'const r = "superadmin";',
    'const list = ["grantor", "opted_in"];',
    '// if (a === "superadmin") {}',
    ' * case "grantor":'
  );
  assert.equal(
    (
      await check("enum-literal-bypass", "services/a/src/x.ts", text, {
        ...SERVICES,
        options,
      })
    ).length,
    0
  );
});

test("enum-literal-bypass layer limits the scope and exemptions apply", async () => {
  const options = { values: NAMED };
  const text = 'if (role === "superadmin") {}';
  assert.equal(
    (
      await check("enum-literal-bypass", "apps/web/src/x.ts", text, {
        ...SERVICES,
        options,
      })
    ).length,
    0
  );
  const exempt = {
    ...SERVICES.settings,
    exempt: {
      files: ["services/a/src/seed.ts"],
      dirs: ["services/a/src/schema/"],
    },
  };
  const opts = { config: SERVICES.config, settings: exempt, options };
  assert.equal(
    (await check("enum-literal-bypass", "services/a/src/seed.ts", text, opts))
      .length,
    0
  );
  assert.equal(
    (
      await check(
        "enum-literal-bypass",
        "services/a/src/schema/t.ts",
        text,
        opts
      )
    ).length,
    0
  );
  assert.equal(
    (await check("enum-literal-bypass", "services/a/src/other.ts", text, opts))
      .length,
    1
  );
});

test("enum-literal-bypass reports one violation per watched value on a line", async () => {
  const options = { values: NAMED };
  const text = 'if (a === "superadmin" || b === "grantor") {}';
  const found = await check("enum-literal-bypass", "a.ts", text, { options });
  assert.equal(found.length, 2);
  const first = await check("enum-literal-bypass", "a.ts", text, {
    options: { ...options, report: "first" },
  });
  assert.equal(first.length, 1);
  assert.match(first[0]?.message ?? "", /superadmin/);
});

test("enum-literal-bypass does nothing without a watch list", async () => {
  assert.equal(
    (await check("enum-literal-bypass", "a.ts", 'if (a === "superadmin") {}'))
      .length,
    0
  );
});

test("enum-literal-bypass loose and reversed comparisons depend on contexts", async () => {
  const text = lines(
    'if (a == "superadmin") {}',
    'if ("grantor" === a) {}',
    'if (a != "opted_in") {}'
  );
  const strictOnly = await check("enum-literal-bypass", "a.ts", text, {
    options: { values: NAMED, contexts: STRICT_CONTEXTS },
  });
  assert.equal(strictOnly.length, 0);
  const all = await check("enum-literal-bypass", "a.ts", text, {
    options: { values: NAMED },
  });
  assert.deepEqual(
    all.map((v) => v.line),
    [1, 2, 3]
  );
});

test("enum-literal-bypass loose comparison does not double count strict operators", async () => {
  const found = await check(
    "enum-literal-bypass",
    "a.ts",
    'if (a === "superadmin") {}',
    { options: { values: NAMED } }
  );
  assert.equal(found.length, 1);
});

test("enum-literal-bypass schemaCalls option", async () => {
  const text = 'const a = Type.Literal("superadmin");';
  assert.equal(
    (
      await check("enum-literal-bypass", "a.ts", text, {
        options: { values: NAMED },
      })
    ).length,
    0
  );
  const found = await check("enum-literal-bypass", "a.ts", text, {
    options: { values: NAMED, schemaCalls: ["t.Literal", "Type.Literal"] },
  });
  assert.equal(found.length, 1);
});

test("enum-literal-bypass message template", async () => {
  const options = { values: NAMED, message: "{value} belongs to {enum}" };
  assert.equal(
    (
      await check("enum-literal-bypass", "a.ts", 'if (a === "grantor") {}', {
        options,
      })
    )[0]?.message,
    "grantor belongs to GrantParticipantRole"
  );
  const plain = { values: ["grantor"], message: "{value} belongs to {enum}" };
  assert.equal(
    (
      await check("enum-literal-bypass", "a.ts", 'if (a === "grantor") {}', {
        options: plain,
      })
    )[0]?.message,
    "grantor belongs to matching"
  );
});

const UNION_VALUES = {
  mapped: "CurationStatus",
  rejected: "CurationStatus",
  archived: "ReleaseStatus",
  pending: "CurationStatus",
  user: "Role",
};

test("enum-literal-bypass scans unions only for the union subset", async () => {
  const options = {
    values: UNION_VALUES,
    contexts: ["comparison", "case", "schema", "union"],
    unionValues: ["mapped", "rejected", "archived"],
  };
  const text = lines(
    'type A = { status: "pending" | "mapped" };',
    'type B = "user" | "admin";',
    'type C = "archived"',
    '  | "other";',
    'if (x === "pending") {}'
  );
  const found = await check("enum-literal-bypass", "a.ts", text, { options });
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 5]
  );
  assert.equal(
    found[0]?.message,
    'Enum value "mapped" in a string-literal union, use the CurationStatus enum type instead'
  );
});

test("enum-literal-bypass unions are off by default and use every value when unionValues is unset", async () => {
  const text = 'type A = "pending" | "x";';
  assert.equal(
    (
      await check("enum-literal-bypass", "a.ts", text, {
        options: { values: UNION_VALUES },
      })
    ).length,
    0
  );
  const all = await check("enum-literal-bypass", "a.ts", text, {
    options: { values: UNION_VALUES, contexts: ["union"] },
  });
  assert.equal(all.length, 1);
});

test("enum-literal-bypass unionMessage and union only values", async () => {
  const options = {
    values: { pending: "S" },
    contexts: ["comparison", "union"],
    unionValues: ["mapped"],
    unionMessage: "union {value}",
  };
  const found = await check(
    "enum-literal-bypass",
    "a.ts",
    lines('type A = "mapped" | "x";', 'if (a === "mapped") {}'),
    { options }
  );
  assert.deepEqual(
    found.map((v) => `${v.line}:${v.message}`),
    ["1:union mapped"]
  );
});

test("enum-literal-bypass union scan is exempt like the rest of the rule", async () => {
  const options = {
    values: UNION_VALUES,
    contexts: ["union"],
    unionValues: ["mapped"],
  };
  const settings = { exempt: { dirs: ["packages/types/src/"] } };
  const text = 'type A = "mapped" | "x";';
  assert.equal(
    (
      await check("enum-literal-bypass", "packages/types/src/a.ts", text, {
        options,
        settings,
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("enum-literal-bypass", "packages/api/src/a.ts", text, {
        options,
        settings,
      })
    ).length,
    1
  );
});

test("enum-literal-bypass flags string comparisons against enum values (explicit list)", async () => {
  const options = { values: ["personal", "weekly"] };
  assert.equal(
    (
      await check(
        "enum-literal-bypass",
        "lib/a.ts",
        'if (context === "personal") {}',
        { options }
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "enum-literal-bypass",
        "lib/a.ts",
        'switch (x) { case "weekly": break; }',
        { options }
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "enum-literal-bypass",
        "lib/a.ts",
        'if ("personal" !== context) {}',
        { options }
      )
    ).length,
    1
  );
});

test("enum-literal-bypass ignores assignments and unrelated strings (explicit list)", async () => {
  const options = { values: ["personal", "weekly"] };
  assert.equal(
    (
      await check("enum-literal-bypass", "lib/a.ts", 'const c = "personal";', {
        options,
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("enum-literal-bypass", "lib/a.ts", 'if (size === "sm") {}', {
        options,
      })
    ).length,
    0
  );
});

const ENUM_FILES = {
  "lib/enums/context.ts":
    'export enum Context { Personal = "personal", Team = "team", Short = "ab", Style = "default" }',
  "lib/enums/frequency.ts":
    'export enum Frequency { Weekly = "weekly", Mixed = "Mixed" }',
  "lib/enums/nested/deep.ts": 'export enum Deep { Hidden = "hidden_value" }',
  "lib/enums/notes.md": 'X = "markdown_value"',
};
const ENUM_DIR_OPTIONS = { enumDir: "lib/enums", report: "first" };

test("enum-literal-bypass reads the watch list from enumDir", async () => {
  const text = lines(
    'if (context === "personal") {}',
    'switch (x) { case "weekly": break; }',
    'if ("team" !== context) {}',
    'if (a === "ab") {}',
    'if (a === "Mixed") {}',
    'if (a === "default") {}',
    'if (a === "hidden_value") {}',
    'if (a === "markdown_value") {}',
    'const c = "personal";'
  );
  const found = await checkProject(
    "enum-literal-bypass",
    { ...ENUM_FILES, "lib/a.ts": text },
    { options: ENUM_DIR_OPTIONS }
  );
  assert.deepEqual(where(found), ["lib/a.ts:1", "lib/a.ts:2", "lib/a.ts:3"]);
  assert.equal(
    found[0]?.message,
    'Raw enum literal "personal", use the matching enum member instead'
  );
});

test("enum-literal-bypass enumDir options: recursive, ignoreValues, enumValuePattern, list of directories", async () => {
  const text = lines('if (a === "hidden_value") {}', 'if (a === "default") {}');
  const files = { ...ENUM_FILES, "lib/a.ts": text };
  const recursive = await checkProject("enum-literal-bypass", files, {
    options: { ...ENUM_DIR_OPTIONS, enumDirRecursive: true },
  });
  assert.deepEqual(where(recursive), ["lib/a.ts:1"]);
  const noIgnore = await checkProject("enum-literal-bypass", files, {
    options: { ...ENUM_DIR_OPTIONS, ignoreValues: [] },
  });
  assert.deepEqual(where(noIgnore), ["lib/a.ts:2"]);
  const pattern = await checkProject(
    "enum-literal-bypass",
    {
      "lib/enums/x.ts": "export const CODES = ['alpha_one'];",
      "lib/a.ts": 'if (a === "alpha_one") {}',
    },
    { options: { enumDir: "lib/enums/", enumValuePattern: "'([a-z_]+)'" } }
  );
  assert.equal(pattern.length, 1);
  const dirs = await checkProject(
    "enum-literal-bypass",
    {
      "a/e.ts": 'X = "from_a"',
      "b/e.ts": 'Y = "from_b"',
      "lib/a.ts": 'if (q === "from_a" || q === "from_b") {}',
    },
    { options: { enumDir: ["a", "./b"], report: "each" } }
  );
  assert.equal(dirs.length, 2);
});

test("enum-literal-bypass explicit values and enumDir values are merged, explicit names win", async () => {
  const found = await checkProject(
    "enum-literal-bypass",
    { ...ENUM_FILES, "lib/a.ts": 'if (a === "personal" || a === "team") {}' },
    {
      options: {
        enumDir: "lib/enums",
        values: { personal: "Context" },
        report: "each",
      },
    }
  );
  assert.deepEqual(
    found.map((v) => v.message),
    [
      'Raw enum literal "personal", use the Context enum member instead',
      'Raw enum literal "team", use the matching enum member instead',
    ]
  );
});

test("enum-literal-bypass enumDir honours exemptions and a missing directory is a no-op", async () => {
  const files = {
    ...ENUM_FILES,
    "lib/intl/a.ts": 'if (a === "personal") {}',
    "lib/a.ts": 'if (a === "personal") {}',
  };
  const settings = {
    exempt: { dirs: ["lib/enums/", "lib/intl/", "lib/db/schema"] },
  };
  const found = await checkProject("enum-literal-bypass", files, {
    options: ENUM_DIR_OPTIONS,
    settings,
  });
  assert.deepEqual(where(found), ["lib/a.ts:1"]);
  assert.equal(
    (
      await checkProject(
        "enum-literal-bypass",
        { "lib/a.ts": 'if (a === "personal") {}' },
        { options: { enumDir: "missing" } }
      )
    ).length,
    0
  );
});

test("enum-literal-bypass answers to the older id", async () => {
  const files = { "lib/a.ts": 'if (context === "personal") {}' };
  assert.equal(findRule("no-enum-literal-bypass")?.id, "enum-literal-bypass");
  const viaHelper = await checkProject("no-enum-literal-bypass", files, {
    options: { values: ["personal"] },
  });
  assert.equal(viaHelper.length, 1);
  assert.equal(viaHelper[0]?.rule, "enum-literal-bypass");

  const config = resolveConfig(
    mergeConfigs(
      {},
      {
        rules: {
          "no-enum-literal-bypass": {
            options: { values: ["personal"] },
            exempt: { files: ["lib/b.ts"] },
          },
        },
      }
    )
  );
  const run = (fs: Record<string, string>) =>
    runRules({
      root: "/v",
      config,
      fs: memoryFileSystem(fs),
      only: ["no-enum-literal-bypass"],
    });
  assert.equal((await run(files)).violations.length, 1);
  assert.equal(
    (await run({ "lib/b.ts": files["lib/a.ts"] })).violations.length,
    0
  );
  const off = resolveConfig({ rules: { "no-enum-literal-bypass": "off" } });
  const result = await runRules({
    root: "/v",
    config: off,
    fs: memoryFileSystem(files),
    only: ["enum-literal-bypass"],
  });
  assert.equal(result.violations.length, 0);
});

test("enum-literal-bypass skips test files", async () => {
  const found = await checkProject(
    "enum-literal-bypass",
    {
      "lib/a.test.ts": 'if (a === "personal") {}',
      "tests/b.ts": 'if (a === "personal") {}',
    },
    { options: { values: ["personal"] } }
  );
  assert.equal(found.length, 0);
});

const UNDOCUMENTED = lines(
  "export function a() {}",
  "export async function b() {}",
  "export const c = 1;",
  "export interface D {}",
  "export type E = string;",
  "export enum F {}",
  "export class G {}"
);

test("require-export-jsdoc flags every undocumented declaration kind with its name", async () => {
  const found = await check("require-export-jsdoc", "lib/a.ts", UNDOCUMENTED);
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 2, 3, 4, 5, 6, 7]
  );
  assert.equal(found[0]?.message, "Exported `a` is missing a JSDoc comment");
  assert.equal(found[1]?.message, "Exported `b` is missing a JSDoc comment");
  assert.equal(found[4]?.message, "Exported `E` is missing a JSDoc comment");
});

test("require-export-jsdoc accepts a preceding JSDoc block, even after blank lines", async () => {
  const text = lines(
    "/** Doc. */",
    "export function a() {}",
    "",
    "/**",
    " * Doc.",
    " */",
    "",
    "export const b = 1;"
  );
  assert.equal(
    (await check("require-export-jsdoc", "lib/a.ts", text)).length,
    0
  );
});

test("require-export-jsdoc rejects a line comment or code between the doc and the export", async () => {
  const text = lines(
    "/** Doc. */",
    "// note",
    "export function a() {}",
    "const z = 1;",
    "export const b = 1;"
  );
  assert.deepEqual(
    (await check("require-export-jsdoc", "lib/a.ts", text)).map((v) => v.line),
    [3, 5]
  );
});

test("require-export-jsdoc ignores re-exports, default exports and other lines", async () => {
  const text = lines(
    'export { a } from "./a";',
    'export type { B } from "./b";',
    'export * from "./c";',
    "export { d };",
    "export default function () {}",
    "function local() {}"
  );
  assert.equal(
    (await check("require-export-jsdoc", "lib/a.ts", text)).length,
    0
  );
});

test("require-export-jsdoc genericTypes option covers generic aliases", async () => {
  const text = "export type Box<T> = { v: T };";
  assert.equal(
    (await check("require-export-jsdoc", "lib/a.ts", text)).length,
    1
  );
  assert.equal(
    (
      await check("require-export-jsdoc", "lib/a.ts", text, {
        options: { genericTypes: false },
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "require-export-jsdoc",
        "lib/a.ts",
        "export type Plain = string;",
        { options: { genericTypes: false } }
      )
    ).length,
    1
  );
});

test("require-export-jsdoc skipLayers skips route files only when the layer is defined", async () => {
  const text = "export const handler = 1;";
  const options = { skipLayers: ["routes"] };
  const config = { layers: { routes: ["**/routes/**"] } };
  assert.equal(
    (
      await check(
        "require-export-jsdoc",
        "services/a/src/routes/users.ts",
        text,
        { options, config }
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "require-export-jsdoc",
        "services/a/src/services/users.ts",
        text,
        { options, config }
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "require-export-jsdoc",
        "services/a/src/services/users.ts",
        text,
        { options }
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "require-export-jsdoc",
        "services/a/src/routes/users.ts",
        text,
        { config }
      )
    ).length,
    1
  );
});

test("require-export-jsdoc skipBarrelFiles and skipTsx", async () => {
  const text = "export const a = 1;";
  assert.equal(
    (await check("require-export-jsdoc", "lib/x/index.ts", text)).length,
    1
  );
  assert.equal(
    (
      await check("require-export-jsdoc", "lib/x/index.ts", text, {
        options: { skipBarrelFiles: true },
      })
    ).length,
    0
  );
  assert.equal(
    (
      await check("require-export-jsdoc", "lib/x/util.ts", text, {
        options: { skipBarrelFiles: true },
      })
    ).length,
    1
  );
  assert.equal(
    (await check("require-export-jsdoc", "ui/a.tsx", text)).length,
    1
  );
  assert.equal(
    (
      await check("require-export-jsdoc", "ui/a.tsx", text, {
        options: { skipTsx: true },
      })
    ).length,
    0
  );
});

test("require-export-jsdoc exemptions and message", async () => {
  const text = "export const a = 1;";
  const settings = { exempt: { files: ["packages/sdk/src/api-schema.ts"] } };
  assert.equal(
    (
      await check(
        "require-export-jsdoc",
        "packages/sdk/src/api-schema.ts",
        text,
        { settings }
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check("require-export-jsdoc", "packages/sdk/src/other.ts", text, {
        settings,
      })
    ).length,
    1
  );
  assert.equal(
    (
      await check("require-export-jsdoc", "a.ts", text, {
        options: { message: "document it" },
      })
    )[0]?.message,
    "document it"
  );
});

test("require-export-jsdoc indented declarations are checked like top-level ones", async () => {
  assert.deepEqual(
    (
      await check(
        "require-export-jsdoc",
        "lib/a.ts",
        "declare module 'x' {\n  export const a: number;\n}"
      )
    ).map((v) => v.line),
    [2]
  );
});
