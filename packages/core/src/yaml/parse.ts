import { parseBlockYaml, type YamlBlockNode } from "./block";
import { resolveYamlFlowNodes } from "./flow";
import { lexYaml, type YamlLexedDocument } from "./lex";
import { firstYamlIssue, orderYamlIssues, type YamlIssue } from "./preflight";

export interface YamlParseResult {
	readonly document: YamlLexedDocument | null;
	readonly node: YamlBlockNode | null;
	readonly issues: readonly YamlIssue[];
	readonly issue: YamlIssue | null;
}

/** Parse the strict §2.6 YAML subset and select its single earliest issue. */
export function parseYaml(input: Uint8Array): YamlParseResult {
	const lexical = lexYaml(input);
	if (lexical.document === null) {
		const issues = orderYamlIssues(lexical.issues);
		return {
			document: null,
			node: null,
			issues,
			issue: firstYamlIssue(issues),
		};
	}

	const block = parseBlockYaml(lexical.document);
	const flow = resolveYamlFlowNodes(block.node);
	const issues = orderYamlIssues([
		...lexical.issues,
		...block.issues,
		...flow.issues,
	]);
	return {
		document: lexical.document,
		node: flow.node,
		issues,
		issue: firstYamlIssue(issues),
	};
}
