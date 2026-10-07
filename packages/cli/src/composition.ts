import type { ProcessPort } from "../../core/src/contracts/ports";
import { createPublicationFileSystemPort } from "../../core/src/fs/publish";
import {
	createReadFileSystemPort,
	type FileSystemHostRequest,
} from "../../core/src/fs/read";
import { createGitPort } from "../../core/src/git/command";
import {
	lintIntent,
	renderIntentLintFinding,
} from "../../core/src/intent/lint";
import { parseIntent } from "../../core/src/intent/parse";
import { createAllowlistedBaseEnvironment } from "../../core/src/process/environment";
import { startHostBridge } from "../../core/src/process/host";
import { superviseProcess } from "../../core/src/process/supervise";
import {
	nodeProjectPathPort,
	resolveProject,
} from "../../core/src/project/resolve";
import {
	formatConfigDiagnostics,
	parseProjectConfig,
} from "../../core/src/project/schema";
import { probeLinuxSandbox } from "../../core/src/sandbox/linux";
import { probeMacOSSandbox } from "../../core/src/sandbox/macos";
import type { ParsedCommand, ProjectOptions } from "./argv";
import { type CliOutput, renderErrorLine } from "./output";

/** A single native bridge supplies real filesystem, Git and process effects. */
export async function createControllerRuntime(
	compiledExecutablePath = process.execPath,
) {
	const bridge = await startHostBridge({ compiledExecutablePath });
	const processPort: ProcessPort = {
		async run(request) {
			try {
				const tailBytes = Math.min(request.outputLimitBytes, 500 * 1024);
				const result = await superviseProcess(bridge, {
					argv: request.argv,
					cwd: request.cwd,
					environment: request.env,
					timeoutMs: request.timeoutMilliseconds,
					stdoutTailBytes: tailBytes,
					stderrTailBytes: tailBytes,
					...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				});
				if (result.stdoutBytes > tailBytes || result.stderrBytes > tailBytes)
					return {
						ok: false,
						error: {
							code: "io",
							message: "Process output exceeds its limit",
							retryable: false,
						},
					};
				return {
					ok: true,
					value: {
						exitCode: result.exitCode,
						signal: result.signal === null ? null : String(result.signal),
						stdout: result.stdoutTail,
						stderr: result.stderrTail,
						timedOut: result.termination === "timed-out",
					},
				};
			} catch (cause) {
				return {
					ok: false,
					error: {
						code: "io",
						message: String(cause),
						retryable: false,
						cause,
					},
				};
			}
		},
	};
	const filesystemHost: FileSystemHostRequest = {
		request(operation, payload) {
			return bridge.request(operation, new Uint8Array(payload));
		},
	};
	const filesystem = {
		...createReadFileSystemPort(filesystemHost),
		...createPublicationFileSystemPort(filesystemHost),
	};
	const git = createGitPort(processPort, {
		environment: createAllowlistedBaseEnvironment(),
	});
	return {
		bridge,
		filesystem,
		git,
		process: processPort,
		probeSandbox() {
			return process.platform === "darwin"
				? probeMacOSSandbox({ process: processPort, environment: process.env })
				: probeLinuxSandbox({ process: processPort });
		},
		close: () => bridge.close(),
	};
}

export type ControllerRuntime = Awaited<
	ReturnType<typeof createControllerRuntime>
>;

/** Foundation validation runs before any later approval, Shape or queue handler. */
export async function validateProjectCommand(
	command: ParsedCommand & ProjectOptions,
	runtime: ControllerRuntime,
): Promise<CliOutput | undefined> {
	const resolved = await resolveProject(
		{ ...command, cwd: process.cwd() },
		{ git: runtime.git, paths: nodeProjectPathPort },
	);
	if (!resolved.ok)
		return renderErrorLine(
			`environment/${resolved.error.code}: ${resolved.error.detail}`,
			3,
		);
	const checkout = resolved.value.checkout;
	const configPath = ".kogen/project.yaml";
	const bytes = await runtime.filesystem.readFile({
		root: checkout,
		path: configPath,
		maxBytes: 256 * 1024,
	});
	if (!bytes.ok)
		return renderErrorLine(
			`environment/project_config_invalid: ${checkout}/${configPath}\n  ${bytes.error.message}`,
			3,
		);
	const config = parseProjectConfig(bytes.value);
	if (!config.ok)
		return renderErrorLine(
			`environment/project_config_invalid: ${checkout}/${configPath}\n${formatConfigDiagnostics(config.diagnostics).join("\n")}`,
			3,
		);
	// Resolve the configured base too; neither stage fetches or mutates the checkout.
	const project = await resolveProject(
		{
			...command,
			cwd: process.cwd(),
			...(config.value.base === undefined
				? {}
				: { configuredBase: config.value.base }),
		},
		{ git: runtime.git, paths: nodeProjectPathPort },
	);
	if (!project.ok)
		return renderErrorLine(
			`environment/${project.error.code}: ${project.error.detail}`,
			3,
		);
	if (command.name === "intent approve") {
		const source = await runtime.filesystem.readFile({
			root: checkout,
			path: `.kogen/intents/${command.slug}/intent.md`,
			maxBytes: 256 * 1024,
		});
		if (!source.ok)
			return renderErrorLine("intent/not_found: Intent does not exist", 2);
		const intent = parseIntent(source.value);
		if (!intent.ok)
			return renderErrorLine(
				`intent/parse: the Intent cannot be read\n${intent.errors.map((error) => `  line ${error.line}: ${error.message}`).join("\n")}`,
				1,
			);
		const findings = lintIntent(intent.intent).filter(
			(finding) => finding.severity === "error",
		);
		if (findings.length > 0)
			return renderErrorLine(
				`intent/lint: the Intent needs changes\n${findings.map((finding) => `  ${renderIntentLintFinding(finding)}`).join("\n")}`,
				1,
			);
	}
	return undefined;
}
