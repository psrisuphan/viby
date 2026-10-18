import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src", "bindings.ts");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "viby-ipc-bindings-"));
const generated = path.join(tempDir, "bindings.ts");
const write = process.argv.includes("--write");

try {
	const result = spawnSync(
		"cargo",
		[
			"run",
			"--quiet",
			"--manifest-path",
			"src-tauri/Cargo.toml",
			"--bin",
			"export_ipc_bindings",
			"--",
			generated,
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);

	if (write) {
		copyFileSync(generated, target);
		console.log("Updated src/bindings.ts from the Rust IPC contract.");
	} else if (readFileSync(generated, "utf8") !== readFileSync(target, "utf8")) {
		console.error("src/bindings.ts is stale. Run npm run generate:ipc-bindings.");
		process.exitCode = 1;
	} else {
		console.log("src/bindings.ts matches the Rust IPC contract.");
	}
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
