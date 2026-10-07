export interface ScopeWarning {
	readonly path: string;
	readonly declaredDomains: readonly string[];
}

function compareUtf8(left: string, right: string): number {
	const encoder = new TextEncoder();
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function cleanPrefix(prefix: string): string | null {
	if (
		prefix.startsWith("/") ||
		prefix.includes("\\") ||
		prefix.includes("\0") ||
		prefix.split("/").some((part) => part === ".." || part === ".")
	)
		return null;
	return prefix.replace(/\/$/u, "");
}

function isWithin(path: string, prefix: string): boolean {
	if (prefix.length === 0) return true;
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Report changed paths outside the Intent's declared domains. These warnings
 * are advice only and must never change gate status, score, or landing choice.
 */
export function scopeWarnings(
	changedPaths: readonly string[],
	intentDomains: readonly string[],
	domainPaths: ReadonlyMap<string, readonly string[]>,
): readonly ScopeWarning[] {
	const declaredDomains = [...new Set(intentDomains)].sort(compareUtf8);
	const roots: string[] = [];
	for (const domain of declaredDomains) {
		for (const rawPrefix of domainPaths.get(domain) ?? []) {
			const prefix = cleanPrefix(rawPrefix);
			if (prefix !== null) roots.push(prefix);
		}
	}
	const uniqueRoots = [...new Set(roots)];
	return [...new Set(changedPaths)]
		.sort(compareUtf8)
		.filter((path) => !uniqueRoots.some((prefix) => isWithin(path, prefix)))
		.map((path) => ({ path, declaredDomains }));
}
