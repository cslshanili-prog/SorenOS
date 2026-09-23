import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const out='output/fishing-qa/mobile';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const read=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')));
const screenshot=async name=>{await page.screenshot({path:`${out}/${name}.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow');};
try{
    await page.goto((process.env.FISHING_QA_URL||'http://127.0.0.1:5177')+'/test/fixtures/fishing.html');
    await page.getByRole('button',{name:'拋竿',exact:true}).waitFor();
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.fishing-shell')).position==='fixed');
    await screenshot('01-water');
    await page.getByRole('button',{name:'拋竿',exact:true}).click();await page.evaluate(()=>window.advanceTime(0));
    for(let i=0;i<320;i++){
        const s=await page.evaluate(()=>JSON.parse(window.render_game_to_text()));
        if(s.phase==='caught'||s.phase==='escaped')break;
        const delta=Math.atan2(Math.sin(s.fishAngle-s.playerAngle-s.playerVelocity*.1),Math.cos(s.fishAngle-s.playerAngle-s.playerVelocity*.1));
        if(delta>0)await page.keyboard.down('Space');else await page.keyboard.up('Space');
        await page.evaluate(()=>window.advanceTime(90));
    }
    await page.keyboard.up('Space');await page.waitForFunction(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')).inventory.length===1);
    assert.equal(await page.evaluate(()=>JSON.parse(window.render_game_to_text()).phase),'caught');await screenshot('02-caught');
    await page.getByRole('button',{name:'再釣一次',exact:true}).click();await page.getByRole('button',{name:'收竿',exact:true}).click();assert.equal((await read()).inventory.length,1);
    await page.getByRole('button',{name:'再釣一次',exact:true}).click();await page.evaluate(()=>window.advanceTime(35000));assert.equal(await page.evaluate(()=>JSON.parse(window.render_game_to_text()).phase),'escaped');assert.equal((await read()).inventory.length,1);await screenshot('03-escaped');
    await page.keyboard.press('f');await page.waitForFunction(()=>!!document.fullscreenElement);await page.keyboard.press('f');await page.waitForFunction(()=>!document.fullscreenElement);
    await page.getByRole('button',{name:'圖鑑',exact:true}).click();await screenshot('04-catalog');
    await page.getByRole('button',{name:/cm/}).first().click();await page.getByRole('button',{name:'自己定價掛板',exact:true}).click();
    await page.getByLabel('金額',{exact:true}).fill('0');await page.getByLabel('便箋正文').fill('你們到底想幹嘛！！');await page.getByLabel('匿名筆名').fill('神秘交易員');await page.getByRole('button',{name:'貼上佈告板',exact:true}).click();
    await page.getByRole('dialog',{name:'彼方佈告板',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'圖鑑',exact:true}).count(),0);
    await page.getByRole('button',{name:/出售 ·/}).first().click();await page.getByLabel('回覆或交付內容').fill('？？？');await page.getByRole('button',{name:'回覆',exact:true}).click();
    await screenshot('05-listing-comments');await page.getByRole('button',{name:'撤下並存檔',exact:true}).click();await page.getByRole('button',{name:'關閉詳情'}).click();
    await page.getByRole('button',{name:'檔案',exact:true}).click();assert.equal((await read()).listings[0].status,'removed');await screenshot('06-archive');
    // Fixtures exercise UI payment paths without model calls or user data.
    await page.evaluate(async()=>{
        const m=await import('/utils/vrWorld/fishingMarket.ts');const seller={id:'wanderer:qa',name:'測試路人',kind:'wanderer'};
        await m.mutateFishingMarket(s=>m.createListing(m.ensureActorAccounts(s,[seller]),seller,null,0,'今日空氣免費',Date.now(),'一口空氣'));
        await m.mutateFishingMarket(s=>m.createRequest(s,seller,undefined,'給我錢',30,'居然真有人給錢嗎',Date.now(),'tip'));
    });
    await page.getByRole('button',{name:'佈告板',exact:true}).click();await page.getByRole('button',{name:'掛板出售',exact:true}).click();await page.getByRole('button',{name:/出售 · 一口空[气氣]/}).click();await page.getByRole('button',{name:'買下',exact:true}).click();await page.getByRole('button',{name:'關閉詳情'}).click();
    await page.getByRole('button',{name:'需求區',exact:true}).click();await page.getByRole('button',{name:/求打[赏賞] · [给給]我[钱錢]/}).click();await page.getByRole('button',{name:'給 ta 鱗幣',exact:true}).click();assert.equal((await read()).accounts.user,970);await screenshot('07-tip-paid');await page.getByRole('button',{name:'關閉詳情'}).click();
    await page.reload();await page.getByRole('button',{name:'拋竿',exact:true}).waitFor();assert.equal((await read()).accounts.user,970);
    await page.evaluate(async()=>{const m=await import('/utils/vrWorld/fishingMarket.ts');await m.mutateFishingMarket(s=>({...s,discovered:m.FISH_CATALOG.map(f=>f.id)}));});
    await page.getByRole('button',{name:'圖鑑',exact:true}).click();await page.getByRole('heading',{name:'水域圖鑑'}).scrollIntoViewIfNeeded();await screenshot('08-fish-art');
    await page.setViewportSize({width:320,height:740});await screenshot('09-small-screen');
    const saved=await read();
    await page.goto((process.env.FISHING_QA_URL||'http://127.0.0.1:5177')+'/test/fixtures/fishing.html?entry=board');
    await page.getByRole('button',{name:'魚類行情',exact:true}).waitFor();
    await page.waitForFunction(()=>JSON.parse(window.render_game_to_text()).boardTab==='prices');
    assert.equal((await read()).accounts.user,970);assert.deepEqual((await read()).inventory,saved.inventory);
    assert.equal(await page.getByRole('button',{name:'拋竿',exact:true}).count(),0);await screenshot('10-board-direct');
    writeFileSync(`${out}/result.json`,JSON.stringify({errors,state:await read()},null,2));assert.deepEqual(errors,[]);console.log('Fishing mobile UI: catch/cancel/escape/fullscreen/catalog/list/comment/archive/buy/tip/persistence passed.');
}finally{await browser.close();}
