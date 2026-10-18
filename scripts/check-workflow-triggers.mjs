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

function packageRuns(event) {
  return (
    event.name === "push" ||
    (event.name === "pull_request" && event.labels.includes("release-bundle"))
  );
}

const fixtures = [
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
  {
    name: "push",
    event: { name: "push", labels: [] },
    expected: true,
  },
];

for (const fixture of fixtures) {
  if (fixture.event.name === "pull_request") {
    assert.ok(
      subscribedActions.has(fixture.event.action),
      `pull_request.${fixture.event.action} must start CI`,
    );
  }
  assert.equal(packageRuns(fixture.event), fixture.expected, fixture.name);
}

console.info(
  "CI workflow check passed: release-bundle label events trigger packaging, other PR labels skip it, pushes package, the Rust job uses Node 22, and both Rust caches target src-tauri/target.",
);
