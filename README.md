# pi-tasked-phases

Track a spec, phased plan, and checklist inside a Pi session.

## What it does

- Adds the `tasked_phases` tool for persistent spec, phase, and task state.
- Injects compact hidden plan context before turns.
- Adds `/phases` for an interactive status view.
- Shows progress in Pi's status UI.
- Includes a `tasked-phases` skill for spec-to-checklist workflows.

## Install

```bash
pi install git:github.com/bnema/pi-tasked-phases
```

## Workflow

```text
/phases
```

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

The tool state is the source of truth. State is reconstructed from tool results, so branching and session resume stay consistent. `set_phase_checked` bulk-checks or reopens every task in a phase. Routine update actions return compact progress summaries to avoid repeating the full checklist in model context.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
