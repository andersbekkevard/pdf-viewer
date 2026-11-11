# Architectural Decision Records

This directory holds ADRs (Architectural Decision Records) for `pdf_viewer`.

## What an ADR is

An ADR is a short, dated document capturing **one architectural decision** —
the context that forced a choice, the decision itself, the rationale behind
it, and the consequences that follow. One decision per file.

Popularized by Michael Nygard (2011); format used widely across the
industry.

## Why we bother

Code shows *what* the system does. Commit messages and PR descriptions show
*what changed*. Neither durably captures *why* a given architectural choice
was made or what alternatives were rejected. Within a few weeks the
reasoning is in the maintainer's head only; within a few months it's gone
entirely.

ADRs exist to preserve the **why**, so that future-me (or a future Claude
session, or anyone reading the repo cold) can:

1. Understand the constraints at the time of the decision
2. See what alternatives were considered and why they were rejected
3. Know which consequences were accepted deliberately (vs. accidental)
4. Decide whether to supersede an ADR when the constraints change

ADRs are **immutable in principle**: you don't rewrite history. When a
decision needs revisiting, write a new ADR that *supersedes* the older
one, and mark the old one Superseded. This preserves the reasoning at
each point in time.

## Filename format

`NNNN-kebab-case-title.md` — four-digit zero-padded index, hyphens, `.md`.

## Structure used here

Every ADR in this folder has these sections:

- **Status** — Accepted / Proposed / Superseded / Deprecated
- **Date** — when the decision was made
- **Context** — the problem or constraints that prompted the choice
- **Decision** — what we chose, stated crisply
- **Rationale** — why this over alternatives
- **Consequences** — what follows (good and bad, both)
- **Related** — references to other ADRs, docs, code, links

Keep each ADR self-contained and scannable. If it exceeds ~400 lines,
it's probably two decisions in one file.

## Current ADRs

| # | Title | Status |
|---|-------|--------|
| 0001 | [pdf2htmlEX as rendering engine](0001-pdf-to-html-engine-pdf2htmlex.md) | Superseded by 0015 |
| 0002 | [Render window and cursor pin model](0002-render-window-and-cursor-pin.md) | Accepted (§A superseded by 0009; §B superseded by 0006) |
| 0003 | [Keyboard shortcut design under Vimium](0003-keyboard-shortcuts-vimium-coexistence.md) | Accepted |
| 0004 | [On-demand Docker, always-on daemon](0004-on-demand-docker-and-daemon-split.md) | Superseded by 0015 for conversion; the always-on daemon stands |
| 0005 | [Vimium scroll scoping via synthetic activation events](0005-vimium-scroll-scoping-via-synthetic-activation.md) | Accepted |
| 0006 | [Scrolloff: CSS scroll-padding plus JS fallback](0006-scrolloff-css-padding-plus-js-fallback.md) | Accepted |
| 0007 | [Native browser find via cached shadow text](0007-native-browser-find-shadow-layer.md) | Superseded by 0009 |
| 0008 | [Proposed mode-aware extension keygate for Vimium coexistence](0008-proposed-mode-aware-extension-keygate.md) | Proposed |
| 0009 | [Native Cmd-F via content-visibility: auto](0009-native-find-via-content-visibility.md) | Accepted |
| 0010 | [Light HTML with external rasters and page text](0010-light-html-external-rasters-page-text.md) | Superseded by 0015 |
| 0011 | [Native arm64 pdf2htmlEX (no Docker for conversion)](0011-native-arm64-pdf2htmlex.md) | Superseded by 0015 |
| 0012 | [Page zoom lives on the pages, not the scroller](0012-page-zoom-off-the-scroller.md) | Accepted |
| 0013 | [Patch pdf2htmlEX for text-layer fidelity](0013-patched-pdf2htmlex-text-fidelity.md) | Superseded by 0015 |
| 0014 | [Reader: PDFium rasters under a transparent text layer](0014-reader-pdfium-rasters-transparent-text.md) | Accepted; the only engine since 0015 |
| 0015 | [Retire pdf2htmlEX; the reader is the only engine](0015-retire-pdf2htmlex.md) | Accepted |
