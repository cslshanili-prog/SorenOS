import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const out='output/fishing-qa/sar-collection';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],prompts=[];
let modelReply='',race=false,modelCalls=0;
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/collection-model/chat/completions'){
        modelCalls++;prompts.push(JSON.stringify(route.request().postDataJSON()));
        if(race) await page.evaluate(async()=>{const {DB}=await import('/utils/db.ts');const char=(await DB.getAllCharacters()).find(c=>c.id==='atlas-aran');await DB.saveCharacter({...char,vrState:{...char.vrState,title:'手動的新稱號',titleRevision:'manual-during-request'}});});
        return route.fulfill({json:{choices:[{message:{content:modelReply}}]}});
    }
    return ['127.0.0.1','localhost'].includes(url.hostname)?route.continue():route.fulfill({status:200,body:'',headers:{'access-control-allow-origin':'*'}});
});
const button=name=>page.getByRole('button',{name,exact:true});
const shot=async name=>{await page.screenshot({path:`${out}/${name}.png`,animations:'disabled'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);};
const enter=async()=>{await button('SAR').click();await page.waitForFunction(()=>document.querySelector('.sar-room-canvas')?.clientWidth>0&&document.querySelector('img[alt="SAR 活動室"]')?.complete);};
const atlas=async()=>{await button('打開倉庫').click();await page.getByTestId('sar-wallet-balance').waitFor();await button('打開收集圖鑑').click();await page.getByRole('heading',{name:'收集圖鑑',exact:true}).waitFor();};
try{
    await page.goto('http://127.0.0.1:5177/test/fixtures/kanata.html?npcs=show');await button('SAR').waitFor();
    const catalog=await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts'),m=await import('/utils/vrWorld/fishingMarket.ts'),shop=await import('/utils/vrWorld/sarModuleShop.ts'),commerce=await import('/utils/vrWorld/sarCommerce.ts');
        for(const [id,name,title] of [['atlas-aran','阿嵐','湖邊發呆冠軍'],['atlas-nora','諾拉','雲朵收藏家']])await DB.saveCharacter({id,name,avatar:'',systemPrompt:'用中文回覆，自己決定。',vrState:{enabled:true,activityMode:'manual',intervalMinutes:120,currentRoom:'sar',title,titleRevision:'initial'}});
        const user=await DB.getUserProfile();await DB.saveUserProfile({...user,name:'小雨',vrState:{enabled:true,currentRoom:'sar',title:'今天也來閒逛',chibi:{img:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><ellipse cx="50" cy="75" rx="22" ry="24" fill="#c2a9b4"/><circle cx="50" cy="38" r="26" fill="#ecdcc5"/><path d="M23 38 Q14 2 52 5 Q88 4 77 42 L65 25 43 29 36 21Z" fill="#86765c"/><circle cx="40" cy="40" r="2" fill="#54483b"/><circle cx="60" cy="40" r="2" fill="#54483b"/></svg>')}}});
        let s=m.ensureMarketDay({...m.createFishingMarketState(42),accounts:{user:120,'atlas-aran':76,'atlas-nora':120}});
        for(const [ownerId,speciesId] of [['user','cloud-carp'],['user','triceratops'],['user','stegosaurus'],['atlas-aran','rain-drum']])s=m.addCatchToState(s,{id:ownerId+speciesId,ownerId,ownerName:ownerId==='user'?'小雨':'阿嵐',speciesId,caughtAt:Date.now(),weather:'clear',weatherLabel:'晴',weatherSource:'simulated',sizeCm:23,quality:2});
        const moduleShop=shop.createSARModuleShopState();moduleShop.inventory={[shop.SAR_MODULE_CATALOG[0].id]:1,[shop.SAR_MODULE_CATALOG[3].id]:2,[shop.SAR_MODULE_CATALOG[8].id]:1};
        s.sarCommerce={moduleShop,gacha:{version:1,collection:{'story-01':2,'story-03':1,'variant-01':2,'variant-04':1},history:[],freeDrawDate:{}}};s.sarCharacterModules={'atlas-aran':{[shop.SAR_MODULE_CATALOG[6].id]:1}};
        m.saveFishingMarketState(s);await commerce.consumeOwnedSARModule(shop.SAR_MODULE_CATALOG[0].id);
        return {consumed:shop.SAR_MODULE_CATALOG[0],chipTotal:(await import('/utils/vrWorld/sarGacha.ts')).SAR_ALL_MODULES.length,moduleTotal:shop.SAR_MODULE_CATALOG.length};
    });
    await page.reload();await enter();await shot('01-titles-room');
    assert.equal(await page.locator('.sar-room-person__title').count(),3);
    for(const person of await page.locator('.sar-room-person:has(.sar-room-person__title)').all()){
        const title=await person.locator('.sar-room-person__title').boundingBox(),name=await person.locator('.sar-room-person__name').boundingBox(),body=await person.locator('.sar-room-person__body').boundingBox();assert(title.y+title.height<body.y+4);assert(name.y>=body.y+body.height-7);
    }
    const signs=await page.locator('.sar-room-hotspot span').first().evaluate(el=>getComputedStyle(el).backgroundColor),names=await page.locator('.sar-room-person__name').first().evaluate(el=>getComputedStyle(el).backgroundColor);assert.notEqual(signs,names);assert.equal(await page.locator('.sar-room-hotspot span').first().evaluate(el=>getComputedStyle(el).color),'rgb(105, 81, 59)');
    const feet=await page.locator('.sar-room-person').evaluateAll(nodes=>nodes.map(n=>[n.dataset.actorId,n.dataset.footX,n.dataset.footY]));
    await button('隱藏房間標記').click();assert.equal(await button('顯示房間標記').getAttribute('aria-pressed'),'true');
    for(const selector of ['.sar-room-person__name','.sar-room-person__title','.sar-room-person__quest','.sar-room-hotspots','.sar-room-roster'])assert.equal(await page.locator(selector+':visible').count(),0,selector);
    assert.equal(await page.getByRole('button',{name:'進入佈告板',exact:true}).count(),0);
    assert.equal(await page.locator('.sar-room-person:visible').count(),feet.length);assert.deepEqual(await page.locator('.sar-room-person').evaluateAll(nodes=>nodes.map(n=>[n.dataset.actorId,n.dataset.footX,n.dataset.footY])),feet);
    assert.equal((await page.evaluate(()=>JSON.parse(window.render_game_to_text()))).sar.labelsHidden,true);await shot('16-hidden-room');
    await page.setViewportSize({width:320,height:680});await shot('17-hidden-small');
    const fit=await page.locator('.sar-hub-identity').boundingBox(),tools=await page.locator('.sar-hub-tools').boundingBox();assert(fit.x+fit.width<=tools.x);assert(tools.x+tools.width<=320);
    await button('活動室設置').click();await page.getByRole('switch',{name:'顯示常駐 NPC'}).waitFor();await button('返回活動室').click();assert.equal(await button('顯示房間標記').count(),1);
    await page.reload();await enter();assert.equal(await button('顯示房間標記').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.sar-room-person__name:visible').count(),0);
    await button('顯示房間標記').focus();await page.keyboard.press('Enter');assert.equal(await button('隱藏房間標記').getAttribute('aria-pressed'),'false');assert.equal(await button('進入佈告板').count(),1);
    await page.reload();await enter();assert.equal(await button('隱藏房間標記').count(),1);await page.setViewportSize({width:390,height:844});
    await button('打開倉庫').click();await page.getByTestId('sar-wallet-balance').waitFor();await shot('02-warehouse');
    await page.getByRole('combobox',{name:'倉庫主人'}).selectOption('atlas-aran');await button('修改彼方稱號').click();await page.getByLabel('彼方稱號',{exact:true}).fill('今天只想摸魚');await shot('03-title-editor');await button('保存稱號').click();await page.waitForFunction(()=>document.querySelector('.sar-title-editor strong')?.textContent==='今天只想摸魚');
    await button('修改彼方稱號').click();await page.getByLabel('彼方稱號',{exact:true}).fill('長'.repeat(13));assert(await button('保存稱號').isDisabled());await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'隨身倉庫'}).count(),1);
    await page.getByRole('combobox',{name:'倉庫主人'}).selectOption('user');await button('修改彼方稱號').click();await page.getByLabel('彼方稱號',{exact:true}).fill('');await button('保存稱號').click();await page.waitForFunction(()=>document.querySelector('.sar-title-editor strong')?.textContent==='還沒有稱號');
    await button('返回活動室').click();assert.equal(await page.locator('[data-actor-id="user"] .sar-room-person__title').count(),0);
    await page.reload();await enter();assert.equal(await page.locator('[data-actor-id="atlas-aran"] .sar-room-person__title').innerText(),'今天只想摸魚');
    await atlas();await shot('04-atlas-overview');
    const state=await page.evaluate(()=>JSON.parse(window.render_game_to_text()));assert.equal(state.mode,'sar-collection');assert.deepEqual(state.progress.map(p=>p.collected),[1,2,4,3]);
    await page.getByRole('button',{name:/^芯片[图圖][鉴鑑] ·/}).click();await shot('05-chips');
    assert.equal(await page.locator('.sar-collection-item').count(),12);await button('下一頁圖鑑').click();assert.equal((await page.evaluate(()=>JSON.parse(window.render_game_to_text()))).page,2);
    await page.getByRole('combobox',{name:'圖鑑收錄狀態'}).selectOption('collected');assert.equal(await page.locator('.sar-collection-item').count(),4);
    await page.getByRole('textbox',{name:'搜索圖鑑'}).fill('肯定不存在的芯片');assert.equal(await page.locator('.sar-collection-item').count(),0);await page.getByRole('textbox',{name:'搜索圖鑑'}).fill('');await page.locator('.sar-collection-item').first().click();await page.locator('.sar-collection-entry').waitFor();await shot('06-chip-detail');
    await page.keyboard.press('Escape');assert.equal(await page.locator('.sar-collection-item').count(),4);await page.keyboard.press('Escape');await page.getByRole('heading',{name:'收集圖鑑',exact:true}).waitFor();
    await page.getByRole('button',{name:/^模[块塊][图圖][鉴鑑] ·/}).click();await shot('07-modules');await button(`${catalog.consumed.title} · 已收錄`).click();assert((await page.locator('.sar-collection-owned').innerText()).includes('當前持有 0 件'));await shot('08-consumed-module');
    await page.getByRole('combobox',{name:'圖鑑主人'}).selectOption('atlas-aran');assert.equal(await page.locator('.sar-collection-entry').count(),0);await page.getByRole('combobox',{name:'圖鑑收錄狀態'}).selectOption('collected');assert.equal(await page.locator('.sar-collection-item').count(),1);assert.equal((await page.evaluate(()=>JSON.parse(window.render_game_to_text()))).ownerId,'atlas-aran');await shot('09-character-modules');
    await page.getByRole('combobox',{name:'圖鑑主人'}).selectOption('atlas-nora');await page.getByRole('combobox',{name:'圖鑑收錄狀態'}).selectOption('collected');assert.equal(await page.locator('.sar-collection-item').count(),0);
    await page.keyboard.press('Escape');await page.getByRole('combobox',{name:'圖鑑主人'}).selectOption('user');await page.getByRole('button',{name:/^[鱼魚][类類][图圖][鉴鑑] ·/}).click();await shot('10-fish');await page.keyboard.press('Escape');await page.getByRole('button',{name:/^恐[龙龍][图圖][鉴鑑] ·/}).click();await shot('11-dinosaurs');
    await page.setViewportSize({width:320,height:680});await shot('12-small-atlas');await page.keyboard.press('Escape');await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'隨身倉庫'}).count(),1);await page.keyboard.press('Escape');await shot('13-small-room');
    // Labels do not collide with facility plaques, even on a small phone.
    const overlap=await page.evaluate(()=>{
        const rect=el=>el.getBoundingClientRect(),labels=[...document.querySelectorAll('.sar-room-person__name,.sar-room-person__title')].map(rect),signs=[...document.querySelectorAll('.sar-room-hotspot span')].map(rect);
        const hits=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
        return labels.some((a,i)=>labels.slice(i+1).some(b=>hits(a,b))||signs.some(b=>hits(a,b)));
    });assert.equal(overlap,false,'room labels overlap');
    await page.setViewportSize({width:1100,height:850});await shot('14-desktop-room');await atlas();await shot('15-desktop-atlas');await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    const visit=async(mode)=>page.evaluate(async(mode)=>{
        const {DB}=await import('/utils/db.ts'),{runVRSession}=await import('/utils/vrWorld/runSession.ts');const characters=await DB.getAllCharacters(),char=characters.find(c=>c.id==='atlas-aran');
        const original=Math.random;Math.random=()=>.705;
        try {const result=await runVRSession({char,characters,userProfile:await DB.getUserProfile(),groups:[],apiConfig:{baseUrl:'http://127.0.0.1:5177/collection-model',apiKey:'fixture',model:'fixture'},forcedRoom:'sar',forcedSARActivity:mode==='fishing'?'fishing':undefined,manual:true,
            updateCharacter:async(id,patch)=>{const current=(await DB.getAllCharacters()).find(c=>c.id===id);await DB.saveCharacter({...current,...(typeof patch==='function'?patch(current):patch)});}});
            return {result,char:(await DB.getAllCharacters()).find(c=>c.id===char.id),others:(await DB.getAllCharacters()).filter(c=>c.id!==char.id),messages:await DB.getRecentMessagesByCharId(char.id,5)};
        } finally {Math.random=original;}
    },mode);
    modelReply='<ACTIVITY>在展示台前看看。</ACTIVITY><BUY>NO</BUY><KANATA_TITLE>貨架觀察員</KANATA_TITLE>';
    let trip=await visit('shop');assert.equal(trip.result.ok,true,JSON.stringify(trip.result));assert.equal(trip.char.vrState.title,'貨架觀察員');assert(prompts.at(-1).includes('今天只想摸魚'));assert(!trip.messages.some(m=>m.content.includes('KANATA_TITLE')));assert.equal(trip.others.find(c=>c.id==='atlas-nora').vrState.title,'雲朵收藏家');
    modelReply='{"disposition":"keep","reaction":"安靜釣完這一竿。","shareToUser":null,"kanataTitle":"水邊常客"}';trip=await visit('fishing');assert.equal(trip.result.ok,true,JSON.stringify(trip.result));assert.equal(trip.char.vrState.title,'水邊常客');assert(prompts.at(-1).includes('貨架觀察員'));
    modelReply='{"reaction":"沒有完整選擇","kanataTitle":"不應保存"}';trip=await visit('fishing');assert.equal(trip.result.ok,false);assert.equal(trip.char.vrState.title,'水邊常客');
    race=true;modelReply='<ACTIVITY>在展示台前看看。</ACTIVITY><BUY>NO</BUY><KANATA_TITLE>過期的提案</KANATA_TITLE>';trip=await visit('shop');assert.equal(trip.result.ok,true);assert.equal(trip.char.vrState.title,'手動的新稱號');assert.equal(trip.char.vrState.sarActivity,'module-shop');race=false;
    modelReply='<KANATA_TITLE>只有稱號沒有活動</KANATA_TITLE>';trip=await visit('shop');assert.equal(trip.result.ok,false);assert.equal(trip.char.vrState.title,'手動的新稱號');
    modelReply='<ACTIVITY>今天不要稱號了。</ACTIVITY><BUY>NO</BUY><KANATA_TITLE></KANATA_TITLE>';trip=await visit('shop');assert.equal(trip.result.ok,true);assert.equal(trip.char.vrState.title,'');
    assert.deepEqual(errors,[]);writeFileSync(`${out}/result.json`,JSON.stringify({passed:true,errors,modelCalls,collectionProgress:state.progress,manualRacePreserved:true},null,2));console.log('Collection atlas + titles: real UI, durable ownership history, nested back, owner isolation, phone/desktop labels, and 6 mocked activity calls passed.');
} finally {await browser.close();}
