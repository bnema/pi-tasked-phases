# pi-tasked-phases

Pi package for spec-driven phased task planning and checklist tracking.

## What it adds

- `tasked_phases` tool for persistent spec + phase + task state
- hidden per-turn context injection so the agent sees the latest stored plan
- branch-aware reconstruction from tool results in the current session branch
- `/phases` command for an interactive status view
- status/widget UI for current progress
- `tasked-phases` skill for spec -> phases -> checklist workflows

## Install

GitHub repo:

```bash
pi install https://github.com/bnema/pi-tasked-phases
```

Local path:

```bash
pi install /path/to/pi-tasked-phases
```

Or test the extension directly:

```bash
pi -e /path/to/pi-tasked-phases/extensions/index.ts
```

## Intended workflow

1. Ask pi to define or refine a spec.
2. Ask pi to store the spec and break the work into phases.
3. Let pi update checklist items as work progresses.
4. Use `/phases` to inspect the current state.

Example prompt:

```text
Define the spec for this feature, split it into phases with concrete checklist tasks, and keep the plan in tasked_phases.
```

## Tool actions

- `get_status`
- `set_spec`
- `replace_plan`
- `add_phase`
- `update_phase`
- `remove_phase`
- `add_task`
- `update_task`
- `remove_task`
- `set_current_phase`
- `set_task_checked`
- `set_phase_checked`
- `clear`

## Notes

- The tool state is the source of truth.
- State is reconstructed from tool results, so branching and session resume stay consistent.
- `set_phase_checked` bulk-checks or reopens every task in a phase.
- Tool rendering is intentionally quiet so background planning updates create less UI noise.
- This package does not write checklist files; it keeps state inside the pi session.
