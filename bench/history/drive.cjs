// One fresh context per document; browser traffic is restricted to the scratch daemon.
const fs = require('fs');
const {chromium} = require('playwright');
(async () => {
 const spec = JSON.parse(fs.readFileSync(process.argv[2]));
 const browser = await chromium.launch({headless:true});
 const context = await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
 const origin = new URL(spec.url).origin;
 await context.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
 const page = await context.newPage();
 const out = {outcome:'error',failure:'harness-error',console_errors:0, overlay_errors:0,first_page_ms:null,text_ms:null};
 page.on('console', m => {if(m.type()==='error')out.console_errors++;});
 page.on('pageerror', () => out.overlay_errors++);
 try {
   const response = await page.goto(spec.url,{waitUntil:'domcontentloaded',timeout:60000});
   if(response.status()>=400) {out.failure = new URL(page.url()).pathname.startsWith('/r/') && response.status()===502?'pdfium-failed':'source-http-'+response.status();}
   else if(!new URL(page.url()).pathname.startsWith('/r/'))out.failure='fallback';
   else {
     out.entry = new URL(page.url()).pathname.split('/')[2];
     await page.waitForFunction(() => [...document.querySelectorAll('.pf img.bi')].some(i=>i.complete&&i.naturalWidth&&i.getBoundingClientRect().top<innerHeight),null,{timeout:60000});
     await page.evaluate(() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
     out.first_page_ms = await page.evaluate(()=>performance.now());
     out.outcome='reader'; out.failure=null;
     await page.waitForFunction(()=>document.documentElement.dataset.readerText==='complete',null,{timeout:60000}).then(async()=>{out.text_ms=await page.evaluate(()=>performance.now());}).catch(()=>out.failure='text-timeout');
     Object.assign(out,await page.evaluate(()=>({pages:document.querySelectorAll('.pf').length,scanned:document.querySelectorAll('[data-reader-ocr]').length,ocr_text:document.querySelectorAll('.t.ocr').length,dom_text:[...document.querySelectorAll('.pf:first-child .t')].map(e=>e.textContent).join('')})));
     if (out.scanned) {
       await page.waitForFunction(() => {
         const frames=[...document.querySelectorAll('.pf[data-reader-ocr]')].filter(e=>e.getBoundingClientRect().top<innerHeight && e.getBoundingClientRect().bottom>0);
         return frames.every(e=>['done','failed'].includes(e.dataset.readerOcr));
       },null,{timeout:15000}).catch(()=>out.ocr_wait_timeout=true);
       out.ocr_text=await page.locator('.t.ocr').count();
     }
     const words=(spec.words||[]).slice(0,8);
     out.find_recall=words.length ? await page.evaluate(words=>words.filter(w=>{getSelection().removeAllRanges();return window.find(w,false,false,true);}).length/words.length,words):null;
   }
 } catch(e) {out.failure = e.name==='TimeoutError'?'timeout':'harness-error';}
 finally {await browser.close();}
 console.log(JSON.stringify(out));
})().catch(()=>{console.log(JSON.stringify({outcome:'error',failure:'harness-error'}));process.exitCode=1;});
