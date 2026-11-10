"""Cache catalog: the filesystem-backed interface to converted PDFs.

The catalog owns cache identity, mappings, representations, disabled state,
native-source discovery, library projection, and safe mutations.  It never
converts PDFs; producers remain the scripts described by ADR 0004.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import html as html_lib
import json
import pathlib
import re
import shutil
import urllib.parse
from typing import Optional, Protocol


LIGHT_HTML_SUFFIX = ".light.html"
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


class NameConflict(CatalogError):
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
class Representation:
    hash: str
    canonical: pathlib.Path
    selected: pathlib.Path
    light: Optional[pathlib.Path]


@dataclass(frozen=True)
class ResolvedSource:
    hash: str
    source_ref: str
    representation: Optional[Representation]
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


class CacheCatalog:
    """Deep module over one cache root.

    Callers provide only source identities, entry hashes, and representation
    preference. Filesystem layout and cross-file mutation rules stay here.
    """

    def __init__(self, root: pathlib.Path, activity: Optional[Activity] = None):
        self.root = root
        self.activity = activity or NullActivity()
        self._content_hashes: dict[tuple[str, int, int], str] = {}
        self._manifests: Optional[dict[str, dict]] = None
        self._manifests_stamp: Optional[int] = None

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
        """Every known entry: mappings.tsv rows (written by the conversion
        scripts) plus the entries registered on demand, which carry their
        identity in `<hash>/entry.json` instead of a row."""
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
            # Stored resolved, as lookups compare resolved paths.
            source_ref = str(pathlib.Path(source_ref).expanduser().resolve())
        manifest["source_ref"] = source_ref
        if manifest != current:
            self._write_manifest(hash_, manifest)
        return manifest

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
        self._content_hashes[key] = value
        return value

    def _mapped_hash_for_path(self, path: pathlib.Path) -> Optional[str]:
        try:
            needle = str(path.expanduser().resolve(strict=True))
        except FileNotFoundError:
            needle = str(path.expanduser())
        return next((h for h, m in self.mappings().items()
                     if strip_passthrough(m.source_ref) == needle), None)

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

    def resolve_source(self, source: str | pathlib.Path, *, prefer_light: bool = False) -> ResolvedSource:
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
        representation = self.locate_representation(hash_, prefer_light=prefer_light) if hash_ else None
        return ResolvedSource(hash_, source_ref, representation, self.is_disabled(hash_))

    @staticmethod
    def _is_light(path: pathlib.Path) -> bool:
        return path.name.endswith(LIGHT_HTML_SUFFIX)

    @staticmethod
    def light_path(canonical: pathlib.Path) -> pathlib.Path:
        return canonical if CacheCatalog._is_light(canonical) else canonical.with_name(canonical.stem + LIGHT_HTML_SUFFIX)

    def locate_representation(self, hash_: str, *, prefer_light: bool = False) -> Optional[Representation]:
        if not hash_ or not HASH_RE.fullmatch(hash_):
            return None
        entry_dir = self.root / hash_
        if not entry_dir.is_dir():
            return None
        matches = sorted(entry_dir.glob("*.html"))
        canonical_matches = [path for path in matches if not self._is_light(path)]
        canonical = canonical_matches[0] if canonical_matches else (matches[0] if matches else None)
        if canonical is None:
            return None
        light_candidate = self.light_path(canonical)
        light = light_candidate if light_candidate.is_file() and light_candidate != canonical else None
        selected = light if prefer_light and light is not None else canonical
        return Representation(hash_, canonical, selected, light)

    def require_representation(self, hash_: str, *, prefer_light: bool = True) -> Representation:
        self.validate_hash(hash_)
        representation = self.locate_representation(hash_, prefer_light=prefer_light)
        if representation is None:
            raise EntryNotFound(f"no cached PDF viewer entry for hash {hash_}")
        return representation

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
        source_ref = self.source_ref(hash_)
        if source_ref and source_ref.startswith("/"):
            path = pathlib.Path(source_ref)
            if path.is_file():
                return path
        return self.cached_source(hash_)

    def entry_name(self, hash_: str) -> str:
        """Display name: the canonical HTML stem (what :rename changes), else
        the mapping row's name, else the source file's stem."""
        representation = self.locate_representation(hash_)
        if representation is not None:
            return representation.canonical.stem
        manifest = self.manifests().get(hash_)
        if manifest and manifest.get("name"):
            return str(manifest["name"])
        mapping = self.mappings().get(hash_)
        if mapping is not None:
            return mapping.name
        source = self.source_pdf(hash_)
        return source.stem if source else hash_

    def viewer_href(self, hash_: str, *, prefer_reader: bool = False,
                    prefer_light: bool = True) -> Optional[str]:
        """Where an entry is read, as an unquoted daemon path: the reader when
        preferred or when it is all the entry has, else its converted HTML.
        None for no entry."""
        if not HASH_RE.fullmatch(hash_ or ""):
            return None
        representation = self.locate_representation(hash_, prefer_light=prefer_light)
        has_source = self.source_pdf(hash_) is not None
        if has_source and (prefer_reader or representation is None):
            return f"/r/{hash_}/"
        if representation is not None:
            return f"/{hash_}/{representation.selected.name}"
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
        for hash_, mapping in self.mappings().items():
            if self.viewer_href(hash_) is None:
                continue
            source_ref = mapping.source_ref
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

    def list_entries(self, *, prefer_reader: bool = False) -> list[dict]:
        scores = self.activity.all_frecency()
        out = []
        for hash_, mapping in self.mappings().items():
            href = self.viewer_href(hash_, prefer_reader=prefer_reader)
            if href is None:
                continue
            representation = self.locate_representation(hash_, prefer_light=True)
            score = scores.get(hash_, {"raw_count": 0, "rank": 0, "last_seen": None,
                                       "age_multiplier": 0.0, "frecency_score": 0.0})
            canonical = representation.canonical if representation else None
            name = self.entry_name(hash_)
            out.append({"hash": hash_, "name": name, "source_ref": mapping.source_ref,
                        "search_text": self._search_text(name, mapping.source_ref),
                        "href": href,
                        "reader_href": f"/r/{hash_}/" if self.source_pdf(hash_) is not None else None,
                        "canonical_href": f"/{hash_}/{canonical.name}" if canonical else None,
                        "light_href": f"/{hash_}/{representation.light.name}" if representation and representation.light else None,
                        "count": score["raw_count"], "rank": score["rank"],
                        "last_seen": score["last_seen"], "age_multiplier": score["age_multiplier"],
                        "frecency_score": score["frecency_score"]})
        out.sort(key=lambda entry: (-entry["frecency_score"], -(entry["last_seen"] or 0), entry["name"].lower()))
        return out

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
        manifest = self.manifests().get(hash_)
        if self.locate_representation(hash_) is None:
            # An entry with no converted HTML keeps its name in entry.json.
            if manifest is None or self.source_pdf(hash_) is None:
                raise EntryNotFound(f"no cached PDF viewer entry for hash {hash_}")
            old_name = str(manifest.get("name") or hash_)
            if old_name != name:
                self._write_manifest(hash_, {**manifest, "name": name})
            result = {"hash": hash_, "old_name": old_name, "new_name": name, "renamed": old_name != name,
                      "href": f"/r/{hash_}/", "canonical_href": None, "light_href": None}
            if old_name != name:
                result.update(light_renamed=False, frecency_boosted=self.activity.boost(hash_, n=3))
            return result
        representation = self.require_representation(hash_, prefer_light=False)
        old = representation.canonical
        if old.stem == name:
            return self._rename_result(hash_, old.stem, name, False, representation, 0)
        target = old.with_name(name + ".html")
        light_target = old.with_name(name + LIGHT_HTML_SUFFIX)
        if target.exists() or light_target.exists():
            raise NameConflict(f"name already in use: {name}")

        def rewrite_title(path: pathlib.Path) -> None:
            try:
                text = path.read_text(encoding="utf-8")
                text, count = re.subn(r"<title>.*?</title>", f"<title>{html_lib.escape(name)}</title>", text, count=1, flags=re.DOTALL)
                if count:
                    path.write_text(text, encoding="utf-8")
            except OSError:
                pass

        rewrite_title(old)
        if representation.light:
            rewrite_title(representation.light)
            representation.light.rename(light_target)
        old.rename(target)
        self._rewrite_mapping_html(hash_, target)
        updated = Representation(hash_, target, target, light_target if representation.light else None)
        return self._rename_result(hash_, old.stem, name, True, updated, self.activity.boost(hash_, n=3))

    @staticmethod
    def _rename_result(hash_: str, old_name: str, new_name: str, renamed: bool,
                       representation: Representation, boosted: int) -> dict:
        # `href` follows the library's rule: the light representation when one
        # exists, so a renamed light tab keeps viewing light HTML.
        preferred = representation.light or representation.canonical
        result = {"hash": hash_, "old_name": old_name, "new_name": new_name, "renamed": renamed,
                  "href": f"/{hash_}/{preferred.name}",
                  "canonical_href": f"/{hash_}/{representation.canonical.name}",
                  "light_href": f"/{hash_}/{representation.light.name}" if representation.light else None}
        if renamed:
            result.update(light_renamed=representation.light is not None, frecency_boosted=boosted)
        return result

    def _rewrite_mapping_html(self, hash_: str, path: pathlib.Path) -> None:
        if not self.mappings_path.is_file():
            return
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
            if parsed.path in {"/view", "/view-light", "/view-canonical", "/native", "/read"}:
                if query.get("path"):
                    return self._hash_for_local_path(pathlib.Path(query["path"][0]))
                if query.get("url"):
                    return url_hash(strip_passthrough(query["url"][0]))
            if parsed.path in {"/view-raw", "/view-light-raw", "/view-canonical-raw", "/read-raw"} and parsed.query:
                return url_hash(strip_passthrough(parsed.query))
        if parsed.scheme == "file":
            return self._hash_for_local_path(pathlib.Path(urllib.parse.unquote(parsed.path)))
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return url_hash(clean)
        return None
