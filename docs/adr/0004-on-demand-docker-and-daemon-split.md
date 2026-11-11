# ADR 0004 — On-demand Docker, always-on daemon

**Status**: Superseded: conversion is gone ([ADR 0015](0015-retire-pdf2htmlex.md)); the always-on local daemon stands
**Date**: 2026-04-21

## Context

pdf2htmlEX ships only as a Docker image (ADR 0001). Docker Desktop on
macOS is not free:

- ~2–4 GB resident RAM when running
- Background CPU/disk churn for the virtualization layer (linuxkit,
  virtiofs)
- Noticeable fan spin-up and battery drain
- Slow cold-start when not already running (10–20 seconds to be
  command-ready)

The user reads PDFs across ~15 textbooks and occasional online PDFs.
A given PDF is converted **once**, then read dozens of times from cache.
Measuring the workload honestly:

- **Conversions per week**: maybe 1–5, often zero
- **PDF reads per week**: hundreds, most hitting the cache

If Docker ran continuously to support rare conversions, the cost/benefit
is absurd — 24×7 resource usage for a few minutes of actual work per
week.

Meanwhile, the **read path** (serving cached HTML) is trivial: a
plain-HTTP static-file server. No Docker involved, no heavy deps.

So the two workloads have wildly different resource profiles. Binding
them together is wasteful.

## Decision

Split the architecture into two distinct layers with different uptime
characteristics:

### Layer 1 — Always-on lightweight daemon (phase 4)

- Small FastAPI process (target: <30 MB RSS)
- Listens on `localhost:7435`
- Autostarts via launchd (`KeepAlive=true`) on login
- Jobs:
  - Serve cached HTML from `~/.cache/pdf_viewer/<hash>/*.html`
  - Serve overlay assets from `~/.cache/pdf_viewer/_assets/` (symlinked to repo)
  - Hash incoming `/view?path=`, `/view?url=`, or extension
    `/view-raw?<url>` requests → check cache → stream HTML if hit, or
    307-redirect to the original URL if miss
  - Track visits (eventually, for LRU eviction)
- Does **not** invoke Docker. Never. The daemon itself doesn't know what
  pdf2htmlEX is.

### Layer 2 — On-demand compute (Docker + pdf2htmlEX)

- Docker Desktop runs **only when the user wants to convert something**
- Two user-facing triggers:
  - Raycast `pdf-viewer-convert` — convert current Comet tab's PDF
  - Raycast `pdf-viewer-index-directory` — bulk convert all PDFs under
    a folder recursively
- Both invoke Docker directly, convert via pdf2htmlEX, write into
  `~/.cache/pdf_viewer/<hash>/`, exit. Docker stays on (or not — user's
  choice).
- User is responsible for starting Docker Desktop before running these
  shortcuts. Failure mode: script fails fast with a clear message if
  the Docker daemon isn't reachable.

### Cache miss handling

When a user clicks a PDF link the daemon hasn't seen:

1. Browser (via extension redirect) → `localhost:7435/view-raw?<X>`
2. Daemon: hash X, check cache, **miss**
3. Daemon: `307 Location: <X>` → browser opens `<X>` natively (Chrome's
   PDF viewer, degraded but functional)
4. User decides: "I want this in HTML." Starts Docker if not running.
   Triggers the Raycast shortcut.
5. Conversion runs, cache populated. User can re-click the original
   link (or hit back + forward) and now gets the HTML viewer.

Docker is required *only* in step 4.

## Rationale

**The read/write ratio makes this obvious.** Paying 24×7 Docker cost for
occasional writes would waste resources 99%+ of the time.

**Docker Desktop is not a cheap dependency.** On Apple Silicon macOS, it
reserves CPU cores and RAM that the user notices. Keeping it off most
of the time is a concrete battery/thermal win.

**The daemon doesn't need Docker.** Cache reads are just file reads.
FastAPI + uvicorn + a couple of routes is fine. No Docker SDK, no
privileged access. This also means the daemon never crashes due to
Docker issues.

**Conversion failure modes stay isolated.** Docker down? The convert
script fails with a clear error. The daemon keeps working, all cached
docs keep reading. No user-visible impact beyond the convert attempt.

**User controls the heavy tool.** Anders starts Docker when he sits
down to convert new material. Rest of the time it's off. Mirrors how
he already uses Docker for other projects — on-demand, not daemonized.

**Explicit over implicit.** An alternative is "auto-start Docker from
the convert script." Rejected because:
- `open -a Docker` takes 10–20s before the daemon is responsive
- If we auto-start, we might auto-kill too, which is dangerous if the
  user had other Docker work going
- Anders prefers explicit actions over automation he can't trust

## Consequences

### Accepted downsides

- **User has to start Docker manually before a conversion.** Small
  friction, maybe 15 seconds once before a conversion session. Accepted
  because the alternative (Docker always on) is far more expensive.

- **First-time visitors to a PDF get the degraded native viewer.**
  Until they explicitly convert. Acceptable because it's a fallback,
  not a regression — before pdf_viewer existed, every PDF was in the
  native viewer.

- **The daemon must not assume Docker is reachable.** Any code in the
  daemon that shells out to `docker` is a bug. Convert paths live in
  a separate Raycast script that is invoked on-demand and short-lived.

### Wins

- Laptop stays quiet and cool when not converting.
- Daemon is trivially stable (plain Python + FastAPI, no external deps
  beyond what FastAPI needs).
- Adding new conversion engines (marker, docling, a frontier VLM API)
  means adding new Raycast shortcuts that write into the same cache
  layout. No daemon changes needed.
- Conversion scripts can be run headlessly (cron, batch) without
  involving the daemon — useful for bulk pre-indexing.

### Implicit guarantees

- **The daemon never blocks on Docker.** Any code path that would
  require Docker must live outside the daemon, in a Raycast-invoked
  script. If we ever feel tempted to add a `/convert` endpoint that
  auto-starts Docker, this ADR is the gate.

## Related

- plan.md §0 (problem statement — scenario table maps one-to-one to
  the layers defined here)
- plan.md §5 (phased roadmap — phase 4 is the daemon, phase 5 is its
  launchd plist, phase 6 is the extension that redirects into it)
- ADR 0001 (why pdf2htmlEX, which is why Docker)
- `scripts/pdf2html-convert.sh` — already follows this pattern (fails
  fast with "Docker daemon not running — start Docker.app" if docker
  info returns nonzero)
