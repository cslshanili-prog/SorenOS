/**
 * Memory Palace — 房間門牌（Room Plates）
 *
 * 情景→語義的固化終點。房間裝原始經歷（MemoryNode，走向量召回），
 * 門牌寫這些經歷沉澱出的常駐認知（PlateEntry，每輪直接注入 System Prompt）。
 *
 * 兩個更新觸發點：
 *   1. EventBox 壓縮/封盒（eventBoxCompression.ts）→ updatePlateFromBoxSummary()
 *      —— 盒子的結論就是最好的蒸餾原料，封盒即沉澱
 *   2. 認知消化（digestion.ts，50輪/手動）→ consolidateAllPlates()
 *      —— 四塊門牌一次全量整理，容量壓力擠掉過時條目
 *
 * 合併語義（不是追加）：LLM 每次輸出目標房間的**完整**新條目列表，
 * 舊條目不被重新輸出即被淘汰；帶 basedOn 引用的條目繼承 firstLearnedAt
 * 與 sourceCount（"這條認知是什麼時候得知的、被印證過幾次"）。
 *
 * 臥室門牌「我們之間」硬規則：只寫現象與質地，禁止給關係命名——
 * 定義只存在於質地的負空間裡。prompt 層約束 + mergePlateEntries 兜底過濾。
 */

import type { MemoryNode, PlateRoom, RoomPlate } from './types';
import { PLATE_ROOMS, PLATE_TITLES } from './types';
import { MemoryNodeDB, RoomPlateDB, loadOrCreatePlate, mutatePlate } from './db';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import {
    PLATE_LLM_MAX_TOKENS,
    PLATE_LLM_TEMPERATURE,
    PLATE_LLM_TIMEOUT_MS,
    PLATE_USER_TURN,
    buildPlateConsolidationPrompt,
    mergeSubmissionsIntoEntries,
    parsePlateLlmReply,
} from './roomPlateCore';

// 提示詞拼裝、回覆解析、合併語義都搬進 roomPlateCore 了——瀏覽器和 amsg worker
// 共用同一份，各寫一份會讓同一批材料在兩條路上整理出不一樣的門牌。這裡只留
// 「讀庫 → 調用 → 落庫」的編排。原有導出原樣轉發，調用方與單測不受影響。
export {
    isPlateRoom,
    mergePlateEntries,
    parseSubmissionLine,
    violatesBedroomRule,
} from './roomPlateCore';
export type { PlateLLMItem, PlateMaterial } from './roomPlateCore';
import type { PlateLLMItem, PlateMaterial } from './roomPlateCore';
import { isPlateRoom, mergePlateEntries } from './roomPlateCore';

// ─── LLM 蒸餾調用 ─────────────────────────────────────

/**
 * 一次 LLM 調用整理若干房間的門牌（瀏覽器側那條路）。
 * 輸入：每房間的現有條目（帶標籤）+ 新原料；輸出：每房間完整的新條目列表。
 *
 * 請求仍走 safeFetchJson——那份帶著「設置 → API 調用記錄」的埋點，是瀏覽器側的東西。
 * 提示詞與解析共用 roomPlateCore，跟雲端那條路一字不差。
 */
async function callPlateLLM(
    charName: string,
    userName: string,
    plates: RoomPlate[],
    materials: PlateMaterial[],
    llmConfig: LightLLMConfig,
    identityContext: string,
): Promise<PlateLLMItem[]> {
    const systemPrompt = buildPlateConsolidationPrompt({
        charName,
        userName,
        identityContext,
        plates: plates.map(p => ({ room: p.room, entries: p.entries.map(e => e.text) })),
        materials,
    });

    const data = await safeFetchJson(
        `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${llmConfig.apiKey}`,
            },
            body: JSON.stringify({
                model: llmConfig.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: PLATE_USER_TURN },
                ],
                temperature: PLATE_LLM_TEMPERATURE,
                max_tokens: PLATE_LLM_MAX_TOKENS,
                stream: false,
            }),
        },
        2, PLATE_LLM_TIMEOUT_MS, { appName: '記憶宮殿', purpose: '門牌整理' }
    );

    return parsePlateLlmReply(data.choices?.[0]?.message?.content || '');
}

/**
 * 送達保證兜底：把消化剛提交的候選**機械併入**門牌——同文本去重、容量上限、
 * 臥室命名過濾照常，不做改寫重排。沒有這一步，候選會靜默蒸發：消化日誌記著"已提交"，
 * 門牌上卻什麼都沒有（提交的源節點已打 digestedAt，不會再來第二次）。
 * 下輪整理 LLM 會重排這些條目。
 *
 * 兩條路都用它，但時機不同，所以 `why` 要說清是哪一種，別讓日誌誤報：
 * 本地那條路是 LLM 整理沒跑成（報錯/輸出解析為空）之後才兜底；
 * 上雲那條路是**提交之前**先並進去保底——那時整理還沒開始，什麼都沒失敗。
 */
async function fallbackMergeSubmissions(
    plates: RoomPlate[],
    submissions: Partial<Record<PlateRoom, string[]>>,
    now: number,
    why: string = 'LLM 整理未跑成',
): Promise<PlateRoom[]> {
    const updated: PlateRoom[] = [];
    for (const plate of plates) {
        const lines = submissions[plate.room];
        if (!lines || lines.length === 0) continue;
        const before = plate.entries.length;
        // 走 mutatePlate：這塊門牌上還有別的路在寫（雲端結果落地、門牌面板的手改），
        // 拿手上這份改完整塊存回去就是把中間那次更新原地抹掉。
        const saved = await mutatePlate(plate.charId, plate.room, fresh => {
            const merged = mergeSubmissionsIntoEntries(fresh.room, fresh.entries, lines, now);
            return merged ? { ...fresh, entries: merged, updatedAt: now, version: fresh.version + 1 } : null;
        });
        if (!saved) continue;
        // 手上這份也要跟著換成落庫後的那份：調用方隨後拿 plates 當快照交給雲端 / 交給
        // 本地 LLM，留著併入之前那份的話，這批剛保底的候選在 LLM 眼裡壓根不存在。
        plate.entries = saved.entries;
        plate.updatedAt = saved.updatedAt;
        plate.version = saved.version;
        updated.push(plate.room);
        console.warn(`🚪 [RoomPlate] 兜底併入「${PLATE_TITLES[plate.room]}」${saved.entries.length - before} 條候選（${why}）`);
    }
    return updated;
}

/**
 * 核心流程：加載目標門牌 → LLM 整理 → 合併落庫。
 *
 * LLM 輸出裡**一個條目都沒提到的房間**跳過保存——區分"LLM 決定清空"
 * 和"LLM 忘了這個房間/輸出被截斷"，寧可保守不動，等下輪消化再整理。
 * LLM 整體失敗/輸出為空時，prioritySubmissions（消化剛提交的候選）走機械兜底併入。
 *
 * `preferCloud` 的那條路見 roomPlateCloud.ts：整理交給用戶自己的 CF Worker 跑，
 * 頁面關著也能跑完，結果晚點回來再合併落庫。交不出去就原地退回本地跑。
 */
async function consolidatePlates(
    charId: string,
    charName: string,
    userName: string,
    materials: PlateMaterial[],
    llmConfig: LightLLMConfig,
    prioritySubmissions?: Partial<Record<PlateRoom, string[]>>,
    preferCloud = false,
): Promise<{ updated: PlateRoom[]; cloudPending?: boolean }> {
    const rooms = materials.map(m => m.room);
    // 快照時刻要在**讀之前**取。讀完門牌之後還要拼身份上下文、過一遍能不能交雲端那幾道門
    // （其中一道要發請求）、把消化剛提交的候選先保底並進去，才輪到提交；這一段少則幾百
    // 毫秒、多則好幾秒，期間用戶在門牌面板上改的字 LLM 是看不到的。取在讀之後（更別說
    // 取在提交那一刻）就會把這段時間的編輯漏判成「LLM 見過」，一份陳舊結果回來把用戶剛
    // 敲的字原樣蓋回去。寧可反過來錯——頂多丟掉整理結果對那一條的改寫。
    const snapshotAt = Date.now();
    const plates = await Promise.all(rooms.map(r => loadOrCreatePlate(charId, r)));

    const hasMaterial = materials.some(m => m.lines.length > 0);
    const hasEntries = plates.some(p => p.entries.length > 0);
    if (!hasMaterial && !hasEntries) {
        return { updated: [] };
    }

    /** 交雲端失敗之前，送達保證已經當場併入的房間。退回本地跑也要連它們一起報。 */
    let cloudRescued: PlateRoom[] = [];
    const withRescued = (updated: PlateRoom[]) => ({ updated: [...new Set([...cloudRescued, ...updated])] });

    // 身份上下文：直接走 ContextBuilder.buildCoreContext(char, user, false)——
    // 與全 App 統一的人設口徑（身份/核心指令/世界觀/用戶畫像/印象/核心記憶），不重複造輪子。
    // includeDetailedMemories=false：不帶詳細日誌與向量召回，整理 LLM 用不上。
    // 尤其是回填場景，材料橫跨幾個月，沒有人設參照時蒸餾視角會飄。
    let identityContext = '';
    try {
        const { DB } = await import('../db');
        const { ContextBuilder } = await import('../context');
        const chars = await DB.getAllCharacters();
        const profile = chars.find(c => c.id === charId);
        const up = await DB.getUserProfile();
        if (profile && up) identityContext = ContextBuilder.buildCoreContext(profile, up, false);
    } catch { /* 拿不到就裸跑，prompt 裡仍有名字與身份確認段 */ }

    if (preferCloud) {
        const cloud = await tryCloudConsolidation({
            charId, charName, userName, identityContext, plates, materials, llmConfig, prioritySubmissions, snapshotAt,
        });
        if (cloud.handled) return { updated: cloud.updated, cloudPending: cloud.pending };
        // 交不出去（沒配 worker / 副 API 缺字段 / 服務端答覆了不行）→ 原地退回本地跑。
        // plates 可能已經被上面的送達保證併入過候選，本地這輪拿到的就是併入後的那份，
        // LLM 的完整新列表照常覆蓋它。
        cloudRescued = cloud.rescued;
    }

    let items: PlateLLMItem[] = [];
    try {
        items = await callPlateLLM(charName, userName, plates, materials, llmConfig, identityContext);
    } catch (e: any) {
        console.warn(`🚪 [RoomPlate] LLM 整理調用失敗: ${e?.message || e}`);
    }
    if (items.length === 0) {
        console.warn(`🚪 [RoomPlate] LLM 未返回有效條目，門牌保持不動`);
        if (prioritySubmissions) {
            return withRescued(await fallbackMergeSubmissions(plates, prioritySubmissions, Date.now()));
        }
        return withRescued([]);
    }

    const now = Date.now();
    const updated: PlateRoom[] = [];
    const skippedPlates: RoomPlate[] = [];
    for (const plate of plates) {
        const roomItems = items.filter(i => i.room === plate.room);
        if (roomItems.length === 0) { skippedPlates.push(plate); continue; }
        // 同上：這塊門牌上還有別的路在寫，落庫統一走 mutatePlate 那條隊。
        const saved = await mutatePlate(plate.charId, plate.room, fresh => ({
            ...fresh,
            entries: mergePlateEntries(fresh.room, fresh.entries, roomItems, now),
            updatedAt: now,
            version: fresh.version + 1,
        }));
        if (!saved) continue;
        plate.entries = saved.entries;
        plate.updatedAt = saved.updatedAt;
        plate.version = saved.version;
        updated.push(plate.room);
        console.log(`🚪 [RoomPlate] 「${PLATE_TITLES[plate.room]}」v${saved.version}：${saved.entries.length} 條`);
    }
    // 半失敗態：LLM 只給部分房間輸出了條目。沒被提到的房間若有本次提交的候選，
    // 同樣機械兜底併入——按房間粒度保證送達。
    if (prioritySubmissions && skippedPlates.length > 0) {
        const rescued = await fallbackMergeSubmissions(skippedPlates, prioritySubmissions, now);
        updated.push(...rescued);
    }
    return withRescued(updated);
}

/**
 * 交雲端這一輪的三種結局。
 *
 * `handled: false` 那支要把 `rescued` 一起交回去：送達保證已經真的把候選並進門牌、
 * 落庫、升過版本號了。丟掉的話消化日誌會說「這次一塊門牌都沒動」，而門牌上明明多了
 * 幾條——本地那條路末尾的兜底併入是按文本去重的，那批已經在裡面了，它一條也不會再報。
 */
type CloudConsolidationOutcome =
    /**
     * 雲端接手了。`pending` = **雲端正有一份整理在跑、結果會晚點落地**——這一輪剛交上去
     * 的算，上一份還沒回來所以這輪沒重複交的也算。它最後決定消化日誌上說哪句話，問的是
     * 「門牌等會兒還會不會動」，不是「這一輪交沒交」。兩者混起來的話，第二種會被寫成
     * 「⚠️ 本次提交的候選未合併進門牌（整理未跑成或未被採納）」——而它正在用戶自己的
     * Worker 上好好跑著，幾分鐘後就落地。
     */
    | { handled: true; updated: PlateRoom[]; pending: boolean }
    /** 交不出去，調用方退回本地跑。`rescued` 是送達保證當場併入的房間。 */
    | { handled: false; rescued: PlateRoom[] };

/**
 * 試著把這一輪整理交給雲端。雲端接手了（交出去了 / 上一份還在跑）就返回 `handled: true`
 * ——`updated` 只有送達保證當場併入的那些，整理結果要等它回來才落地；交不出去返回
 * `handled: false`，調用方退回本地跑。
 *
 * **送達保證要前置**：本地那條路是「LLM 掛了才機械併入候選」，而上雲之後「掛沒掛」
 * 要幾分鐘後才知道，候選的源節點卻已經打了 digestedAt、不會再來第二次。所以改成
 * 先並進去保底，再把併入後的門牌當快照交上去——雲端整理出的完整新列表會把這批粗糙
 * 條目改寫掉，雲端要是最終沒回來，它們也已經在門牌上了，不會靜默蒸發。
 */
async function tryCloudConsolidation(args: {
    charId: string;
    charName: string;
    userName: string;
    identityContext: string;
    plates: RoomPlate[];
    materials: PlateMaterial[];
    llmConfig: LightLLMConfig;
    prioritySubmissions?: Partial<Record<PlateRoom, string[]>>;
    /** `plates` 是什麼時候讀的（epoch 毫秒），原樣傳給提交側記進在飛記號。 */
    snapshotAt: number;
}): Promise<CloudConsolidationOutcome> {
    // 動態 import：沒開主動消息 2.0 的用戶不該為這條路付首屏包體。
    // 只引這一個模塊——「能不能交」那幾道門也收在它裡面（plateCloudGate），
    // 判定入口分散到兩處的話，改一處漏一處就是「點了燈卻走本地」那種查不出來的靜默分流。
    const { plateCloudGate, readPlateJobInFlight, submitPlateConsolidation } = await import('./roomPlateCloud');

    const gate = await plateCloudGate({ charId: args.charId, lightLLM: args.llmConfig });
    if (gate === 'local') return { handled: false, rescued: [] };

    const rescued = args.prioritySubmissions
        ? await fallbackMergeSubmissions(args.plates, args.prioritySubmissions, Date.now(), '先保底再交雲端整理')
        : [];

    // 上一份整理還在雲端跑：這輪只做送達保證，整理本身不重複交也不退回本地——本地再全量
    // 跑一遍會白燒一次 API，跑出來的結果還會和在飛那份互相覆蓋。
    // `pending: true` —— 雲端確實有一份在跑，門牌等會兒就會動。報 false 的話，候選恰好
    // 都已經在門牌上（送達保證按文本去重、一條都沒並進去）的那次消化，日誌上會寫成
    // 「整理未跑成」。
    if (gate === 'skip') return { handled: true, updated: rescued, pending: true };

    try {
        await submitPlateConsolidation({
            charId: args.charId,
            charName: args.charName,
            userName: args.userName,
            identityContext: args.identityContext,
            plates: args.plates,
            materials: args.materials,
            lightLLM: args.llmConfig,
            snapshotAt: args.snapshotAt,
        });
        return { handled: true, updated: rescued, pending: true };
    } catch (e: any) {
        // 在飛記號還在 = 請求發出去了卻沒等到答覆，任務可能已經在雲端建起來了（提交那側
        // 只在「服務端答覆了不行」時才收記號）。這時候退回本地全量跑一遍，就是拿同一份
        // 快照燒兩次 API，兩份結果還先後落地互相蓋。寧可這輪不整理，等它回來。
        if (readPlateJobInFlight(args.charId)) {
            console.warn(`🚪 [RoomPlate] 交雲端整理沒等到答覆，任務可能已經建起來了，這輪不退回本地: ${e?.message || e}`);
            return { handled: true, updated: rescued, pending: true };
        }
        console.warn(`🚪 [RoomPlate] 交雲端整理失敗，退回本地跑: ${e?.message || e}`);
        return { handled: false, rescued };
    }
}

// ─── 觸發點 1：EventBox 壓縮/封盒 → 增量合併 ─────────

/**
 * 盒子壓縮完成後，把這次整合的結論合併進該房間的門牌。
 * 由 eventBoxCompression 調用；失敗只 warn，不影響壓縮結果。
 */
export async function updatePlateFromBoxSummary(
    charId: string,
    room: string,
    summaryContent: string,
    llmConfig: LightLLMConfig,
    charName: string,
    userName?: string,
): Promise<void> {
    if (!isPlateRoom(room)) return;
    if (!summaryContent?.trim()) return;
    await consolidatePlates(
        charId, charName, userName || '用戶',
        [{ room, lines: [summaryContent.trim()] }],
        llmConfig,
    );
}

// ─── 觸發點 2：認知消化 → 四塊門牌全量整理 ───────────

/** 每房間送入 LLM 的原料上限與單條截斷長度 */
const MATERIAL_NODES_PER_ROOM = 15;
const MATERIAL_LINE_MAX_CHARS = 160;
/** sinceTs 窗口之前的老節點最多留幾條高分錨點（防止每輪重複喂同一批高分老貨） */
const MATERIAL_ANCHOR_CAP = 5;

/**
 * 從房間裡挑蒸餾原料，優先級：
 *   1. 盒子 summary（已是整合過的結論）
 *   2. sinceTs 之後的新節點（按時近降序）——"這段時間的新經歷"
 *   3. sinceTs 之前的老節點按 importance 取最多 MATERIAL_ANCHOR_CAP 條錨點
 * 排除 archived（已被壓進 summary）。sinceTs=0 時全部算新節點（老行為兼容）。
 */
export function pickMaterialLines(nodes: MemoryNode[], room: PlateRoom, sinceTs: number = 0): string[] {
    const candidates = nodes.filter(n => n.room === room && !n.archived);
    const summaries = candidates.filter(n => n.isBoxSummary);
    const fresh = candidates
        .filter(n => !n.isBoxSummary && n.createdAt > sinceTs)
        .sort((a, b) => b.createdAt - a.createdAt);
    const anchors = sinceTs > 0
        ? candidates
            .filter(n => !n.isBoxSummary && n.createdAt <= sinceTs)
            .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
            .slice(0, MATERIAL_ANCHOR_CAP)
        : [];
    return [...summaries, ...fresh, ...anchors]
        .slice(0, MATERIAL_NODES_PER_ROOM)
        .map(n => n.content.replace(/\s+/g, ' ').trim().slice(0, MATERIAL_LINE_MAX_CHARS));
}

/**
 * 全量整理四塊門牌。由 runCognitiveDigestion 在消化尾聲調用，
 * 也可從 UI 手動觸發。一次 LLM 調用覆蓋全部房間。
 *
 * @param extraMaterial 消化狀態機之外提交的蒸餾候選（synthesize_user /
 *   internalize / self_insight / distill 的產出）。放在原料最前——它們是
 *   本次消化剛提煉的概括，優先級高於舊節點，且不佔節點配額。
 * @param sinceTs 上次消化時間戳：節點原料以該時間之後的新增優先，
 *   老節點只留少量高分錨點（避免每輪重複喂同一批高分老貨）。
 */
export async function consolidateAllPlates(
    charId: string,
    charName: string,
    userName: string | undefined,
    llmConfig: LightLLMConfig,
    extraMaterial?: Partial<Record<PlateRoom, string[]>>,
    sinceTs: number = 0,
): Promise<{ updated: PlateRoom[]; cloudPending?: boolean }> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);
    const materials: PlateMaterial[] = PLATE_ROOMS.map(room => {
        const extra = (extraMaterial?.[room] || [])
            .map(l => l.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .map(l => l.slice(0, MATERIAL_LINE_MAX_CHARS * 2)); // 領悟全文可到 200 字，放寬截斷
        return {
            room,
            lines: [...extra, ...pickMaterialLines(allNodes, room, sinceTs)],
        };
    });
    // extraMaterial 同時作為 prioritySubmissions 傳入：LLM 整理失敗時機械兜底併入，不許蒸發。
    //
    // 這個觸發點走雲端（配了主動消息 2.0 的話）：消化跑在一輪對話剛結束的時候，用戶
    // 大概率正準備切走，而四塊門牌全量整理是這條鏈上最慢的一次調用。同一個角色同時只許
    // 一份整理在飛（見 roomPlateCloud 的在飛記號），兩份結果先後落地就是拿兩份舊快照
    // 互相蓋。另外兩個觸發點留在本地——盒子壓縮那個一輪裡可能跑好幾次、後一次要看到前
    // 一次的結果；手動回填有進度條，批次之間也是串行依賴的。
    return consolidatePlates(charId, charName, userName || '用戶', materials, llmConfig, extraMaterial, true);
}

// ─── 歷史回填（Bootstrap — 老用戶的門牌不能從零開始） ──

/** 回填每批每房間的行數 & 單角色回填的行數上限（超出取最新的，舊尾丟棄並 log） */
const BOOTSTRAP_LINES_PER_BATCH = 12;
export const BOOTSTRAP_MAX_LINES_PER_ROOM = 240;

/**
 * 收集某房間的全部歷史原料，**時間正序**（舊→新）：
 * 分批餵給整理 LLM 時，後面的批次帶著更新的事實，合併語義自然完成 supersede——
 * 和知識真實積累的順序一致。盒子 summary 按自身 createdAt 參與排序。
 * 超過上限時丟最舊的（保留最新 N 條），返回丟棄數供 log。
 */
export function collectBootstrapNodes(
    nodes: MemoryNode[],
    room: PlateRoom,
    maxLines: number = BOOTSTRAP_MAX_LINES_PER_ROOM,
): { nodes: MemoryNode[]; dropped: number } {
    const candidates = nodes
        .filter(n => n.room === room && !n.archived)
        .sort((a, b) => a.createdAt - b.createdAt);
    const dropped = Math.max(0, candidates.length - maxLines);
    return { nodes: dropped > 0 ? candidates.slice(dropped) : candidates, dropped };
}

export function collectBootstrapLines(
    nodes: MemoryNode[],
    room: PlateRoom,
    maxLines: number = BOOTSTRAP_MAX_LINES_PER_ROOM,
): { lines: string[]; dropped: number } {
    const { nodes: kept, dropped } = collectBootstrapNodes(nodes, room, maxLines);
    return {
        lines: kept.map(n => n.content.replace(/\s+/g, ' ').trim().slice(0, MATERIAL_LINE_MAX_CHARS)),
        dropped,
    };
}

/**
 * 從歷史記憶回填門牌：把四個門牌房間的全部積壓分批過整理 LLM。
 *
 * 觸發方式：
 *   - 自動：消化尾聲發現"門牌全空但歷史可觀"時跑一次（批數受 maxBatches 限制，
 *     控制後台成本；沒掃完的部分等手動觸發補完）
 *   - 手動：記憶宮殿 App「從歷史記憶重建門牌」按鈕（全量批次 + 進度回調）
 *
 * 冪等性：合併語義天然冪等——重複回填同樣的歷史，條目被去重/合併而非翻倍。
 */
export async function bootstrapPlatesFromHistory(
    charId: string,
    charName: string,
    userName: string | undefined,
    llmConfig: LightLLMConfig,
    options: {
        maxBatches?: number;
        /** 歷史總行數低於此值直接跳過（常規整理足以覆蓋小歷史，不值得跑回填） */
        minLines?: number;
        /** 斷點續傳：從第幾批開始（0 起）。歷史近似 append-only + 穩定排序，批次邊界跨次穩定 */
        startBatch?: number;
        /** 進度回調：done/total 都是全量口徑（絕對批次序號 / 總批數） */
        onProgress?: (done: number, total: number) => void;
    } = {},
): Promise<{ updated: PlateRoom[]; batches: number; totalLines: number; neededBatches: number; nextBatch: number; complete: boolean }> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);
    const byRoom = new Map<PlateRoom, MemoryNode[]>();
    let totalLines = 0;
    for (const room of PLATE_ROOMS) {
        const { nodes: kept, dropped } = collectBootstrapNodes(allNodes, room);
        if (dropped > 0) {
            console.warn(`🚪 [Bootstrap] 「${PLATE_TITLES[room]}」歷史超上限，丟棄最舊 ${dropped} 條（保留最新 ${BOOTSTRAP_MAX_LINES_PER_ROOM}）`);
        }
        byRoom.set(room, kept);
        totalLines += kept.length;
    }
    if (totalLines === 0 || totalLines < (options.minLines ?? 0)) {
        return { updated: [], batches: 0, totalLines, neededBatches: 0, nextBatch: 0, complete: false };
    }

    const neededBatches = Math.max(
        ...PLATE_ROOMS.map(r => Math.ceil((byRoom.get(r)!.length) / BOOTSTRAP_LINES_PER_BATCH)),
    );
    const startBatch = Math.max(0, Math.min(options.startBatch ?? 0, neededBatches));
    const endBatch = Math.min(neededBatches, startBatch + (options.maxBatches ?? neededBatches));
    if (startBatch > 0 || endBatch < neededBatches) {
        console.log(`🚪 [Bootstrap] 本次跑第 ${startBatch + 1}~${endBatch} 批（共 ${neededBatches} 批）——沒跑完的部分下次續傳`);
    }

    const fmtLine = (n: MemoryNode) => n.content.replace(/\s+/g, ' ').trim().slice(0, MATERIAL_LINE_MAX_CHARS);
    const updatedSet = new Set<PlateRoom>();
    let ran = 0;
    let nextBatch = startBatch;
    for (let i = startBatch; i < endBatch; i++) {
        const batchNodes = PLATE_ROOMS.flatMap(room =>
            byRoom.get(room)!.slice(i * BOOTSTRAP_LINES_PER_BATCH, (i + 1) * BOOTSTRAP_LINES_PER_BATCH));
        if (batchNodes.length === 0) { nextBatch = i + 1; continue; }
        const materials: PlateMaterial[] = PLATE_ROOMS.map(room => ({
            room,
            lines: byRoom.get(room)!.slice(i * BOOTSTRAP_LINES_PER_BATCH, (i + 1) * BOOTSTRAP_LINES_PER_BATCH).map(fmtLine),
        }));
        // 進度在批次**開始**時上報：慢批次跑著的時候用戶看到的是"正在第 N 批"，
        // 而不是上一批的舊數字掛著像死機（LLM 調用已有 120s/次硬超時兜底）
        options.onProgress?.(i + 1, neededBatches);
        try {
            const { updated } = await consolidatePlates(charId, charName, userName || '用戶', materials, llmConfig);
            updated.forEach(r => updatedSet.add(r));
        } catch (e: any) {
            console.warn(`🚪 [Bootstrap] 第 ${i + 1}/${neededBatches} 批整理失敗（繼續下一批）: ${e?.message || e}`);
        }
        // 判過"該不該上門牌"的歷史節點打標退場：不再進後續消化的送審候選，
        // 也和續傳指針語義一致（該批不會再被掃）。與批次成敗無關——resume 同樣跳過失敗批。
        const seenAt = Date.now();
        for (const n of batchNodes) {
            if (!n.digestedAt) {
                n.digestedAt = seenAt;
                try { await MemoryNodeDB.save(n); } catch { /* 單條失敗無害，最多下輪多看一眼 */ }
            }
        }
        ran++;
        nextBatch = i + 1;
    }
    const complete = nextBatch >= neededBatches;
    console.log(`🚪 [Bootstrap] 本次 ${ran} 批 / 進度 ${nextBatch}/${neededBatches}${complete ? '（已還清）' : ''} → 更新 ${[...updatedSet].length} 塊門牌`);
    return { updated: [...updatedSet], batches: ran, totalLines, neededBatches, nextBatch, complete };
}

// 回填進度（斷點續傳）：跑一半關頁面/自動限批沒跑完時，從這裡接著還
const BOOTSTRAP_PROGRESS_KEY = (charId: string) => `mp_plateBootstrapBatch_${charId}`;
export function getBootstrapResume(charId: string): number {
    try {
        const v = parseInt(localStorage.getItem(BOOTSTRAP_PROGRESS_KEY(charId)) || '0', 10);
        return isNaN(v) || v < 0 ? 0 : v;
    } catch { return 0; }
}
export function setBootstrapResume(charId: string, nextBatch: number): void {
    try { localStorage.setItem(BOOTSTRAP_PROGRESS_KEY(charId), String(nextBatch)); } catch {}
}
export function clearBootstrapResume(charId: string): void {
    try { localStorage.removeItem(BOOTSTRAP_PROGRESS_KEY(charId)); } catch {}
}

/** 門牌是否全空（自動回填的觸發判據之一） */
export async function arePlatesEmpty(charId: string): Promise<boolean> {
    const plates = await RoomPlateDB.getByCharId(charId);
    return plates.every(p => p.entries.length === 0);
}

// 回填完成標記：防"LLM 判定無可立牌"時每次消化都重掃歷史的成本循環。
// 自動路徑查/設；手動全量回填完成後也設（並可無視它強制重跑）。
const BOOTSTRAP_FLAG_KEY = (charId: string) => `mp_plateBootstrapped_${charId}`;
export function isPlateBootstrapDone(charId: string): boolean {
    try { return !!localStorage.getItem(BOOTSTRAP_FLAG_KEY(charId)); } catch { return false; }
}
export function markPlateBootstrapDone(charId: string): void {
    try { localStorage.setItem(BOOTSTRAP_FLAG_KEY(charId), String(Date.now())); } catch {}
}

// ─── 注入：格式化為常駐 System Prompt 段落 ───────────

/**
 * 門牌 → Markdown 段落。空門牌跳過；全空返回 ''。
 *
 * 注入框架是設計核心：這些是 constraint（認知底色，防說錯話），
 * 不是 topic（不要老唸叨）——對應人腦"背景知識常在但低激活"的狀態。
 */
export function formatRoomPlatesSection(plates: RoomPlate[], userName?: string): string {
    const userLabel = userName || '用戶';
    const byRoom = new Map(plates.map(p => [p.room, p]));
    const sections: string[] = [];

    for (const room of PLATE_ROOMS) {
        const plate = byRoom.get(room);
        if (!plate || plate.entries.length === 0) continue;
        const title = room === 'user_room' ? `關於${userLabel}` : PLATE_TITLES[room];
        const suffix = room === 'bedroom' ? '（沒有名字，也不需要名字——只有質地）' : '';
        sections.push(
            `**${title}**${suffix}\n` +
            plate.entries.map(e => `- ${e.text}`).join('\n')
        );
    }

    if (sections.length === 0) return '';

    return `### 底色認知 (Resident Knowledge)
以下是你早已知道的背景。它們是你認知的底色，不是話題——不要主動提起，也不要逐條複述，只在相關時讓它們自然影響你的反應、措辭與溫度。

${sections.join('\n\n')}
`;
}

/** 加載某角色的全部門牌並格式化（純 IDB 讀，不調 LLM，供 pipeline 每輪注入用） */
export async function buildRoomPlatesInjection(charId: string, userName?: string): Promise<string> {
    try {
        const plates = await RoomPlateDB.getByCharId(charId);
        return formatRoomPlatesSection(plates, userName);
    } catch (e: any) {
        console.warn(`🚪 [RoomPlate] 加載門牌失敗: ${e?.message || e}`);
        return '';
    }
}
