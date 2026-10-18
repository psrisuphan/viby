import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const biome = resolve(root, "node_modules", ".bin", "biome");
const result = spawnSync(biome, ["check", "--reporter=json", "."], {
  cwd: root,
  encoding: "utf8",
});

if (result.error) {
  console.error(`Could not run Biome: ${result.error.message}`);
  process.exit(1);
}
if (result.signal || result.status === null) {
  console.error(
    `Biome did not finish normally${result.signal ? ` (signal ${result.signal})` : ""}.`,
  );
  process.stderr.write(result.stderr ?? "");
  process.stdout.write(result.stdout ?? "");
  process.exit(1);
}
if (result.status !== 0 && result.status !== 1) {
  console.error(`Biome exited unexpectedly with status ${result.status}.`);
  process.stderr.write(result.stderr ?? "");
  process.stdout.write(result.stdout ?? "");
  process.exit(1);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const jsonStart = output.indexOf('{"summary":');
if (jsonStart < 0) {
  console.error(output);
  console.error("Biome did not return its expected JSON report.");
  process.exit(1);
}

let depth = 0;
let inString = false;
let escaped = false;
let jsonEnd = -1;
for (let index = jsonStart; index < output.length; index++) {
  const character = output[index];
  if (inString) {
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') inString = false;
    continue;
  }
  if (character === '"') inString = true;
  else if (character === "{") depth++;
  else if (character === "}" && --depth === 0) {
    jsonEnd = index + 1;
    break;
  }
}
if (jsonEnd < 0) {
  console.error(output);
  console.error("Biome returned malformed JSON.");
  process.exit(1);
}

let report;
try {
  report = JSON.parse(output.slice(jsonStart, jsonEnd));
} catch (error) {
  console.error(`Biome returned invalid JSON: ${error.message}`);
  console.error(output);
  process.exit(1);
}
if (!report.summary || !Array.isArray(report.diagnostics)) {
  console.error("Biome's JSON report is missing its summary or diagnostics.");
  console.error(output);
  process.exit(1);
}
const baseline = JSON.parse(
  readFileSync(resolve(root, "scripts/biome-baseline.json"), "utf8"),
);
const actualCounts = new Map();
for (const diagnostic of report.diagnostics) {
  actualCounts.set(
    diagnostic.category,
    (actualCounts.get(diagnostic.category) ?? 0) + 1,
  );
}

const regressions = [];
for (const [category, actual] of actualCounts) {
  const allowed = baseline.diagnosticsByCategory[category] ?? 0;
  if (actual > allowed) regressions.push({ category, actual, allowed });
}

if (regressions.length > 0) {
  console.error(
    "Frontend lint/format diagnostics exceed the recorded baseline:",
  );
  for (const regression of regressions) {
    console.error(
      `  ${regression.category}: ${regression.actual} (baseline ${regression.allowed})`,
    );
  }
  process.exit(1);
}

const total = [...actualCounts.values()].reduce((sum, count) => sum + count, 0);
const baselineTotal = Object.values(baseline.diagnosticsByCategory).reduce(
  (sum, count) => sum + count,
  0,
);
console.log(
  `Frontend diagnostics: ${total}; recorded baseline: ${baselineTotal}.`,
);
