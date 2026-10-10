"use strict";
/** Tests the independent coverage check, including its c8 integration. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  ".github",
  "scripts",
  "verify-coverage.js",
);
const {
  verify,
  listSourceFiles,
  findDataProblems,
  findThresholdProblems,
  findEntrypointProblems,
  findNodeOptionsProblems,
  findImportProblems,
  findSymlinkProblems,
} = require(SCRIPT_PATH);

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cla-bot-verify-cov-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

const metric = (covered, total) => ({
  covered,
  total,
  pct: total === 0 ? "Unknown" : (covered / total) * 100,
});
const fullMetrics = () => ({
  lines: metric(10, 10),
  statements: metric(10, 10),
  functions: metric(2, 2),
  branches: metric(4, 4),
});

function writeSummary(dir, summary) {
  fs.mkdirSync(path.join(dir, "coverage"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "coverage", "coverage-summary.json"),
    JSON.stringify(summary),
  );
}

// --- listSourceFiles ------------------------------------------------------------

test("listSourceFiles finds .js/.cjs/.mjs files at any depth under src/, sorted, and nothing else", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/b.js": "",
      "src/a.js": "",
      "src/deep/er/c.cjs": "",
      "src/d.mjs": "",
      "src/readme.md": "",
      "src/data.json": "",
      "test/not-src.js": "",
      "other/x.js": "",
    });
    assert.deepStrictEqual(
      listSourceFiles(dir).map((f) =>
        path.relative(dir, f).split(path.sep).join("/"),
      ),
      ["src/a.js", "src/b.js", "src/d.mjs", "src/deep/er/c.cjs"],
    );
  });
});

test("listSourceFiles returns an empty list when there is no src/ directory", async () => {
  await withTmpDir((dir) => {
    assert.deepStrictEqual(listSourceFiles(dir), []);
  });
});

// --- findDataProblems --------------------------------------------------------------

test("findDataProblems is clean when every source file is tracked and data exists", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "", "src/lib/b.js": "" });
    const summary = {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
      [path.join(dir, "src", "lib", "b.js")]: fullMetrics(),
    };
    assert.deepStrictEqual(findDataProblems(summary, dir), []);
  });
});

test("findDataProblems flags a source file that is missing from the report", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/tracked.js": "", "src/new-feature.js": "" });
    const summary = {
      total: fullMetrics(),
      [path.join(dir, "src", "tracked.js")]: fullMetrics(),
    };
    const problems = findDataProblems(summary, dir);
    assert.strictEqual(problems.length, 1);
    assert.match(
      problems[0],
      /src\/new-feature\.js exists but is missing from the coverage report/,
    );
  });
});

test("findDataProblems flags having no source files to measure", async () => {
  await withTmpDir((dir) => {
    const problems = findDataProblems({ total: fullMetrics() }, dir);
    assert.ok(
      problems.some((p) => /No source files were found under src\//.test(p)),
    );
  });
});

test("findDataProblems flags a run that measured zero statements, or has no total at all", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "" });
    const tracked = { [path.join(dir, "src", "a.js")]: fullMetrics() };
    const empty = {
      lines: metric(0, 0),
      statements: metric(0, 0),
      functions: metric(0, 0),
      branches: metric(0, 0),
    };
    for (const total of [empty, undefined, { lines: metric(1, 1) }]) {
      const problems = findDataProblems({ ...tracked, total }, dir);
      assert.ok(
        problems.some((p) => /No coverage data was collected/.test(p)),
        JSON.stringify(total),
      );
    }
  });
});

// --- findThresholdProblems ---------------------------------------------------------

test("findThresholdProblems is clean when every metric is covered === total", () => {
  assert.deepStrictEqual(findThresholdProblems({ total: fullMetrics() }), []);
});

for (const name of ["lines", "statements", "functions", "branches"]) {
  test(`findThresholdProblems reports ${name} below 100% from the raw counts`, () => {
    const total = fullMetrics();
    total[name] = metric(total[name].total - 1, total[name].total);
    const problems = findThresholdProblems({ total });
    assert.strictEqual(problems.length, 1);
    assert.match(
      problems[0],
      new RegExp(`^${name} coverage is \\d+/\\d+, not 100%`),
    );
  });
}

test("findThresholdProblems reports a metric that is missing from the report entirely", () => {
  const total = fullMetrics();
  delete total.branches;
  assert.deepStrictEqual(findThresholdProblems({ total }), [
    "branches coverage is missing from the report.",
  ]);
  assert.strictEqual(findThresholdProblems({}).length, 4);
});

// --- action.yml: the shipped entrypoint must be measured -----------------------------------

const trackedSet = (dir, ...rels) =>
  new Set(rels.map((rel) => path.join(dir, ...rel.split("/"))));

// A composite action whose single script step has the given `run` text
// (and, optionally, step env).
function compositeAction(run, env) {
  return [
    "name: t",
    "runs:",
    '  using: "composite"',
    "  steps:",
    "    - uses: actions/setup-node@v1",
    "    - shell: bash",
    ...(env
      ? [
          "      env:",
          ...Object.entries(env).map(([k, v]) => `        ${k}: ${v}`),
        ]
      : []),
    `      run: ${run}`,
    "",
  ].join("\n");
}
const ACTION_PATH_ENV = { ACTION_PATH: "${{ github.action_path }}" };

test("the REAL action.yml runs only measured scripts under src/ (the shipped entrypoint is inside the gate)", () => {
  assert.deepStrictEqual(
    findEntrypointProblems(REPO_ROOT, new Set(listSourceFiles(REPO_ROOT))),
    [],
  );
});

test('findEntrypointProblems accepts the project\'s own shape: node "$ACTION_PATH/src/x.js" with ACTION_PATH = github.action_path', async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml": compositeAction(
        'node "$ACTION_PATH/src/x.js"',
        ACTION_PATH_ENV,
      ),
    });
    assert.deepStrictEqual(
      findEntrypointProblems(dir, trackedSet(dir, "src/x.js")),
      [],
    );
  });
});

test("findEntrypointProblems accepts ${ACTION_PATH}, the github.action_path expression, unquoted scripts and node options", async () => {
  await withTmpDir((dir) => {
    for (const run of [
      'node "${ACTION_PATH}/src/x.js"',
      "node '${{ github.action_path }}/src/x.js'",
      "node ${{ github.action_path }}/src/x.js",
      'node --max-old-space-size=512 "$ACTION_PATH/src/x.js" && echo done',
    ]) {
      writeFiles(dir, {
        "action.yml": compositeAction(JSON.stringify(run), ACTION_PATH_ENV),
      });
      assert.deepStrictEqual(
        findEntrypointProblems(dir, trackedSet(dir, "src/x.js")),
        [],
        run,
      );
    }
  });
});

test("findEntrypointProblems has nothing to verify when there is no action.yml", async () => {
  await withTmpDir((dir) => {
    assert.deepStrictEqual(findEntrypointProblems(dir, new Set()), []);
  });
});

test("findEntrypointProblems flags a script outside src/ (the action.yml bypass)", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml": compositeAction(
        'node "$ACTION_PATH/scripts/evil.js"',
        ACTION_PATH_ENV,
      ),
      "scripts/evil.js": "",
    });
    const problems = findEntrypointProblems(dir, trackedSet(dir, "src/x.js"));
    assert.strictEqual(problems.length, 1);
    assert.match(
      problems[0],
      /runs scripts\/evil\.js, which is outside src\/ and therefore never measured/,
    );
  });
});

test("findEntrypointProblems flags a script that is under src/ but missing from the report", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml": compositeAction(
        'node "$ACTION_PATH/src/ghost.js"',
        ACTION_PATH_ENV,
      ),
    });
    const problems = findEntrypointProblems(dir, trackedSet(dir, "src/x.js"));
    assert.match(
      problems[0],
      /runs src\/ghost\.js, but it is missing from the coverage report/,
    );
  });
});

test("findEntrypointProblems flags inline (-e/-p), preloaded (-r/--require/--import) code, which is never measured", async () => {
  await withTmpDir((dir) => {
    for (const run of [
      "node -e \"require('./x')\"",
      'node --eval="1" "$ACTION_PATH/src/x.js"',
      "node -p 1",
      'node -r ./pre.js "$ACTION_PATH/src/x.js"',
      'node --require=./pre.js "$ACTION_PATH/src/x.js"',
      'node --import ./pre.mjs "$ACTION_PATH/src/x.js"',
    ]) {
      writeFiles(dir, {
        "action.yml": compositeAction(JSON.stringify(run), ACTION_PATH_ENV),
      });
      const problems = findEntrypointProblems(dir, trackedSet(dir, "src/x.js"));
      assert.ok(
        problems.some((p) => /inline or preloaded code/.test(p)),
        run,
      );
    }
  });
});

test("findEntrypointProblems flags loader flags on the node command line too (--loader / --experimental-loader)", async () => {
  await withTmpDir((dir) => {
    for (const run of [
      'node --loader ./hooks.mjs "$ACTION_PATH/src/x.js"',
      'node --experimental-loader=./hooks.mjs "$ACTION_PATH/src/x.js"',
    ]) {
      writeFiles(dir, {
        "action.yml": compositeAction(JSON.stringify(run), ACTION_PATH_ENV),
      });
      const problems = findEntrypointProblems(dir, trackedSet(dir, "src/x.js"));
      assert.ok(
        problems.some((p) => /inline or preloaded code/.test(p)),
        run,
      );
    }
  });
});

// --- NODE_OPTIONS: preloading without a flag on the node command line --------------------
//
// `env: { NODE_OPTIONS: "--require ./evil.js" }` followed by a perfectly
// plain `node "$ACTION_PATH/src/x.js"` preloads evil.js, and coverage never
// sees it. The flag has to be caught where the variable is set.

const PRELOAD_PROBLEM = /NODE_OPTIONS with inline or preloaded code/;
const INDIRECT_PROBLEM = /NODE_OPTIONS from an expression or variable/;

test("findNodeOptionsProblems flags a preload/inline flag in a step's env (any step, any spelling of the name)", () => {
  for (const value of [
    "--require ${{ github.action_path }}/tools/evil.js",
    "-r ./evil.js",
    "--require=./evil.js",
    "--import ./evil.mjs",
    "--experimental-loader ./hooks.mjs",
    "--loader=./hooks.mjs",
    "-e 1",
    "--max-old-space-size=4096 --require ./evil.js", // after a harmless flag
  ]) {
    // `uses:` steps have no `run`; their env still reaches node later on.
    const problems = findNodeOptionsProblems({ env: { NODE_OPTIONS: value } });
    assert.strictEqual(problems.length, 1, value);
    assert.match(problems[0], PRELOAD_PROBLEM, value);
  }
  // Windows environment variable names are case-insensitive.
  assert.match(
    findNodeOptionsProblems({ env: { node_options: "-r ./x.js" } })[0],
    PRELOAD_PROBLEM,
  );
});

test("findNodeOptionsProblems flags NODE_OPTIONS set inside a run script: prefix, export, += and $GITHUB_ENV writes", () => {
  for (const run of [
    'NODE_OPTIONS="--require ./evil.js" node "$ACTION_PATH/src/x.js"',
    "NODE_OPTIONS='--require ./evil.js' node \"$ACTION_PATH/src/x.js\"",
    'NODE_OPTIONS=--require ./evil.js node "$ACTION_PATH/src/x.js"',
    'export NODE_OPTIONS="--import ./evil.mjs"',
    "export NODE_OPTIONS=--require=./evil.js",
    'NODE_OPTIONS+=" --require ./evil.js" node x',
    // Carried to a LATER step through the environment file:
    'echo "NODE_OPTIONS=--require ./evil.js" >> "$GITHUB_ENV"',
    'echo "NODE_OPTIONS=--max-old-space-size=1 --require ./evil.js" >> "$GITHUB_ENV"',
    // A backslash continuation does not hide the flag on the next line:
    'export NODE_OPTIONS="--max-old-space-size=1 \\\n  --require ./evil.js"',
    "NODE_OPTIONS=--max-old-space-size=1 \\\n  --require ./evil.js node x",
    // Appending to the existing value still adds the flag:
    'export NODE_OPTIONS="$NODE_OPTIONS -r ./evil.js"',
    'export NODE_OPTIONS="${NODE_OPTIONS} --require ./evil.js"',
    // Windows shells:
    "set node_options=--require ./evil.js",
    '$env:NODE_OPTIONS="--require ./evil.js"',
  ]) {
    const problems = findNodeOptionsProblems({ run });
    assert.ok(
      problems.length >= 1 && problems.every((p) => PRELOAD_PROBLEM.test(p)),
      run,
    );
  }
});

test("findNodeOptionsProblems rejects a NODE_OPTIONS value it cannot evaluate (expression, variable, command substitution)", () => {
  for (const step of [
    { env: { NODE_OPTIONS: "${{ inputs.node-options }}" } },
    { env: { NODE_OPTIONS: "--max-old-space-size=${{ inputs.mem }}" } },
    { env: { NODE_OPTIONS: "$EXTRA" } },
    { run: 'export NODE_OPTIONS="${{ inputs.node-options }}"' },
    { run: 'export NODE_OPTIONS="$EXTRA"' },
    { run: 'export NODE_OPTIONS="`cat opts.txt`"' },
    { run: 'NODE_OPTIONS=$EXTRA node "$ACTION_PATH/src/x.js"' },
    { run: 'NODE_OPTIONS=${{ inputs.x }} node "$ACTION_PATH/src/x.js"' },
  ]) {
    const problems = findNodeOptionsProblems(step);
    assert.strictEqual(problems.length, 1, JSON.stringify(step));
    assert.match(problems[0], INDIRECT_PROBLEM, JSON.stringify(step));
  }
});

test("findNodeOptionsProblems allows harmless NODE_OPTIONS, and anything unrelated to the variable", () => {
  for (const step of [
    { env: { NODE_OPTIONS: "--max-old-space-size=4096" } },
    { env: { NODE_OPTIONS: "--enable-source-maps --no-warnings" } },
    { env: { NODE_OPTIONS: "" } },
    { env: { NODE_OPTIONS: null } },
    { env: { NODE_OPTIONS: 4096 } },
    { env: { OTHER: "--require ./x.js" } },
    { env: "not a mapping" },
    {},
    { run: "echo hello" },
    {
      run: 'NODE_OPTIONS=--max-old-space-size=4096 node "$ACTION_PATH/src/x.js"',
    },
    { run: 'export NODE_OPTIONS="--max-old-space-size=4096"' },
    { run: 'echo "NODE_OPTIONS=--max-old-space-size=4096" >> "$GITHUB_ENV"' },
    { run: 'export NODE_OPTIONS="$NODE_OPTIONS --max-old-space-size=4096"' },
    { run: 'export NODE_OPTIONS="${NODE_OPTIONS} --enable-source-maps"' },
    // Only the variable NODE_OPTIONS matters, not names that merely end in it:
    { run: "MY_NODE_OPTIONS=--require ./x.js" },
    // A flag-looking word AFTER a harmless value in a quoted string is still flagged,
    // but a script argument after the closing quote is not part of the value:
    { run: 'NODE_OPTIONS="--max-old-space-size=1" node x --require-thing' },
  ]) {
    assert.deepStrictEqual(
      findNodeOptionsProblems(step),
      [],
      JSON.stringify(step),
    );
  }
});

test("findNodeOptionsProblems echoes a long offending value truncated, so a report stays small", () => {
  const long = `--require ./${"a".repeat(500)}.js`;
  const [problem] = findNodeOptionsProblems({ env: { NODE_OPTIONS: long } });
  assert.match(problem, PRELOAD_PROBLEM);
  assert.ok(problem.includes("..."), "value is truncated");
  assert.ok(problem.length < 300, `message stays short (${problem.length})`);
});

test("findEntrypointProblems applies the NODE_OPTIONS check to the real shape of the bypass, in a composite action.yml", async () => {
  await withTmpDir((dir) => {
    const withEnvStep = (env, run) =>
      [
        "name: t",
        "runs:",
        '  using: "composite"',
        "  steps:",
        "    - uses: actions/setup-node@v1",
        "      env:",
        ...Object.entries(env).map(
          ([k, v]) => `        ${k}: ${JSON.stringify(v)}`,
        ),
        "    - shell: bash",
        "      env:",
        '        ACTION_PATH: "${{ github.action_path }}"',
        `      run: ${JSON.stringify(run)}`,
        "",
      ].join("\n");
    const clean = 'node "$ACTION_PATH/src/x.js"';
    const tracked = trackedSet(dir, "src/x.js");

    // 1. env on the node step itself, with a plain-looking run line
    writeFiles(dir, {
      "action.yml": compositeAction(JSON.stringify(clean), {
        ...ACTION_PATH_ENV,
        NODE_OPTIONS: JSON.stringify(
          "--require ${{ github.action_path }}/tools/evil.js",
        ),
      }),
    });
    assert.ok(
      findEntrypointProblems(dir, tracked).some((p) => PRELOAD_PROBLEM.test(p)),
      "env on the node step",
    );

    // 2. env on an earlier, unrelated step
    writeFiles(dir, {
      "action.yml": withEnvStep({ NODE_OPTIONS: "--require ./evil.js" }, clean),
    });
    assert.ok(
      findEntrypointProblems(dir, tracked).some((p) => PRELOAD_PROBLEM.test(p)),
      "env on an earlier step",
    );

    // 3. inline prefix and export inside the run script
    for (const run of [
      `NODE_OPTIONS="--require ./evil.js" ${clean}`,
      `export NODE_OPTIONS="--require ./evil.js"\n${clean}`,
    ]) {
      writeFiles(dir, { "action.yml": withEnvStep({ OTHER: "1" }, run) });
      assert.ok(
        findEntrypointProblems(dir, tracked).some((p) =>
          PRELOAD_PROBLEM.test(p),
        ),
        run,
      );
    }

    // 4. the harmless version of all of the above passes
    writeFiles(dir, {
      "action.yml": withEnvStep(
        { NODE_OPTIONS: "--max-old-space-size=4096" },
        `NODE_OPTIONS=--max-old-space-size=4096 ${clean}`,
      ),
    });
    assert.deepStrictEqual(findEntrypointProblems(dir, tracked), []);
  });
});

test("findEntrypointProblems skips composite steps that are not mappings", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml": [
        "name: t",
        "runs:",
        '  using: "composite"',
        "  steps:",
        "    - just a string",
        "    - 42",
        "    - shell: bash",
        '      env: { ACTION_PATH: "${{ github.action_path }}" }',
        '      run: node "$ACTION_PATH/src/x.js"',
        "",
      ].join("\n"),
    });
    assert.deepStrictEqual(
      findEntrypointProblems(dir, trackedSet(dir, "src/x.js")),
      [],
    );
  });
});

test("findEntrypointProblems flags locations it cannot verify: other roots, '..', variables, a repointed ACTION_PATH or none at all", async () => {
  await withTmpDir((dir) => {
    const cases = [
      ["node ./src/x.js", ACTION_PATH_ENV],
      ["node src/x.js", ACTION_PATH_ENV],
      ["node /abs/src/x.js", ACTION_PATH_ENV],
      ['node "$ACTION_PATH/../x.js"', ACTION_PATH_ENV],
      ['node "$ACTION_PATH/src/../../x.js"', ACTION_PATH_ENV],
      ['node "$ACTION_PATH/src/$X.js"', ACTION_PATH_ENV],
      ['node "$OTHER/src/x.js"', ACTION_PATH_ENV],
      // ACTION_PATH redefined to a different tree, or not defined by the step:
      [
        'node "$ACTION_PATH/src/x.js"',
        { ACTION_PATH: "${{ github.workspace }}/evil" },
      ],
      ['node "$ACTION_PATH/src/x.js"', undefined],
      ['node "${ACTION_PATH}/src/x.js"', { OTHER: "1" }],
    ];
    for (const [run, env] of cases) {
      writeFiles(dir, {
        "action.yml": compositeAction(JSON.stringify(run), env),
      });
      const problems = findEntrypointProblems(dir, trackedSet(dir, "src/x.js"));
      assert.ok(
        problems.some((p) => /from a location the gate cannot verify/.test(p)),
        `${run} ${JSON.stringify(env)} -> ${problems}`,
      );
    }
  });
});

test("findEntrypointProblems requires the action to run some node script from src/", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "action.yml": compositeAction("echo hello") });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /does not run any node script from src\//,
    );
  });
});

test("findEntrypointProblems ignores steps without a run, and tolerates a composite action with no steps list", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml":
        "runs:\n  using: composite\n  steps:\n    - uses: a/b@v1\n    - null\n",
    });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /does not run any node script/,
    );
    writeFiles(dir, { "action.yml": "runs:\n  using: composite\n" });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /does not run any node script/,
    );
  });
});

test("findEntrypointProblems checks the main/pre/post scripts of a node action", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml":
        "runs:\n  using: node24\n  main: src/main.js\n  pre: src/pre.js\n  post: dist/post.js\n",
    });
    const problems = findEntrypointProblems(
      dir,
      trackedSet(dir, "src/main.js"),
    );
    assert.strictEqual(problems.length, 2);
    assert.ok(problems.some((p) => /src\/pre\.js, but it is missing/.test(p)));
    assert.ok(
      problems.some((p) => /dist\/post\.js, which is outside src\//.test(p)),
    );

    writeFiles(dir, {
      "action.yml": "runs:\n  using: node24\n  main: src/main.js\n",
    });
    assert.deepStrictEqual(
      findEntrypointProblems(dir, trackedSet(dir, "src/main.js")),
      [],
    );

    writeFiles(dir, { "action.yml": "runs:\n  using: node24\n" });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /without a `main` script/,
    );
  });
});

test("findEntrypointProblems rejects action types it can't verify, and unusable files", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "action.yml": "runs:\n  using: docker\n  image: Dockerfile\n",
    });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /runs\.using "docker"/,
    );

    writeFiles(dir, { "action.yml": "name: no-runs\n" });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /no `runs` section/,
    );

    writeFiles(dir, { "action.yml": "just a string\n" });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /no `runs` section/,
    );

    writeFiles(dir, { "action.yml": "runs: [unclosed\n  - : :\n" });
    assert.match(
      findEntrypointProblems(dir, new Set())[0],
      /could not be parsed/,
    );
  });
});

test("findDataProblems includes the entrypoint and import problems", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/a.js": 'require("../outside.js");\n',
      "action.yml": compositeAction(
        'node "$ACTION_PATH/tools/x.js"',
        ACTION_PATH_ENV,
      ),
    });
    const summary = {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    };
    const problems = findDataProblems(summary, dir);
    assert.ok(
      problems.some((p) =>
        /outside src\/ and therefore never measured/.test(p),
      ),
    );
    assert.ok(problems.some((p) => /tools\/x\.js/.test(p)));
  });
});

// --- imports that leave src/ ----------------------------------------------------------------

test("findImportProblems allows built-ins, packages and relative imports that stay inside src/", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/a.js": [
        'const fs = require("fs");',
        'const b = require("./lib/b.js");',
        'const c = require("./lib");',
        'const self = require(".");',
        'const dyn = import("./lib/b.js");',
        'import d from "./lib/b.js";',
        'import "./lib/b.js";',
        'const pkg = require("some-package");',
      ].join("\n"),
      "src/lib/b.js": 'require("../a.js"); require("../lib/b.js");',
    });
    assert.deepStrictEqual(findImportProblems(dir, listSourceFiles(dir)), []);
  });
});

test("findImportProblems flags require/import/dynamic import of a relative path outside src/", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/a.js": [
        'require("../vendor/x.js");',
        "require('../../elsewhere');",
        'import("../dyn.js");',
        'import e from "../esm.mjs";',
        'import "../side-effect.js";',
        'require("..");',
        "require(`../tpl.js`);",
      ].join("\n"),
    });
    const problems = findImportProblems(dir, listSourceFiles(dir));
    assert.strictEqual(problems.length, 7);
    for (const spec of [
      "../vendor/x.js",
      "../../elsewhere",
      "../dyn.js",
      "../esm.mjs",
      "../side-effect.js",
      "..",
      "../tpl.js",
    ]) {
      assert.ok(
        problems.some((p) => p.includes(`loads "${spec}"`)),
        spec,
      );
    }
  });
});

test("findImportProblems skips a file that vanished between listing and reading", async () => {
  await withTmpDir((dir) => {
    assert.deepStrictEqual(
      findImportProblems(dir, [path.join(dir, "src", "gone.js")]),
      [],
    );
  });
});

// --- reading files without check-then-use races -------------------------------------------------

// --- symlinks under src/ ------------------------------------------------------------------

test("findSymlinkProblems flags a symlink under src/ (file or directory) and ignores real files", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/real.js": "module.exports = 1;\n",
      "src/nested/deep.js": "module.exports = 2;\n",
      "tools/evil.js": "console.log('unmeasured');\n",
    });
    assert.deepStrictEqual(findSymlinkProblems(dir), []);

    fs.symlinkSync("../tools/evil.js", path.join(dir, "src", "linked.js"));
    fs.symlinkSync("../../tools", path.join(dir, "src", "nested", "tools-dir"));
    const problems = findSymlinkProblems(dir);
    assert.strictEqual(problems.length, 2);
    assert.match(problems[0], /^src\/linked\.js is a symlink inside src\//);
    assert.match(
      problems[1],
      /^src\/nested\/tools-dir is a symlink inside src\//,
    );
  });
});

test("findSymlinkProblems has nothing to say when src/ does not exist", async () => {
  await withTmpDir((dir) => {
    assert.deepStrictEqual(findSymlinkProblems(dir), []);
  });
});

test("findDataProblems includes the symlink problem (a link can pass for measured source)", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, {
      "src/real.js": "module.exports = 1;\n",
      "tools/evil.js": "console.log('unmeasured');\n",
    });
    fs.symlinkSync("../tools/evil.js", path.join(dir, "src", "linked.js"));
    const summary = {
      total: fullMetrics(),
      [path.join(dir, "src", "real.js")]: fullMetrics(),
    };
    assert.ok(
      findDataProblems(summary, dir).some((p) =>
        /src\/linked\.js is a symlink/.test(p),
      ),
    );
  });
});

test("listSourceFiles treats a missing src/ or a src that is a plain file as 'no sources', but surfaces real I/O errors", async () => {
  await withTmpDir((dir) => {
    fs.writeFileSync(path.join(dir, "src"), "i am a file, not a directory");
    assert.deepStrictEqual(listSourceFiles(dir), []);
  });
  await withTmpDir((dir) => {
    const original = fs.readdirSync;
    fs.readdirSync = () => {
      throw Object.assign(new Error("disk on fire"), { code: "EIO" });
    };
    try {
      assert.throws(() => listSourceFiles(dir), /disk on fire/);
    } finally {
      fs.readdirSync = original;
    }
  });
});

test("verify() surfaces a real read error instead of reporting 'not found' (only ENOENT means missing)", async () => {
  await withTmpDir((dir) => {
    // A directory where the summary file should be: reading it fails with
    // EISDIR, which must not be mistaken for "the file is missing".
    fs.mkdirSync(path.join(dir, "coverage", "coverage-summary.json"), {
      recursive: true,
    });
    assert.throws(() => verify({ cwd: dir }), /EISDIR/);
  });
});

// --- verify() and the CLI ---------------------------------------------------------------

test("verify() reports a missing summary instead of throwing", async () => {
  await withTmpDir((dir) => {
    const problems = verify({ cwd: dir });
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /coverage-summary\.json not found/);
  });
});

test("verify() defaults to the current directory and passes on a complete, fully covered report", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "" });
    writeSummary(dir, {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      assert.deepStrictEqual(verify(), []);
    } finally {
      process.chdir(previous);
    }
  });
});

test("verify() combines data and threshold problems", async () => {
  await withTmpDir((dir) => {
    writeSummary(dir, { total: { ...fullMetrics(), lines: metric(1, 2) } });
    const problems = verify({ cwd: dir });
    assert.ok(problems.some((p) => /No source files/.test(p)));
    assert.ok(problems.some((p) => /^lines coverage is 1\/2/.test(p)));
  });
});

test("the CLI exits 0 with a confirmation when the report is complete and fully covered", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "" });
    writeSummary(dir, {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /Coverage data verified/);
  });
});

test("the CLI prints every problem and exits 1 when something is wrong", async () => {
  await withTmpDir((dir) => {
    writeFiles(dir, { "src/a.js": "", "src/b.js": "" });
    writeSummary(dir, {
      total: fullMetrics(),
      [path.join(dir, "src", "a.js")]: fullMetrics(),
    });
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /ERROR: src\/b\.js exists but is missing/);
  });
});

// --- the real c8, with the project's real config ---------------------------------------------

// Runs c8 for real inside `dir`, writing its data and reports only under
// dir/coverage (explicit absolute paths, so it can never touch - and with
// c8's default `clean` wipe - the coverage data of an outer c8 run that is
// measuring this very test file).
function runC8(dir, args) {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  return spawnSync(
    process.execPath,
    [
      require.resolve("c8/bin/c8.js"),
      `--reports-dir=${path.join(dir, "coverage")}`,
      `--temp-directory=${path.join(dir, "coverage", "tmp")}`,
      ...args,
    ],
    { cwd: dir, env, encoding: "utf8" },
  );
}

function useProjectConfig(dir) {
  fs.copyFileSync(
    path.join(REPO_ROOT, ".c8rc.json"),
    path.join(dir, ".c8rc.json"),
  );
}

test("REAL c8 + the project's .c8rc.json: a new src file that no test imports shows up at 0% and fails the gate", async () => {
  await withTmpDir((dir) => {
    useProjectConfig(dir);
    writeFiles(dir, {
      "src/loaded.js": "module.exports = { a() { return 1; } };\n",
      "src/new-feature.js": "module.exports = { b() { return 2; } };\n",
      "test/t.js": 'require("../src/loaded.js").a();\n',
    });

    const run = runC8(dir, [process.execPath, "test/t.js"]);
    assert.notStrictEqual(run.status, 0, "c8 itself must fail the run");
    assert.match(run.stdout + run.stderr, /does not meet global threshold/);

    const summary = JSON.parse(
      fs.readFileSync(
        path.join(dir, "coverage", "coverage-summary.json"),
        "utf8",
      ),
    );
    const tracked = Object.keys(summary).map((k) => path.basename(k));
    assert.ok(
      tracked.includes("new-feature.js"),
      "the untested file must be tracked",
    );

    // And the independent check agrees, whatever c8 did.
    assert.deepStrictEqual(findDataProblems(summary, dir), []);
    assert.ok(findThresholdProblems(summary).length > 0);
  });
});

test("REAL c8: when `include` matches nothing, c8 check-coverage still passes - and verify() catches it", async () => {
  await withTmpDir((dir) => {
    // The "include was edited / src was renamed" failure mode.
    fs.writeFileSync(
      path.join(dir, ".c8rc.json"),
      JSON.stringify({
        all: true,
        include: ["nonexistent/**/*.js"],
        reporter: ["json-summary", "json"],
        "check-coverage": true,
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      }),
    );
    writeFiles(dir, {
      "src/untracked.js": "module.exports = 1;\n",
      "test/t.js": 'require("../src/untracked.js");\n',
    });

    const run = runC8(dir, [process.execPath, "test/t.js"]);
    const check = runC8(dir, ["check-coverage"]);
    // This is the upstream gap the guard exists for: nothing measured, yet
    // c8 is happy. If a c8 upgrade fixes it, this assertion will say so.
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);

    const problems = verify({ cwd: dir });
    assert.ok(
      problems.some((p) => /src\/untracked\.js exists but is missing/.test(p)),
    );
    assert.ok(problems.some((p) => /No coverage data was collected/.test(p)));
  });
});

test("REAL c8 + the project's .c8rc.json: a fully tested project passes both c8 and verify()", async () => {
  await withTmpDir((dir) => {
    useProjectConfig(dir);
    writeFiles(dir, {
      "src/lib.js": "module.exports = { a() { return 1; } };\n",
      "test/t.js": 'require("../src/lib.js").a();\n',
    });
    const run = runC8(dir, [process.execPath, "test/t.js"]);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.deepStrictEqual(verify({ cwd: dir }), []);
  });
});

test("REAL c8: a child process spawned with a stripped environment is still measured (the e2e CLI tests rely on this)", async () => {
  await withTmpDir((dir) => {
    useProjectConfig(dir);
    writeFiles(dir, {
      // The `if` body can only ever run in the child, where it is the entry point.
      "src/cli.js":
        'if (require.main === module) { process.stdout.write("ran"); }\nmodule.exports = {};\n',
      "test/t.js": [
        'const { spawnSync } = require("child_process");',
        'const path = require("path");',
        'const cli = path.join(__dirname, "..", "src", "cli.js");',
        "// Like test/e2e.test.js: only PATH is passed on, never the parent env.",
        'const r = spawnSync(process.execPath, [cli], { env: { PATH: process.env.PATH }, encoding: "utf8" });',
        'if (r.stdout !== "ran") process.exit(3);',
        "",
      ].join("\n"),
    });
    const run = runC8(dir, [process.execPath, "test/t.js"]);
    // 100% (c8 exits 0) means the child's execution was recorded.
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.deepStrictEqual(verify({ cwd: dir }), []);
  });
});

// --- the project's own config ------------------------------------------------------------------
// Not a security control (a PR can edit this file and this test together -
// see CONTRIBUTING.md "How the coverage gate is enforced"), but it makes any
// weakening of the gate an explicit, visible failure in the diff.

test(".c8rc.json keeps the gate at 100% on every metric, measuring all of src/", () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".c8rc.json"), "utf8"),
  );
  assert.strictEqual(config["check-coverage"], true);
  assert.strictEqual(config.all, true);
  assert.ok(config.include.includes("src/**/*.js"));
  for (const m of ["lines", "statements", "functions", "branches"]) {
    assert.strictEqual(config[m], 100, `${m} threshold`);
  }
  assert.ok(
    config.reporter.includes("json-summary"),
    "verify() reads json-summary",
  );
  assert.ok(config.reporter.includes("json"), "coverage-report.js reads json");
});

// --- runner -----------------------------------------------------------------------------------------

async function runAll() {
  let passed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
      passed += 1;
    } catch (e) {
      console.error(`FAIL: ${name}\n - ${e.stack}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${cases.length} test(s) passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED.");
  } else {
    console.log("ALL TESTS PASSED.");
  }
}

runAll();
