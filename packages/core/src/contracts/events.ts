import type { PortError } from "./errors";

export type EffectPortName =
	| "credentials"
	| "filesystem"
	| "git"
	| "http"
	| "process"
	| "random";

export interface Event<Kind extends string, Payload> {
	readonly kind: Kind;
	readonly atUnixMilliseconds: number;
	readonly payload: Payload;
}

export type EffectRequestedEvent = Event<
	"effect.requested",
	{
		readonly effectId: string;
		readonly port: EffectPortName;
		readonly operation: string;
	}
>;

export type EffectCompletedEvent = Event<
	"effect.completed",
	{
		readonly effectId: string;
		readonly outcome: "succeeded" | "failed" | "cancelled";
		readonly error?: PortError;
	}
>;

export type EffectEvent = EffectRequestedEvent | EffectCompletedEvent;
