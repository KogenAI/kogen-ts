import { expect, test } from "bun:test";
import {
	formatConfigDiagnostics,
	parseMachineConfig,
	parseProjectConfig,
} from "../../packages/core/src/project/schema";

const encode = (source: string): Uint8Array => new TextEncoder().encode(source);

test("project schema accepts the complete admitted config and fills its defaults", () => {
	const result = parseProjectConfig(
		encode(`name: kt
checks:
  - name: lint
    argv: [sh, checks/lint.sh]
    timeout_ms: 60000
acceptance_checks:
  - name: syntax
    argv: [sh, -n, "{path}"]
    timeout_ms: 60000
setup:
  - name: setup
    argv: [sh, checks/setup.sh]
    timeout_ms: 60000
setup_outputs: [build]
setup_inputs: [package.lock]
fix:
  - name: fmt
    argv: [sh, checks/fmt.sh]
    timeout_ms: 60000
format: [sh, checks/fmt.sh]
protected_paths: [Makefile, "docs/**"]
gate_paths: ["checks/*.sh"]
domains:
  app: [lib]
env:
  KT_MODE: test
sandbox: true
base: main
acceptance:
  adapter: command
  ext: .t.sh
  candidate_dir: test/acceptance
  run: [sh, run-acceptance.sh, "{path}"]
  timeout_ms: 600000
shaping:
  proof: none
build:
  recipe: ladder
  roles:
    builder: {model: gpt-6-luna, effort: max}
    planner: {model: gpt-6.1-sol, effort: high}
    shaper: {model: gpt-6.1-sol, effort: high}
    auditor: {model: gpt-6.1-sol, effort: high}
    reviewer: {effort: medium}
    context: {model: gpt-6.1-sol}
  wall_minutes: 60
  edge_tests: false
  model_fallback: true
  context_bytes: 16000
  plan_max_words: 600
  tool_result_tokens: 4096
  model_generation_tokens: 4096
  luna_provider_mode: responses
  land: green-or-advisory
  auditor_demotion: false
account: default
`),
	);

	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.name).toBe("kt");
	expect(result.value.checks).toEqual([
		{ name: "lint", argv: ["sh", "checks/lint.sh"], timeoutMs: 60_000 },
	]);
	expect(result.value.build).toMatchObject({
		recipe: "ladder",
		wallMinutes: 60,
		modelFallback: true,
		planMaxWords: 600,
		toolResultTokens: 4096,
		land: "green-or-advisory",
		auditorDemotion: false,
	});
	expect(result.value.build.roles.get("reviewer")).toEqual({
		effort: "medium",
	});
	expect(result.value.base).toBe("main");
	expect(result.value.acceptance).toMatchObject({
		adapter: "command",
		timeoutMs: 600_000,
	});
});

test("project schema admits the I4 ladder and active budget with closed nested keys", () => {
	const accepted = parseProjectConfig(
		encode(`name: kt
checks: []
build:
  ladder:
    max_rungs: 1
    experimental_r4: false
    repeat_from: null
  budget_ms: 120000
`),
	);
	expect(accepted.ok).toBe(true);
	if (accepted.ok) {
		expect(accepted.value.build.ladder).toEqual({
			maxRungs: 1,
			experimentalR4: false,
			repeatFrom: null,
		});
		expect(accepted.value.build.budgetMs).toBe(120_000);
	}
	const rejected = parseProjectConfig(
		encode(`name: kt
checks: []
build:
  ladder:
    max_rungs: 5
    unknown: yes
  budget_ms: 0
`),
	);
	expect(rejected.ok).toBe(false);
	if (!rejected.ok)
		expect(rejected.diagnostics.map((issue) => issue.message)).toEqual([
			'build.ladder has unknown key "unknown"',
			"build.ladder.max_rungs must be an integer from 1 to 4",
			"build.budget_ms must be an integer ≥ 1",
		]);
});

test("project schema reports all closed-schema issues with stable messages", () => {
	const result = parseProjectConfig(
		encode(`name: kt
frobnicate: yes
checks:
  - name: lint
    argv: [sh, checks/lint.sh]
    timeout_ms: 60000
    cmd: lint
setup:
  - name: s
    argv: [sh, checks/setup.sh]
    timeout_ms: 1000
  - name: s
    argv: [sh, checks/setup.sh]
    timeout_ms: 1000
fix:
  - name: fmt
    argv: [sh, checks/fmt.sh]
    timeout_ms: soon
build:
  roles:
    judge: {model: gpt-6.1-sol, effort: high}
`),
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(formatConfigDiagnostics(result.diagnostics)).toEqual([
		'  project has unknown key "frobnicate"',
		'  checks[1] has unknown key "cmd"',
		'  setup has duplicate name "s"',
		"  fix[1].timeout_ms must be a positive integer",
		'  build.roles has unknown role "judge"',
	]);
});

test("fallback_shaper is unknown and auditor demotion is refused without calibration", () => {
	const result = parseProjectConfig(
		encode(`name: kt
checks: []
build:
  roles:
    fallback_shaper: {model: gpt-6.1-sol, effort: high}
  auditor_demotion: true
`),
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics.map((issue) => issue.message)).toEqual([
		'build.roles has unknown role "fallback_shaper"',
		"build.auditor_demotion has no admitted calibration",
	]);
});

test("rejected config diagnostics cover reserved environment names, domain shape, and duplicate checks", () => {
	const result = parseProjectConfig(
		encode(`name: kt
checks:
  - name: lint
    argv: [sh, checks/lint.sh]
    timeout_ms: 1000
  - name: lint
    argv: [sh, checks/unit.sh]
    timeout_ms: 1000
domains:
  app: lib
env:
  KOGEN_SANDBOXED: "1"
`),
	);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics.map((issue) => issue.message)).toEqual([
		'checks has duplicate name "lint"',
		"domains.app must be a list",
		"env cannot set KOGEN_SANDBOXED",
	]);
});

test("setup paths reject escapes and overlapping outputs", () => {
	const result = parseProjectConfig(
		encode(`name: kt
checks: []
setup_outputs: [build, build/cache, ../outside, .git/config]
setup_inputs: [/absolute]
`),
	);

	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.diagnostics.map((issue) => issue.message)).toEqual([
		"setup_outputs[3] must be a safe relative path",
		"setup_outputs[4] must be a safe relative path",
		"setup_inputs[1] must be a safe relative path",
		'setup_outputs has overlapping paths "build" and "build/cache"',
	]);
});

test("machine config admits only build and parses partial role fields", () => {
	const result = parseMachineConfig(
		encode(`build:
  roles:
    builder: {model: machine-builder, effort: low}
    planner: {model: machine-planner, effort: low}
  plan_max_words: 800
`),
	);
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.value.build.roles?.get("planner")).toEqual({
		model: "machine-planner",
		effort: "low",
	});
	expect(result.value.build.planMaxWords).toBe(800);

	const rejected = parseMachineConfig(encode("jobs: 4\n"));
	expect(rejected.ok).toBe(false);
	if (rejected.ok) return;
	expect(rejected.diagnostics.map((issue) => issue.message)).toEqual([
		'machine config has unknown key "jobs"',
	]);
});

test("invalid YAML is reported with a source line", () => {
	const result = parseProjectConfig(
		encode("name: kt\nchecks: [bad,, value]\n"),
	);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(formatConfigDiagnostics(result.diagnostics)).toEqual([
		"  line 2: malformed flow collection near , value]",
	]);
});
