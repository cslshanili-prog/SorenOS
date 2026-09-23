// 捏人器（彼方 / 520 共用的 chibi 捏臉系統）自定義部件的 base64 ⇄ Blob 橋。
//
// 部件（CustomCreatorPart.src / shadowSrc）歷來是 base64 PNG 存進 cc_custom_parts store，
// PSD 整批導入一次能塞幾十個，很吃 IndexedDB 配額。這裡把「存儲」改成 Blob（blobref 令牌），
// 而「消費」側仍要 base64——因為部件要跨 iframe（character_creator.html）用 postMessage 注入，
// iframe 裡直接 `<img src="${it.src}">`。所以：落庫轉令牌、讀出轉回 base64，iframe 契約不動。
//
// 內置素材不經這裡：它們是 base64 內嵌在 character_creator.html 靜態文件裡，走 bundle / HTTP
// 緩存，不佔 IndexedDB，無需也無法轉。

import type { CustomCreatorPart } from '../types';
import { isBlobRef, migrateDataUrlToRef, resolveRefToDataUrl } from './blobRef';
import { DB } from './db';

/** 落庫前：把 base64 的 src / shadowSrc 轉成 blobref 令牌（已是令牌 / http 的原樣保留）。 */
export async function creatorPartToBlobRefs(part: CustomCreatorPart): Promise<CustomCreatorPart> {
    const out: CustomCreatorPart = { ...part };
    if (out.src && out.src.startsWith('data:')) out.src = await migrateDataUrlToRef(out.src);
    if (out.shadowSrc && out.shadowSrc.startsWith('data:')) out.shadowSrc = await migrateDataUrlToRef(out.shadowSrc);
    return out;
}

/**
 * 讀取供渲染 / 注入 iframe：返回 src / shadowSrc 已解析成 base64 的部件列表。
 * 順手把仍是 base64 的存量部件惰性遷移成 Blob 令牌落庫（存量省配額，只跑一次）。
 */
export async function loadCreatorPartsForRender(): Promise<CustomCreatorPart[]> {
    const parts = await DB.getCustomCreatorParts();
    const out: CustomCreatorPart[] = [];
    for (const p of parts) {
        let dbSrc = p.src;
        let dbShadow = p.shadowSrc;
        let migrated = false;
        // 存量 data: → 令牌（落庫），遷移失敗時保持原值不丟圖
        if (dbSrc && dbSrc.startsWith('data:')) {
            const r = await migrateDataUrlToRef(dbSrc);
            if (isBlobRef(r)) { dbSrc = r; migrated = true; }
        }
        if (dbShadow && dbShadow.startsWith('data:')) {
            const r = await migrateDataUrlToRef(dbShadow);
            if (isBlobRef(r)) { dbShadow = r; migrated = true; }
        }
        if (migrated) {
            try { await DB.saveCustomCreatorPart({ ...p, src: dbSrc, shadowSrc: dbShadow }); } catch { /* ignore */ }
        }
        // 解析成 base64 供 <img> / iframe 用
        out.push({
            ...p,
            src: await resolveRefToDataUrl(dbSrc),
            shadowSrc: dbShadow ? await resolveRefToDataUrl(dbShadow) : undefined,
        });
    }
    return out;
}
