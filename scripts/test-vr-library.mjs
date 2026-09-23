import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
await mkdir('output/vr-library',{recursive:true});
const browser=await chromium.launch({headless:true});
try {
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:5177/test/fixtures/kanata.html');
    await page.getByRole('button',{name:'書庫',exact:true}).waitFor();
    await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts');
        // This is a fresh Playwright context; the app may already have seeded its default character.
        await DB.saveCharacter({id:'qa-reader',name:'閱讀測試',avatar:'',systemPrompt:'QA',vrState:{enabled:true,activityMode:'manual',intervalMinutes:120,novelBookmarks:{'qa-0':1}}});
        for(let i=0;i<26;i++)await DB.saveVRNovel({id:`qa-${i}`,title:`舊書 ${String(i).padStart(2,'0')}`,author:'測試作者',segments:[{idx:0,text:'舊書正文不變。',chars:8}],totalChars:8,createdAt:1,updatedAt:1});
        await DB.saveVRAnnotation({id:'qa-annotation',novelId:'qa-0',segIdx:0,authorId:'qa-reader',authorName:'閱讀測試',content:'這條批註要保留。',createdAt:1});
    });
    await page.reload();
    const btn=name=>page.getByRole('button',{name,exact:true});
    await btn('書庫').click();
    const lib=page.getByRole('region',{name:'彼方書庫'});
    await lib.getByText('舊書 00',{exact:true}).waitFor();
    await btn('分類').click();
    await page.getByLabel('分類名稱',{exact:true}).fill('網文');await btn('新建分類').click();
    await page.locator('.vrl-category-row').filter({hasText:'網文'}).waitFor();
    await page.getByLabel('分類名稱',{exact:true}).fill('嚴肅文學');await btn('新建分類').click();
    await page.locator('.vrl-category-row').filter({hasText:'嚴肅文學'}).waitFor();
    await btn('分類').click();await btn('整理').click();
    await btn('選擇本頁').click();
    await page.getByLabel('移入分類',{exact:true}).selectOption({label:'網文'});await btn('移入分類').click();
    await page.getByText('已選 0 本',{exact:true}).waitFor();
    await btn('整理').click();
    const categories=page.getByRole('navigation',{name:'書籍分類'});
    await categories.getByRole('button',{name:/^[网網]文/}).click();
    assert.equal(await page.locator('.vrl-book').count(),12);
    await page.locator('.vrl-readers summary').click();
    await page.locator('.vrl-reader-list').getByRole('button',{name:/[阅閱][读讀][测測][试試]/}).click();
    await btn('按分類').click();
    await page.locator('.vrl-preference-list').getByRole('button',{name:/^[网網]文/}).click();
    await page.screenshot({path:'output/vr-library/02-preference.png'});
    await btn('保存偏好').click();
    await page.waitForFunction(async()=>{const {DB}=await import('/utils/db.ts');return (await DB.getAllCharacters()).find(c=>c.id==='qa-reader')?.vrState?.novelReadingMode==='categories';});
    // New imports inherit the active category; no second character preference edit.
    await btn('上架').click();
    assert.equal(await page.getByLabel('上架書籍分類').locator('option:checked').innerText(),'網文');
    await page.getByPlaceholder('書名（必填）').fill('新歸入的小說');
    await page.getByPlaceholder('粘貼正文…').fill('新書正文。今晚的小鎮下著雨，街角亮起一盞燈。');
    await btn('上架到書庫').click();
    await page.waitForFunction(async()=>{const {DB}=await import('/utils/db.ts');return (await DB.getVRNovels()).some(n=>n.title==='新歸入的小說');});
    const snapshot=await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts'),{readableNovels}=await import('/utils/vrWorld/library.ts');
        const books=await DB.getVRNovels(),c=(await DB.getAllCharacters()).find(c=>c.id==='qa-reader');
        return {categories:await DB.getVRLibraryCategories(),eligible:readableNovels(books,c).map(n=>n.title),annotations:await DB.getVRAnnotations('qa-0'),bookmark:c.vrState.novelBookmarks['qa-0']};
    });
    assert(snapshot.eligible.includes('新歸入的小說'));assert.equal(snapshot.eligible.length,13);assert.equal(snapshot.annotations[0].content,'這條批註要保留。');assert.equal(snapshot.bookmark,1);
    await btn('分類').click();
    await page.locator('.vrl-category-row').filter({hasText:'網文'}).getByRole('button',{name:'重命名'}).click();
    await page.getByLabel('分類名稱',{exact:true}).fill('網絡小說');await btn('保存名稱').click();
    await page.locator('.vrl-category-row').filter({hasText:'網絡小說'}).waitFor();
    await btn('分類').click();await page.reload();await btn('書庫').click();
    await categories.getByRole('button',{name:/^[网網][络絡]小[说說]/}).click();
    assert.equal(await page.locator('.vrl-book').count(),12);
    await page.screenshot({path:'output/vr-library/01-library.png'});
    for(const [width,height] of [[320,568],[844,390]]){
        await page.setViewportSize({width,height});
        await page.evaluate(()=>{document.documentElement.style.setProperty('--chrome-top','59px');document.documentElement.style.setProperty('--safe-bottom','34px');});
        await page.locator('.vrl-readers summary').click();
        await page.locator('.vrl-reader-list').getByRole('button',{name:/[阅閱][读讀][测測][试試]/}).click();
        const close=btn('關閉閱讀偏好'),box=await close.boundingBox();assert(box.y>=59&&box.y+box.height<height);
        const save=await btn('保存偏好').boundingBox();assert(save.y+save.height<=height-34);
        await page.screenshot({path:`output/vr-library/preference-${width}.png`});await close.click();
        await page.locator('.vrl-readers summary').click();
    }
    // Both the category registry and book assignments participate in the existing backup format.
    const backup=await page.evaluate(async()=>{const {DB}=await import('/utils/db.ts');const b=await DB.exportFullData();return {categories:b.vrSettings.find(x=>x.id==='library-categories-v1'),book:b.vrNovels.find(x=>x.title==='新歸入的小說'),char:b.characters.find(x=>x.id==='qa-reader')};});
    assert.equal(backup.categories.categories.find(x=>x.id===snapshot.categories[0].id).name,'網絡小說');
    assert.equal(backup.book.categoryId,backup.char.vrState.preferredNovelCategoryIds[0]);
    // Removing a category moves its books to Uncategorized and never widens reading scope.
    await btn('分類').click();await page.locator('.vrl-category-row').filter({hasText:'網絡小說'}).getByRole('button',{name:'移除分類'}).click();
    await page.waitForFunction(async()=>{const {DB}=await import('/utils/db.ts');return !(await DB.getVRLibraryCategories()).some(c=>c.name==='網絡小說');});
    const empty=await page.evaluate(async()=>{const {DB}=await import('/utils/db.ts'),{readableNovels}=await import('/utils/vrWorld/library.ts');return readableNovels(await DB.getVRNovels(),(await DB.getAllCharacters()).find(c=>c.id==='qa-reader')).length;});assert.equal(empty,0);
    assert.deepEqual(errors,[]);
    console.log('PASS categories, bulk move, preferences, new upload inheritance, bookmark/annotation preservation, rename/reload, backup, category removal and mobile safe area.');
} finally {await browser.close();}
