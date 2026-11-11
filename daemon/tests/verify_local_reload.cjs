// Headless proof against an already-running scratch daemon, never the personal cache.
// NODE_PATH=<cached Playwright modules> node daemon/tests/verify_local_reload.cjs
const {chromium}=require('playwright');
const {execFileSync}=require('child_process');
const fs=require('fs');
const os=require('os'), path=require('path');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(), 'pdfv-local-proof-'));
const file=path.join(scratch, 'live.pdf'), base=process.env.PDFV_TEST_BASE || 'http://127.0.0.1:7444';
function generate(n){execFileSync('uv',['run','--with','reportlab','python','-c',
 `import sys
from reportlab.pdfgen.canvas import Canvas
c=Canvas(sys.argv[1])
for i in range(int(sys.argv[2])):
 c.drawString(50,700,f'Generated page {i+1}');c.showPage()
c.save()`,file,String(n)]);}
(async()=>{
 generate(4);
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage();let errors=[];page.on('pageerror',e=>errors.push(String(e)));
 let checks=0;page.on('request',r=>{if(r.url().includes('/local-file/check'))checks++;});
 await page.goto(base+'/read?path='+encodeURIComponent(file));
 await page.waitForSelector('#pdf2html-pageno-current', {state:'attached'});
 const first=page.url();
 async function command(text){await page.keyboard.press(':');await page.locator('#pdf2html-palette-input').fill(text);await page.keyboard.press('Enter');}
 await command('page 3');await command('mark a');await page.waitForTimeout(1100);
 fs.writeFileSync(file,'%PDF-1.7\n');await page.waitForTimeout(4200);
 if(page.url()!==first)throw Error('reloaded truncated file'); console.log('PASS incomplete save retained tab');
 generate(2);let started=Date.now();
 await page.waitForURL(u=>u.href!==first,{timeout:20000});await page.waitForSelector('#pdf2html-pageno-current', {state:'attached'});await page.waitForTimeout(1000);
 let hash=new URL(page.url()).pathname.split('/')[2];let state=await (await fetch(base+'/entry/'+hash+'/state')).json();
 if(state.position.value.page!==2||state.marks.value.a.page!==2)throw Error(JSON.stringify(state));
 console.log('PASS stable save reloaded and clamped position/marks',Date.now()-started,'ms');
 await command('livereload off');const second=page.url();generate(3);await page.waitForTimeout(4500);
 if(page.url()!==second)throw Error('off preference ignored');console.log('PASS command disables reload');
 await command('livereload on');await page.waitForURL(u=>u.href!==second,{timeout:20000});console.log('PASS command enables reload');
 await page.close();let count=checks;await new Promise(r=>setTimeout(r,3200));if(count!==checks)throw Error('poll after close');console.log('PASS no polls after close; errors',JSON.stringify(errors));
 if(errors.length)throw Error(errors.join('\n'));
 await browser.close();
 fs.rmSync(scratch,{recursive:true,force:true});
})().catch(e=>{console.error(e);process.exit(1)});
