import { writeFileSync } from "node:fs";
import { startHostBridge } from "../../packages/core/src/process/host";
import { superviseProcess } from "../../packages/core/src/process/supervise";

const [compiledCliPath, reportPath, processPath] = process.argv.slice(2);
if (!compiledCliPath || !reportPath || !processPath)
	throw new Error(
		"usage: parent-kill-driver <helper> <helper-report> <process-report>",
	);

const bridge = await startHostBridge({
	compiledExecutablePath: compiledCliPath,
});
writeFileSync(reportPath, String(bridge.pid), { flag: "wx", mode: 0o600 });
await superviseProcess(bridge, {
	argv: [
		"/bin/sh",
		"-c",
		'sleep 60 & echo "$$ $!" > "$1"; wait',
		"custody-parent-death",
		processPath,
	],
	environment: { PATH: "/usr/bin:/bin" },
	timeoutMs: 60_000,
	stdoutTailBytes: 16,
	stderrTailBytes: 16,
});
