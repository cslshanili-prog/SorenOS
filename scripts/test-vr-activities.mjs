import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
await mkdir('output/vr-activities',{recursive:true});
const browser=await chromium.launch({headless:true});
try{
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:5177/test/fixtures/kanata.html');
    const button=name=>page.getByRole('button',{name,exact:true});
    await button('接入').waitFor();
    await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts');
        await DB.saveCharacter({id:'qa-activity',name:'活動測試',avatar:'',systemPrompt:'QA',vrState:{enabled:true,activityMode:'manual',intervalMinutes:120}});
        await DB.saveVRNovel({id:'qa-activity-book',title:'活動讀物',segments:[{idx:0,text:'正文',chars:2}],totalChars:2,createdAt:1,updatedAt:1});
    });
    await page.reload();await button('接入').click();
    const card=page.locator('[data-vr-character="qa-activity"]');
    await card.waitFor();await card.locator('.vra-restrictions summary').click();
    await card.getByLabel('不自動玩抽芯片演繹',{exact:true}).check();
    await card.getByLabel('不自動去整個SAR活動室',{exact:true}).check();
    assert(await card.getByLabel('不自動玩模塊商店',{exact:true}).isDisabled());
    await card.getByLabel('不自動去整個SAR活動室',{exact:true}).uncheck();
    assert(await card.getByLabel('不自動玩抽芯片演繹',{exact:true}).isChecked());
    assert(!(await card.getByLabel('不自動玩模塊商店',{exact:true}).isChecked()));
    for(const room of ['圖書館','劇院','聽歌房','留言簿','娛樂室','郵局'])await card.getByLabel(`不自動去${room}`,{exact:true}).check();
    await card.getByLabel('不自動去整個SAR活動室',{exact:true}).check();
    await card.getByRole('status').filter({hasText:'全部自動活動已排除'}).waitFor();
    await page.screenshot({path:'output/vr-activities/03-restrictions.png'});
    const saved=await page.evaluate(async()=>{const{DB}=await import('/utils/db.ts');return(await DB.getAllCharacters()).find(c=>c.id==='qa-activity').vrState;});
    assert.equal(saved.excludedAutoRooms.length,7);assert.deepEqual(saved.excludedAutoSARActivities,['cabinet']);
    await page.reload();await button('接入').click();await card.locator('.vra-restrictions summary').click();
    assert(await card.getByLabel('不自動去整個SAR活動室',{exact:true}).isChecked());
    // Capture UI routing without calling a model. Scheduler forwarding is separately unit-tested.
    await page.evaluate(()=>{window.activityCalls=[];window.kanataQA.scheduler.triggerNow=(...args)=>window.activityCalls.push(args);});
    const open=()=>card.getByRole('button',{name:'讓 ta 現在去逛一次',exact:true}).click();
    await open();const modal=page.getByRole('dialog',{name:'邀請活動測試活動'});
    await modal.waitFor();await page.screenshot({path:'output/vr-activities/01-groups.png'});
    assert.equal(await modal.locator('main > button').count(),2);
    await modal.getByRole('button',{name:/^普通空[间間]/}).click();
    assert.equal(await modal.locator('main > button').count(),6);
    await button('返回活動分類').click();await modal.getByRole('button',{name:/^SAR 活[动動]室/}).click();
    assert.equal(await modal.locator('main > button').count(),5);
    assert(await modal.getByRole('button',{name:/^恐[龙龍]箱庭/}).isDisabled());
    await page.keyboard.press('Escape');assert.equal(await modal.locator('main > button').count(),2);
    await button('關閉活動選擇').click();
    await page.evaluate(async()=>{
        const{readFishingMarketState,saveFishingMarketState}=await import('/utils/vrWorld/fishingMarket.ts');
        const{ensureDinosaurGarden,setGardenVisits}=await import('/utils/vrWorld/dinosaurGarden.ts');
        const user={id:'user',name:'測試用戶',kind:'user'};
        saveFishingMarketState(setGardenVisits(ensureDinosaurGarden(readFishingMarketState(),user),true,user));
    });
    const activities=[['抽芯片演繹','cabinet'],['模塊商店','module-shop'],['水域釣魚','fishing'],['佈告板','market'],['恐龍箱庭','garden']];
    for(const [label,id] of activities){await open();await modal.getByRole('button',{name:/^SAR 活[动動]室/}).click();await modal.getByRole('button',{name:new RegExp('^'+label)}).click();assert.deepEqual((await page.evaluate(()=>window.activityCalls)).at(-1),['qa-activity','sar',undefined,id]);await modal.waitFor({state:'detached'});}
    // Manual ordinary invitations also remain enabled despite automatic exclusion.
    await open();await modal.getByRole('button',{name:/^普通空[间間]/}).click();await modal.getByRole('button',{name:/^[图圖][书書][馆館]/}).click();assert.deepEqual((await page.evaluate(()=>window.activityCalls)).at(-1),['qa-activity','library',undefined,undefined]);
    for(const [width,height,top] of [[390,844,83],[320,568,59],[844,390,24]]){
        await page.setViewportSize({width,height});await page.evaluate(top=>{document.documentElement.style.setProperty('--chrome-top',`${top}px`);document.documentElement.style.setProperty('--safe-bottom','34px');},top);
        await open();await modal.getByRole('button',{name:/^SAR 活[动動]室/}).click();
        const back=await button('返回活動分類').boundingBox(),random=await button('在活動室隨便玩一樣').boundingBox();assert(back.y>=top);assert(random.y+random.height<=height-34);
        await page.screenshot({path:`output/vr-activities/02-sar-${width}.png`});
        await button('返回活動分類').click();await button('關閉活動選擇').click();
    }
    const backup=await page.evaluate(async()=>{const{DB}=await import('/utils/db.ts');return(await DB.exportFullData()).characters.find(c=>c.id==='qa-activity').vrState;});assert.deepEqual(backup.excludedAutoRooms,saved.excludedAutoRooms);
    await card.getByRole('button',{name:'恢復全部可去',exact:true}).click();
    await page.waitForFunction(async()=>{const{DB}=await import('/utils/db.ts');const c=(await DB.getAllCharacters()).find(c=>c.id==='qa-activity');return !c.vrState.excludedAutoRooms.length&&!c.vrState.excludedAutoSARActivities.length;});
    // Exercise the real UI -> scheduler -> OSContext -> runSession chain with a local fake model.
    let modelMode='module-shop';const requests=[];
    await page.route('**/qa-activity-api/**',async route=>{
        requests.push(JSON.parse(route.request().postData()));
        const content=modelMode==='module-shop'?'<ACTIVITY>研究了模塊。</ACTIVITY><NOTE>這次只看不買。</NOTE><BUY>NO</BUY><USE_ON_USER>NO</USE_ON_USER>':JSON.stringify({title:'手動芯片檢查',story:'芯片只用來演繹這一場。',notes:'記下了這次推演。'});
        await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{role:'assistant',content}}]})});
    });
    await page.evaluate(async()=>{
        const{DB}=await import('/utils/db.ts');const c=(await DB.getAllCharacters()).find(c=>c.id==='qa-activity');
        await DB.saveCharacter({...c,memoryPalaceEnabled:false,vrState:{...c.vrState,excludedAutoRooms:['sar'],api:{baseUrl:'http://127.0.0.1:5177/qa-activity-api/v1',apiKey:'qa-local',model:'qa'}}});
    });
    await page.reload();await button('接入').click();
    for(const [label,mode,meta] of [['模塊商店','module-shop','sarModuleShop'],['抽芯片演繹','cabinet','sarCabinetNote']]){
        modelMode=mode;await open();await modal.getByRole('button',{name:/^SAR 活[动動]室/}).click();await modal.getByRole('button',{name:new RegExp('^'+label)}).click();
        await page.waitForFunction(async meta=>{const{DB}=await import('/utils/db.ts');return(await DB.getVRCardsByCharId('qa-activity')).some(m=>m.metadata?.[meta]);},meta);
    }
    assert.equal(requests.length,2);assert(requests[0].messages.some(m=>typeof m.content==='string'&&m.content.includes('此刻只在模塊商店')));
    assert.deepEqual(errors,[]);console.log('PASS two-level menu, all five SAR routes, ordinary invitation, unavailable garden, exclusions persistence/inheritance/reset/backup, keyboard return, portrait/landscape safe areas.');
}finally{await browser.close();}
