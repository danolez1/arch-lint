import assert from "node:assert/strict";
import test from "node:test";
import { findRule } from "../../src/arch/registry";
import { check, checkProject, type CheckOptions } from "./helpers";

const lines = (...parts: string[]): string => parts.join("\n");
const where = (violations: { file: string; line: number }[]): string[] =>
  violations.map((v) => `${v.file}:${v.line}`);

test("data layer rules are registered under their canonical ids", () => {
  for (const id of [
    "no-db-outside-models",
    "no-db-in-routes",
    "no-direct-write-audit-in-routes",
    "no-cache-in-models",
    "models-stay-below-services",
    "tx-required-multi-write",
    "tx-delete-then-insert",
    "tx-service-orchestration",
  ]) {
    assert.equal(findRule(id)?.id, id);
  }
  assert.equal(findRule("tx-service-orchestration")?.kind, "project");
  assert.equal(findRule("no-db-outside-models")?.kind, "file");
});

const SVC = "services/x/src/services/demo.service.ts";
const handleStyle = {
  options: {
    handleNames: ["db", "pool"],
    modules: ["^drizzle-orm(/|$)", "^@acme/db/schema(/|$)"],
    packages: ["^@acme/db(/|$)"],
    reExports: false,
  },
  config: {
    layers: {
      "service-src": ["services/*/src/**"],
      models: ["*/**/models/**"],
    },
  },
  settings: { layer: "service-src" },
};
const dbOutside = (
  path: string,
  text: string,
  extra: Record<string, unknown> = {}
) =>
  check("no-db-outside-models", path, text, {
    ...handleStyle,
    options: { ...handleStyle.options, ...extra },
  });

test("no-db-outside-models: layers decide which files are in scope", async () => {
  const text = 'import { db } from "@acme/db";\n';
  const found = await checkProject(
    "no-db-outside-models",
    {
      "services/x/src/services/a.service.ts": text,
      "services/x/src/workers/a.worker.ts": text,
      "services/x/src/routes/a.ts": text,
      "services/x/src/models/a.model.ts": text,
      "packages/db/src/client.ts": text,
      "apps/web/src/lib/a.ts": text,
    },
    handleStyle
  );
  assert.deepEqual(where(found), [
    "services/x/src/routes/a.ts:1",
    "services/x/src/services/a.service.ts:1",
    "services/x/src/workers/a.worker.ts:1",
  ]);
});

test("no-db-outside-models: type specifiers are dropped and aliases resolve to the original name", async () => {
  const aliased = await dbOutside(
    SVC,
    'import { db as defaultDb, type DB, eq } from "../x";\n'
  );
  assert.equal(aliased.length, 1);
  assert.match(aliased[0]?.message ?? "", /db/);
  assert.doesNotMatch(aliased[0]?.message ?? "", /DB/);
  assert.equal(
    (await dbOutside(SVC, 'import Default, { a } from "../x";\n')).length,
    0
  );
  assert.equal(
    (await dbOutside(SVC, 'import * as schema from "../x";\n')).length,
    0
  );
  assert.equal((await dbOutside(SVC, 'import db from "../x";\n')).length, 1);
});

test("no-db-outside-models: flags a handle import from the database package", async () => {
  const found = await dbOutside(
    SVC,
    'import { db, recordAuditSafely } from "@acme/db";\n'
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, "no-db-outside-models");
  assert.match(found[0]?.message ?? "", /db/);
});

test("no-db-outside-models: flags an aliased handle on a multi-line import at the statement line", async () => {
  const text =
    'import type { X } from "y";\nimport {\n  db as defaultDb,\n  writeAuditEntry,\n} from "@acme/db";\n';
  const found = await dbOutside(SVC, text);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 2);
});

test("no-db-outside-models: flags a handle pulled through a local barrel", async () => {
  const found = await dbOutside(
    "services/x/src/routes/a.ts",
    'import { db, getActorRole } from "../services/audit.service";\n'
  );
  assert.equal(found.length, 1);
});

test("no-db-outside-models: flags query builder operators and table definitions", async () => {
  const text =
    'import { and, eq } from "drizzle-orm";\nimport { twins } from "@acme/db/schema";\n';
  assert.deepEqual(
    (await dbOutside(SVC, text)).map((v) => v.line),
    [1, 2]
  );
});

test("no-db-outside-models: flags a barrel re-export of a handle", async () => {
  assert.equal(
    (await dbOutside(SVC, "export { db, recordAuditSafely };\n")).length,
    1
  );
  assert.equal(
    (await dbOutside(SVC, 'export { pool } from "@acme/db";\n')).length,
    1
  );
  assert.equal((await dbOutside(SVC, "export type { db };\n")).length, 0);
});

test("no-db-outside-models: flags a namespace import of the package, the builder or the schema", async () => {
  assert.equal(
    (await dbOutside(SVC, 'import * as acmeDb from "@acme/db";\n')).length,
    1
  );
  assert.equal(
    (await dbOutside(SVC, 'import * as orm from "drizzle-orm";\n')).length,
    1
  );
  assert.equal(
    (await dbOutside(SVC, 'import * as schema from "@acme/db/schema";\n'))
      .length,
    1
  );
});

test("no-db-outside-models: flags a dynamic import of the database package", async () => {
  assert.equal(
    (await dbOutside(SVC, 'const { db } = await import("@acme/db");\n')).length,
    1
  );
});

test("no-db-outside-models: passes type-only imports, non-handle helpers and comments", async () => {
  const text = lines(
    'import type { DB } from "@acme/db";',
    'import type { twins } from "@acme/db/schema";',
    'import { type SQL } from "drizzle-orm";',
    'import { findApiKeyByPrefix, recordAuditSafely } from "@acme/db";',
    'import { findTwin } from "../models/twin.model";',
    '// import { db } from "@acme/db";',
    "/* export { db }; */"
  );
  assert.equal((await dbOutside(SVC, text)).length, 0);
});

test("no-db-outside-models: a wider handle list also catches owner pools and the transaction helper", async () => {
  const wide = { handleNames: ["db", "ownerDb", "pool", "withTransaction"] };
  assert.equal(
    (await dbOutside(SVC, 'import { ownerDb } from "../x";\n', wide)).length,
    1
  );
  assert.equal(
    (await dbOutside(SVC, 'import { withTransaction } from "../x";\n', wide))
      .length,
    1
  );
  assert.equal(
    (await dbOutside(SVC, 'import { ownerDb } from "../x";\n')).length,
    0
  );
  assert.equal((await dbOutside(SVC, "export { ownerDb };\n", wide)).length, 1);
});

test("no-db-outside-models: a side-effect import cannot swallow the next statement", async () => {
  const found = await dbOutside(
    SVC,
    'import "./polyfill";\nimport { db } from "../x";\n'
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [2]
  );
});

const moduleStyle = {
  options: {
    handleNames: [],
    modules: [
      "^@/lib/db(/(schema|transaction|pool-config))?$",
      "^(drizzle-orm|postgres|pg)(/|$)",
    ],
  },
  config: { layers: { routes: ["app/api/"] } },
  settings: { exempt: { dirs: ["lib/db/"] } },
};
const dbModule = (
  path: string,
  text: string,
  extra: Record<string, unknown> = {}
) =>
  check("no-db-outside-models", path, text, {
    ...moduleStyle,
    options: { ...moduleStyle.options, ...extra },
  });

test("no-db-outside-models: module name variant flags value imports of the handle and the builder", async () => {
  assert.equal(
    (await dbModule("lib/services/a.ts", 'import { db } from "@/lib/db";'))
      .length,
    1
  );
  assert.equal(
    (await dbModule("lib/x.ts", 'import { eq } from "drizzle-orm";')).length,
    1
  );
  assert.equal((await dbModule("lib/x.ts", 'import pg from "pg";')).length, 1);
  const route = await dbModule(
    "app/api/a/route.ts",
    'import { users } from "@/lib/db/schema";'
  );
  assert.match(route[0]?.message ?? "", /Routes/);
});

test("no-db-outside-models: module name variant allows types, models and exempt directories", async () => {
  const route = "app/api/a/route.ts";
  assert.equal(
    (await dbModule(route, 'import type { User } from "@/lib/db/schema";'))
      .length,
    0
  );
  assert.equal(
    (await dbModule(route, 'import { getUser } from "@/lib/db/models/user";'))
      .length,
    0
  );
  assert.equal(
    (await dbModule("lib/db/models/user.ts", 'import { db } from "@/lib/db";'))
      .length,
    0
  );
  assert.equal(
    (
      await dbModule(
        "lib/x.ts",
        'import { type Foo, type Bar } from "@/lib/db";'
      )
    ).length,
    0
  );
});

test("no-db-outside-models: module name variant reports the first line of a multi-line import", async () => {
  const text =
    'import a from "a";\nimport {\n  db,\n  x,\n} from "@/lib/db";\n';
  assert.equal((await dbModule("lib/x.ts", text))[0]?.line, 2);
});

test("no-db-outside-models: module name variant also covers re-exports and dynamic imports", async () => {
  assert.equal(
    (await dbModule("lib/x.ts", 'export * from "@/lib/db";')).length,
    1
  );
  assert.equal(
    (await dbModule("lib/x.ts", 'export { eq } from "drizzle-orm";')).length,
    1
  );
  assert.equal(
    (await dbModule("lib/x.ts", 'const orm = await import("drizzle-orm");'))
      .length,
    1
  );
  assert.equal(
    (await dbModule("lib/x.ts", 'export type { A } from "@/lib/db";')).length,
    0
  );
});

test("no-db-outside-models: reExports false lets a builder re-export through and packages narrows dynamic imports", async () => {
  assert.equal(
    (
      await dbModule("lib/x.ts", 'export { eq } from "drizzle-orm";', {
        reExports: false,
      })
    ).length,
    0
  );
  assert.equal(
    (
      await dbModule("lib/x.ts", 'const orm = await import("drizzle-orm");', {
        packages: ["^@/lib/db$"],
      })
    ).length,
    0
  );
});

test("no-db-outside-models: defaults cover builders, drivers and the db and pool handles, in every file", async () => {
  const found = await check(
    "no-db-outside-models",
    "src/any/place.ts",
    lines(
      'import { eq } from "drizzle-orm/pg-core";',
      'import { Pool } from "pg";',
      'import { pool } from "./client";'
    )
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 2, 3]
  );
  assert.equal(
    (
      await check(
        "no-db-outside-models",
        "src/a.ts",
        'import { x } from "./client";'
      )
    ).length,
    0
  );
});

test("no-db-outside-models: skipLayers defaults to models only when that layer is defined", async () => {
  const text = 'import { db } from "./client";\n';
  assert.equal(
    (await check("no-db-outside-models", "src/models/a.ts", text)).length,
    1
  );
  const withLayer = { config: { layers: { models: ["src/models/"] } } };
  assert.equal(
    (await check("no-db-outside-models", "src/models/a.ts", text, withLayer))
      .length,
    0
  );
  assert.equal(
    (await check("no-db-outside-models", "src/services/a.ts", text, withLayer))
      .length,
    1
  );
  const custom = {
    ...withLayer,
    options: { skipLayers: ["data"] },
    config: { layers: { data: ["src/services/"] } },
  };
  assert.equal(
    (await check("no-db-outside-models", "src/services/a.ts", text, custom))
      .length,
    0
  );
});

test("no-db-outside-models: options.message replaces every message and exemptions apply", async () => {
  const found = await check(
    "no-db-outside-models",
    "src/a.ts",
    'import { db } from "./c";\nexport { pool };\n',
    {
      options: { message: "custom text" },
    }
  );
  assert.deepEqual(
    found.map((v) => v.message),
    ["custom text", "custom text"]
  );
  const exempt = await check(
    "no-db-outside-models",
    "src/boot.ts",
    'import { db } from "./c";\n',
    {
      settings: { exempt: { files: ["src/boot.ts"] } },
    }
  );
  assert.equal(exempt.length, 0);
});

const routeLayers = { layers: { routes: ["*/**/routes/**"] } };
const strictRoutes = {
  options: { modules: ["^@acme/db"], typeImports: "flag" },
  config: routeLayers,
  settings: {
    exempt: {
      files: ["services/a/src/routes/healthcheck.ts"],
      dirs: ["packages/db/"],
    },
  },
};
const inRoutes = (
  path: string,
  text: string,
  extra: Record<string, unknown> = {}
) =>
  check("no-db-in-routes", path, text, {
    ...strictRoutes,
    options: { ...strictRoutes.options, ...extra },
  });

test("no-db-in-routes: flags any import of the database package in a route file", async () => {
  const found = await inRoutes(
    "services/x/src/routes/a.ts",
    'import { db } from "@acme/db";\n'
  );
  assert.deepEqual(where(found), ["services/x/src/routes/a.ts:1"]);
  assert.equal(found[0]?.rule, "no-db-in-routes");
  assert.equal(
    (
      await inRoutes(
        "services/x/src/routes/a.ts",
        'import { t } from "@acme/db/schema";'
      )
    ).length,
    1
  );
  assert.equal(
    (
      await inRoutes(
        "services/x/src/routes/a.ts",
        'export { db } from "@acme/db";'
      )
    ).length,
    1
  );
});

test("no-db-in-routes: type imports follow the typeImports option", async () => {
  const text = 'import type { Db } from "@acme/db";\n';
  assert.equal((await inRoutes("services/x/src/routes/a.ts", text)).length, 1);
  assert.equal(
    (
      await inRoutes("services/x/src/routes/a.ts", text, {
        typeImports: "allow",
      })
    ).length,
    0
  );
  assert.equal(
    (
      await inRoutes(
        "services/x/src/routes/a.ts",
        'import { type Db } from "@acme/db";',
        { typeImports: "allow" }
      )
    ).length,
    0
  );
});

test("no-db-in-routes: a multi-line import is reported on the line that names the module", async () => {
  const text = 'import {\n  db,\n  x,\n} from "@acme/db";\n';
  assert.deepEqual(
    (await inRoutes("services/x/src/routes/a.ts", text)).map((v) => v.line),
    [4]
  );
});

test("no-db-in-routes: non-route files, comments and exemptions are left alone", async () => {
  const text = 'import { db } from "@acme/db";\n';
  assert.equal(
    (await inRoutes("services/x/src/services/a.ts", text)).length,
    0
  );
  assert.equal(
    (
      await inRoutes(
        "services/x/src/routes/a.ts",
        '// import { db } from "@acme/db";'
      )
    ).length,
    0
  );
  assert.equal(
    (await inRoutes("services/a/src/routes/healthcheck.ts", text)).length,
    0
  );
  assert.equal((await inRoutes("packages/db/src/routes/a.ts", text)).length, 0);
});

test("no-db-in-routes: an exact module pattern leaves subpaths and type imports alone", async () => {
  const exact = { modules: ["^@acme/db$"], typeImports: "allow" };
  const path = "apps/api/src/routes/a.ts";
  assert.equal(
    (await inRoutes(path, 'import { db, eq } from "@acme/db";', exact)).length,
    1
  );
  assert.equal(
    (await inRoutes(path, 'import type { Db } from "@acme/db";', exact)).length,
    0
  );
  assert.equal(
    (await inRoutes(path, 'import { t } from "@acme/db/schema";', exact))
      .length,
    0
  );
});

test("no-db-in-routes: defaults flag builders and drivers in the routes layer only", async () => {
  const opts = { config: routeLayers };
  assert.equal(
    (
      await check(
        "no-db-in-routes",
        "a/routes/x.ts",
        'import { eq } from "drizzle-orm";',
        opts
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-db-in-routes",
        "a/routes/x.ts",
        'import pg from "pg";',
        opts
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-db-in-routes",
        "a/routes/x.ts",
        'import type { SQL } from "drizzle-orm";',
        opts
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "no-db-in-routes",
        "a/lib/x.ts",
        'import { eq } from "drizzle-orm";',
        opts
      )
    ).length,
    0
  );
});

test("no-db-in-routes: options.message and a layer override are honoured", async () => {
  const found = await check(
    "no-db-in-routes",
    "handlers/x.ts",
    'import { eq } from "drizzle-orm";',
    {
      options: { message: "go through a model" },
      config: { layers: { handlers: ["handlers/"] } },
      settings: { layer: "handlers" },
    }
  );
  assert.deepEqual(
    found.map((v) => v.message),
    ["go through a model"]
  );
});

const auditRoute = "services/x/src/routes/users.ts";
const audit = (text: string, opts: Record<string, unknown> = {}) =>
  check("no-direct-write-audit-in-routes", auditRoute, text, {
    config: routeLayers,
    ...opts,
  });

test("no-direct-write-audit-in-routes: flags the raw primitive in a single-line import", async () => {
  const found = await audit(
    'import { writeAuditEntry, other } from "../audit";\n'
  );
  assert.deepEqual(where(found), [`${auditRoute}:1`]);
  assert.equal(found[0]?.rule, "no-direct-write-audit-in-routes");
});

test("no-direct-write-audit-in-routes: flags the line inside a multi-line import", async () => {
  const text = lines(
    "import {",
    "  recordAuditSafely,",
    "  writeAuditEntry,",
    '} from "../audit";'
  );
  assert.deepEqual(
    (await audit(text)).map((v) => v.line),
    [3]
  );
});

test("no-direct-write-audit-in-routes: type imports and the safe wrapper pass", async () => {
  assert.equal(
    (await audit('import type { writeAuditEntry } from "../audit";')).length,
    0
  );
  assert.equal(
    (
      await audit(
        lines("import type {", "  writeAuditEntry,", '} from "../audit";')
      )
    ).length,
    0
  );
  assert.equal(
    (await audit('import { recordAuditSafely } from "../audit";')).length,
    0
  );
});

test("no-direct-write-audit-in-routes: a doc comment inside an import list is not a reference", async () => {
  const text = lines(
    "import {",
    "  /** wraps writeAuditEntry, fail open */",
    "  recordAuditSafely,",
    '} from "../audit";'
  );
  assert.equal((await audit(text)).length, 0);
});

test("no-direct-write-audit-in-routes: only imports count, and a default import does not leak state", async () => {
  const text = lines(
    'import foo from "foo";',
    "export async function handler() {",
    "  await writeAuditEntry(db, entry);",
    "}"
  );
  assert.equal((await audit(text)).length, 0);
});

test("no-direct-write-audit-in-routes: names option, layer and exemptions", async () => {
  const names = {
    options: { names: ["rawAudit", "auditDirect"] },
    config: routeLayers,
  };
  assert.equal(
    (await audit('import { rawAudit } from "../a";', names)).length,
    1
  );
  assert.equal(
    (await audit('import { writeAuditEntry } from "../a";', names)).length,
    0
  );
  const outside = await check(
    "no-direct-write-audit-in-routes",
    "services/x/src/services/a.ts",
    'import { writeAuditEntry } from "../a";',
    {
      config: routeLayers,
    }
  );
  assert.equal(outside.length, 0);
  const exempt = await audit('import { writeAuditEntry } from "../a";', {
    settings: { exempt: { files: [auditRoute] } },
  });
  assert.equal(exempt.length, 0);
});

const modelCache = {
  options: {
    modules: [
      "^(@/lib/(cache|cache-invalidation|redis|redis-client)(/|$)|next/cache$)",
    ],
  },
  config: { layers: { models: ["lib/db/models/"] } },
};

test("no-cache-in-models: flags a cache import in the models layer only", async () => {
  const text = 'import { cache } from "@/lib/cache";';
  assert.equal(
    (await check("no-cache-in-models", "lib/db/models/a.ts", text, modelCache))
      .length,
    1
  );
  assert.equal(
    (await check("no-cache-in-models", "app/api/a/route.ts", text, modelCache))
      .length,
    0
  );
});

test("no-cache-in-models: type imports and dynamic imports count, and each listed module matches", async () => {
  const path = "lib/db/models/a.ts";
  assert.equal(
    (
      await check(
        "no-cache-in-models",
        path,
        'import type { C } from "@/lib/cache";',
        modelCache
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-cache-in-models",
        path,
        'const c = await import("@/lib/redis");',
        modelCache
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-cache-in-models",
        path,
        'import { revalidateTag } from "next/cache";',
        modelCache
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-cache-in-models",
        path,
        'import { x } from "@/lib/cache-invalidation";',
        modelCache
      )
    ).length,
    1
  );
  assert.equal(
    (
      await check(
        "no-cache-in-models",
        path,
        'import { x } from "@/lib/cached-thing";',
        modelCache
      )
    ).length,
    0
  );
});

test("no-cache-in-models: defaults cover the framework cache and redis clients and report the import line", async () => {
  const opts = { config: modelCache.config };
  const text = lines(
    'import a from "a";',
    'import { unstable_cache } from "next/cache";',
    'import Redis from "ioredis";'
  );
  const found = await check(
    "no-cache-in-models",
    "lib/db/models/a.ts",
    text,
    opts
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [2, 3]
  );
  assert.match(found[0]?.message ?? "", /next\/cache/);
});

const upward = {
  options: {
    modules: [
      "^@/(lib/(services|server|workers|queue|payments)|store|components|app)(/|$)|^@/lib/subscription/[^/]+-service$",
    ],
  },
  config: { layers: { models: ["lib/db/models/"] } },
};

test("models-stay-below-services: models may not import services, but types and other layers are fine", async () => {
  const path = "lib/db/models/a.ts";
  const push = 'import { push } from "@/lib/server/services/push/dispatch";';
  assert.equal(
    (await check("models-stay-below-services", path, push, upward)).length,
    1
  );
  assert.equal(
    (
      await check(
        "models-stay-below-services",
        path,
        'import type { X } from "@/lib/services/a";',
        upward
      )
    ).length,
    0
  );
  assert.equal(
    (
      await check(
        "models-stay-below-services",
        "lib/services/a.ts",
        'import { x } from "@/lib/services/b";',
        upward
      )
    ).length,
    0
  );
});

test("models-stay-below-services: each higher layer is covered, including the named service suffix", async () => {
  const path = "lib/db/models/a.ts";
  for (const source of [
    "@/store/cart",
    "@/components/ui/button",
    "@/app/api/x",
    "@/lib/workers/job",
    "@/lib/queue",
    "@/lib/payments/stripe",
    "@/lib/subscription/plan-service",
  ]) {
    const found = await check(
      "models-stay-below-services",
      path,
      `import { v } from "${source}";`,
      upward
    );
    assert.equal(found.length, 1, source);
  }
  assert.equal(
    (
      await check(
        "models-stay-below-services",
        path,
        'import { v } from "@/lib/subscription/plan";',
        upward
      )
    ).length,
    0
  );
});

test("models-stay-below-services: the default modules match relative and alias paths into higher layers", async () => {
  const opts = { config: upward.config };
  const text = lines(
    'import { a } from "../services/a";',
    'import { b } from "@/lib/server/workers/b";',
    'import { c } from "./queue-helper";',
    'import { d } from "queue";',
    'import { e } from "../shared/e";'
  );
  const found = await check(
    "models-stay-below-services",
    "lib/db/models/a.ts",
    text,
    opts
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 2]
  );
});

const SERVICE_FILE = "services/api/src/services/demo.service.ts";
const MODEL_FILE = "services/identity/src/models/demo.model.ts";
const twoInserts = lines(
  "export async function doThing() {",
  "  await db.insert(tokens).values(a);",
  "  await db.insert(auditLog).values(b);",
  "}"
);

const basicTx = {
  options: {
    blockStart: "top-level",
    transactionNames: ["withTransaction"],
    skipLayers: ["routes"],
  },
  config: {
    layers: {
      backend: ["services/", "packages/", "plugins/"],
      routes: ["*/**/routes/**"],
    },
  },
  settings: { exempt: { dirs: ["packages/db/"] } },
};
const strictTx = {
  options: {
    blockStart: "nested",
    transactionNames: ["withTransaction", "billingTx", "runInTransaction"],
  },
  config: { layers: { backend: ["services/", "packages/"] } },
  settings: { exempt: { dirs: ["packages/db/"] } },
};
const multi = (path: string, text: string, opts: CheckOptions = basicTx) =>
  check("tx-required-multi-write", path, text, opts);

test("tx-required-multi-write: flags two db writes in one function with no transaction", async () => {
  const found = await multi(MODEL_FILE, twoInserts);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, "tx-required-multi-write");
  assert.equal(found[0]?.line, 2);
  assert.equal((await multi(SERVICE_FILE, twoInserts, strictTx)).length, 1);
});

test("tx-required-multi-write: passes when the writes sit inside a transaction helper", async () => {
  const text = lines(
    "export async function doThing() {",
    "  const r = await withTransaction(async (tx) => {",
    "    await tx.insert(tokens).values(a);",
    "    await tx.insert(auditLog).values(b);",
    "  });",
    "  return toServiceResult(r);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
  assert.equal((await multi(SERVICE_FILE, text, strictTx)).length, 0);
});

test("tx-required-multi-write: passes when the block uses an inline db.transaction", async () => {
  const text = lines(
    "export async function doThing() {",
    "  await db.transaction(async (tx) => {",
    "    await tx.update(grants).set(x);",
    "    await tx.insert(auditLog).values(b);",
    "  });",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
});

test("tx-required-multi-write: a single write passes", async () => {
  const text = lines(
    "export async function createOne() {",
    "  await db.insert(tokens).values(a);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
});

test("tx-required-multi-write: writes in separate top-level functions are not merged", async () => {
  const text = lines(
    "export async function createOne() {",
    "  await db.insert(tokens).values(a);",
    "}",
    "export async function updateOne() {",
    "  await db.update(tokens).set(a);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
});

test("tx-required-multi-write: insert, update and delete all count as writes", async () => {
  const text = lines(
    "export async function churn() {",
    "  await db.update(tokens).set(a);",
    "  await db.delete(tokens).where(b);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 1);
});

test("tx-required-multi-write: writes on an executor already inside a transaction are ignored", async () => {
  const text = lines(
    "export async function composite(tx) {",
    "  await tx.insert(tokens).values(a);",
    "  await tx.insert(auditLog).values(b);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
});

test("tx-required-multi-write: commented-out writes do not count", async () => {
  const text = lines(
    "export async function doThing() {",
    "  await db.insert(tokens).values(a);",
    "  // await db.insert(auditLog).values(b);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
  const block = lines(
    "export async function doThing() {",
    "  await db.insert(tokens).values(a);",
    "  /*",
    "   * await db.insert(auditLog).values(b);",
    "   */",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, block)).length, 0);
});

test("tx-required-multi-write: the skipLayers option leaves route files out", async () => {
  const route = "services/identity/src/routes/demo.ts";
  assert.equal((await multi(route, twoInserts)).length, 0);
  assert.equal(
    (
      await multi(route, twoInserts, {
        ...basicTx,
        options: { ...basicTx.options, skipLayers: [] },
      })
    ).length,
    1
  );
});

test("tx-required-multi-write: the exempt directory and the backend layer limit the scope", async () => {
  assert.equal((await multi("packages/db/src/demo.ts", twoInserts)).length, 0);
  assert.equal((await multi("apps/web/src/lib/demo.ts", twoInserts)).length, 0);
  assert.equal(
    (await multi("packages/other/src/demo.ts", twoInserts)).length,
    1
  );
});

test("tx-required-multi-write: no layer config means every scanned file is in scope", async () => {
  assert.equal(
    (await check("tx-required-multi-write", "lib/db/models/a.ts", twoInserts))
      .length,
    1
  );
});

test("tx-required-multi-write: the strict variant counts billing and run-in-transaction helpers as evidence", async () => {
  const wrap = (name: string) =>
    lines(
      "export async function both() {",
      `  await ${name}(async (tx) => {`,
      "    await db.insert(a).values(x);",
      "    await db.update(b).set(y);",
      "  });",
      "}"
    );
  assert.equal(
    (await multi(SERVICE_FILE, wrap("billingTx"), strictTx)).length,
    0
  );
  assert.equal(
    (await multi(SERVICE_FILE, wrap("runInTransaction"), strictTx)).length,
    0
  );
  assert.equal((await multi(SERVICE_FILE, wrap("billingTx"))).length, 1);
  const custom = {
    ...basicTx,
    options: { ...basicTx.options, transactionNames: ["inTx"] },
  };
  assert.equal((await multi(SERVICE_FILE, wrap("inTx"), custom)).length, 0);
});

test("tx-required-multi-write: the strict variant starts a new block at indented methods", async () => {
  const factory = lines(
    "export function createService() {",
    "  return {",
    "    async first() {",
    "      await db.insert(a).values(1);",
    "    },",
    "    async second() {",
    "      await db.update(b).set(2);",
    "    },",
    "  };",
    "}"
  );
  assert.equal((await multi(SERVICE_FILE, factory, strictTx)).length, 0);
  const merged = await multi(SERVICE_FILE, factory);
  assert.deepEqual(
    merged.map((v) => v.line),
    [4]
  );
  const inner = lines(
    "export async function run() {",
    "  await db.insert(a).values(1);",
    "  function helper() {",
    "    return db.update(b).set(2);",
    "  }",
    "}"
  );
  assert.equal((await multi(SERVICE_FILE, inner, strictTx)).length, 0);
  assert.equal((await multi(SERVICE_FILE, inner)).length, 1);
});

test("tx-required-multi-write: the db handle names are configurable", async () => {
  const text = lines(
    "export async function f() {",
    "  await conn.insert(a).values(1);",
    "  await conn.update(b).set(2);",
    "}"
  );
  assert.equal((await multi(MODEL_FILE, text)).length, 0);
  const conn = {
    ...basicTx,
    options: { ...basicTx.options, dbHandles: ["conn"] },
  };
  assert.equal((await multi(MODEL_FILE, text, conn)).length, 1);
});

test("tx-required-multi-write: flags two untransacted writes and accepts a transaction or a single write", async () => {
  const opts = {
    options: { blockStart: "top-level", transactionNames: ["withTransaction"] },
    config: {},
    settings: {},
  };
  const two =
    "export async function f() {\n  await db.insert(a).values(x);\n  await db.update(b).set(y);\n}\n";
  assert.equal((await multi("lib/db/models/a.ts", two, opts)).length, 1);
  const wrapped =
    "export async function f() {\n  return withTransaction(async () => {\n    await db.insert(a);\n    await db.update(b);\n  });\n}\n";
  assert.equal((await multi("lib/db/models/a.ts", wrapped, opts)).length, 0);
  assert.equal(
    (
      await multi(
        "lib/db/models/a.ts",
        "export async function f() {\n  await db.insert(a);\n}\n",
        opts
      )
    ).length,
    0
  );
  const exempt = {
    ...opts,
    settings: { exempt: { files: ["lib/db/transaction.ts"] } },
  };
  assert.equal((await multi("lib/db/transaction.ts", two, exempt)).length, 0);
});

test("tx-required-multi-write: writes before the first declaration are ignored and options.message applies", async () => {
  const top = lines(
    "await db.insert(a).values(1);",
    "await db.insert(b).values(2);",
    "export const x = 1;"
  );
  assert.equal((await multi(MODEL_FILE, top)).length, 0);
  const found = await multi(MODEL_FILE, twoInserts, {
    ...basicTx,
    options: { ...basicTx.options, message: "wrap it" },
  });
  assert.deepEqual(
    found.map((v) => v.message),
    ["wrap it"]
  );
});

const ETL = "tools/adapters/src/pipeline/demo.ts";
const ADAPTER = "tools/adapters/src/adapters/demo.ts";
const APP = "apps/api/src/models/demo.ts";
const bulk = {
  options: {
    blockStart: "top-level",
    transactionNames: ["withTransaction"],
    deferDeleteThenInsert: true,
    skipLayers: ["etl"],
  },
  config: {
    layers: {
      etl: [
        "tools/adapters/src/pipeline/",
        "tools/adapters/src/adapters/",
        "apps/api/import-*.ts",
      ],
    },
  },
  settings: { exempt: { dirs: ["packages/db/"] } },
};
const bulkDelete = {
  options: { blockStart: "top-level", transactionNames: ["withTransaction"] },
  config: {},
  settings: { exempt: { dirs: ["packages/db/"] } },
};
const refresh = lines(
  "export async function refresh(db) {",
  "  await db.delete(t).where(x);",
  "  await db.insert(t).values(y);",
  "}"
);

test("tx-delete-then-insert: flags a delete followed by an insert outside a transaction in any directory", async () => {
  const found = await check(
    "tx-delete-then-insert",
    ADAPTER,
    refresh,
    bulkDelete
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, "tx-delete-then-insert");
  assert.equal(found[0]?.line, 2);
  assert.equal(
    (await check("tx-delete-then-insert", ETL, refresh, bulkDelete)).length,
    1
  );
});

test("tx-delete-then-insert: passes inside a transaction helper", async () => {
  const text = lines(
    "export async function refresh(db) {",
    "  await withTransaction(db, async (tx) => {",
    "    await tx.delete(t).where(x);",
    "    await tx.insert(t).values(y);",
    "  });",
    "}"
  );
  assert.equal(
    (await check("tx-delete-then-insert", ADAPTER, text, bulkDelete)).length,
    0
  );
});

test("tx-delete-then-insert: order matters and tx writes or other function blocks do not count", async () => {
  const insertFirst = lines(
    "export async function f(db) {",
    "  await db.insert(t).values(y);",
    "  await db.delete(t).where(x);",
    "}"
  );
  assert.equal(
    (await check("tx-delete-then-insert", APP, insertFirst, bulkDelete)).length,
    0
  );
  const onTx = lines(
    "export async function composite(tx) {",
    "  await tx.delete(t).where(x);",
    "  await tx.insert(t).values(y);",
    "}"
  );
  assert.equal(
    (await check("tx-delete-then-insert", APP, onTx, bulkDelete)).length,
    0
  );
  const split = lines(
    "export async function a(db) {",
    "  await db.delete(t).where(x);",
    "}",
    "export async function b(db) {",
    "  await db.insert(t).values(y);",
    "}"
  );
  assert.equal(
    (await check("tx-delete-then-insert", APP, split, bulkDelete)).length,
    0
  );
  const afterUpdate = lines(
    "export async function g(db) {",
    "  await db.delete(t).where(x);",
    "  await db.update(t).set(y);",
    "}"
  );
  assert.equal(
    (await check("tx-delete-then-insert", APP, afterUpdate, bulkDelete)).length,
    0
  );
});

test("tx-delete-then-insert: skipLayers, exemptions and options.message", async () => {
  const skip = {
    ...bulkDelete,
    options: { ...bulkDelete.options, skipLayers: ["etl"] },
    config: bulk.config,
  };
  assert.equal(
    (await check("tx-delete-then-insert", ETL, refresh, skip)).length,
    0
  );
  assert.equal(
    (
      await check(
        "tx-delete-then-insert",
        "packages/db/src/x.ts",
        refresh,
        bulkDelete
      )
    ).length,
    0
  );
  const worded = {
    ...bulkDelete,
    options: { ...bulkDelete.options, message: "no data loss" },
  };
  assert.deepEqual(
    (await check("tx-delete-then-insert", APP, refresh, worded)).map(
      (v) => v.message
    ),
    ["no data loss"]
  );
});

test("tx-required-multi-write: bulk import paths are relaxed through a layer", async () => {
  const batch = lines(
    "export async function importStuff(db) {",
    "  await db.insert(concepts).values(a).onConflictDoNothing();",
    "  await db.insert(mappings).values(b).onConflictDoNothing();",
    "  await db.insert(interactions).values(c).onConflictDoNothing();",
    "}"
  );
  assert.equal((await multi(ETL, batch, bulk)).length, 0);
  assert.equal((await multi(ADAPTER, batch, bulk)).length, 0);
  assert.equal(
    (await multi("apps/api/import-codes.ts", batch, bulk)).length,
    0
  );
  assert.equal(
    (await multi("apps/api/src/import-codes.ts", batch, bulk)).length,
    1
  );
});

test("tx-required-multi-write: deferDeleteThenInsert leaves that shape to the delete rule", async () => {
  assert.equal((await multi(APP, refresh, bulk)).length, 0);
  assert.equal(
    (
      await multi(APP, refresh, {
        ...bulk,
        options: { ...bulk.options, deferDeleteThenInsert: false },
      })
    ).length,
    1
  );
  const afterUpdate = lines(
    "export async function g(db) {",
    "  await db.delete(t).where(x);",
    "  await db.update(t).set(y);",
    "}"
  );
  assert.equal((await multi(APP, afterUpdate, bulk)).length, 1);
});

test("tx-required-multi-write: bulk variant flags two writes in an app function and keeps the rule id", async () => {
  const text = lines(
    "export async function doTwo(db) {",
    "  await db.update(t).set(a);",
    "  await db.insert(u).values(b);",
    "}"
  );
  const found = await multi(APP, text, bulk);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, "tx-required-multi-write");
  const single = lines(
    "export async function one(db) {",
    "  await db.update(t).set(a);",
    "}"
  );
  assert.equal((await multi(APP, single, bulk)).length, 0);
});

test("tx-required-multi-write: bulk variant does not merge functions and ignores tx writes", async () => {
  const split = lines(
    "export async function a(db) {",
    "  await db.insert(t).values(x);",
    "}",
    "export async function b(db) {",
    "  await db.update(u).set(y);",
    "}"
  );
  assert.equal((await multi(APP, split, bulk)).length, 0);
  const onTx = lines(
    "export async function composite(tx) {",
    "  await tx.delete(t).where(x);",
    "  await tx.insert(t).values(y);",
    "}"
  );
  assert.equal((await multi(APP, onTx, bulk)).length, 0);
});

const MODEL = "services/x/src/models/thing.model.ts";
const SERVICE = "services/x/src/services/demo.service.ts";
const modelSource = lines(
  "export async function createThing(input) {",
  "  const rows = await db.insert(things).values(input).returning();",
  "  return ok(rows[0]);",
  "}",
  "export async function updateThing(id) {",
  "  await db.update(things).set({ id });",
  "}",
  "export async function findThing(id) {",
  "  return ok(await db.select().from(things));",
  "}"
);
const basicOrch = {
  options: {
    writeReceivers: ["db"],
    transactionNames: ["withTransaction"],
    blockStart: "top-level",
  },
  config: {
    layers: {
      models: ["*/**/models/**"],
      services: ["*/**/services/**", "*/**/workers/**"],
    },
  },
};
const strictOrch = {
  options: {
    transactionNames: ["withTransaction", "billingTx", "runInTransaction"],
    blockStart: "nested",
  },
  config: {
    layers: {
      models: ["packages/db/src/models/*.ts"],
      services: [
        "services/**/services/**",
        "services/**/workers/**",
        "services/**/*.service.ts",
      ],
    },
  },
};
const orchestrate = (
  service: string,
  path = SERVICE,
  opts: CheckOptions = basicOrch,
  model = modelSource,
  modelPath = MODEL
) =>
  checkProject(
    "tx-service-orchestration",
    { [modelPath]: model, [path]: service },
    opts
  );

test("tx-service-orchestration: flags a service function calling two distinct mutating model functions", async () => {
  const src = lines(
    "export async function doBoth() {",
    "  await createThing(a);",
    "  await updateThing(b);",
    "}"
  );
  const found = await orchestrate(src);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, "tx-service-orchestration");
  assert.equal(found[0]?.line, 2);
  assert.equal(found[0]?.file, SERVICE);
  assert.match(found[0]?.message ?? "", /createThing, updateThing/);
});

test("tx-service-orchestration: passes inside a transaction helper", async () => {
  const src = lines(
    "export async function doBoth() {",
    "  return withTransaction(async () => {",
    "    await createThing(a);",
    "    await updateThing(b);",
    "  });",
    "}"
  );
  assert.equal((await orchestrate(src)).length, 0);
});

test("tx-service-orchestration: one call, repeated calls to one function and read-only calls pass", async () => {
  assert.equal(
    (
      await orchestrate(
        lines("export async function one() {", "  await createThing(a);", "}")
      )
    ).length,
    0
  );
  const loopy = lines(
    "export async function loopy() {",
    "  await createThing(a);",
    "  await createThing(b);",
    "}"
  );
  assert.equal((await orchestrate(loopy)).length, 0);
  const mixed = lines(
    "export async function mixed() {",
    "  await findThing(a);",
    "  await createThing(b);",
    "}"
  );
  assert.equal((await orchestrate(mixed)).length, 0);
});

test("tx-service-orchestration: calls in separate top-level functions are not merged", async () => {
  const src = lines(
    "export async function a() {",
    "  await createThing(x);",
    "}",
    "export async function b() {",
    "  await updateThing(y);",
    "}"
  );
  assert.equal((await orchestrate(src)).length, 0);
});

test("tx-service-orchestration: a read-only model function is never registered", async () => {
  const src = lines(
    "export async function readTwice() {",
    "  await findThing(a);",
    "  await findThing(b);",
    "}"
  );
  assert.equal((await orchestrate(src)).length, 0);
  const second = lines(
    "export async function pair() {",
    "  await findThing(a);",
    "  await updateThing(b);",
    "}"
  );
  assert.equal((await orchestrate(second)).length, 0);
});

test("tx-service-orchestration: workers are scanned and a saga file can be exempted", async () => {
  const src = lines(
    "export async function runPipeline() {",
    "  await createThing(a);",
    "  await updateThing(b);",
    "}"
  );
  const worker = "services/x/src/workers/pipeline.worker.ts";
  assert.equal((await orchestrate(src, worker)).length, 1);
  const exempt = await orchestrate(src, worker, {
    ...basicOrch,
    settings: { exempt: { files: [worker] } },
  });
  assert.equal(exempt.length, 0);
  assert.equal(
    (await orchestrate(src, "services/x/src/routes/a.ts")).length,
    0
  );
});

test("tx-service-orchestration: a const arrow function is registered as a mutating model function", async () => {
  const model = lines(
    "export const archiveThing = async (id) => {",
    "  await db.delete(things).where(id);",
    "};",
    modelSource
  );
  const src = lines(
    "export async function both() {",
    "  await archiveThing(a);",
    "  await updateThing(b);",
    "}"
  );
  assert.equal((await orchestrate(src, SERVICE, basicOrch, model)).length, 1);
});

test("tx-service-orchestration: writes through an executor parameter register by default", async () => {
  const model = lines(
    "export async function stageThing(id, executor = db) {",
    "  await executor.insert(things).values({ id });",
    "}",
    modelSource
  );
  const src = lines(
    "export async function both() {",
    "  await stageThing(a);",
    "  await updateThing(b);",
    "}"
  );
  const defaultReceivers = {
    ...basicOrch,
    options: { transactionNames: ["withTransaction"], blockStart: "top-level" },
  };
  assert.equal(
    (await orchestrate(src, SERVICE, defaultReceivers, model)).length,
    1
  );
  assert.equal((await orchestrate(src, SERVICE, basicOrch, model)).length, 0);
});

test("tx-service-orchestration: the strict variant does not merge methods of a service factory", async () => {
  const factory = lines(
    "export function createService() {",
    "  return {",
    "    async first() {",
    "      await createThing(1);",
    "    },",
    "    async second() {",
    "      await updateThing(2);",
    "    },",
    "  };",
    "}"
  );
  const path = "services/x/src/services/factory.service.ts";
  const modelPath = "packages/db/src/models/thing.ts";
  assert.equal(
    (await orchestrate(factory, path, strictOrch, modelSource, modelPath))
      .length,
    0
  );
  const merged = {
    ...strictOrch,
    options: { ...strictOrch.options, blockStart: "top-level" },
  };
  assert.equal(
    (await orchestrate(factory, path, merged, modelSource, modelPath)).length,
    1
  );
});

test("tx-service-orchestration: the strict variant accepts a run-in-transaction wrapper", async () => {
  const src = lines(
    "export async function both() {",
    "  await runInTransaction(async (tx) => {",
    "    await createThing(1, tx);",
    "    await updateThing(2, tx);",
    "  });",
    "}"
  );
  const path = "services/x/src/services/demo.service.ts";
  const modelPath = "packages/db/src/models/thing.ts";
  assert.equal(
    (await orchestrate(src, path, strictOrch, modelSource, modelPath)).length,
    0
  );
  assert.equal(
    (await orchestrate(src, path, basicOrch, modelSource, MODEL)).length,
    1
  );
});

test("tx-service-orchestration: the strict variant's layers pick models by glob and services by name or suffix", async () => {
  const src = lines(
    "export async function both() {",
    "  await createThing(a);",
    "  await updateThing(b);",
    "}"
  );
  const modelPath = "packages/db/src/models/thing.ts";
  const run = (path: string) =>
    orchestrate(src, path, strictOrch, modelSource, modelPath);
  assert.equal((await run("services/x/src/billing.service.ts")).length, 1);
  assert.equal((await run("services/x/src/workers/job.ts")).length, 1);
  assert.equal((await run("services/x/src/routes/a.ts")).length, 0);
  assert.equal((await run("apps/web/src/services/a.ts")).length, 0);
  const nested = await orchestrate(
    modelSource,
    "packages/db/src/models/deep/x.ts",
    strictOrch,
    modelSource,
    modelPath
  );
  assert.equal(nested.length, 0);
});

test("tx-service-orchestration: without both layers defined the rule reports nothing", async () => {
  const src = lines(
    "export async function doBoth() {",
    "  await createThing(a);",
    "  await updateThing(b);",
    "}"
  );
  assert.equal(
    (await orchestrate(src, SERVICE, { options: {}, config: {} })).length,
    0
  );
  const onlyModels = {
    options: {},
    config: { layers: { models: ["*/**/models/**"] } },
  };
  assert.equal((await orchestrate(src, SERVICE, onlyModels)).length, 0);
});

test("tx-service-orchestration: layer names are options and options.message applies", async () => {
  const src = lines(
    "export async function doBoth() {",
    "  await createThing(a);",
    "  await updateThing(b);",
    "}"
  );
  const renamed = {
    options: {
      modelsLayer: "data",
      servicesLayer: "logic",
      writeReceivers: ["db"],
      message: "compose them",
    },
    config: {
      layers: { data: ["*/**/models/**"], logic: ["*/**/services/**"] },
    },
  };
  const found = await orchestrate(src, SERVICE, renamed);
  assert.deepEqual(
    found.map((v) => v.message),
    ["compose them"]
  );
});

test("tx-service-orchestration: comment lines do not register a model function or count as a call", async () => {
  const model = lines(
    "export async function noteThing() {",
    "  // await db.insert(things).values(1);",
    "}",
    modelSource
  );
  const src = lines(
    "export async function both() {",
    "  // await noteThing(a);",
    "  await noteThing(a);",
    "  await findThing(b);",
    "}"
  );
  assert.equal((await orchestrate(src, SERVICE, basicOrch, model)).length, 0);
  const commented = lines(
    "export async function c() {",
    "  // await createThing(a);",
    "  await updateThing(b);",
    "}"
  );
  assert.equal((await orchestrate(commented)).length, 0);
});

// Variant cases: the same inputs run through the options each rule variant needs.

test("no-db-outside-models: the module name variant uses the route message for re-exports too", async () => {
  const route = "app/api/a/route.ts";
  assert.match(
    (await dbModule(route, 'export * from "@/lib/db";'))[0]?.message ?? "",
    /Routes/
  );
  assert.match(
    (await dbModule(route, 'export { eq } from "drizzle-orm";'))[0]?.message ??
      "",
    /Routes/
  );
  assert.doesNotMatch(
    (await dbModule("lib/x.ts", 'export { eq } from "drizzle-orm";'))[0]
      ?.message ?? "",
    /Routes/
  );
});

interface TxCase {
  name: string;
  text: string;
  lines: number[];
}

const txCases: TxCase[] = [
  { name: "two inserts", text: twoInserts, lines: [2] },
  {
    name: "writes inside a transaction helper",
    text: lines(
      "export async function doThing() {",
      "  const r = await withTransaction(async (tx) => {",
      "    await tx.insert(tokens).values(a);",
      "    await tx.insert(auditLog).values(b);",
      "  });",
      "  return toServiceResult(r);",
      "}"
    ),
    lines: [],
  },
  {
    name: "writes inside an inline transaction",
    text: lines(
      "export async function doThing() {",
      "  await db.transaction(async (tx) => {",
      "    await tx.update(grants).set(x);",
      "    await tx.insert(auditLog).values(b);",
      "  });",
      "}"
    ),
    lines: [],
  },
  {
    name: "single write",
    text: lines(
      "export async function createOne() {",
      "  await db.insert(tokens).values(a);",
      "}"
    ),
    lines: [],
  },
  {
    name: "writes in separate functions",
    text: lines(
      "export async function createOne() {",
      "  await db.insert(tokens).values(a);",
      "}",
      "export async function updateOne() {",
      "  await db.update(tokens).set(a);",
      "}"
    ),
    lines: [],
  },
  {
    name: "update then delete",
    text: lines(
      "export async function churn() {",
      "  await db.update(tokens).set(a);",
      "  await db.delete(tokens).where(b);",
      "}"
    ),
    lines: [2],
  },
  {
    name: "writes on the transaction executor",
    text: lines(
      "export async function composite(tx) {",
      "  await tx.insert(tokens).values(a);",
      "  await tx.insert(auditLog).values(b);",
      "}"
    ),
    lines: [],
  },
  {
    name: "commented out write",
    text: lines(
      "export async function doThing() {",
      "  await db.insert(tokens).values(a);",
      "  // await db.insert(auditLog).values(b);",
      "}"
    ),
    lines: [],
  },
];

test("tx-required-multi-write: every case of the basic variant gives the same lines", async () => {
  for (const c of txCases) {
    const found = await multi(MODEL_FILE, c.text);
    assert.deepEqual(
      found.map((v) => v.line),
      c.lines,
      c.name
    );
  }
  assert.equal(
    (await multi("services/identity/src/routes/demo.ts", twoInserts)).length,
    0
  );
  assert.equal((await multi("packages/db/src/demo.ts", twoInserts)).length, 0);
  assert.equal((await multi("apps/web/src/lib/demo.ts", twoInserts)).length, 0);
});

test("tx-required-multi-write: every case of the strict variant gives the same lines", async () => {
  const service = "services/api/src/services/demo.service.ts";
  for (const c of txCases) {
    const found = await multi(service, c.text, strictTx);
    assert.deepEqual(
      found.map((v) => v.line),
      c.lines,
      c.name
    );
  }
  assert.equal(
    (await multi("packages/db/src/demo.ts", twoInserts, strictTx)).length,
    0
  );
  assert.equal(
    (await multi("apps/admin/src/lib/demo.ts", twoInserts, strictTx)).length,
    0
  );
  const route = "services/api/src/routes/demo.ts";
  assert.equal((await multi(route, twoInserts, strictTx)).length, 1);
});

test("tx-required-multi-write: the app-root variant needs no layers and checks every scanned file", async () => {
  const opts = {
    options: { blockStart: "top-level", transactionNames: ["withTransaction"] },
  };
  for (const c of txCases) {
    const found = await multi("lib/db/models/a.ts", c.text, opts);
    assert.deepEqual(
      found.map((v) => v.line),
      c.lines,
      c.name
    );
  }
});

const bulkRun = async (path: string, text: string): Promise<string[]> => {
  const [writes, remove] = await Promise.all([
    check("tx-required-multi-write", path, text, bulk),
    check("tx-delete-then-insert", path, text, bulkDelete),
  ]);
  return [...writes, ...remove].map((v) => `${v.rule}:${v.line}`).sort();
};

test("tx-required-multi-write with tx-delete-then-insert: the bulk import variant reports the combined result", async () => {
  assert.deepEqual(await bulkRun(ADAPTER, refresh), [
    "tx-delete-then-insert:2",
  ]);
  assert.deepEqual(await bulkRun(APP, refresh), ["tx-delete-then-insert:2"]);
  const twoWrites = lines(
    "export async function doTwo(db) {",
    "  await db.update(t).set(a);",
    "  await db.insert(u).values(b);",
    "}"
  );
  assert.deepEqual(await bulkRun(APP, twoWrites), [
    "tx-required-multi-write:2",
  ]);
  assert.deepEqual(await bulkRun(ETL, twoWrites), []);
  const wrapped = lines(
    "export async function refresh(db) {",
    "  await withTransaction(db, async (tx) => {",
    "    await tx.delete(t).where(x);",
    "    await tx.insert(t).values(y);",
    "  });",
    "}"
  );
  assert.deepEqual(await bulkRun(ADAPTER, wrapped), []);
});

const orchCases: { name: string; src: string; lines: number[] }[] = [
  {
    name: "two distinct",
    src: lines(
      "export async function doBoth() {",
      "  await createThing(a);",
      "  await updateThing(b);",
      "}"
    ),
    lines: [2],
  },
  {
    name: "transaction helper",
    src: lines(
      "export async function doBoth() {",
      "  return withTransaction(async () => {",
      "    await createThing(a);",
      "    await updateThing(b);",
      "  });",
      "}"
    ),
    lines: [],
  },
  {
    name: "single call",
    src: lines("export async function one() {", "  await createThing(a);", "}"),
    lines: [],
  },
  {
    name: "same function twice",
    src: lines(
      "export async function loopy() {",
      "  await createThing(a);",
      "  await createThing(b);",
      "}"
    ),
    lines: [],
  },
  {
    name: "separate functions",
    src: lines(
      "export async function a() {",
      "  await createThing(x);",
      "}",
      "export async function b() {",
      "  await updateThing(y);",
      "}"
    ),
    lines: [],
  },
  {
    name: "read only call",
    src: lines(
      "export async function mixed() {",
      "  await findThing(a);",
      "  await createThing(b);",
      "}"
    ),
    lines: [],
  },
];

test("tx-service-orchestration: every case of the basic variant gives the same lines", async () => {
  for (const c of orchCases) {
    assert.deepEqual(
      (await orchestrate(c.src)).map((v) => v.line),
      c.lines,
      c.name
    );
  }
});

test("tx-service-orchestration: every case of the strict variant gives the same lines", async () => {
  const path = "services/x/src/services/demo.service.ts";
  const modelPath = "packages/db/src/models/thing.ts";
  for (const c of orchCases) {
    assert.deepEqual(
      (await orchestrate(c.src, path, strictOrch, modelSource, modelPath)).map(
        (v) => v.line
      ),
      c.lines,
      c.name
    );
  }
  const executorModel = lines(
    "export async function stageThing(id, executor = db) {",
    "  await executor.insert(things).values({ id });",
    "}"
  );
  const staged = lines(
    "export async function both() {",
    "  await stageThing(1);",
    "  await stageThing(2);",
    "  await updateThing(3);",
    "}"
  );
  const found = await orchestrate(
    staged,
    path,
    strictOrch,
    `${executorModel}\n${modelSource}`,
    modelPath
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [2]
  );
});

test("tx-required-multi-write: a catch-all layer checks every file even when the config narrows the backend layer", async () => {
  const opts = {
    options: { blockStart: "top-level", transactionNames: ["withTransaction"] },
    config: { layers: { backend: ["app/api/", "lib/db/"], scanned: ["**"] } },
  };
  assert.equal((await multi("lib/services/a.ts", twoInserts, opts)).length, 0);
  const all = {
    ...opts,
    settings: {
      layer: "scanned",
      exempt: { files: ["lib/db/transaction.ts"] },
    },
  };
  assert.equal((await multi("lib/services/a.ts", twoInserts, all)).length, 1);
  assert.equal(
    (await multi("lib/db/transaction.ts", twoInserts, all)).length,
    0
  );
});
