'use strict';
// Uses real CDP-backed mouse input, never fabricated selection events for drags.
module.exports = async function(page, base, record) {
  const fs = require('fs'), os = require('os'), path = require('path');
  const {execFileSync} = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfv-selection-'));
  try {
    const pdf = path.join(tmp, 'fixture.pdf');
    execFileSync('uv', ['run','--quiet','--no-project','--with','reportlab','python',path.join(__dirname,'lib/text-selection-fixture.py'),pdf]);
    await page.goto(base + '/read?path=' + encodeURIComponent(pdf));
    await page.waitForSelector('#pf1 .t');
    await page.waitForTimeout(500);
    await page.evaluate(() => { localStorage.setItem('pdf2html-zoom','1'); });
    await page.reload(); await page.waitForSelector('#pf1 .t'); await page.waitForTimeout(500);
    for (const n of [1,2]) {
      await page.evaluate(n => { const pf = document.getElementById('pf'+n); const root=document.getElementById('page-container'); root.scrollTop += pf.getBoundingClientRect().top-root.getBoundingClientRect().top-8; }, n);
      await page.waitForTimeout(400);
      const boxes = await page.evaluate(n => {
        const pf=document.getElementById('pf'+n), lines=[...pf.querySelectorAll('.t')];
        const line=lines.find(l=>l.textContent.startsWith('C1R4'));
        const b=line.getBoundingClientRect(), p=pf.getBoundingClientRect();
        return {x:b.x,y:b.y,w:b.width,h:b.height,px:p.x,py:p.y,pw:p.width};
      },n);
      for (const [label,x,y] of [
        ['right whitespace',boxes.x+boxes.w+15,boxes.y+boxes.h/2],
        ['left margin',boxes.px+25,boxes.y+boxes.h/2],
        ['paragraph gap',boxes.x+boxes.w-5,boxes.y+boxes.h+8],
        ['below last line',boxes.x+30,boxes.py+730],
      ]) {
        await page.evaluate(()=>getSelection().removeAllRanges());
        await page.mouse.move(boxes.x+20,boxes.y+boxes.h/2); await page.mouse.down();
        await page.mouse.move(boxes.x+45,boxes.y+boxes.h/2,{steps:3}); await page.mouse.move(x,y,{steps:12}); await page.waitForTimeout(60);
        const selected = await page.evaluate(()=>getSelection().toString());
        await page.mouse.up();
        record(`reader ${n===1?'single':'two'} column drag into ${label} stays local`,
          selected.length > 0 && !selected.includes('C1R1') && (label==='below last line'||!selected.includes('C2R')),JSON.stringify(selected));
      }
    }
    await page.evaluate(()=>{document.getElementById('pf1').scrollIntoView();getSelection().removeAllRanges();});
    await page.waitForTimeout(400);
    const b=await page.locator('#pf1 .t').filter({hasText:'C1R4'}).boundingBox();
    await page.mouse.click(b.x+8,b.y+b.height/2,{clickCount:2});
    record('reader double-click selects a word', (await page.evaluate(()=>getSelection().toString())).trim()==='C1R4');
    await page.mouse.click(b.x+8,b.y+b.height/2,{clickCount:3});
    record('reader triple-click selects a line', (await page.evaluate(()=>getSelection().toString())).includes('C1R4 ordinary text'));
    const spanning = await page.evaluate(()=>{
      const a=[...document.querySelectorAll('#pf1 .t')].at(-1);
      const b=document.querySelector('#pf2 .t');
      const first=document.createTreeWalker(a,NodeFilter.SHOW_TEXT).nextNode();
      const last=document.createTreeWalker(b,NodeFilter.SHOW_TEXT).nextNode();
      getSelection().setBaseAndExtent(first,0,last,last.length);
      return {text:getSelection().toString(),a:a.textContent,b:b.textContent};
    });
    record('reader page-spanning selection has each boundary line once and a line break',
      spanning.text.split(spanning.a).length===2 && spanning.text.split(spanning.b).length===2 &&
      spanning.text.includes('\n'), JSON.stringify(spanning.text));
    await page.keyboard.press('Meta+c');
    const copied=await page.evaluate(()=>navigator.clipboard.readText());
    record('reader page-spanning native copy equals the selected text',copied===spanning.text);
    const hyphen=await page.evaluate(()=>{
      const lines=[...document.querySelectorAll('#pf4 .t')];
      const a=lines.find(l=>l.textContent==='hyphen-'), b=lines.find(l=>l.textContent==='ated unchanged');
      const first=a.firstChild,last=b.firstChild;
      getSelection().setBaseAndExtent(first,0,last,last.length);
      return getSelection().toString();
    });
    record('reader preserves PDFium line-end hyphen on selection/copy', /hyphen-\n+ated unchanged/.test(hyphen),JSON.stringify(hyphen));
    await page.evaluate(()=>{getSelection().removeAllRanges();window.find('C1R2');});
    await page.waitForTimeout(300);
    await page.evaluate(()=>{document.getElementById('page-container').scrollTop+=800;});
    await page.waitForTimeout(400);
    const before=await page.evaluate(()=>document.getElementById('page-container').scrollTop);
    await page.keyboard.press('Enter');
    // Chromium may dispatch selectionchange again with identical native-find endpoints.
    await page.evaluate(()=>document.dispatchEvent(new Event('selectionchange')));
    await page.waitForTimeout(500);
    const after=await page.evaluate(()=>document.getElementById('page-container').scrollTop);
    record('stale native-find selection does not follow on Enter/selectionchange',Math.abs(before-after)<2,`${before} -> ${after}`);
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
};
