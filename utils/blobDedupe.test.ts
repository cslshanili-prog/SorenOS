import { describe, it, expect, beforeEach } from 'vitest';
import { DB, openDB } from './db';
import { rewriteBlobRefs, rewriteRefsInText, rewriteRefsDeep, collectUnmergeableRefs, buildMergePlan } from './blobDedupe';
import { REF_SOURCE_STORES, runBlobGc } from './blobGc';
import { putImageBlob, getBlobForRef, BLOBREF_PREFIX } from './blobRef';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock } from './maintenanceLock';

// fake-indexeddb 已由 test-setup.ts 注入。
// 這組用例釘住令牌合併（引用搬家）的幾條生死線：
//   1. 邊界：令牌 A 是令牌 B 的前綴時，改 A 不能傷到 B（裸字符串 replaceAll 會踩）；
//   2. 行的完整性：Blob / Date 這類非 JSON 值必須原樣留著（stringify→parse 往返會毀）；
//   3. 覆蓋面：嵌套 JSON 字符串、localStorage、各引用面表都要改到，且與 GC 同源；
//   4. 入參體檢：自指 / 鏈式 / 保留方沒有 Blob 一律拒絕（改錯不可逆）；
//   5. 端到端：改寫後跑 GC，重複的 Blob 被回收、保留方與圖都還在。

const tinyBlob = (byte: string) => new Blob([byte], { type: 'image/png' });

async function clearStore(name: string): Promise<void> {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

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

async function readRow(name: string, key: IDBValidKey): Promise<any> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(name, 'readonly');
        const req = tx.objectStore(name).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

beforeEach(async () => {
    for (const s of ['blob_assets', 'characters', 'messages', 'songs', 'assets', 'cc_custom_parts']) {
        await clearStore(s);
    }
    localStorage.clear();
});

describe('文本改寫的邊界', () => {
    it('令牌 A 是令牌 B 的前綴時，改 A 不傷 B', () => {
        const a = `${BLOBREF_PREFIX}b_aaa`;
        const b = `${BLOBREF_PREFIX}b_aaa_bbb`;
        const keep = `${BLOBREF_PREFIX}b_keep`;
        const text = `前 ${a} 中 ${b} 後`;

        expect(rewriteRefsInText(text, new Map([[a, keep]])))
            .toBe(`前 ${keep} 中 ${b} 後`);
    });

    it('表裡沒有的令牌原樣留下', () => {
        const other = `${BLOBREF_PREFIX}b_other`;
        expect(rewriteRefsInText(`x ${other} y`, new Map([[`${BLOBREF_PREFIX}b_zzz`, `${BLOBREF_PREFIX}b_keep`]])))
            .toBe(`x ${other} y`);
    });

    it('緊貼在 JSON 引號 / 逗號之間的令牌照樣命中', () => {
        const from = `${BLOBREF_PREFIX}b_1`;
        const to = `${BLOBREF_PREFIX}b_2`;
        const json = JSON.stringify({ wallpaper: from, list: [from] });
        expect(rewriteRefsInText(json, new Map([[from, to]])))
            .toBe(JSON.stringify({ wallpaper: to, list: [to] }));
    });
});

describe('對象樹改寫：只碰 string，別的原樣', () => {
    it('Blob / Date / 數字 / null 一律不動，令牌照改', () => {
        const from = `${BLOBREF_PREFIX}b_1`;
        const to = `${BLOBREF_PREFIX}b_2`;
        const when = new Date('2020-01-01T00:00:00.000Z');
        const binary = tinyBlob('x');
        const row: any = { avatar: from, when, binary, count: 3, nothing: null, nested: { img: from } };

        expect(rewriteRefsDeep(row, new Map([[from, to]]))).toBe(true);
        expect(row.avatar).toBe(to);
        expect(row.nested.img).toBe(to);
        // 這三條釘的是「別 JSON.stringify 整行再 parse 回來」——那樣 Date 會變字符串、Blob 變 {}
        expect(row.when).toBeInstanceOf(Date);
        expect(row.binary).toBeInstanceOf(Blob);
        expect(row.count).toBe(3);
        expect(row.nothing).toBeNull();
    });

    it('沒命中任何令牌時返回 false（調用方據此跳過寫回）', () => {
        const row = { avatar: `${BLOBREF_PREFIX}b_other`, text: '普通文字' };
        expect(rewriteRefsDeep(row, new Map([[`${BLOBREF_PREFIX}b_1`, `${BLOBREF_PREFIX}b_2`]]))).toBe(false);
    });

    it('循環引用不死循環', () => {
        const from = `${BLOBREF_PREFIX}b_1`;
        const to = `${BLOBREF_PREFIX}b_2`;
        const a: any = { img: from };
        a.self = a;
        expect(rewriteRefsDeep(a, new Map([[from, to]]))).toBe(true);
        expect(a.img).toBe(to);
    });
});

describe('全引用面改寫', () => {
    it('表行、嵌套 JSON 字符串、localStorage 一起改到', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const dup = await putImageBlob(tinyBlob('a'));

        // 順手在行裡塞 Date / Blob：寫回路徑也不許把非 JSON 值弄丟
        const when = new Date('2020-01-01T00:00:00.000Z');
        await seedStore('characters', [{
            id: 'c1', avatar: dup, createdAt: when, voiceClip: tinyBlob('v'),
            roomConfig: { items: [{ id: 'i1', image: dup }] },
        }]);
        await seedStore('songs', [{ id: 's1', coverImage: dup }]);
        // assets 的外觀預設：令牌藏在一段 JSON 文本里
        await DB.saveAsset('appearance_preset_1', JSON.stringify({ theme: { wallpaper: dup } }));
        localStorage.setItem('acnh_wallpaper_backup', dup);

        const r = await rewriteBlobRefs(new Map([[dup, keep]]));

        expect((await readRow('characters', 'c1')).avatar).toBe(keep);
        expect((await readRow('characters', 'c1')).roomConfig.items[0].image).toBe(keep);
        expect((await readRow('characters', 'c1')).createdAt).toBeInstanceOf(Date);
        expect((await readRow('characters', 'c1')).voiceClip).toBeInstanceOf(Blob);
        expect((await readRow('songs', 's1')).coverImage).toBe(keep);
        expect(JSON.parse((await DB.getAsset('appearance_preset_1'))!).theme.wallpaper).toBe(keep);
        expect(localStorage.getItem('acnh_wallpaper_backup')).toBe(keep);
        expect(r.rewrittenRows).toBe(3);
        expect(r.rewrittenLocalKeys).toBe(1);
    });

    it('沒有任何引用命中時一行都不寫回，也不報「合併了幾份」', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const dup = await putImageBlob(tinyBlob('a'));
        await seedStore('characters', [{ id: 'c1', avatar: '普通頭像' }]);

        const r = await rewriteBlobRefs(new Map([[dup, keep]]));
        expect(r.rewrittenRows).toBe(0);
        expect(r.scannedRows).toBeGreaterThan(0);
        // 映射裡有它、庫裡也確實有兩份一樣的 Blob，但沒人引用 dup —— 這一輪什麼都沒合併成。
        // 按映射條數報帳就會虛報出一筆並不存在的收益（合併後的孤兒 Blob 會一直被重複掃出來）。
        expect(r.mergedRefs.size).toBe(0);
    });

    it('只統計真改掉的那些令牌', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const usedDup = await putImageBlob(tinyBlob('a'));
        const orphanDup = await putImageBlob(tinyBlob('a'));
        await seedStore('characters', [{ id: 'c1', avatar: usedDup }]);

        const r = await rewriteBlobRefs(new Map([[usedDup, keep], [orphanDup, keep]]));
        expect([...r.mergedRefs]).toEqual([usedDup]);
    });

    it('空映射直接返回，不掃庫', async () => {
        const r = await rewriteBlobRefs(new Map());
        expect(r).toEqual({ rewrittenRows: 0, rewrittenLocalKeys: 0, scannedRows: 0, mergedRefs: new Set() });
    });
});

describe('入參體檢（改錯不可逆，一律拒絕）', () => {
    it('令牌指向自己 → 拋', async () => {
        const t = await putImageBlob(tinyBlob('a'));
        await expect(rewriteBlobRefs(new Map([[t, t]]))).rejects.toThrow(/指向自己/);
    });

    it('鏈式映射（A→B 同時 B→C）→ 拋', async () => {
        const a = await putImageBlob(tinyBlob('a'));
        const b = await putImageBlob(tinyBlob('a'));
        const c = await putImageBlob(tinyBlob('a'));
        await expect(rewriteBlobRefs(new Map([[a, b], [b, c]]))).rejects.toThrow(/一跳/);
    });

    it('保留方讀不到 Blob → 拋，且一行都沒改', async () => {
        const dup = await putImageBlob(tinyBlob('a'));
        const ghost = `${BLOBREF_PREFIX}b_ghost`;
        await seedStore('characters', [{ id: 'c1', avatar: dup }]);

        await expect(rewriteBlobRefs(new Map([[dup, ghost]]))).rejects.toThrow(/[读讀]不到 Blob/);
        expect((await readRow('characters', 'c1')).avatar).toBe(dup);
    });
});

describe('與孤兒 GC 的配合', () => {
    it('清單守衛：改寫走的引用面就是 GC 的那一份', () => {
        // 兩邊共用同一個常量——GC 能 mark 到的面，改寫就能改到。
        // 換成各自維護的清單時，這條會紅。
        expect(REF_SOURCE_STORES.length).toBeGreaterThan(0);
        expect([...REF_SOURCE_STORES]).toEqual(
            [
                'characters', 'messages', 'cc_custom_parts', 'songs', 'gallery', 'assets', 'themes', 'emojis',
                'user_profile', 'social_posts', 'groups', 'character_groups', 'story_theater_masks',
                'bank_data', 'guidebook', 'life_sim', 'pixel_home_assets',
            ],
        );
    });

    it('端到端：合併引用後跑 GC，重複 Blob 被回收，保留方與圖都還在', async () => {
        const keep = await putImageBlob(tinyBlob('a'));
        const dup = await putImageBlob(tinyBlob('a'));
        await seedStore('characters', [{ id: 'c1', avatar: dup }, { id: 'c2', avatar: keep }]);

        await rewriteBlobRefs(new Map([[dup, keep]]));
        // minAgeMs: 0 關掉新鮮豁免——剛 put 的 Blob 否則會被豁免窗口保住
        const gc = await runBlobGc({ minAgeMs: 0 });

        expect(gc.aborted).toBe(false);
        expect(gc.deleted).toBe(1);
        expect(await getBlobForRef(dup)).toBeNull();
        expect(await getBlobForRef(keep)).not.toBeNull();
        expect((await readRow('characters', 'c1')).avatar).toBe(keep);
    });

    it('維護互斥：改寫由調用方持鎖，鎖被佔時 GC 乾淨拒絕', async () => {
        expect(tryAcquireMaintenanceLock('測試佔用')).toBe(true);
        try {
            await expect(runBlobGc()).rejects.toThrow(/正在[进進]行/);
        } finally {
            releaseMaintenanceLock();
        }
    });
});

describe('不參與合併的令牌（裸刪字段）', () => {
    it('五個裸刪字段的令牌全被撈出來', async () => {
        const avatar = `${BLOBREF_PREFIX}b_avatar`;
        const stage = `${BLOBREF_PREFIX}b_stage`;
        const deskBg = `${BLOBREF_PREFIX}b_deskbg`;
        const snapshot = `${BLOBREF_PREFIX}b_snap`;
        const fakeCam = `${BLOBREF_PREFIX}b_fakecam`;
        // 同一行裡的安全字段：不該被撈進來
        const roomWall = `${BLOBREF_PREFIX}b_wall`;

        await seedStore('characters', [{
            id: 'c1',
            companionAvatar: { imageRef: avatar },
            videoCallBackground: stage,
            companionBackground: deskBg,
            roomConfig: { wallImage: roomWall },
        }]);
        await seedStore('messages', [{ id: 1, metadata: { cameraSnapshotRef: snapshot } }]);
        localStorage.setItem('sully-call-fake-camera-image-v1', fakeCam);

        const refs = await collectUnmergeableRefs();
        expect([...refs].sort()).toEqual([avatar, deskBg, fakeCam, snapshot, stage].sort());
        expect(refs.has(roomWall)).toBe(false);
    });

    it('衣櫃條目的令牌也被撈出來（跟頂層 imageRef 共用令牌，換圖時會跟著一起刪）', async () => {
        const active = `${BLOBREF_PREFIX}b_active`;
        const spare = `${BLOBREF_PREFIX}b_spare`;

        await seedStore('characters', [{
            id: 'c1',
            companionAvatar: {
                imageRef: active,
                imageWardrobe: [
                    { id: active, imageRef: active, fileName: '現在穿的.png' },
                    { id: spare, imageRef: spare, fileName: '備用.png' },
                ],
            },
        }]);

        const refs = await collectUnmergeableRefs();
        expect([...refs].sort()).toEqual([active, spare].sort());
    });

    it('imageWardrobe 不是數組時照常收頂層，不炸', async () => {
        const active = `${BLOBREF_PREFIX}b_active`;
        await seedStore('characters', [
            { id: 'c1', companionAvatar: { imageRef: active, imageWardrobe: '壞數據' } },
            { id: 'c2', companionAvatar: { imageWardrobe: null } },
        ]);
        expect([...await collectUnmergeableRefs()]).toEqual([active]);
    });

    it('字段是普通圖片地址 / 空值時不誤收', async () => {
        await seedStore('characters', [{
            id: 'c1',
            companionAvatar: { imageRef: 'https://example.com/a.png' },
            videoCallBackground: '',
            companionBackground: undefined,
        }]);
        expect((await collectUnmergeableRefs()).size).toBe(0);
    });
});

describe('合併計劃', () => {
    const g = (canonical: string, duplicates: string[], wastedBytes = 100) => ({
        canonical, duplicates, wastedBytes, size: duplicates.length ? wastedBytes / duplicates.length : wastedBytes,
    });

    it('普通重複組收斂成一跳映射', () => {
        const plan = buildMergePlan([g('t_a', ['t_b', 't_c'])], new Set());
        expect([...plan.mapping]).toEqual([['t_b', 't_a'], ['t_c', 't_a']]);
        expect(plan.skippedGroups).toBe(0);
        expect(plan.reclaimableBytes).toBe(100);
    });

    it('保留方被裸刪字段引用 → 整組跳過', () => {
        const plan = buildMergePlan([g('t_a', ['t_b'])], new Set(['t_a']));
        expect(plan.mapping.size).toBe(0);
        expect(plan.skippedGroups).toBe(1);
        expect(plan.reclaimableBytes).toBe(0);
    });

    it('被合併方被裸刪字段引用 → 同樣整組跳過（只剔掉它並不能讓剩下的變安全）', () => {
        const plan = buildMergePlan([g('t_a', ['t_b', 't_c'])], new Set(['t_c']));
        expect(plan.mapping.size).toBe(0);
        expect(plan.skippedGroups).toBe(1);
    });

    it('安全組照常合併，跳過的組不計入可回收字節', () => {
        const plan = buildMergePlan(
            [g('t_a', ['t_b'], 100), g('t_x', ['t_y'], 500)],
            new Set(['t_y']),
        );
        expect([...plan.mapping]).toEqual([['t_b', 't_a']]);
        expect(plan.skippedGroups).toBe(1);
        expect(plan.reclaimableBytes).toBe(100);
    });

    it('空 duplicates 的組直接忽略', () => {
        const plan = buildMergePlan([g('t_a', [])], new Set());
        expect(plan.mapping.size).toBe(0);
        expect(plan.skippedGroups).toBe(0);
    });
});
