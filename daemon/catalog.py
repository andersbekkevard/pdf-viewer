"""Cache catalog: the filesystem-backed interface to the library of PDFs.

The catalog owns cache identity, mappings, disabled state, native-source
discovery, library projection, and safe mutations.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
import pathlib
import re
import shutil
import threading
import tempfile
import time
import urllib.parse
from typing import Optional, Protocol


ENTRY_MANIFEST = "entry.json"
PASSTHROUGH_MARKER = "_pdfvw=passthrough"
HASH_RE = re.compile(r"^[a-f0-9]{6,32}$")
NAME_MAX_LEN = 200


class CatalogError(Exception):
    """Base class for cache-interface errors."""


class InvalidCatalogInput(CatalogError):
    pass


class EntryNotFound(CatalogError):
    pass


class Activity(Protocol):
    def all_frecency(self) -> dict[str, dict]: ...
    def boost(self, hash_: str, n: int = 3) -> int: ...
    def forget(self, hash_: str) -> int: ...


class NullActivity:
    def all_frecency(self) -> dict[str, dict]:
        return {}

    def boost(self, hash_: str, n: int = 3) -> int:
        return 0

    def forget(self, hash_: str) -> int:
        return 0


@dataclass(frozen=True)
class Mapping:
    hash: str
    source_ref: str
    name: str
    html_path: pathlib.Path


@dataclass(frozen=True)
class ResolvedSource:
    hash: str
    source_ref: str
    disabled: bool


@dataclass(frozen=True)
class NativeSource:
    kind: str
    value: pathlib.Path | str


def url_hash(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    return hashlib.sha256(f"{parsed.netloc}{parsed.path}".encode()).hexdigest()[:16]


# The passthrough marker is added and removed as a literal `&`-separated
# query item. Every other byte of the query is preserved: re-encoding it
# would break signed URLs and URLs embedded raw in a daemon query string.

def _query_items(url: str) -> tuple[urllib.parse.ParseResult, list[str]]:
    parsed = urllib.parse.urlparse(url)
    return parsed, parsed.query.split("&") if parsed.query else []


def strip_passthrough(url: str) -> str:
    parsed, items = _query_items(url)
    kept = [item for item in items if item != PASSTHROUGH_MARKER]
    if len(kept) == len(items):
        return url
    return urllib.parse.urlunparse(parsed._replace(query="&".join(kept)))


def with_passthrough(url: str) -> str:
    parsed, items = _query_items(url)
    if PASSTHROUGH_MARKER in items:
        return url
    return urllib.parse.urlunparse(parsed._replace(query="&".join(items + [PASSTHROUGH_MARKER])))


_LOCAL_QUIET_SEC = 0.6


def _snapshot_file(source: pathlib.Path, dest: pathlib.Path) -> None:
    """Copy-on-write clone where the filesystem has one (APFS): no bytes move."""
    dest.unlink(missing_ok=True)
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.clonefile(os.fsencode(source), os.fsencode(dest), 0) == 0:
            return
    except (AttributeError, OSError):
        pass
    dest.unlink(missing_ok=True)
    shutil.copyfile(source, dest)


class CacheCatalog:
    """Deep module over one cache root.

    Callers provide only source identities and entry hashes. Filesystem layout and cross-file mutation rules stay here.
    """

    def __init__(self, root: pathlib.Path, activity: Optional[Activity] = None):
        self.root = root
        self.activity = activity or NullActivity()
        self._content_hashes: dict[tuple[str, int, int], str] = {}
        self._manifests: Optional[dict[str, dict]] = None
        self._manifests_stamp: Optional[int] = None
        # Request threads register entries while others list them; a scan that
        # started before a write must not replace the copy that has it.
        self._manifests_lock = threading.RLock()
        # While one thread lists the library, its many per-entry lookups share
        # one read of mappings.tsv instead of re-reading it per lookup.
        self._listing = threading.local()

    @property
    def mappings_path(self) -> pathlib.Path:
        return self.root / "mappings.tsv"

    @property
    def disabled_path(self) -> pathlib.Path:
        return self.root / "disabled.json"

    def validate_hash(self, hash_: str) -> str:
        if not HASH_RE.fullmatch(hash_):
            raise InvalidCatalogInput("invalid hash")
        return hash_

    def _tsv_mappings(self) -> dict[str, Mapping]:
        out: dict[str, Mapping] = {}
        if not self.mappings_path.is_file():
            return out
        with self.mappings_path.open(encoding="utf-8") as source:
            for line in source:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 4:
                    continue
                _ts, source_ref, hash_, html_path = parts[:4]
                path = pathlib.Path(html_path) if html_path else self.root / hash_ / f"{hash_}.html"
                out[hash_] = Mapping(hash_, source_ref, path.stem, path)
        return out

    def mappings(self) -> dict[str, Mapping]:
        """Every known entry: the entries registered on demand, which carry
        their identity in `<hash>/entry.json`, plus mappings.tsv rows, which
        the retired conversion scripts wrote. A row wins over a manifest for
        the same hash: its name is the stem of the HTML path it records,
        which is where :rename kept the names of converted entries."""
        memo = getattr(self._listing, "mappings", None)
        if memo is not None:
            return memo
        out = self._tsv_mappings()
        for hash_, manifest in self.manifests().items():
            if hash_ in out:
                continue
            name = manifest.get("name") or hash_
            out[hash_] = Mapping(hash_, manifest.get("source_ref", ""), name,
                                 self.root / hash_ / f"{name}.html")
        return out

    # ------------------------------------------------------------ manifests
    def manifests(self) -> dict[str, dict]:
        """`<hash>/entry.json` of every entry that has one. Entry directories
        coming and going change the root's mtime, which refreshes the scan;
        this process's own writes update the cached copy directly."""
        with self._manifests_lock:
            return self._scan_manifests()

    def _scan_manifests(self) -> dict[str, dict]:
        try:
            stamp = self.root.stat().st_mtime_ns
        except OSError:
            return {}
        if self._manifests is None or stamp != self._manifests_stamp:
            found: dict[str, dict] = {}
            for path in self.root.glob(f"*/{ENTRY_MANIFEST}"):
                if not HASH_RE.fullmatch(path.parent.name):
                    continue
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                if isinstance(data, dict):
                    found[path.parent.name] = data
            self._manifests, self._manifests_stamp = found, stamp
        return self._manifests

    def _write_manifest(self, hash_: str, manifest: dict) -> None:
        with self._manifests_lock:
            self._write_manifest_locked(hash_, manifest)

    def _write_manifest_locked(self, hash_: str, manifest: dict) -> None:
        entry_dir = self.root / hash_
        entry_dir.mkdir(parents=True, exist_ok=True)
        path = entry_dir / ENTRY_MANIFEST
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp.replace(path)
        self.manifests()[hash_] = manifest
        try:
            self._manifests_stamp = self.root.stat().st_mtime_ns
        except OSError:
            pass

    def register(self, hash_: str, source_ref: str, name: str) -> dict:
        """Record an entry opened on demand. Keeps an existing name (the
        reader may have renamed it) and refreshes the source reference, so
        a moved file or a re-signed URL stays reachable."""
        self.validate_hash(hash_)
        current = self.manifests().get(hash_)
        manifest = dict(current) if current else {"name": self._sanitize_name(name) or hash_}
        source_ref = strip_passthrough(source_ref)
        if source_ref.startswith("/"):
            # Keep the lexical path so extension rules match the file URL.
            source_ref = self.local_path(pathlib.Path(source_ref))
        refs = list(manifest.get("source_refs", [manifest.get("source_ref")]))
        refs = [r for r in refs if r]
        if source_ref not in refs:
            refs.append(source_ref)
        if source_ref.startswith("/") or any(r.startswith("/") for r in refs):
            if len(refs) > 1 or "source_refs" in manifest:
                manifest["source_refs"] = refs
        manifest["source_ref"] = source_ref
        if manifest != current:
            self._write_manifest(hash_, manifest)
        return manifest

    @staticmethod
    def local_path(path: pathlib.Path) -> str:
        # Preserve every symlink component: this is the browser's file URL.
        path = path.expanduser().absolute()
        return str(path)

    def local_entry(self, path: pathlib.Path) -> Optional[str]:
        needle = self.local_path(path)
        for hash_, manifest in self.manifests().items():
            if needle in manifest.get("source_refs", [manifest.get("source_ref")]):
                return hash_
        return self._mapped_hash_for_path(path)

    @staticmethod
    def local_stamp(path: pathlib.Path) -> str:
        st = path.stat()
        return f"{st.st_dev}:{st.st_ino}:{st.st_size}:{st.st_mtime_ns}:{st.st_ctime_ns}"

    def open_local(self, path: pathlib.Path, validate, inherit) -> tuple[str, str]:
        """Publish an immutable, parsed snapshot, then move just this path's reference.

        The lock serializes reference/state transfers and GC. PDFium validation
        is supplied by the adapter and runs in the reader's worker process.
        """
        source = self.local_path(path)
        path = pathlib.Path(source)
        with self._manifests_lock:
            before = self.local_stamp(path)
            previous = self.local_entry(path)
            old = self.manifests().get(previous, {})
            if old.get("local_stamps", {}).get(source) == before and self.cached_source(previous):
                return previous, before
            self.root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="_local-", dir=self.root) as scratch:
                snapshot = pathlib.Path(scratch) / "source.pdf"
                _snapshot_file(path, snapshot)
                # Only a file written in the last moments can still be mid-save;
                # an older one is opened without waiting.
                quiet = _LOCAL_QUIET_SEC - (time.time() - path.stat().st_mtime)
                if quiet > 0:
                    time.sleep(min(quiet, _LOCAL_QUIET_SEC))
                    if before != self.local_stamp(path):
                        raise InvalidCatalogInput("local PDF is still being written; retry shortly")
                if before != self.local_stamp(path):
                    raise InvalidCatalogInput("local PDF is still being written; retry shortly")
                with snapshot.open("rb") as stream:
                    stream.seek(max(0, snapshot.stat().st_size - 2048))
                    if b"%%EOF" not in stream.read():
                        raise InvalidCatalogInput("local PDF is incomplete; retry after saving")
                pages = validate(snapshot)
                if not pages:
                    raise InvalidCatalogInput("local PDF has no pages")
                if before != self.local_stamp(path):
                    raise InvalidCatalogInput("local PDF changed during validation; retry shortly")
                hash_ = self._content_hash(snapshot)
                target_exists = hash_ in self.mappings()
                dest = self.root / hash_ / "_source" / "source.pdf"
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    snapshot.replace(dest)
                if previous and previous != hash_ and not target_exists:
                    inherit(previous, hash_, len(pages))
                manifest = self.register(hash_, source, path.stem)
                # Track each browser-visible local alias independently.
                refs = list(manifest.get("source_refs", [manifest.get("source_ref")]))
                if source not in refs:
                    refs.append(source)
                manifest.update(source_ref=source, source_refs=refs, pages=len(pages))
                manifest.setdefault("local_stamps", {})[source] = before
                self._write_manifest(hash_, manifest)
                if previous and previous != hash_:
                    old = dict(old)
                    refs = [r for r in old.get("source_refs", [old.get("source_ref")]) if r and r != source]
                    # A legacy TSV reference is an independent source too.
                    mapping = self._tsv_mappings().get(previous)
                    if mapping and mapping.source_ref != source and mapping.source_ref not in refs:
                        refs.append(mapping.source_ref)
                    if refs:
                        old.update(source_ref=refs[-1], source_refs=refs)
                        old.get("local_stamps", {}).pop(source, None)
                        self._write_manifest(previous, old)
                    else:
                        self.delete(previous)
                return hash_, before

    def _content_hash(self, path: pathlib.Path) -> str:
        stat = path.stat()
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if key in self._content_hashes:
            return self._content_hashes[key]
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1 << 20), b""):
                digest.update(chunk)
        value = digest.hexdigest()[:16]
        if len(self._content_hashes) >= 128:
            self._content_hashes.clear()
        self._content_hashes[key] = value
        return value

    def _mapped_hash_for_path(self, path: pathlib.Path) -> Optional[str]:
        lexical = self.local_path(path)
        resolved = str(path.expanduser().resolve())
        candidates = []
        for hash_, mapping in self.mappings().items():
            refs = self.manifests().get(hash_, {}).get("source_refs", [mapping.source_ref])
            for ref in refs:
                if ref and ref.startswith("/"):
                    if ref == lexical:
                        return hash_
                    candidates.append((hash_, ref))
        return next((hash_ for hash_, ref in candidates
                     if str(pathlib.Path(ref).resolve()) == resolved), None)

    def _hash_for_local_path(self, path: pathlib.Path) -> Optional[str]:
        mapped = self._mapped_hash_for_path(path)
        if mapped:
            return mapped
        try:
            resolved = path.expanduser().resolve(strict=True)
        except FileNotFoundError:
            return None
        if not resolved.is_file():
            return None
        try:
            return self._content_hash(resolved)
        except OSError:
            return None

    def resolve_source(self, source: str | pathlib.Path) -> ResolvedSource:
        if isinstance(source, pathlib.Path):
            hash_ = self._mapped_hash_for_path(source)
            if hash_ is None:
                try:
                    hash_ = self._content_hash(source)
                except OSError:
                    hash_ = ""
            source_ref = str(source)
        else:
            parsed = urllib.parse.urlparse(source)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise InvalidCatalogInput("source URL must be absolute http(s)")
            source_ref = strip_passthrough(source)
            hash_ = url_hash(source_ref)
        return ResolvedSource(hash_, source_ref, self.is_disabled(hash_))

    def source_ref(self, hash_: str) -> Optional[str]:
        mapping = self.mappings().get(hash_)
        return strip_passthrough(mapping.source_ref) if mapping else None

    def cached_source(self, hash_: str) -> Optional[pathlib.Path]:
        source_dir = self.root / hash_ / "_source"
        matches = sorted(source_dir.glob("*.pdf")) if source_dir.is_dir() else []
        return matches[0] if matches else None

    def source_pdf(self, hash_: str) -> Optional[pathlib.Path]:
        """The PDF bytes behind an entry: the local original when it still
        exists, else the cached download. None when neither is on disk."""
        if not HASH_RE.fullmatch(hash_ or ""):
            return None
        cached = self.cached_source(hash_)
        if cached:
            return cached
        source_ref = self.source_ref(hash_)
        if source_ref and source_ref.startswith("/"):
            path = pathlib.Path(source_ref)
            if path.is_file():
                return path
        return self.cached_source(hash_)

    def entry_name(self, hash_: str) -> str:
        """Display name: the mapping's name (what :rename changes), else the
        source file's stem."""
        mapping = self.mappings().get(hash_)
        if mapping is not None:
            return mapping.name
        source = self.source_pdf(hash_)
        return source.stem if source else hash_

    def viewer_href(self, hash_: str) -> Optional[str]:
        """Where an entry is read, as an unquoted daemon path: the reader when
        its PDF is on disk, else the route that downloads its URL again.
        None for no entry, and for an entry whose PDF cannot be had."""
        if not HASH_RE.fullmatch(hash_ or ""):
            return None
        if self.source_pdf(hash_) is not None:
            return f"/r/{hash_}/"
        source_ref = self.source_ref(hash_)
        if source_ref and source_ref.startswith(("http://", "https://")):
            return "/read?url=" + urllib.parse.quote(source_ref, safe="")
        return None

    def native_source(self, hash_: str) -> NativeSource:
        if self.viewer_href(hash_) is None:
            raise EntryNotFound(f"no cached PDF viewer entry for hash {hash_}")
        source_ref = self.source_ref(hash_)
        if source_ref and source_ref.startswith("/"):
            path = pathlib.Path(source_ref).expanduser()
            if not path.is_file():
                raise EntryNotFound(f"source PDF not found: {source_ref}")
            return NativeSource("file", path)
        cached = self.cached_source(hash_)
        if cached:
            return NativeSource("file", cached)
        if source_ref and source_ref.startswith(("http://", "https://")):
            return NativeSource("url", with_passthrough(source_ref))
        raise EntryNotFound(f"no native PDF source for hash {hash_}")

    def _disabled_hashes(self) -> set[str]:
        try:
            data = json.loads(self.disabled_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return set()
        values = data.get("disabled", []) if isinstance(data, dict) else data if isinstance(data, list) else []
        return {value for value in values if isinstance(value, str) and HASH_RE.fullmatch(value)}

    def is_disabled(self, hash_: str) -> bool:
        return hash_ in self._disabled_hashes()

    def set_disabled(self, hash_: str, disabled: bool) -> bool:
        self.validate_hash(hash_)
        hashes = self._disabled_hashes()
        before = hash_ in hashes
        hashes.add(hash_) if disabled else hashes.discard(hash_)
        if (hash_ in hashes) != before:
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self.disabled_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"disabled": sorted(hashes)}, indent=2) + "\n", encoding="utf-8")
            tmp.replace(self.disabled_path)
        return hash_ in hashes

    def extension_entries(self) -> list[dict]:
        out = []
        entries = []
        for hash_, mapping in self.mappings().items():
            refs = self.manifests().get(hash_, {}).get("source_refs", [mapping.source_ref])
            entries.extend((hash_, ref) for ref in refs)
        for hash_, source_ref in entries:
            if self.viewer_href(hash_) is None:
                continue
            if source_ref.startswith(("http://", "https://")):
                parsed = urllib.parse.urlparse(source_ref)
                out.append({"kind": "url", "host": parsed.netloc.lower(), "path": parsed.path,
                            "hash": hash_, "disabled": self.is_disabled(hash_)})
            elif source_ref.startswith("/"):
                out.append({"kind": "file", "path": source_ref, "hash": hash_,
                            "disabled": self.is_disabled(hash_)})
        return out

    @staticmethod
    def _search_text(name: str, source_ref: Optional[str]) -> str:
        parts = [name]
        if source_ref:
            parsed = urllib.parse.urlparse(source_ref)
            if parsed.scheme in {"http", "https"}:
                parts += [parsed.netloc, parsed.path, pathlib.PurePosixPath(parsed.path).name]
            else:
                path = pathlib.Path(source_ref)
                parts += [source_ref, path.name, str(path.parent)]
        text = urllib.parse.unquote(" ".join(parts))
        return re.sub(r"\s+", " ", text.casefold()).strip()

    def list_entries(self) -> list[dict]:
        self._listing.mappings = self.mappings()
        try:
            return self._list_entries()
        finally:
            self._listing.mappings = None

    def _list_entries(self) -> list[dict]:
        scores = self.activity.all_frecency()
        out = []
        for hash_, mapping in self.mappings().items():
            href = self.viewer_href(hash_)
            if href is None:
                continue
            score = scores.get(hash_, {"raw_count": 0, "rank": 0, "last_seen": None,
                                       "age_multiplier": 0.0, "frecency_score": 0.0})
            name = self.entry_name(hash_)
            has_source = self.source_pdf(hash_) is not None
            meta = self._entry_meta(hash_)
            out.append({"hash": hash_, "name": name, "source_ref": mapping.source_ref,
                        "search_text": self._search_text(name, mapping.source_ref),
                        "href": href,
                        "reader_href": f"/r/{hash_}/" if has_source else None,
                        "count": score["raw_count"], "rank": score["rank"],
                        "last_seen": score["last_seen"], "age_multiplier": score["age_multiplier"],
                        "frecency_score": score["frecency_score"],
                        # Home page (assets/home.js): meta.json fields and a page-1 thumbnail.
                        "pages": meta.get("pages"), "title": meta.get("title"),
                        "author": meta.get("author"),
                        "thumb_href": self._thumb_href(hash_, has_source)})
        out.sort(key=lambda entry: (-entry["frecency_score"], -(entry["last_seen"] or 0), entry["name"].lower()))
        return out

    # Metadata titles that name the authoring tool or file, not the work.
    _JUNK_TITLE = re.compile(
        r"^(untitled|title|document\d*|slide \d+|microsoft (word|powerpoint) - .*|.*\.(docx?|pptx?|pdf|tex|dvi|indd|qxd|rtf))$",
        re.IGNORECASE)

    @classmethod
    def _source_stem(cls, source_ref: str) -> str:
        if source_ref.startswith(("http://", "https://")):
            path = urllib.parse.unquote(urllib.parse.urlparse(source_ref).path)
            return pathlib.PurePosixPath(path).stem
        return pathlib.PurePath(source_ref).stem

    @classmethod
    def display_title(cls, name: str, source_ref: str, meta_title: Optional[str]) -> str:
        """What a reader calls the document: a name chosen with :rename (any
        name that is not the source file's stem), else a usable metadata
        title, else the name."""
        renamed = bool(name) and name != cls._source_stem(source_ref or "") and not HASH_RE.fullmatch(name)
        title = (meta_title or "").strip()
        if not renamed and len(title) >= 3 and not cls._JUNK_TITLE.match(title) and not HASH_RE.fullmatch(title):
            return title
        return name

    def finder_entries(self, positions: dict, current: str = "") -> list[dict]:
        """The library as the overlay's quick-open rows (⌘P, ⌘K, :open).

        Only what a row shows or matches on, so the response stays small:
        title, author, source host, file name, pages, the saved page, when it
        was last read and the frecency score, in frecency order. `last_read`
        is the later of the last open and the last saved page change, in
        seconds. `previous` marks the most recently read document other than
        `current`: ⌘P then Enter goes back to it.
        """
        out = []
        for entry in self.list_entries():
            ref = strip_passthrough(entry["source_ref"] or "")
            parsed = urllib.parse.urlparse(ref)
            web = parsed.scheme in {"http", "https"}
            path = urllib.parse.unquote(parsed.path) if web else ref
            saved = positions.get(entry["hash"])
            last_read = max(entry["last_seen"] or 0, saved[1] // 1000 if saved else 0) or None
            out.append({"hash": entry["hash"], "href": entry["href"], "name": entry["name"],
                        "title": self.display_title(entry["name"], ref, entry["title"]),
                        "author": entry["author"], "host": parsed.netloc.lower() if web else None,
                        "file": pathlib.PurePosixPath(path).name or None, "source_ref": entry["source_ref"],
                        "pages": entry["pages"], "page": saved[0] if saved else None,
                        "last_read": last_read, "rank": entry["rank"], "count": entry["count"],
                        "score": entry["frecency_score"], "previous": False})
        others = [row for row in out if row["hash"] != current and row["last_read"]]
        if others:
            max(others, key=lambda row: row["last_read"])["previous"] = True
        return out

    def _entry_meta(self, hash_: str) -> dict:
        """`<hash>/meta.json` (written by the reader from PDFium), or {}.
        Never opens the PDF."""
        try:
            meta = json.loads((self.root / hash_ / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(meta, dict):
            return {}
        pages = meta.get("pages")
        return {"pages": pages if isinstance(pages, int) and pages > 0 else None,
                "title": str(meta["title"]).strip() or None if meta.get("title") else None,
                "author": str(meta["author"]).strip() or None if meta.get("author") else None}

    def _thumb_href(self, hash_: str, has_source: bool) -> Optional[str]:
        """Page 1 small, rendered by the reader from the source PDF (240 px,
        the width the sidebar's Pages tab already caches)."""
        return f"/r/{hash_}/p/1/240.png" if has_source else None

    def search_entries(self, query: str) -> list[dict]:
        needle = self._search_text(query, None)
        return [entry for entry in self.list_entries() if needle in entry["search_text"]]

    @staticmethod
    def _sanitize_name(raw: str) -> str:
        value = (raw or "").strip()
        if value.lower().endswith(".html"):
            value = value[:-5].rstrip()
        return re.sub(r"[\x00-\x1f/\\]+", "-", value).lstrip(".").strip()[:NAME_MAX_LEN]

    def rename(self, hash_: str, raw_name: str) -> dict:
        self.validate_hash(hash_)
        name = self._sanitize_name(raw_name)
        if not name:
            raise InvalidCatalogInput("name is empty after sanitization")
        if self.viewer_href(hash_) is None:
            raise EntryNotFound(f"no cached PDF viewer entry for hash {hash_}")
        old_name = self.entry_name(hash_)
        renamed = old_name != name
        if renamed:
            row = self._tsv_mappings().get(hash_)
            if row is not None:
                # A row from the retired conversion scripts keeps its name as
                # the stem of the HTML path it records.
                self._rewrite_mapping_html(hash_, row.html_path.with_name(name + ".html"))
            else:
                manifest = self.manifests().get(hash_) or {"source_ref": self.source_ref(hash_) or ""}
                self._write_manifest(hash_, {**manifest, "name": name})
        result = {"hash": hash_, "old_name": old_name, "new_name": name, "renamed": renamed,
                  "href": self.viewer_href(hash_)}
        if renamed:
            result["frecency_boosted"] = self.activity.boost(hash_, n=3)
        return result

    def _rewrite_mapping_html(self, hash_: str, path: pathlib.Path) -> None:
        lines = []
        with self.mappings_path.open(encoding="utf-8") as source:
            for line in source:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 4 and parts[2] == hash_:
                    parts[3] = str(path)
                    line = "\t".join(parts) + "\n"
                lines.append(line if line.endswith("\n") else line + "\n")
        self._atomic_lines(self.mappings_path, lines)

    def delete(self, hash_: str) -> dict:
        self.validate_hash(hash_)
        source_ref = None
        dropped = False
        kept = []
        if self.mappings_path.is_file():
            with self.mappings_path.open(encoding="utf-8") as source:
                for line in source:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) >= 4 and parts[2] == hash_:
                        source_ref, dropped = strip_passthrough(parts[1]), True
                    else:
                        kept.append(line if line.endswith("\n") else line + "\n")
            if dropped:
                self._atomic_lines(self.mappings_path, kept)
        manifest = self.manifests().pop(hash_, None)
        if manifest is not None and source_ref is None:
            source_ref = manifest.get("source_ref") or None
        entry_dir = self.root / hash_
        removed = False
        if entry_dir.is_dir():
            resolved = entry_dir.resolve()
            if resolved.parent != self.root.resolve():
                raise InvalidCatalogInput("cache entry resolves outside cache root")
            shutil.rmtree(resolved)
            removed = not resolved.exists()
        visits_deleted = self.activity.forget(hash_)
        self.set_disabled(hash_, False)
        if not (dropped or removed):
            raise EntryNotFound(f"no cache entry for hash {hash_}")
        return {"hash": hash_, "source_ref": source_ref, "mapping_dropped": dropped,
                "removed_dir": removed, "visits_deleted": visits_deleted, "disabled": False}

    @staticmethod
    def _atomic_lines(path: pathlib.Path, lines: list[str]) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text("".join(lines), encoding="utf-8")
        tmp.replace(path)

    def hash_for_browser_url(self, url: str, *, daemon_port: int = 7435) -> Optional[str]:
        clean = strip_passthrough(url)
        # A daemon URL's query may embed a whole source URL, so read it before
        # any passthrough stripping of the outer URL.
        parsed = urllib.parse.urlparse(url)
        daemon = parsed.scheme in {"http", "https"} and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        try:
            daemon = daemon and parsed.port == daemon_port
        except ValueError:
            daemon = False
        if daemon:
            match = re.match(r"^(?:/r)?/([a-f0-9]{6,32})(?:/|$)", parsed.path)
            if match:
                return match.group(1)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            if parsed.path == "/native" and query.get("hash") and HASH_RE.fullmatch(query["hash"][0]):
                return query["hash"][0]
            if parsed.path in {"/view", "/native", "/read"}:
                if query.get("path"):
                    return self._hash_for_local_path(pathlib.Path(query["path"][0]))
                if query.get("url"):
                    return url_hash(strip_passthrough(query["url"][0]))
            if parsed.path in {"/view-raw", "/read-raw"} and parsed.query:
                return url_hash(strip_passthrough(parsed.query))
        if parsed.scheme == "file":
            return self._hash_for_local_path(pathlib.Path(urllib.parse.unquote(parsed.path)))
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return url_hash(clean)
        return None
