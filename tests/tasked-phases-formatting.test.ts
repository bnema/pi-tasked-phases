import assert from "node:assert/strict";
import test from "node:test";

import { __testHooks } from "../extensions/index.ts";

type TestPlanState = Parameters<typeof __testHooks.buildContextSummary>[0];

const sampleState: TestPlanState = {
	version: 1,
	spec: "Ship compact tasked phases output without losing source-of-truth state.",
	phases: [
		{
			id: "phase-1",
			title: "Finished discovery",
			goal: "Understand the old behavior",
			tasks: [
				{ id: "task-1", text: "Completed discovery task", checked: true },
				{ id: "task-2", text: "Completed contract task", checked: true },
			],
		},
		{
			id: "phase-2",
			title: "Implement compact output",
			goal: "Reduce repeated context",
			tasks: [
				{ id: "task-3", text: "Completed implementation task", checked: true },
				{ id: "task-4", text: "Remaining implementation task", checked: false },
			],
		},
	],
	currentPhaseId: "phase-2",
	nextPhaseNumber: 3,
	nextTaskNumber: 5,
	updatedAt: Date.now(),
};

test("routine mutation tool results are compact and omit the full checklist", () => {
	const text = __testHooks.buildToolResultText("set_task_checked", sampleState, "Checked task task-3");

	assert.match(text, /Checked task task-3/);
	assert.match(text, /Progress: 3\/4 tasks checked/);
	assert.match(text, /Current phase: Implement compact output \[phase-2\] \(1 remaining\) - Reduce repeated context/);
	assert.doesNotMatch(text, /Phases:/);
	assert.doesNotMatch(text, /Completed discovery task/);
	assert.doesNotMatch(text, /Remaining implementation task \[task-4\]/);
});

test("explicit status tool results keep the full summary", () => {
	const text = __testHooks.buildToolResultText("get_status", sampleState, "Current phased plan status");

	assert.match(text, /Current phased plan status/);
	assert.match(text, /Phases:/);
	assert.match(text, /Completed discovery task \[task-1\]/);
	assert.match(text, /Remaining implementation task \[task-4\]/);
});

test("injected context focuses on incomplete work and omits completed task history", () => {
	const text = __testHooks.buildContextSummary(sampleState);

	assert.match(text, /\[TASKED PHASES STATE - SOURCE OF TRUTH\]/);
	assert.match(text, /Progress: 3\/4 tasks checked across 2 phase\(s\)/);
	assert.match(text, /Current phase: Implement compact output \[phase-2\]/);
	assert.match(text, /\[ \] Remaining implementation task \[task-4\]/);
	assert.match(text, /Completed tasks are omitted/);
	assert.doesNotMatch(text, /Completed discovery task/);
	assert.doesNotMatch(text, /Completed implementation task/);
});

test("injected context preserves guidance and actionable tasks for long plans", () => {
	const longState: TestPlanState = {
		...sampleState,
		spec: "Long spec sentence. ".repeat(300),
		phases: [
			{
				id: "phase-1",
				title: "Large current phase",
				goal: "Keep enough actionable context even when the spec is long",
				tasks: Array.from({ length: 12 }, (_, index) => ({
					id: `task-${index + 1}`,
					text: `Incomplete task ${index + 1} ${"with detailed context ".repeat(20)}`,
					checked: false,
				})),
			},
			...Array.from({ length: 8 }, (_, index) => ({
				id: `phase-${index + 2}`,
				title: `Future phase ${index + 1} ${"with a long title ".repeat(20)}`,
				goal: `Future phase goal ${index + 1} ${"with detail ".repeat(20)}`,
				tasks: [{ id: `future-task-${index + 1}`, text: "Future incomplete task", checked: false }],
			})),
		],
		currentPhaseId: "phase-1",
		nextPhaseNumber: 2,
		nextTaskNumber: 13,
	};

	const text = __testHooks.buildContextSummary(longState);

	assert.ok(text.length <= 2500);
	assert.match(text, /\.\.\. \(truncated\)/);
	assert.match(text, /Current phase: Large current phase \[phase-1\]/);
	assert.match(text, /\[ \] Incomplete task 1/);
	assert.match(text, /\[ \] Incomplete task 8/);
	assert.match(text, /4 more incomplete task\(s\) omitted/);
	assert.match(text, /After completing each checklist task, immediately call set_task_checked/);
	assert.match(text, /Call tasked_phases get_status if the exact full checklist is needed/);
	assert.doesNotMatch(text, /\[ \] Incomplete task 9/);
});

test("injected context falls back to the first incomplete phase when currentPhaseId is absent", () => {
	const phaseTransitionState: TestPlanState = {
		...sampleState,
		currentPhaseId: undefined,
	};

	const text = __testHooks.buildContextSummary(phaseTransitionState);

	assert.match(text, /Current phase: Implement compact output \[phase-2\] \(1\/2\) - Reduce repeated context/);
	assert.match(text, /\[ \] Remaining implementation task \[task-4\]/);
});
