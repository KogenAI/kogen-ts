import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [pkg, worktree, base] = process.argv.slice(2);
if (!pkg || !worktree || !base)
	throw new Error("Usage: dispatch-scope <pkg> <worktree> <base>");
const root = join(import.meta.dir, "..");
interface Packet {
	name: string;
	id: string;
	owned: string;
}
const packets: Packet[] = JSON.parse(
	readFileSync(join(root, "docs/work/packages.json"), "utf8"),
);
const packet = packets.find((entry) => entry.name === pkg);
if (!packet) throw new Error(`Unknown package ${pkg}`);
function expand(pattern: string): string[] {
	const match = /\{([^{}]+)\}/.exec(pattern);
	if (!match || match.index === undefined) return [pattern];
	return (
		match[1]
			?.split(",")
			.flatMap((part) =>
				expand(
					pattern.slice(0, match.index) +
						part +
						pattern.slice(match.index + match[0].length),
				),
			) ?? []
	);
}
function matches(path: string, pattern: string): boolean {
	if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
	const regex = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${regex}$`).test(path);
}
const patterns = packet.owned.split("; ").flatMap(expand);
if (packet.id === "00" && patterns.includes("Root manifests/config/Makefile")) {
	patterns.splice(
		patterns.indexOf("Root manifests/config/Makefile"),
		1,
		"package.json",
		"bun.lock",
		"bunfig.toml",
		"tsconfig.json",
		"biome.json",
		"mise.toml",
		"toolchain.lock.json",
		"Makefile",
		".gitignore",
	);
}
patterns.push(`docs/work/receipts/${pkg}.md`);
const diff = spawnSync(
	"git",
	["-C", worktree, "diff", "--name-only", "-z", `${base}...HEAD`],
	{ encoding: "utf8", timeout: 30_000 },
);
if (diff.error) throw diff.error;
if (diff.status !== 0) throw new Error(diff.stderr);
const outside = diff.stdout
	.split("\0")
	.filter(Boolean)
	.filter((path) => !patterns.some((pattern) => matches(path, pattern)));
if (outside.length)
	throw new Error(`Out-of-scope changes: ${outside.join(", ")}`);
console.log(`Scope OK: ${pkg}`);
