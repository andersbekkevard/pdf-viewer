"""Measure known column order without retaining document text (run through uv/daemon)."""
import json
import pathlib
import re
import sys
from unittest.mock import patch
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'daemon'))
import pdfium_doc

out=[]
for page in range(5):
    with patch.object(pdfium_doc, 'reading_order', lambda lines: lines):
        before=pdfium_doc.page_text(sys.argv[1],page)
    after=pdfium_doc.reading_order(before)
    def score(lines):
        tokens=[]
        for line in lines:
            text=''.join(seg['t'] for seg in line['segs'])
            tokens.extend((int(c),int(r)) for c,r in re.findall(r'C(\d)R(\d)',text))
        inv=sum(a>b for i,a in enumerate(tokens) for b in tokens[i+1:])
        return inv
    auxiliary_ok=True
    if page < 3:
        text=[''.join(s['t'] for s in line['segs']) for line in after]
        auxiliary_ok=(text.index('Figure caption.') < text.index('Paragraph after a figure.')
                      < text.index('Footnote at the bottom.') < text.index('Rotated margin stamp')
                      and text[-1]=='Rotated margin stamp')
    out.append(dict(auxiliary_order_ok=auxiliary_ok,page=page+1,before_inversions=score(before),after_inversions=score(after),
                    lines=len(before),unchanged=(before==after),same_lines=sorted(map(id,before))==sorted(map(id,after))))
print(json.dumps(out,indent=2))
if any(p['after_inversions'] or not p['same_lines'] or not p['auxiliary_order_ok'] for p in out) or not all(p['unchanged'] for p in out[3:]): sys.exit(1)
