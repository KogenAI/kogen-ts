import { expect, test } from "bun:test";
import {
	BUILD_AUDIT_MODE,
	DEFAULT_BUILD_LAND_POLICY,
	isBuildVerificationLandable,
	observeBuildAudit,
} from "../../packages/core/src/build/audit";
import { parseProjectConfig } from "../../packages/core/src/project/schema";
import { acceptanceItem, gateResult } from "./fixtures";

test("default audit advice cannot demote a required failed item or grant landing", () => {
	const verification = gateResult({
		items: [acceptanceItem("A1", "pass"), acceptanceItem("A2", "fail")],
	});
	const before = structuredClone(verification);
	for (const verdict of ["over_strict", "contradicts"] as const) {
		const observation = observeBuildAudit(verification, {
			items: [{ id: "A2", verdict, reason: "The test seems strict." }],
		});
		expect(observation).toMatchObject({
			mode: "observational",
			warning: false,
			demoted: false,
			advisoryItems: [],
			items: [{ id: "A2", verdict }],
		});
		expect(
			isBuildVerificationLandable({
				verification,
				landPolicy: DEFAULT_BUILD_LAND_POLICY,
				approvedItemIds: ["A1", "A2"],
				approvedChangeItemIds: ["A1", "A2"],
			}),
		).toBe(false);
	}
	expect(verification).toEqual(before);
	expect(BUILD_AUDIT_MODE).toBe("observational");
});

test("malformed, duplicate, unknown, and legacy-shaped advice warns without changing gate state", () => {
	const verification = gateResult({ items: [acceptanceItem("A2", "fail")] });
	const advice = observeBuildAudit(verification, {
		items: [
			{ id: "A2", verdict: "valid", reason: "First response." },
			{ id: "A2", verdict: "contradicts", reason: "Duplicate." },
			{ id: "A9", verdict: "over_strict", reason: "Unknown item." },
			{
				id: "A2",
				verdict: "over_strict",
				reason: "Old citation response.",
				citation: "legacy field",
			},
		],
	});
	expect(advice).toMatchObject({
		warning: true,
		demoted: false,
		advisoryItems: [],
		items: [{ id: "A2", verdict: "valid", reason: "First response." }],
	});
	expect(observeBuildAudit(verification, "not json")).toMatchObject({
		warning: true,
		items: [],
		demoted: false,
		advisoryItems: [],
	});
	expect(verification.status).toBe("red");
	expect(
		isBuildVerificationLandable({
			verification,
			landPolicy: "green-or-advisory",
			approvedItemIds: ["A2"],
			approvedChangeItemIds: ["A2"],
		}),
	).toBe(false);
});

test("green and legacy land policies have identical verified-change eligibility", () => {
	const green = gateResult({
		items: [acceptanceItem("A1", "pass"), acceptanceItem("A2", "pass")],
	});
	const request = {
		verification: green,
		approvedItemIds: ["A1", "A2"],
		approvedChangeItemIds: ["A1"],
	};
	expect(isBuildVerificationLandable({ ...request, landPolicy: "green" })).toBe(
		true,
	);
	expect(
		isBuildVerificationLandable({
			...request,
			landPolicy: "green-or-advisory",
		}),
	).toBe(true);

	const red = gateResult({
		items: [acceptanceItem("A1", "pass"), acceptanceItem("A2", "fail")],
	});
	expect(
		isBuildVerificationLandable({
			...request,
			verification: red,
			landPolicy: "green-or-advisory",
		}),
	).toBe(false);
	expect(
		isBuildVerificationLandable({
			...request,
			approvedChangeItemIds: [],
			landPolicy: "green",
		}),
	).toBe(false);
});

test("project config defaults to green and refuses uncalibrated auditor demotion", () => {
	const encode = (source: string) => new TextEncoder().encode(source);
	const defaults = parseProjectConfig(encode("name: kt\nchecks: []\n"));
	expect(defaults.ok).toBe(true);
	if (defaults.ok) {
		expect(defaults.value.build.land).toBe("green");
		expect(defaults.value.build.auditorDemotion).toBe(false);
	}
	const experiment = parseProjectConfig(
		encode("name: kt\nchecks: []\nbuild:\n  auditor_demotion: true\n"),
	);
	expect(experiment.ok).toBe(false);
	if (!experiment.ok)
		expect(experiment.diagnostics.map((item) => item.message)).toContain(
			"build.auditor_demotion has no admitted calibration",
		);
});
