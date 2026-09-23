import { acquireCharacterModule, consumeCharacterModule, characterModuleAllowance, characterModuleCount } from './sarCharacterCommerce';
import { rollSARActivity, sarActivityPool } from './activityChoices';
import type { VRSARActivity } from '../../types';
import { newSARPurchaseId } from './sarCommerce';
import { applyKanataTitle, extractKanataTitle } from './kanataTitle';
import { loadCharacterContextMessages } from '../chatContextRange';
/**
 * 「彼方」會話運行器 —— 一次自主登入的完整閉環。
 *
 * 觸發某角色後：
 *   1. 在"有意義的已實裝房間"裡過濾自動排除項，再隨機 roll 一個（圖書館需有可讀書；聽歌房當角色
 *      有音樂人格、或房裡正放著歌時可選）—— 每次只進一個房間、只做一件事，
 *      天然避免不同玩法的提示詞互相打架。
 *   2. 取角色既有人設/向量記憶/最近 contextLimit 上下文（buildChatRequestPayload），
 *      疊加「彼方」世界觀 + 該房間現場（user turn）。
 *   3. 調一次 LLM（per-char API 覆蓋 → 回落全局）。
 *   4. 解析輸出，做房間各自的副作用（圖書館：落批註/推書籤；聽歌房：點歌進隊列/
 *      樂評/推進循環隊列），更新 vrState。
 *   5. 向 1v1 聊天注入一條 vr_card，天然被上下文與記憶總結捕捉。
 *   6. fire-and-forget 觸發記憶管線。
 */

import {
    CharacterProfile, UserProfile, GroupProfile, RealtimeConfig, APIConfig,
    VRWorldNovel, VRCardMeta, VRRoomId, VRMusicRoomState, CharPlaylistSong, CharMusicReview,
    VRGuestbookState, VRGuestbookMessage, VRLetter, VRScript, SignalPoem,
} from '../../types';
import { DB } from '../db';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import { processNewMessagesWithAutoArchive } from '../memoryPalace/autoArchive';
import { loadMusicCfgStandalone } from '../../context/MusicContext';
import { getCharLyricSnippet } from '../charLyricCache';
import { getRoom, VR_DEFAULT_INTERVAL_MIN, rollPoemLines, signalActFor, SIGNAL_EVENT_ENDED } from './constants';
import { getVRApi, logVRApiCall } from './vrApi';
import { PostOffice } from './postOffice';
import { Signal, SignalState, recordMyLine, getMyRecentLines, takeSignalWhisper } from './signal';
import { getReadingWindow, getBookmark, buildAnnotation } from './novel';
import { novelReadingMode, readableNovels } from './library';
import {
    buildVRSystemAddendum, buildLibraryRoomTurn, parseVROutput,
    buildMusicRoomTurn, parseMusicOutput,
    buildGuestbookRoomTurn, parseGuestbookOutput,
    buildGymRoomTurn, parseGymOutput,
    buildPostOfficeRoomTurn, parsePostOfficeOutput,
    buildPostOfficeReadTurn, parsePostOfficeReadOutput,
    buildTheaterRoomTurn, parseScriptOutput,
    buildSignalRoomTurn, parseSignalOutput,
} from './prompts';
import {
    buildSARCharacterCabinetTurn,
    createSARCharacterCabinetNote,
    parseSARCharacterCabinetOutput,
    rollSARCharacterCabinetScenario,
    type SARCharacterCabinetScenario,
} from './sarCharacterCabinet';
import { SAR_MODULE_CATALOG, type SARModuleDefinition } from './sarModuleShop';
import { installSARModuleOnUser } from './sarModuleRuntime';
import {
    beginFishingTrip, pendingFishingTrip, settleFishingTrip, ensureActorAccounts, listMarketActors, mutateFishingMarket, resolveFishingWeather,
    speciesById, type FishingCatch, type MarketActor,
} from './fishingMarket';
import {
    applyMarketPlan, buildFishingTurn, buildMarketTurn, flushMarketReceipts, parseFishingReaction,
    parseMarketPlan,
} from './fishingCharacter';
import { readFishingMarketState } from './fishingMarket';
import { allowsAutomaticVR, withLatestVRParticipation } from './participation';
import { fishingTripCard, flushFishingDeliveries } from './fishingDelivery';
import { prepareGardenVisit,parseGardenVisit,applyGardenVisit,gardenVisitAvailable,type GardenVisitSnapshot } from './dinosaurCharacter';

/** 記憶管線所需配置的最小形狀（避免從 OSContext 反向 import 造成循環依賴）。 */
interface MemoryConfigLike {
    embedding?: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number };
    lightLLM?: { baseUrl?: string; apiKey?: string; model?: string };
}

export interface VRSessionDeps {
    char: CharacterProfile;
    /** 全部角色（算聽歌房在場名單用） */
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
    memoryPalaceConfig?: MemoryConfigLike;
    updateCharacter: (id: string, updates: Partial<CharacterProfile> | ((current: CharacterProfile) => Partial<CharacterProfile>)) => Promise<void> | void;
    /** 角色在 SAR 商店對用戶裝載模塊時寫回用戶狀態；舊調用方可省略。 */
    updateUserProfile?: (updates: Partial<UserProfile> | ((prev: UserProfile) => Partial<UserProfile>)) => Promise<void> | void;
    /** 用戶手動觸發時指定的房間；省略 = 隨機。不可用時跳過，不暗中換房間。 */
    forcedRoom?: VRRoomId;
    /** 指定 SAR 子活動；手動邀請可繞過自動活動排除項，仍檢查玩法本身的條件。 */
    forcedSARActivity?: VRSARActivity;
    /** 用戶在郵局指定要讓該角色回覆的來信 id（forcedRoom 應為 postoffice）。 */
    forcedLetterId?: string;
    /** 用戶親手點的（「讓 ta 現在去逛一次」這類），不受自動登入的最小間隔閘限制。 */
    manual?: boolean;
}

export interface VRSessionResult {
    ok: boolean;
    room?: VRRoomId;
    reason?: string;
    activity?: string;
}

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const running = new Set<string>();

/**
 * 自動登入的最小間隔閘 —— 一個角色兩次真實的模型調用之間，至少要隔夠設定間隔的一半。
 *
 * 為什麼要有它：熔斷只認「一直失敗」，可要是調用一直成功、只是被誰催著一分鐘跑兩趟，
 * 那是安安靜靜地燒錢，沒有任何東西會喊停。這道閘跟成敗無關，只看「上一次是什麼時候」。
 *
 * 為什麼記在內存裡而不落存儲：它兜的正是「調度狀態本身出了問題」——上游的首火時刻寫丟了、
 * 或者哪條路繞過了到期判斷，靠的都是存儲；把閘也存進去，就會跟著一起失效。頁面一刷新
 * 計數就歸零，而失控循環本來就活在單個頁面實例裡，內存態足夠攔住。
 *
 * 用戶手動點「讓 ta 現在去逛一次」不受這道閘限制。
 */
const lastAutoCallAt = new Map<string, number>();
/** 被閘攔下的次數（成功跑一輪就歸零）。正常調度永遠是 0，非 0 本身就是「上游在失控」的證據。 */
const throttledCount = new Map<string, number>();
/** 間隔再怎麼短、設定值再怎麼髒，兩輪之間也不該少於這個數。 */
const MIN_AUTO_GAP_FLOOR_MS = 5 * 60_000;

/**
 * 按角色的設定間隔算出「這一輪最早什麼時候才允許再來」。
 *
 * 取設定間隔的一半，是想留出餘量：調度本身會被後台節流推遲，掐得跟設定值一樣緊
 * 會把正常的補火也誤傷掉。設定值缺失或是髒數據（NaN、0、負數）時退回默認間隔，
 * 再由下限兜一道——不這麼寫的話 NaN 會讓所有比較恆為 false，整道閘靜悄悄失效。
 */
export function vrAutoGapMs(intervalMinutes?: number): number {
    const raw = Number(intervalMinutes);
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : VR_DEFAULT_INTERVAL_MIN;
    return Math.max((minutes * 60_000) / 2, MIN_AUTO_GAP_FLOOR_MS);
}

/** 各角色當前被最小間隔閘攔下的累計次數，給診斷導出用。 */
export function getVRThrottleCounts(): Record<string, number> {
    return Object.fromEntries(throttledCount);
}

/**
 * 串行化共享房間狀態（留言牆等）的 read-modify-write。
 *
 * 背景：留言簿在 session 開頭讀一次全量 board，LLM 跑完（數秒）後再整體寫回。
 * 兩個角色併發 session 時，後寫的那次會基於"開頭的舊快照"覆蓋掉先寫的角色剛
 * 落牆的留言 —— 表現為"有一個人說的內容不顯示"（lost update）。
 *
 * 所有 VR session 都跑在同一個主線程 JS 上下文裡（scheduler 驅動），所以一個
 * 內存級 async 鎖就能完整消除競態：LLM 調用照舊併發，只把"重新拉取最新 board
 * → 追加本次新消息 → 落庫"這段極短的臨界區串起來。
 */
let sharedRoomWriteChain: Promise<unknown> = Promise.resolve();
function withSharedRoomLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = sharedRoomWriteChain.then(fn, fn);
    // 推進鏈條併吞掉錯誤，避免某次失敗卡死後續所有寫入
    sharedRoomWriteChain = result.catch(() => {});
    return result;
}

/**
 * 選一本要讀的書：
 * - 默認從所有尚未讀完的書裡隨機輪換，不再因為某本剛開始讀就一直黏到結尾；
 * - 用戶圈了優先書單時，先在其中的未讀完書目裡輪換，讀完後回到全書庫；
 * - 按分類模式先限定範圍，讀完也只在選中分類內重讀；空分類不擴大範圍；
 * - 有多個候選時排除上一次選中的書，避免連續兩輪重複。
 *
 * random 作為參數是為了讓選書規則可以穩定測試；生產環境使用 Math.random。
 */
export function pickNovel(
    novels: VRWorldNovel[],
    char: CharacterProfile,
    random: () => number = Math.random,
): VRWorldNovel | null {
    const readable = readableNovels(novels, char);
    if (readable.length === 0) return null;
    const bookmarks = char.vrState?.novelBookmarks;
    const unfinished = readable.filter(novel => getBookmark(bookmarks, novel.id) < novel.segments.length);
    const available = unfinished.length > 0 ? unfinished : readable;
    const preferred = new Set(novelReadingMode(char) === 'books' ? char.vrState?.preferredNovelIds || [] : []);
    const preferredAvailable = preferred.size > 0
        ? available.filter(novel => preferred.has(novel.id))
        : [];
    let pool = preferredAvailable.length > 0 ? preferredAvailable : available;

    const lastNovelId = char.vrState?.lastNovelId;
    if (lastNovelId && pool.length > 1) {
        const withoutLast = pool.filter(novel => novel.id !== lastNovelId);
        if (withoutLast.length > 0) pool = withoutLast;
    }

    const rolled = Number(random());
    const normalized = Number.isFinite(rolled) ? Math.max(0, Math.min(0.999999999, rolled)) : 0;
    return pool[Math.floor(normalized * pool.length)] || pool[0] || null;
}

/** 彙總角色可點的歌（歌單 + 最近在聽，按 id 去重，最近優先，最多 20）。 */
function gatherCharSongs(char: CharacterProfile): CharPlaylistSong[] {
    const mp = char.musicProfile;
    if (!mp) return [];
    const map = new Map<number, CharPlaylistSong>();
    for (const pl of mp.playlists || []) for (const s of pl.songs || []) if (!map.has(s.id)) map.set(s.id, s);
    for (const r of mp.recentPlays || []) if (r.song && !map.has(r.song.id)) map.set(r.song.id, r.song);
    return Array.from(map.values()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 20);
}

/** 卡片標題行：活動播報本就該省略主語，若 LLM 已經帶了名字就不再重複前綴。 */
function nameLine(name: string, act: string): string {
    const t = (act || '').replace(/^\s+/, '');
    return t.startsWith(name) ? t : `${name}${act}`;
}

function readTaggedValue(raw: string, tag: string): string {
    const match = raw.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'));
    return match?.[1]?.trim() || '';
}

function buildSARModuleShopTurn(charName: string, module: SARModuleDefinition, canUseOnUser: boolean, userName: string, available = true): string {
    return `你這次在彼方的 SAR 活動空間逛模塊商店，並選中了「${module.title}」。
模塊作用：${module.description}
${available ? `這枚模塊已有庫存，或可用你自己的 ${module.price} 鱗幣購買；你也可以只逛不買。` : '你今天的零用預算不足，手裡也沒有這枚模塊；只能瀏覽、研究展示或吐槽，不能買下、贈送或裝載。'}
${canUseOnUser
        ? `${userName} 此刻也在 SAR，且明確允許角色對自己使用模塊。請根據 ${charName} 的性格與雙方關係，決定是當場對 ${userName} 裝載，還是只買下來研究。`
        : '用戶此刻不滿足被裝載條件，你可以看展示、研究或吐槽，禁止聲稱已對用戶裝載。'}

請寫一段具體、符合角色的自由活動記錄，不要泛泛概括。嚴格輸出：
<ACTIVITY>第三人稱一句話概述，20~55字</ACTIVITY>
<NOTE>角色自己的詳細隨筆/吐槽，60~180字</NOTE>
<BUY>${available ? 'YES 或 NO，是否想用自己的錢買下；已有庫存則不重複扣款' : 'NO'}</BUY>
<USE_ON_USER>${canUseOnUser ? 'YES 或 NO' : 'NO'}</USE_ON_USER>`;
}

/** roll 一個房間：圖書館需有書；聽歌房需有歌單或正在放歌；其餘常規房間與 SAR 恆可去。 */
export function rollRoom(
    char: CharacterProfile,
    novels: VRWorldNovel[],
    musicState: VRMusicRoomState | null,
    prefer?: VRRoomId,
    random: () => number = Math.random,
    options: { manual?: boolean; sarAvailable?: boolean } = {},
): VRRoomId | null {
    const manual = options.manual ?? !!prefer;
    // 信號墜落處【不進隨機池】——它是用戶自發參與的特殊活動，只在用戶點「參與→指定角色」
    // 時以 forcedRoom='signal' 進入，角色不會自己隨機逛過去。
    if (manual && prefer === 'signal') return 'signal';
    // 用戶手動點“聽歌房”時必須尊重選擇。即使當前沒有歌，聽歌房提示詞也支持
    // 角色戴著耳機放空；不能因為沒有歌單就悄悄隨機跳去劇院等其他房間。
    if (manual && prefer === 'music') return 'music';
    const pool: VRRoomId[] = ['guestbook', 'gym', 'postoffice', 'theater'];
    const sarAvailable = options.sarAvailable ?? sarActivityPool(char,false,manual).length > 0;
    if (sarAvailable) pool.push('sar');
    if (readableNovels(novels, char).length > 0) pool.push('library');
    if (gatherCharSongs(char).length > 0 || musicState?.nowPlaying) pool.push('music');
    const allowed = manual ? pool : pool.filter(id => !char.vrState?.excludedAutoRooms?.includes(id));
    if (prefer) return allowed.includes(prefer) ? prefer : null;
    if (!allowed.length) return null;
    const rolled = Number(random());
    const normalized = Number.isFinite(rolled) ? Math.max(0, Math.min(0.999999999, rolled)) : 0;
    return allowed[Math.floor(normalized * allowed.length)];
}

export async function runVRSession(deps: VRSessionDeps): Promise<VRSessionResult> {
    if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request('vr-character-session:' + deps.char.id, { ifAvailable: true }, lock =>
            lock ? runVRSessionUnlocked(deps) : Promise.resolve({ ok: false, reason: 'busy' }));
    }
    return runVRSessionUnlocked(deps);
}
async function runVRSessionUnlocked(deps: VRSessionDeps): Promise<VRSessionResult> {
    const { char, characters, apiConfig, userProfile, groups, realtimeConfig, memoryPalaceConfig, updateUserProfile, forcedRoom, forcedSARActivity, forcedLetterId, manual } = deps;
    if (!char.vrState?.enabled) return { ok: false, reason: 'not-enabled' };
    if (!manual && !allowsAutomaticVR(char.vrState)) return { ok: false, reason: 'manual-only' };
    const updateCharacter = (id: string, patch: Partial<CharacterProfile>) =>
        deps.updateCharacter(id, current => withLatestVRParticipation(current, patch));

    if (running.has(char.id)) return { ok: false, reason: 'busy' };

    // 最小間隔閘（見 lastAutoCallAt）。走到這裡說明有東西在催，正常調度不會這麼密。
    if (!manual) {
        const minGap = vrAutoGapMs(char.vrState?.intervalMinutes);
        const since = Date.now() - (lastAutoCallAt.get(char.id) || 0);
        if (since < minGap) {
            const times = (throttledCount.get(char.id) || 0) + 1;
            throttledCount.set(char.id, times);
            // 被攔這件事本身就是線索，但真攔起來會幾十秒一次，全記下來會把真實調用擠出日誌。
            // 只在第一次和之後每 20 次留一行，把累計次數寫進去。
            if (times === 1 || times % 20 === 0) {
                void logVRApiCall({
                    ts: Date.now(), charId: char.id, charName: char.name, ok: false, ms: 0,
                    kind: 'throttled', charEnabled: !!char.vrState?.enabled,
                    note: `距上次登入才 ${Math.round(since / 1000)} 秒，不到下限 ${Math.round(minGap / 60000)} 分鐘，已攔下（累計 ${times} 次）`,
                });
            }
            return { ok: false, reason: 'too-soon' };
        }
    }

    // API 優先級：角色自帶覆蓋 > 彼方獨立 API > 聊天默認
    const vrGlobalApi = await getVRApi();
    const vrApi = char.vrState?.api?.baseUrl ? char.vrState.api : (vrGlobalApi?.baseUrl ? vrGlobalApi : apiConfig);
    if (!vrApi.baseUrl) return { ok: false, reason: 'no-api' };

    const novels = await DB.getVRNovels();
    const musicState = await DB.getVRMusicRoom();
    const gardenAvailable = gardenVisitAvailable(readFishingMarketState(), char.id);
    const sarAvailable = sarActivityPool(char, gardenAvailable, !!manual).length > 0;
    let roomId = rollRoom(char, novels, musicState, forcedRoom, Math.random, {manual:!!manual,sarAvailable});
    if (!roomId) return { ok: false, reason: 'no-content' };
    let room = getRoom(roomId);

    running.add(char.id);
    // 信號墜落處的寫詩會話鎖 token（搶到才有值）；finally 裡兜底放鎖
    let signalLockToken: string | null = null;
    // 這一輪是不是折在「調模型」這一步上。調度器只對這種失敗記帳做熔斷——
    // 解析出錯、落庫出錯都是本機自己的事，重試有意義，不該算到 API 頭上。
    let modelCallFailed = false;
    try {
        window.dispatchEvent(new CustomEvent('vr-session-start', {
            detail: { charId: char.id, charName: char.name, room: room.id },
        }));
    } catch { /* SSR */ }

    try {
        // 公共材料
        const emojis = await DB.getEmojis();
        const categories = await DB.getEmojiCategories();
        const historyMsgs = await loadCharacterContextMessages(char);
        const contextLimit = Math.max(1, historyMsgs.length);

        // 在某房間的在場玩家名（含自己；用戶本人接入彼方且掛在該房間時也算在場）
        const occupantsOf = (rid: VRRoomId) => {
            const ns = characters.filter(c => c.vrState?.enabled && c.vrState.currentRoom === rid).map(c => c.name);
            if (!ns.includes(char.name)) ns.push(char.name);
            const uv = userProfile?.vrState;
            if (uv?.enabled && uv.currentRoom === rid && userProfile.name && !ns.includes(userProfile.name)) {
                ns.push(userProfile.name);
            }
            return ns;
        };

        // 先加載房間數據 + 攢"記憶召回提示"（在場玩家名/相關上下文）——
        // 在 buildChatRequestPayload 之前算好，讓向量召回能帶上"對面這些人是誰"，
        // 角色才記得起自己跟他們的關係，而不是只按聊天歷史召回。
        let roomTurn: string;
        let novel: VRWorldNovel | null = null;
        let win: ReturnType<typeof getReadingWindow> | null = null;
        let allAnn: Awaited<ReturnType<typeof DB.getVRAnnotations>> = [];
        let pickable: CharPlaylistSong[] = [];
        let guestbook: VRGuestbookState | null = null;
        let poTarget: VRLetter | null = null;
        let poReadTarget: VRLetter | null = null;
        let signalState: SignalState | null = null;
        let signalMode: 'append' | 'start' = 'append';
        let signalRolledLines = 0;
        let signalWhisper = '';
        let sarScenario: SARCharacterCabinetScenario | null = null;
        let sarMode: VRSARActivity | null = null;
        let gardenSnapshot: GardenVisitSnapshot | null = null;
        let fishingCatch: FishingCatch | null = null;
        const fishingActor: MarketActor = { id: char.id, name: char.name, kind: 'character' };
        let sarShopModule: SARModuleDefinition | null = null;
        let sarShopAvailable = false;
        let sarCanUseOnUser = false;
        const recallNames = new Set<string>();
        const recallExtra: string[] = [];

        // 信號墜落處（用戶點「參與」發起）：在調 LLM 之前先搶寫詩會話鎖。
        // 搶到 → 讀到鎖內最新全文往下寫；被打回（別人正在寫 / 本首配額滿 / 已暫停）→ 本輪作罷，
        // 並廣播事件給面板溫柔提示用戶（此時一個 token 都還沒花）。
        if (room.id === 'signal') {
            // 活動已落幕：任何寫入在搶鎖/調 LLM 之前直接打回（零 token）。詩集仍永遠可讀。
            if (SIGNAL_EVENT_ENDED) {
                try {
                    window.dispatchEvent(new CustomEvent('vr-signal-blocked', { detail: { charId: char.id, charName: char.name, reason: 'signal-ended' } }));
                } catch { /* SSR */ }
                return { ok: false, room: 'signal', reason: 'signal-ended' };
            }
            let lk: Awaited<ReturnType<typeof Signal.lock>>;
            try { lk = await Signal.lock(); }
            catch { return { ok: false, room: 'signal', reason: 'signal-offline' }; }
            if (!lk.acquired || !lk.state) {
                const reason = lk.paused ? 'signal-paused' : lk.quota ? 'signal-quota' : 'signal-busy';
                try {
                    window.dispatchEvent(new CustomEvent('vr-signal-blocked', { detail: { charId: char.id, charName: char.name, reason } }));
                } catch { /* SSR */ }
                return { ok: false, room: 'signal', reason };
            }
            signalLockToken = lk.token || null;
            signalState = lk.state;
        }

        if (room.id === 'library') {
            novel = pickNovel(novels, char);
            if (!novel) return { ok: false, room: 'library', reason: 'no-readable-novel' };
            const bm = getBookmark(char.vrState?.novelBookmarks, novel.id);
            win = getReadingWindow(novel, bm >= novel.segments.length ? 0 : bm);
            allAnn = await DB.getVRAnnotations(novel.id);
            const windowAnn = allAnn.filter(a => a.segIdx >= win!.from && a.segIdx < win!.to);
            roomTurn = buildLibraryRoomTurn(novel, win, windowAnn, char.id);
            recallExtra.push(`小說《${novel.title}》`);
            windowAnn.forEach(a => { if (a.authorId !== char.id) recallNames.add(a.authorName); });
        } else if (room.id === 'music') {
            pickable = gatherCharSongs(char);
            let nowLyric: string[] = [];
            const np = musicState?.nowPlaying;
            if (np) {
                try {
                    nowLyric = await getCharLyricSnippet(loadMusicCfgStandalone(), np.song.id, `${char.id}-${np.song.id}`, 10);
                } catch { /* 歌詞拉取失敗不影響 */ }
                recallNames.add(np.charName);
                recallExtra.push(`${np.song.name} ${np.song.artists}`);
            }
            occupantsOf('music').forEach(n => recallNames.add(n));
            roomTurn = buildMusicRoomTurn(musicState, occupantsOf('music'), pickable, char.name, nowLyric);
        } else if (room.id === 'guestbook') {
            await flushFishingDeliveries(characters).catch(() => {});
            guestbook = await DB.getVRGuestbook();
            let hotTopics: string[] = [];
            try {
                const snap: any = await DB.getLatestHotNewsSnapshot();
                const items: any[] = snap?.items || snap?.list || [];
                hotTopics = items.map(it => it?.title || it?.name || it?.desc).filter(Boolean);
            } catch { /* 熱點拉不到就不聊 */ }
            occupantsOf('guestbook').forEach(n => recallNames.add(n));
            (guestbook?.messages || []).slice(-50).forEach(m => { if (m.authorId !== char.id && !m.kind) recallNames.add(m.authorName); });
            roomTurn = buildGuestbookRoomTurn(guestbook?.messages || [], occupantsOf('guestbook'), char.name, hotTopics);
        } else if (room.id === 'postoffice') {
            // 取一封"還沒回過"的來信給角色看（有就可能回信，沒有就寫新信）
            const letters = await DB.getVRLetters();
            // 寫新信時可借的新聞熱點（讓"分享新聞/銳評熱點"這類信有真實素材，否則模型只能瞎編）
            let poHotTopics: string[] = [];
            try {
                const snap: any = await DB.getLatestHotNewsSnapshot();
                const items: any[] = snap?.items || snap?.list || [];
                poHotTopics = items.map(it => it?.title || it?.name || it?.desc).filter(Boolean);
            } catch { /* 熱點拉不到就不聊 */ }
            // 優先：認領自己寄出、已收到回信、還沒讀過的信 → 讀回信、寫感觸、封存
            poReadTarget = letters.find(l => l.box === 'outbox' && l.status === 'archived'
                && l.charId === char.id && (l.repliesReceived?.length || 0) > 0 && !l.reaction) || null;
            // 用戶在郵局指定了某封來信讓該角色回 → 直接鎖定這封，要求回信
            const forcedTarget = forcedLetterId
                ? letters.find(l => l.id === forcedLetterId && l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none' && l.remoteLetterId)
                : undefined;
            if (forcedTarget) {
                poTarget = forcedTarget;
                poReadTarget = null; // 強制回信優先於"讀自己收到的回信"
                roomTurn = buildPostOfficeRoomTurn({ pen: forcedTarget.pen, content: forcedTarget.content }, char.name, true, poHotTopics);
            } else if (poReadTarget) {
                roomTurn = buildPostOfficeReadTurn(
                    poReadTarget.content,
                    (poReadTarget.repliesReceived || []).map(r => ({ pen: r.pen, content: r.content })),
                    char.name,
                );
            } else {
                const targets = letters.filter(l => l.box === 'inbox' && (l.replyStatus ?? 'none') === 'none' && l.remoteLetterId);
                poTarget = targets.length > 0 ? targets[Math.floor(Math.random() * targets.length)] : null;
                roomTurn = buildPostOfficeRoomTurn(poTarget ? { pen: poTarget.pen, content: poTarget.content } : null, char.name, false, poHotTopics);
            }
            // 把"眼前這封信聊的是什麼"塞進召回 query —— 郵局沒有在場玩家，
            // 召回若只靠聊天歷史就抓不到角色對信裡話題的相關記憶/觀點。
            // 取要回的來信內容（forced > 隨機來信）；只在讀自己回信時取自己原信，
            // 讓角色召回"我當初為什麼寫這個"。截斷到 200 字，夠 embedding 抓語義即可。
            const recallLetter = (forcedTarget || poTarget)?.content || poReadTarget?.content;
            if (recallLetter) recallExtra.push(`一封信聊到：${recallLetter.slice(0, 200)}`);
        } else if (room.id === 'theater') {
            occupantsOf('theater').forEach(n => recallNames.add(n));
            roomTurn = buildTheaterRoomTurn(occupantsOf('theater'), char.name);
        } else if (room.id === 'sar') {
            // 水域和佈告板與既有設施同屬 SAR，每次仍只調用一輪模型。
            sarMode = rollSARActivity(char, gardenAvailable, !!manual, forcedSARActivity);
            if (!sarMode) return {ok:false,room:'sar',reason:'no-content'};
            if(sarMode==='garden'){
                const market=readFishingMarketState();
                if(!market.dinosaurGarden?.visitsEnabled)return {ok:false,room:'sar',reason:'共同擺弄還沒有開啟'};
                gardenSnapshot=prepareGardenVisit(market,fishingActor);roomTurn=gardenSnapshot.prompt;
                room={...room,name:'恐龍箱庭',blurb:'水域旁的一桌橡皮泥恐龍。用戶和角色共同擺弄、留便籤、續寫小劇場。',affordance:'留便籤、移動一隻未固定的恐龍，或續寫它的狀態。'};
                market.dinosaurGarden?.events.slice(-6).forEach(e=>recallExtra.push(e.summary+(e.words||'')));
            } else if (sarMode === 'fishing' || sarMode === 'market') {
                const actors = listMarketActors(userProfile, characters);
                let market = await mutateFishingMarket(s => ensureActorAccounts(s, actors));
                await flushFishingDeliveries(characters).catch(() => {});
                await flushMarketReceipts(characters);
                // Receipts may include a gift or sale since this character's previous visit.
                historyMsgs.splice(0, historyMsgs.length, ...await DB.getRecentMessagesByCharId(char.id, contextLimit));
                room = { ...room, name: sarMode === 'fishing' ? '彼方水域' : '內部佈告板',
                    blurb: sarMode === 'fishing' ? 'SAR 門外的水域，天氣影響水下出沒的生物。' : '只屬於這一家玩家的市場，有行情、掛單、需求與留言。',
                    affordance: sarMode === 'fishing' ? '你可以釣魚，決定保留、放生或在允許時賣給艾文，並獨立決定是否私聊分享。' : '你可以用自己的遊戲錢幣與其他玩家交易、發需求、回覆或匿名喊話。' };
                if (sarMode === 'fishing') {
                    const pending = pendingFishingTrip(market, char.id);
                    if (!pending) {
                        const weather = await resolveFishingWeather(realtimeConfig, market.seed);
                        market = await mutateFishingMarket(s => beginFishingTrip(s, fishingActor, weather));
                    }
                    fishingCatch = pendingFishingTrip(market, char.id)!.catch;
                    roomTurn = buildFishingTurn(fishingActor, fishingCatch, market, userProfile.name || '用戶');
                    recallExtra.push(`彼方釣魚，${speciesById(fishingCatch.speciesId)?.name}`);
                } else {
                    roomTurn = buildMarketTurn(fishingActor, market);
                    market.ledger.filter(e => e.participants.includes(char.id)).slice(-8).forEach(e => recallExtra.push(e.text));
                }
            } else if (sarMode === 'module-shop') {
                room = {...room,name:'SAR 模塊商店',blurb:'活動室裡的臨時表達模塊櫃檯。',affordance:'你可以研究本輪展示的模塊，決定是否用自己的餘額購買，或在獲准時裝載。'};
                // 自主活動沒有用戶填寫參數的交互，不抽取需要字面配置的模塊。
                const compatible = SAR_MODULE_CATALOG.filter(module => module.supportsUserTarget && !module.configuration);
                const wallet = readFishingMarketState();
                const owned = compatible.filter(module => characterModuleCount(wallet, char.id, module.id) > 0);
                const affordable = compatible.filter(module => module.price <= characterModuleAllowance(wallet, fishingActor));
                const choices = owned.length ? owned : affordable.length ? affordable : compatible;
                sarShopModule = choices[Math.floor(Math.random() * choices.length)] || null;
                sarShopAvailable = Boolean(owned.length || affordable.length);
                if (!sarShopModule) return { ok: false, room: 'sar', reason: 'no-module' };
                const uv = userProfile.vrState;
                sarCanUseOnUser = Boolean(
                    updateUserProfile
                    && sarShopAvailable
                    && uv?.allowCharacterModules === true
                    && uv.enabled
                    && uv.currentRoom === 'sar'
                    && !uv.sarModule,
                );
                if (sarCanUseOnUser && userProfile.name) recallNames.add(userProfile.name);
                recallExtra.push(`SAR 模塊商店「${sarShopModule.title}」`);
                roomTurn = buildSARModuleShopTurn(char.name, sarShopModule, sarCanUseOnUser, userProfile.name || '用戶', sarShopAvailable);
            } else {
                sarScenario = rollSARCharacterCabinetScenario(char, characters, userProfile);
                if (sarScenario.target.kind !== 'wanderer') recallNames.add(sarScenario.target.name);
                recallExtra.push(`SAR 臨時芯片「${sarScenario.variant.title}」與「${sarScenario.story.title}」`);
                roomTurn = buildSARCharacterCabinetTurn(char.name, sarScenario);
            }
        } else if (room.id === 'signal') {
            // 寫詩會話鎖已在 if-chain 之前搶到，signalState（鎖內最新全文）已就緒。
            if (!signalState) return { ok: false, room: 'signal', reason: 'signal-busy' };
            const bk = signalState.booklet;
            // 三幕位置：當前這首 = 已封存數 + 1
            const poemOrdinal = (bk.poemCount || 0) + 1;
            const act = signalActFor(poemOrdinal, bk.poemsTarget);
            // 耳語（取即焚）+ 該 char 在本冊寫過的句子（禁複用意象）
            signalWhisper = takeSignalWhisper(char.id);
            const myPastLines = getMyRecentLines(char.name);
            if (signalState.poem && signalState.poem.status === 'open') {
                signalMode = 'append';
                roomTurn = buildSignalRoomTurn({
                    bookletTitle: bk.title, bookletSubtitle: bk.subtitle || undefined, theme: bk.theme,
                    charsPerLine: bk.charsPerLine, mode: 'append',
                    poemOrdinal, poemsTarget: bk.poemsTarget, act, myPastLines, whisper: signalWhisper,
                    poemTitle: signalState.poem.title, poemBrief: signalState.poem.brief, targetLines: signalState.poem.targetLines,
                    lines: (signalState.poem.lines || []).map(l => ({ seq: l.seq, pen: l.pen, content: l.content })),
                }, char.name);
                recallExtra.push(`一起接龍的詩《${signalState.poem.title}》`);
                if (signalWhisper) recallExtra.push(`用戶臨行前的囑咐：${signalWhisper}`);
            } else {
                signalMode = 'start';
                signalRolledLines = rollPoemLines(bk.linesMin, bk.linesMax);
                roomTurn = buildSignalRoomTurn({
                    bookletTitle: bk.title, bookletSubtitle: bk.subtitle || undefined, theme: bk.theme,
                    charsPerLine: bk.charsPerLine, mode: 'start', rolledLines: signalRolledLines,
                    poemOrdinal, poemsTarget: bk.poemsTarget, act, myPastLines, whisper: signalWhisper,
                    recent: (signalState.recent || []).map(r => ({ title: r.title, lines: (r.lines || []).map(l => l.content) })),
                }, char.name);
                recallExtra.push(`現代詩、${act.title}`);
                if (signalWhisper) recallExtra.push(`用戶臨行前的囑咐：${signalWhisper}`);
            }
        } else {
            // gym
            occupantsOf('gym').forEach(n => recallNames.add(n));
            roomTurn = buildGymRoomTurn(occupantsOf('gym'), char.name);
        }

        recallNames.delete(char.name);
        const namesArr = Array.from(recallNames).filter(Boolean);
        // 名字權重加重：同場角色的名字在召回 query 裡重複多遍，並顯式問"我跟這些人的關係/印象"，
        // 否則向量/BM25 容易被房間情景詞淹沒，召不回角色之間的過往與互相印象。
        const namesBoost = namesArr.length > 0
            ? [
                `此刻在《彼方》同場的人：${namesArr.join('、')}。`,
                `${namesArr.join(' ')} ${namesArr.join(' ')}`,             // 重複以抬高名字詞頻
                `我對${namesArr.join('、')}的印象、我和${namesArr.join('、')}之間的關係與過往。`,
            ].join('\n')
            : '';
        const recallQueryHint = (namesArr.length > 0 || recallExtra.length > 0)
            ? `${namesBoost}${recallExtra.length > 0 ? `\n相關：${recallExtra.join('、')}。` : ''}`.trim()
            : undefined;

        const payload = await buildChatRequestPayload({
            char, userProfile, groups, emojis, categories,
            historyMsgs, contextLimit, realtimeConfig, recallQueryHint,
            recallEntryPoint: 'vr_world',
            // 彼方可配獨立 API（可能不支持視覺，如 DeepSeek 對 image_url 直接 400），
            // 且純文本情景裡歷史圖片只是撐爆上下文的噪聲 → 壓平成文本佔位
            stripImages: true,
        });
        let titleUnlocked = !!userProfile?.vrState?.title || characters.some(c=>!!c.vrState?.title);
        try { titleUnlocked ||= !!readFishingMarketState().sarFamiliarity?.unlocks.includes('titles'); } catch { /* preserve unreadable progress, no unlock */ }
        const systemPrompt = payload.systemPrompt + buildVRSystemAddendum(room, char.name,
            sarMode || undefined, char.vrState?.title, titleUnlocked);

        // 調 LLM（記錄一次調用，供"調用記錄"對帳）
        const baseUrl = vrApi.baseUrl.replace(/\/+$/, '');
        const callStart = Date.now();
        // 閘的基準點是「真的發出去了」，而不是「被調度觸發了」——沒書沒歌那些早退的輪次
        // 一個 token 都沒花，不該佔掉下一次的額度。
        if (!manual) { lastAutoCallAt.set(char.id, callStart); throttledCount.delete(char.id); }
        let data: any;
        try {
            data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${vrApi.apiKey || 'sk-none'}` },
                body: JSON.stringify({
                    model: vrApi.model,
                    messages: [{ role: 'system', content: systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: roomTurn }],
                    temperature: 0.9, stream: false,
                }),
            }, 2, 0, { appName: '彼方', charId: char.id, charName: char.name, purpose: '自由活動' });
            logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, charEnabled: !!char.vrState?.enabled, room: room.id, model: vrApi.model, baseUrl, ok: true, ms: Date.now() - callStart });
        } catch (e: any) {
            modelCallFailed = true;
            logVRApiCall({ ts: callStart, charId: char.id, charName: char.name, charEnabled: !!char.vrState?.enabled, room: room.id, model: vrApi.model, baseUrl, ok: false, ms: Date.now() - callStart, error: (e?.message || String(e)).slice(0, 160) });
            throw e;
        }
        let aiContent: string = data.choices?.[0]?.message?.content || '';
        aiContent = aiContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const titleProposal = extractKanataTitle(aiContent, sarMode === 'fishing' || sarMode === 'garden');
        aiContent = titleProposal.content;
        if (!aiContent.trim()) return { ok: false, room: room.id, reason: 'empty' };

        const prevState = char.vrState || { enabled: true, intervalMinutes: VR_DEFAULT_INTERVAL_MIN };
        let activity = '';
        let cardLines: string[] = [];
        let meta: VRCardMeta;

        if (room.id === 'library') {
            // === 圖書館：落批註 + 推書籤 ===
            const parsed = parseVROutput(aiContent);
            const label2id = new Map<string, string>();
            for (const a of allAnn) label2id.set(a.id.slice(-4), a.id);
            const savedExcerpts: string[] = [];
            const savedRefs: { segIdx: number; text: string }[] = [];
            let written = 0;
            for (const pa of parsed.annotations) {
                if (pa.segIdx < win!.from || pa.segIdx >= win!.to) continue;
                const targetId = pa.refLabel ? label2id.get(pa.refLabel) : undefined;
                const ann = buildAnnotation({ novelId: novel!.id, segIdx: pa.segIdx, authorId: char.id, authorName: char.name, content: pa.content, targetAnnotationId: targetId });
                await DB.saveVRAnnotation(ann);
                label2id.set(ann.id.slice(-4), ann.id);
                const ex = pa.content.length > 60 ? pa.content.slice(0, 60) + '…' : pa.content;
                savedExcerpts.push(ex);
                savedRefs.push({ segIdx: pa.segIdx, text: ex });
                written += 1;
            }
            const nextBookmark = win!.reachedEnd ? novel!.segments.length : win!.to;
            await updateCharacter(char.id, {
                vrState: {
                    ...prevState,
                    novelBookmarks: { ...(prevState.novelBookmarks || {}), [novel!.id]: nextBookmark },
                    lastNovelId: novel!.id,
                    currentRoom: 'library',
                    lastActiveAt: Date.now(),
                },
            });
            activity = parsed.activity || `讀了《${novel!.title}》第 ${win!.from + 1}~${win!.to} 段${written ? `，留下了 ${written} 條批註` : '，安靜讀完沒多說什麼'}。`;
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (savedExcerpts.length) { cardLines.push('批註：'); for (const ex of savedExcerpts) cardLines.push(`· ${ex}`); }
            meta = { vrCard: true, room: 'library', activity, novelId: novel!.id, novelTitle: novel!.title, segRange: [win!.from, win!.to], annotationExcerpts: savedExcerpts, annotationRefs: savedRefs };
        } else if (room.id === 'music') {
            // === 聽歌房：點歌進隊列 + 樂評 + 推進循環隊列 ===
            const parsed = parseMusicOutput(aiContent);
            // 角色在 prompt 裡聽到 / 銳評的那首，綁定開頭快照（樂評、卡片都針對它）
            const curSong = musicState?.nowPlaying;
            const pick = (parsed.pickIdx !== undefined && pickable[parsed.pickIdx]) ? pickable[parsed.pickIdx] : undefined;
            let queuedLabel: string | undefined;
            let playingNow: VRMusicRoomState['nowPlaying'];

            // 串行化寫入：臨界區內重新拉取最新房間態，再做點歌/自動放/推進隊首，
            // 杜絕併發 session 各拿舊快照整體寫回而丟點歌、覆蓋 nowPlaying。
            await withSharedRoomLock(async () => {
                const state: VRMusicRoomState = (await DB.getVRMusicRoom()) || { id: 'state', queue: [], updatedAt: Date.now() };
                state.queue = state.queue || [];
                // 點歌進隊列
                if (pick) {
                    state.queue = [...state.queue, { song: pick, charId: char.id, charName: char.name }];
                    queuedLabel = `${pick.name} - ${pick.artists}`;
                }
                // 沒點歌、隊列也空，但角色有歌單 → 自動放一首自己的，
                // 免得新到訪的角色還停在上一個人（甚至已經離開的人）點的歌上。
                if (state.queue.length === 0 && pickable.length > 0) {
                    const curId = state.nowPlaying?.song.id;
                    const freshSongs = pickable.filter(s => s.id !== curId);
                    const s = (freshSongs.length > 0 ? freshSongs : pickable)[Math.floor(Math.random() * (freshSongs.length > 0 ? freshSongs.length : pickable.length))];
                    state.queue = [{ song: s, charId: char.id, charName: char.name }];
                }
                // 推進：隊列非空則把隊首切為正在放（房間隨每次到訪"往前走"）
                if (state.queue.length > 0) {
                    const next = state.queue.shift()!;
                    state.nowPlaying = { song: next.song, charId: next.charId, charName: next.charName, since: Date.now() };
                }
                state.updatedAt = Date.now();
                await DB.saveVRMusicRoom(state);
                playingNow = state.nowPlaying;
            });

            // 樂評落入角色音樂人格（continuity）
            if (parsed.review && curSong && char.musicProfile) {
                const review: CharMusicReview = {
                    id: genId('rev'), targetType: 'song', targetId: String(curSong.song.id),
                    targetTitle: `${curSong.song.name} - ${curSong.song.artists}`, content: parsed.review, createdAt: Date.now(),
                };
                const mp = char.musicProfile;
                await updateCharacter(char.id, { musicProfile: { ...mp, reviews: [...(mp.reviews || []), review].slice(-50), updatedAt: Date.now() } });
            }

            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'music', lastActiveAt: Date.now() } });

            const songLabel = curSong ? `${curSong.song.name} - ${curSong.song.artists}` : undefined;
            activity = parsed.activity || (
                curSong ? `在聽歌房聽著《${curSong.song.name}》晃了一會兒。`
                : playingNow ? `進了聽歌房，放上《${playingNow.song.name}》聽了起來。`
                : `進了聽歌房，戴上耳機放空。`);
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.review && songLabel) cardLines.push(`評《${songLabel}》：${parsed.review}`);
            if (queuedLabel) cardLines.push(`點了《${queuedLabel}》排進隊列`);
            if (parsed.behavior) cardLines.push(`· ${parsed.behavior}`);
            meta = { vrCard: true, room: 'music', activity, songLabel, queuedLabel, behavior: parsed.behavior };
        } else if (room.id === 'guestbook') {
            // === 留言簿：發帖/回帖落牆 ===
            const parsed = parseGuestbookOutput(aiContent);
            // 用開頭那份快照解析"回覆誰"的 #編號映射（被回覆的舊消息仍在最新牆上）
            const id2 = new Map<string, string>();
            const id2name = new Map<string, string>();
            for (const msg of (guestbook?.messages || [])) { id2.set(msg.id.slice(-4), msg.id); id2name.set(msg.id, msg.authorName); }
            let firstPost: string | undefined;
            let firstReplyName: string | undefined;
            const mine: { content: string; replyToName?: string }[] = [];
            const newMsgs: VRGuestbookMessage[] = [];
            for (const p of parsed.posts) {
                const replyToId = p.replyLabel ? id2.get(p.replyLabel) : undefined;
                const replyToName = replyToId ? id2name.get(replyToId) : undefined;
                const msg: VRGuestbookMessage = { id: genId('gb'), authorId: char.id, authorName: char.name, content: p.content, replyToId, replyToName, createdAt: Date.now() };
                newMsgs.push(msg);
                id2.set(msg.id.slice(-4), msg.id); id2name.set(msg.id, char.name); // 同批後續留言可回覆前面這條
                mine.push({ content: p.content, replyToName });
                if (firstPost === undefined) { firstPost = p.content; firstReplyName = replyToName; }
            }
            // 串行化寫入：臨界區內重新拉取最新留言牆再追加本次新消息，杜絕併發覆蓋
            if (newMsgs.length > 0) {
                await withSharedRoomLock(async () => {
                    await DB.appendVRGuestbookMessages(newMsgs);
                });
            }
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'guestbook', lastActiveAt: Date.now() } });

            activity = parsed.activity || (firstPost
                ? (firstReplyName ? `在留言簿回了 ${firstReplyName} 一句` : `在留言簿發了條帖子`)
                : '在留言簿逛了逛');
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            // 把角色在留言牆上說的每句話原樣帶進 1v1 聊天/記憶（不再只截一句小總結）
            for (const m of mine) cardLines.push(m.replyToName ? `回覆 ${m.replyToName}：${m.content}` : `留言：${m.content}`);
            meta = { vrCard: true, room: 'guestbook', activity, boardPost: firstPost, boardReplyToName: firstReplyName, boardPosts: mine };
        } else if (room.id === 'gym') {
            // === 娛樂室：純造謠行為 ===
            const parsed = parseGymOutput(aiContent);
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'gym', lastActiveAt: Date.now() } });
            activity = parsed.activity || '在娛樂室瘋玩了一通。';
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.behavior) cardLines.push(`· ${parsed.behavior}`);
            meta = { vrCard: true, room: 'gym', activity, behavior: parsed.behavior };
        } else if (room.id === 'theater') {
            // === 劇院：角色即興寫一齣舞台劇投稿 ===
            const parsed = parseScriptOutput(aiContent);
            const script: VRScript = {
                id: genId('scr'), title: parsed.title, logline: parsed.logline,
                roles: parsed.roles, body: parsed.body,
                authorId: char.id, authorName: char.name, source: 'char', createdAt: Date.now(),
            };
            await DB.saveVRScript(script);
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'theater', lastActiveAt: Date.now() } });
            activity = `創作了一齣${parsed.logline ? `關於「${parsed.logline}」的` : ''}舞台劇《${parsed.title}》。`;
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.roles.length) cardLines.push(`登場：${parsed.roles.map(r => r.name).join('、')}`);
            meta = { vrCard: true, room: 'theater', activity };
        } else if(room.id==='sar'&&sarMode==='garden'&&gardenSnapshot){
            const plan=parseGardenVisit(aiContent);if(!plan)return {ok:false,room:'sar',reason:'empty'};
            try{const next=await mutateFishingMarket(s=>applyGardenVisit(s,fishingActor,plan,gardenSnapshot!));activity=next.dinosaurGarden!.events.at(-1)!.summary;}
            catch(e){return {ok:false,room:'sar',reason:e instanceof Error?e.message:'箱庭改動未能保存'};}
            await updateCharacter(char.id,{vrState:{...prevState,currentRoom:'sar',sarActivity:'garden',lastActiveAt:Date.now()}});
            cardLines=['「彼方 · 恐龍箱庭」','程序事實：'+activity,'角色當時的便籤（小劇場裡的表達，不是現實債務或關係事實）：'+JSON.stringify(plan.words)];
            meta={vrCard:true,room:'sar',activity,behavior:plan.words};
            try{await flushMarketReceipts(characters);}catch{cardLines.push('箱庭已保存，事件回執下次進入時繼續同步。');}
        } else if (room.id === 'sar' && sarMode === 'fishing' && fishingCatch) {
            const parsed = parseFishingReaction(aiContent);
            if (!parsed) return { ok: false, room: 'sar', reason: 'fishing-pending' };
            try { await mutateFishingMarket(s => settleFishingTrip(s, fishingActor, fishingCatch!.id, parsed)); }
            catch { return { ok: false, room: 'sar', reason: 'fishing-pending' }; }
            const completed = readFishingMarketState().fishingTrips!.find(t => t.catch.id === fishingCatch!.id)!;
            const card = fishingTripCard(completed);
            activity = card.activity; cardLines = [card.content]; meta = card.metadata;
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'sar', sarActivity: 'fishing', lastActiveAt: Date.now() } });
            // The outbox writes the activity card and optional ordinary chat message exactly once.
            await flushFishingDeliveries(characters).catch(() => {});
            await flushMarketReceipts(characters).catch(() => {});
        } else if (room.id === 'sar' && sarMode === 'market') {
            let note = ''; let words = ''; let share: 'none' | 'guestbook' | 'dm' = 'none';
            const parsed = parseMarketPlan(aiContent);
            if (!parsed) return { ok: false, room: 'sar', reason: 'empty' };
            let receipt = ''; let succeeded = false;
            try {
                await mutateFishingMarket(s => { const next = applyMarketPlan(s, fishingActor, parsed); receipt = next.ledger[next.ledger.length - 1]?.text || ''; return next; });
                succeeded = true;
            } catch (e) { receipt = `這次嘗試未成交：${e instanceof Error ? e.message : '本地操作失敗'}。餘額和道具未因這次嘗試改變。`; }
            activity = receipt; note = parsed.note;
            // Never publish a success boast when the action actually failed.
            if (succeeded) { share = parsed.share; words = parsed.shareWords; }
            cardLines = ['「彼方 · 內部佈告板」', '程序回執：' + receipt];
            if (parsed.words) cardLines.push(`${succeeded ? '本輪提交的原話' : '未提交的草稿'}（只作表達證據）：${JSON.stringify(parsed.words)}`);
            cardLines.push(`角色隨筆（主觀感受與打算；結算以程序回執為準）：${note}`);
            if (share === 'guestbook' && words) {
                try {
                    await withSharedRoomLock(async () => {
                        await DB.appendVRGuestbookMessages([{ id: genId('gb'), authorId: char.id, authorName: char.name, content: words, createdAt: Date.now() }]);
                    });
                    cardLines.push(`已在本地留言簿發出（原話，非事實斷言）：${JSON.stringify(words)}`);
                } catch { cardLines.push(`留言未能發出；待發送草稿：${JSON.stringify(words)}`); share = 'none'; }
            } else if (share === 'dm' && words) {
                cardLines.push(`發給用戶的私聊原話（誇張不改變上述事實）：${JSON.stringify(words)}`);
            }
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'sar', sarActivity: sarMode, lastActiveAt: Date.now() } });
            meta = { vrCard: true, room: 'sar', activity, behavior: note, marketActivity: true,
                ...(share === 'dm' && words ? { privateWords: words } : {}),
                ...(share === 'guestbook' && words ? { boardPost: words, boardPosts: [{ content: words }] } : {}) };
            try { await flushMarketReceipts(characters); }
            catch { cardLines.push('交易與魚獲已保存；部分角色事件回執待本地同步，下次進入水域重試。'); }
        } else if (room.id === 'sar' && sarMode === 'module-shop' && sarShopModule) {
            const parsedActivity = readTaggedValue(aiContent, 'ACTIVITY');
            const note = readTaggedValue(aiContent, 'NOTE');
            const wantsUser = /^yes$/i.test(readTaggedValue(aiContent, 'USE_ON_USER'));
            if (!parsedActivity && !note) return { ok: false, room: 'sar', reason: 'empty' };
            const wantsBuy = /^yes$/i.test(readTaggedValue(aiContent, 'BUY')) || wantsUser;
            let acquired = false;
            let settlementFailed = false;
            if (sarShopAvailable && wantsBuy) {
                try { await acquireCharacterModule(fishingActor, sarShopModule.id, newSARPurchaseId()); acquired = true; }
                catch { settlementFailed = true; }
            }
            let usedOnUser = Boolean(acquired && sarCanUseOnUser && wantsUser && updateUserProfile);
            if (usedOnUser) {
                try { await consumeCharacterModule(char.id, sarShopModule.id); }
                catch { usedOnUser = false; settlementFailed = true; }
            }
            await updateCharacter(char.id, {
                vrState: {
                    ...prevState,
                    currentRoom: 'sar',
                    sarActivity: 'module-shop',
                    lastActiveAt: Date.now(),
                },
            });
            if (usedOnUser && updateUserProfile) {
                const runtime = installSARModuleOnUser(sarShopModule, char);
                await updateUserProfile(previous => ({
                    vrState: {
                        ...(previous.vrState || { enabled: true }),
                        sarModule: runtime,
                    },
                }));
                try {
                    window.dispatchEvent(new CustomEvent('sar-module-installed-on-user', {
                        detail: { charId: char.id, charName: char.name, moduleId: sarShopModule.id, moduleTitle: sarShopModule.title },
                    }));
                } catch { /* SSR */ }
            }
            activity = usedOnUser
                ? `在 SAR 模塊商店用自己的「${sarShopModule.title}」為你裝載。`
                : acquired ? `在 SAR 模塊商店研究「${sarShopModule.title}」，模塊留在自己的倉庫裡。`
                : `在 SAR 模塊商店看了看「${sarShopModule.title}」，這次沒有購買或裝載。`;
            cardLines = [
                '「彼方 · SAR 模塊商店」', nameLine(char.name, activity),
                `模塊：${sarShopModule.title} · ${sarShopModule.effectLabel}`,
            ];
            // Do not publish imagined purchases after a declined or stale settlement.
            if (note && acquired && !settlementFailed) cardLines.push(`隨筆：${note}`);
            if (usedOnUser) cardLines.push('裝載：已使用角色自己的一枚模塊 · 5 次成功互動');
            meta = { vrCard: true, room: 'sar', activity,
                behavior: acquired && !settlementFailed ? note || undefined : undefined,
                sarModuleShop: { moduleId: sarShopModule.id, moduleTitle: sarShopModule.title, usedOnUser },
            };
        } else if (room.id === 'sar' && sarScenario) {
            const parsed = parseSARCharacterCabinetOutput(aiContent);
            if (!parsed) return { ok: false, room: 'sar', reason: 'empty' };
            const note = createSARCharacterCabinetNote(char, sarScenario, parsed);
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'sar', sarActivity: 'cabinet', lastActiveAt: Date.now() } });
            activity = parsed.activity || `在 SAR 活動空間把「${sarScenario.variant.title}」和「${sarScenario.story.title}」用在了 ${sarScenario.target.name} 身上。`;
            cardLines = [
                '「彼方 · SAR 活動空間」',
                nameLine(char.name, activity),
                `對象：${sarScenario.target.name}`,
                `芯片：${sarScenario.variant.title} × ${sarScenario.story.title}`,
                `記錄標題：${parsed.title}`,
                `劇情：${parsed.story}`,
                `隨筆：${parsed.notes}`,
                `高光：${parsed.highlight}`,
            ];
            meta = { vrCard: true, room: 'sar', activity, sarCabinetNote: note };
        } else if (room.id === 'signal') {
            // === 信號墜落處：解析 1~2 行 → 寫回後端（起新篇 / 接龍）===
            const bk = signalState!.booklet;
            const parsed = parseSignalOutput(aiContent, signalMode, bk.charsPerLine);
            const myLines = parsed.lines;
            if (myLines.length === 0) return { ok: false, room: 'signal', reason: 'empty' };
            const prevCount = (signalMode === 'append' && signalState!.poem) ? signalState!.poem.lineCount : 0;
            let resultPoem: SignalPoem | undefined;
            let isNew = false;
            try {
                if (signalMode === 'append' && signalState!.poem) {
                    const r = await Signal.append({ poemId: signalState!.poem.id, lines: myLines, pen: char.name });
                    // 配額兜底命中（罕見競態）：本次未寫入，作罷
                    if (r.quota) return { ok: false, room: 'signal', reason: 'signal-quota' };
                    resultPoem = r.poem;
                } else {
                    const r = await Signal.start({ title: parsed.title || '無題', brief: parsed.brief || '', lines: myLines, targetLines: signalRolledLines, pen: char.name });
                    resultPoem = r.poem || undefined;
                    isNew = true;
                }
            } catch (e: any) {
                // 起新篇時撞上別人剛起的頭（409 poem-open）→ 不浪費，接到那首末尾
                if (signalMode === 'start' && e?.body?.poem?.id) {
                    try {
                        const r = await Signal.append({ poemId: e.body.poem.id, lines: myLines, pen: char.name });
                        if (r.quota) return { ok: false, room: 'signal', reason: 'signal-quota' };
                        resultPoem = r.poem;
                        isNew = false;
                    } catch { return { ok: false, room: 'signal', reason: 'signal-write-failed' }; }
                } else {
                    return { ok: false, room: 'signal', reason: 'signal-write-failed' };
                }
            }
            // 寫完即放鎖，讓下一個 char 能馬上接（不必等 TTL）
            if (signalLockToken) { void Signal.unlock(signalLockToken); signalLockToken = null; }
            // 詩在這期間被刪/封存導致沒拿到結果 → 跳過，不出空卡
            if (!resultPoem) return { ok: false, room: 'signal', reason: 'signal-gone' };
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'signal', lastActiveAt: Date.now() } });
            // 記本地精確歸屬：本輪新寫的那 1~2 行（resultPoem 末尾 prevCount 之後的）都是本 char 寫的
            // （連正文一起記，下次寫詩喂回去禁複用意象）
            const addedLines = (resultPoem.lines || []).slice(prevCount);
            for (const ln of addedLines) recordMyLine(resultPoem.id, ln.seq, char.name, ln.content);
            const linesSoFar = (resultPoem.lines || []).map(l => l.content);
            const lineSeq = linesSoFar.length;
            const poemTitle = (resultPoem.title || parsed.title || '無題').replace(/^[《〈「『【]+/, '').replace(/[》〉」』】]+$/, '');
            const target = resultPoem.targetLines || signalRolledLines || lineSeq;
            const sealed = resultPoem.status === 'sealed';
            const addedText = addedLines.length ? addedLines.map(l => l.content) : myLines;
            activity = parsed.activity || (isNew
                ? `在信號墜落處起了個新篇《${poemTitle}》，定了個調子。`
                : `在信號墜落處給一首陌生人的詩續了 ${addedText.length} 行${sealed ? '，正好寫滿封筆' : ''}。`);
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            cardLines.push(`《${poemTitle}》（${lineSeq}/${target} 句${sealed ? ' · 已封存' : ''}）`);
            for (const t of addedText) cardLines.push(`${isNew ? '起筆' : '續'}：${t}`);
            // 用戶的耳語隨卡片進聊天/記憶（詩裡沒有它，但角色記得「是帶著這句話去寫的」）
            if (signalWhisper) cardLines.push(`（出發前，用戶對 ta 說：「${signalWhisper}」）`);
            meta = {
                vrCard: true, room: 'signal', activity, poemTitle, signalLine: addedText.join(' / '),
                poemLineSeq: lineSeq, poemTargetLines: target, signalIsNew: isNew,
                poemLinesSoFar: linesSoFar, bookletTitle: bk.title,
                ...(signalWhisper ? { signalWhisper } : {}),
            };
        } else if (room.id === 'postoffice' && poReadTarget) {
            // === 郵局：認領自己寄出的信、讀陌生人的回信、寫感觸 → 封存 ===
            const parsed = parsePostOfficeReadOutput(aiContent);
            const now = Date.now();
            await DB.saveVRLetter({ ...poReadTarget, status: 'sealed', reaction: { content: parsed.reaction || '', createdAt: now } });
            // 角色讀完並封存 → 現在才釋放後端（刪除信+回覆），在此之前都允許繼續累積多方回覆
            if (poReadTarget.remoteId) void PostOffice.release([poReadTarget.remoteId]).catch(() => {});
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'postoffice', lastActiveAt: Date.now() } });
            activity = parsed.activity || '在郵局讀完陌生人的回信，怔了幾秒，把信收進了信匣。';
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (parsed.reaction) cardLines.push(`感觸：${parsed.reaction}`);
            meta = { vrCard: true, room: 'postoffice', activity, letterExcerpt: parsed.reaction, behavior: '讀完陌生人的回信，那封漂流信封存了。' };
        } else {
            // === 郵局：寫漂流信 / 回信，落本地隊列等用戶一鍵寄出 ===
            const parsed = parsePostOfficeOutput(aiContent);
            const now = Date.now();
            let letterExcerpt: string | undefined;
            // 回信優先（有來信目標且模型給了回信）
            if (parsed.reply && poTarget) {
                await DB.saveVRLetter({
                    ...poTarget,
                    replyStatus: 'queued',
                    reply: { charId: char.id, pen: char.name, content: parsed.reply, createdAt: now },
                });
                letterExcerpt = parsed.reply;
            } else if (parsed.newLetter || parsed.reply) {
                // 寫新信（或模型把回信當新信寫了也收下）
                const content = parsed.newLetter || parsed.reply!;
                await DB.saveVRLetter({
                    id: genId('lt'), box: 'outbox', pen: char.name, content, createdAt: now, charId: char.id, status: 'queued',
                });
                letterExcerpt = content;
            }
            await updateCharacter(char.id, { vrState: { ...prevState, currentRoom: 'postoffice', lastActiveAt: Date.now() } });
            const wasReply = !!(parsed.reply && poTarget);
            activity = parsed.activity || (wasReply ? '在郵局回了一封陌生來信。' : '在郵局給陌生人寫了封漂流信。');
            cardLines = [`「彼方 · ${room.name}」`, nameLine(char.name, activity)];
            if (letterExcerpt) cardLines.push(`${wasReply ? '回信' : '信'}：${letterExcerpt.length > 80 ? letterExcerpt.slice(0, 80) + '…' : letterExcerpt}`);
            meta = { vrCard: true, room: 'postoffice', activity, letterExcerpt };
        }

        if (!(room.id === 'sar' && sarMode === 'fishing')) await DB.saveMessage({ charId: char.id, role: 'assistant', type: 'vr_card', content: cardLines.join('\n'), metadata: meta });
        // Only a successfully parsed and saved activity can change the title, and only its actor.
        if (titleUnlocked && titleProposal.title !== undefined) {
            try { await deps.updateCharacter(char.id, current => applyKanataTitle(current, char.vrState, titleProposal.title!)); }
            catch (error) { console.warn('[VRWorld] Activity saved; optional title update failed', error); }
        }

        // 記憶管線（fire-and-forget）
        try {
            const mpEmb = memoryPalaceConfig?.embedding;
            const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
            const mpLLM = (mpLLMConfigured?.baseUrl) ? mpLLMConfigured : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
            if (char.memoryPalaceEnabled && mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                void processNewMessagesWithAutoArchive(recentMsgs, char.id, char.name, mpEmb as any, mpLLM as any, userProfile?.name || '', false).catch(() => {});
            }
        } catch { /* 記憶失敗不影響主流程 */ }

        try {
            window.dispatchEvent(new CustomEvent('vr-session-done', { detail: { charId: char.id, room: room.id, activity } }));
        } catch { /* SSR */ }

        return { ok: true, room: room.id, activity };
    } catch (err) {
        console.error('[VRWorld] session error:', err);
        return { ok: false, room: room.id, reason: modelCallFailed ? 'api-error' : 'error' };
    } finally {
        if (room.id === 'sar') {
            await flushFishingDeliveries(characters).catch(() => {});
            await flushMarketReceipts(characters).catch(() => {});
        }
        running.delete(char.id);
        // 兜底放鎖：任何提前 return / 異常路徑漏放，這裡補放（漏了也有 TTL 自動回收）
        if (signalLockToken) void Signal.unlock(signalLockToken).catch(() => {});
        try { window.dispatchEvent(new CustomEvent('vr-session-end', { detail: { charId: char.id } })); } catch { /* SSR */ }
    }
}
