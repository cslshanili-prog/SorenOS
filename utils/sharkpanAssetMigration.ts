/**
 * 老用戶數據裡的鯊盤（sharkpan）圖鏈接一次性改寫成 jsDelivr。
 *
 * 背景：Sully 的表情包、家園情緒立繪、小屋傢俱、見面皮膚等默認素材原先掛在 sharkpan 圖床
 * （不穩定、常拉不到）。源碼常量已改為素材倉庫 jsDelivr 路徑，但【已經裝過】的用戶 IndexedDB
 * 裡存的仍是老鯊盤鏈接——只改源碼只能救新用戶。這裡在啟動時把這些庫存鏈接就地改寫，救現有用戶。
 *
 * 只替換【精確匹配】的已知鯊盤 URL（下表 30 條），絕不碰用戶自己上傳的圖；
 * bank 背景圖（bg.png）用戶選擇不遷、head.png 已單獨處理，都不在表內。
 */

import { DB } from './db';

const BASE = 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/';

// 鯊盤完整 URL -> jsDelivr 完整 URL（文件名保持不變，與源碼常量一致）。
export const SHARKPAN_ASSET_MAP: Record<string, string> = Object.fromEntries(
    [
        ['https://sharkpan.xyz/f/pWg6HQ/night.png', 'night.png'],
        ['https://sharkpan.xyz/f/75wvuj/w.png', 'w.png'],
        ['https://sharkpan.xyz/f/MK77Ia/see.png', 'see.png'],
        ['https://sharkpan.xyz/f/3WwMHe/fight.png', 'fight.png'],
        ['https://sharkpan.xyz/f/5nwxCj/an.png', 'an.png'],
        ['https://sharkpan.xyz/f/ylWpfN/sDN.png', 'sDN.png'],
        ['https://sharkpan.xyz/f/QdnaU6/sorry.png', 'sorry.png'],
        ['https://sharkpan.xyz/f/5nrJsj/wait.png', 'wait.png'],
        ['https://sharkpan.xyz/f/w3QQFq/01.png', '01.png'],
        ['https://sharkpan.xyz/f/MKg7ta/02.png', '02.png'],
        ['https://sharkpan.xyz/f/3WnMce/03.png', '03.png'],
        ['https://sharkpan.xyz/f/5n1xSj/04.png', '04.png'],
        ['https://sharkpan.xyz/f/kdwet6/05.png', '05.png'],
        ['https://sharkpan.xyz/f/oWZQF4/S2.png', 'S2.png'],
        ['https://sharkpan.xyz/f/A3XeUZ/BED.png', 'BED.png'],
        ['https://sharkpan.xyz/f/G5n3Ul/DNZ.png', 'DNZ.png'],
        ['https://sharkpan.xyz/f/zlpWS5/SG.png', 'SG.png'],
        ['https://sharkpan.xyz/f/85K5ij/DDB.png', 'DDB.png'],
        ['https://sharkpan.xyz/f/75Nvsj/LJT.png', 'LJT.png'],
        ['https://sharkpan.xyz/f/NdJyhv/b.png', 'b.png'],
        ['https://sharkpan.xyz/f/m3adhW/Vha.png', 'Vha.png'],
        ['https://sharkpan.xyz/f/BZgDfa/Vsad.png', 'Vsad.png'],
        ['https://sharkpan.xyz/f/4rzdtj/VNormal.png', 'VNormal.png'],
        ['https://sharkpan.xyz/f/NdlVfv/VAn.png', 'VAn.png'],
        ['https://sharkpan.xyz/f/VyontY/Vshy.png', 'Vshy.png'],
        ['https://sharkpan.xyz/f/xl8muX/VBl.png', 'VBl.png'],
        ['https://sharkpan.xyz/f/dDzLi8/001.png', '001.png'],
        ['https://sharkpan.xyz/f/lmD6Tx/002.png', '002.png'],
        ['https://sharkpan.xyz/f/gXayCw/XT.png', 'XT.png'],
        ['https://sharkpan.xyz/f/2WzAFQ/CAFE.png', 'CAFE.png'],
    ].map(([old, name]) => [old, BASE + name]),
);

/** 把字符串裡所有已知鯊盤鏈接替換成 jsDelivr。無已知鏈接則原樣返回（省掉無謂改寫）。 */
export function rewriteSharkpanUrls(s: string): string {
    if (!s.includes('sharkpan.xyz')) return s;
    let out = s;
    for (const [oldUrl, newUrl] of Object.entries(SHARKPAN_ASSET_MAP)) {
        if (out.includes(oldUrl)) out = out.split(oldUrl).join(newUrl);
    }
    return out;
}

const MIGRATION_FLAG = 'sharkpan_assets_migrated_v1';

/**
 * 啟動時調用一次：把表情包 + 角色（立繪/傢俱/見面皮膚，可能深層嵌套）裡存的鯊盤鏈接
 * 改寫成 jsDelivr。冪等；跑成功後打標記跳過後續啟動。任何異常吞掉，絕不阻斷啟動。
 */
export async function migrateSharkpanAssets(): Promise<void> {
    try { if (localStorage.getItem(MIGRATION_FLAG) === '1') return; } catch { /* localStorage 不可用：照跑 */ }

    try {
        // 表情包：逐行改 url（keyPath=name，saveEmoji 同名覆蓋）
        const emojis = await DB.getRawStoreData('emojis');
        for (const e of emojis) {
            if (e && typeof e.url === 'string' && e.url.includes('sharkpan.xyz')) {
                const nu = rewriteSharkpanUrls(e.url);
                if (nu !== e.url) await DB.saveEmoji(e.name, nu, e.categoryId);
            }
        }

        // 角色：整體序列化後深層替換（立繪 sprites / 小屋 roomConfig / 見面 dateSkinSets 都能一網打盡）
        const chars = await DB.getAllCharacters();
        for (const c of chars) {
            const s = JSON.stringify(c);
            if (!s.includes('sharkpan.xyz')) continue;
            const ns = rewriteSharkpanUrls(s);
            if (ns !== s) await DB.saveCharacter(JSON.parse(ns));
        }

        try { localStorage.setItem(MIGRATION_FLAG, '1'); } catch { /* ignore */ }
    } catch (err) {
        console.warn('[migrateSharkpanAssets] 遷移失敗（不影響啟動，下次再試）', err);
    }
}
