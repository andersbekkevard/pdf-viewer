import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import pdfium_doc


def line(text, x, y, w=100, **kw):
    return dict(x=x, y=y, h=12, dir=0, segs=[dict(t=text, w=w, gap=0, sp=False)], **kw)


class ReadingOrderTests(unittest.TestCase):
    def test_interleaved_columns(self):
        for columns in (2, 3):
            lines = [line(f'{c}:{r}', 50+c*160, 50+r*20) for r in range(6) for c in range(columns)]
            expected = [f'{c}:{r}' for c in range(columns) for r in range(6)]
            ordered = pdfium_doc.reading_order(lines)
            self.assertEqual([l['segs'][0]['t'] for l in ordered], expected)
            self.assertEqual({id(l) for l in ordered}, {id(l) for l in lines})

    def test_caption_footnote_and_rotated_stamp(self):
        stamp = line('stamp', 12, 200); stamp['dir'] = 3
        lines = [stamp, line('footnote', 50, 700), line('body2', 50, 400),
                 line('caption', 50, 300), line('body1', 50, 100)]
        self.assertEqual([l['segs'][0]['t'] for l in pdfium_doc.reading_order(lines)],
                         ['body1', 'caption', 'body2', 'footnote', 'stamp'])

    def test_rtl_and_table_are_conservative(self):
        rtl = [line('אבג', 60, 200, rtl=True), line('דהו', 60, 100, rtl=True)]
        self.assertEqual(pdfium_doc.reading_order(rtl), rtl)
        rows = [line(str(i), 50, 50+i*20) for i in range(5)]
        for row in rows:
            row['segs'].append(dict(t='cell', w=60, gap=130, sp=True))
        self.assertEqual(pdfium_doc.reading_order(rows), rows)

    def test_rtl_characters_and_markup_unchanged(self):
        import reader
        chars=[(ch, 100-i*9, 50, 109-i*9, 62, i) for i,ch in enumerate('שלום עולם')]
        lines=pdfium_doc._build_line(chars)
        self.assertTrue(lines[0]['rtl'])
        self.assertEqual(pdfium_doc.reading_order(lines), lines)
        self.assertIn('dir="rtl"', reader._line_html(lines[0]))
        self.assertEqual(lines[0]['segs'][0]['t'], 'שלום עולם')
