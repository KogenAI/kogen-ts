import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type HelpPage,
	helpText,
	renderErrorLine,
	renderHelp,
	renderMovedForm,
	renderUsageError,
} from "../../packages/cli/src/output";

const repositoryRoot = join(import.meta.dir, "../..");
const frozenHelpRoot = join(
	repositoryRoot,
	"spec-lock/kogen-spec/spec/data/help",
);

const helpPages: readonly HelpPage[] = [
	"kogen",
	"kogen-intent",
	"kogen-intent-approve",
	"kogen-intent-remove",
	"kogen-intent-shape",
	"kogen-queue",
	"kogen-queue-start",
	"kogen-queue-stop",
	"kogen-provider",
	"kogen-provider-list",
	"kogen-provider-login",
	"kogen-provider-logout",
	"kogen-provider-use",
	"kogen-status",
	"kogen-version",
];

test("all help pages match the frozen spec byte for byte", () => {
	for (const page of helpPages) {
		const expected = readFileSync(join(frozenHelpRoot, `${page}.txt`));
		expect(Buffer.from(helpText(page))).toEqual(expected);
	}
});

test("help output has the exact page and exit contract", () => {
	const result = renderHelp("kogen");
	expect(result.stdout).toBe(helpText("kogen"));
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(0);
});

test("usage errors append the meant page and leave stderr empty", () => {
	const result = renderUsageError(
		"kogen status: unknown option '--bogus'",
		"kogen-status",
	);
	expect(result.stdout).toBe(
		`kogen status: unknown option '--bogus'\n\n${helpText("kogen-status")}`,
	);
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(2);
});

test("command error lines go to stdout with one trailing newline", () => {
	const result = renderErrorLine("intent/not_found: Intent does not exist", 2);
	expect(result.stdout).toBe("intent/not_found: Intent does not exist\n");
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(2);
});

test("moved forms have one exact stdout line and exit 2", () => {
	const result = renderMovedForm("kogen version");
	expect(result.stdout).toBe("kogen: moved: use kogen version\n");
	expect(result.stderr).toBe("");
	expect(result.exitCode).toBe(2);
});
