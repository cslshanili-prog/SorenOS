import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out='output/sar-market-encounters';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
const context=await browser.newContext({viewport:{width:390,height:844}});
await context.addInitScript(()=>{
 localStorage.setItem('sar-facility-guide-board-v1','done');
 localStorage.setItem('sar-feature-update-2026-09-16-bulk-fish-v1:board','done');
});
const page=await context.newPage(),errors=[];let calls=0;
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.pathname.includes('/chat/completions')){
  calls++;
  const scene=JSON.parse(route.request().postDataJSON().messages[1].content),ids=scene.visitors.map(v=>v.id);
  const mode=['buy','work','free'][calls-1],price=mode==='buy'?16:mode==='work'?9:0;
  const personas=scene.visitors.map((v,i)=>({actorId:v.id,...(v.persona||{name:'試音員'+i,identity:'給電梯配音的實習生'})}));
  const actions=[{actorId:ids[0],action:'encounter',ref:'n1',mode,price,title:'紙箱電梯第'+calls+'班',words:'專業報站，不保證離地。',event:{story:'{{participant}}剛進門，試音員就宣佈抵達三樓。門外仍是一樓。他遞來成績單：老師說我聲音上去了，人沒有。'}},
   ...ids.slice(1).map(actorId=>({actorId,action:'comment',targetId:'n1',words:'貨梯轉專業了？'})),{actorId:ids[0],action:'comment',targetId:'n1',words:'現在主修客梯。'}];
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({personas,actions})}}]})});
 }
 return ['127.0.0.1','localhost'].includes(url.hostname)?route.continue():route.fulfill({status:200,body:'',headers:{'access-control-allow-origin':'*'}});
});
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')));
try{
 await page.goto(`${process.env.SAR_QA_URL||'http://127.0.0.1:5183'}/test/fixtures/sar-facilities.html?facility=board`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.facilityQA?.os.characters.length>=60);
 await page.evaluate(()=>{Math.random=()=>.1;});
 const starting=(await state()).accounts.user;
 for(let i=1;i<=3;i++){
  await page.getByRole('button',{name:'刷新佈告板',exact:true}).click();
  await page.getByRole('status').filter({hasText:'來過了'}).waitFor();
  await page.getByRole('button').filter({hasText:'紙箱電梯第'+i+'班'}).click();
  assert.equal(await page.getByRole('region',{name:'路人小事件'}).count(),0);
  assert.equal(await page.getByText(/老[师師][说說]我[声聲]音上去了/).count(),0,'hidden story stays out of the DOM');
  const participate=page.getByRole('button',{name:i===1?'支付 16 鱗幣，參與':i===2?'接下這份活 · 酬謝 9 鱗幣':'去看看',exact:true});
  await participate.evaluate(b=>{b.click();b.click();});
  await page.getByRole('region',{name:'路人小事件'}).waitFor();
  assert.equal(calls,i,'participation does not call a model');
  const current=await state(),post=[...current.listings,...current.requests].find(p=>p.itemLabel==='紙箱電梯第'+i+'班');
  assert.equal(post.encounterResult.participantId,'user');
  assert(!post.encounterResult.story.includes('{{participant}}'));
  assert.equal(current.accounts.user,starting-16+(i>=2?9:0));
  assert.equal(current.ledger.filter(e=>e.text.includes('遊戲內')&&e.text.includes('紙箱電梯第'+i+'班')).length,1);
  await page.screenshot({path:`${out}/event-${i}.png`,animations:'disabled'});
  await page.getByRole('button',{name:'返回上一頁',exact:true}).click();
 }
 await page.getByRole('button',{name:'佈告板更多',exact:true}).click();
 await page.getByRole('button').filter({hasText:'往期便箋'}).click();
 await page.getByRole('button').filter({hasText:'紙箱電梯第1班'}).click();
 await page.getByRole('region',{name:'路人小事件'}).waitFor();
 await page.setViewportSize({width:320,height:640});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:`${out}/archive-320.png`,animations:'disabled'});
 assert.deepEqual(errors,[]);
 writeFileSync(`${out}/report.json`,JSON.stringify({calls,paidFreeAndWork:true,hiddenUntilParticipation:true,oneSettlement:true,archive:true,errors},null,2));
 console.log('Market encounters passed: hidden story, payment/reward/free, one settlement, no extra model call, archive and 320px layout.');
}finally{await browser.close();}
