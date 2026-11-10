#!/usr/bin/env python3
"""Build a light pdf2htmlEX HTML variant with lazy page rasters.

The canonical pdf2htmlEX output embeds every full-page raster as a base64
data URI. This script keeps the canonical HTML untouched, writes each inline
page raster to a sibling directory, and writes a derived HTML file whose
page-raster <img> tags carry data-pdf2html-src instead of eager src. The
default text mode, paint-safe, simplifies only the lines proved to be hidden
fallback text and keeps every other positioned pdf2htmlEX text line byte for
byte, so the raster and text keep their canonical paint roles while the text
remains the browser's find/copy/selection surface.

Usage:
    externalize-page-images.py <input.html> <output.light.html> \
        --image-dir <entry/page-images> --url-prefix /<hash>/page-images/
"""
from __future__ import annotations

import argparse
import base64
import html
import pathlib
import re
import shutil
import sys


IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
CLASS_RE = re.compile(r"\bclass=(['\"])(.*?)\1", re.IGNORECASE | re.DOTALL)
SRC_RE = re.compile(r"\s+src=(['\"])(.*?)\1", re.IGNORECASE | re.DOTALL)
ID_RE = re.compile(r"\bid=(['\"])(.*?)\1", re.IGNORECASE | re.DOTALL)
DATA_URI_RE = re.compile(
    r"^data:image/(png|jpe?g);base64,(.*)$",
    re.IGNORECASE | re.DOTALL,
)
OLD_ATTR_RE = re.compile(
    r"\s+data-pdf2html-(?:src|raster|page)=(['\"]).*?\1",
    re.IGNORECASE | re.DOTALL,
)
BODY_TAG_RE = re.compile(r"<body\b[^>]*>", re.IGNORECASE)
HTML_TAG_RE = re.compile(r"<html\b[^>]*>", re.IGNORECASE)
TEXT_DIV_RE = re.compile(
    r"(<div\b[^>]*\bclass=(['\"])(?=[^'\"]*\bt\b)[^'\"]*\2[^>]*>)"
    r"(.*?)"
    r"(</div>)",
    re.IGNORECASE | re.DOTALL,
)
CLASS_ATTR_RE = re.compile(r"\bclass=(['\"])(.*?)\1", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>", re.DOTALL)
DIV_TAG_RE = re.compile(r"<div\b[^>]*>", re.IGNORECASE | re.DOTALL)
SPAN_TAG_RE = re.compile(r"</?span\b[^>]*>", re.IGNORECASE | re.DOTALL)
SIMPLE_SPAN_RE = re.compile(r"(<span\b[^>]*>)([^<]*)(</span>)", re.IGNORECASE | re.DOTALL)
PAINT_CLASS_RE = re.compile(r"(?:fc|sc)[a-z0-9_-]*\Z", re.IGNORECASE)
STYLE_TAG_RE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.IGNORECASE | re.DOTALL)
CSS_RULE_RE = re.compile(r"([^{}]+)\{([^{}]*)\}", re.DOTALL)
CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
FF_CLASS_RE = re.compile(r"ff[a-z0-9_-]+\Z", re.IGNORECASE)
CSS_FF_SELECTOR_RE = re.compile(r"\.((?:ff)[a-z0-9_-]+)\b", re.IGNORECASE)
CSS_CLASS_SELECTOR_RE = re.compile(r"\.([a-z_][a-z0-9_-]*)\b", re.IGNORECASE)
STYLE_ATTR_RE = re.compile(r"\bstyle=(['\"])(.*?)\1", re.IGNORECASE | re.DOTALL)
VISIBILITY_PROPERTY_RE = re.compile(r"(?:^|;)\s*visibility\s*:\s*([^;]+)", re.IGNORECASE)
OPEN_TAG_RE = re.compile(r"<[a-z][^>]*>", re.IGNORECASE | re.DOTALL)


def is_page_raster(tag: str) -> bool:
    match = CLASS_RE.search(tag)
    if not match:
        return False
    classes = re.split(r"\s+", match.group(2).strip())
    return "bi" in classes


def add_attrs(tag: str, attrs: str) -> str:
    tag = OLD_ATTR_RE.sub("", tag)
    if tag.endswith("/>"):
        return tag[:-2].rstrip() + attrs + " />"
    return tag[:-1].rstrip() + attrs + ">"


def set_attrs(tag: str, attrs: dict[str, str]) -> str:
    """Replace named attributes without depending on their original order."""
    for name in attrs:
        attr_re = re.compile(
            rf"\s+{re.escape(name)}=(['\"]).*?\1", re.IGNORECASE | re.DOTALL
        )
        tag = attr_re.sub("", tag)
    additions = "".join(
        f' {name}="{html.escape(value, quote=True)}"' for name, value in attrs.items()
    )
    return add_attrs(tag, additions)


def class_tokens(tag: str) -> list[str]:
    match = CLASS_ATTR_RE.search(tag)
    if not match:
        return []
    return re.split(r"\s+", match.group(2).strip())


def add_class(tag: str, class_name: str) -> str:
    tokens = class_tokens(tag)
    if class_name in tokens:
        return tag
    match = CLASS_ATTR_RE.search(tag)
    if match:
        quote = match.group(1)
        classes = (match.group(2).strip() + " " + class_name).strip()
        return tag[: match.start(2)] + html.escape(classes, quote=True) + tag[match.end(2) :]
    insert_at = -2 if tag.endswith("/>") else -1
    return tag[:insert_at].rstrip() + f' class="{class_name}"' + tag[insert_at:]


def mark_light_body(text: str) -> str:
    return BODY_TAG_RE.sub(lambda match: add_class(match.group(0), "pdf2html-light"), text, count=1)


def mark_light_html(text: str, text_layer: str) -> str:
    if not HTML_TAG_RE.search(text):
        raise RuntimeError("input HTML has no <html> root")
    return HTML_TAG_RE.sub(
        lambda match: set_attrs(
            match.group(0),
            {
                "data-pdf2html-representation": "light-v1",
                "data-pdf2html-text-mode": text_layer,
            },
        ),
        text,
        count=1,
    )


def is_page_frame(tag: str) -> bool:
    identifier = ID_RE.search(tag)
    return bool(
        identifier
        and re.fullmatch(r"pf[0-9a-f]+", identifier.group(2), re.IGNORECASE)
        and "pf" in class_tokens(tag)
    )


def page_frame_count(text: str) -> int:
    return sum(1 for match in DIV_TAG_RE.finditer(text) if is_page_frame(match.group(0)))


def mark_geometry_pages(text: str) -> str:
    page_number = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal page_number
        tag = match.group(0)
        if not is_page_frame(tag):
            return tag
        page_number += 1
        return set_attrs(
            tag,
            {
                "data-pdf2html-page": str(page_number),
                "data-pdf2html-text-mode": "geometry",
            },
        )

    return DIV_TAG_RE.sub(replace, text)


def mark_flattened_html(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        tag = match.group(0)
        if re.search(r"\sdata-pdf2html-text-flattened=", tag, re.IGNORECASE):
            return tag
        insert_at = -2 if tag.endswith("/>") else -1
        return tag[:insert_at].rstrip() + ' data-pdf2html-text-flattened="line"' + tag[insert_at:]

    return HTML_TAG_RE.sub(replace, text, count=1)


def mark_page_text_html(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        tag = match.group(0)
        if re.search(r"\sdata-pdf2html-text-flattened=", tag, re.IGNORECASE):
            return tag
        insert_at = -2 if tag.endswith("/>") else -1
        return tag[:insert_at].rstrip() + ' data-pdf2html-text-flattened="page"' + tag[insert_at:]

    return HTML_TAG_RE.sub(replace, text, count=1)


def plain_text_from_markup(inner: str) -> str:
    return html.unescape(TAG_RE.sub("", inner))


def is_paint_only_span(tag: str) -> bool:
    """True for a span whose only effect is foreground/stroke paint.

    Spacers (``_``), letter spacing (``ls*``), fallback fonts (``ff*``), and
    any span with attributes beyond ``class`` are retained because they can
    affect text geometry.
    """
    if tag.startswith("</"):
        return False
    class_match = CLASS_ATTR_RE.search(tag)
    if not class_match:
        return False
    remainder = CLASS_ATTR_RE.sub("", tag)
    remainder = re.sub(r"^<span\b|/?>$", "", remainder, flags=re.IGNORECASE).strip()
    if remainder:
        return False
    tokens = class_tokens(tag)
    return bool(tokens) and all(PAINT_CLASS_RE.fullmatch(token) for token in tokens)


def unwrap_paint_only_spans(inner: str) -> tuple[str, int]:
    """Drop paint wrappers while preserving all text and layout markup."""
    out_parts: list[str] = []
    pos = 0
    paint_stack: list[bool] = []
    unwrapped = 0

    for match in SPAN_TAG_RE.finditer(inner):
        tag = match.group(0)
        out_parts.append(inner[pos : match.start()])
        if tag.startswith("</"):
            if not paint_stack:
                raise RuntimeError("unbalanced </span> in pdf2htmlEX text line")
            if paint_stack.pop():
                unwrapped += 1
            else:
                out_parts.append(tag)
        else:
            paint_only = is_paint_only_span(tag)
            paint_stack.append(paint_only)
            if not paint_only:
                out_parts.append(tag)
        pos = match.end()

    if paint_stack:
        raise RuntimeError("unclosed <span> in pdf2htmlEX text line")
    out_parts.append(inner[pos:])
    return "".join(out_parts), unwrapped


def is_spacer_span(tag: str) -> bool:
    """pdf2htmlEX spacer spans always carry the base ``_`` class."""
    return "_" in class_tokens(tag)


def simplify_spacer_spans(inner: str) -> tuple[str, int]:
    """Keep word-gap geometry while removing DOM-only kerning noise.

    Empty ``._`` spans are intra-word kerning and have no logical text value.
    Whitespace spacers reserve real width, so their element remains. If an
    immediate literal whitespace character already represents the word gap,
    its text is emptied to avoid a duplicate copied/searchable space.
    """
    simplified = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal simplified
        start, content, end = match.groups()
        if not is_spacer_span(start):
            return match.group(0)
        if content == "":
            simplified += 1
            return ""
        if not html.unescape(content).isspace():
            return match.group(0)

        left = inner[match.start() - 1 : match.start()]
        right = inner[match.end() : match.end() + 1]
        normalized = "" if left.isspace() or right.isspace() else " "
        if content != normalized:
            simplified += 1
        return start + normalized + end

    return SIMPLE_SPAN_RE.sub(replace, inner), simplified


def simplify_text_spans_to_geometry(text: str) -> tuple[str, int]:
    unwrapped = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal unwrapped
        start, inner, end = match.group(1), match.group(3), match.group(4)
        simplified, count = unwrap_paint_only_spans(inner)
        simplified, spacer_count = simplify_spacer_spans(simplified)
        unwrapped += count + spacer_count
        return start + simplified + end

    return TEXT_DIV_RE.sub(replace, text), unwrapped


def visibility_from_declarations(declarations: str) -> str | None:
    """Return a supported final visibility value, or ``None`` for ambiguity."""
    values = VISIBILITY_PROPERTY_RE.findall(declarations)
    if not values:
        return None
    value = values[-1].strip().lower().replace("!important", "").strip()
    return value if value in {"hidden", "visible"} else None


def font_visibility_semantics(text: str) -> dict[str, str | None]:
    """Read document-local, simple ``.ff*`` visibility rules conservatively.

    pdf2htmlEX emits the fallback-font choice as a one-class rule such as
    ``.ff4{font-family:sans-serif;visibility:hidden;}``. A complex selector,
    unsupported value, or competing visibility rule is deliberately recorded
    as ambiguous so no corresponding line is changed.
    """
    semantics: dict[str, str | None] = {}
    for style in STYLE_TAG_RE.findall(text):
        css = CSS_COMMENT_RE.sub("", style)
        for rule in CSS_RULE_RE.finditer(css):
            selector, declarations = rule.groups()
            if "visibility" not in declarations.lower():
                continue
            referenced = {
                name.lower() for name in CSS_FF_SELECTOR_RE.findall(selector)
            }
            if not referenced:
                continue
            value = visibility_from_declarations(declarations)
            normalized_selector = re.sub(r"\s+", "", selector)
            supported = (
                value is not None
                and len(referenced) == 1
                and normalized_selector == "." + next(iter(referenced))
            )
            for font_class in referenced:
                semantics[font_class] = value if supported else None
    return semantics


def visibility_selector_classes(text: str) -> set[str]:
    """Return every class named by a document-local visibility rule.

    We deliberately avoid implementing the full descendant CSS cascade. A
    descendant class named by any visibility selector might override inherited
    line visibility, so keeping that complete line is the paint-safe result.
    """
    classes: set[str] = set()
    for style in STYLE_TAG_RE.findall(text):
        css = CSS_COMMENT_RE.sub("", style)
        for rule in CSS_RULE_RE.finditer(css):
            selector, declarations = rule.groups()
            if "visibility" in declarations.lower():
                classes.update(
                    name.lower() for name in CSS_CLASS_SELECTOR_RE.findall(selector)
                )
    return classes


def has_inline_visibility(tag: str) -> bool:
    match = STYLE_ATTR_RE.search(tag)
    return bool(match and VISIBILITY_PROPERTY_RE.search(match.group(2)))


def paint_safe_line_is_eligible(
    start_tag: str,
    inner: str,
    font_visibility: dict[str, str | None],
    visibility_classes: set[str],
) -> bool:
    """Whether a line is provably a hidden fallback-text line.

    This is intentionally narrower than browser CSS. Any inline visibility or
    descendant font/visibility declaration can alter the computed value, so
    the line remains canonical instead of risking a paint change.
    """
    font_classes = [
        token.lower() for token in class_tokens(start_tag) if FF_CLASS_RE.fullmatch(token)
    ]
    if len(font_classes) != 1 or font_visibility.get(font_classes[0]) != "hidden":
        return False
    if any(
        token.lower() in visibility_classes and token.lower() != font_classes[0]
        for token in class_tokens(start_tag)
    ):
        return False
    if has_inline_visibility(start_tag):
        return False
    for descendant in OPEN_TAG_RE.finditer(inner):
        tag = descendant.group(0)
        if has_inline_visibility(tag):
            return False
        if any(
            FF_CLASS_RE.fullmatch(token) or token.lower() in visibility_classes
            for token in class_tokens(tag)
        ):
            return False
    return True


def mark_paint_safe_line(start_tag: str) -> str:
    marked = add_class(start_tag, "pdf2html-paint-safe")
    return set_attrs(marked, {"data-pdf2html-paint-safe": "hidden"})


def simplify_hidden_lines_for_paint_safe(text: str) -> tuple[str, int]:
    """Simplify only hidden lines without changing line text or order."""
    font_visibility = font_visibility_semantics(text)
    visibility_classes = visibility_selector_classes(text)
    simplified = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal simplified
        start, inner, end = match.group(1), match.group(3), match.group(4)
        if not paint_safe_line_is_eligible(
            start, inner, font_visibility, visibility_classes
        ):
            return match.group(0)
        geometry_inner, count = unwrap_paint_only_spans(inner)
        if plain_text_from_markup(geometry_inner) != plain_text_from_markup(inner):
            raise RuntimeError("paint-safe simplification changed a text line")
        simplified += count
        return mark_paint_safe_line(start) + geometry_inner + end

    return TEXT_DIV_RE.sub(replace, text), simplified


def validate_paint_safe_output(source: str, output: str) -> None:
    """Prove exact logical text/order and byte conservation of other lines."""
    font_visibility = font_visibility_semantics(source)
    visibility_classes = visibility_selector_classes(source)
    source_matches = list(TEXT_DIV_RE.finditer(source))
    output_matches = list(TEXT_DIV_RE.finditer(output))
    if len(output_matches) != len(source_matches):
        raise RuntimeError("paint-safe output changed the text-line count")

    for index, (source_match, output_match) in enumerate(
        zip(source_matches, output_matches), start=1
    ):
        source_start, source_inner = source_match.group(1), source_match.group(3)
        source_line = source_match.group(0)
        output_line = output_match.group(0)
        if plain_text_from_markup(source_inner) != plain_text_from_markup(output_match.group(3)):
            raise RuntimeError(f"paint-safe output changed text content on line {index}")
        eligible = paint_safe_line_is_eligible(
            source_start, source_inner, font_visibility, visibility_classes
        )
        marked = 'data-pdf2html-paint-safe="hidden"' in output_match.group(1)
        if eligible and not marked:
            raise RuntimeError(f"paint-safe output did not mark hidden line {index}")
        if not eligible:
            if marked:
                raise RuntimeError(f"paint-safe output marked ambiguous line {index}")
            if output_line != source_line:
                raise RuntimeError(f"paint-safe output changed visible line {index}")


def text_lines(text: str) -> list[str]:
    return [plain_text_from_markup(match.group(3)) for match in TEXT_DIV_RE.finditer(text)]


def normalized_logical_text(value: str) -> str:
    """Compare line content after collapsing layout-only word-gap duplicates."""
    return re.sub(r"\s+", " ", value)


def validate_source(text: str, input_html: pathlib.Path) -> tuple[int, int]:
    pages = page_frame_count(text)
    rasters = 0
    for match in IMG_TAG_RE.finditer(text):
        tag = match.group(0)
        if not is_page_raster(tag):
            continue
        rasters += 1
        if not SRC_RE.search(tag):
            raise RuntimeError(f"page raster {rasters} in {input_html} has no src")
    if pages == 0:
        raise RuntimeError(f"input HTML has no pdf2htmlEX page frames: {input_html}")
    if rasters != pages:
        raise RuntimeError(
            f"page/raster mismatch in {input_html}: {pages} page frames, {rasters} page rasters"
        )
    return pages, rasters


def validate_geometry_output(source: str, output: str, expected_pages: int, expected_rasters: int) -> None:
    if page_frame_count(output) != expected_pages:
        raise RuntimeError("geometry output changed the page-frame count")
    source_lines = [normalized_logical_text(line) for line in text_lines(source)]
    output_lines = [normalized_logical_text(line) for line in text_lines(output)]
    if output_lines != source_lines:
        raise RuntimeError("geometry output changed text-line content")

    pages = [
        match.group(0)
        for match in DIV_TAG_RE.finditer(output)
        if is_page_frame(match.group(0))
    ]
    for index, page in enumerate(pages, start=1):
        if f'data-pdf2html-page="{index}"' not in page or 'data-pdf2html-text-mode="geometry"' not in page:
            raise RuntimeError(f"geometry output page {index} is missing metadata")

    rasters = [match.group(0) for match in IMG_TAG_RE.finditer(output) if is_page_raster(match.group(0))]
    if len(rasters) != expected_rasters:
        raise RuntimeError("geometry output changed the page-raster count")
    for index, raster in enumerate(rasters, start=1):
        if f'data-pdf2html-page="{index}"' not in raster:
            raise RuntimeError(f"geometry output raster {index} is missing page metadata")
        if 'data-pdf2html-raster="external"' not in raster:
            raise RuntimeError(f"geometry output raster {index} is not externalized")


def flatten_text_spans_to_lines(text: str) -> tuple[str, int]:
    flattened = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal flattened
        start, inner, end = match.group(1), match.group(3), match.group(4)

        flattened += 1
        content = plain_text_from_markup(inner)
        return start + html.escape(content, quote=False) + end

    return TEXT_DIV_RE.sub(replace, text), flattened


def collapse_text_spans_to_pages(text: str) -> tuple[str, int, int]:
    page_starts = [
        match.start()
        for match in re.finditer(
            r'<div\s+id=(["\'])pf[0-9a-f]+\1\s+class=(["\'])(?=[^"\']*\bpf\b)',
            text,
            re.IGNORECASE,
        )
    ]
    if not page_starts:
        return text, 0, 0

    page_starts.append(len(text))
    out_parts: list[str] = []
    pos = 0
    flattened = 0
    pages = 0

    for start, end in zip(page_starts, page_starts[1:]):
        out_parts.append(text[pos:start])
        chunk = text[start:end]
        lines: list[str] = []

        def remove_text_run(match: re.Match[str]) -> str:
            nonlocal flattened
            content = plain_text_from_markup(match.group(3))
            if content.strip():
                lines.append(content)
            flattened += 1
            return ""

        chunk = TEXT_DIV_RE.sub(remove_text_run, chunk)
        page_text = "\n".join(lines)
        page_text_div = (
            '<div class="pdf2html-page-text">'
            + html.escape(page_text, quote=False)
            + "</div>"
        )
        marker = '</div><div class="pi"'
        insert_at = chunk.rfind(marker)
        if insert_at >= 0:
            chunk = chunk[:insert_at] + page_text_div + chunk[insert_at:]
        else:
            chunk += page_text_div
        out_parts.append(chunk)
        pos = end
        pages += 1

    out_parts.append(text[pos:])
    return "".join(out_parts), flattened, pages


def image_extension(mime_ext: str) -> str:
    return "jpg" if mime_ext.lower() in {"jpg", "jpeg"} else "png"


def externalize(
    input_html: pathlib.Path,
    output_html: pathlib.Path,
    image_dir: pathlib.Path,
    url_prefix: str,
    eager: int,
    clean: bool,
    text_layer: str = "original",
) -> tuple[int, int, int, int, int]:
    text = input_html.read_text(encoding="utf-8", errors="ignore")
    expected_pages, expected_rasters = validate_source(text, input_html)

    if not url_prefix.endswith("/"):
        url_prefix += "/"

    page_index = 0
    inline_count = 0
    external_count = 0
    out_parts: list[str] = []
    pending_assets: list[tuple[pathlib.Path, bytes]] = []
    pos = 0

    for match in IMG_TAG_RE.finditer(text):
        tag = match.group(0)
        if not is_page_raster(tag):
            continue

        src_match = SRC_RE.search(tag)
        if not src_match:
            continue

        src_value = src_match.group(2)
        data_match = DATA_URI_RE.match(src_value)

        page_index += 1
        asset_url = src_value

        if data_match:
            ext = image_extension(data_match.group(1))
            filename = f"{page_index:04d}.{ext}"
            asset_path = image_dir / filename
            payload = re.sub(r"\s+", "", data_match.group(2))
            try:
                decoded = base64.b64decode(payload, validate=True)
            except Exception as exc:
                raise RuntimeError(
                    f"failed to decode page raster {page_index} in {input_html}: {exc}"
                ) from exc
            pending_assets.append((asset_path, decoded))
            asset_url = url_prefix + filename
            inline_count += 1
        else:
            external_count += 1

        escaped_url = html.escape(asset_url, quote=True)
        tag_without_src = SRC_RE.sub("", tag, count=1)
        attrs = (
            f' data-pdf2html-src="{escaped_url}"'
            f' data-pdf2html-raster="external"'
            f' data-pdf2html-page="{page_index}"'
        )
        if page_index <= eager:
            attrs = f' src="{escaped_url}"' + attrs
        replacement = add_attrs(tag_without_src, attrs)

        out_parts.append(text[pos:match.start()])
        out_parts.append(replacement)
        pos = match.end()

    # Every raster is decoded above and held in pending_assets, so a bad one
    # has already failed before any published asset is cleared or replaced.
    out_parts.append(text[pos:])
    output_text = mark_light_html(mark_light_body("".join(out_parts)), text_layer)
    page_text_count = 0
    if text_layer == "geometry":
        output_text, flattened_count = simplify_text_spans_to_geometry(output_text)
        output_text = mark_geometry_pages(output_text)
        validate_geometry_output(text, output_text, expected_pages, expected_rasters)
    elif text_layer == "paint-safe":
        output_text, flattened_count = simplify_hidden_lines_for_paint_safe(output_text)
        validate_paint_safe_output(text, output_text)
    elif text_layer == "page":
        output_text, flattened_count, page_text_count = collapse_text_spans_to_pages(output_text)
        output_text = mark_page_text_html(output_text)
    elif text_layer == "line":
        output_text, flattened_count = flatten_text_spans_to_lines(output_text)
        output_text = mark_flattened_html(output_text)
    else:
        flattened_count = 0

    # Do every parse/transform validation before replacing published assets.
    # A malformed hidden text line must leave a previous light artifact intact.
    if clean and image_dir.exists():
        shutil.rmtree(image_dir)
    image_dir.mkdir(parents=True, exist_ok=True)
    output_html.parent.mkdir(parents=True, exist_ok=True)
    for asset_path, payload in pending_assets:
        asset_path.write_bytes(payload)
    output_html.write_text(output_text, encoding="utf-8")
    return page_index, inline_count, external_count, flattened_count, page_text_count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_html", type=pathlib.Path)
    parser.add_argument("output_html", type=pathlib.Path)
    parser.add_argument("--image-dir", type=pathlib.Path, required=True)
    parser.add_argument("--url-prefix", required=True)
    parser.add_argument("--eager", type=int, default=2)
    parser.add_argument("--clean", action="store_true")
    parser.add_argument(
        "--text-layer",
        choices=("original", "geometry", "paint-safe", "page", "line"),
        default="paint-safe",
        help=(
            "light HTML text strategy: simplify only provably hidden fallback "
            "lines (paint-safe, default), retain positioned text lines while "
            "unwrapping paint-only spans (geometry), preserve the original "
            "pdf2htmlEX subtree for original diagnostics, one searchable "
            "text node per page (page), or one flattened node per visual "
            "line (line)"
        ),
    )
    parser.add_argument(
        "--preserve-text-spans",
        action="store_true",
        help="deprecated alias for --text-layer=original",
    )
    args = parser.parse_args()

    if args.eager < 0:
        parser.error("--eager must be >= 0")
    if not args.input_html.is_file():
        parser.error(f"input HTML not found: {args.input_html}")

    text_layer = "original" if args.preserve_text_spans else args.text_layer

    try:
        pages, inline_count, external_count, flattened_count, page_text_count = externalize(
            args.input_html,
            args.output_html,
            args.image_dir,
            args.url_prefix,
            args.eager,
            args.clean,
            text_layer,
        )
    except Exception as exc:
        print(f"externalize-page-images: {exc}", file=sys.stderr)
        return 1

    text_summary = f"{flattened_count} text spans {'preserved' if text_layer == 'original' else 'simplified'}"
    if text_layer == "paint-safe":
        paint_safe_lines = args.output_html.read_text(encoding="utf-8").count(
            'data-pdf2html-paint-safe="hidden"'
        )
        text_summary = (
            f"{paint_safe_lines} paint-safe hidden lines, "
            f"{flattened_count} text spans simplified"
        )

    print(
        "externalize-page-images: "
        f"{pages} page rasters, {inline_count} extracted, "
        f"{external_count} already external, "
        f"{text_summary}, "
        f"{page_text_count} page text nodes -> {args.output_html}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
