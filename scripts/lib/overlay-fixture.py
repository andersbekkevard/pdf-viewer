# Synthetic outline/link fixture adapted from verify-vimium.cjs; 160 pages exercise distant jumps.
# Usage: overlay-fixture.py <out.pdf> <title> <pages> [flat|nested|none]
#   flat (default): four chapters; nested adds sections under them; none has no outline.

import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

out, title = sys.argv[1], sys.argv[2]
W, H = A4
WORDS = ("reading documents with the keyboard should feel ordinary and quiet while every page "
         "keeps its layout and its text remains selectable searchable and copyable across lines "
         "chapters figures footnotes tables margins and references").split()
CHAPTERS = {1: "Introduction", 4: "Methods", 8: "Results", 12: "Discussion"}
OUTLINE = sys.argv[4] if len(sys.argv) > 4 else "flat"
SECTIONS = {5: (1, "Sampling design"), 6: (2, "Résumé of instruments"), 9: (1, "Effect sizes"),
            10: (1, "Robustness checks")}
c = canvas.Canvas(out, pagesize=A4)
c.setTitle(title)
number = 0
for n in range(1, int(sys.argv[3]) + 1):
    key = "p%d" % n
    c.bookmarkPage(key, fit="XYZ", top=H - 60)
    if n in CHAPTERS:
        number += 1
        if OUTLINE != "none":
            c.addOutlineEntry("%d %s" % (number, CHAPTERS[n]), key, level=0)
    if OUTLINE == "nested" and n in SECTIONS:
        level, label = SECTIONS[n]
        c.addOutlineEntry(label, key, level=level)
    c.setFont("Helvetica-Bold", 18)
    c.drawString(72, H - 80, "Page %d heading" % n + (": " + CHAPTERS[n] if n in CHAPTERS else ""))
    c.setFont("Helvetica", 11)
    y = H - 120
    for line in range(38):
        words = [WORDS[(n * 7 + line * 5 + i) % len(WORDS)] for i in range(12)]
        text = "Line %d of page %d: %s." % (line + 1, n, " ".join(words))
        if line == 20 and n % 3 == 2:
            text = "Line %d of page %d holds the marker word zymurgical among ordinary words." % (line + 1, n)
        c.drawString(72, y, text)
        y -= 16
    if n == 1:
        c.drawString(72, 100, "Source https://example.org/vimium-harness/paper and doi:10.1234/vimium.5678 here.")
        c.drawString(72, 60, "See the results on page nine. Visit the example site.")
        c.linkAbsolute("", ("p9" if int(sys.argv[3]) >= 9 else "p1"), Rect=(72, 56, 240, 72))
        c.linkURL("https://example.com/vimium-harness", (260, 56, 400, 72), relative=0)
    c.showPage()
c.save()
