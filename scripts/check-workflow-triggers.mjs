import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const pullRequestBlock = workflow.match(
  /^ {2}pull_request:\s*\n([\s\S]*?)(?=^ {2}[a-z_]+:)/m,
);
assert.ok(pullRequestBlock, "CI must declare a pull_request trigger");

const pullRequestTypes = pullRequestBlock[1].match(
  /^\s+types:\s*\[([^\]]+)\]/m,
);
assert.ok(pullRequestTypes, "pull_request must declare explicit event types");
const subscribedActions = new Set(
  pullRequestTypes[1].split(",").map((action) => action.trim()),
);
assert.ok(subscribedActions.has("labeled"), "adding a PR label must start CI");
assert.ok(
  subscribedActions.has("unlabeled"),
  "removing a PR label must re-evaluate CI",
);

const packageStart = workflow.indexOf("\n  package:");
assert.notEqual(packageStart, -1, "CI must declare a package job");
const packageBlock = workflow.slice(packageStart);
const packageCondition = packageBlock.match(/^\s+if:\s*(.+)$/m)?.[1];
assert.ok(packageCondition, "package job must have an explicit release gate");
assert.match(packageCondition, /github\.event_name\s*==\s*'push'/);
assert.match(packageCondition, /github\.event_name\s*==\s*'pull_request'/);
assert.match(
  packageCondition,
  /contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'release-bundle'\)/,
);

const rustStart = workflow.indexOf("\n  rust:");
assert.notEqual(rustStart, -1, "CI must declare a Rust job");
const rustBlock = workflow.slice(rustStart, packageStart);
assert.match(
  rustBlock,
  /uses:\s*actions\/setup-node@v4[\s\S]*?node-version:\s*22/,
);

function assertRustCacheWorkspace(jobBlock, jobName) {
  const cacheUses = [
    ...jobBlock.matchAll(/- uses:\s*Swatinem\/rust-cache@v2/g),
  ];
  assert.equal(cacheUses.length, 1, `${jobName} must configure one Rust cache`);
  const cacheStart = cacheUses[0].index;
  const nextStep = jobBlock.indexOf("\n      - ", cacheStart + 1);
  const cacheStep = jobBlock.slice(
    cacheStart,
    nextStep < 0 ? undefined : nextStep,
  );
  assert.match(
    cacheStep,
    /workspaces:\s*\|\n\s+src-tauri -> target(?:\s|$)/,
    `${jobName} must cache the nested Tauri target directory`,
  );
}

assertRustCacheWorkspace(rustBlock, "Rust job");
assertRustCacheWorkspace(packageBlock, "package job");

// Evaluate the supported subset of GitHub Actions expressions so these
// fixtures exercise the condition extracted from ci.yml, not a second copy of
// the packaging policy. Unsupported syntax fails closed and requires an
// explicit checker update.
function parsePackageCondition(condition) {
  const tokens = [];
  let cursor = 0;

  while (cursor < condition.length) {
    if (/\s/.test(condition[cursor])) {
      cursor += 1;
      continue;
    }

    const remaining = condition.slice(cursor);
    const atoms = [
      [/^github\.event_name\s*==\s*'push'/, { type: "atom", value: "push" }],
      [
        /^github\.event_name\s*==\s*'pull_request'/,
        { type: "atom", value: "pull_request" },
      ],
      [
        /^contains\s*\(\s*github\.event\.pull_request\.labels\.\*\.name\s*,\s*'release-bundle'\s*\)/,
        { type: "atom", value: "release-bundle" },
      ],
    ];
    const atom = atoms
      .map(([pattern, token]) => {
        const match = pattern.exec(remaining);
        return match ? { match, token } : null;
      })
      .find(Boolean);

    if (atom) {
      tokens.push(atom.token);
      cursor += atom.match[0].length;
      continue;
    }

    const operator = [
      ["&&", "and"],
      ["||", "or"],
      ["!", "not"],
      ["(", "left"],
      [")", "right"],
    ].find(([text]) => remaining.startsWith(text));
    assert.ok(operator, `unsupported package condition near: ${remaining}`);
    tokens.push({ type: operator[1] });
    cursor += operator[0].length;
  }

  let index = 0;
  const peek = (type) => tokens[index]?.type === type;
  const consume = (type) => {
    assert.ok(peek(type), `expected ${type} in package condition`);
    return tokens[index++];
  };

  function parsePrimary() {
    if (peek("not")) {
      consume("not");
      return { type: "not", child: parsePrimary() };
    }
    if (peek("left")) {
      consume("left");
      const child = parseOr();
      consume("right");
      return child;
    }
    return { type: "atom", value: consume("atom").value };
  }

  function parseAnd() {
    let node = parsePrimary();
    while (peek("and")) {
      consume("and");
      node = { type: "and", left: node, right: parsePrimary() };
    }
    return node;
  }

  function parseOr() {
    let node = parseAnd();
    while (peek("or")) {
      consume("or");
      node = { type: "or", left: node, right: parseAnd() };
    }
    return node;
  }

  const root = parseOr();
  assert.equal(index, tokens.length, "unexpected trailing package condition");

  function evaluate(node, event) {
    switch (node.type) {
      case "atom":
        if (node.value === "push") return event.name === "push";
        if (node.value === "pull_request") return event.name === "pull_request";
        return event.labels.includes("release-bundle");
      case "not":
        return !evaluate(node.child, event);
      case "and":
        return evaluate(node.left, event) && evaluate(node.right, event);
      case "or":
        return evaluate(node.left, event) || evaluate(node.right, event);
      default:
        throw new Error(
          `unsupported parsed package condition node: ${node.type}`,
        );
    }
  }

  return (event) => evaluate(root, event);
}

const fixtures = [
  {
    name: "push",
    event: { name: "push", labels: [] },
    expected: true,
  },
  {
    name: "labeled",
    event: {
      name: "pull_request",
      action: "labeled",
      labels: ["release-bundle"],
    },
    expected: true,
  },
  {
    name: "labeled without release-bundle",
    event: { name: "pull_request", action: "labeled", labels: ["bug"] },
    expected: false,
  },
  {
    name: "unlabeled release-bundle",
    event: { name: "pull_request", action: "unlabeled", labels: [] },
    expected: false,
  },
];

function assertPackageFixturesMatch(condition) {
  const packageRuns = parsePackageCondition(condition);
  for (const fixture of fixtures) {
    if (fixture.event.name === "pull_request") {
      assert.ok(
        subscribedActions.has(fixture.event.action),
        `pull_request.${fixture.event.action} must start CI`,
      );
    }
    assert.equal(packageRuns(fixture.event), fixture.expected, fixture.name);
  }
}

assertPackageFixturesMatch(packageCondition);

const brokenConjunction = packageCondition.replace(" || ", " && ");
assert.notEqual(brokenConjunction, packageCondition);
assert.throws(
  () => assertPackageFixturesMatch(brokenConjunction),
  /push/,
  "fixtures must reject a broken push/PR conjunction",
);

const brokenNegation = packageCondition.replace(
  "contains(github.event.pull_request.labels.*.name, 'release-bundle')",
  "!contains(github.event.pull_request.labels.*.name, 'release-bundle')",
);
assert.notEqual(brokenNegation, packageCondition);
assert.throws(
  () => assertPackageFixturesMatch(brokenNegation),
  /labeled/,
  "fixtures must reject a negated release-label gate",
);

console.info(
  "CI workflow check passed: PRs package while release-bundle is present, label changes re-evaluate the gate, pushes package, the Rust job uses Node 22, and both Rust caches target src-tauri/target.",
);
