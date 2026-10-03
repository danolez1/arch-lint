import assert from "node:assert/strict";
import test from "node:test";
import { check, checkProject, type CheckOptions } from "./helpers";

const IDS = [
  "no-dash",
  "no-ui-toolkit",
  "no-feature-import",
  "no-store-in-features",
  "no-hardcoded-origin",
];

async function all(path: string, text: string, opts: CheckOptions = {}) {
  const found = [];
  for (const id of IDS) found.push(...(await check(id, path, text, opts)));
  return found.sort((a, b) => a.line - b.line);
}

async function ruleIds(path: string, text: string, opts: CheckOptions = {}) {
  return (await all(path, text, opts)).map((v) => v.rule);
}

const withPackage: CheckOptions = { options: { packageName: "demo" } };

test("rejects a Material import in a repository", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/repositories/course_repository.dart",
      "import 'package:flutter/material.dart';"
    ),
    ["no-ui-toolkit"]
  );
});

test("allows foundation and widgets in the sync layer", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/sync/sync_manager.dart",
      "import 'package:flutter/foundation.dart';\nimport 'package:flutter/widgets.dart';"
    ),
    []
  );
});

test("rejects a repository importing a feature by package path", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/repositories/quiz_repository.dart",
      "import 'package:demo/features/study/quiz/quiz_list.dart';",
      withPackage
    ),
    ["no-feature-import"]
  );
});

test("rejects a relative import that climbs into features", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/domain/quiz/quiz_session.dart",
      "import '../../features/study/quiz/quiz_list.dart';"
    ),
    ["no-feature-import"]
  );
});

test("does not treat a sibling folder named like a layer as that layer", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/domain/quiz/quiz_session.dart",
      "import 'quiz_grading.dart';"
    ),
    []
  );
});

test("rejects direct store access from a screen", async () => {
  const found = await all(
    "lib/features/courses/course_list.dart",
    "import '../../objectbox.g.dart';\nfinal c = store.box<Course>().getAll();"
  );
  assert.deepEqual(
    found.map((v) => v.rule),
    ["no-store-in-features", "no-store-in-features"]
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 2]
  );
});

test("rejects an origin outside the env helper and allows store links", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/data/api_client.dart",
      "const u = 'https://example.com/api';"
    ),
    ["no-hardcoded-origin"]
  );
  assert.deepEqual(
    await ruleIds(
      "lib/core/min_version.dart",
      "return 'https://play.google.com/store/apps/details?id=$pkg';"
    ),
    []
  );
  const env = "defaultValue: 'http://localhost:3000',";
  const exempt: CheckOptions = {
    settings: { exempt: { files: ["lib/core/env.dart"] } },
  };
  assert.deepEqual(await ruleIds("lib/core/env.dart", env, exempt), []);
  assert.deepEqual(await ruleIds("lib/core/env.dart", env), [
    "no-hardcoded-origin",
  ]);
});

test("ignores origins cited in comments", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/data/api_client.dart",
      "// see https://docs.example.com/x"
    ),
    []
  );
});

test("rejects em and en dashes", async () => {
  assert.deepEqual(await ruleIds("lib/app/router.dart", "// a \u2014 b"), [
    "no-dash",
  ]);
  assert.deepEqual(await ruleIds("lib/app/router.dart", "// 1\u20132"), [
    "no-dash",
  ]);
});

test("reports the origin text and the line number", async () => {
  const [v] = await check(
    "no-hardcoded-origin",
    "lib/data/a.dart",
    "var a = 1;\nconst u = 'http://10.0.0.1:8080/x';"
  );
  assert.equal(v?.line, 2);
  assert.equal(v?.file, "lib/data/a.dart");
  assert.match(
    v?.message ?? "",
    /^http:\/\/10\.0\.0\.1:8080 belongs in the environment config helper$/
  );
});

test("root option limits the scan and keeps project paths in violations", async () => {
  const files = {
    "mobile/lib/domain/q/a.dart":
      "import '../../features/x.dart';\nimport 'package:flutter/material.dart';",
    "other/lib/domain/b.dart": "import 'package:flutter/material.dart';",
    "lib/domain/c.dart": "import 'package:flutter/material.dart';",
  };
  const opts: CheckOptions = { options: { root: "mobile" } };
  const toolkit = await checkProject("no-ui-toolkit", files, opts);
  assert.deepEqual(
    toolkit.map((v) => `${v.file}:${v.line}`),
    ["mobile/lib/domain/q/a.dart:2"]
  );
  const feature = await checkProject("no-feature-import", files, opts);
  assert.deepEqual(
    feature.map((v) => `${v.file}:${v.line}`),
    ["mobile/lib/domain/q/a.dart:1"]
  );
  const everything = await checkProject("no-ui-toolkit", files);
  assert.deepEqual(
    everything.map((v) => v.file),
    ["lib/domain/c.dart"]
  );
});

test("root with a trailing slash behaves the same", async () => {
  const files = { "mobile/lib/a.dart": "// a \u2014 b" };
  assert.equal(
    (await checkProject("no-dash", files, { options: { root: "mobile/" } }))
      .length,
    1
  );
  assert.equal(
    (await checkProject("no-dash", files, { options: { root: "web" } })).length,
    0
  );
});

test("sourceDirs defaults to lib and can be widened", async () => {
  const files = {
    "test/a_test.dart": "// a \u2014 b",
    "lib/a.dart": "// a \u2014 b",
    "tool/t.dart": "// a \u2014 b",
  };
  const byDefault = await checkProject("no-dash", files);
  assert.deepEqual(
    byDefault.map((v) => v.file),
    ["lib/a.dart"]
  );
  const wide = await checkProject("no-dash", files, {
    options: { sourceDirs: ["lib/", "tool/"] },
  });
  assert.deepEqual(
    wide.map((v) => v.file),
    ["lib/a.dart", "tool/t.dart"]
  );
});

test("generated .g.dart files are skipped by default and skipSuffixes replaces the list", async () => {
  const files = {
    "lib/a.g.dart": "// a \u2014 b",
    "lib/a.freezed.dart": "// a \u2014 b",
  };
  assert.equal((await checkProject("no-dash", files)).length, 1);
  const custom = await checkProject("no-dash", files, {
    options: { skipSuffixes: [".freezed.dart"] },
  });
  assert.deepEqual(
    custom.map((v) => v.file),
    ["lib/a.g.dart"]
  );
  const none = await checkProject("no-dash", files, {
    options: { skipSuffixes: [] },
  });
  assert.equal(none.length, 2);
});

test("exempt dirs and files and include apply to project rules", async () => {
  const files = {
    "lib/l10n/en.dart": "// a \u2014 b",
    "lib/firebase_options.dart": "// a \u2014 b",
    "lib/api/generated/m.dart": "// a \u2014 b",
    "lib/app.dart": "// a \u2014 b",
  };
  const exempt = await checkProject("no-dash", files, {
    settings: {
      exempt: {
        dirs: ["lib/l10n/", "lib/api/generated/"],
        files: ["lib/firebase_options.dart"],
      },
    },
  });
  assert.deepEqual(
    exempt.map((v) => v.file),
    ["lib/app.dart"]
  );
  const included = await checkProject("no-dash", files, {
    settings: { include: ["lib/l10n/"] },
  });
  assert.deepEqual(
    included.map((v) => v.file),
    ["lib/l10n/en.dart"]
  );
});

test("non-dart files are not scanned", async () => {
  assert.deepEqual(
    await ruleIds("lib/notes.md", "// a \u2014 b https://example.com"),
    []
  );
});

test("nonUiDirs option replaces the default layer list", async () => {
  const text = "import 'package:flutter/material.dart';";
  assert.deepEqual(await ruleIds("lib/services/s.dart", text), []);
  assert.deepEqual(
    await ruleIds("lib/services/s.dart", text, {
      options: { nonUiDirs: ["lib/services/"] },
    }),
    ["no-ui-toolkit"]
  );
  assert.deepEqual(
    await ruleIds("lib/data/d.dart", text, {
      options: { nonUiDirs: ["lib/services/"] },
    }),
    []
  );
});

test("uiToolkits option replaces the forbidden list", async () => {
  const text =
    "import 'package:flutter/material.dart';\nimport 'package:fluent_ui/fluent_ui.dart';";
  const found = await check("no-ui-toolkit", "lib/data/d.dart", text, {
    options: { uiToolkits: ["package:fluent_ui/fluent_ui.dart"] },
  });
  assert.deepEqual(
    found.map((v) => v.line),
    [2]
  );
  assert.match(
    found[0]?.message ?? "",
    /^package:fluent_ui\/fluent_ui\.dart imported outside the UI layer$/
  );
});

test("double-quoted imports are read too", async () => {
  assert.deepEqual(
    await ruleIds(
      "lib/data/d.dart",
      'import "package:flutter/cupertino.dart";'
    ),
    ["no-ui-toolkit"]
  );
});

test("featureDir option changes the feature directory for both rules", async () => {
  const feature = await check(
    "no-feature-import",
    "lib/domain/q.dart",
    "import '../screens/home.dart';",
    {
      options: { featureDir: "lib/screens/" },
    }
  );
  assert.equal(feature.length, 1);
  assert.deepEqual(
    await check(
      "no-feature-import",
      "lib/domain/q.dart",
      "import '../features/home.dart';",
      { options: { featureDir: "lib/screens/" } }
    ),
    []
  );
  const store = await check(
    "no-store-in-features",
    "lib/screens/s.dart",
    "final c = store.box<A>().all;",
    {
      options: { featureDir: "lib/screens/" },
    }
  );
  assert.equal(store.length, 1);
});

test("an empty featureDir turns the feature rules off", async () => {
  assert.deepEqual(
    await check(
      "no-feature-import",
      "lib/domain/q.dart",
      "import '../x.dart';",
      { options: { featureDir: "" } }
    ),
    []
  );
  assert.deepEqual(
    await check(
      "no-store-in-features",
      "lib/a.dart",
      "final c = store.box<A>();",
      { options: { featureDir: "" } }
    ),
    []
  );
});

test("package imports of other packages and the sdk never count as feature imports", async () => {
  const text = "import 'package:other/features/x.dart';\nimport 'dart:async';";
  assert.deepEqual(
    await check("no-feature-import", "lib/domain/q.dart", text, withPackage),
    []
  );
});

test("without a package name an own-package import is not resolved, with one it is", async () => {
  const text = "import 'package:demo/features/x.dart';";
  assert.deepEqual(
    await check("no-feature-import", "lib/domain/q.dart", text),
    []
  );
  assert.equal(
    (await check("no-feature-import", "lib/domain/q.dart", text, withPackage))
      .length,
    1
  );
});

test("package name is read from pubspec.yaml under the root when the option is unset", async () => {
  const files = {
    "app/pubspec.yaml": "name: shop\nversion: 1.0.0\n",
    "app/lib/domain/q.dart": "import 'package:shop/features/x.dart';",
  };
  const found = await checkProject("no-feature-import", files, {
    options: { root: "app" },
  });
  assert.deepEqual(
    found.map((v) => v.file),
    ["app/lib/domain/q.dart"]
  );
});

test("own-package import into a non-feature directory is fine", async () => {
  assert.deepEqual(
    await check(
      "no-feature-import",
      "lib/domain/q.dart",
      "import 'package:demo/domain/y.dart';",
      withPackage
    ),
    []
  );
});

test("storeImportPattern and storeCallPattern are configurable", async () => {
  const text =
    "import 'package:isar/isar.dart';\nfinal c = isar.collection<A>();\nfinal d = store.box<B>();";
  const opts: CheckOptions = {
    options: {
      storeImportPattern: "^package:isar/",
      storeCallPattern: "isar\\.collection<",
    },
  };
  const found = await check(
    "no-store-in-features",
    "lib/features/f.dart",
    text,
    opts
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [1, 2]
  );
});

test("store calls in comments are ignored", async () => {
  assert.deepEqual(
    await check(
      "no-store-in-features",
      "lib/features/f.dart",
      "// store.box<A>()"
    ),
    []
  );
});

test("allowedUrlPattern replaces the allowed link list", async () => {
  const text =
    "const a = 'https://cdn.example.com/x';\nconst b = 'https://play.google.com/store';";
  const found = await check("no-hardcoded-origin", "lib/a.dart", text, {
    options: { allowedUrlPattern: "https://cdn\\.example\\.com/" },
  });
  assert.deepEqual(
    found.map((v) => v.line),
    [2]
  );
});

test("options.message overrides the message of every rule", async () => {
  const cases: Array<[string, string, string]> = [
    ["no-dash", "lib/a.dart", "// a \u2014 b"],
    [
      "no-ui-toolkit",
      "lib/data/a.dart",
      "import 'package:flutter/material.dart';",
    ],
    ["no-feature-import", "lib/domain/a.dart", "import '../features/x.dart';"],
    [
      "no-store-in-features",
      "lib/features/a.dart",
      "final c = store.box<A>();",
    ],
    ["no-hardcoded-origin", "lib/a.dart", "const u = 'https://example.com';"],
  ];
  for (const [id, path, text] of cases) {
    const [v] = await check(id, path, text, { options: { message: "custom" } });
    assert.equal(v?.message, "custom", id);
    assert.equal(v?.rule, id);
  }
});

test("default messages name no project path", async () => {
  const cases: Array<[string, string, string]> = [
    ["no-feature-import", "lib/domain/a.dart", "import '../features/x.dart';"],
    [
      "no-store-in-features",
      "lib/features/a.dart",
      "final c = store.box<A>();",
    ],
    ["no-hardcoded-origin", "lib/a.dart", "const u = 'https://example.com';"],
  ];
  for (const [id, path, text] of cases) {
    const [v] = await check(id, path, text);
    assert.doesNotMatch(v?.message ?? "", /lib\/(domain|core)/, id);
  }
});
