import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = 'output/sar-exclusive-keepsakes'; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
await context.addInitScript(() => localStorage.setItem('sar-facility-guide-warehouse-v1', 'done'));
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.fulfill({ status: 200, body: '', headers: { 'access-control-allow-origin': '*' } }));
const button = name => page.getByRole('button', { name, exact: true });
const shot = name => page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
try {
    await page.goto(`${process.env.SAR_QA_URL || 'http://127.0.0.1:5173'}/test/fixtures/sar-facilities.html?facility=warehouse`);
    await page.waitForFunction(() => window.facilityQA?.os.characters.length >= 60);
    await button('打開收集圖鑑').click();
    await page.evaluate(()=>window.originalCollectionTabs=document.querySelector('.sar-collection-sections'));
    const checkTabs=async selected=>{
        const nav=page.getByRole('navigation',{name:'圖鑑頁面'});
        assert.deepEqual(await nav.getByRole('button').allTextContents(),['收藏','專屬紀念','名冊']);
        assert.equal(await nav.locator('[aria-current="page"]').textContent(),selected);
        assert.equal(await page.evaluate(()=>window.originalCollectionTabs===document.querySelector('.sar-collection-sections')),true);
        assert.equal(await page.locator('.sar-hub-panel header').count(),1);
    };
    for(const tab of ['名冊','收藏','專屬紀念']){await button(tab).click();await checkTabs(tab);}
    await page.getByText('這一頁，先為你留著', { exact: true }).waitFor();
    assert.equal(await page.locator('.sar-exclusive-item').count(), 0);
    await page.evaluate(async () => {
        const m = await import('/utils/vrWorld/fishingMarket.ts');
        const { freshFamiliarity } = await import('/utils/vrWorld/sarFamiliarity/storageTypes.ts');
        const { FAMILIARITY_SCENES, familiarityText } = await import('/utils/vrWorld/sarFamiliarity/catalog.ts');
        const souvenirs = FAMILIARITY_SCENES.flatMap(scene => Object.entries(scene.nodes).flatMap(([nodeId, node]) => (node.rewards || []).filter(r => r.kind === 'souvenir').map(reward => ({ id: reward.id, title: reward.title, description: familiarityText(reward.description, '雨眠'), npc: scene.npc, sceneId: scene.id, nodeId, at: Date.now(), userName: '雨眠', flags: {}, draft: { date: '2026/9/11', caption: '保存下來的會議合影' } }))));
        await m.mutateFishingMarket(state => m.addCatchToState({ ...state, sarFamiliarity: { ...freshFamiliarity(), souvenirs } }, { id: 'qa-chimera', speciesId: 'aiven-chimera', ownerId: 'user', ownerName: '雨眠', caughtAt: Date.now(), sizeCm: 12, quality: 3, weather: 'clear', weatherLabel: '晴朗', weatherSource: 'simulated' }));
        window.realKeepsakes = souvenirs;
    });
    await page.locator('.sar-exclusive-item').first().waitFor(); await shot('shelf');
    const before = await page.evaluate(() => localStorage.getItem('vr_fishing_market_v1'));
    await page.locator('.sar-exclusive-item').filter({ hasText: '第一次 SAR 會議' }).click();
    await button('看看背面').click(); await page.getByText('寫在照片背面', { exact: true }).waitFor();
    await checkTabs('專屬紀念');await shot('saved-photo'); await page.keyboard.press('Escape');
    await button('艾文').click();
    assert.equal(await page.locator('.sar-exclusive-item').filter({ hasText: '凱恩 · 專屬贈禮' }).count(), 0);
    await page.locator('.sar-exclusive-item').filter({ hasText: '？？？' }).click();
    await page.getByText('已經放在你的恐龍收藏裡，可以去箱庭單獨起名、換色和擺放。', { exact: true }).waitFor();
    await shot('exclusive-dinosaur'); await button('返回專屬紀念').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('vr_fishing_market_v1')), before, 'reading souvenirs does not grant anything or modify their originals');
    await page.evaluate(async () => {
        const m = await import('/utils/vrWorld/fishingMarket.ts');
        await m.mutateFishingMarket(s => ({ ...s, sarFamiliarity: { ...s.sarFamiliarity, souvenirs: [...window.realKeepsakes, ...Array.from({ length: 17 }, (_, i) => ({ ...window.realKeepsakes[0], id: `qa-page-${i}`, title: `分頁紀念 ${i + 1}`, at: 1 }))] } }));
    });
    await button('全部').click(); assert.equal(await page.locator('.sar-exclusive-item').count(), 12);
    await button('專屬紀念下一頁').click();
    assert((await page.locator('.sar-exclusive-item').count()) <= 12);
    await page.evaluate(async () => {
        const m = await import('/utils/vrWorld/fishingMarket.ts');
        await m.mutateFishingMarket(s => ({ ...s, sarFamiliarity: { ...s.sarFamiliarity, souvenirs: window.realKeepsakes } }));
        const backup = await import('/utils/vrWorld/sarBackup.ts');
        const saved = backup.collectSARLocalBackup(); backup.restoreSARLocalBackup(saved, { replaceMissing: true });
    });
    await button('凱恩').click(); await page.setViewportSize({ width: 320, height: 640 });
    await shot('shelf-320'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    for(const tab of ['名冊','收藏','專屬紀念']){await button(tab).click();await checkTabs(tab);await shot('tabs-'+tab+'-320');}
    await page.keyboard.press('Escape');await button('打開收集圖鑑').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    writeFileSync(`${out}/report.json`, JSON.stringify({ earnedOnly: true, photoReplay: true, exclusiveDinosaur: true, noRewardReplay: true, npcFilter: true, pagination: true, backupRestore: true, mobile320: true, errors }, null, 2));
    console.log('Exclusive keepsakes passed: earned items, saved photo, special dinosaur, pagination, return navigation and backup.');
} finally { await browser.close(); }
