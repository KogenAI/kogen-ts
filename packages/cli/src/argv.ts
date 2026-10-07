import { resolve } from "node:path";
import movedFormsData from "../data/moved.json" with { type: "json" };
import type { HelpPage } from "./output";

type OptionKind = "boolean" | "value";

export type Provider = "chatgpt" | "grok";

export interface ProjectOptions {
	readonly project: string;
	readonly origin?: string;
	readonly base?: string;
}

export type ParsedCommand =
	| ({
			readonly name: "status";
			readonly watch: boolean;
			readonly json: boolean;
			readonly slug?: string;
	  } & ProjectOptions)
	| ({
			readonly name: "intent shape";
			readonly slug: string;
			readonly file: string;
	  } & ProjectOptions)
	| ({
			readonly name: "intent approve";
			readonly slug: string;
			readonly hash?: string;
			readonly by?: string;
	  } & ProjectOptions)
	| ({
			readonly name: "intent remove";
			readonly slug: string;
			readonly force: boolean;
	  } & ProjectOptions)
	| ({
			readonly name: "queue start";
			readonly detach: boolean;
	  } & ProjectOptions)
	| ({ readonly name: "queue stop" } & ProjectOptions)
	| { readonly name: "provider list" }
	| { readonly name: "provider login"; readonly provider: Provider }
	| { readonly name: "provider logout"; readonly provider: Provider }
	| {
			readonly name: "provider use";
			readonly provider: Provider;
			readonly account: string;
			readonly project?: string;
	  }
	| { readonly name: "version" };

export type ArgvResult =
	| { readonly kind: "command"; readonly command: ParsedCommand }
	| { readonly kind: "help"; readonly page: HelpPage }
	| {
			readonly kind: "usage-error";
			readonly message: string;
			readonly page: HelpPage;
	  }
	| { readonly kind: "moved"; readonly message: string };

interface MovedRow {
	readonly match: "prefix" | "flag" | "flag_outside_provider";
	readonly form: string;
	readonly message: string;
}

interface MovedFormsFile {
	readonly format: string;
	readonly exit: number;
	readonly rows: readonly MovedRow[];
}

interface Route {
	readonly name: ParsedCommand["name"];
	readonly path: string;
	readonly page: HelpPage;
	readonly optionKinds: Readonly<Record<string, OptionKind>>;
	readonly requiredPositionals: readonly string[];
	readonly optionalPositionals: readonly string[];
}

const MOVED_FORMS = movedFormsData as unknown as MovedFormsFile;

const PROJECT_OPTIONS = {
	"--project": "value",
	"--origin": "value",
	"--base": "value",
} as const satisfies Readonly<Record<string, OptionKind>>;

const ROUTES: Readonly<Record<string, Route>> = {
	status: {
		name: "status",
		path: "status",
		page: "kogen-status",
		optionKinds: {
			...PROJECT_OPTIONS,
			"--watch": "boolean",
			"--json": "boolean",
		},
		requiredPositionals: [],
		optionalPositionals: ["<slug>"],
	},
	"intent shape": {
		name: "intent shape",
		path: "intent shape",
		page: "kogen-intent-shape",
		optionKinds: PROJECT_OPTIONS,
		requiredPositionals: ["<slug>", "<file|->"],
		optionalPositionals: [],
	},
	"intent approve": {
		name: "intent approve",
		path: "intent approve",
		page: "kogen-intent-approve",
		optionKinds: {
			...PROJECT_OPTIONS,
			"--by": "value",
		},
		requiredPositionals: ["<slug>"],
		optionalPositionals: ["<hash>"],
	},
	"intent remove": {
		name: "intent remove",
		path: "intent remove",
		page: "kogen-intent-remove",
		optionKinds: {
			...PROJECT_OPTIONS,
			"--force": "boolean",
		},
		requiredPositionals: ["<slug>"],
		optionalPositionals: [],
	},
	"queue start": {
		name: "queue start",
		path: "queue start",
		page: "kogen-queue-start",
		optionKinds: {
			...PROJECT_OPTIONS,
			"--detach": "boolean",
		},
		requiredPositionals: [],
		optionalPositionals: [],
	},
	"queue stop": {
		name: "queue stop",
		path: "queue stop",
		page: "kogen-queue-stop",
		optionKinds: PROJECT_OPTIONS,
		requiredPositionals: [],
		optionalPositionals: [],
	},
	"provider list": {
		name: "provider list",
		path: "provider list",
		page: "kogen-provider-list",
		optionKinds: {},
		requiredPositionals: [],
		optionalPositionals: [],
	},
	"provider login": {
		name: "provider login",
		path: "provider login",
		page: "kogen-provider-login",
		optionKinds: {},
		requiredPositionals: ["<provider>"],
		optionalPositionals: [],
	},
	"provider logout": {
		name: "provider logout",
		path: "provider logout",
		page: "kogen-provider-logout",
		optionKinds: {},
		requiredPositionals: ["<provider>"],
		optionalPositionals: [],
	},
	"provider use": {
		name: "provider use",
		path: "provider use",
		page: "kogen-provider-use",
		optionKinds: {
			"--as": "value",
			"--project": "value",
		},
		requiredPositionals: ["<provider>"],
		optionalPositionals: [],
	},
	version: {
		name: "version",
		path: "version",
		page: "kogen-version",
		optionKinds: {},
		requiredPositionals: [],
		optionalPositionals: [],
	},
};

function beginsWith(
	argv: readonly string[],
	words: readonly string[],
): boolean {
	return words.every((word, index) => argv[index] === word);
}

function commandIsInProviderGroup(argv: readonly string[]): boolean {
	return argv[0] === "provider";
}

function movedForm(argv: readonly string[]): string | undefined {
	for (const row of MOVED_FORMS.rows) {
		if (row.match !== "prefix") continue;
		if (beginsWith(argv, row.form.split(" "))) return row.message;
	}

	for (const row of MOVED_FORMS.rows) {
		if (row.match === "prefix") continue;
		if (row.match === "flag_outside_provider" && commandIsInProviderGroup(argv))
			continue;
		if (
			argv.some(
				(token) => token === row.form || token.startsWith(`${row.form}=`),
			)
		)
			return row.message;
	}

	return undefined;
}

function routeFor(argv: readonly string[]): Route | ArgvResult {
	const command = argv[0];
	if (command === undefined) return { kind: "help", page: "kogen" };
	if (command === "help") {
		return argv.length === 1
			? { kind: "help", page: "kogen" }
			: {
					kind: "usage-error",
					message: `kogen help: unexpected argument '${argv[1]}'`,
					page: "kogen",
				};
	}

	if (command === "intent" || command === "queue" || command === "provider") {
		const subcommand = argv[1];
		if (subcommand === undefined)
			return { kind: "help", page: `kogen-${command}` as HelpPage };
		const route = ROUTES[`${command} ${subcommand}`];
		if (route) return route;
		return {
			kind: "usage-error",
			message: `kogen ${command}: unknown command '${subcommand}'`,
			page: `kogen-${command}` as HelpPage,
		};
	}

	const route = ROUTES[command];
	if (route) return route;
	return {
		kind: "usage-error",
		message: `kogen: unknown command '${command}'`,
		page: "kogen",
	};
}

function isOptionToken(token: string): boolean {
	return token !== "-" && token.startsWith("-");
}

const BOOLEAN_OPTIONS = new Set(["--json", "--watch", "--force", "--detach"]);

interface ParsedOptions {
	readonly positionals: readonly string[];
	readonly values: ReadonlyMap<string, string | boolean>;
	readonly issue?: string;
}

function parseOptions(route: Route, args: readonly string[]): ParsedOptions {
	const positionals: string[] = [];
	const values = new Map<string, string | boolean>();
	let optionsEnded = false;
	let issue: string | undefined;

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		if (optionsEnded) {
			positionals.push(token);
			continue;
		}
		if (token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!isOptionToken(token)) {
			positionals.push(token);
			continue;
		}

		const separator = token.indexOf("=");
		const option = separator < 0 ? token : token.slice(0, separator);
		const attachedValue =
			separator < 0 ? undefined : token.slice(separator + 1);
		const kind = route.optionKinds[option];
		if (kind === undefined) {
			issue ??=
				attachedValue !== undefined && BOOLEAN_OPTIONS.has(option)
					? `kogen ${route.path}: ${option} takes no value`
					: `kogen ${route.path}: unknown option '${token}'`;
			continue;
		}
		if (kind === "boolean") {
			if (attachedValue !== undefined) {
				issue ??= `kogen ${route.path}: ${option} takes no value`;
				continue;
			}
			values.set(option, true);
			continue;
		}

		let value = attachedValue;
		if (value === undefined) {
			const next = args[index + 1];
			if (next !== undefined && next !== "--" && !isOptionToken(next)) {
				value = next;
				index += 1;
			}
		}
		if (value === undefined || value.length === 0) {
			issue ??= `kogen ${route.path}: ${option} needs a value`;
			continue;
		}
		values.set(option, value);
	}

	return issue === undefined
		? { positionals, values }
		: { positionals, values, issue };
}

function usage(route: Route, message: string): ArgvResult {
	return { kind: "usage-error", message, page: route.page };
}

function projectOptions(
	values: ReadonlyMap<string, string | boolean>,
	cwd: string,
): ProjectOptions {
	const projectValue = values.get("--project");
	const originValue = values.get("--origin");
	const baseValue = values.get("--base");
	return {
		project: resolve(
			cwd,
			typeof projectValue === "string" ? projectValue : ".",
		),
		...(typeof originValue === "string"
			? { origin: resolve(cwd, originValue) }
			: {}),
		...(typeof baseValue === "string" ? { base: baseValue } : {}),
	};
}

function providerFrom(value: string): Provider | undefined {
	return value === "chatgpt" || value === "grok" ? value : undefined;
}

function buildCommand(
	route: Route,
	positionals: readonly string[],
	values: ReadonlyMap<string, string | boolean>,
	cwd: string,
): ParsedCommand | ArgvResult {
	const positionalCount = positionals.length;
	const requiredCount = route.requiredPositionals.length;
	const maxCount = requiredCount + route.optionalPositionals.length;
	if (positionalCount < requiredCount) {
		const missing = route.requiredPositionals[positionalCount];
		if (missing !== undefined)
			return usage(route, `kogen ${route.path}: missing ${missing}`);
	}
	if (positionalCount > maxCount) {
		const extra = positionals[maxCount];
		if (extra !== undefined)
			return usage(
				route,
				`kogen ${route.path}: unexpected argument '${extra}'`,
			);
	}

	const project = projectOptions(values, cwd);
	switch (route.name) {
		case "status": {
			const slug = positionals[0];
			if (values.get("--watch") === true && values.get("--json") === true)
				return usage(
					route,
					"kogen status: --watch and --json can't be combined",
				);
			return {
				name: route.name,
				...project,
				watch: values.get("--watch") === true,
				json: values.get("--json") === true,
				...(slug === undefined ? {} : { slug }),
			};
		}
		case "intent shape":
			return {
				name: route.name,
				...project,
				slug: positionals[0] ?? "",
				file: positionals[1] ?? "",
			};
		case "intent approve": {
			const slug = positionals[0] ?? "";
			const hash = positionals[1];
			if (hash !== undefined && !/^[0-9a-f]{6,64}$/.test(hash))
				return usage(
					route,
					"kogen intent approve: <hash> must be 6 to 64 lowercase hex characters",
				);
			const by = values.get("--by");
			return {
				name: route.name,
				...project,
				slug,
				...(hash === undefined ? {} : { hash }),
				...(typeof by === "string" ? { by } : {}),
			};
		}
		case "intent remove":
			return {
				name: route.name,
				...project,
				slug: positionals[0] ?? "",
				force: values.get("--force") === true,
			};
		case "queue start":
			return {
				name: route.name,
				...project,
				detach: values.get("--detach") === true,
			};
		case "queue stop":
			return { name: route.name, ...project };
		case "provider list":
			return { name: route.name };
		case "provider login":
		case "provider logout": {
			const providerValue = positionals[0] ?? "";
			const provider = providerFrom(providerValue);
			if (!provider)
				return usage(
					route,
					`kogen provider ${route.name.slice("provider ".length)}: unknown provider '${providerValue}' (supported: chatgpt, grok)`,
				);
			return { name: route.name, provider };
		}
		case "provider use": {
			const providerValue = positionals[0] ?? "";
			const provider = providerFrom(providerValue);
			if (!provider)
				return usage(
					route,
					`kogen provider use: unknown provider '${providerValue}' (supported: chatgpt, grok)`,
				);
			const account = values.get("--as");
			if (typeof account !== "string")
				return usage(route, "kogen provider use: missing --as <label>");
			const projectValue = values.get("--project");
			return {
				name: route.name,
				provider,
				account,
				...(typeof projectValue === "string"
					? { project: resolve(cwd, projectValue) }
					: {}),
			};
		}
		case "version":
			return { name: route.name };
	}
}

/** Parse public `kogen` arguments without applying command-time slug validation. */
export function parseArgv(
	argv: readonly string[],
	options: { readonly cwd?: string } = {},
): ArgvResult {
	const moved = movedForm(argv);
	if (moved !== undefined) return { kind: "moved", message: moved };

	const routeResult = routeFor(argv);
	if ("kind" in routeResult) return routeResult;

	const route = routeResult;
	const routeWords = route.path.split(" ");
	const parsed = parseOptions(route, argv.slice(routeWords.length));
	if (parsed.issue !== undefined) return usage(route, parsed.issue);

	const cwd = resolve(options.cwd ?? process.cwd());
	const command = buildCommand(route, parsed.positionals, parsed.values, cwd);
	return "kind" in command ? command : { kind: "command", command };
}
