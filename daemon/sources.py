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


def download(url: str, target_dir: pathlib.Path) -> str:
    """Download a PDF into target_dir and return its filename."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SourceError("not an http(s) URL")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"})
    target_dir.mkdir(parents=True, exist_ok=True)
    tmp = target_dir / f".download.{os.getpid()}.tmp"
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SEC) as response:
            head = response.read(5)
            if head[:4] != b"%PDF":
                raise SourceError("response is not a PDF (a sign-in page?)")
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
        return name
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise SourceError(str(error)) from error
    finally:
        if tmp.exists():
            tmp.unlink()
