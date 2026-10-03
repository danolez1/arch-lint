import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigs, resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { canonicalId, findRule } from "../../src/arch/registry";
import { runRules } from "../../src/arch/run";
import { check } from "./helpers";

const count = async (...args: Parameters<typeof check>) =>
  (await check(...args)).length;
const lines = async (...args: Parameters<typeof check>) =>
  (await check(...args)).map((v) => v.line);

const BACKEND = { layers: { backend: ["app/api/", "lib/db/", "lib/server/"] } };

test("registered ids and aliases", () => {
  for (const id of [
    "no-raw-process-env",
    "no-console",
    "no-raw-fetch",
    "no-raw-fetch-in-components",
    "no-axios",
    "no-magic-path",
    "no-relative-cross-package",
    "no-service-in-tsx",
    "no-date-methods",
    "phi-redaction-required",
  ]) {
    assert.equal(findRule(id)?.id, id);
  }
  assert.equal(canonicalId("no-console-log"), "no-console");
});

test("an older id in the config still configures the rule", async () => {
  const config = resolveConfig(
    mergeConfigs(
      {},
      { rules: { "no-console-log": { options: { methods: ["log"] } } } }
    )
  );
  const { violations } = await runRules({
    root: "/v",
    config,
    fs: memoryFileSystem({ "a.ts": "console.log(1);\nconsole.error(2);\n" }),
    only: ["no-console-log"],
  });
  assert.deepEqual(
    violations.map((v) => `${v.rule}:${v.line}`),
    ["no-console-log:1"]
  );
});

test("no-raw-process-env flags member access and skips comments", async () => {
  assert.equal(
    await count("no-raw-process-env", "lib/a.ts", "const x = process.env.FOO;"),
    1
  );
  assert.equal(
    await count("no-raw-process-env", "lib/a.ts", "// process.env.FOO"),
    0
  );
});

test("no-raw-process-env flags bare and bracket access by default", async () => {
  assert.equal(
    await count("no-raw-process-env", "a.ts", "const env = process.env;"),
    1
  );
  assert.equal(
    await count("no-raw-process-env", "a.ts", 'const v = process.env["FOO"];'),
    1
  );
});

test("no-raw-process-env memberAccessOnly ignores a bare reference", async () => {
  const options = { memberAccessOnly: true };
  assert.equal(
    await count("no-raw-process-env", "a.ts", "const env = process.env;", {
      options,
    }),
    0
  );
  assert.equal(
    await count("no-raw-process-env", "a.ts", "const v = process.env.FOO;", {
      options,
    }),
    1
  );
  assert.equal(
    await count("no-raw-process-env", "a.ts", 'const v = process.env["FOO"];', {
      options,
    }),
    1
  );
});

test("no-raw-process-env limited to a layer with env schema files exempt by layer", async () => {
  const opts = {
    options: { memberAccessOnly: true, exemptLayers: ["env"] },
    settings: { layer: "backend" },
    config: {
      layers: {
        backend: ["services/", "packages/"],
        env: ["*/**/env.ts", "packages/env/src/"],
      },
    },
  };
  const text = "const v = process.env.FOO;";
  assert.equal(
    await count("no-raw-process-env", "services/api/src/x.ts", text, opts),
    1
  );
  assert.equal(
    await count("no-raw-process-env", "services/api/src/env.ts", text, opts),
    0
  );
  assert.equal(
    await count("no-raw-process-env", "packages/env/src/schema.ts", text, opts),
    0
  );
  assert.equal(
    await count("no-raw-process-env", "apps/admin/src/x.ts", text, opts),
    0
  );
});

test("no-raw-process-env exemptLayers naming an undefined layer exempts nothing", async () => {
  const options = { exemptLayers: ["env"] };
  assert.equal(
    await count("no-raw-process-env", "lib/a.ts", "process.env.A", { options }),
    1
  );
});

test("no-raw-process-env exempt files from the config", async () => {
  const settings = { exempt: { files: ["lib/env.ts"] } };
  assert.equal(
    await count("no-raw-process-env", "lib/env.ts", "process.env.A", {
      settings,
    }),
    0
  );
  assert.equal(
    await count("no-raw-process-env", "lib/other.ts", "process.env.A", {
      settings,
    }),
    1
  );
});

const consoleSides = {
  config: BACKEND,
  options: {
    methods: ["log", "warn", "info", "debug"],
    layerMethods: { backend: ["log", "warn", "error", "info", "debug"] },
  },
};

test("no-console per layer method lists differ by side", async () => {
  assert.equal(
    await count(
      "no-console",
      "app/api/a/route.ts",
      "console.error(e)",
      consoleSides
    ),
    1
  );
  assert.equal(
    await count(
      "no-console",
      "components/a.tsx",
      "console.error(e)",
      consoleSides
    ),
    0
  );
  assert.equal(
    await count(
      "no-console",
      "components/a.tsx",
      "console.log(e)",
      consoleSides
    ),
    1
  );
});

test("no-console default list covers log, warn, error, info and debug everywhere", async () => {
  for (const method of ["log", "warn", "error", "info", "debug"]) {
    assert.equal(
      await count("no-console", "a.ts", `console.${method}("x");`),
      1,
      method
    );
  }
  assert.equal(await count("no-console", "a.ts", 'console.trace("x");'), 0);
  assert.equal(await count("no-console", "a.ts", "// console.log(1)"), 0);
  assert.equal(
    await count("no-console", "a.ts", "const consoleLog = 1; logger.log(1);"),
    0
  );
});

test("no-console methods option narrows to log, warn and error", async () => {
  const options = { methods: ["log", "warn", "error"] };
  const text = [
    "console.log(1)",
    "console.warn(2)",
    "console.error(3)",
    "console.info(4)",
    "console.debug(5)",
  ].join("\n");
  assert.deepEqual(
    await lines("no-console", "a.ts", text, { options }),
    [1, 2, 3]
  );
});

test("no-console limited to a layer and exempt files", async () => {
  const opts = {
    config: { layers: { backend: ["services/", "packages/"] } },
    settings: { layer: "backend", exempt: { dirs: ["packages/browser/src/"] } },
  };
  assert.equal(
    await count("no-console", "services/api/src/x.ts", "console.info(1)", opts),
    1
  );
  assert.equal(
    await count(
      "no-console",
      "packages/browser/src/x.ts",
      "console.info(1)",
      opts
    ),
    0
  );
  assert.equal(
    await count("no-console", "apps/web/src/x.ts", "console.info(1)", opts),
    0
  );
});

test("no-console layerMethods uses the first matching layer and ignores undefined layers", async () => {
  const opts = {
    config: { layers: { tools: ["tools/"], backend: ["tools/", "services/"] } },
    options: {
      methods: ["log"],
      layerMethods: { missing: ["error"], tools: ["debug"], backend: ["warn"] },
    },
  };
  assert.equal(
    await count("no-console", "tools/a.ts", "console.debug(1)", opts),
    1
  );
  assert.equal(
    await count("no-console", "tools/a.ts", "console.warn(1)", opts),
    0
  );
  assert.equal(
    await count("no-console", "services/a.ts", "console.warn(1)", opts),
    1
  );
  assert.equal(
    await count("no-console", "other/a.ts", "console.log(1)", opts),
    1
  );
  assert.equal(
    await count("no-console", "other/a.ts", "console.error(1)", opts),
    0
  );
});

test("no-console empty method list reports nothing and message option is used", async () => {
  assert.equal(
    await count("no-console", "a.ts", "console.log(1)", {
      options: { methods: [] },
    }),
    0
  );
  const [found] = await check("no-console", "a.ts", "console.log(1)", {
    options: { message: "custom" },
  });
  assert.equal(found?.message, "custom");
});

test("no-raw-fetch flags global fetch calls", async () => {
  assert.equal(await count("no-raw-fetch", "lib/a.ts", "await fetch(url)"), 1);
  assert.equal(
    await count("no-raw-fetch", "service.ts", "await globalThis.fetch(url)"),
    1
  );
  assert.equal(
    await count("no-raw-fetch", "service.ts", "await window.fetch(url)"),
    1
  );
  assert.equal(
    await count("no-raw-fetch", "service.ts", "await global.fetch(url)"),
    1
  );
  assert.equal(
    await count("no-raw-fetch", "service.ts", "await self.fetch(url)"),
    1
  );
});

test("no-raw-fetch allows method calls that happen to be named fetch", async () => {
  assert.equal(
    await count("no-raw-fetch", "lib/a.ts", "await route.fetch()"),
    0
  );
  assert.equal(
    await count("no-raw-fetch", "client.ts", "await apiClient.fetch(request)"),
    0
  );
  assert.equal(
    await count(
      "no-raw-fetch",
      "client.ts",
      "await apiClient.global.fetch(request)"
    ),
    0
  );
});

test("no-raw-fetch skips import lines and comments", async () => {
  assert.equal(
    await count("no-raw-fetch", "a.ts", 'import { fetch } from "undici";'),
    0
  );
  assert.equal(await count("no-raw-fetch", "a.ts", "// await fetch(url)"), 0);
});

test("no-raw-fetch covers tsx files by default", async () => {
  assert.equal(await count("no-raw-fetch", "a.tsx", "await fetch(url)"), 1);
});

test("no-raw-fetch scope non-tsx leaves components to their own rule", async () => {
  const options = { scope: "non-tsx" };
  assert.equal(
    await count("no-raw-fetch", "a.tsx", "await fetch(url)", { options }),
    0
  );
  assert.equal(
    await count("no-raw-fetch", "a.ts", "await fetch(url)", { options }),
    1
  );
});

test("no-raw-fetch scope tsx covers only components", async () => {
  const options = { scope: "tsx" };
  assert.equal(
    await count("no-raw-fetch", "a.tsx", "await fetch(url)", { options }),
    1
  );
  assert.equal(
    await count("no-raw-fetch", "a.ts", "await fetch(url)", { options }),
    0
  );
});

test("no-raw-fetch-in-components flags fetch in tsx but not method calls named fetch", async () => {
  assert.equal(
    await count(
      "no-raw-fetch-in-components",
      "apps/admin/src/a.tsx",
      "await fetch(url)"
    ),
    1
  );
  assert.equal(
    await count(
      "no-raw-fetch-in-components",
      "apps/admin/src/a.tsx",
      "await route.fetch()"
    ),
    0
  );
  assert.equal(
    await count(
      "no-raw-fetch-in-components",
      "apps/admin/src/a.ts",
      "await fetch(url)"
    ),
    0
  );
});

test("no-raw-fetch-in-components skips imports and comments, and has its own exemptions", async () => {
  const text = 'import fetchy from "x";\n// fetch(a)\nawait fetch(b)';
  assert.deepEqual(
    await lines("no-raw-fetch-in-components", "a.tsx", text),
    [3]
  );
  const settings = { exempt: { dirs: ["apps/web/src/components/landing/"] } };
  assert.equal(
    await count(
      "no-raw-fetch-in-components",
      "apps/web/src/components/landing/v.tsx",
      "fetch(a)",
      { settings }
    ),
    0
  );
});

test("no-axios flags a default import", async () => {
  assert.equal(
    await count("no-axios", "lib/a.ts", 'import axios from "axios";'),
    1
  );
});

test("no-axios flags from and require forms, not other packages", async () => {
  assert.equal(
    await count("no-axios", "a.ts", 'import { get } from "axios";'),
    1
  );
  assert.equal(
    await count("no-axios", "a.ts", "import {\n  get,\n} from 'axios';"),
    1
  );
  assert.equal(
    await count("no-axios", "a.ts", 'const axios = require("axios");'),
    1
  );
  assert.equal(
    await count("no-axios", "a.ts", "const axios = require( 'axios' );"),
    1
  );
  assert.equal(
    await count("no-axios", "a.ts", 'const m = await import("axios");'),
    1
  );
  assert.equal(
    await count("no-axios", "a.ts", 'import x from "axios-retry";'),
    0
  );
  assert.equal(
    await count("no-axios", "a.ts", '// import axios from "axios";'),
    0
  );
  assert.equal(await count("no-axios", "a.ts", 'const s = "axios";'), 0);
});

test("no-axios flags type imports unless allowTypeImports is set", async () => {
  const text = 'import type { AxiosError } from "axios";';
  assert.equal(await count("no-axios", "a.ts", text), 1);
  assert.equal(
    await count("no-axios", "a.ts", text, {
      options: { allowTypeImports: true },
    }),
    0
  );
  const inline = 'import { type AxiosError } from "axios";';
  assert.equal(
    await count("no-axios", "a.ts", inline, {
      options: { allowTypeImports: true },
    }),
    0
  );
  const value = 'import { AxiosError } from "axios";';
  assert.equal(
    await count("no-axios", "a.ts", value, {
      options: { allowTypeImports: true },
    }),
    1
  );
});

test("no-axios exempt files from the config", async () => {
  const settings = { exempt: { files: ["lib/api-client.ts"] } };
  assert.equal(
    await count("no-axios", "lib/api-client.ts", 'import axios from "axios";', {
      settings,
    }),
    0
  );
});

const clientNames = {
  options: { clients: ["apiClient", "externalApiClient"] },
};

test("no-magic-path flags literal routes", async () => {
  assert.equal(
    await count("no-magic-path", "components/a.tsx", '<Link href="/courses">'),
    1
  );
  assert.equal(
    await count("no-magic-path", "components/a.tsx", 'router.push("/login")'),
    1
  );
  assert.equal(
    await count("no-magic-path", "lib/a.ts", 'apiClient.get("/api/x")'),
    1
  );
});

test("no-magic-path allows imported paths and external urls", async () => {
  assert.equal(
    await count(
      "no-magic-path",
      "components/a.tsx",
      "<Link href={paths.courses}>"
    ),
    0
  );
  assert.equal(
    await count(
      "no-magic-path",
      "components/a.tsx",
      '<a href="https://x.dev">'
    ),
    0
  );
});

test("no-magic-path covers the other navigation calls", async () => {
  assert.equal(await count("no-magic-path", "a.ts", 'Router.replace("/a")'), 1);
  assert.equal(
    await count("no-magic-path", "a.ts", "router.prefetch(`/a`)"),
    1
  );
  assert.equal(await count("no-magic-path", "a.ts", 'redirect("/a")'), 1);
  assert.equal(
    await count("no-magic-path", "a.ts", "permanentRedirect('/a')"),
    1
  );
  assert.equal(await count("no-magic-path", "a.tsx", "<a href={`/a`}>"), 1);
  assert.equal(
    await count("no-magic-path", "a.ts", "router.push(paths.home)"),
    0
  );
});

test("no-magic-path clients option names the client objects checked", async () => {
  const text = 'externalApiClient.post("/x")';
  assert.equal(await count("no-magic-path", "a.ts", text), 0);
  assert.equal(await count("no-magic-path", "a.ts", text, clientNames), 1);
  assert.equal(
    await count("no-magic-path", "a.ts", 'apiClient.get("/x")', {
      options: { clients: [] },
    }),
    0
  );
  assert.equal(
    await count("no-magic-path", "a.ts", 'http.get("/x")', {
      options: { clients: ["http"] },
    }),
    1
  );
});

test("no-relative-cross-package flags sibling workspace imports", async () => {
  assert.equal(
    await count(
      "no-relative-cross-package",
      "tools/tool-a/audit.ts",
      'import { audit } from "../tool-b/src/lib/audit";'
    ),
    1
  );
});

test("no-relative-cross-package flags relative imports into another workspace root", async () => {
  assert.equal(
    await count(
      "no-relative-cross-package",
      "packages/sdk/src/client.ts",
      'import { handler } from "../../../services/api/src/handler";'
    ),
    1
  );
});

test("no-relative-cross-package allows relative imports inside one workspace", async () => {
  assert.equal(
    await count(
      "no-relative-cross-package",
      "tools/tool-a/src/audit.ts",
      'import { policy } from "../policy";'
    ),
    0
  );
  assert.equal(
    await count(
      "no-relative-cross-package",
      "services/api/src/a/b.ts",
      'import { policy } from "../policy";'
    ),
    0
  );
});

test("no-relative-cross-package ignores files and targets outside the workspace roots", async () => {
  const text = 'import { a } from "../../b/src/a";';
  assert.equal(await count("no-relative-cross-package", "src/a/x.ts", text), 0);
  assert.equal(
    await count(
      "no-relative-cross-package",
      "packages/a/x.ts",
      'import { a } from "../../../outside/a";'
    ),
    0
  );
  assert.equal(
    await count(
      "no-relative-cross-package",
      "packages/a/x.ts",
      '// import { a } from "../b/y";'
    ),
    0
  );
});

test("no-relative-cross-package workspaceRoots option changes which roots count", async () => {
  const text = 'import { a } from "../../../plugins/b/src/a";';
  assert.equal(
    await count("no-relative-cross-package", "packages/a/src/x.ts", text),
    1
  );
  const options = { workspaceRoots: ["apps", "packages", "services", "tools"] };
  assert.equal(
    await count("no-relative-cross-package", "packages/a/src/x.ts", text, {
      options,
    }),
    0
  );
  assert.equal(
    await count("no-relative-cross-package", "plugins/a/src/x.ts", text, {
      options,
    }),
    0
  );
});

test("no-service-in-tsx stops components importing a service", async () => {
  const text = 'import { getCourses } from "@/lib/services/courses";';
  assert.equal(await count("no-service-in-tsx", "components/a.tsx", text), 1);
  assert.equal(await count("no-service-in-tsx", "store/a.ts", text), 0);
});

test("no-service-in-tsx allows a server component to import a server service", async () => {
  const text = 'import { getPage } from "@/lib/server/services/x";';
  assert.equal(
    await count("no-service-in-tsx", "app/admin/x/page.tsx", text),
    0
  );
});

test("no-service-in-tsx binds client components to server services too", async () => {
  assert.equal(
    await count(
      "no-service-in-tsx",
      "components/a.tsx",
      '"use client";\nimport { getPage } from "@/lib/server/services/x";'
    ),
    1
  );
  assert.equal(
    await count(
      "no-service-in-tsx",
      "components/b.tsx",
      '/** header */\n// note\n"use client";\nimport { getPage } from "@/lib/server/services/x";'
    ),
    1
  );
});

test("no-service-in-tsx allows type-only imports", async () => {
  assert.equal(
    await count(
      "no-service-in-tsx",
      "components/a.tsx",
      'import type { X } from "@/lib/services/a";'
    ),
    0
  );
  assert.equal(
    await count(
      "no-service-in-tsx",
      "components/a.tsx",
      'import { type X } from "@/lib/services/a";'
    ),
    0
  );
});

test("no-service-in-tsx prefix match respects segment boundaries", async () => {
  assert.equal(
    await count(
      "no-service-in-tsx",
      "a.tsx",
      'import { x } from "@/lib/services";'
    ),
    1
  );
  assert.equal(
    await count(
      "no-service-in-tsx",
      "a.tsx",
      'import { x } from "@/lib/services-extra/a";'
    ),
    0
  );
});

test("no-service-in-tsx servicePaths and clientOnlyServicePaths options", async () => {
  const options = {
    servicePaths: ["@app/services"],
    clientOnlyServicePaths: ["@app/server"],
  };
  assert.equal(
    await count(
      "no-service-in-tsx",
      "a.tsx",
      'import { x } from "@/lib/services/a";',
      { options }
    ),
    0
  );
  assert.equal(
    await count(
      "no-service-in-tsx",
      "a.tsx",
      'import { x } from "@app/services/a";',
      { options }
    ),
    1
  );
  assert.equal(
    await count(
      "no-service-in-tsx",
      "a.tsx",
      'import { x } from "@app/server/a";',
      { options }
    ),
    0
  );
  assert.equal(
    await count(
      "no-service-in-tsx",
      "a.tsx",
      '"use client";\nimport { x } from "@app/server/a";',
      { options }
    ),
    1
  );
});

test("no-date-methods strict variant flags date calls and arithmetic", async () => {
  assert.equal(
    await count("no-date-methods", "lib/a.ts", "d.toLocaleDateString()"),
    1
  );
  assert.equal(
    await count("no-date-methods", "lib/a.ts", "createdAt.toLocaleString()"),
    1
  );
  assert.equal(
    await count("no-date-methods", "lib/a.ts", "amount.toLocaleString()"),
    0
  );
  assert.equal(
    await count("no-date-methods", "lib/a.ts", "const ms = 5 * 60 * 1000;"),
    1
  );
  assert.equal(
    await count("no-date-methods", "lib/a.ts", "const day = d.getDate();"),
    1
  );
  assert.equal(
    await count("no-date-methods", "lib/a.ts", "format(d, 'yyyy')"),
    0
  );
});

test("no-date-methods strict variant also flags setters, iso split and getTime", async () => {
  assert.equal(await count("no-date-methods", "a.ts", "d.setHours(0);"), 1);
  assert.equal(await count("no-date-methods", "a.ts", "d.setUTCDate(1);"), 1);
  assert.equal(
    await count("no-date-methods", "a.ts", "d.toISOString().split('T')[0];"),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "const t = new Date(x).getTime();"),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "const t = 1000 * 60 * 60;"),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "const t = n * 1000 * 60;"),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "const t = Date.now();"),
    0
  );
  assert.equal(await count("no-date-methods", "a.ts", "// d.getDate()"), 0);
});

test("no-date-methods strict variant matches date, time and at receivers for toLocaleString", async () => {
  assert.equal(
    await count("no-date-methods", "a.ts", "startTime.toLocaleString()"),
    1
  );
  assert.equal(
    await count(
      "no-date-methods",
      "a.ts",
      "row.updatedAt.toLocaleString('en')"
    ),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "price.toLocaleString('en')"),
    0
  );
});

test("no-date-methods basic variant flags toLocale methods and the get family only", async () => {
  const options = { variant: "basic" };
  assert.equal(
    await count("no-date-methods", "a.ts", "amount.toLocaleString()", {
      options,
    }),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "d.toLocaleDateString()", {
      options,
    }),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "d.toLocaleTimeString()", {
      options,
    }),
    1
  );
  for (const getter of [
    "getMonth",
    "getFullYear",
    "getDate",
    "getDay",
    "getHours",
    "getMinutes",
    "getSeconds",
  ]) {
    assert.equal(
      await count("no-date-methods", "a.ts", `d.${getter}()`, { options }),
      1,
      getter
    );
    assert.equal(
      await count(
        "no-date-methods",
        "a.ts",
        `d.${getter.replace("get", "getUTC")}()`,
        { options }
      ),
      1,
      getter
    );
  }
  assert.equal(
    await count("no-date-methods", "a.ts", "d.setHours(0);", { options }),
    0
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "d.toISOString().split('T')", {
      options,
    }),
    0
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "new Date(x).getTime()", {
      options,
    }),
    0
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "const ms = 5 * 60 * 1000;", {
      options,
    }),
    0
  );
});

test("no-date-methods checks option picks individual checks and replaces the variant", async () => {
  const options = { variant: "basic", checks: ["setters", "ms-arithmetic"] };
  assert.equal(
    await count("no-date-methods", "a.ts", "d.getDate()", { options }),
    0
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "d.setMonth(1)", { options }),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "5 * 60 * 1000", { options }),
    1
  );
  assert.equal(
    await count("no-date-methods", "a.ts", "d.setMonth(1)", {
      options: { checks: [] },
    }),
    0
  );
});

test("no-date-methods rejects an unknown variant or check", async () => {
  await assert.rejects(
    () =>
      check("no-date-methods", "a.ts", "x", { options: { variant: "loose" } }),
    /unknown variant/
  );
  await assert.rejects(
    () =>
      check("no-date-methods", "a.ts", "x", { options: { checks: ["nope"] } }),
    /unknown check/
  );
});

test("no-date-methods exempt files from the config", async () => {
  const settings = { exempt: { files: ["apps/admin/billing.tsx"] } };
  assert.equal(
    await count(
      "no-date-methods",
      "apps/admin/billing.tsx",
      "n.toLocaleString()",
      { settings, options: { variant: "basic" } }
    ),
    0
  );
});

const clinical = { config: { layers: { clinical: ["services/", "apps/"] } } };

test("phi-redaction-required flags every console method including trace in the clinical layer", async () => {
  for (const method of ["log", "warn", "error", "info", "debug", "trace"]) {
    assert.equal(
      await count(
        "phi-redaction-required",
        "services/api/src/x.ts",
        `console.${method}("p");`,
        clinical
      ),
      1,
      method
    );
  }
});

test("phi-redaction-required skips other layers, test files and comments", async () => {
  assert.equal(
    await count(
      "phi-redaction-required",
      "packages/db/src/x.ts",
      "console.log(1)",
      clinical
    ),
    0
  );
  assert.equal(
    await count(
      "phi-redaction-required",
      "services/api/src/x.test.ts",
      "console.log(1)",
      clinical
    ),
    0
  );
  assert.equal(
    await count(
      "phi-redaction-required",
      "services/api/tests/x.ts",
      "console.log(1)",
      clinical
    ),
    0
  );
  assert.equal(
    await count(
      "phi-redaction-required",
      "services/api/src/x.ts",
      "// console.log(1)",
      clinical
    ),
    0
  );
});

test("phi-redaction-required covers all files when no clinical layer is configured", async () => {
  assert.equal(
    await count("phi-redaction-required", "lib/a.ts", "console.log(1)"),
    1
  );
});

test("phi-redaction-required methods option and exempt files", async () => {
  const opts = {
    ...clinical,
    options: { methods: ["log"] },
    settings: { exempt: { files: ["apps/docs/page.tsx"] } },
  };
  assert.equal(
    await count(
      "phi-redaction-required",
      "services/a.ts",
      "console.error(1)",
      opts
    ),
    0
  );
  assert.equal(
    await count(
      "phi-redaction-required",
      "services/a.ts",
      "console.log(1)",
      opts
    ),
    1
  );
  assert.equal(
    await count(
      "phi-redaction-required",
      "apps/docs/page.tsx",
      "console.log(1)",
      opts
    ),
    0
  );
});

test("looseMatch restores the unbounded console, process.env and throw patterns", async () => {
  const text = "myconsole.log(1);\nconst v = myprocess.env.A;\n";
  const strict = await check("no-console", "src/a.ts", text);
  assert.equal(strict.length, 0);
  const loose = await check("no-console", "src/a.ts", text, {
    options: { looseMatch: true },
  });
  assert.deepEqual(
    loose.map((v) => v.line),
    [1]
  );
  assert.equal((await check("no-raw-process-env", "src/a.ts", text)).length, 0);
  const env = await check("no-raw-process-env", "src/a.ts", text, {
    options: { looseMatch: true },
  });
  assert.deepEqual(
    env.map((v) => v.line),
    [2]
  );
});

test("no-axios forms limit which import styles are reported", async () => {
  const text = [
    'import a from "axios";',
    'export { x } from "axios";',
    'const b = await import("axios");',
    'const c = require("axios");',
  ].join("\n");
  const all = await check("no-axios", "src/a.ts", text);
  assert.deepEqual(
    all.map((v) => v.line),
    [1, 2, 3, 4]
  );
  const legacy = await check("no-axios", "src/a.ts", text, {
    options: { forms: ["import", "export-from", "require"] },
  });
  assert.deepEqual(
    legacy.map((v) => v.line),
    [1, 2, 4]
  );
});

test("no-axios multiLineAt picks the import line or the from line", async () => {
  const text = 'import {\n  a,\n  b,\n} from "axios";\n';
  const atImport = await check("no-axios", "src/a.ts", text);
  assert.deepEqual(
    atImport.map((v) => v.line),
    [1]
  );
  const atFrom = await check("no-axios", "src/a.ts", text, {
    options: { multiLineAt: "from" },
  });
  assert.deepEqual(
    atFrom.map((v) => v.line),
    [4]
  );
});
