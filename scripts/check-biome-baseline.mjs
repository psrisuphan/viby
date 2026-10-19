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

const stdout = (result.stdout ?? "").trim();
let report;
try {
  report = JSON.parse(stdout);
} catch (error) {
  console.error(`Biome returned invalid JSON: ${error.message}`);
  console.error(stdout);
  console.error(result.stderr ?? "");
  process.exit(1);
}

function failReport(message) {
  console.error(message);
  console.error(stdout);
  console.error(result.stderr ?? "");
  process.exit(1);
}

const summary = report.summary;
if (
  report.command !== "check" ||
  !summary ||
  !Array.isArray(report.diagnostics)
) {
  failReport("Biome returned an incomplete check report.");
}

const severities = ["errors", "warnings", "infos"];
for (const severity of severities) {
  if (!Number.isSafeInteger(summary[severity]) || summary[severity] < 0) {
    failReport(`Biome returned an invalid ${severity} count.`);
  }
}
if (summary.diagnosticsNotPrinted !== 0) {
  failReport("Biome's JSON report omitted diagnostics.");
}

const reportedCounts = { error: 0, warning: 0, info: 0 };
for (const diagnostic of report.diagnostics) {
  if (
    !diagnostic ||
    typeof diagnostic.category !== "string" ||
    typeof diagnostic.severity !== "string" ||
    !Object.hasOwn(reportedCounts, diagnostic.severity)
  ) {
    failReport("Biome returned a malformed diagnostic entry.");
  }
  reportedCounts[diagnostic.severity]++;
}
if (
  reportedCounts.error !== summary.errors ||
  reportedCounts.warning !== summary.warnings ||
  reportedCounts.info !== summary.infos
) {
  failReport("Biome's summary counts do not match its diagnostic entries.");
}
if ((result.status === 0) !== (summary.errors === 0)) {
  failReport("Biome's exit status does not match its reported error count.");
}

// Biome's JSON reporter writes its report to stdout and a fixed text summary to
// stderr. Reject anything else there, including a config/runtime error emitted
// after an otherwise parseable report.
const stderrLines = (result.stderr ?? "").replace(/\r\n/g, "\n").split("\n");
const reporterNotice =
  "The `json` and `json-pretty` reporters are experimental and may change in patch releases.";
if (stderrLines[0] === reporterNotice) stderrLines.shift();
const stderrSummary = stderrLines
  .join("\n")
  .replace(/[ \t]+\n/g, "\n")
  .trim();
const expectedErrorSummary =
  /^check ━+\n\n {2}× Some errors were emitted while running checks\.$/.test(
    stderrSummary,
  );
if (summary.errors > 0 ? !expectedErrorSummary : stderrSummary.length > 0) {
  failReport("Biome emitted unexpected output outside its JSON diagnostics.");
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
