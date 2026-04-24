---
name: tasked-phases
description: Use when the user wants a spec turned into phased work with checklist subtasks persisted in the tasked_phases tool, or when ongoing work should be tracked phase by phase with checked tasks.
---

# Tasked Phases

Use the `tasked_phases` tool as the source of truth for specs, phases, and checklist progress.

## Workflow

1. Clarify missing requirements if the spec is ambiguous.
2. Save the accepted spec with `tasked_phases` using `set_spec`.
3. Create or replace the phased plan with `tasked_phases` using `replace_plan`.
4. Make phases small enough to review and tasks concrete enough to check off.
5. Keep `currentPhaseId` accurate with `set_current_phase` when focus changes.
6. During implementation, update progress continuously: call `set_task_checked` immediately after each checklist task is completed.
7. If all tasks in all phases are complete, treat the stored plan as closed. For unrelated new work, call `clear` first, or call `set_spec` immediately followed by `replace_plan`. Do not extend the closed plan.
8. If the plan changes materially before it is closed, update the stored state instead of only describing the new plan in prose.

## Planning rules

- Prefer 3-7 phases unless the task is tiny.
- Each task should be checkable.
- Avoid vague tasks like "work on this" or "finish implementation".
- Prefer tasks that describe an observable outcome.
- Keep the stored plan concise and operational.

## Tool usage guidance

- Use `get_status` before revising a long-running plan.
- Use `replace_plan` when restructuring the plan substantially.
- Use `add_phase` and `add_task` for small incremental changes.
- Use `update_phase` and `update_task` when editing existing entries.
- Use `set_task_checked` immediately when a task is done; do not batch all updates for the final response.
- Use `set_current_phase` as soon as work moves to another phase.
- Use `set_phase_checked` when an entire phase should be completed or reopened at once.
- Do not assume a task is complete unless the tool state says it is checked.
- Do not add phases or tasks to a closed/completed plan. Start a new stored plan for new work.
