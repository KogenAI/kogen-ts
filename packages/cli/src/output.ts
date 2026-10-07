import rootHelp from "../data/help/kogen.txt" with { type: "text" };
import intentHelp from "../data/help/kogen-intent.txt" with { type: "text" };
import approveHelp from "../data/help/kogen-intent-approve.txt" with {
	type: "text",
};
import removeHelp from "../data/help/kogen-intent-remove.txt" with {
	type: "text",
};
import shapeHelp from "../data/help/kogen-intent-shape.txt" with {
	type: "text",
};
import providerHelp from "../data/help/kogen-provider.txt" with {
	type: "text",
};
import providerListHelp from "../data/help/kogen-provider-list.txt" with {
	type: "text",
};
import providerLoginHelp from "../data/help/kogen-provider-login.txt" with {
	type: "text",
};
import providerLogoutHelp from "../data/help/kogen-provider-logout.txt" with {
	type: "text",
};
import providerUseHelp from "../data/help/kogen-provider-use.txt" with {
	type: "text",
};
import queueHelp from "../data/help/kogen-queue.txt" with { type: "text" };
import queueStartHelp from "../data/help/kogen-queue-start.txt" with {
	type: "text",
};
import queueStopHelp from "../data/help/kogen-queue-stop.txt" with {
	type: "text",
};
import statusHelp from "../data/help/kogen-status.txt" with { type: "text" };
import versionHelp from "../data/help/kogen-version.txt" with { type: "text" };
import movedFormsData from "../data/moved.json" with { type: "json" };

export type HelpPage =
	| "kogen"
	| "kogen-intent"
	| "kogen-intent-approve"
	| "kogen-intent-remove"
	| "kogen-intent-shape"
	| "kogen-queue"
	| "kogen-queue-start"
	| "kogen-queue-stop"
	| "kogen-provider"
	| "kogen-provider-list"
	| "kogen-provider-login"
	| "kogen-provider-logout"
	| "kogen-provider-use"
	| "kogen-status"
	| "kogen-version";

export interface CliOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

interface MovedOutputData {
	readonly format: string;
	readonly exit: number;
}

const MOVED_OUTPUT = movedFormsData as unknown as MovedOutputData;

const HELP_PAGES: Readonly<Record<HelpPage, string>> = {
	kogen: rootHelp,
	"kogen-intent": intentHelp,
	"kogen-intent-approve": approveHelp,
	"kogen-intent-remove": removeHelp,
	"kogen-intent-shape": shapeHelp,
	"kogen-queue": queueHelp,
	"kogen-queue-start": queueStartHelp,
	"kogen-queue-stop": queueStopHelp,
	"kogen-provider": providerHelp,
	"kogen-provider-list": providerListHelp,
	"kogen-provider-login": providerLoginHelp,
	"kogen-provider-logout": providerLogoutHelp,
	"kogen-provider-use": providerUseHelp,
	"kogen-status": statusHelp,
	"kogen-version": versionHelp,
};

/** Return the exact UTF-8 help page, including its frozen trailing newline. */
export function helpText(page: HelpPage): string {
	return HELP_PAGES[page];
}

export function renderHelp(page: HelpPage): CliOutput {
	return { stdout: helpText(page), stderr: "", exitCode: 0 };
}

export function renderUsageError(message: string, page: HelpPage): CliOutput {
	return {
		stdout: `${message}\n\n${helpText(page)}`,
		stderr: "",
		exitCode: 2,
	};
}

export function renderErrorLine(message: string, exitCode: number): CliOutput {
	return { stdout: `${message}\n`, stderr: "", exitCode };
}

export function renderMovedForm(message: string): CliOutput {
	return {
		stdout: `${MOVED_OUTPUT.format.replace("<message>", message)}\n`,
		stderr: "",
		exitCode: MOVED_OUTPUT.exit,
	};
}
