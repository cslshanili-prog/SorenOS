import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DB, openDB } from './db';
import { optimizeResourceStorage, OPTIMIZE_TARGET_STORES } from './storageOptimize';
import { REF_SOURCE_STORES, runBlobGc } from './blobGc';
import { isBlobRef, getBlobForRef, dataUrlToBlob, putImageBlob, clearContentMemo } from './blobRef';
import { blobStore } from './blobStore';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';
import { ChatPrompts } from './chatPrompts';
import { buildGroupHistoryBlock } from './groupChat/prompts';

// fake-indexeddb 已通過 test-setup.ts 注入。
// 這組用例釘「優化資源存儲」的安全邊界：只轉已接令牌鏈路的面、原值失敗保留、
// 冪等可重跑、目標表必須在 GC 引用面清單內（否則轉出的 Blob 會被 GC 當孤兒刪）。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// 字節內容隨意（沒人校驗 jpeg 魔數），要的只是「另一份不同的 data URL」
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';
// 第三張不同內容的圖：氣泡主題一側就有三個圖片字段，兩張不夠擺
const TINY_GIF = 'data:image/gif;base64,BwgJCgsM';

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

beforeEach(async () => {
    // 清庫範圍跟著覆蓋面走：收了新表這裡自動跟上，不用手工維護第二份清單
    for (const s of [...new Set([...OPTIMIZE_TARGET_STORES, 'story_theater_masks', 'blob_assets', 'memory_vectors'])]) {
        await clearStore(s);
    }
    localStorage.clear();
    // 內容記憶是模塊級的，不清會讓上一條用例存的令牌被這條複用，斷言全亂
    clearContentMemo();
});

/** 直接往某張表裡塞幾行（繞開 DB 的各種便捷寫入口，形狀隨便造）。 */
async function seedStore(name: string, records: any[]): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        const store = tx.objectStore(name);
        for (const r of records) store.put(r);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function blobBytes(token: string): Promise<Uint8Array> {
    const blob = await getBlobForRef(token);
    expect(blob).not.toBeNull();
    return new Uint8Array(await blob!.arrayBuffer());
}

describe('優化資源存儲（一次性批量遷移）', () => {
    it('壁紙 assets 行轉成令牌，Blob 字節與原圖逐一致', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const r = await optimizeResourceStorage();

        const stored = await DB.getAsset('wallpaper');
        expect(isBlobRef(stored)).toBe(true);
        expect(await blobBytes(stored!)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
        expect(r.bytesBefore).toBe(TINY_PNG.length);
        expect(r.bytesAfter).toBeGreaterThan(0);
    });

    it('同一張圖多處引用：全部換成同一令牌，只建一個 Blob', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveCharacter({
            id: 'c1', name: '測試角色',
            roomConfig: { wallImage: TINY_PNG, floorImage: TINY_JPEG, items: [{ id: 'i1', image: TINY_PNG }] },
        } as any);

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(4);   // wallpaper + wallImage + item + floorImage
        expect(r.uniqueBlobs).toBe(2); // TINY_PNG 一個、TINY_JPEG 一個

        const wallpaperToken = await DB.getAsset('wallpaper');
        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(c.roomConfig.wallImage).toBe(wallpaperToken);
        expect(c.roomConfig.items[0].image).toBe(wallpaperToken);
        expect(isBlobRef(c.roomConfig.floorImage)).toBe(true);
        expect(c.roomConfig.floorImage).not.toBe(wallpaperToken);
    });

    it('songs 封面與捏人器部件（canonical 鏈路）都轉成可解析令牌', async () => {
        await DB.saveSong({ id: 's1', title: '測試曲', coverImage: TINY_JPEG } as any);
        await DB.saveCustomCreatorPart({ id: 'p1', src: TINY_PNG, shadowSrc: TINY_JPEG } as any);

        await optimizeResourceStorage();

        const song = (await DB.getAllSongs()).find(s => s.id === 's1') as any;
        expect(isBlobRef(song.coverImage)).toBe(true);
        expect(await blobBytes(song.coverImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));

        const part = (await DB.getCustomCreatorParts()).find(p => p.id === 'p1') as any;
        expect(isBlobRef(part.src)).toBe(true);
        expect(isBlobRef(part.shadowSrc)).toBe(true);
        expect(await blobBytes(part.src)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
    });

    it('外觀預設 JSON：壁紙/圖標轉令牌，其餘字段原樣、JSON 結構完好', async () => {
        const preset = {
            id: 'ap1', name: '我的預設', createdAt: 1,
            theme: { wallpaper: TINY_PNG, darkMode: true },
            customIcons: { chat: TINY_JPEG },
        };
        await DB.saveAsset('appearance_preset_ap1', JSON.stringify(preset));

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(2);

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap1'))!);
        expect(isBlobRef(stored.theme.wallpaper)).toBe(true);
        expect(isBlobRef(stored.customIcons.chat)).toBe(true);
        expect(stored.name).toBe('我的預設');
        expect(stored.theme.darkMode).toBe(true);
    });

    it('卡片消息：content 和 metadata.scoreCard 兩份副本一起轉（讀端優先讀後者）', async () => {
        await seedStore('messages', [{
            id: 101, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ type: 'anniv520_card', charAvatar: TINY_PNG, photoDataUrl: TINY_JPEG, title: '心動瞬間' }),
            metadata: { scoreCard: { type: 'anniv520_card', charAvatar: TINY_PNG, photoDataUrl: TINY_JPEG, title: '心動瞬間' } },
        }]);

        await optimizeResourceStorage();

        const [m]: any = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        const card = JSON.parse(m.content);
        expect(isBlobRef(card.charAvatar)).toBe(true);
        expect(isBlobRef(card.photoDataUrl)).toBe(true);
        expect(isBlobRef(m.metadata.scoreCard.charAvatar)).toBe(true);
        expect(isBlobRef(m.metadata.scoreCard.photoDataUrl)).toBe(true);
        expect(card.title).toBe('心動瞬間');
    });

    it('雷區守衛：卡片 JSON 裡的 520 手辦圖不能被順手轉走', async () => {
        await seedStore('messages', [{
            id: 102, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ charAvatar: TINY_PNG, charChibi: { dataUrl: TINY_JPEG } }),
            metadata: { scoreCard: { charAvatar: TINY_PNG, charChibi: { dataUrl: TINY_JPEG } } },
        }]);

        await optimizeResourceStorage();

        const [m]: any = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        expect(isBlobRef(JSON.parse(m.content).charAvatar)).toBe(true);
        expect(JSON.parse(m.content).charChibi.dataUrl).toBe(TINY_JPEG);
        expect(m.metadata.scoreCard.charChibi.dataUrl).toBe(TINY_JPEG);
    });

    it('通話結束卡的頭像、分享帖快照的作者與評論頭像都轉，帖子配圖不碰', async () => {
        await seedStore('messages', [{
            id: 103, charId: 'c1', role: 'assistant', type: 'text', content: '通話結束', timestamp: 1,
            metadata: {
                characterAvatar: TINY_PNG,
                post: {
                    authorName: '甲', authorAvatar: TINY_JPEG, images: [TINY_PNG],
                    comments: [{ authorName: '乙', authorAvatar: TINY_PNG }],
                },
            },
        }]);

        await optimizeResourceStorage();

        const [m]: any = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        expect(isBlobRef(m.metadata.characterAvatar)).toBe(true);
        expect(isBlobRef(m.metadata.post.authorAvatar)).toBe(true);
        expect(isBlobRef(m.metadata.post.comments[0].authorAvatar)).toBe(true);
        expect(m.metadata.post.images[0]).toBe(TINY_PNG);   // 讀端把它當可能是 emoji 的文本渲染
    });

    it('引用快照：圖片副本換成佔位符，不留令牌（留了會讓孤兒清理整輪不敢刪）', async () => {
        await seedStore('messages', [
            { id: 104, charId: 'c1', role: 'assistant', type: 'text', content: '好可愛', timestamp: 1,
              replyTo: { name: '小明', content: TINY_PNG } },
            { id: 105, charId: 'c1', role: 'assistant', type: 'text', content: '嗯嗯', timestamp: 2,
              replyTo: { name: '小明', content: '今天去看海啦' } },
        ]);

        await optimizeResourceStorage();

        const rows: any[] = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        const withImage = rows.find(r => r.id === 104);
        const withText = rows.find(r => r.id === 105);
        expect(withImage.replyTo.content).toBe('[圖片]');
        expect(withImage.replyTo.content).not.toContain('blobref');
        expect(withText.replyTo.content).toBe('今天去看海啦');   // 普通文字原樣
    });

    it('引用快照：圖片 / 表情行的引用也要歸一化，正文轉令牌不能頂掉這一步', async () => {
        // 引用一條圖片消息後回了張圖或一個表情，這兩行的 type 就是 image / emoji。
        // 正文和引用快照是一行裡的兩處改動，得一起寫回去：漏掉引用那處的話，正文下一輪
        // 已經是令牌、不會再被處理，快照裡那份幾 MB 的 dataURL 就永久留在庫裡了。
        await seedStore('messages', [
            { id: 201, charId: 'c1', role: 'user', type: 'image', content: TINY_PNG, timestamp: 1,
              replyTo: { name: '小明', content: TINY_JPEG } },
            { id: 202, charId: 'c1', role: 'user', type: 'emoji', content: TINY_GIF, timestamp: 2,
              replyTo: { name: '小明', content: TINY_PNG } },
        ]);

        await optimizeResourceStorage();

        const rows: any[] = (await DB.getStoreRowsPage('messages', null, 10)).rows;
        const image = rows.find(r => r.id === 201);
        const emoji = rows.find(r => r.id === 202);
        expect(image.replyTo.content).toBe('[圖片]');
        expect(emoji.replyTo.content).toBe('[圖片]');
        // 正文照轉，兩處改動合成一次整行寫回
        expect(isBlobRef(image.content)).toBe(true);
        expect(isBlobRef(emoji.content)).toBe(true);
        expect(JSON.stringify(rows)).not.toContain('data:image');
    });

    it('我方的彼方 Q 版形象也轉（角色那側和我方這側是兩段代碼，只改一邊會漏）', async () => {
        await seedStore('user_profile', [{ id: 'me', name: '小明', vrState: { chibi: { img: TINY_PNG } } }]);

        await optimizeResourceStorage();

        const [me]: any = (await DB.getStoreRowsPage('user_profile', null, 10)).rows;
        expect(isBlobRef(me.vrState.chibi.img)).toBe(true);
    });

    it('聊天背景與見面背景都轉（文件頭列了就得真的在代碼裡）', async () => {
        await DB.saveCharacter({
            id: 'c-bg', name: '背景角色',
            chatBackground: TINY_PNG, dateBackground: TINY_JPEG,
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-bg')!;
        expect(isBlobRef(c.chatBackground)).toBe(true);
        expect(isBlobRef(c.dateBackground)).toBe(true);
    });

    it('見面立繪：角色默認那套和每個換裝套裝都轉，換裝那側不漏', async () => {
        await DB.saveCharacter({
            id: 'c-sprite', name: '立繪角色',
            sprites: { normal: TINY_PNG, happy: TINY_JPEG, chibi: TINY_PNG },
            dateSkinSets: [{ id: 'skin1', name: '泳裝', sprites: { normal: TINY_JPEG, shy: TINY_PNG } }],
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-sprite')!;
        for (const key of ['normal', 'happy', 'chibi']) expect(isBlobRef(c.sprites[key])).toBe(true);
        for (const key of ['normal', 'shy']) expect(isBlobRef(c.dateSkinSets[0].sprites[key])).toBe(true);
    });

    it('見面存檔：currentSprite 整個刪掉，情緒鍵先反查出來補上', async () => {
        // 這個字段是歷史殘留（新存檔只記 currentSpriteKey），存的是整張立繪的 base64 副本。
        // 反查必須發生在立繪轉令牌之前，否則值就對不上了。
        await DB.saveCharacter({
            id: 'c-saved', name: '有存檔的角色',
            sprites: { normal: TINY_PNG, happy: TINY_JPEG },
            savedDateState: { currentSprite: TINY_JPEG, timestamp: 1 },
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-saved')!;
        expect(c.savedDateState.currentSprite).toBeUndefined();   // 空間歸零
        expect(c.savedDateState.currentSpriteKey).toBe('happy');  // 表情沒丟
        expect(isBlobRef(c.sprites.happy)).toBe(true);
    });

    it('見面存檔：已經記了情緒鍵的存檔，不覆蓋它', async () => {
        await DB.saveCharacter({
            id: 'c-saved2', name: '新存檔',
            sprites: { normal: TINY_PNG, happy: TINY_JPEG },
            savedDateState: { currentSprite: TINY_JPEG, currentSpriteKey: 'normal', timestamp: 1 },
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-saved2')!;
        expect(c.savedDateState.currentSpriteKey).toBe('normal');
        expect(c.savedDateState.currentSprite).toBeUndefined();
    });

    it('彼方 Q 版形象、查手機通訊錄頭像、活動卡片頭像都轉', async () => {
        await DB.saveCharacter({
            id: 'c-misc', name: '雜項角色',
            vrState: { chibi: { img: TINY_PNG } },
            phoneState: { contacts: [{ id: 'ct1', name: '甲', avatar: TINY_JPEG }, { id: 'ct2', name: '乙', avatar: TINY_PNG }] },
            specialMomentRecords: { qixi_2026_x: { customData: { chatCard: { charAvatar: TINY_JPEG } } } },
        } as any);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c-misc')!;
        expect(isBlobRef(c.vrState.chibi.img)).toBe(true);
        expect(isBlobRef(c.phoneState.contacts[0].avatar)).toBe(true);
        expect(isBlobRef(c.phoneState.contacts[1].avatar)).toBe(true);
        expect(isBlobRef(c.specialMomentRecords.qixi_2026_x.customData.chatCard.charAvatar)).toBe(true);
    });

    it('活動留存的大圖也轉（白色情人節明信片 / 520 定妝照）', async () => {
        await DB.saveCharacter({
            id: 'c-moment', name: '活動角色',
            specialMomentRecords: {
                whiteday_2026: { image: TINY_PNG, timestamp: 1 },
                like520_2026: { image: TINY_JPEG, timestamp: 2 },
            },
        } as any);

        await optimizeResourceStorage();

        const m: any = ((await DB.getAllCharacters()).find(x => x.id === 'c-moment') as any).specialMomentRecords;
        expect(isBlobRef(m.whiteday_2026.image)).toBe(true);
        expect(isBlobRef(m.like520_2026.image)).toBe(true);
    });

    it('雷區守衛：活動記錄裡的 520 手辦圖刻意保持 dataURL，絕不能被順手轉走', async () => {
        // 520 活動那邊全是裸 <img> + canvas 合成，令牌過不去。誰要是把
        // specialMomentRecords 改成整體深度遍歷，這條會掛。
        await DB.saveCharacter({
            id: 'c-520', name: '520 角色',
            specialMomentRecords: {
                like520_2026: {
                    customData: {
                        chatCard: { charAvatar: TINY_PNG },
                        charChibi: { dataUrl: TINY_JPEG },
                        userChibi: { dataUrl: TINY_JPEG },
                    },
                },
            },
        } as any);

        await optimizeResourceStorage();

        const cd: any = ((await DB.getAllCharacters()).find(x => x.id === 'c-520') as any).specialMomentRecords.like520_2026.customData;
        expect(isBlobRef(cd.chatCard.charAvatar)).toBe(true);     // 這個該轉
        expect(cd.charChibi.dataUrl).toBe(TINY_JPEG);             // 這兩個一個字節都不許動
        expect(cd.userChibi.dataUrl).toBe(TINY_JPEG);
    });

    it('社交帖子：作者頭像與評論頭像都轉，帖子自己的配圖不碰', async () => {
        await DB.putStoreRows('social_posts', [{
            id: 'p1', authorName: '小明', authorAvatar: TINY_PNG,
            title: 't', content: 'c', images: [TINY_JPEG],
            comments: [{ id: 'cm1', authorName: '乙', authorAvatar: TINY_JPEG, content: 'hi' }],
            likes: 0, timestamp: 1, tags: [], isCollected: false, isLiked: false,
        }]);

        await optimizeResourceStorage();

        const [post]: any = (await DB.getStoreRowsPage('social_posts', null, 100)).rows;
        expect(isBlobRef(post.authorAvatar)).toBe(true);
        expect(isBlobRef(post.comments[0].authorAvatar)).toBe(true);
        expect(post.images[0]).toBe(TINY_JPEG);   // 讀端還沒改造，不在收錄範圍
    });

    it('群頭像轉令牌，但代碼現畫的 SVG 佔位符跳過（換一條 Blob 行不值幾百字節）', async () => {
        const SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"><circle r="9"/></svg>';
        await DB.putStoreRows('groups', [
            { id: 'g1', name: '真頭像群', avatar: TINY_PNG },
            { id: 'g2', name: '默認頭像群', avatar: SVG },
        ]);

        await optimizeResourceStorage();

        const rows: any[] = (await DB.getStoreRowsPage('groups', null, 100)).rows;
        expect(isBlobRef(rows.find(g => g.id === 'g1').avatar)).toBe(true);
        expect(rows.find(g => g.id === 'g2').avatar).toBe(SVG);
    });

    it('雷區守衛：生活模擬只轉角色頭像副本，劇情插圖不碰', async () => {
        // attachments[].imageUrl 是裸 <img> 渲染的（apps/lifesim/StoryAttachments.tsx）。
        // 誰把 life_sim 改成整行深度遍歷，這條會掛。
        await DB.putStoreRows('life_sim', [{
            id: 'sim1',
            actionLog: [{
                turnNumber: 1, actor: '甲', actorAvatar: TINY_PNG,
                attachments: [{ id: 'a1', imageUrl: TINY_JPEG }],
            }],
        }]);

        await optimizeResourceStorage();

        const [sim]: any = (await DB.getStoreRowsPage('life_sim', null, 100)).rows;
        expect(isBlobRef(sim.actionLog[0].actorAvatar)).toBe(true);
        expect(sim.actionLog[0].attachments[0].imageUrl).toBe(TINY_JPEG);
    });

    it('社交主頁：背景圖（裸字符串）和資料 JSON 裡的頭像都轉', async () => {
        await DB.saveAsset('spark_user_bg', TINY_PNG);
        await DB.saveAsset('spark_social_profile', JSON.stringify({ name: '小明', avatar: TINY_JPEG, bio: '你好' }));

        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(2);

        expect(isBlobRef((await DB.getAsset('spark_user_bg'))!)).toBe(true);
        const profile = JSON.parse((await DB.getAsset('spark_social_profile'))!);
        expect(isBlobRef(profile.avatar)).toBe(true);
        expect(profile.name).toBe('小明');   // 非圖片字段原樣
        expect(profile.bio).toBe('你好');
    });

    it('桌面小組件圖：assets 裡的 widget_* 行和預設裡內嵌的那份都轉', async () => {
        await DB.saveAsset('widget_dsq', TINY_PNG);
        await DB.saveAsset('appearance_preset_ap4', JSON.stringify({
            id: 'ap4', name: '帶小組件的預設', createdAt: 1,
            theme: {
                wallpaper: 'linear-gradient(#fff,#000)',
                // polaroid_* 是老美化包留下的歷史槽位，桌面只認 tl/tr/wide/dsq，
                // 但它一樣佔著預設 JSON 的體積，一起轉
                launcherWidgets: { dsq: TINY_JPEG, wide: TINY_PNG, polaroid_tl: TINY_JPEG },
            },
        }));

        await optimizeResourceStorage();

        expect(isBlobRef((await DB.getAsset('widget_dsq'))!)).toBe(true);
        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap4'))!);
        for (const slot of ['dsq', 'wide', 'polaroid_tl']) {
            expect(isBlobRef(stored.theme.launcherWidgets[slot])).toBe(true);
        }
    });

    it('外觀預設內嵌的氣泡主題：user / ai 兩側六張圖都轉，一側都不漏', async () => {
        // 存預設時 chatThemes 是從 themes 表原樣抄過來的。themes 表轉了、預設裡這份沒轉，
        // 下次應用預設就把 base64 又灌回 themes 表——兩邊必須一起轉。
        const preset = {
            id: 'ap2', name: '帶氣泡的預設', createdAt: 1,
            theme: { wallpaper: TINY_PNG },
            chatThemes: [{
                id: 'ct1', name: '主題一', type: 'custom',
                user: { backgroundImage: TINY_PNG, decoration: TINY_JPEG, avatarDecoration: TINY_PNG },
                ai: { backgroundImage: TINY_JPEG, decoration: TINY_PNG, avatarDecoration: TINY_JPEG },
            }],
        };
        await DB.saveAsset('appearance_preset_ap2', JSON.stringify(preset));

        await optimizeResourceStorage();

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap2'))!);
        for (const side of ['user', 'ai']) {
            for (const key of ['backgroundImage', 'decoration', 'avatarDecoration']) {
                expect(isBlobRef(stored.chatThemes[0][side][key])).toBe(true);
            }
        }
        expect(stored.chatThemes[0].name).toBe('主題一');   // 非圖片字段原樣
    });

    it('外觀預設裡的 launcherWidgetImage 直接扔掉，不佔位也不轉成令牌', async () => {
        // 這個字段 types.ts 標了 DEPRECATED、加載時必被剝離、永遠不渲染。
        // 老美化包的預設裡壓著幾百 KB 的 base64，轉成令牌只是把死重量換個地方存。
        const preset = {
            id: 'ap3', name: '老美化包', createdAt: 1,
            theme: { wallpaper: 'linear-gradient(#fff,#000)', launcherWidgetImage: TINY_PNG },
        };
        await DB.saveAsset('appearance_preset_ap3', JSON.stringify(preset));

        const r = await optimizeResourceStorage();

        const stored = JSON.parse((await DB.getAsset('appearance_preset_ap3'))!);
        expect(stored.theme.launcherWidgetImage).toBeUndefined();
        expect(stored.theme.wallpaper).toBe('linear-gradient(#fff,#000)');   // 漸變不動
        expect(r.converted).toBe(0);   // 扔掉不算「轉換」，不該虛報收益
    });

    it('相冊 gallery 行轉成令牌，Blob 字節與原圖逐字節一致', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const r = await optimizeResourceStorage();

        const stored = (await DB.getGalleryImages()).find(g => g.id === 'g1')!;
        expect(isBlobRef(stored.url)).toBe(true);
        expect(await blobBytes(stored.url)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('相冊圖和別處引用同一張圖：收斂到同一個令牌，只建一個 Blob', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const r = await optimizeResourceStorage();

        const stored = (await DB.getGalleryImages()).find(g => g.id === 'g1')!;
        expect(isBlobRef(stored.url)).toBe(true);
        expect(stored.url).toBe(await DB.getAsset('wallpaper'));
        expect(r.converted).toBe(2);
        expect(r.uniqueBlobs).toBe(1);
    });

    it('相冊冪等：第一遍轉完，第二遍零轉換', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(1);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('相冊獨佔引用的圖不會被孤兒 GC 刪掉（gallery 必須在 GC 的引用面清單裡）', async () => {
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });
        await optimizeResourceStorage();
        const token = (await DB.getGalleryImages()).find(g => g.id === 'g1')!.url;
        expect(isBlobRef(token)).toBe(true);

        // 轉出來的 Blob 只有相冊這一面引用著：GC 看不見這個面就會把它當孤兒刪掉，相冊全沒
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(token)).not.toBeNull();
    });

    /** 一套氣泡主題：兩側各帶底紋 / 貼紙 / 頭像掛件三張圖，外加幾個不該被碰的數值字段。 */
    function makeTheme(): any {
        return {
            id: 't1', name: '我的氣泡', type: 'custom',
            user: {
                textColor: '#ffffff', backgroundColor: '#6366f1', borderRadius: 20, opacity: 1,
                backgroundImage: TINY_PNG, decoration: TINY_JPEG, avatarDecoration: TINY_GIF,
                decorationX: 88, decorationY: -12, avatarDecorationScale: 1.5,
            },
            ai: {
                textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 16, opacity: 0.9,
                backgroundImage: TINY_GIF, decoration: TINY_PNG, avatarDecoration: TINY_JPEG,
                decorationX: 10, backgroundImageOpacity: 0.35,
            },
        };
    }

    it('氣泡主題：兩側六個圖片字段都轉成令牌，Blob 字節與原圖逐字節一致', async () => {
        await DB.saveTheme(makeTheme());

        const r = await optimizeResourceStorage();

        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        // 只處理 user 一側是這一面最容易犯的錯，所以兩側逐個字段都要斷言
        for (const side of ['user', 'ai']) {
            for (const key of ['backgroundImage', 'decoration', 'avatarDecoration']) {
                expect(isBlobRef(t[side][key])).toBe(true);
            }
        }
        expect(await blobBytes(t.user.backgroundImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(await blobBytes(t.user.decoration)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
        expect(await blobBytes(t.user.avatarDecoration)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(await blobBytes(t.ai.backgroundImage)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(r.converted).toBe(6);
        expect(r.uniqueBlobs).toBe(3);   // 三張不同的圖，兩側交叉引用只建三份 Blob
        expect(r.failed).toBe(0);
    });

    it('氣泡主題的非圖片字段一字不動：顏色、圓角、透明度、貼紙座標全保持原值', async () => {
        const before = makeTheme();
        await DB.saveTheme(before);

        await optimizeResourceStorage();

        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        expect(t.name).toBe('我的氣泡');
        expect(t.user.textColor).toBe('#ffffff');
        expect(t.user.backgroundColor).toBe('#6366f1');
        expect(t.user.borderRadius).toBe(20);
        expect(t.user.opacity).toBe(1);
        expect(t.user.decorationX).toBe(88);
        expect(t.user.decorationY).toBe(-12);
        expect(t.user.avatarDecorationScale).toBe(1.5);
        expect(t.ai.borderRadius).toBe(16);
        expect(t.ai.opacity).toBe(0.9);
        expect(t.ai.backgroundImageOpacity).toBe(0.35);
    });

    it('氣泡主題冪等：第一遍轉完，第二遍零轉換', async () => {
        await DB.saveTheme(makeTheme());

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(6);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('氣泡主題獨佔引用的圖不會被孤兒 GC 刪掉（themes 必須在 GC 的引用面清單裡）', async () => {
        await DB.saveTheme(makeTheme());
        await optimizeResourceStorage();
        const t = (await DB.getThemes()).find(x => x.id === 't1') as any;
        const tokens = [t.user.backgroundImage, t.user.decoration, t.user.avatarDecoration];
        for (const token of tokens) expect(isBlobRef(token)).toBe(true);

        // 轉出來的 Blob 只有主題這一面引用著：GC 看不見這個面就會把它們全當孤兒刪掉
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        for (const token of tokens) expect(await getBlobForRef(token)).not.toBeNull();
    });

    /** 往 messages 表塞一條消息，返回它的自增 id。 */
    async function seedMessage(type: string, content: string, charId = 'c1'): Promise<number> {
        return DB.saveMessage({ charId, role: 'user', type, content } as any);
    }

    async function readMessage(id: number, charId = 'c1'): Promise<any> {
        return (await DB.getMessagesByCharId(charId)).find(m => m.id === id);
    }

    it('聊天圖片消息：content 轉成令牌，Blob 字節與原圖逐字節一致', async () => {
        const id = await seedMessage('image', TINY_PNG);

        const r = await optimizeResourceStorage();

        const msg = await readMessage(id);
        expect(isBlobRef(msg.content)).toBe(true);
        expect(await blobBytes(msg.content)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('表情消息（type=emoji）也轉成令牌', async () => {
        const id = await seedMessage('emoji', TINY_JPEG);

        await optimizeResourceStorage();

        const msg = await readMessage(id);
        expect(isBlobRef(msg.content)).toBe(true);
        expect(await blobBytes(msg.content)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
    });

    it('文本消息一字不動：正文恰好長得像 data URL 也不碰', async () => {
        // messages 表裡絕大多數行跟圖片無關。少了 type 那道閘，一條正文裡粘了 base64 的
        // 文本消息就會被當圖片轉掉，用戶看到的是自己發過的一段話變成了一串令牌。
        const id = await seedMessage('text', TINY_PNG);

        const r = await optimizeResourceStorage();

        const msg = await readMessage(id);
        expect(msg.content).toBe(TINY_PNG);
        expect(r.converted).toBe(0);
        expect(r.uniqueBlobs).toBe(0);
    });

    it('表情庫：本地圖轉成令牌，http 外鏈原樣保留、分類不丟', async () => {
        await DB.saveEmoji('本地表情', TINY_PNG, 'cat-1');
        await DB.saveEmoji('網絡表情', 'https://img.host/sticker.png', 'cat-1');

        const r = await optimizeResourceStorage();

        const list = await DB.getEmojis();
        const local = list.find(e => e.name === '本地表情')!;
        const remote = list.find(e => e.name === '網絡表情')!;
        expect(isBlobRef(local.url)).toBe(true);
        expect(await blobBytes(local.url)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        // 外鏈是別人服務器上的地址，本機沒有它的二進制，轉不了也不該動
        expect(remote.url).toBe('https://img.host/sticker.png');
        // 表情的主鍵是 name，回寫時把分類帶丟了的話，這個表情會掉出它原來的分組
        expect(local.categoryId).toBe('cat-1');
        expect(r.converted).toBe(1);
    });

    it('聊天圖與表情庫獨佔引用的 Blob 不會被孤兒 GC 刪掉（兩面都必須在 GC 引用面清單裡）', async () => {
        const msgId = await seedMessage('image', TINY_PNG);
        await DB.saveEmoji('本地表情', TINY_JPEG, undefined);
        await optimizeResourceStorage();

        const msgToken = (await readMessage(msgId)).content;
        const emojiToken = (await DB.getEmojis()).find(e => e.name === '本地表情')!.url;
        expect(isBlobRef(msgToken)).toBe(true);
        expect(isBlobRef(emojiToken)).toBe(true);

        // 這兩份 Blob 各自只有一處引用：GC 看不見那個面就會把它當孤兒刪掉，用戶的聊天圖 / 表情全沒
        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(msgToken)).not.toBeNull();
        expect(await getBlobForRef(emojiToken)).not.toBeNull();
    });

    it('聊天圖與表情庫冪等：第一遍轉完，第二遍零轉換', async () => {
        await seedMessage('image', TINY_PNG);
        await seedMessage('emoji', TINY_JPEG);
        await DB.saveEmoji('本地表情', TINY_GIF, undefined);

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(3);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('角色頭像：base64 轉成令牌，Blob 字節與原圖逐字節一致', async () => {
        await DB.saveCharacter({ id: 'c1', name: '角色', avatar: TINY_PNG } as any);

        const r = await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1')!;
        expect(isBlobRef(c.avatar)).toBe(true);
        expect(await blobBytes(c.avatar)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(1);
        expect(r.failed).toBe(0);
    });

    it('角色頭像與小屋圖一趟遍歷裡一起轉，互不影響', async () => {
        await DB.saveCharacter({
            id: 'c1', name: '角色', avatar: TINY_PNG,
            roomConfig: { wallImage: TINY_JPEG, items: [] },
        } as any);

        const r = await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(isBlobRef(c.avatar)).toBe(true);
        expect(isBlobRef(c.roomConfig.wallImage)).toBe(true);
        expect(r.converted).toBe(2);
    });

    it('角色頭像：emoji 與 http 外鏈原樣保留，只有 data: 才轉', async () => {
        // 頭像是兩用字段，用戶可以只填一個 emoji；外鏈是別人服務器上的地址，本機沒有二進制
        await DB.saveCharacter({ id: 'c1', name: '表情頭像', avatar: '🐱' } as any);
        await DB.saveCharacter({ id: 'c2', name: '外鏈頭像', avatar: 'https://img.host/a.png' } as any);

        const r = await optimizeResourceStorage();

        const chars = await DB.getAllCharacters();
        expect(chars.find(c => c.id === 'c1')!.avatar).toBe('🐱');
        expect(chars.find(c => c.id === 'c2')!.avatar).toBe('https://img.host/a.png');
        expect(r.converted).toBe(0);
    });

    it('角色的非頭像字段一字不動：刻意留 dataURL 的手辦圖和文本字段都不碰', async () => {
        await DB.saveCharacter({
            id: 'c1', name: '角色', avatar: TINY_PNG, personality: '話很少',
            chibiStudio: { like520: { img: TINY_JPEG } },
        } as any);

        const r = await optimizeResourceStorage();

        const c = (await DB.getAllCharacters()).find(x => x.id === 'c1') as any;
        expect(isBlobRef(c.avatar)).toBe(true);             // 頭像照轉
        expect(c.chibiStudio.like520.img).toBe(TINY_JPEG);  // 刻意保持 dataURL，見 docs/chibi-studio.md
        expect(c.personality).toBe('話很少');
        expect(r.converted).toBe(1);
    });

    it('我方頭像：整體頭像與分角色頭像兩處都轉，外鏈與文本字段不動', async () => {
        // 只轉 avatar、忘了 perCharAvatars 是這一面最容易犯的錯——分角色那幾張會靜默留在 base64
        await DB.saveUserProfile({
            name: '小明', bio: '愛吃辣', avatar: TINY_PNG,
            perCharAvatars: { c1: TINY_JPEG, c2: TINY_GIF, c3: 'https://img.host/me.png' },
        } as any);

        const r = await optimizeResourceStorage();

        const p = (await DB.getUserProfile())!;
        expect(isBlobRef(p.avatar)).toBe(true);
        expect(await blobBytes(p.avatar)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
        const per = p.perCharAvatars!;
        expect(isBlobRef(per.c1)).toBe(true);
        expect(isBlobRef(per.c2)).toBe(true);
        expect(await blobBytes(per.c1)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_JPEG).arrayBuffer()));
        expect(await blobBytes(per.c2)).toEqual(new Uint8Array(await dataUrlToBlob(TINY_GIF).arrayBuffer()));
        expect(per.c3).toBe('https://img.host/me.png');
        expect(p.name).toBe('小明');
        expect(p.bio).toBe('愛吃辣');
        expect(r.converted).toBe(3);
        expect(r.uniqueBlobs).toBe(3);
        expect(r.failed).toBe(0);
    });

    it('我方頭像獨佔引用的 Blob 不會被孤兒 GC 刪掉（user_profile 必須在 GC 引用面清單裡）', async () => {
        await DB.saveUserProfile({ name: '小明', avatar: TINY_PNG, perCharAvatars: { c1: TINY_JPEG } } as any);
        await optimizeResourceStorage();
        const p = (await DB.getUserProfile())!;
        const tokens = [p.avatar, p.perCharAvatars!.c1];
        for (const t of tokens) expect(isBlobRef(t)).toBe(true);

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        for (const t of tokens) expect(await getBlobForRef(t)).not.toBeNull();
    });

    it('頭像被抄進帖子 / 群資料 / 劇場面具後，孤兒清理不會把圖刪掉', async () => {
        // 頭像會被抄進這些面長期留著。用戶之後換了頭像，characters 那邊就不再指著原圖，
        // 只剩這些副本還引用它——GC 看不見哪一面，那一面上的頭像就會碎成空白，且不可逆。
        await DB.saveCharacter({ id: 'c1', name: '甲', avatar: TINY_PNG } as any);
        await DB.saveCharacter({ id: 'c2', name: '乙', avatar: TINY_JPEG } as any);
        await DB.saveCharacter({ id: 'c3', name: '丙', avatar: TINY_GIF } as any);
        await optimizeResourceStorage();

        const chars = await DB.getAllCharacters();
        const tokenOf = (id: string) => chars.find(c => c.id === id)!.avatar;
        const postToken = tokenOf('c1');
        const groupToken = tokenOf('c2');
        const maskToken = tokenOf('c3');
        for (const t of [postToken, groupToken, maskToken]) expect(isBlobRef(t)).toBe(true);

        await seedStore('social_posts', [{ id: 'p1', charId: 'c1', authorAvatar: postToken, content: '今天天氣不錯', timestamp: 1 }]);
        await seedStore('groups', [{ id: 'g1', name: '小群', members: ['c1'], avatar: groupToken }]);
        await seedStore('story_theater_masks', [{ id: 'm1', name: '路人甲', avatar: maskToken }]);
        // 三個角色隨後都換成了 emoji 頭像：這三份 Blob 只剩上面那三處副本引用著
        for (const c of chars) await DB.saveCharacter({ ...c, avatar: '🐱' });

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(0);
        expect(await getBlobForRef(postToken)).not.toBeNull();   // 帖子裡的作者頭像
        expect(await getBlobForRef(groupToken)).not.toBeNull();  // 群資料裡的群頭像
        expect(await getBlobForRef(maskToken)).not.toBeNull();   // 劇場面具上的頭像
    });

    it('頭像冪等：第一遍轉完，第二遍零轉換', async () => {
        await DB.saveCharacter({ id: 'c1', name: '角色', avatar: TINY_PNG } as any);
        await DB.saveUserProfile({ name: '小明', avatar: TINY_JPEG, perCharAvatars: { c1: TINY_GIF } } as any);

        const first = await optimizeResourceStorage();
        expect(first.converted).toBe(3);

        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('冪等：第二次運行零轉換零新建', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.converted).toBe(0);
        expect(second.uniqueBlobs).toBe(0);
        expect(second.failed).toBe(0);
    });

    it('壞 data:image 轉不動：原值保留、計入 failed，不中斷其他面', async () => {
        await DB.saveAsset('wallpaper', 'data:image/png;base64,@@@@');
        await DB.saveAsset('lock_wallpaper', TINY_PNG);

        const r = await optimizeResourceStorage();
        expect(r.failed).toBe(1);
        expect(r.converted).toBe(1);
        expect(await DB.getAsset('wallpaper')).toBe('data:image/png;base64,@@@@');
        expect(isBlobRef(await DB.getAsset('lock_wallpaper'))).toBe(true);

        // 失敗原因得留下來：只報一個 failed 數字的話，用戶那邊轉不動時無從查起。
        // 鍵上帶著面名（這裡是「系統外觀」），才知道是哪張表出的事。
        const reasons = Object.keys(r.failureReasons);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('系統外觀');
        expect(r.failureReasons[reasons[0]]).toBe(1);
    });

    it('行寫回失敗（配額滿）：只丟這一行，整輪跑完不中斷，也不虛報省下的量', async () => {
        // 各表的寫入口會等事務真的提交完才 resolve，配額滿 / 事務 abort 都從那兒拋上來。
        // 整個優化只有 finally 沒有 catch，不在行級接住的話，一行寫不進去就把後面的面
        // 全掐了——連回收最省的那步「合併重複圖片」都輪不到。而存儲快滿恰恰正是有人來點
        // 這個按鈕的時候。
        await DB.saveGalleryImage({ id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 });
        await DB.saveGalleryImage({ id: 'g2', charId: 'c1', url: TINY_JPEG, timestamp: 2 });
        // 表情包在相冊後面，用它看整輪到底有沒有跑到頭
        await DB.saveEmoji('本地表情', TINY_GIF, undefined);

        const quota = new Error('存儲空間不足');
        quota.name = 'QuotaExceededError';
        const spy = vi.spyOn(DB, 'saveGalleryImage').mockRejectedValueOnce(quota);
        let r: Awaited<ReturnType<typeof optimizeResourceStorage>>;
        try {
            r = await optimizeResourceStorage();   // 不許拋
        } finally {
            spy.mockRestore();
        }

        // 掛掉的那一行原值還在（圖不丟），後面的行和後面的面照常處理
        const gallery = await DB.getGalleryImages();
        expect(gallery.find(g => g.id === 'g1')!.url).toBe(TINY_PNG);
        expect(isBlobRef(gallery.find(g => g.id === 'g2')!.url)).toBe(true);
        expect(isBlobRef((await DB.getEmojis()).find(e => e.name === '本地表情')!.url)).toBe(true);

        // 口徑不許撒謊：沒落庫的那張算「沒省下來」，不算轉換、也不算新建的 Blob
        expect(r!.failed).toBe(1);
        expect(r!.converted).toBe(2);     // g2 + 表情
        expect(r!.uniqueBlobs).toBe(2);
        const reasons = Object.keys(r!.failureReasons);
        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toContain('相冊');
        expect(reasons[0]).toContain('QuotaExceededError');
        expect(r!.failureReasons[reasons[0]]).toBe(1);
    });

    it('沒有失敗時 failureReasons 是空的（別拿噪音餵給反饋報告）', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const r = await optimizeResourceStorage();
        expect(r.failed).toBe(0);
        expect(r.failureReasons).toEqual({});
    });

    it('清單守衛：優化寫入的每張表都在 GC 引用面清單裡（否則轉出的 Blob 會被當孤兒刪）', () => {
        for (const store of OPTIMIZE_TARGET_STORES) {
            expect(REF_SOURCE_STORES).toContain(store);
        }
    });

    it('維護互斥：鎖被佔時優化與孤兒 GC 都乾淨拒絕', async () => {
        expect(tryAcquireMaintenanceLock('測試佔用')).toBe(true);
        try {
            await expect(optimizeResourceStorage()).rejects.toThrow(/正在[进進]行/);
            await expect(runBlobGc()).rejects.toThrow(/正在[进進]行/);
        } finally {
            releaseMaintenanceLock();
        }
        // 釋放後可正常運行（鎖沒被拒絕路徑汙染）
        const r = await optimizeResourceStorage();
        expect(r.converted).toBe(0);
    });
});

// 「換圖即刪」字段（清單見 utils/blobDedupe.ts）：換圖 / 移除時直接 deleteBlobRef 掉舊
// Blob，前提是那份令牌只歸自己。這組用例釘住遷移過來的令牌確實獨佔，以及衣櫃不會裂。
describe('換圖即刪的字段：令牌獨佔，衣櫃不裂', () => {
    it('桌面靜態形象轉成令牌，衣櫃裡那條跟頂層指向同一個', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            companionAvatar: {
                version: 1, source: 'upload', imageRef: TINY_PNG,
                imageWardrobe: [
                    { id: TINY_PNG, imageRef: TINY_PNG },
                    { id: TINY_JPEG, imageRef: TINY_JPEG },
                ],
            },
        }]);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');
        expect(isBlobRef(c.companionAvatar.imageRef)).toBe(true);
        // 衣櫃按 imageRef 認親。當前穿著這套在衣櫃裡得還是同一條，兩邊令牌不一致就會裂成兩條
        expect(c.companionAvatar.imageWardrobe[0].imageRef).toBe(c.companionAvatar.imageRef);
        // 另一套是另一張圖，令牌自然是另一個
        expect(isBlobRef(c.companionAvatar.imageWardrobe[1].imageRef)).toBe(true);
        expect(c.companionAvatar.imageWardrobe[1].imageRef).not.toBe(c.companionAvatar.imageRef);
        expect(await blobBytes(c.companionAvatar.imageRef))
            .toEqual(new Uint8Array(await dataUrlToBlob(TINY_PNG).arrayBuffer()));
    });

    it('同一張圖別處也有時，這個字段拿到的是自己那份令牌', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            avatar: TINY_PNG,                                                      // 走去重那條
            companionAvatar: { version: 1, source: 'upload', imageRef: TINY_PNG },  // 走獨佔那條
        }]);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');
        expect(isBlobRef(c.avatar)).toBe(true);
        expect(isBlobRef(c.companionAvatar.imageRef)).toBe(true);
        // 內容一樣，令牌必須是兩個：換掉桌面形象時它會把自己那份 Blob 直接刪掉
        expect(c.companionAvatar.imageRef).not.toBe(c.avatar);
    });

    it('兩個背景字段放同一張圖，也各拿各的令牌', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            videoCallBackground: TINY_JPEG,
            companionBackground: TINY_JPEG,
        }]);

        await optimizeResourceStorage();

        const c: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');
        expect(isBlobRef(c.videoCallBackground)).toBe(true);
        expect(isBlobRef(c.companionBackground)).toBe(true);
        expect(c.videoCallBackground).not.toBe(c.companionBackground);
    });

    it('再跑一遍，去重階段也不會把這兩份一樣的 Blob 併到一起', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '小明',
            avatar: TINY_PNG,
            companionAvatar: { version: 1, source: 'upload', imageRef: TINY_PNG },
        }]);

        await optimizeResourceStorage();
        const first: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');

        // 第二遍的去重階段這才看得見上一遍轉出來的兩份同內容 Blob。
        // collectUnmergeableRefs 把裸刪字段擋在合併之外，擋漏了這裡就會併成一個。
        await optimizeResourceStorage();
        const second: any = (await DB.getAllCharacters()).find(x => x.id === 'c1');

        expect(second.companionAvatar.imageRef).toBe(first.companionAvatar.imageRef);
        expect(second.companionAvatar.imageRef).not.toBe(second.avatar);
    });

    it('源碼守衛：這幾個字段不許走去重那條 put', () => {
        const src = readFileSync(new URL('./storageOptimize.ts', import.meta.url), 'utf8');
        const start = src.indexOf('const companion = (c as any).companionAvatar;');
        expect(start).toBeGreaterThan(-1);
        const end = src.indexOf('const rc = (c as any).roomConfig;', start);
        expect(end).toBeGreaterThan(start);
        const block = src.slice(start, end);

        expect(block).toContain('convertExclusive');
        // 換成 convert( 就是把令牌交給內容去重，別處一裸刪這邊的圖跟著沒
        expect(block).not.toMatch(/\bconvert\(/);
    });
});

describe('去重：同一張圖只留一份 Blob', () => {
    it('存量重複：兩份一樣的 Blob，優化後引用收斂到最老的那個', async () => {
        // 造出歷史上兩條遷移路徑各存各的局面（putImageBlob 本身不去重）
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('appearance_preset_1', JSON.stringify({ theme: { wallpaper: newer } }));

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(older);
        expect(JSON.parse((await DB.getAsset('appearance_preset_1'))!).theme.wallpaper).toBe(older);
        expect(r.mergedDuplicates).toBe(1);
        expect(r.reclaimableBytes).toBeGreaterThan(0);
        expect(r.scanUnavailable).toBe(false);
    });

    it('合併只改引用，不刪 Blob——多出來那份留給孤兒清理', async () => {
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('lock_wallpaper', newer);

        await optimizeResourceStorage();
        expect(await getBlobForRef(newer)).not.toBeNull();

        const gc = await runBlobGc({ minAgeMs: 0 });
        expect(gc.deleted).toBe(1);
        expect(await getBlobForRef(newer)).toBeNull();
        expect(await getBlobForRef(older)).not.toBeNull();
    });

    it('轉換時複用庫裡已有的同內容 Blob，不再存出新的一份', async () => {
        const existing = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('lock_wallpaper', existing);   // 先讓它有引用，不是孤兒
        await DB.saveAsset('wallpaper', TINY_PNG);        // 這行還是 base64，等著被轉

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(existing);
        expect(r.converted).toBe(1);
        expect(r.uniqueBlobs).toBe(0);   // 一個新 Blob 都沒建
        expect(r.bytesAfter).toBe(0);
    });

    it('被「換圖即刪」字段引用的令牌整組跳過合併（否則對方一刪這邊就破圖）', async () => {
        const wallpaperRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const stageRef = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', wallpaperRef);
        // videoCallBackground 換圖時是裸刪舊 Blob 的
        await DB.saveCharacter({ id: 'c1', name: '測試角色', videoCallBackground: stageRef } as any);

        const r = await optimizeResourceStorage();

        expect(await DB.getAsset('wallpaper')).toBe(wallpaperRef);
        expect(((await DB.getAllCharacters())[0] as any).videoCallBackground).toBe(stageRef);
        expect(r.mergedDuplicates).toBe(0);
        expect(r.skippedGroups).toBe(1);
    });

    /** 造一份掃庫結果：scanned 與 skipped 在 SDK 裡互斥（算出哈希才 scanned++，
     *  讀不出 / 算不動一律 skipped++），所以兩個數字分別擺就夠描述各種局面。 */
    function stubScan(scanned: number, skipped: number) {
        return vi.spyOn(blobStore, 'scanContent').mockResolvedValue({
            byHash: new Map<string, string[]>(), duplicateGroups: [],
            scanned, skipped, wastedBytes: 0, aborted: false,
        });
    }

    it('一條都沒算出哈希（非安全上下文沒有 crypto.subtle）：報「這輪沒做成去重」', async () => {
        // scanUnavailable 要抓的就是這個場景。判反了的話面板會說「已是最省形態」，
        // 用戶完全不知道換個環境還能再省一截。
        await DB.saveAsset('wallpaper', TINY_PNG);
        const spy = stubScan(0, 3);
        try {
            const r = await optimizeResourceStorage();
            expect(r.scanUnavailable).toBe(true);
            expect(r.converted).toBe(1);   // 去重停擺，轉換照跑
        } finally {
            spy.mockRestore();
        }
    });

    it('只有幾條讀壞：去重照跑，不許誤報成沒做成', async () => {
        await DB.saveAsset('wallpaper', TINY_PNG);
        const spy = stubScan(3, 3);
        try {
            const r = await optimizeResourceStorage();
            expect(r.scanUnavailable).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('空庫：一條都沒有也不算「沒做成」', async () => {
        const spy = stubScan(0, 0);
        try {
            const r = await optimizeResourceStorage();
            expect(r.scanUnavailable).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('合併跑完是冪等的：再點一次沒有重複可合', async () => {
        const older = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const newer = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await DB.saveAsset('wallpaper', older);
        await DB.saveAsset('lock_wallpaper', newer);

        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.mergedDuplicates).toBe(0);
        expect(second.converted).toBe(0);
    });
});

describe('記憶向量：壓成緊湊形態', () => {
    /** 直接塞一條舊 number[] 形態的向量（繞開 MemoryVectorDB.save，它會當場轉成緊湊形態）。 */
    async function seedLegacyVector(memoryId: string, charId: string, dims: number): Promise<number[]> {
        const vector = Array.from({ length: dims }, (_, i) => (i % 7) / 7 - 0.5);
        const db = await openDB();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('memory_vectors', 'readwrite');
            tx.objectStore('memory_vectors').put({ memoryId, charId, vector, dimensions: dims });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        return vector;
    }

    async function readRawVector(memoryId: string): Promise<any> {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction('memory_vectors', 'readonly').objectStore('memory_vectors').get(memoryId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    it('一鍵優化會把舊 number[] 向量壓成緊湊字節，數值逐位不變', async () => {
        const original = await seedLegacyVector('m1', 'c1', 16);

        const r = await optimizeResourceStorage();

        expect(r.vectorsCompacted).toBe(1);
        expect(r.vectorError).toBeNull();
        const stored = await readRawVector('m1');
        expect(ArrayBuffer.isView(stored.vector)).toBe(true);
        // Float32 精度內逐位一致：壓縮必須是無損的，否則召回質量會靜默退化
        const back = new Float32Array(stored.vector.buffer, stored.vector.byteOffset, stored.vector.byteLength >>> 2);
        expect(back.length).toBe(original.length);
        for (let i = 0; i < original.length; i++) {
            expect(back[i]).toBeCloseTo(original[i], 6);
        }
    });

    it('冪等：已是緊湊形態的再點一次不重複計數', async () => {
        await seedLegacyVector('m1', 'c1', 16);
        await optimizeResourceStorage();
        const second = await optimizeResourceStorage();
        expect(second.vectorsCompacted).toBe(0);
        expect(second.vectorError).toBeNull();
    });

    it('向量這步失敗不吞、也不連累圖片那幾步的成果', async () => {
        const mp = await import('./memoryPalace/db');
        const spy = vi.spyOn(mp.MemoryVectorDB, 'scanAndMigrateLegacy')
            .mockRejectedValue(new Error('磁盤滿了'));
        try {
            await DB.saveAsset('wallpaper', TINY_PNG);

            const r = await optimizeResourceStorage();

            // 圖片照轉完，結果照報
            expect(r.converted).toBe(1);
            expect(isBlobRef(await DB.getAsset('wallpaper'))).toBe(true);
            // 向量的失敗原樣帶出來（開機那次後台掃描就是只 console.warn，卡住了沒人知道）
            expect(r.vectorsCompacted).toBe(0);
            expect(r.vectorError).toContain('磁盤滿了');
        } finally {
            spy.mockRestore();
        }
    });
});

describe('分頁讀表：跨頁不漏行，進度條對得上', () => {
    // 這五面原本是整表 getAll 的，行都在一個數組裡，怎麼寫都不會漏。改成按主鍵翻頁之後，
    // 「只跑了第一批就退出」「翻頁起點取錯」這類毛病在小庫上一條都不會紅，而漏掉的行
    // 就是沒被轉換的存量圖。這組用例把跨頁和進度口徑釘住。
    const PAGE = 200; // 與 storageOptimize.ts 的 PAGE_SIZE 一致

    it('相冊行數超過一頁：跨頁每一行都轉到，一條不漏', async () => {
        const count = PAGE + 50;
        await seedStore('gallery', Array.from({ length: count }, (_, i) => ({
            id: `g${String(i + 1).padStart(4, '0')}`, charId: 'c1', url: TINY_PNG, timestamp: i + 1,
        })));

        const r = await optimizeResourceStorage();

        const rows = await DB.getGalleryImages();
        expect(rows.length).toBe(count);
        // 第 2 頁起漏掉任何一行，這裡就是一堆還留著 data: 的相冊圖
        expect(rows.filter(g => isBlobRef(g.url)).length).toBe(count);
        expect(r.converted).toBe(count);
        expect(r.uniqueBlobs).toBe(1); // 全是同一張圖，去重後只建一份 Blob
    });

    it('聊天消息行數超過一頁：跨頁每一條圖片消息都轉到，一條不漏', async () => {
        // messages 是全庫最大的表，翻頁出問題時漏掉的就是第 2 頁往後所有存量聊天圖
        const count = PAGE + 50;
        await seedStore('messages', Array.from({ length: count }, (_, i) => ({
            id: i + 1, charId: 'c1', role: 'user', type: 'image', content: TINY_PNG, timestamp: i + 1,
        })));

        const r = await optimizeResourceStorage();

        const rows = await DB.getMessagesByCharId('c1');
        expect(rows.length).toBe(count);
        expect(rows.filter(m => isBlobRef(m.content)).length).toBe(count);
        expect(r.converted).toBe(count);
        expect(r.uniqueBlobs).toBe(1); // 全是同一張圖，去重後只建一份 Blob
    });

    it('進度回調：total 就是十二面的真實行數，done 一路遞增且正好停在 total', async () => {
        // 十二個面各擺幾行、行數互不相同——少數了哪一面都對不上
        await DB.saveAsset('wallpaper', TINY_PNG);
        await DB.saveAsset('lock_wallpaper', TINY_JPEG);
        await seedStore('characters', [
            { id: 'c1', name: '角色一', roomConfig: { wallImage: TINY_PNG, items: [] } },
            { id: 'c2', name: '角色二' },
            { id: 'c3', name: '角色三' },
        ]);
        await seedStore('songs', [{ id: 's1', title: '測試曲', coverImage: TINY_JPEG }]);
        await seedStore('cc_custom_parts', [
            { id: 'p1', src: TINY_PNG, createdAt: 1 },
            { id: 'p2', src: TINY_JPEG, createdAt: 2 },
        ]);
        await seedStore('gallery', [
            { id: 'g1', charId: 'c1', url: TINY_PNG, timestamp: 1 },
            { id: 'g2', charId: 'c1', url: TINY_JPEG, timestamp: 2 },
            { id: 'g3', charId: 'c1', url: TINY_PNG, timestamp: 3 },
            { id: 'g4', charId: 'c1', url: TINY_JPEG, timestamp: 4 },
        ]);
        await seedStore('themes', [
            { id: 't1', name: '氣泡一', type: 'custom', user: { backgroundImage: TINY_PNG }, ai: {} },
            { id: 't2', name: '氣泡二', type: 'custom', user: {}, ai: { decoration: TINY_GIF } },
            { id: 't3', name: '氣泡三', type: 'custom', user: {}, ai: {} },
            { id: 't4', name: '氣泡四', type: 'custom', user: {}, ai: {} },
            { id: 't5', name: '氣泡五', type: 'custom', user: {}, ai: {} },
        ]);
        await seedStore('messages', [
            { id: 1, charId: 'c1', role: 'user', type: 'image', content: TINY_PNG, timestamp: 1 },
            { id: 2, charId: 'c1', role: 'user', type: 'text', content: '一句話', timestamp: 2 },
            { id: 3, charId: 'c1', role: 'user', type: 'emoji', content: TINY_JPEG, timestamp: 3 },
            { id: 4, charId: 'c1', role: 'assistant', type: 'text', content: '回一句', timestamp: 4 },
            { id: 5, charId: 'c1', role: 'user', type: 'text', content: '再一句', timestamp: 5 },
            { id: 6, charId: 'c1', role: 'user', type: 'text', content: '還有一句', timestamp: 6 },
        ]);
        await seedStore('emojis', [
            { name: '本地表情', url: TINY_GIF },
            { name: '網絡表情', url: 'https://img.host/sticker.png' },
        ]);
        await seedStore('user_profile', [{ id: 'me', name: '小明', avatar: TINY_JPEG }]);
        await seedStore('social_posts', [
            { id: 'sp1', authorName: '甲', authorAvatar: TINY_PNG, comments: [], images: [], timestamp: 1 },
            { id: 'sp2', authorName: '乙', authorAvatar: TINY_JPEG, comments: [], images: [], timestamp: 2 },
            { id: 'sp3', authorName: '丙', authorAvatar: '', comments: [], images: [], timestamp: 3 },
            { id: 'sp4', authorName: '丁', authorAvatar: '', comments: [], images: [], timestamp: 4 },
            { id: 'sp5', authorName: '戊', authorAvatar: '', comments: [], images: [], timestamp: 5 },
            { id: 'sp6', authorName: '己', authorAvatar: '', comments: [], images: [], timestamp: 6 },
            { id: 'sp7', authorName: '庚', authorAvatar: '', comments: [], images: [], timestamp: 7 },
        ]);
        await seedStore('groups', [
            { id: 'gp1', name: '群一', avatar: TINY_PNG },
            { id: 'gp2', name: '群二', avatar: '' },
            { id: 'gp3', name: '群三', avatar: '' },
            { id: 'gp4', name: '群四', avatar: '' },
            { id: 'gp5', name: '群五', avatar: '' },
            { id: 'gp6', name: '群六', avatar: '' },
            { id: 'gp7', name: '群七', avatar: '' },
            { id: 'gp8', name: '群八', avatar: '' },
        ]);
        await seedStore('life_sim', [
            { id: 'ls1', actionLog: [{ turnNumber: 1, actor: '甲', actorAvatar: TINY_JPEG }] },
            { id: 'ls2', actionLog: [] },
            { id: 'ls3', actionLog: [] },
            { id: 'ls4', actionLog: [] },
            { id: 'ls5', actionLog: [] },
            { id: 'ls6', actionLog: [] },
            { id: 'ls7', actionLog: [] },
            { id: 'ls8', actionLog: [] },
            { id: 'ls9', actionLog: [] },
        ]);
        const expectedRows = 2 + 3 + 1 + 2 + 4 + 5 + 6 + 2 + 1 + 7 + 8 + 9;

        // 只收十二面自己報的那幾檔：掃庫 / 合併 / 向量三段各有各的進度口徑，混進來會算錯
        const faceLabels = new Set(['系統外觀', '角色頭像與小屋', '歌曲封面', '捏人器部件', '相冊', '氣泡主題', '聊天圖片', '表情包', '我的頭像', '社交帖子', '群頭像', '生活模擬']);
        const events: Array<{ done: number; total: number }> = [];
        await optimizeResourceStorage(p => {
            if (faceLabels.has(p.label)) events.push({ done: p.done, total: p.total });
        });

        expect(events.length).toBe(expectedRows);                   // 每行恰好報一次
        for (const e of events) expect(e.total).toBe(expectedRows); // 總數不是估的
        // done 從 1 數到 total：不倒退、不跳號、不越過
        expect(events.map(e => e.done)).toEqual(Array.from({ length: expectedRows }, (_, i) => i + 1));
    });
});

describe('氣泡主題導出：分享文件裡不能留令牌', () => {
    // 工坊導出的 .sully-bubble.json 是給別人的，令牌只有本機認得——原樣導出，對方導進去
    // 拿到的是一串死字符串，三張圖全空，還沒有任何報錯。所以導出前必須在深拷貝上跑一遍
    // resolveBlobRefsDeep 把令牌換回內嵌 data URL。
    // 真調一次得把整個工坊界面渲染起來，代價太大，這裡用源碼錨：改壞導出這條就掛。
    const themeMakerSrc = readFileSync(new URL('../apps/ThemeMaker.tsx', import.meta.url), 'utf8');

    /** 截出 exportSavedTheme 的函數體（到第一處同縮進的收尾 `};` 為止）。 */
    function exportFnBody(): string {
        const start = themeMakerSrc.indexOf('const exportSavedTheme');
        expect(start).toBeGreaterThan(-1);
        const end = themeMakerSrc.indexOf('\n    };', start);
        expect(end).toBeGreaterThan(start);
        return themeMakerSrc.slice(start, end);
    }

    it('導出前解析令牌，解析的是副本、寫進文件的也是那份副本', () => {
        const body = exportFnBody();
        // 一、真的解析了
        const resolved = /await resolveBlobRefsDeep\((\w+)\)/.exec(body);
        expect(resolved).not.toBeNull();
        const copyName = resolved![1];
        // 二、解析的不是庫裡那份（resolveBlobRefsDeep 原地改對象，喂 theme 等於把用戶的主題改空）
        expect(copyName).not.toBe('theme');
        expect(body).toMatch(new RegExp(`const ${copyName} = cloneTheme\\(`));
        // 三、序列化進文件的是解析過的那份，不是原始入參
        expect(body).toMatch(new RegExp(`theme:\\s*${copyName}\\b`));
        expect(body.indexOf('resolveBlobRefsDeep')).toBeLessThan(body.indexOf('JSON.stringify'));
    });

    it('工坊上傳的圖存的是令牌，不是 base64', () => {
        const start = themeMakerSrc.indexOf('const handleImageUpload');
        expect(start).toBeGreaterThan(-1);
        const body = themeMakerSrc.slice(start, themeMakerSrc.indexOf('\n    };', start));
        // processImage 給的是 data URL，得再過一道 migrateDataUrlToRef 才進主題
        expect(body).toMatch(/await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/updateStyle\('(backgroundImage|decoration|avatarDecoration)', result\)/);
    });
});

describe('頭像上傳：新存進去的就是令牌', () => {
    // 存量遷移只管庫裡已經躺著的那些。寫端要是沒接上，用戶每傳一張新頭像就又落一份 base64，
    // 一鍵優化跑完照樣長回來，而界面上一點區別都看不出來。真渲染一遍這幾個界面代價太大，
    // 這裡用源碼錨：四個上傳點裡哪個漏了 migrateDataUrlToRef，這組就紅。
    const readSrc = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

    /** 截出某個 handler 的函數體（到最近的一處收尾 `};` 為止；各文件縮進不同，2/4 空格都認）。 */
    function handlerBody(src: string, decl: string): string {
        const start = src.indexOf(decl);
        expect(start).toBeGreaterThan(-1);
        const ends = ['\n  };', '\n    };'].map(m => src.indexOf(m, start)).filter(i => i > start);
        expect(ends.length).toBeGreaterThan(0);
        return src.slice(start, Math.min(...ends));
    }

    it('角色頭像（角色資料頁）', () => {
        const body = handlerBody(readSrc('../apps/Character.tsx'), 'const handleFileChange');
        expect(body).toMatch(/handleChange\('avatar', await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/handleChange\('avatar', processedBase64\)/);
    });

    it('我的整體頭像（個人檔案 · 身份卡，含真實身份）', () => {
        // 個人檔案頁的整體頭像編輯收進了身份卡編輯器（真實身份也走同一個編輯器），
        // UserApp.tsx 本身不再直接處理頭像上傳。
        const body = handlerBody(readSrc('../components/user/UserPersonaEditor.tsx'), 'const handleUpload');
        expect(body).toMatch(/setDraftAvatar\(await migrateDataUrlToRef\(/);
        expect(body).not.toMatch(/setDraftAvatar\(base64\)/);
    });

    it('群頭像（群聊設置）', () => {
        const body = handlerBody(readSrc('../apps/GroupChat.tsx'), 'const handleGroupAvatarUpload');
        expect(body).toMatch(/await migrateDataUrlToRef\(/);
        // 內存那份和落庫那份必須是同一個值，否則退出重進會讀回令牌、當前界面還掛著 base64
        expect(body).not.toMatch(/avatar: base64/);
    });

    it('分角色聊天頭像：本地上傳轉令牌，圖床外鏈那條路不碰', () => {
        const src = readSrc('../components/user/PerCharAvatarPicker.tsx');
        const upload = handlerBody(src, 'const handleUpload');
        expect(upload).toMatch(/setOverride\(editingId, await migrateDataUrlToRef\(/);
        expect(upload).not.toMatch(/setOverride\(editingId, base64\)/);
        // 外鏈只是個 http 地址，本機沒有它的二進制，轉不了也不該轉
        const applyUrl = handlerBody(src, 'const applyUrl');
        expect(applyUrl).not.toMatch(/migrateDataUrlToRef/);
    });
});

describe('圖片令牌進提示詞：靠前綴判圖的地方必須認得令牌', () => {
    // 這組守衛跟「一鍵優化」不是同一件事，但它們釘的是同一次遷移裡最難查的那種壞法：
    // 判定認不出 `blobref:` 令牌時，圖明明還在庫裡，模型收到的卻是「圖片數據已不可用」，
    // 或者乾脆沒被列進附圖名單——不報錯、不破圖，從界面上一點看不出來。
    // 放在這份文件裡是因為它跟聊天圖 / 表情包的遷移同批落地，改壞遷移和改壞判定要一起紅。

    const TINY_PNG_LOCAL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const char = { id: 'c1', name: '角色', contextRangePolicyVersion: 1 } as any;
    const userProfile = { name: '小明' } as any;

    /** 只有一條圖片消息的私聊歷史，取轉寫出來的那一條。 */
    function imageHistoryEntry(content: string): any {
        return ChatPrompts.buildMessageHistory(
            [{ id: 1, charId: 'c1', role: 'user', type: 'image', content, timestamp: Date.now() } as any],
            50,
            char,
            userProfile,
            [],
        ).apiMessages[0];
    }

    it('私聊歷史：令牌形態的圖片照樣走 image_url 結構化字段', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG_LOCAL));

        const entry = imageHistoryEntry(token);

        expect(Array.isArray(entry.content)).toBe(true);
        expect(entry.content.some((p: any) => p.type === 'image_url' && p.image_url?.url === token)).toBe(true);
        // 認不出令牌時這裡會變成「圖片數據已不可用」的純文本，圖卻好端端躺在庫裡
        expect(JSON.stringify(entry.content)).not.toContain('no longer available');
    });

    it('私聊歷史：圖真丟了才說不可用（空 content 走佔位文本）', () => {
        const entry = imageHistoryEntry('');
        expect(typeof entry.content).toBe('string');
        expect(entry.content).toContain('no longer available');
    });

    it('群歷史：令牌形態的圖片進最近附圖名單，不被當正文內聯', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG_LOCAL));

        const block = buildGroupHistoryBlock(
            [{ id: 1, groupId: 'g1', charId: 'user', role: 'user', type: 'image', content: token, timestamp: Date.now() } as any],
            [],
            [],
            '小明',
        );

        expect(block.attachedImages.map(i => i.url)).toEqual([token]);
        expect(block.text).toContain('[圖片#1]');
        expect(block.text).not.toContain(token);
    });

    it('群歷史兜底：別的類型裡躺著令牌也按媒體佔位，不內聯進正文', async () => {
        // 令牌內聯進正文的代價比漏一個 URL 大得多——出門時網絡出口那層會把它還原成
        // 整段 data URL，等於把幾 MB 的 base64 焊進 prompt。
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG_LOCAL));

        const block = buildGroupHistoryBlock(
            [{ id: 1, groupId: 'g1', charId: 'user', role: 'user', type: 'text', content: token, timestamp: Date.now() } as any],
            [],
            [],
            '小明',
        );

        expect(block.text).toContain('[媒體]');
        expect(block.text).not.toContain(token);
    });
});

describe('主動消息上雲：先還原令牌再算體積預算', () => {
    // worker 那邊沒有 IndexedDB，`blobref:` 令牌到了雲端誰也解不開；而令牌只有幾十字節，
    // 先算預算再還原的話，一份「看著沒超」的包還原後可能是幾 MB。所以順序是死的：
    // 先還原，再交給 toFirePackChatMessages 算預算。
    it('還原發生在副本上：調用方那串消息一個字節都不變，令牌換成了 data URL', async () => {
        const { resolveChatMessagesForUpload } = await import('./activeMsgClient');
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const original = [
            { role: 'user', content: [{ type: 'text', text: '看這張' }, { type: 'image_url', image_url: { url: token } }] },
            { role: 'assistant', content: '好看' },
        ];
        const snapshot = JSON.stringify(original);

        const resolved = await resolveChatMessagesForUpload(original);

        // 一、令牌真的被還原成了可離線閱讀的 data URL
        const url = (resolved[0].content as any)[1].image_url.url as string;
        expect(url.startsWith('data:')).toBe(true);
        expect(isBlobRef(url)).toBe(false);
        // 二、原數組沒被就地改掉（本地這一輪還要用同一串消息）
        expect(JSON.stringify(original)).toBe(snapshot);
    });

    it('打包點真的用上了它：chat 段是「先還原、再交給體積預算」', () => {
        // 上面那條只證明函數本身好使。真正會靜默出事的是「函數寫了但沒接上」——
        // 那樣打上雲的還是令牌，worker 解不開，圖在雲端悄悄消失。
        // 真調一次 sendInstantChat 要把整個 worker 客戶端立起來，這裡用源碼錨。
        const src = readFileSync(new URL('./activeMsgClient.ts', import.meta.url), 'utf8');
        expect(src).toMatch(/messages:\s*toFirePackChatMessages\(await resolveChatMessagesForUpload\(chatMessages\)\)/);
        // 別處不許再把沒還原過的那串直接塞進去
        expect(src).not.toMatch(/toFirePackChatMessages\(chatMessages\)/);
    });
});

// ═══ 全庫對帳（從測試期的診斷卡片遷來，卡片撤了守衛留下） ═══
//
// 上面的用例都是「一個面一個面」地釘；這條反過來從全庫視角問一句：收錄清單裡的
// 每種字段各擺一份，跑完優化後還掃得出 data:image 嗎？哪個字段沒被收錄，它就會
// 按表點名。將來新收字段時往 seed 裡補一份，就能立刻知道優化器跟沒跟上。
describe('全庫對帳：收錄字段各擺一份，優化後一條 base64 都不剩', () => {
    /** 每張圖內容都不同：內容相同的會被去重合併成一份，令牌計數就對不上了。 */
    const tinyImage = (seed: string): string =>
        `data:image/png;base64,${Buffer.from(`sullyos-guard-${seed}`).toString('base64')}`;

    /** 全庫逐表 stringify，按表數 data:image 出現次數。跟優化器各算各的，
     *  兩邊對得上才說明看的是同一批數據。 */
    async function scanBase64ByStore(): Promise<Record<string, number>> {
        const db = await openDB();
        const hits: Record<string, number> = {};
        for (const store of Array.from(db.objectStoreNames)) {
            let count = 0;
            let afterKey: IDBValidKey | null = null;
            for (;;) {
                const { rows, lastKey } = await DB.getStoreRowsPage(store, afterKey, 200);
                for (const row of rows) count += (JSON.stringify(row)?.match(/data:image\//g) ?? []).length;
                if (lastKey === null || rows.length < 200) break;
                afterKey = lastKey;
            }
            if (count > 0) hits[store] = count;
        }
        return hits;
    }

    it('十二個面的收錄字段全擺上，優化後全庫掃不出一條 data:image', async () => {
        await seedStore('characters', [{
            id: 'c1', name: '角色一',
            chatBackground: tinyImage('chat-bg'),
            dateBackground: tinyImage('date-bg'),
            sprites: { normal: tinyImage('sprite-normal') },
            dateSkinSets: [{ id: 'sk1', name: '泳裝', sprites: { happy: tinyImage('skin-happy') } }],
            vrState: { chibi: { img: tinyImage('char-chibi') } },
            phoneState: { contacts: [{ id: 'ct1', name: '甲', avatar: tinyImage('contact') }] },
            companionAvatar: {
                version: 1, source: 'upload', imageRef: tinyImage('companion'),
                imageWardrobe: [{ id: 'w1', imageRef: tinyImage('companion-alt') }],
            },
            videoCallBackground: tinyImage('call-bg'),
            companionBackground: tinyImage('companion-bg'),
            specialMomentRecords: {
                whiteday_2026: {
                    image: tinyImage('moment-img'),
                    customData: { chatCard: { charAvatar: tinyImage('card-avatar') } },
                },
            },
        }]);
        await seedStore('user_profile', [{ id: 'me', name: '小明', vrState: { chibi: { img: tinyImage('my-chibi') } } }]);
        await seedStore('social_posts', [{
            id: 'p1', authorName: '甲', authorAvatar: tinyImage('post-author'), images: [], timestamp: 1,
            comments: [{ id: 'cm1', authorName: '乙', authorAvatar: tinyImage('comment-author') }],
        }]);
        await seedStore('groups', [{ id: 'g1', name: '群一', avatar: tinyImage('group') }]);
        await seedStore('life_sim', [{ id: 'ls1', actionLog: [{ turnNumber: 1, actor: '甲', actorAvatar: tinyImage('actor') }] }]);
        await seedStore('messages', [{
            id: 1, charId: 'c1', role: 'assistant', type: 'score_card', timestamp: 1,
            content: JSON.stringify({ charAvatar: tinyImage('card-content'), photoDataUrl: tinyImage('photo') }),
            metadata: {
                characterAvatar: tinyImage('call-avatar'),
                scoreCard: { charAvatar: tinyImage('card-meta'), photoDataUrl: tinyImage('photo-meta') },
                post: {
                    authorName: '甲', authorAvatar: tinyImage('shared-author'), images: [],
                    comments: [{ authorName: '乙', authorAvatar: tinyImage('shared-comment') }],
                },
            },
        }]);
        await seedStore('assets', [
            { id: 'widget_dsq', data: tinyImage('widget') },
            { id: 'spark_user_bg', data: tinyImage('spark-bg') },
            { id: 'spark_social_profile', data: JSON.stringify({ name: '小明', avatar: tinyImage('spark-avatar') }) },
            { id: 'appearance_preset_ap1', data: JSON.stringify({
                id: 'ap1', name: '預設', createdAt: 1,
                theme: { wallpaper: 'linear-gradient(#fff,#000)', launcherWidgets: { dsq: tinyImage('preset-widget') } },
                chatThemes: [{
                    id: 'ct1', name: '氣泡', type: 'custom',
                    user: { decoration: tinyImage('preset-bubble-user') },
                    ai: { avatarDecoration: tinyImage('preset-bubble-ai') },
                }],
            }) },
        ]);

        const before = await scanBase64ByStore();
        const beforeTotal = Object.values(before).reduce((a, b) => a + b, 0);
        expect(beforeTotal).toBeGreaterThan(0); // seed 本身得先被看見，全零 = 擺錯了地方

        const r = await optimizeResourceStorage();

        // 哪個字段沒被收錄，它就留在這裡按表點名
        expect(await scanBase64ByStore()).toEqual({});
        expect(r.failed).toBe(0);
        // 優化器報的轉換數 == 掃描數出來的張數，兩邊對得上才說明沒有靜默漏轉
        expect(r.converted).toBe(beforeTotal);
    });
});
