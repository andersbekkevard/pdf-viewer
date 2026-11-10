# AI Production Workflow

This branch is the operating model for evolving `pdf_viewer` with mostly
hands-off agent work. `main` stays the stable baseline; experimental work
should happen on `codex/*` branches or branches explicitly named by the user.

## Source of truth

- `README.md` is the product orientation: what exists, how the viewer works,
  and how the human uses it.
- `CLAUDE.md` / `AGENTS.md` is agent orientation: repo shape, commands,
  gotchas, and workflow rules. `AGENTS.md` is a symlink to `CLAUDE.md`; keep
  guidance single-sourced there.
- `docs/adr/` records decisions that constrain future work. Add or amend an
  ADR when a choice changes architecture, key strategy, daemon/conversion
  boundaries, or browser-extension behavior.
- Focused reference docs own focused facts: `docs/keybindings.md` owns keys
  and palette commands, `docs/cache.md` owns cache semantics, and
  `docs/pdf2htmlex-dom.md` owns converted DOM assumptions.
- `.beads/issues.jsonl` is the active work queue. The SQLite database in
  `.beads/` is local runtime state and is intentionally ignored.
- `TODO.md` is legacy intake. Do not add new work there; move actionable items
  into beads and leave `TODO.md` as historical notes.

## Bead shape

Every non-trivial bead should be independently pickable by a future agent. Use
this description structure:

```markdown
## Context

Why this matters and which files/docs are relevant.

## What to build

The smallest end-to-end behavior change that would make progress.

## Acceptance criteria

- [ ] Observable outcome
- [ ] Documentation impact handled or explicitly not needed
- [ ] Verification command or manual check named

## Verification

The exact command, browser flow, daemon check, or Raycast/Comet check that
proves the work.
```

Use labels to mark autonomy:

- `AFK`: implementable without more human judgement.
- `HITL`: requires user choice, product judgement, visual review, or a real
  PDF workflow check before implementation can continue.

Use dependencies instead of prose when order matters:

```bash
br dep add <blocked-bead-id> <blocker-bead-id>
```

## Session protocol

1. Run `br sync --status` and `br ready` before starting work.
2. Claim one bead with `br update <id> --claim`, or create a new bead if the
   user asks for work that is not tracked yet.
3. Keep scope to the bead. If a new issue appears, create a linked bead instead
   of broadening the current change.
4. Update docs in the same change when behavior, workflow, commands,
   keybindings, or architecture constraints change.
5. Verify with the narrowest real check that exercises the changed surface; use
   `docs/verification.md` to choose the right browser, daemon, or manual proof.
6. Add a `br comments add <id> --message "Verification: ..."` note with the
   command/browser flow and result.
7. Close the bead only after implementation, docs, and verification are done.
8. Run `br sync --flush-only` before ending so `.beads/issues.jsonl` is current.

`CLAUDE.md` ("Publication boundary") describes the publish path. Use
`git push` and PR creation only when the user asks for publication or the
session is explicitly a shipping session.

## Documentation rules

- Prefer updating the owning doc over creating a new parallel note.
- Link to existing docs instead of duplicating their content.
- Keep accepted decisions in ADRs, not in bead comments or scratch notes.
- Keep unresolved work in beads, not docs prose.
- When documentation and code disagree, verify the live behavior, fix the owner
  doc, and create a bead if the code needs follow-up.
