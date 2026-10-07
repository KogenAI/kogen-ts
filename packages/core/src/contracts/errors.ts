export type PortErrorCode =
	| "cancelled"
	| "conflict"
	| "invalid_input"
	| "io"
	| "not_found"
	| "permission_denied"
	| "timeout"
	| "unavailable"
	| "unknown";

export interface PortError {
	readonly code: PortErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly cause?: unknown;
}

export type Result<Value, Error = PortError> =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly error: Error };
