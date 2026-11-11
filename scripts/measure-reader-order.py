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
    out.append(dict(page=page+1,before_inversions=score(before),after_inversions=score(after),
                    lines=len(before),unchanged=(before==after),same_lines=sorted(map(id,before))==sorted(map(id,after))))
print(json.dumps(out,indent=2))
if any(p['after_inversions'] or not p['same_lines'] for p in out) or not all(p['unchanged'] for p in out[3:]): sys.exit(1)
