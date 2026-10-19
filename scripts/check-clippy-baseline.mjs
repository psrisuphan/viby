import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const result = spawnSync(
  "cargo",
  [
    "clippy",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--lib",
    "--locked",
    "--message-format=json",
    "--",
    "-W",
    "clippy::all",
  ],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  },
);

if (result.error) {
  console.error(`Could not run Clippy: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.stderr.write(result.stdout ?? "");
  process.exit(result.status ?? 1);
}

const diagnostics = (result.stdout ?? "")
  .split(String.fromCharCode(10))
  .filter(Boolean)
  .flatMap((line) => {
    try {
      const message = JSON.parse(line);
      return message.reason === "compiler-message" ? [message.message] : [];
    } catch {
      return [];
    }
  });

const actualCounts = new Map();
for (const diagnostic of diagnostics) {
  const code = diagnostic.code?.code;
  if (diagnostic.level === "warning" && code?.startsWith("clippy::")) {
    actualCounts.set(code, (actualCounts.get(code) ?? 0) + 1);
  }
}

const baseline = JSON.parse(
  readFileSync(resolve(root, "scripts/clippy-baseline.json"), "utf8"),
);
const regressions = [];
for (const [lint, actual] of actualCounts) {
  const allowed = baseline.diagnosticsByLint[lint] ?? 0;
  if (actual > allowed) regressions.push({ lint, actual, allowed });
}

if (regressions.length > 0) {
  console.error("Clippy diagnostics exceed the recorded baseline:");
  for (const regression of regressions) {
    console.error(
      `  ${regression.lint}: ${regression.actual} (baseline ${regression.allowed})`,
    );
  }
  const regressedLints = new Set(regressions.map(({ lint }) => lint));
  for (const diagnostic of diagnostics) {
    if (regressedLints.has(diagnostic.code?.code) && diagnostic.rendered) {
      process.stderr.write(diagnostic.rendered);
    }
  }
  process.exit(1);
}

const total = [...actualCounts.values()].reduce((sum, count) => sum + count, 0);
const baselineTotal = Object.values(baseline.diagnosticsByLint).reduce(
  (sum, count) => sum + count,
  0,
);
console.log(
  `Clippy diagnostics: ${total}; recorded baseline: ${baselineTotal}.`,
);
