"""Snapshot the reader's PDFium output, then compare it across implementations.

From a checkout's daemon directory, using that daemon's environment:
    uv run python ../bench/reader/fidelity.py /tmp/generated --out /tmp/before.json

Use the same fixtures with a different checkout for the candidate. Pass
--baseline /tmp/before.json to require exact equality. Output contains hashes
and page counts only. Use run.py separately for browser copy, find and paint.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path.cwd()))
import pdfium_doc
from reader import range_bodies


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_raster(pdf: str, page: int, width: int, fmt: str) -> str:
    try:
        return digest(pdfium_doc.render_raster(pdf, page, width, fmt))
    except Exception as error:
        return f"error:{type(error).__name__}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--max-pages", type=int, default=8)
    parser.add_argument("--width", type=int, default=740)
    args = parser.parse_args()
    output = {}
    for file in sorted(args.fixtures.glob("*.pdf")):
        identity = digest(file.read_bytes())
        path = str(file)
        sizes = pdfium_doc.page_sizes(path)
        stop = min(len(sizes), args.max_pages)
        bodies = range_bodies(path, 0, stop)
        document = [sizes, pdfium_doc.outline(path), pdfium_doc.metadata(path)]
        output[identity] = {
            "pages": len(sizes),
            "document": digest(json.dumps(document, sort_keys=True).encode()),
            "text": [[digest(body.encode()), body.scanned] for body in bodies],
            "jpg": [record_raster(path, page, args.width, "jpg") for page in range(stop)],
            "png": [record_raster(path, page, args.width, "png") for page in range(stop)],
        }
    if not output:
        parser.error("the fixture directory has no PDFs")
    args.out.write_text(json.dumps(output, indent=2, sort_keys=True) + "\n")
    pages = sum(len(doc["text"]) for doc in output.values())
    raster_errors = sum(value.startswith("error:") for doc in output.values()
                        for fmt in ("jpg", "png") for value in doc[fmt])
    print(f"{len(output)} PDFs, {pages} sampled pages, {raster_errors} raster errors, "
          f"native_text={getattr(pdfium_doc, 'NATIVE_TEXT', False)}")
    if args.baseline:
        before = json.loads(args.baseline.read_text())
        for identity in sorted(before.keys() | output.keys()):
            a, b = before.get(identity, {}), output.get(identity, {})
            fields = [key for key in sorted(a.keys() | b.keys()) if a.get(key) != b.get(key)]
            if fields:
                print(f"{identity[:12]} differs in {', '.join(fields)}")
        if before != output:
            return 1
        print("Exact match")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
