import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostHelperName } from "../packages/core/src/process/host";

const root = resolve(import.meta.dir, "..");
const destination = resolve(process.argv[2] ?? join(root, "dist"));
function run(argv: string[], capture = false): string {
	const executable = argv[0];
	if (!executable) throw new Error("Missing build executable");
	const result = spawnSync(executable, argv.slice(1), {
		cwd: root,
		timeout: 120_000,
		encoding: "utf8",
		stdio: capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Build failed: ${argv.join(" ")}`);
	return result.stdout?.trim() ?? "";
}
mkdirSync(destination, { recursive: true, mode: 0o700 });
run([
	"/usr/bin/cc",
	"-std=c17",
	"-Wall",
	"-Wextra",
	"-Werror",
	"-I",
	"native",
	"native/main.c",
	"native/protocol.c",
	"native/paths.c",
	"native/read.c",
	"native/publish.c",
	"native/supervisor.c",
	"-o",
	join(destination, hostHelperName()),
]);
const sha = run(["git", "rev-parse", "--short=8", "HEAD"], true);
const date = run(["git", "show", "-s", "--format=%cs", "HEAD"], true);
const dirty = run(["git", "status", "--porcelain"], true).length > 0;
const version = `kogen ${sha} (${date}${dirty ? ", uncommitted changes" : ""})`;
run([
	process.execPath,
	"--no-install",
	"build",
	"--compile",
	"packages/cli/src/main.ts",
	"--define",
	`KOGEN_BUILD_VERSION=${JSON.stringify(version)}`,
	"--outfile",
	join(destination, "kogen"),
]);
