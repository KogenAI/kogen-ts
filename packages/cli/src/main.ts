import { isValidIntentSlug } from "../../core/src/intent/parse";
import { parseArgv } from "./argv";
import { createControllerRuntime, validateProjectCommand } from "./composition";
import { classifyCliException } from "./errors";
import { runI1Command } from "./i1";
import { runI2QueueCommand } from "./i2";
import { runI2ProviderCommand } from "./i2-auth";
import {
	type CliOutput,
	renderErrorLine,
	renderHelp,
	renderMovedForm,
	renderUsageError,
} from "./output";

declare const KOGEN_BUILD_VERSION: string;

async function run(): Promise<CliOutput> {
	const parsed = parseArgv(process.argv.slice(2));
	if (parsed.kind === "help") return renderHelp(parsed.page);
	if (parsed.kind === "usage-error")
		return renderUsageError(parsed.message, parsed.page);
	if (parsed.kind === "moved") return renderMovedForm(parsed.message);
	const command = parsed.command;
	if (command.name === "version")
		return renderErrorLine(KOGEN_BUILD_VERSION, 0);
	if (
		"slug" in command &&
		command.slug !== undefined &&
		!isValidIntentSlug(command.slug)
	)
		return renderErrorLine(
			"intent/invalid_slug: Slug must use lowercase letters, digits, and dashes.",
			2,
		);
	if (
		command.name === "intent approve" ||
		command.name === "intent remove" ||
		command.name === "status"
	) {
		const runtime = await createControllerRuntime();
		try {
			return await runI1Command(command, runtime);
		} finally {
			await runtime.close();
		}
	}
	if (command.name === "queue start" || command.name === "queue stop") {
		const runtime = await createControllerRuntime();
		try {
			return await runI2QueueCommand(command, runtime);
		} finally {
			await runtime.close();
		}
	}
	if (
		command.name === "provider list" ||
		command.name === "provider login" ||
		command.name === "provider logout" ||
		command.name === "provider use"
	) {
		const runtime = await createControllerRuntime();
		try {
			return await runI2ProviderCommand(command, runtime);
		} finally {
			await runtime.close();
		}
	}
	if ("project" in command && command.project !== undefined) {
		const runtime = await createControllerRuntime();
		try {
			const failure = await validateProjectCommand(
				command as typeof command & { project: string },
				runtime,
			);
			if (failure !== undefined) return failure;
		} finally {
			await runtime.close();
		}
	}
	// Lifecycle handlers are admitted by I1/I2, after their implementation packets.
	return renderErrorLine(`environment/command_unavailable: ${command.name}`, 3);
}

try {
	const output = await run();
	process.stdout.write(output.stdout);
	process.stderr.write(output.stderr);
	process.exitCode = output.exitCode;
} catch (error) {
	const output = classifyCliException(error);
	process.stdout.write(output.stdout);
	process.exitCode = output.exitCode;
}
