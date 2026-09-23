import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
mkdirSync('output/appearance-rescue', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
const errors = []; page.on('pageerror', e => errors.push(e.message));
const button = name => page.getByRole('button', { name, exact: true });
const read = () => page.evaluate(async () => {
    const { DB } = await import('/utils/db.ts');
    return { theme: JSON.parse(localStorage.getItem('os_theme')), char: (await DB.getAllCharacters()).find(c => c.id === 'qa-rescue'),
        preset: await DB.getAsset('appearance_preset_qa-rescue'), messages: await DB.getMessagesByCharId('qa-rescue', true) };
});
try {
    await page.goto('http://127.0.0.1:5183/test/fixtures/appearance-rescue.html');
    await page.getByRole('heading', { name: '系統設置', exact: true }).waitFor();
    await page.evaluate(async () => {
        const { DB } = await import('/utils/db.ts');
        await DB.saveCharacter({ id: 'qa-rescue', name: '測試角色', avatar: '', systemPrompt: '保留人設', chromeCustomCss: '.sully-chat-name { color: red; }' });
        await DB.saveMessage({ charId: 'qa-rescue', role: 'user', type: 'text', content: '保留聊天記錄' });
        await DB.saveAsset('appearance_preset_qa-rescue', JSON.stringify({ id: 'qa-rescue', name: '保留預設', createdAt: 1, theme: { hue: 123 } }));
        localStorage.setItem('os_theme', JSON.stringify({ hue: 123, chatChromeCustomCss: '.sully-chat-inputbar { color: red; }', journalAppearance: { preset: 'original', customCss: '.journal { color: red; }' } }));
    });
    await page.reload();
    await page.getByRole('button', { name: /^外[观觀]急救/ }).click();
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: '外觀急救', exact: true }) });
    assert.equal(await page.locator('section').first().innerText(), await section.innerText(), 'rescue stays first');
    const before = await read();
    const chrome = button('一鍵還原全部聊天白框美化（救援）');
    page.once('dialog', dialog => dialog.dismiss()); await chrome.click();
    assert.deepEqual(await read(), before, 'cancel chrome reset changes nothing');
    page.once('dialog', dialog => dialog.accept()); await chrome.click();
    await page.waitForFunction(async () => { const { DB } = await import('/utils/db.ts'); return !(await DB.getAllCharacters()).find(c => c.id === 'qa-rescue').chromeCustomCss; });
    const cleared = await read();
    assert.equal(cleared.theme.chatChromeCustomCss, ''); assert.equal(cleared.theme.hue, 123);
    assert.deepEqual(cleared.theme.journalAppearance, before.theme.journalAppearance);
    assert.deepEqual(cleared.messages, before.messages); assert.equal(cleared.preset, before.preset);
    await button('還原為初始外觀').click();
    assert.deepEqual(await read(), cleared, 'first reset click only opens confirmation');
    await button('取消').click(); assert.deepEqual(await read(), cleared);
    await page.screenshot({ path: 'output/appearance-rescue/settings-390.png' });
    await button('還原為初始外觀').click(); await button('確認還原').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('os_theme')).hue !== 123);
    const reset = await read();
    assert.equal(reset.preset, before.preset); assert.deepEqual(reset.messages, before.messages);
    assert.equal(reset.char.systemPrompt, '保留人設');
    await button('QA 外觀').click(); await button('外觀預設').click();
    assert.equal(await button('還原為初始外觀').count(), 0);
    await button('聊天界面').click(); assert.equal(await chrome.count(), 0);
    await button('QA 設置').click(); await page.getByRole('button', { name: /^外[观觀]急救/ }).click();
    await page.setViewportSize({ width: 320, height: 740 });
    await page.screenshot({ path: 'output/appearance-rescue/settings-320.png' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS: settings first section contains rescue actions, old appearance actions removed; cancel, scoped CSS reset and full appearance reset preserve messages/presets.');
} catch (error) { await page.screenshot({ path: 'output/appearance-rescue/failure.png' }); throw error; }
finally { await browser.close(); }
