const { chromium } = require(process.env.TDG_PLAYWRIGHT || 'playwright');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const entry = '/scripts/extensions/third-party/tavern-draft-guard/';
const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${entry}style.css"><style>body{background:#202020;color:#eee;font-family:system-ui}#send_textarea{width:90%;height:120px}button,select,textarea{background:#303030;color:#eee}</style><body><h2>酒馆输入框测试</h2><form><div id="leftSendForm"></div><textarea id="send_textarea"></textarea></form><script>
window.listeners={}; window.ctx={ chat:[],characters:[{avatar:'alice.png'},{avatar:'bob.png'}],characterId:0,groupId:null,chatId:'chat-A',eventTypes:{APP_READY:'ready',CHAT_CHANGED:'change',MESSAGE_SENT:'sent'},getCurrentChatId(){return this.chatId},eventSource:{on(type,fn){(listeners[type]??=[]).push(fn)}}};
window.emit=(type,...args)=>{for(const fn of listeners[type]||[])fn(...args)};
window.SillyTavern={getContext:()=>ctx};
window.send=(text)=>{const box=document.querySelector('#send_textarea');const msg=text??box.value;box.value='';box.dispatchEvent(new Event('input',{bubbles:true}));ctx.chat.push({is_user:true,mes:msg});emit('sent',ctx.chat.length-1)};
</script><script type="module" src="${entry}index.js"></script></body></html>`;
const requests=[];
const server=http.createServer(async(req,res)=>{
    requests.push(req.url);
    if(req.url==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(html)}
    if(req.url==='/scripts/user.js'){res.setHeader('Content-Type','text/javascript');return res.end("export const getCurrentUserHandle=()=>window.testUser||'test-user';")}
    const file=req.url.startsWith(entry)?req.url.slice(entry.length):'';
    if(!['index.js','store.js','style.css'].includes(file)){res.statusCode=404;return res.end()}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');
    res.end(await fs.readFile(path.join(root,file)));
});
const results=[];
async function check(name,fn){await fn();results.push(name);console.log('PASS',name)}
(async()=>{
 await fs.mkdir('work',{recursive:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({...(process.env.TDG_BROWSER ? {executablePath:process.env.TDG_BROWSER} : {}),headless:true});
 try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1});
 const errors=[];page.on('pageerror',err=>errors.push(err.message));
 const url=`http://127.0.0.1:${server.address().port}`;
 await page.goto(url);await page.waitForSelector('#tdg-open');
 const box=page.locator('#send_textarea');
 async function history(){await page.locator('#tdg-open').click();await page.waitForFunction(()=>{const s=document.querySelector('.tdg-status');return s&&!s.textContent.includes('正在读取')});}
 async function close(){await page.getByRole('button',{name:'关闭',exact:true}).click()}
 async function rows(){return page.evaluate(async(entry)=>{const{DraftStore}=await import(entry+'store.js');const s=new DraftStore();const k=JSON.stringify([window.testUser||'test-user','character',ctx.characters[ctx.characterId].avatar,ctx.chatId]);const m=await s.list(k);return {current:await Promise.all(m.current.map(x=>s.read(k,x.id))),previous:await Promise.all(m.previous.map(x=>s.read(k,x.id)))}},entry)}
 await check('3 秒内连续输入会保存，静止不重复写入',async()=>{
  await box.fill('第一楼 v1');await page.waitForTimeout(3150);let r=await rows();assert.equal(r.current.at(-1).text,'第一楼 v1');
  await page.waitForTimeout(3200);assert.equal((await rows()).current.length,1);
 });
 await check('发送前不足 3 秒的末尾修改仍保留；发送后保留第一楼',async()=>{
  await box.fill('第一楼 最后修改');await page.evaluate(()=>send());await history();await close();
  let r=await rows();assert.deepEqual(r.previous.map(x=>x.text),['第一楼 v1','第一楼 最后修改']);assert.equal(r.current.length,0);
 });
 await check('第三楼正在写时第一楼仍在；第三楼发出时物理删除第一楼快照',async()=>{
  const old=(await rows()).previous.map(x=>x.id);
  await box.fill('第三楼 草稿');await history();await close();let r=await rows();assert.equal(r.previous.length,2);assert.equal(r.current.at(-1).text,'第三楼 草稿');
  await box.fill('第三楼 发送');await page.evaluate(()=>send());await history();await close();r=await rows();assert.deepEqual(r.previous.map(x=>x.text),['第三楼 草稿','第三楼 发送']);
  const exists=await page.evaluate(async({entry,old})=>{const{DraftStore}=await import(entry+'store.js');const s=new DraftStore();const k=JSON.stringify(['test-user','character','alice.png','chat-A']);return Promise.all(old.map(id=>s.read(k,id)))},{entry,old});assert(exists.every(x=>x===null));
 });
 await check('刷新后可查看与恢复；恢复前保护现有正文',async()=>{
  await box.fill('第五楼 正在写');await history();await close();await page.reload();await page.waitForSelector('#tdg-open');await history();
  assert.equal(await page.locator('.tdg-preview').inputValue(),'第五楼 正在写');await close();
  await box.fill('第五楼 临时改写');await history();
  const option=await page.locator('.tdg-select option').evaluateAll(nodes=>nodes.map(n=>n.value));
  await page.locator('.tdg-select').selectOption(option[1]);await page.waitForFunction(()=>document.querySelector('.tdg-preview').value==='第五楼 正在写');
  await page.getByRole('button',{name:'恢复到输入框',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);assert.equal(await box.inputValue(),'第五楼 正在写');assert((await rows()).current.some(x=>x.text==='第五楼 临时改写'));
 });
 await check('聊天、角色、账户隔离；切换前保存旧聊天',async()=>{
  await box.fill('A 离开前最后输入');await page.evaluate(()=>{ctx.chatId='chat-B';document.querySelector('#send_textarea').value='';emit('change')});
  await history();assert.equal(await page.locator('.tdg-select').count(),0);await close();
  await page.evaluate(()=>{ctx.chatId='chat-A';ctx.characterId=1;emit('change')});assert.equal((await rows()).current.length,0);
  await page.evaluate(()=>{ctx.characterId=0;window.testUser='other';emit('change')});assert.equal((await rows()).current.length,0);
  await page.evaluate(()=>{window.testUser='test-user';emit('change')});assert.equal((await rows()).current.at(-1).text,'A 离开前最后输入');
 });
 await check('中文输入法组合过程中不定时保存，完成组合后保存',async()=>{
  await page.evaluate(()=>document.querySelector('#send_textarea').dispatchEvent(new CompositionEvent('compositionstart')));
  await box.fill('输入法尚未确认');await page.waitForTimeout(3150);assert(!(await rows()).current.some(x=>x.text==='输入法尚未确认'));
  await page.evaluate(()=>document.querySelector('#send_textarea').dispatchEvent(new CompositionEvent('compositionend')));await page.waitForTimeout(3150);assert.equal((await rows()).current.at(-1).text,'输入法尚未确认');
 });
 await check('发送事件延迟到达时，新输入归入下一楼；重复事件不再轮换',async()=>{
  await box.fill('第五楼 即将发送');await page.evaluate(()=>{const b=document.querySelector('#send_textarea');b.value='';b.dispatchEvent(new Event('input',{bubbles:true}))});
  await box.fill('第七楼 提前开始');await page.waitForTimeout(3150);
  await page.evaluate(()=>{ctx.chat.push({is_user:true,mes:'第五楼 即将发送'});emit('sent',ctx.chat.length-1)});await history();await close();
  let r=await rows();assert.equal(r.previous.at(-1).text,'第五楼 即将发送');assert.equal(r.current.at(-1).text,'第七楼 提前开始');
  await page.evaluate(()=>emit('sent',ctx.chat.length-1));await history();await close();assert.equal((await rows()).previous.at(-1).text,'第五楼 即将发送');
 });
 await check('正文按纯文本展示，不执行 HTML；手机宽度无横向溢出',async()=>{
  await box.fill('<img src=x onerror="window.injected=true">你好');await history();assert.equal(await page.locator('.tdg-preview').inputValue(),'<img src=x onerror="window.injected=true">你好');assert.equal(await page.evaluate(()=>window.injected),undefined);
  assert(await page.locator('dialog').evaluate(d=>d.getBoundingClientRect().width<=innerWidth&&d.scrollWidth<=d.clientWidth));
  await page.screenshot({path:'work/mobile-history.png'});await close();
 });
 await check('浏览器存储失败时显示错误，恢复操作不覆盖原输入',async()=>{
  await box.fill('存储异常时原文不能丢');
  await page.evaluate(async(entry)=>{const{DraftStore}=await import(entry+'store.js');window.realSave=DraftStore.prototype.save;DraftStore.prototype.save=async()=>{throw new Error('模拟磁盘写入失败')}},entry);
  await history();assert((await page.locator('.tdg-status').innerText()).includes('失败'));
  await page.getByRole('button',{name:'恢复到输入框',exact:true}).click();assert.equal(await box.inputValue(),'存储异常时原文不能丢');assert(await page.locator('dialog').evaluate(d=>d.open));await close();
  await page.evaluate(async(entry)=>{const{DraftStore}=await import(entry+'store.js');DraftStore.prototype.save=window.realSave},entry);await history();await close();assert.equal((await rows()).current.at(-1).text,'存储异常时原文不能丢');
 });
 await check('版本上限、字节预算、聊天上限与超长保护生效',async()=>{
  const result=await page.evaluate(async(entry)=>{
   const{DraftStore,LIMITS}=await import(entry+'store.js');const s=new DraftStore('tdg-limit-test');
   for(let i=0;i<130;i++)await s.save('count','v'+i);
   const count=(await s.list('count')).current.length;
   for(let i=0;i<8;i++)await s.save('bytes',String(i)+'a'.repeat(100000));
   const bm=await s.list('bytes');let rejected=false;try{await s.save('large','x'.repeat(LIMITS.text+1))}catch{rejected=true}
   for(let i=0;i<34;i++)await s.save('chat'+i,'hello');
   const chats=await s.transact('readonly',(chats,snaps,done)=>{const req=chats.count();req.onsuccess=()=>done(req.result)});
   const snapshots=await s.transact('readonly',(chats,snaps,done)=>{const req=snaps.count();req.onsuccess=()=>done(req.result)});
   return {count,bytes:bm.current.reduce((n,x)=>n+x.bytes,0),rejected,chats,snapshots};
  },entry);
  assert.equal(result.count,120);assert(result.bytes<=1024*1024);assert(result.rejected);assert.equal(result.chats,32);assert.equal(result.snapshots,32);
 });
 await check('局域网 HTTP 缺少 randomUUID 时仍能保存和轮换',async()=>{
  const result=await page.evaluate(async(entry)=>{
   const original=crypto.randomUUID;crypto.randomUUID=undefined;
   try{const{DraftStore}=await import(entry+'store.js');const s=new DraftStore('tdg-http-test');await s.save('http','正文');await s.sent('http','已发送正文');const m=await s.list('http');return(await s.read('http',m.previous.at(-1).id)).text}
   finally{crypto.randomUUID=original}
  },entry);assert.equal(result,'已发送正文');
 });
 await check('脚本/快捷回复发送不误删仍留在输入框中的草稿',async()=>{
  await box.fill('仍然没发出的正文');await page.evaluate(()=>{ctx.chat.push({is_user:true,mes:'脚本单独发送'});emit('sent',ctx.chat.length-1)});await history();await close();
  const r=await rows();assert.equal(r.current.at(-1).text,'仍然没发出的正文');assert.equal(r.previous.at(-1).text,'脚本单独发送');
 });
 await check('切入后台立即补存且不再定时写入，返回前台可继续保存',async()=>{
  await box.fill('切后台前输入');await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))});
  await page.waitForTimeout(100);assert.equal((await rows()).current.at(-1).text,'切后台前输入');
  await box.fill('后台脚本更改');await page.waitForTimeout(3200);assert.equal((await rows()).current.at(-1).text,'切后台前输入');
  await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});await history();await close();assert.equal((await rows()).current.at(-1).text,'后台脚本更改');
 });
 await check('空闲不发生存储写入；扩展无任何网络写入和设置写入',async()=>{
  await page.evaluate(()=>{window.putCount=0;window.realPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){window.putCount++;return window.realPut.apply(this,args)}});
  await page.waitForTimeout(3200);assert.equal(await page.evaluate(()=>putCount),0);
  assert(!requests.some(x=>x.startsWith('/api/')));
  const source=await fs.readFile(path.join(root,'index.js'),'utf8');assert(!/saveSettings|extension_settings|localStorage|fetch\(/.test(source));
 });
 const perf=await page.evaluate(async(entry)=>{const{DraftStore}=await import(entry+'store.js');const s=new DraftStore('tdg-perf');const times=[];for(let i=0;i<30;i++){const start=performance.now();await s.save('perf','a'.repeat(50000)+i);times.push(performance.now()-start)}return{median:times.sort((a,b)=>a-b)[15],max:Math.max(...times)}},entry);
 assert.deepEqual(errors,[]);
 const report={passed:results.length,tests:results,storageBenchmark50kCharactersMs:perf,browser:await browser.version(),upstreamCommit:'06bde939fb1e9c4c8d8641d810f0a916b5bce127',note:'Real Chromium + mocked SillyTavern DOM/events; not a full SillyTavern server or a physical phone.'};
 await fs.writeFile('work/test-results.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();server.close()}
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
