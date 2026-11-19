# AI Production Workflow

This branch is the operating model for evolving `pdf_viewer` with mostly
hands-off agent work. `main` stays the stable baseline; experimental work
should happen on `codex/*` branches or branches explicitly named by the user.

## Source of truth

README.md describes the product. Focused docs describe the owning surfaces;
ADRs record architectural decisions. AGENTS.md / CLAUDE.md describe how to work.
Use repository plans for ongoing work. Beads is not used.

## Session protocol

1. Inspect the branch and working tree; preserve shared work.
2. Implement the requested scope and update its owning documentation.
3. Verify the changed surface using docs/verification.md and record the exact
   commands and results in the handoff or relevant plan.
4. Follow the publication boundary in CLAUDE.md. Completion alone does not
   authorize committing, pushing or creating a pull request.
