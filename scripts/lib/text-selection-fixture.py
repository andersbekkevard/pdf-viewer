"""Synthetic selection/order cases. No private document content."""
import sys
from reportlab.pdfgen import canvas
c = canvas.Canvas(sys.argv[1], pagesize=(600, 780))
for columns in (1, 2, 3):
    c.setFont('Helvetica', 11)
    # Deliberately interleaved stream order; each column is read to its end.
    for row in range(8):
        for col in range(columns):
            c.drawString(50 + col * (500 / columns), 700 - row * 38 - col * 13,
                         f'C{col+1}R{row+1} ordinary text')
    c.drawString(50, 300, 'Paragraph after a figure.')
    c.drawString(50, 350, 'Figure caption.')
    c.drawString(50, 80, 'Footnote at the bottom.')
    c.saveState(); c.translate(18, 200); c.rotate(90)
    c.drawString(0, 0, 'Rotated margin stamp'); c.restoreState()
    c.showPage()
c.setFont('Helvetica', 11)
for row in range(6):
    c.drawString(50, 700-row*22, f'Table row {row} left')
    c.drawString(310, 700-row*22, f'right cell {row}')
c.drawString(50, 500, 'hyphen-'); c.drawString(50, 478, 'ated unchanged')
c.showPage()
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pathlib import Path
font = next((p for p in (
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
) if Path(p).is_file()), None)
if font is None:
    raise RuntimeError('RTL selection fixture needs Arial or DejaVu Sans')
pdfmetrics.registerFont(TTFont('SelectionRTL', font))
c.setFont('SelectionRTL', 12)
c.drawString(300, 620, 'שלום עולם')
c.drawString(300, 700, 'טקסט לבחירה')
c.showPage(); c.save()
