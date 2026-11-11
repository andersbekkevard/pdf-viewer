# ADR 0011 — Native arm64 pdf2htmlEX (no Docker for conversion)

**Status**: Superseded by [ADR 0015](0015-retire-pdf2htmlex.md) (pdf2htmlEX retired 2026-11-11)
**Date**: 2026-06-12
**Supersedes**: the Docker-compute half of [ADR 0004](0004-on-demand-docker-and-daemon-split.md)

## Context

ADR 0001 picked pdf2htmlEX as the rendering engine; ADR 0004 accepted
that the only distribution that existed was an x86_64 Docker image
(`pdf2htmlex/pdf2htmlex:0.18.8.rc2-…-x86_64`) and built the
on-demand-Docker / always-on-daemon split around it. On Apple Silicon
that image runs inside Docker Desktop's arm64 Linux VM **under
Rosetta 2**: every instruction of the pdf2htmlEX C++ pipeline is
translated x86 → arm64 before it executes. Rosetta's overhead on
compute-heavy C++ is ~2–2.5×, and it is the dominant cost of any
non-trivial conversion. A 1,137-page textbook took ~101 s.

`docs/arm64-native-proposals.md` (2026-04-22) surveyed the options.
No off-the-shelf arm64 build existed: the 2019 Homebrew tap is
abandoned, MacPorts has never built on darwin-arm64, upstream ships
only x86_64 release artifacts, and every "M-series" community Docker
image is still an amd64 manifest leaning on Rosetta. The only path to
native arm64 was to build it ourselves. That doc recommended **Option 1**
(fork the Dockerfile, target `linux/arm64`) as the low-risk way to
capture the Rosetta speedup while keeping the Docker split intact, and
explicitly flagged Option 2 (a native darwin-arm64 binary, no Docker)
as the higher-effort, higher-risk path to revisit only if we wanted to
drop the Docker dependency entirely.

We did the experiment on Option 2 anyway, and it worked.

## Decision

Convert with a **natively-built darwin-arm64 pdf2htmlEX binary** and
drop Docker from the conversion path entirely.

Provenance and toolchain:

- Built from upstream `pdf2htmlEX/pdf2htmlEX` master (July 2025) in
  `~/dev/external/pdf2htmlEX_v2/` against modern Homebrew deps:
  poppler 24.06.1, fontforge 20230101, cairo 1.18.4. **Zero patches to
  pdf2htmlEX source.**
- A sibling tree `~/dev/external/pdf2htmlEX/` (v1) holds a stricter
  legacy-parity build — poppler pinned to 0.89.0 to match the Docker
  image, 13 source patches including Base14→DejaVu font bundling. It is
  kept as a research reference and is **not** the production binary.
- The **v2 modern-deps build is what ships.** The installer
  `scripts/install-native-pdf2htmlex.sh` copies the binary and its
  `share/pdf2htmlEX` data dir out of the v2 build tree into a stable,
  relocation-safe prefix at `~/.local/opt/pdf2htmlEX/`. It copies only —
  never rebuilds, never touches Docker, never hits the network.

Invocation (from `scripts/pdf2html-convert.sh` and
`scripts/index-directory*.sh`) always passes data dirs explicitly:

- `--data-dir ~/.local/opt/pdf2htmlEX/share/pdf2htmlEX` — the binary's
  baked default points back into the fragile v2 build tree, which breaks
  if that tree is moved or deleted.
- `--poppler-data-dir /opt/homebrew/share/poppler` — the baked poppler
  default is a version-pinned Homebrew Cellar path that breaks on a
  `brew upgrade poppler`; the `/opt/homebrew/share/poppler` symlink is
  stable. Poppler data is needed for CJK / CID-encoded PDFs.

## Rationale

**v2 (modern deps, zero patches) over v1 (legacy parity, 13 patches).**
The instinct is that matching the 2020 Docker image's poppler 0.89.0
byte-for-byte is the safe choice. It is not the right contract. The
real contract this viewer depends on is the **DOM conventions of the
converted HTML** (`docs/pdf2htmlex-dom.md`) plus human readability — not
pixel-identity with a five-year-old image. v2 buys a maintained poppler,
a clang/libc++-clean build, and an empty patch queue, which is what
makes the binary something we can actually rebuild and carry forward.
v1's pinned poppler and font-bundling patches are interesting as a
parity experiment but are dead weight to maintain in production.

**Verified parity is good enough.** On the 7-fixture upstream sample set
the native binary produced exact structural parity and ≤5% pixel diff
(anti-aliasing only, max 4.72%). On a real 1,137-page textbook
(Datamaskiner-Pensumbok) it produced identical page/span/image counts
(1137 / 59749 / 1137) and **byte-identical visible text** versus the
cached Docker output. The one known residual is that FontForge emits
subtly different WOFF glyph outlines on arm64, yielding sub-pixel
anti-aliasing differences. That is cosmetic and well inside the
"readable + same DOM" contract.

**The recommendation was overridden because the extra wins were real,
not marginal.** Option 1 only kills Rosetta. Option 2 kills Rosetta
*and* the ~1–2 s Docker container startup per run *and* the Docker
Desktop dependency for conversion altogether. The proposals doc judged
those extra wins "small in absolute terms"; in practice removing the
Docker requirement simplifies the UX enough (no "is Docker running?"
precondition, no Docker Desktop RAM/thermal footprint at all) to justify
the higher build effort — and the build effort turned out to be tractable
because building against *modern* deps (v2), rather than resurrecting the
vendored 2019 poppler, sidestepped the rabbit-hole the proposals doc
feared.

## Consequences

### Wins

- **~1.44× faster on the big book**: 70 s native vs 101 s Docker/Rosetta
  on the 1,137-page textbook. The proportional win is larger on small
  PDFs, where Docker + Rosetta startup is a bigger fraction of total
  wall-time.
- **Docker Desktop is no longer needed for conversion at all.** No "start
  Docker first" precondition, no background VM RAM/CPU/thermal cost. The
  laptop stays quiet during a convert session, not just between them.
- **The conversion engine is now rebuildable.** Modern deps + zero
  patches means the v2 tree can be rebuilt against newer poppler/cairo
  without un-rotting a 2019 formula.

### Accepted downsides

- **Mixed-provenance cache.** Existing cache entries were Docker-converted
  and are kept as-is — the cache is content-hash keyed, so nothing is
  re-converted on upgrade. Only future cache misses run the native binary.
  We accept a cache that mixes Docker-era and native-era HTML; both honor
  the same DOM conventions, so the overlay can't tell them apart.
- **WOFF / anti-aliasing residual.** Native-converted pages have sub-pixel
  AA differences from the Docker output because FontForge's arm64 WOFF
  outlines differ. Cosmetic; visible text and layout are identical.
- **Homebrew dylib runtime dependency.** The binary links several Homebrew
  dylibs (cairo, glib, freetype, …) via `/opt/homebrew/opt/*` and needs
  `/opt/homebrew/share/poppler`. These are runtime requirements, not
  bundled. The installer warns (does not fail) on a missing dylib or
  poppler data dir. **Rebuild path**: if a `brew upgrade` breaks the
  linkage, rebuild in `~/dev/external/pdf2htmlEX_v2/` (`native/build.sh`)
  and re-run `scripts/install-native-pdf2htmlex.sh`.
- **Thumbs/meta extraction** (`extract-pdf-thumbs.sh`,
  `extract-pdf-meta.sh`) now rely on local Homebrew poppler utils and
  soft-skip if those are missing — the same Homebrew-dependency posture
  as the converter.

### Distribution (portable install, no build tree)

The local build tree (`~/dev/external/pdf2htmlEX_v2/`) is a one-off
artifact — a fresh Mac or a lost `external/` tree leaves the installer
with nothing to copy. To make the toolchain installable anywhere, the
binary is also published as a **relocatable bundle** through a personal
Homebrew tap:

- **Tap**: `andersbekkevard/homebrew-tools`
  (`brew tap andersbekkevard/tools`).
- **Formula**: `pdf2htmlex` — a binary pour (not a from-source build) of
  a relocatable bundle attached to a GitHub release
  (`pdf2htmlex-v0.18.8.rc2-1`). The bundle ships the binary plus every
  Homebrew dylib it links, copied into `lib/` with
  `@executable_path/../lib` install names and ad-hoc re-signed, so it
  needs **no `/opt/homebrew/*` dylibs at runtime** (`otool -L` shows zero
  `/opt/homebrew` references across the binary and all 22 bundled libs).
  The keg lays the bundle out under `libexec/{bin,lib,share}` so
  `brew link` can't shadow real Homebrew kegs (cairo, glib, …) in
  `/opt/homebrew/lib`; only the binary is symlinked into `bin`.
- **Installer fallback**: `scripts/install-native-pdf2htmlex.sh` now tries
  the local build tree first, then falls back to the brew keg
  (`brew --prefix andersbekkevard/tools/pdf2htmlex`), copying
  `bin` + `lib` + `share` into `~/.local/opt/pdf2htmlEX/` (the brew path
  additionally populates `lib/`; the build-tree path leaves it absent
  since that binary uses absolute `/opt/homebrew` links). The
  `~/.local/opt/pdf2htmlEX/{bin,share}` contract the pipeline depends on
  is unchanged.

This is the fallback path from bead `pdfv-6el.1`. Encoding the full
from-source build as a brew formula (so brew owns deps and arm64 rebuilds
on any Mac) remains the preferred long-term shape; the relocatable bundle
ships today and survives a `brew upgrade poppler` because its deps are
bundled, not linked.

### Relationship to ADR 0004

This ADR **supersedes the Docker-compute half of ADR 0004**. ADR 0004's
"on-demand Docker" layer no longer exists: conversion is a native binary,
so there is no Docker Desktop to start before a convert session and no
"Docker daemon not running" failure mode. The convert script now fails
fast on a missing *native binary* instead, pointing at
`install-native-pdf2htmlex.sh`.

ADR 0004's **other half still stands**: the daemon is read-only, never
invokes the converter, and survives any conversion-side failure. The
daemon never touched Docker, so removing Docker changes nothing about it.
The architectural principle — scary/heavy work lives in Raycast-invoked
scripts, the always-on daemon only reads cache — is unchanged; only the
identity of the heavy tool changed (Docker image → native binary).

## Related

- [ADR 0001](0001-pdf-to-html-engine-pdf2htmlex.md) — pdf2htmlEX as the
  engine (still holds; only the packaging changed)
- [ADR 0004](0004-on-demand-docker-and-daemon-split.md) — Docker-compute
  half superseded here; daemon-independence half stands
- [`docs/arm64-native-proposals.md`](../arm64-native-proposals.md) —
  the survey that recommended Option 1; Option 2 shipped instead
- [`docs/pdf2htmlex-dom.md`](../pdf2htmlex-dom.md) — the DOM contract that
  is the real parity target
- `scripts/install-native-pdf2htmlex.sh` — copy-only installer into
  `~/.local/opt/pdf2htmlEX/`
- `scripts/pdf2html-convert.sh`, `scripts/index-directory.sh` — native
  invocation with explicit `--data-dir` / `--poppler-data-dir`
- Build trees: `~/dev/external/pdf2htmlEX_v2/` (production, modern deps),
  `~/dev/external/pdf2htmlEX/` (v1 legacy-parity research reference)
