/**
 * Approval ref compare-and-swap policy shared by the production writer and
 * replay adapters. The first lost race may be retried against the observed
 * parent; a second lost race is terminal for this approval invocation.
 */
export type ApprovalCasDecision =
	| { readonly kind: "retry"; readonly expectedParent: string | null }
	| { readonly kind: "failed" }
	| { readonly kind: "exhausted"; readonly latestParent: string | null };

export function approvalCasTransition(input: {
	readonly attempt: 0 | 1;
	readonly expectedParent: string | null;
	readonly observedParent: string | null;
}): ApprovalCasDecision {
	if (input.observedParent === input.expectedParent) return { kind: "failed" };
	if (input.attempt === 0)
		return { kind: "retry", expectedParent: input.observedParent };
	return { kind: "exhausted", latestParent: input.observedParent };
}
