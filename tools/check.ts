import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
interface ToolPin {
	readonly version: string;
	readonly resolved_binary?: string;
	readonly binary_sha256?: string;
}

interface ToolchainLock {
	readonly platform: string;
	readonly tools: Record<string, ToolPin>;
	readonly npm_pins: Record<string, string>;
}

interface RootPackage {
	readonly packageManager: string;
	readonly devDependencies: Record<string, string>;
	readonly overrides: Record<string, string>;
}

const toolchain = JSON.parse(
	readFileSync(join(root, "toolchain.lock.json"), "utf8"),
) as ToolchainLock;
const rootPackage = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
) as RootPackage;
const scratch = mkdtempSync(join(tmpdir(), "kts-check-"));
const testHome = join(scratch, "home");
const testTmp = join(scratch, "tmp");
mkdirSync(testHome, { mode: 0o700 });
mkdirSync(testTmp, { mode: 0o700 });
const git = process.env.KTS_CHECK_GIT ?? Bun.which("git");
if (!git) throw new Error("Provision Git before checking");
const env: Record<string, string> = {
	HOME: testHome,
	TMPDIR: `${testTmp}/`,
	XDG_CONFIG_HOME: join(testHome, ".config"),
	XDG_CACHE_HOME: join(testHome, ".cache"),
	XDG_DATA_HOME: join(testHome, ".local/share"),
	PATH: [
		dirname(process.execPath),
		dirname(git),
		join(root, "node_modules/.bin"),
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	].join(":"),
	LC_ALL: "C",
	LANG: "C",
	TZ: "UTC",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "4",
	GIT_CONFIG_KEY_0: "user.name",
	GIT_CONFIG_VALUE_0: "Kogen test fixture",
	GIT_CONFIG_KEY_1: "user.email",
	GIT_CONFIG_VALUE_1: "fixture@example.invalid",
	GIT_CONFIG_KEY_2: "commit.gpgsign",
	GIT_CONFIG_VALUE_2: "false",
	GIT_CONFIG_KEY_3: "core.hooksPath",
	GIT_CONFIG_VALUE_3: "/dev/null",
	KOGEN_CREDENTIAL_STORE: "file",
	BUN_INSTALL_AUTO: "0",
};
function run(argv: string[], capture = false): string {
	const command = argv[0];
	if (!command) throw new Error("Missing check command");
	console.log(`check: ${argv.join(" ")}`);
	const result = spawnSync(command, argv.slice(1), {
		cwd: root,
		env,
		timeout: 300_000,
		maxBuffer: 16 * 1024 * 1024,
		stdio: capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`Check failed: ${command} (${result.status})`);
	return result.stdout?.toString().trim() ?? "";
}
try {
	const bunPin = toolchain.tools.bun;
	const gitPin = toolchain.tools.git;
	if (!bunPin || !gitPin)
		throw new Error("Toolchain lock must pin Bun and Git");
	if (Bun.version !== bunPin.version)
		throw new Error(`Expected Bun ${bunPin.version}, got ${Bun.version}`);
	if (rootPackage.packageManager !== `bun@${bunPin.version}`)
		throw new Error(`packageManager must pin bun@${bunPin.version}`);
	for (const [name, version] of Object.entries(toolchain.npm_pins)) {
		const declared =
			rootPackage.devDependencies[name] ?? rootPackage.overrides[name];
		if (declared !== version)
			throw new Error(`package.json must pin ${name} ${version}`);
		const installed = await Bun.file(
			join(root, "node_modules", name, "package.json"),
		).json();
		if (installed.version !== version)
			throw new Error(`Expected ${name} ${version}, got ${installed.version}`);
	}
	if (run([git, "--version"], true) !== gitPin.version)
		throw new Error(`Expected provisioned ${gitPin.version}`);
	const hostPlatform = `${process.platform}-${process.arch}`;
	if (toolchain.platform === hostPlatform) {
		for (const [name, path, expectedHash] of [
			["bun", process.execPath, bunPin.binary_sha256],
			["git", git, gitPin.binary_sha256],
		] as const) {
			if (!expectedHash)
				throw new Error(`Toolchain lock is missing ${name} binary hash`);
			const actualHash = createHash("sha256")
				.update(readFileSync(realpathSync(path)))
				.digest("hex");
			if (actualHash !== expectedHash)
				throw new Error(`${name} binary does not match toolchain.lock.json`);
		}
	} else {
		console.log(
			`check: binary hashes not asserted for host ${hostPlatform}; lock records ${toolchain.platform}`,
		);
	}
	const biome = join(root, "node_modules/@biomejs/biome/bin/biome");
	run([process.execPath, "--no-install", biome, "check", "."]);
	run([
		process.execPath,
		"--no-install",
		join(root, "node_modules/typescript/bin/tsc"),
		"--noEmit",
	]);
	run(["/bin/bash", "-n", "tools/kdispatch-ts.sh"]);
	run([process.execPath, "--no-install", "tools/freeze.ts", "--check"]);
	run([process.execPath, "--no-install", "tools/dispatch.ts", "--check"]);
	const nativeSources = readdirSync(join(root, "native")).filter((name) =>
		name.endsWith(".c"),
	);
	for (const name of nativeSources) {
		run([
			"/usr/bin/cc",
			"-std=c17",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-I",
			"native",
			"-c",
			join("native", name),
			"-o",
			join(scratch, `${name}.o`),
		]);
	}
	// Packet 02 owns executable helper linking/runtime tests. Every C translation
	// unit is warning-clean immediately; no placeholder helper passes a product test.
	writeFileSync(join(testHome, ".gitconfig"), "");
	run([
		process.execPath,
		"--no-install",
		"test",
		"--max-concurrency",
		"1",
		"./tests",
	]);
	console.log(
		"make check: PASS (format, lint, types, shell, native units, isolated tests)",
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
