import type { CheckSpec } from "../../project/schema";

export type RailsAdapterName = "command" | "exunit" | "rails";

export const RAILS_SOURCE_DIRECTORY = ".kogen/acceptance";
export const RAILS_CANDIDATE_DIRECTORY = "test/acceptance";
export const RAILS_TEST_SUFFIX = "_test.rb";
export const RAILS_BUNDLE_PATH = "vendor/bundle";
export const RAILS_ENVIRONMENT = "test";

export const RAILS_SEED_DIRECTORIES = ["vendor/cache"] as const;
export const RAILS_GATE_PATHS = [
	"Gemfile",
	"Gemfile.lock",
	"bin/rails",
	".standard.yml",
	".rubocop.yml",
] as const;

export const RAILS_SETUP_CHECKS: readonly CheckSpec[] = [
	{
		name: "rails-bundle-install",
		argv: ["bundle", "install", "--local"],
		timeoutMs: 600_000,
	},
];

/** Rails is selected only when both frozen discovery markers are present. */
export function hasRailsProjectMarkers(paths: Iterable<string>): boolean {
	const files = new Set(paths);
	return files.has("Gemfile") && files.has("config/application.rb");
}

/** An explicitly configured adapter takes precedence over stack detection. */
export function selectAcceptanceAdapter(
	paths: Iterable<string>,
	configured?: RailsAdapterName,
): RailsAdapterName {
	if (configured !== undefined) return configured;
	return hasRailsProjectMarkers(paths) ? "rails" : "exunit";
}

/** Force Rails' offline bundle and test environment after inherited project values. */
export function railsChildEnvironment(
	base: Readonly<Record<string, string>>,
): Record<string, string> {
	const environment: Record<string, string> = Object.create(null);
	for (const [name, value] of Object.entries(base)) environment[name] = value;
	environment.BUNDLE_PATH = RAILS_BUNDLE_PATH;
	environment.RAILS_ENV = RAILS_ENVIRONMENT;
	return environment;
}
