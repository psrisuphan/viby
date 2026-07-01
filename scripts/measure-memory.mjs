import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const appDir = process.argv[2] ?? process.cwd();
const route = process.argv[3] ?? "/?vibyTest=home";
const port = Number(process.argv[4] ?? 4173);
const chromePath = process.env.CHROME_PATH ?? "google-chrome";

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			...options,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
			}
		});
	});
}

async function waitForPreview(child) {
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});

	for (let i = 0; i < 80; i += 1) {
		if (output.includes(`:${port}`) || output.includes("Local:")) return;
		if (child.exitCode !== null) {
			throw new Error(`preview exited early\n${output}`);
		}
		await wait(100);
	}
	throw new Error(`preview did not start\n${output}`);
}

async function descendants(pid) {
	const { stdout } = await run("ps", ["-eo", "pid=,ppid=,rss=,comm=,args="]);
	const rows = stdout
		.trim()
		.split("\n")
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
			if (!match) return null;
			return {
				pid: Number(match[1]),
				ppid: Number(match[2]),
				rssKb: Number(match[3]),
				comm: match[4],
				args: match[5] ?? "",
			};
		})
		.filter(Boolean);

	const byParent = new Map();
	for (const row of rows) {
		const list = byParent.get(row.ppid) ?? [];
		list.push(row);
		byParent.set(row.ppid, list);
	}

	const found = [];
	const stack = [pid];
	while (stack.length > 0) {
		const current = stack.pop();
		for (const child of byParent.get(current) ?? []) {
			found.push(child);
			stack.push(child.pid);
		}
	}
	return rows.filter((row) => row.pid === pid).concat(found);
}

function chromeProcessType(proc, rootPid) {
	if (proc.pid === rootPid) return "browser";
	const type = proc.args.match(/--type=([^\s]+)/)?.[1];
	if (type) return type;
	if (proc.comm === "cat") return "stdio-helper";
	return "unknown";
}

async function main() {
	const userDataDir = await mkdtemp(path.join(tmpdir(), "viby-chrome-"));
	const preview = spawn(
		"npm",
		[
			"run",
			"preview",
			"--",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--strictPort",
		],
		{ cwd: appDir, stdio: ["ignore", "pipe", "pipe"] },
	);

	let chrome;
	try {
		await waitForPreview(preview);
		chrome = spawn(
			chromePath,
			[
				"--headless=new",
				"--disable-background-networking",
				"--disable-default-apps",
				"--disable-extensions",
				"--disable-features=Translate,MediaRouter",
				"--disable-sync",
				"--enable-precise-memory-info",
				"--no-first-run",
				"--no-sandbox",
				`--user-data-dir=${userDataDir}`,
				`http://127.0.0.1:${port}${route}`,
			],
			{ stdio: ["ignore", "ignore", "ignore"] },
		);

		await wait(4000);
		const processes = await descendants(chrome.pid);
		const totalRssKb = processes.reduce((sum, proc) => sum + proc.rssKb, 0);
		const typedProcesses = processes.map((proc) => ({
			...proc,
			type: chromeProcessType(proc, chrome.pid),
		}));
		const rendererRssKb = typedProcesses
			.filter((proc) => proc.type === "renderer")
			.reduce((sum, proc) => sum + proc.rssKb, 0);
		const pageRenderers = typedProcesses.filter(
			(proc) => proc.type === "renderer" && !proc.args.includes("--extension-process"),
		);
		const pageRendererRssKb = pageRenderers.reduce(
			(sum, proc) => sum + proc.rssKb,
			0,
		);
		const largestPageRendererRssKb = pageRenderers.reduce(
			(max, proc) => Math.max(max, proc.rssKb),
			0,
		);
		const byType = Object.values(
			typedProcesses.reduce((acc, proc) => {
				const current = acc[proc.type] ?? {
					type: proc.type,
					count: 0,
					rssKb: 0,
				};
				current.count += 1;
				current.rssKb += proc.rssKb;
				acc[proc.type] = current;
				return acc;
			}, {}),
		).map((entry) => ({
			type: entry.type,
			count: entry.count,
			rssMb: Number((entry.rssKb / 1024).toFixed(1)),
		}));

		console.log(
			JSON.stringify(
				{
					appDir,
					route,
					totalRssMb: Number((totalRssKb / 1024).toFixed(1)),
					chromeTreeProcessCount: processes.length,
					rendererRssMb: Number((rendererRssKb / 1024).toFixed(1)),
					pageRendererRssMb: Number((pageRendererRssKb / 1024).toFixed(1)),
					largestPageRendererRssMb: Number(
						(largestPageRendererRssKb / 1024).toFixed(1),
					),
					byType,
					processes: typedProcesses.map((proc) => ({
						pid: proc.pid,
						rssMb: Number((proc.rssKb / 1024).toFixed(1)),
						type: proc.type,
						comm: proc.comm,
						args: proc.args,
					})),
				},
				null,
				2,
			),
		);
	} finally {
		if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
		if (preview.exitCode === null) preview.kill("SIGTERM");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await rm(userDataDir, { recursive: true, force: true });
				break;
			} catch (error) {
				if (attempt === 4) throw error;
				await wait(250);
			}
		}
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
