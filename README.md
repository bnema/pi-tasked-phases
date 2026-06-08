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

## Use

```text
/phases
```

Example prompt:

```text
Define the spec for this feature, split it into phases with concrete checklist tasks, and keep the plan in tasked_phases.
```

Tool actions include `set_spec`, `replace_plan`, `add_phase`, `add_task`, `set_task_checked`, and `get_status`.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
