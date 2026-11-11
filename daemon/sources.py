"""Fetching a remote PDF into an entry's `_source/` directory.

The reader opens a URL by downloading its bytes once. This is a plain HTTP
GET with no cookies: a host that wants a sign-in answers with an HTML page,
which fails the PDF check here and leaves the caller to fall back.
"""
from __future__ import annotations

import email.message
import os
import pathlib
import re
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 512 * 1024 * 1024
TIMEOUT_SEC = 60
USER_AGENT = "Mozilla/5.0 (Macintosh) pdf_viewer"


class SourceError(Exception):
    pass


def filename_for(url: str, content_disposition: str = "") -> str:
    """Content-Disposition filename, else the URL's last path segment."""
    name = None
    if content_disposition:
        message = email.message.Message()
        message["content-disposition"] = content_disposition
        try:
            name = message.get_filename()
        except Exception:
            name = None
    if not name:
        name = urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]
    name = urllib.parse.unquote(name or "").strip()
    name = re.sub(r"[\x00-\x1f/\\]+", "_", name).lstrip(".")
    extension = name[-4:] if name.lower().endswith(".pdf") else ".pdf"
    stem = name[:-4] if name.lower().endswith(".pdf") else name
    # Capped before the extension goes back on: `_source/*.pdf` finds it.
    return (stem[:196] or "document") + extension


def save(body: bytes, url: str, content_disposition: str, target_dir: pathlib.Path) -> str:
    """Store PDF bytes fetched elsewhere (the browser, through the extension)
    into target_dir and return the filename, with the same checks as a
    download."""
    if body[:4] != b"%PDF":
        raise SourceError("bytes are not a PDF (a sign-in page?)")
    if len(body) > MAX_BYTES:
        raise SourceError("source larger than 512 MB")
    name = filename_for(url, content_disposition)
    target_dir.mkdir(parents=True, exist_ok=True)
    tmp = target_dir / f".save.{os.getpid()}.tmp"
    try:
        tmp.write_bytes(body)
        tmp.replace(target_dir / name)
    finally:
        if tmp.exists():
            tmp.unlink()
    return name


def download(url: str, target_dir: pathlib.Path) -> str:
    """Download a PDF into target_dir and return its filename."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SourceError("not an http(s) URL")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"})
    # A failed download (the common sign-in page) leaves no empty entry
    # directory behind: those are created only for a PDF, and removed again
    # if the download fails after all.
    created = [d for d in (target_dir.parent, target_dir) if not d.exists()]
    tmp = target_dir / f".download.{os.getpid()}.tmp"
    stored = False
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SEC) as response:
            head = response.read(5)
            if head[:4] != b"%PDF":
                raise SourceError("response is not a PDF (a sign-in page?)")
            target_dir.mkdir(parents=True, exist_ok=True)
            size = len(head)
            with tmp.open("wb") as out:
                out.write(head)
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise SourceError("source larger than 512 MB")
                    out.write(chunk)
            name = filename_for(url, response.headers.get("Content-Disposition", ""))
        tmp.replace(target_dir / name)
        stored = True
        return name
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise SourceError(str(error)) from error
    finally:
        if tmp.exists():
            tmp.unlink()
        if not stored:
            for directory in reversed(created):
                try:
                    directory.rmdir()
                except OSError:
                    pass


class Upload:
    """A PDF arriving in pieces (the extension's chunked upload) into
    target_dir. The first bytes must be `%PDF`; the whole stays under
    MAX_BYTES. Nothing is visible under target_dir until finish(); abort()
    removes the partial file and any directory this upload created."""

    def __init__(self, target_dir: pathlib.Path, tag: str):
        self.target_dir = target_dir
        self.size = 0
        self._created = [d for d in (target_dir.parent, target_dir) if not d.exists()]
        self._tmp = target_dir / f".upload.{tag}.{os.getpid()}.tmp"
        self._head = b""
        self.aborted = False

    def append(self, chunk: bytes) -> None:
        if self.aborted:
            raise SourceError("upload abandoned")
        if len(self._head) < 4:
            self._head += chunk[:4 - len(self._head)]
            if len(self._head) >= 4 and self._head != b"%PDF":
                raise SourceError("bytes are not a PDF (a sign-in page?)")
        if self.size + len(chunk) > MAX_BYTES:
            raise SourceError("source larger than 512 MB")
        self.target_dir.mkdir(parents=True, exist_ok=True)
        with self._tmp.open("ab") as out:
            out.write(chunk)
        self.size += len(chunk)

    def finish(self, url: str, content_disposition: str) -> str:
        if self._head != b"%PDF":
            self.abort()
            raise SourceError("bytes are not a PDF (a sign-in page?)")
        name = filename_for(url, content_disposition)
        self._tmp.replace(self.target_dir / name)
        return name

    def abort(self) -> None:
        self.aborted = True
        try:
            self._tmp.unlink()
        except OSError:
            pass
        for directory in reversed(self._created):
            try:
                directory.rmdir()
            except OSError:
                pass
