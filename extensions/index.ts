import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

const TOOL_NAME = "tasked_phases";
const WIDGET_VISIBLE_PHASES = 4;
const CLOSED_PLAN_BLOCKED_ACTIONS = new Set<string>([
	"replace_plan",
	"add_phase",
	"update_phase",
	"remove_phase",
	"add_task",
	"update_task",
	"remove_task",
	"set_current_phase",
	"set_task_checked",
	"set_phase_checked",
]);
const TOOL_ACTIONS = [
	"get_status",
	"set_spec",
	"replace_plan",
	"add_phase",
	"update_phase",
	"remove_phase",
	"add_task",
	"update_task",
	"remove_task",
	"set_current_phase",
	"set_task_checked",
	"set_phase_checked",
	"clear",
] as const;

type ToolAction = (typeof TOOL_ACTIONS)[number];

interface PhaseTask {
	id: string;
	text: string;
	checked: boolean;
}

interface Phase {
	id: string;
	title: string;
	goal?: string;
	tasks: PhaseTask[];
}

interface PlanState {
	version: 1;
	spec?: string;
	phases: Phase[];
	currentPhaseId?: string;
	closedAt?: number;
	closedSummary?: string;
	nextPhaseNumber: number;
	nextTaskNumber: number;
	updatedAt: number;
}

interface TaskedPhasesDetails {
	action: ToolAction;
	state: PlanState;
	summary: string;
	error?: string;
}

const TaskInputSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional task id. If omitted, one is generated." })),
	text: Type.String({ description: "Checklist task text" }),
	checked: Type.Optional(Type.Boolean({ description: "Whether the task starts checked", default: false })),
});

const PhaseInputSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Optional phase id. If omitted, one is generated." })),
	title: Type.String({ description: "Phase title" }),
	goal: Type.Optional(Type.String({ description: "Optional short goal for the phase" })),
	tasks: Type.Optional(Type.Array(TaskInputSchema, { description: "Checklist tasks for the phase" })),
});

const TaskedPhasesParamsSchema = Type.Object({
	action: StringEnum(TOOL_ACTIONS, {
		description:
			"State operation to perform. If the current plan is closed/complete, restart by calling clear first, or set_spec immediately followed by replace_plan. Do not extend closed plans.",
	}),
	spec: Type.Optional(Type.String({ description: "Spec text used by set_spec" })),
	phaseId: Type.Optional(Type.String({ description: "Target phase id" })),
	phaseTitle: Type.Optional(Type.String({ description: "Phase title for add_phase or update_phase" })),
	phaseGoal: Type.Optional(Type.String({ description: "Phase goal for add_phase or update_phase" })),
	taskId: Type.Optional(Type.String({ description: "Target task id" })),
	taskText: Type.Optional(Type.String({ description: "Task text for add_task or update_task" })),
	checked: Type.Optional(Type.Boolean({ description: "Checked state for set_task_checked or set_phase_checked" })),
	phases: Type.Optional(Type.Array(PhaseInputSchema, { description: "Full plan replacement used by replace_plan" })),
});

type PhaseInput = Static<typeof PhaseInputSchema>;

function createEmptyState(): PlanState {
	return {
		version: 1,
		phases: [],
		nextPhaseNumber: 1,
		nextTaskNumber: 1,
		updatedAt: Date.now(),
	};
}

function cloneState(state: PlanState): PlanState {
	return structuredClone(state);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function singleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncatePlain(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function getPhaseProgress(phase: Phase): { done: number; total: number } {
	const total = phase.tasks.length;
	const done = phase.tasks.filter((task) => task.checked).length;
	return { done, total };
}

function getPlanProgress(state: PlanState): { done: number; total: number } {
	let done = 0;
	let total = 0;
	for (const phase of state.phases) {
		const progress = getPhaseProgress(phase);
		done += progress.done;
		total += progress.total;
	}
	return { done, total };
}

function isPhaseDone(phase: Phase): boolean {
	const progress = getPhaseProgress(phase);
	return progress.total > 0 && progress.done === progress.total;
}

function hasStoredPlan(state: PlanState): boolean {
	return Boolean(state.spec) || state.phases.length > 0;
}

function isPlanComplete(state: PlanState): boolean {
	return state.phases.length > 0 && state.phases.every((phase) => isPhaseDone(phase));
}

function isPlanClosed(state: PlanState): boolean {
	return typeof state.closedAt === "number";
}

function closePlanIfComplete(state: PlanState): void {
	if (!isPlanComplete(state)) return;

	const progress = getPlanProgress(state);
	state.closedAt ??= Date.now();
	state.closedSummary = `Completed ${progress.done}/${progress.total} tasks across ${state.phases.length} phase(s).`;
	state.currentPhaseId = undefined;
}

function getCurrentPhase(state: PlanState): Phase | undefined {
	if (!state.currentPhaseId) return undefined;
	return state.phases.find((phase) => phase.id === state.currentPhaseId);
}

function getActivePhase(state: PlanState): Phase | undefined {
	return getCurrentPhase(state) ?? state.phases.find((phase) => !isPhaseDone(phase));
}

function getCurrentPhaseIndex(state: PlanState): number {
	const currentIndex = state.phases.findIndex((phase) => phase.id === state.currentPhaseId);
	if (currentIndex >= 0) return currentIndex;

	const firstIncompleteIndex = state.phases.findIndex((phase) => !isPhaseDone(phase));
	if (firstIncompleteIndex >= 0) return firstIncompleteIndex;

	return Math.max(0, state.phases.length - 1);
}

function getPhaseWindow(
	state: PlanState,
	maxVisible: number,
): { phases: Phase[]; hiddenBefore: number; hiddenAfter: number } {
	const total = state.phases.length;
	if (total === 0) return { phases: [], hiddenBefore: 0, hiddenAfter: 0 };

	const visibleCount = Math.min(Math.max(1, maxVisible), total);
	if (total <= visibleCount) {
		return { phases: state.phases, hiddenBefore: 0, hiddenAfter: 0 };
	}

	const currentIndex = getCurrentPhaseIndex(state);
	const phasesBeforeCurrent = Math.floor((visibleCount - 1) / 2);
	let start = currentIndex - phasesBeforeCurrent;
	let end = start + visibleCount;

	if (start < 0) {
		start = 0;
		end = visibleCount;
	} else if (end > total) {
		end = total;
		start = total - visibleCount;
	}

	return {
		phases: state.phases.slice(start, end),
		hiddenBefore: start,
		hiddenAfter: total - end,
	};
}

function getSuggestedCurrentPhaseId(state: PlanState): string | undefined {
	if (state.currentPhaseId && state.phases.some((phase) => phase.id === state.currentPhaseId)) {
		return state.currentPhaseId;
	}

	const firstIncomplete = state.phases.find((phase) => !isPhaseDone(phase));
	if (firstIncomplete) return firstIncomplete.id;
	return state.phases[state.phases.length - 1]?.id;
}

function extractHighestIdNumber(prefix: string, ids: string[]): number {
	let highest = 0;
	const pattern = new RegExp(`^${prefix}-(\\d+)$`);
	for (const id of ids) {
		const match = pattern.exec(id);
		if (!match) continue;
		const parsed = Number(match[1]);
		if (Number.isFinite(parsed)) highest = Math.max(highest, parsed);
	}
	return highest;
}

function ensureState(state: PlanState): PlanState {
	const normalized = cloneState(state);
	normalized.version = 1;
	normalized.spec = normalizeOptionalText(normalized.spec);
	normalized.phases = normalized.phases.map((phase) => ({
		id: phase.id,
		title: phase.title,
		goal: normalizeOptionalText(phase.goal),
		tasks: phase.tasks.map((task) => ({ id: task.id, text: task.text, checked: task.checked })),
	}));
	normalized.closedSummary = normalizeOptionalText(normalized.closedSummary);
	if (isPlanComplete(normalized)) {
		closePlanIfComplete(normalized);
	} else {
		normalized.closedAt = undefined;
		normalized.closedSummary = undefined;
	}

	const highestPhase = extractHighestIdNumber(
		"phase",
		normalized.phases.map((phase) => phase.id),
	);
	const highestTask = extractHighestIdNumber(
		"task",
		normalized.phases.flatMap((phase) => phase.tasks.map((task) => task.id)),
	);

	normalized.nextPhaseNumber = Math.max(normalized.nextPhaseNumber ?? 1, highestPhase + 1);
	normalized.nextTaskNumber = Math.max(normalized.nextTaskNumber ?? 1, highestTask + 1);
	if (isPlanClosed(normalized)) {
		normalized.currentPhaseId = undefined;
	} else {
		normalized.currentPhaseId = getSuggestedCurrentPhaseId(normalized);
	}
	normalized.updatedAt = Date.now();
	return normalized;
}

function nextPhaseId(state: PlanState): string {
	const id = `phase-${state.nextPhaseNumber}`;
	state.nextPhaseNumber += 1;
	return id;
}

function nextTaskId(state: PlanState): string {
	const id = `task-${state.nextTaskNumber}`;
	state.nextTaskNumber += 1;
	return id;
}

function findPhase(state: PlanState, phaseId: string | undefined): Phase | undefined {
	if (!phaseId) return undefined;
	return state.phases.find((phase) => phase.id === phaseId);
}

function findTask(
	state: PlanState,
	taskId: string | undefined,
	phaseId?: string,
): { phase: Phase; task: PhaseTask } | undefined {
	if (!taskId) return undefined;

	if (phaseId) {
		const phase = findPhase(state, phaseId);
		const task = phase?.tasks.find((entry) => entry.id === taskId);
		return phase && task ? { phase, task } : undefined;
	}

	for (const phase of state.phases) {
		const task = phase.tasks.find((entry) => entry.id === taskId);
		if (task) return { phase, task };
	}

	return undefined;
}

function buildPhaseFromInput(state: PlanState, input: PhaseInput): Phase {
	return {
		id: normalizeOptionalText(input.id) ?? nextPhaseId(state),
		title: input.title.trim(),
		goal: normalizeOptionalText(input.goal),
		tasks: (input.tasks ?? []).map((task) => ({
			id: normalizeOptionalText(task.id) ?? nextTaskId(state),
			text: task.text.trim(),
			checked: task.checked ?? false,
		})),
	};
}

function buildSummary(state: PlanState): string {
	if (!hasStoredPlan(state)) {
		return "No spec or phased checklist has been stored yet.";
	}

	const lines: string[] = [];
	if (state.spec) {
		lines.push("Spec:");
		lines.push(state.spec);
		lines.push("");
	}

	if (state.phases.length === 0) {
		lines.push("Phases: (none)");
		return lines.join("\n");
	}

	const total = getPlanProgress(state);
	lines.push(`Plan progress: ${total.done}/${total.total} tasks checked`);
	if (isPlanClosed(state)) {
		lines.push(`Plan closed: ${state.closedSummary ?? "all phases complete"}`);
	}
	lines.push("Phases:");
	for (const phase of state.phases) {
		const progress = getPhaseProgress(phase);
		const currentMarker = phase.id === state.currentPhaseId ? ">" : " ";
		const phaseMarker = isPhaseDone(phase) ? "[x]" : "[ ]";
		const goalSuffix = phase.goal ? ` - ${phase.goal}` : "";
		lines.push(`${currentMarker} ${phaseMarker} ${phase.title} [${phase.id}] (${progress.done}/${progress.total})${goalSuffix}`);
		if (phase.tasks.length === 0) {
			lines.push("    - No tasks yet");
			continue;
		}
		for (const task of phase.tasks) {
			lines.push(`    ${task.checked ? "[x]" : "[ ]"} ${task.text} [${task.id}]`);
		}
	}

	return lines.join("\n");
}

const FULL_SUMMARY_ACTIONS = new Set<ToolAction>(["get_status", "replace_plan", "clear"]);
const CONTEXT_VISIBLE_INCOMPLETE_TASKS = 8;
const CONTEXT_VISIBLE_OTHER_PHASES = 8;
const CONTEXT_MAX_LENGTH = 2500;

function formatRemainingTaskCount(count: number): string {
	return count === 1 ? "1 remaining" : `${count} remaining`;
}

function getIncompleteTasks(phase: Phase): PhaseTask[] {
	return phase.tasks.filter((task) => !task.checked);
}

function formatPhaseTitle(phase: Phase): string {
	return truncatePlain(singleLine(phase.title), 120);
}

function formatTaskText(task: PhaseTask): string {
	return truncatePlain(singleLine(task.text), 180);
}

function buildCompactSummary(state: PlanState): string {
	if (!hasStoredPlan(state)) {
		return "No spec or phased checklist has been stored yet.";
	}

	const lines: string[] = [];
	if (state.spec) {
		lines.push(`Spec: ${truncatePlain(singleLine(state.spec), 220)}`);
	}

	const total = getPlanProgress(state);
	lines.push(`Progress: ${total.done}/${total.total} tasks checked`);

	if (isPlanClosed(state)) {
		lines.push(`Plan closed: ${state.closedSummary ?? "all phases complete"}`);
		return lines.join("\n");
	}

	const currentPhase = getActivePhase(state);
	if (currentPhase) {
		const incompleteCount = getIncompleteTasks(currentPhase).length;
		const goalSuffix = currentPhase.goal ? ` - ${truncatePlain(singleLine(currentPhase.goal), 120)}` : "";
		lines.push(`Current phase: ${formatPhaseTitle(currentPhase)} [${currentPhase.id}] (${formatRemainingTaskCount(incompleteCount)})${goalSuffix}`);
	} else if (state.phases.length > 0) {
		lines.push("Current phase: none");
	}

	return lines.join("\n");
}

function shouldReturnFullSummary(action: ToolAction, error?: string): boolean {
	return Boolean(error) || FULL_SUMMARY_ACTIONS.has(action);
}

function buildToolResultText(action: ToolAction, state: PlanState, headline: string, error?: string): string {
	const summary = shouldReturnFullSummary(action, error) ? buildSummary(state) : buildCompactSummary(state);
	return error ? `Error: ${error}\n\n${summary}` : `${headline}\n\n${summary}`;
}

function buildContextSummary(state: PlanState): string {
	const instructions = isPlanClosed(state)
		? [
				"The stored plan is CLOSED because every task in every phase is complete.",
				"Do not add phases or tasks to this closed plan for new user work.",
				"For any new work, restart by calling tasked_phases clear first, or set_spec immediately followed by replace_plan."
			]
		: [
				"Completed tasks are omitted from this injected context to reduce token use.",
				"Call tasked_phases get_status if the exact full checklist is needed.",
				"Update tasked_phases continuously while implementing, not only at the end.",
				"After completing each checklist task, immediately call set_task_checked.",
				"After moving to another phase, immediately call set_current_phase.",
				"Do not rely on prose alone for completion state.",
			];

	const lines: string[] = ["[TASKED PHASES STATE - SOURCE OF TRUTH]"];
	if (!hasStoredPlan(state)) {
		lines.push("No spec or phased checklist has been stored yet.");
	} else {
		const total = getPlanProgress(state);
		lines.push(`Progress: ${total.done}/${total.total} tasks checked across ${state.phases.length} phase(s)`);
		if (isPlanClosed(state)) {
			lines.push(`Plan closed: ${state.closedSummary ?? "all phases complete"}`);
		} else {
			const currentPhase = getActivePhase(state);
			if (currentPhase) {
				const progress = getPhaseProgress(currentPhase);
				const goalSuffix = currentPhase.goal ? ` - ${truncatePlain(singleLine(currentPhase.goal), 180)}` : "";
				lines.push(`Current phase: ${formatPhaseTitle(currentPhase)} [${currentPhase.id}] (${progress.done}/${progress.total})${goalSuffix}`);
				const allIncompleteTasks = getIncompleteTasks(currentPhase);
				const incompleteTasks = allIncompleteTasks.slice(0, CONTEXT_VISIBLE_INCOMPLETE_TASKS);
				if (incompleteTasks.length > 0) {
					lines.push("Incomplete tasks in current phase:");
					for (const task of incompleteTasks) {
						lines.push(`  [ ] ${formatTaskText(task)} [${task.id}]`);
					}
					const omittedCount = allIncompleteTasks.length - incompleteTasks.length;
					if (omittedCount > 0) {
						lines.push(`  ... ${omittedCount} more incomplete task(s) omitted; call tasked_phases get_status for the full checklist.`);
					}
				}
			}

			const otherIncompletePhases = state.phases.filter(
				(phase) => phase.id !== currentPhase?.id && getIncompleteTasks(phase).length > 0,
			);
			if (otherIncompletePhases.length > 0) {
				lines.push("Other incomplete phases:");
				for (const phase of otherIncompletePhases.slice(0, CONTEXT_VISIBLE_OTHER_PHASES)) {
					const progress = getPhaseProgress(phase);
					const goalSuffix = phase.goal ? ` - ${truncatePlain(singleLine(phase.goal), 120)}` : "";
					lines.push(`  [ ] ${formatPhaseTitle(phase)} [${phase.id}] (${progress.done}/${progress.total})${goalSuffix}`);
				}
				const omittedCount = otherIncompletePhases.length - CONTEXT_VISIBLE_OTHER_PHASES;
				if (omittedCount > 0) {
					lines.push(`  ... ${omittedCount} more incomplete phase(s) omitted; call tasked_phases get_status for the full checklist.`);
				}
			}
		}

		if (state.spec) {
			lines.push("");
			lines.push("Spec:");
			lines.push(truncatePlain(state.spec, 600));
		}
	}

	const instructionBlock = ["", ...instructions].join("\n");
	const body = lines.join("\n");
	const base = `${body}${instructionBlock}`;

	if (base.length <= CONTEXT_MAX_LENGTH) return base;
	const maxBodyLength = Math.max(0, CONTEXT_MAX_LENGTH - instructionBlock.length - 20);
	return `${body.slice(0, maxBodyLength).trimEnd()}\n... (truncated)${instructionBlock}`;
}

function buildWidgetLines(state: PlanState, theme: Theme): string[] | undefined {
	if (!hasStoredPlan(state)) return undefined;
	if (isPlanClosed(state)) return undefined;

	const lines: string[] = [];
	const total = getPlanProgress(state);
	const currentPhase = getCurrentPhase(state);
	lines.push(theme.fg("accent", "Phased plan"));
	if (state.spec) {
		lines.push(theme.fg("muted", truncatePlain(singleLine(state.spec), 72)));
	}
	if (currentPhase) {
		const currentProgress = getPhaseProgress(currentPhase);
		lines.push(
			theme.fg("accent", "Current: ") +
				theme.fg("text", currentPhase.title) +
				theme.fg("dim", ` (${currentProgress.done}/${currentProgress.total})`),
		);
	}
	lines.push(theme.fg("muted", `${total.done}/${total.total} tasks checked across ${state.phases.length} phase(s)`));

	const phaseWindow = getPhaseWindow(state, WIDGET_VISIBLE_PHASES);
	if (phaseWindow.hiddenBefore > 0) {
		lines.push(theme.fg("dim", `... +${phaseWindow.hiddenBefore} earlier phases`));
	}

	for (const phase of phaseWindow.phases) {
		const progress = getPhaseProgress(phase);
		const isCurrent = phase.id === state.currentPhaseId;
		const prefix = isCurrent ? "> " : "  ";
		const marker = isPhaseDone(phase) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
		const title = isCurrent ? theme.fg("accent", phase.title) : theme.fg("text", phase.title);
		lines.push(`${theme.fg("dim", prefix)}${marker} ${title} ${theme.fg("dim", `(${progress.done}/${progress.total})`)}`);
	}

	if (phaseWindow.hiddenAfter > 0) {
		lines.push(theme.fg("dim", `... +${phaseWindow.hiddenAfter} later phases`));
	}

	return lines;
}

function buildStatusText(state: PlanState, theme: Theme): string | undefined {
	if (!hasStoredPlan(state)) return undefined;
	if (isPlanClosed(state)) return undefined;
	const total = getPlanProgress(state);
	const currentPhase = getCurrentPhase(state);
	let text = theme.fg("accent", `phases ${total.done}/${total.total}`);
	if (currentPhase) {
		text += theme.fg("muted", ` ${currentPhase.title}`);
	}
	return text;
}

function buildViewLines(state: PlanState, theme: Theme): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push(theme.fg("accent", " Tasked phases "));
	lines.push("");

	if (!hasStoredPlan(state)) {
		lines.push(`  ${theme.fg("dim", "No spec or phases stored yet.")}`);
		lines.push("");
		lines.push(`  ${theme.fg("dim", "Ask the agent to create a spec and phased checklist.")}`);
		lines.push("");
		lines.push(`  ${theme.fg("dim", "Press Escape to close")}`);
		return lines;
	}

	if (state.spec) {
		lines.push(`  ${theme.fg("accent", "Spec")}`);
		for (const specLine of state.spec.split("\n")) {
			lines.push(`  ${specLine}`);
		}
		lines.push("");
	}

	const total = getPlanProgress(state);
	lines.push(`  ${theme.fg("muted", `Progress: ${total.done}/${total.total} tasks checked`)}`);
	if (isPlanClosed(state)) {
		lines.push(`  ${theme.fg("success", `Closed: ${state.closedSummary ?? "all phases complete"}`)}`);
		lines.push(`  ${theme.fg("dim", "New work should create a fresh plan instead of extending this one.")}`);
	}
	lines.push("");

	for (const phase of state.phases) {
		const progress = getPhaseProgress(phase);
		const isCurrent = phase.id === state.currentPhaseId;
		const marker = isPhaseDone(phase) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
		let header = `  ${marker} ${isCurrent ? theme.fg("accent", phase.title) : phase.title}`;
		header += theme.fg("dim", ` [${phase.id}] (${progress.done}/${progress.total})`);
		lines.push(header);
		if (phase.goal) {
			lines.push(`    ${theme.fg("muted", phase.goal)}`);
		}
		if (phase.tasks.length === 0) {
			lines.push(`    ${theme.fg("dim", "- No tasks yet")}`);
			continue;
		}
		for (const task of phase.tasks) {
			const taskMarker = task.checked ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
			const taskText = task.checked ? theme.fg("muted", theme.strikethrough(task.text)) : task.text;
			lines.push(`    ${taskMarker} ${taskText} ${theme.fg("dim", `[${task.id}]`)}`);
		}
		lines.push("");
	}

	lines.push(`  ${theme.fg("dim", "Press Escape to close")}`);
	return lines;
}

function updateUi(state: PlanState, ctx: ExtensionContext): void {
	ctx.ui.setWidget("tasked-phases", buildWidgetLines(state, ctx.ui.theme));
	ctx.ui.setStatus("tasked-phases", buildStatusText(state, ctx.ui.theme));
}

function buildToolResult(action: ToolAction, state: PlanState, headline: string, error?: string) {
	const summary = shouldReturnFullSummary(action, error) ? buildSummary(state) : buildCompactSummary(state);
	const text = buildToolResultText(action, state, headline, error);
	return {
		content: [{ type: "text" as const, text }],
		details: { action, state, summary, error } satisfies TaskedPhasesDetails,
	};
}

class PhaseStateView {
	private readonly state: PlanState;
	private readonly theme: Theme;
	private readonly onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(state: PlanState, theme: Theme, onClose: () => void) {
		this.state = state;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines = buildViewLines(this.state, this.theme).map((line) => truncateToWidth(line, width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function restoreStateFromSession(ctx: ExtensionContext): PlanState {
	let restored = createEmptyState();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== TOOL_NAME) continue;
		const details = message.details as TaskedPhasesDetails | undefined;
		if (details?.state) {
			restored = ensureState(details.state);
		}
	}

	return restored;
}

export const __testHooks = {
	buildContextSummary,
	buildToolResultText,
};

export default function taskedPhasesExtension(pi: ExtensionAPI) {
	let state = createEmptyState();
	let stateQueue: Promise<void> = Promise.resolve();

	const withStateLock = async <T>(operation: () => Promise<T> | T): Promise<T> => {
		let release: (() => void) | undefined;
		const previous = stateQueue;
		stateQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	};

	const setState = (nextState: PlanState, ctx: ExtensionContext) => {
		state = ensureState(nextState);
		updateUi(state, ctx);
	};

	const syncStateFromSession = (ctx: ExtensionContext) => {
		state = restoreStateFromSession(ctx);
		updateUi(state, ctx);
	};

	pi.on("session_start", async (_event, ctx) => syncStateFromSession(ctx));
	pi.on("session_tree", async (_event, ctx) => syncStateFromSession(ctx));

	pi.on("before_agent_start", async () => {
		if (!hasStoredPlan(state)) return;
		return {
			message: {
				customType: "tasked-phases-context",
				content: buildContextSummary(state),
				display: false,
			},
		};
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Tasked Phases",
		description:
			"Persist and update a structured spec, phased plan, current phase, and checklist tasks. Use it for spec-driven planning and progress tracking.",
		renderShell: "self",
		promptGuidelines: [
			"Use tasked_phases to store or update specs, phases, subtasks, and checklist progress.",
			"After you create or materially revise a phased plan, call tasked_phases so the plan becomes persistent context.",
			"While implementing, update tasked_phases continuously; do not wait until the end of the turn or final summary.",
			"Use tasked_phases set_task_checked immediately after each checklist item is completed.",
			"Use tasked_phases set_current_phase when you begin work on a different phase.",
			"Use tasked_phases set_phase_checked when an entire phase should be marked done or reopened at once.",
			"When all tasks in all phases are checked, the plan is closed; for unrelated new work, restart by calling clear first, or set_spec immediately followed by replace_plan. Do not extend the closed plan.",
			"Use tasked_phases get_status before relying on remembered plan state if the plan may have changed.",
		],
		parameters: TaskedPhasesParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return withStateLock(async () => {
				if (signal?.aborted) {
					return buildToolResult(params.action, state, "Cancelled", "Operation was aborted.");
				}

				const nextState = cloneState(state);
				const action = params.action as ToolAction;

				const isReopenAction =
					(action === "set_task_checked" || action === "set_phase_checked") && params.checked === false;

				if (isPlanClosed(state) && CLOSED_PLAN_BLOCKED_ACTIONS.has(action) && !isReopenAction) {
					return buildToolResult(
						action,
						state,
						"Plan is closed",
						"This plan is already complete and closed. To start new work, call clear first, or call set_spec immediately followed by replace_plan. Do not extend the closed plan.",
					);
				}

				switch (action) {
					case "get_status":
						updateUi(state, ctx);
						return buildToolResult("get_status", state, "Current phased plan status");

					case "set_spec": {
						const spec = normalizeOptionalText(params.spec);
						if (!spec) {
							return buildToolResult("set_spec", state, "Spec not updated", "spec is required for set_spec.");
						}
						nextState.spec = spec;
						if (isPlanClosed(state)) {
							nextState.phases = [];
							nextState.currentPhaseId = undefined;
							nextState.nextPhaseNumber = 1;
							nextState.nextTaskNumber = 1;
						}
						nextState.closedAt = undefined;
						nextState.closedSummary = undefined;
						setState(nextState, ctx);
						return buildToolResult("set_spec", state, "Saved spec");
					}

					case "replace_plan": {
						if (!params.phases) {
							return buildToolResult(
								"replace_plan",
								state,
								"Plan not replaced",
								"phases is required for replace_plan.",
							);
						}
						nextState.phases = [];
						nextState.currentPhaseId = undefined;
						nextState.nextPhaseNumber = 1;
						nextState.nextTaskNumber = 1;
						nextState.phases = params.phases.map((phaseInput) => buildPhaseFromInput(nextState, phaseInput));
						nextState.currentPhaseId = getSuggestedCurrentPhaseId(nextState);
						setState(nextState, ctx);
						return buildToolResult("replace_plan", state, `Replaced plan with ${state.phases.length} phase(s)`);
					}

					case "add_phase": {
						const phaseTitle = normalizeOptionalText(params.phaseTitle);
						if (!phaseTitle) {
							return buildToolResult("add_phase", state, "Phase not added", "phaseTitle is required for add_phase.");
						}
						nextState.phases.push({
							id: nextPhaseId(nextState),
							title: phaseTitle,
							goal: normalizeOptionalText(params.phaseGoal),
							tasks: [],
						});
						if (!nextState.currentPhaseId) {
							nextState.currentPhaseId = nextState.phases[0]?.id;
						}
						setState(nextState, ctx);
						return buildToolResult("add_phase", state, `Added phase ${phaseTitle}`);
					}

					case "update_phase": {
						const phase = findPhase(nextState, params.phaseId);
						if (!phase) {
							return buildToolResult("update_phase", state, "Phase not updated", "phaseId was not found.");
						}
						const phaseTitle = normalizeOptionalText(params.phaseTitle);
						if (phaseTitle) {
							phase.title = phaseTitle;
						}
						if (params.phaseGoal !== undefined) {
							phase.goal = normalizeOptionalText(params.phaseGoal);
						}
						setState(nextState, ctx);
						return buildToolResult("update_phase", state, `Updated phase ${phase.title}`);
					}

					case "remove_phase": {
						if (!params.phaseId) {
							return buildToolResult("remove_phase", state, "Phase not removed", "phaseId is required.");
						}
						const beforeCount = nextState.phases.length;
						nextState.phases = nextState.phases.filter((phase) => phase.id !== params.phaseId);
						if (nextState.phases.length === beforeCount) {
							return buildToolResult("remove_phase", state, "Phase not removed", "phaseId was not found.");
						}
						nextState.currentPhaseId = getSuggestedCurrentPhaseId(nextState);
						setState(nextState, ctx);
						return buildToolResult("remove_phase", state, `Removed phase ${params.phaseId}`);
					}

					case "add_task": {
						const phase = findPhase(nextState, params.phaseId);
						const taskText = normalizeOptionalText(params.taskText);
						if (!phase) {
							return buildToolResult("add_task", state, "Task not added", "phaseId was not found.");
						}
						if (!taskText) {
							return buildToolResult("add_task", state, "Task not added", "taskText is required for add_task.");
						}
						phase.tasks.push({ id: nextTaskId(nextState), text: taskText, checked: false });
						setState(nextState, ctx);
						return buildToolResult("add_task", state, `Added task to ${phase.title}`);
					}

					case "update_task": {
						const foundTask = findTask(nextState, params.taskId, params.phaseId);
						const taskText = normalizeOptionalText(params.taskText);
						if (!foundTask) {
							return buildToolResult("update_task", state, "Task not updated", "taskId was not found.");
						}
						if (!taskText) {
							return buildToolResult("update_task", state, "Task not updated", "taskText is required for update_task.");
						}
						foundTask.task.text = taskText;
						setState(nextState, ctx);
						return buildToolResult("update_task", state, `Updated task ${foundTask.task.id}`);
					}

					case "remove_task": {
						if (!params.taskId) {
							return buildToolResult("remove_task", state, "Task not removed", "taskId is required.");
						}
						const foundTask = findTask(nextState, params.taskId, params.phaseId);
						if (!foundTask) {
							return buildToolResult("remove_task", state, "Task not removed", "taskId was not found.");
						}
						foundTask.phase.tasks = foundTask.phase.tasks.filter((task) => task.id !== params.taskId);
						setState(nextState, ctx);
						return buildToolResult("remove_task", state, `Removed task ${params.taskId}`);
					}

					case "set_current_phase": {
						const phase = findPhase(nextState, params.phaseId);
						if (!phase) {
							return buildToolResult(
								"set_current_phase",
								state,
								"Current phase not updated",
								"phaseId was not found.",
							);
						}
						nextState.currentPhaseId = phase.id;
						setState(nextState, ctx);
						return buildToolResult("set_current_phase", state, `Current phase set to ${phase.title}`);
					}

					case "set_task_checked": {
						const foundTask = findTask(nextState, params.taskId, params.phaseId);
						if (!foundTask) {
							return buildToolResult(
								"set_task_checked",
								state,
								"Task not updated",
								"taskId was not found.",
							);
						}
						if (typeof params.checked !== "boolean") {
							return buildToolResult(
								"set_task_checked",
								state,
								"Task not updated",
								"checked must be provided for set_task_checked.",
							);
						}
						foundTask.task.checked = params.checked;
						if (params.checked && nextState.currentPhaseId === foundTask.phase.id && isPhaseDone(foundTask.phase)) {
							nextState.currentPhaseId = undefined;
						}
						setState(nextState, ctx);
						return buildToolResult(
							"set_task_checked",
							state,
							`${params.checked ? "Checked" : "Unchecked"} task ${foundTask.task.id}`,
						);
					}

					case "set_phase_checked": {
						const phase = findPhase(nextState, params.phaseId);
						if (!phase) {
							return buildToolResult(
								"set_phase_checked",
								state,
								"Phase not updated",
								"phaseId was not found.",
							);
						}
						if (typeof params.checked !== "boolean") {
							return buildToolResult(
								"set_phase_checked",
								state,
								"Phase not updated",
								"checked must be provided for set_phase_checked.",
							);
						}
						if (phase.tasks.length === 0) {
							return buildToolResult(
								"set_phase_checked",
								state,
								"Phase not updated",
								"set_phase_checked requires the phase to have at least one task.",
							);
						}
						for (const task of phase.tasks) {
							task.checked = params.checked;
						}
						if (params.checked && nextState.currentPhaseId === phase.id) {
							nextState.currentPhaseId = undefined;
						}
						if (!params.checked) {
							nextState.currentPhaseId = phase.id;
						}
						setState(nextState, ctx);
						return buildToolResult(
							"set_phase_checked",
							state,
							`${params.checked ? "Checked" : "Unchecked"} phase ${phase.title}`,
						);
					}

					case "clear": {
						setState(createEmptyState(), ctx);
						return buildToolResult("clear", state, "Cleared stored spec and phased checklist");
					}

					default:
						return buildToolResult(params.action as ToolAction, state, "Unsupported action", "Unknown action.");
				}
			});
		},
		renderCall() {
			return new Container();
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskedPhasesDetails | undefined;
			if (!details) {
				const text = Array.isArray(result.content) && result.content.length > 0 ? result.content[0] : undefined;
				if (!expanded || text?.type !== "text") {
					return new Container();
				}
				return new Text(theme.fg("dim", text.text), 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Tasked phases error: ${details.error}`), 0, 0);
			}

			if (!expanded) {
				return new Container();
			}

			return new Text(theme.fg("dim", details.summary), 0, 0);
		},
	});

	pi.registerCommand("phases", {
		description: "Show the current spec, phases, and checklist state",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new PhaseStateView(state, theme, () => done()));
		},
	});
}
