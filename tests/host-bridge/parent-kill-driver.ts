import { writeFileSync } from "node:fs";
import { startHostBridge } from "../../packages/core/src/process/host";

const [compiledCliPath, workerPath, reportPath] = process.argv.slice(2);
if (!compiledCliPath || !workerPath || !reportPath) {
	throw new Error("usage: parent-kill-driver <cli> <worker> <report>");
}

const bridge = await startHostBridge({
	compiledExecutablePath: compiledCliPath,
});
const response = await bridge.request(
	0x7f01,
	new TextEncoder().encode(workerPath),
);
if (response.byteLength !== 9) throw new Error("bad group probe response");
const view = new DataView(
	response.buffer,
	response.byteOffset,
	response.byteLength,
);
writeFileSync(
	reportPath,
	JSON.stringify({
		helperPid: bridge.pid,
		workerPid: view.getUint32(0, false),
		grandchildPid: view.getUint32(4, false),
		controlFdClosedOnExec: response[8] === 1,
	}),
	{ mode: 0o600, flag: "wx" },
);

await new Promise<void>(() => {});
