import { expect, test } from "bun:test";
import movedFormsData from "../../packages/cli/data/moved.json" with {
	type: "json",
};
import { parseArgv } from "../../packages/cli/src/argv";

const cwd = "/tmp/cli-project";

const grammarCases = [
	{
		name: "empty argv selects the top help page",
		argv: [],
		kind: "help",
		page: "kogen",
	},
	{
		name: "a bare group selects its group page",
		argv: ["provider"],
		kind: "help",
		page: "kogen-provider",
	},
	{
		name: "unknown root token precedes option interpretation",
		argv: ["--json", "status"],
		kind: "usage-error",
		message: "kogen: unknown command '--json'",
		page: "kogen",
	},
	{
		name: "unknown subcommand uses the group page",
		argv: ["intent", "frob", "--help"],
		kind: "usage-error",
		message: "kogen intent: unknown command 'frob'",
		page: "kogen-intent",
	},
	{
		name: "help rejects its first following token",
		argv: ["help", "intent", "frob"],
		kind: "usage-error",
		message: "kogen help: unexpected argument 'intent'",
		page: "kogen",
	},
	{
		name: "moved forms beat tree and help handling",
		argv: ["--version", "--help"],
		kind: "moved",
		message: "kogen version",
	},
	{
		name: "moved flags match attached values",
		argv: ["intent", "shape", "greet", "--task-file=request.md"],
		kind: "moved",
		message: "kogen intent shape <slug> <file>",
	},
	{
		name: "moved --as wording applies outside the provider group",
		argv: ["status", "--as", "work"],
		kind: "moved",
		message: "kogen provider use chatgpt --as <label> --project <checkout>",
	},
	{
		name: "provider login rejects the route-disallowed --as option",
		argv: ["provider", "login", "chatgpt", "--as"],
		kind: "usage-error",
		message: "kogen provider login: unknown option '--as'",
		page: "kogen-provider-login",
	},
	{
		name: "unknown option precedes missing positionals",
		argv: ["intent", "approve", "--bogus"],
		kind: "usage-error",
		message: "kogen intent approve: unknown option '--bogus'",
		page: "kogen-intent-approve",
	},
	{
		name: "missing option value is reported before positionals",
		argv: ["status", "--project"],
		kind: "usage-error",
		message: "kogen status: --project needs a value",
		page: "kogen-status",
	},
	{
		name: "booleans reject attached values",
		argv: ["status", "--json=true"],
		kind: "usage-error",
		message: "kogen status: --json takes no value",
		page: "kogen-status",
	},
	{
		name: "a disallowed boolean with an attached value still rejects the value",
		argv: ["intent", "shape", "greet", "-", "--json=false"],
		kind: "usage-error",
		message: "kogen intent shape: --json takes no value",
		page: "kogen-intent-shape",
	},
	{
		name: "a bare disallowed boolean remains an unknown option",
		argv: ["intent", "shape", "greet", "-", "--json"],
		kind: "usage-error",
		message: "kogen intent shape: unknown option '--json'",
		page: "kogen-intent-shape",
	},
	{
		name: "missing required positional precedes values",
		argv: ["provider", "login"],
		kind: "usage-error",
		message: "kogen provider login: missing <provider>",
		page: "kogen-provider-login",
	},
	{
		name: "extra positional is rejected",
		argv: ["version", "extra"],
		kind: "usage-error",
		message: "kogen version: unexpected argument 'extra'",
		page: "kogen-version",
	},
	{
		name: "provider validation names both providers",
		argv: ["provider", "login", "Claude"],
		kind: "usage-error",
		message:
			"kogen provider login: unknown provider 'Claude' (supported: chatgpt, grok)",
		page: "kogen-provider-login",
	},
	{
		name: "hash values accept six through sixty-four lowercase hex characters",
		argv: ["intent", "approve", "Odd_Slug", "abcdef"],
		kind: "command",
		command: {
			name: "intent approve",
			project: cwd,
			slug: "Odd_Slug",
			hash: "abcdef",
		},
	},
	{
		name: "hash values reject uppercase or short forms",
		argv: ["intent", "approve", "greet", "abcde"],
		kind: "usage-error",
		message:
			"kogen intent approve: <hash> must be 6 to 64 lowercase hex characters",
		page: "kogen-intent-approve",
	},
	{
		name: "watch and json conflict after positional parsing",
		argv: ["status", "greet", "--watch", "--json"],
		kind: "usage-error",
		message: "kogen status: --watch and --json can't be combined",
		page: "kogen-status",
	},
	{
		name: "double dash preserves option-looking positional bytes",
		argv: ["status", "--", "--json"],
		kind: "command",
		command: {
			name: "status",
			project: cwd,
			slug: "--json",
			watch: false,
			json: false,
		},
	},
	{
		name: "options can follow positionals and repeated values are last-wins",
		argv: [
			"status",
			"greet",
			"--project",
			"/first",
			"--project=/last",
			"--origin",
			"origin",
		],
		kind: "command",
		command: {
			name: "status",
			project: "/last",
			origin: `${cwd}/origin`,
			slug: "greet",
			watch: false,
			json: false,
		},
	},
	{
		name: "provider use accepts Grok and requires an account label",
		argv: ["provider", "use", "grok", "--as", "work"],
		kind: "command",
		command: {
			name: "provider use",
			provider: "grok",
			account: "work",
		},
	},
	{
		name: "provider use reports a missing account label",
		argv: ["provider", "use", "chatgpt"],
		kind: "usage-error",
		message: "kogen provider use: missing --as <label>",
		page: "kogen-provider-use",
	},
	{
		name: "provider use resolves an explicit project against cwd",
		argv: ["provider", "use", "chatgpt", "--as", "work", "--project", "repo"],
		kind: "command",
		command: {
			name: "provider use",
			provider: "chatgpt",
			account: "work",
			project: `${cwd}/repo`,
		},
	},
];

for (const grammarCase of grammarCases) {
	test(`CLI grammar: ${grammarCase.name}`, () => {
		const { name: _name, argv, ...expected } = grammarCase;
		const result = parseArgv(argv, { cwd });
		expect(result).toMatchObject(expected);
	});
}

interface MovedRow {
	readonly match: "prefix" | "flag" | "flag_outside_provider";
	readonly form: string;
	readonly message: string;
}

const movedRows = (
	movedFormsData as unknown as { readonly rows: readonly MovedRow[] }
).rows;

for (const row of movedRows) {
	test(`moved-form table: ${row.form}`, () => {
		const argv =
			row.match === "prefix"
				? row.form.split(" ")
				: ["status", `${row.form}=fixture`];
		expect(parseArgv(argv)).toEqual({ kind: "moved", message: row.message });
	});
}
