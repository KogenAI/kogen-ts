import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

interface SourceRecord {
	readonly commit: string;
	readonly diff_sha256: string | null;
	readonly working_content?: boolean;
	readonly source_status_at_freeze?: string;
}

interface FreezeManifest {
	readonly schema: number;
	readonly target: string;
	readonly files_sha256: Record<string, string>;
	readonly sources: {
		readonly "kogen-spec": SourceRecord;
		readonly "kogen-conformance": SourceRecord;
	};
	readonly excluded_ignored_artifacts?: Record<
		string,
		{ readonly sha256: string; readonly reason: string }
	>;
}

const root = resolve(import.meta.dir, "..");
const bundleRoot = resolve(root, "spec-lock");
const expectedManifestHash =
	"0a87fe0ef2ce82f61fef6e6da063622e25a1fda54dff1c229c6cc30c451437c5";
const expectedChangesHash =
	"848b40d20be1900494302d318f4b6b106daa37279d4796212a75ec5242b99840";
const expectedCliRuleHash =
	"7d47a2e26be97f5ced44eaaed4ccae8d7369805337b55a262f27d92e1f544edc";
const expectedExcluded = {
	"kogen-spec/quint/slices/approve/attempts.log":
		"7f28187e43ce21278e37d30985f9eeb85cc30207fd1f65e0670302a6dfd41116",
	"kogen-spec/quint/slices/resilience/attempts.log":
		"d2a442c903868e63f93e619ac426558ecba83c079a346f520688bd638e3a6805",
} as const;
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
	throw new Error("Usage: tools/freeze.ts [--check]");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const manifestPath = resolve(bundleRoot, "manifest.json");
assert(
	sha256(readFileSync(manifestPath)) === expectedManifestHash,
	"Source manifest hash changed from the frozen inventory",
);
const manifest = JSON.parse(
	readFileSync(manifestPath, "utf8"),
) as FreezeManifest;
assert(manifest.schema === 1, "Unsupported source manifest schema");
assert(manifest.target === "v1.3-draft", "Frozen target is not v1.3-draft");
assert(
	manifest.sources["kogen-spec"].commit ===
		"e19dd1c21c19c5be1201c3b6a42c59c28b5c2887",
	"Frozen spec commit is not e19dd1c",
);
assert(
	manifest.sources["kogen-spec"].working_content,
	"Spec working tree was not frozen",
);
assert(
	manifest.sources["kogen-spec"].diff_sha256 ===
		"1fa72f5df8725013ffad3a258d7f851dcb38b187ae06727880b47db2f6b64378",
	"Spec working-tree diff hash changed",
);
assert(
	manifest.files_sha256["kogen-spec.diff"] ===
		manifest.sources["kogen-spec"].diff_sha256,
	"Spec diff hash disagrees with the captured file inventory",
);
assert(
	manifest.sources["kogen-conformance"].commit ===
		"0f93bad988fb8d7a8eff4e94954d1db0a046c89d",
	"Frozen conformance suite revision changed",
);

assert(
	manifest.files_sha256["kogen-spec/CHANGES-v1.3.md"] === expectedChangesHash,
	"CHANGES-v1.3.md hash changed from the frozen draft",
);
assert(
	manifest.files_sha256["kogen-spec/CLI-RULE.txt"] === expectedCliRuleHash,
	"CLI-RULE.txt hash changed from the frozen command contract",
);
assert(
	Object.keys(manifest.files_sha256).length === 896,
	"Frozen source file inventory count changed",
);
let verifiedFiles = 0;
for (const [relativePath, expectedHash] of Object.entries(
	manifest.files_sha256,
)) {
	assert(
		!isAbsolute(relativePath),
		`Absolute source path is forbidden: ${relativePath}`,
	);
	const filePath = resolve(bundleRoot, relativePath);
	assert(
		filePath.startsWith(`${bundleRoot}${sep}`),
		`Source path escapes spec-lock: ${relativePath}`,
	);
	const info = lstatSync(filePath);
	assert(info.isFile(), `Frozen source is not a regular file: ${relativePath}`);
	const actualHash = sha256(readFileSync(filePath));
	assert(
		actualHash === expectedHash,
		`Frozen source hash mismatch: ${relativePath} expected=${expectedHash} actual=${actualHash}`,
	);
	verifiedFiles += 1;
}

const excluded = Object.entries(manifest.excluded_ignored_artifacts ?? {});
assert(
	excluded.length === Object.keys(expectedExcluded).length,
	"Excluded log inventory changed",
);
for (const [relativePath, artifact] of excluded) {
	assert(
		relativePath.endsWith("/attempts.log"),
		`Unexpected excluded artifact: ${relativePath}`,
	);
	assert(
		/^[a-f0-9]{64}$/.test(artifact.sha256),
		`Invalid excluded hash: ${relativePath}`,
	);
	assert(
		artifact.sha256 ===
			expectedExcluded[relativePath as keyof typeof expectedExcluded],
		`Excluded log hash changed: ${relativePath}`,
	);
	assert(
		artifact.reason.length > 0,
		`Excluded artifact needs a reason: ${relativePath}`,
	);
	const filePath = resolve(bundleRoot, relativePath);
	assert(
		filePath.startsWith(`${bundleRoot}${sep}`),
		`Excluded path escapes spec-lock: ${relativePath}`,
	);
	let excludedExists = false;
	try {
		lstatSync(filePath);
		excludedExists = true;
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	assert(
		!excludedExists,
		`Excluded generated artifact unexpectedly exists: ${relativePath}`,
	);
}

console.log(
	`Input freeze: PASS target=v1.3-draft source=e19dd1c files=${verifiedFiles} CHANGES-v1.3.sha256=${expectedChangesHash} excluded-ignored-logs=${excluded.length}`,
);
