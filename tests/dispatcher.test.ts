import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
interface Packet {
	id: string;
	deps: string[];
}
test("Bash 3 dry-run respects every DAG dependency and performs no dispatch writes", () => {
	const scratch = mkdtempSync(join(tmpdir(), "kts-dispatch-test-"));
	try {
		const result = spawnSync(
			"/bin/bash",
			[join(root, "tools/kdispatch-ts.sh")],
			{
				env: {
					...process.env,
					DRY_RUN: "1",
					KTS_REPO: root,
					KTS_STATE: join(scratch, "state"),
					KTS_WORKTREES: join(scratch, "worktrees"),
				},
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		expect(result.status).toBe(0);
		const packets: Packet[] = JSON.parse(
			readFileSync(join(root, "docs/work/packages.json"), "utf8"),
		);
		const byId = new Map(packets.map((p) => [p.id, p]));
		const complete = new Set<string>();
		for (const line of result.stdout.split("\n")) {
			const match = /batch \d+: (.*)/.exec(line);
			if (!match?.[1]) continue;
			const ids = match[1].trim().split(/\s+/);
			expect(ids.length).toBeLessThanOrEqual(4);
			for (const id of ids) {
				expect(complete.has(id)).toBe(false);
				const packet = byId.get(id);
				expect(packet).toBeDefined();
				for (const dep of packet?.deps ?? [])
					expect(complete.has(dep)).toBe(true);
			}
			for (const id of ids) complete.add(id);
		}
		expect(complete.size).toBe(66);
		expect(result.stdout).toContain("No workers started");
		expect(() => readFileSync(join(scratch, "state/events.tsv"))).toThrow();
		expect(() => readFileSync(join(scratch, "worktrees"))).toThrow();
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("integration rejects a red check, preserves work, and admits the repaired commit", () => {
	// Exercise extracted integration functions in a disposable repository. The
	// dispatcher scheduling loop and the real worker launcher are never run.
	const scratch = mkdtempSync(join(tmpdir(), "kts-integrate-test-"));
	const repo = join(scratch, "repo");
	const state = join(scratch, "state");
	const worktrees = join(scratch, "worktrees");
	const git = Bun.which("git");
	if (!git) throw new Error("Missing fixture Git");
	function quote(value: string): string {
		return `'${value.replace(/'/g, `'\\''`)}'`;
	}
	function run(argv: string[]): void {
		const command = argv[0];
		if (!command) throw new Error("Missing fixture command");
		const result = spawnSync(command, argv.slice(1), {
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	}
	try {
		mkdirSync(join(repo, "docs/work"), { recursive: true });
		mkdirSync(join(repo, "tools"));
		writeFileSync(join(repo, "docs/work/QUEUE.txt"), "00-fixture deps: none\n");
		writeFileSync(join(repo, "docs/work/GATES.txt"), "");
		writeFileSync(join(repo, "docs/work/INTEGRATION.txt"), "");
		writeFileSync(
			join(repo, "docs/work/00-fixture.md"),
			"Disposable integration fixture\n",
		);
		writeFileSync(
			join(repo, "docs/work/packages.json"),
			JSON.stringify([
				{ id: "00", name: "00-fixture", owned: "tests/fixture/**" },
			]),
		);
		writeFileSync(
			join(repo, "tools/dispatch-scope.ts"),
			readFileSync(join(root, "tools/dispatch-scope.ts")),
		);
		writeFileSync(
			join(repo, "Makefile"),
			'check:\n\t@test "$$(cat tests/fixture/result)" = good\n',
		);
		run([git, "-C", repo, "init", "-b", "main"]);
		run([git, "-C", repo, "add", "."]);
		run([git, "-C", repo, "commit", "-m", "Create integration fixture"]);
		const mise = join(scratch, "mise");
		writeFileSync(
			mise,
			`#!/bin/bash\ncase "$2" in git) echo ${quote(git)};; bun) echo ${quote(process.execPath)};; *) exit 1;; esac\n`,
			{ mode: 0o700 },
		);
		const source = readFileSync(join(root, "tools/kdispatch-ts.sh"), "utf8");
		// macOS refuses its privileged ps executable inside any sandbox. These
		// fixtures exercise merge locking/order with a deterministic identity port.
		const prefix = source
			.slice(0, source.indexOf("\nwhile :; do"))
			.replace(/^identity\(\) \{.*$/m, 'identity() { echo "fixture-$1"; }');
		const script = join(scratch, "integration.sh");
		writeFileSync(
			script,
			`${prefix}
      pkg=00-fixture; pd="$D/packages/$pkg"; wt="$W/$pkg"
      mkdir -p "$pd"
      "$GIT" rev-parse main > "$pd/base"
      cp "$pd/base" "$pd/scope-base"
      "$GIT" worktree add -q -b "kts/$pkg" "$wt" main
      mkdir -p "$wt/tests/fixture"
      echo bad > "$wt/tests/fixture/result"
      "$GIT" -C "$wt" add tests/fixture/result
      "$GIT" -C "$wt" commit -qm 'Add red fixture'
      if integrate "$pkg"; then echo 'red check merged' >&2; exit 1; fi
      [ "$("$GIT" rev-parse main)" = "$(cat "$pd/base")" ] || exit 1
      [ "$(status "$pkg")" = FAILED ] || exit 1
      [ -d "$wt" ] || exit 1
      echo good > "$wt/tests/fixture/result"
      "$GIT" -C "$wt" add tests/fixture/result
      "$GIT" -C "$wt" commit -qm 'Repair fixture'
      integrate "$pkg" || exit 1
      [ "$(status "$pkg")" = MERGED ] || exit 1
      [ ! -d "$wt" ] || exit 1
      echo 'red preserved; repaired ff-only merge passed'
      "$GIT" rev-parse main > "$pd/base"
      cp "$pd/base" "$pd/scope-base"
      "$GIT" worktree add -q "$wt" "kts/$pkg"
      echo worker > "$wt/tests/fixture/result"
      "$GIT" -C "$wt" add tests/fixture/result
      "$GIT" -C "$wt" commit -qm 'Create conflict in worker fixture'
      echo main > tests/fixture/result
      "$GIT" add tests/fixture/result
      "$GIT" commit -qm 'Move main in fixture'
      main_before=$("$GIT" rev-parse main)
      if integrate "$pkg"; then echo 'conflict merged' >&2; exit 1; fi
      [ "$("$GIT" rev-parse main)" = "$main_before" ] || exit 1
      [ "$(status "$pkg")" = FAILED ] || exit 1
      [ -d "$wt" ] || exit 1
      echo good > "$wt/tests/fixture/result"
      "$GIT" -C "$wt" add tests/fixture/result
      GIT_EDITOR=true "$GIT" -C "$wt" rebase --continue
      integrate "$pkg" || exit 1
      [ "$(status "$pkg")" = MERGED ] || exit 1
      [ ! -d "$wt" ] || exit 1
      echo 'conflict preserved; resolved rebase re-merged'

    `,
		);
		const result = spawnSync("/bin/bash", [script], {
			env: {
				...process.env,
				KTS_REPO: repo,
				KTS_STATE: state,
				KTS_WORKTREES: worktrees,
				KTS_MISE: mise,
				KTS_RUNNER: "/usr/bin/true",
				KTS_RUNNER_LOGS: join(scratch, "runner-logs"),
			},
			encoding: "utf8",
			timeout: 30_000,
		});
		if (result.status !== 0)
			throw new Error(
				`${result.stderr}\n${result.stdout}\n${existsSync(join(state, "logs/00-fixture.integration.log")) ? readFileSync(join(state, "logs/00-fixture.integration.log"), "utf8") : "integration not reached"}`,
			);
		expect(result.stdout).toContain(
			"red preserved; repaired ff-only merge passed",
		);
		expect(result.stdout).toContain(
			"conflict preserved; resolved rebase re-merged",
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
