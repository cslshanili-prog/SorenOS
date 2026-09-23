import { loadCharacterContextMessages } from '../chatContextRange';
/**
 * 「家園」演繹引擎 —— 一輪"觀測"的完整閉環。
 *
 * 成本模型（刻意不做真實時間常駐運行）：
 *   - 用戶每次"觀測"（手動推進）或每日有限次離線 tick 觸發一輪演繹
 *   - 一輪 = 1 次 NPC 世界引擎調用（一口氣演完所有 NPC，NPC 無記憶）
 *          + N 次角色調用（鏈式，每角色一次，確保沒人開上帝視角）
 *   - 一輪推進半天劇情時間；"我不看的時候世界慢慢走，我一看就加速"
 *
 * 每個角色的調用複用聊天主鏈路 buildChatRequestPayload：
 *   ContextBuilder 人設 + 角色設定的私聊上下文條數 + 記憶宮殿
 *   （召回 query 注入"同世界其他角色"，讓角色記得自己跟他們的過往）。
 *
 * 產出注入：每個成員的 1v1 聊天各落一條 world_card（可解析 metadata），
 * 與彼方 vr_card 同構，天然進入上下文與記憶管線。
 */

import type {
    CharacterProfile, UserProfile, GroupProfile, RealtimeConfig, APIConfig,
    WorldProfile, WorldEpisode, WorldCharBeat, WorldCardMeta,
} from '../../types';
import { DB } from '../db';
import { recoverWorldProgress } from './episodeOrder';
import { buildChatRequestPayload } from '../chatRequestPayload';
import { safeFetchJson } from '../safeApi';
import { processNewMessagesWithAutoArchive } from '../memoryPalace/autoArchive';
import { getDailyScheduleForChar } from '../dailySchedule';
import {
    worldTimeLabel, buildWorldSystemAddendum, buildWorldCharTurn, buildNpcTurn,
    parseCharBeat, parseNpcScene, realObserveTarget, formatRealClock, migrateWorldDaySegs,
    alignCharToWorldClock,
} from './prompts';
import { ensureThreads, applyBeatToThreads, applyNpcGroupLines, applyNpcDms, npcInboxes } from './threads';
import { shouldCloseChapter, summarizeChapter, SIM_CHAPTER_CLOCKS } from './chapters';

interface MemoryConfigLike {
    embedding?: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number };
    lightLLM?: { baseUrl?: string; apiKey?: string; model?: string };
}

export interface WorldEpisodeDeps {
    world: WorldProfile;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
    memoryPalaceConfig?: MemoryConfigLike;
    trigger: 'observe' | 'tick';
}

export interface WorldEpisodeResult {
    ok: boolean;
    reason?: string;
    episode?: WorldEpisode;
}

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const running = new Set<string>();

/** 讀家園全局 API（設置彈窗寫入 localStorage 的 'world_home_api'；不設返回 null）。 */
function readWorldHomeApiOverride(): { baseUrl: string; apiKey: string; model: string } | null {
    try {
        const s = typeof localStorage !== 'undefined' ? localStorage.getItem('world_home_api') : null;
        const c = s ? JSON.parse(s) : null;
        return c?.baseUrl ? c : null;
    } catch { return null; }
}

export function isWorldRunning(worldId: string): boolean {
    return running.has(worldId);
}

const dispatch = (name: string, detail: any) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* SSR */ }
};

/**
 * 關係 delta 回填。關係有向：A 的演繹裡"和 B 關係 +2"只代表 **A 對 B** 的好感變了，
 * B 對 A 怎麼想由 B 自己的演繹輪決定——兩邊完全可以不對等。不存在的邊按 50 起步。
 */
export function applyRelationshipDeltas(world: WorldProfile, beats: WorldCharBeat[], members: { id: string; name: string }[]): void {
    const idOf = (name: string) => members.find(m => m.name === name)?.id;
    for (const beat of beats) {
        for (const rd of beat.relationshipDeltas || []) {
            const otherId = idOf(rd.withName);
            if (!otherId || otherId === beat.charId) continue;
            let rel = world.relationships.find(r => r.fromId === beat.charId && r.toId === otherId);
            if (!rel) {
                // 沒記錄的邊按「陌生中立」0 起步（不是憑空友善）
                rel = { fromId: beat.charId, toId: otherId, value: 0 };
                world.relationships.push(rel);
            }
            // 好感範圍 -100 ~ +100（可為負 = 嫌隙/敵意）
            rel.value = Math.max(-100, Math.min(100, rel.value + rd.delta));
            // 重大轉折時，角色對這段關係的看法（label）也會變
            if (rd.newLabel) rel.label = rd.newLabel;
        }
    }
}

/**
 * 機械拼接本輪梗概（餵給下一輪所有人，不再額外燒一次 LLM）。
 * ⚠️ 只能用公開信息：shared 行程 + 位置。narrative/mood/secrets 是私人的，
 * 切進 summary 等於把瞞下的事廣播給所有人，伏筆就廢了。
 */
export function buildSummary(storyTime: string, beats: WorldCharBeat[], npcHooks: string[]): string {
    const parts = beats.map(b => {
        const sharedEvents = (b.timeline || []).filter(tl => tl.shared).map(tl => tl.event);
        return sharedEvents.length > 0
            ? `${b.charName}（${b.location}）：${sharedEvents.join('→')}`
            : `${b.charName} 主要在${b.location}`;
    });
    const hookPart = npcHooks.length > 0 ? ` ／鎮上：${npcHooks.join('；')}` : '';
    return `${storyTime}：${parts.join(' ／ ')}${hookPart}`.slice(0, 1200);
}

/** 公開社交媒體：上一輪 + 本輪已演繹角色的動態（公開可見，傳給每個角色）。 */
function collectRecentPosts(lastBeats: WorldCharBeat[], beatsSoFar: WorldCharBeat[]): { name: string; post: string }[] {
    const out: { name: string; post: string }[] = [];
    for (const b of [...lastBeats, ...beatsSoFar]) {
        for (const p of b.phone?.posts || []) out.push({ name: b.charName, post: p });
    }
    return out.slice(-10);
}

/** 動態去重用的歸一化（去掉空白，避免「同一條只差換行/空格」漏判）。 */
const normalizePost = (s: string): string => s.replace(/\s+/g, '').trim();

/**
 * 把這一拍裡和「最近動態」重複的 post 丟掉——模型偶爾會把上一輪的動態原樣再發一遍，
 * 落庫前先剔除，免得手機動態裡同一條文案在不同時間反覆刷屏。
 */
export function dropDuplicatePosts(beat: WorldCharBeat, recent: { post: string }[]): void {
    if (!beat.phone?.posts?.length) return;
    const seen = new Set(recent.map(r => normalizePost(r.post)));
    const kept: string[] = [];
    for (const p of beat.phone.posts) {
        const n = normalizePost(p);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        kept.push(p);
    }
    beat.phone = { ...beat.phone, posts: kept };
}

/**
 * 把 beat 裡瞞下的事收進伏筆欄（pending）。
 * 顯式 secrets 優先；timeline 裡 shared=false 但沒寫進 secrets 的條目自動補一條。
 */
export function collectSeeds(world: WorldProfile, beat: WorldCharBeat, round: number, storyTime: string): void {
    if (!world.seeds) world.seeds = [];
    const texts = new Set<string>();
    for (const s of beat.secrets || []) {
        texts.add(s.text);
        world.seeds.push({
            id: genId('seed'), charId: beat.charId, charName: beat.charName,
            text: s.text, hideFrom: s.hideFrom || [], round, storyTime, status: 'pending',
        });
    }
    for (const tl of beat.timeline || []) {
        if (tl.shared) continue;
        const text = `${tl.time} 在${tl.place}：${tl.event}`;
        // 已被顯式 secrets 覆蓋（粗匹配事件文本）就不重複
        if ([...texts].some(t => t.includes(tl.event.slice(0, 20)) || tl.event.includes(t.slice(0, 20)))) continue;
        world.seeds.push({
            id: genId('seed'), charId: beat.charId, charName: beat.charName,
            text, hideFrom: [], round, storyTime, status: 'pending',
        });
    }
    // 伏筆欄只留最近 30 條 pending/armed；resolved 留 20 條供回看
    const active = world.seeds.filter(s => s.status !== 'resolved').slice(-30);
    const resolved = world.seeds.filter(s => s.status === 'resolved').slice(-20);
    world.seeds = [...resolved, ...active];
}

/** 按 armed 伏筆為某角色生成"繞不開的事"注入文案。 */
function buildExposures(world: WorldProfile, charId: string, charName: string): string[] {
    const out: string[] = [];
    for (const seed of world.seeds || []) {
        if (seed.status !== 'armed') continue;
        if (seed.charId === charId) {
            out.push(`你之前瞞下的事（${seed.text}）這半天藏不住了——有人察覺了端倪，正面處理它帶來的局面。`);
        } else if (seed.hideFrom.length === 0 || seed.hideFrom.includes(charName)) {
            out.push(`你發現/聽說了 ${seed.charName} 一直瞞著的事：${seed.text}。這件事此刻擺在你面前，按你的性格去消化或對質。`);
        }
    }
    return out;
}

/** 單個角色的 world_card 文本（注入本人的 1v1 聊天與記憶——本人的視角，含自己瞞的事）。 */
function buildCardContent(world: WorldProfile, storyTime: string, beat: WorldCharBeat): string {
    const lines = [
        `「家園 · ${world.name}」${storyTime}`,
        `${beat.charName} 在${beat.location}（${beat.mood}）`,
    ];
    if (beat.timeline?.length) {
        lines.push('這半天的行程：');
        for (const tl of beat.timeline) lines.push(`· ${tl.time} ${tl.place}：${tl.event}${tl.shared ? '' : '（沒聲張）'}`);
    }
    lines.push(beat.narrative);
    if (beat.memo?.length) {
        for (const m of beat.memo) lines.push(`備忘錄：${m}`);
    }
    if (beat.impulse) lines.push(`心裡的衝動：${beat.impulse.text}`);
    if (beat.dialogues?.length) {
        for (const d of beat.dialogues) lines.push(`當面對 ${d.with} 說：${d.lines.join(' / ')}`);
    }
    if (beat.phone?.posts?.length) {
        for (const p of beat.phone.posts) lines.push(`發了動態：${p}`);
    }
    if (beat.phone?.dms?.length) {
        for (const d of beat.phone.dms) lines.push(`給 ${d.to} 發消息：${d.lines.join(' / ')}`);
    }
    if (beat.phone?.group?.length) {
        lines.push(`在世界群聊裡說：${beat.phone.group.join(' / ')}`);
    }
    return lines.join('\n');
}

/** 組裝某一拍的 world_card metadata（與彼方 vr_card 同構，注入聊天 / 進記憶用）。 */
export function buildWorldCardMeta(world: WorldProfile, beat: WorldCharBeat, round: number, storyTime: string): WorldCardMeta {
    return {
        worldCard: true,
        worldId: world.id,
        worldName: world.name,
        mode: world.mode,
        round,
        storyTime,
        location: beat.location,
        mood: beat.mood,
        narrative: beat.narrative,
        statusPanel: beat.statusPanel,
        timeline: beat.timeline,
        memo: beat.memo,
        impulse: beat.impulse,
        phonePosts: beat.phone?.posts,
        phoneGroup: beat.phone?.group,
    };
}

/**
 * 演繹某角色時補註 ta 今天的**全天**日程（防行為衝突）。
 * 聊天主鏈路（buildChatRequestPayload）注入的日程只有「當前時段 + 下一個」，
 * 家園一拍演的是半天，只看當前時段不夠——這裡把整天藍圖給足。
 * 軟參考：世界裡的突發事件可以合理打斷日程，但不許"沒看見"就硬撞。
 * sim（虛擬時間）番外與真實日程無關，跳過。
 */
async function buildFullDayScheduleBlock(world: WorldProfile, char: CharacterProfile): Promise<string> {
    if ((world.timeMode ?? 'real') === 'sim') return '';
    try {
        const s = await getDailyScheduleForChar(char);
        if (!s?.slots?.length) return '';
        const lines = s.slots
            .map(x => `- ${x.startTime} ${x.activity}${x.location ? `（${x.location}）` : ''}`)
            .join('\n');
        return `\n\n## 你今天的日程表（既定安排）\n${lines}\n（演繹這半天時以此為參照，行為別和既定安排無故衝突；世界裡的事件可以合理打斷日程，但要有交代。）`;
    } catch {
        return '';
    }
}

/**
 * 把某一拍作為 world_card 注入這名角色的 1v1 聊天（進上下文與記憶）。
 * 自動演繹、單拍補發都走這裡——保證格式一致，也方便 UI 做「手動發送保底」。
 */
export async function injectWorldCard(world: WorldProfile, beat: WorldCharBeat, round: number, storyTime: string): Promise<void> {
    await DB.saveMessage({
        charId: beat.charId, role: 'assistant', type: 'world_card',
        content: buildCardContent(world, storyTime, beat),
        metadata: buildWorldCardMeta(world, beat, round, storyTime),
    });
}

export async function runWorldEpisode(deps: WorldEpisodeDeps): Promise<WorldEpisodeResult> {
    const { characters, apiConfig, userProfile, groups, realtimeConfig, memoryPalaceConfig, trigger } = deps;
    const worldId = deps.world.id;

    if (running.has(worldId)) return { ok: false, reason: 'busy' };
    running.add(worldId);
    try {
        const world = await DB.getWorld(worldId) || deps.world;
        const lastEpisodes = await DB.getWorldEpisodes(worldId, 2);

        // 舊存檔（一天三段制）防禦性遷移到四段制（含凌晨）：啟動 sweep 可能還沒跑完就被 tick 搶跑，
        // 這裡原地換算，storyClock/clockSegs 隨本輪結束的 saveWorld 一併持久化。
        migrateWorldDaySegs(world);
        recoverWorldProgress(world, lastEpisodes);

        const members = world.memberIds
            .map(id => characters.find(c => c.id === id))
            .filter(Boolean) as CharacterProfile[];
        if (members.length === 0) return { ok: false, reason: 'no-members' };

        // API 優先級：世界私有覆蓋（舊數據）> 家園全局設置（localStorage）> 全局聊天默認
        const worldHomeApi = readWorldHomeApiOverride();
        const api = world.api?.baseUrl ? world.api : (worldHomeApi || apiConfig);
        if (!api.baseUrl) return { ok: false, reason: 'no-api' };
        const baseUrl = api.baseUrl.replace(/\/+$/, '');

        // real 模式：演的那一段跟著真實時鍾走，且只能補當天錯過的段；已追上現實就沒東西可演
        const realTarget = world.timeMode !== 'sim' ? realObserveTarget(world) : null;
        if (world.timeMode !== 'sim' && !realTarget) return { ok: false, reason: 'caught-up' };

        const storyTime = realTarget ? formatRealClock(realTarget) : worldTimeLabel(world);
        const round = world.storyClock + 1;
        // sim 模式不進記憶/聊天——演繹攢在家園裡，靠每 20 天的結卷總結沉澱
        const entersMemory = world.timeMode !== 'sim' && world.injectToChat !== false;
        // sim 模式：已結卷歸檔的原文不再喂；最新一卷的單視角總結 + 氛圍作為上文
        const latestChapter = (world.chapters || [])[(world.chapters?.length || 0) - 1];
        // 線程容器就位：本輪所有消息（NPC 群聊冒泡 / 角色私聊與群聊）都即時落在 world.threads 上，
        // 鏈式後續角色構建上下文時直接讀到——消息在同一輪內就完成傳遞。
        ensureThreads(world);
        dispatch('world-episode-start', { worldId: world.id, worldName: world.name, storyTime, total: members.length });

        // 給一點縱深：最近兩輪的梗概都喂進去，世界才有"昨天"的概念。
        // sim 模式下，已歸檔（round ≤ simSummarizedClock）的原文不再喂——交給章節總結。
        const sinceClock = world.simSummarizedClock || 0;
        const summarySource = world.timeMode === 'sim'
            ? lastEpisodes.filter(e => e.round > sinceClock)
            : lastEpisodes;
        const lastSummary = summarySource.length > 0
            ? summarySource.slice().reverse().map(e => e.summary).join('\n')
            : undefined;

        // NPC 引擎改到角色之後跑（見 ── 2.5 ──）：這樣 NPC 能看到角色這一輪剛發的私聊/動態/
        // 群聊，當輪就回應。角色這一輪看到的「鎮上動靜」用上一輪 NPC 的產出——和角色彼此錯一
        // 輪接話是一致的模型。本輪 NPC 的產出存進 episode、並在下一輪被角色接住。
        const lastNpcScene = lastEpisodes[0]?.npcScene;
        const lastNpcHooks = lastEpisodes[0]?.npcHooks || [];
        let npcScene: string | undefined;
        let npcHooks: string[] = [];

        // ── 1. 鏈式角色演繹（每角色一次獨立調用，後者能"看到"前者的公開行為） ──
        const memberNames = members.map(m => m.name);
        const lastBeats = lastEpisodes[0]?.beats || [];
        const beats: WorldCharBeat[] = [];
        const consumedDirectiveIds: string[] = [];
        let anyCharOk = false;
        for (let i = 0; i < members.length; i++) {
            const char = members[i];
            try {
                const others = memberNames.filter(n => n !== char.name);
                // 與彼方同款的名字加權召回：讓向量記憶召回"我和這些人的關係"，
                // 而不是被世界觀情景詞淹沒。query = 當前世界的其他角色。
                const recallQueryHint = others.length > 0
                    ? [
                        `此刻在「${world.name}」共同生活的人：${others.join('、')}。`,
                        `${others.join(' ')} ${others.join(' ')}`,
                        `我對${others.join('、')}的印象、我和${others.join('、')}之間的關係與過往。`,
                    ].join('\n')
                    : undefined;

                const historyMsgs = await loadCharacterContextMessages(char);
                const contextLimit = Math.max(1, historyMsgs.length);
                // 家園內角色的當前時間與日程日期都必須對齊同一把世界鍾。
                const worldChar = alignCharToWorldClock(world, char);
                const payload = await buildChatRequestPayload({
                    char: worldChar, userProfile, groups, emojis: [], categories: [],
                    historyMsgs, contextLimit, realtimeConfig, recallQueryHint,
                    recallEntryPoint: 'world_home',
                    // 家園可配獨立 API（可能不支持視覺，image_url 會 400）→ 歷史圖片壓平成文本佔位
                    stripImages: true,
                });
                const systemPrompt = payload.systemPrompt
                    + buildWorldSystemAddendum(world, char, userProfile?.name || '')
                    + await buildFullDayScheduleBlock(world, worldChar);
                const directive = (world.directives || []).find(d => d.charId === char.id);
                // sim 模式：喂回這名角色自己的單視角總結 + 本卷氛圍（絕不喂全知 synopsis）
                const priorChapter = (world.timeMode === 'sim' && latestChapter)
                    ? {
                        atmosphere: latestChapter.atmosphere,
                        charPerspective: latestChapter.perspectives.find(p => p.charId === char.id)?.text,
                    }
                    : undefined;
                const turn = buildWorldCharTurn({
                    world, char, members, storyTime, round, lastSummary,
                    npcScene: lastNpcScene, npcHooks: lastNpcHooks, beatsSoFar: beats,
                    recentPosts: collectRecentPosts(lastBeats, beats),
                    exposures: buildExposures(world, char.id, char.name),
                    directive: directive ? { impulseText: directive.impulseText, text: directive.text } : undefined,
                    priorChapter,
                    userName: userProfile?.name || '',
                });
                if (directive) consumedDirectiveIds.push(directive.id);

                const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
                    body: JSON.stringify({
                        model: api.model,
                        messages: [{ role: 'system', content: systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: turn }],
                        temperature: 0.9, stream: false,
                    }),
                }, 2, 0, { appName: '家園', charId: char.id, charName: char.name, purpose: `演繹 · ${world.name}` });
                const beat = parseCharBeat(data.choices?.[0]?.message?.content || '', char, memberNames, world.npcs.map(n => n.name));
                // 落庫前剔除和最近動態重複的 post（上一輪 + 本輪已演繹角色）
                dropDuplicatePosts(beat, collectRecentPosts(lastBeats, beats));
                beats.push(beat);
                // 該角色發出的私聊/群聊立刻落線程——後面還沒演繹的角色這一輪就能收到並回應
                applyBeatToThreads(world, beat, members, round, storyTime);
                // 瞞下的事落進伏筆欄（pending，等用戶點擊引爆）
                collectSeeds(world, beat, round, storyTime);
                anyCharOk = true;
            } catch (e) {
                // 單個角色失敗不拖垮整輪——這半天 ta 只是沒什麼動靜
                console.error(`[WorldHome] beat failed for ${char.name}:`, e);
            }
            dispatch('world-beat-done', { worldId: world.id, stage: 'char', charId: char.id, charName: char.name, done: i + 1, total: members.length });
        }

        if (!anyCharOk) return { ok: false, reason: 'all-beats-failed' };

        // ── 2.5 NPC 世界引擎（角色之後跑）：回應本輪角色發來的私聊、給本輪動態點贊/評論、群裡冒泡 ──
        if (world.npcs.length > 0) {
            try {
                // 喂這一輪角色剛發的動態，讓 NPC + 路人當輪就點贊評論
                const recentPostsForNpc = beats.flatMap(b =>
                    (b.phone?.posts || []).map((post, idx) => ({ ref: `${round}_${b.charId}_${idx}`, name: b.charName, post }))
                ).slice(0, 12);
                const npcData = await safeFetchJson(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
                    body: JSON.stringify({
                        model: api.model,
                        messages: [{ role: 'user', content: buildNpcTurn({ world, members, storyTime, lastSummary, chapterAtmosphere: latestChapter?.atmosphere, inboxes: npcInboxes(world), recentPosts: recentPostsForNpc }) }],
                        temperature: 0.9, stream: false,
                    }),
                }, 2, 0, { appName: '家園', purpose: `NPC世界引擎 · ${world.name}` });
                const parsed = parseNpcScene(npcData.choices?.[0]?.message?.content || '');
                npcScene = parsed.scene || undefined;
                npcHooks = parsed.hooks;
                // 群聊冒泡 + 回覆成員私信（落線程，角色下一輪接住）
                applyNpcGroupLines(world, parsed.groupLines, round, storyTime);
                applyNpcDms(world, parsed.dms, members, round, storyTime);
                // 動態的點贊/評論（NPC + 路人）回填
                if (parsed.feedReactions.length > 0) {
                    world.feedReactions = { ...(world.feedReactions || {}) };
                    for (const r of parsed.feedReactions) world.feedReactions[r.ref] = { likes: r.likes, comments: r.comments };
                }
            } catch (e) {
                console.warn('[WorldHome] NPC engine failed:', e);
            }
            dispatch('world-beat-done', { worldId: world.id, stage: 'npc', done: members.length, total: members.length });
        }

        // ── 3. 落庫：episode + 關係回填 + 劇情時鐘推進 ──
        // 成功的角色照常保留；沒演出來的記下 charId，UI 提示用戶可單獨重 roll
        const okIds = new Set(beats.map(b => b.charId));
        const failedCharIds = members.filter(m => !okIds.has(m.id)).map(m => m.id);
        const episode: WorldEpisode = {
            id: genId('we'),
            worldId: world.id,
            round,
            storyTime,
            trigger,
            npcScene,
            npcHooks: npcHooks.length > 0 ? npcHooks : undefined,
            beats,
            failedCharIds: failedCharIds.length > 0 ? failedCharIds : undefined,
            summary: buildSummary(storyTime, beats, npcHooks),
            createdAt: Date.now(),
        };
        await DB.saveWorldEpisode(episode);

        applyRelationshipDeltas(world, beats, members);
        // armed 伏筆本輪已爆發 → resolved；本輪注入過的用戶決策消費掉
        for (const seed of world.seeds || []) {
            if (seed.status === 'armed') seed.status = 'resolved';
        }
        const remainingDirectives = (world.directives || []).filter(d => !consumedDirectiveIds.includes(d.id));
        const updatedWorld: WorldProfile = {
            ...world,
            relationships: world.relationships,
            threads: world.threads, // 本輪累積的私聊/群聊消息一併持久化
            seeds: world.seeds,
            directives: remainingDirectives,
            storyClock: world.storyClock + 1,
            // real 模式：把世界的「現實段」推進到這次演的那一段
            realClock: realTarget || world.realClock,
            updatedAt: Date.now(),
        };
        await DB.saveWorld(updatedWorld);

        // ── 3.5 sim 模式：攢滿 20 天結一卷（小說體總結 + 各角色單視角，歸檔原文） ──
        const newClock = updatedWorld.storyClock;
        if (shouldCloseChapter(updatedWorld, newClock)) {
            try {
                const fromClock = newClock - SIM_CHAPTER_CLOCKS;
                const index = newClock / SIM_CHAPTER_CLOCKS;
                // 拉取本卷窗口內的原文（round 落在 (fromClock, newClock]）
                const windowEpisodes = (await DB.getWorldEpisodes(world.id, SIM_CHAPTER_CLOCKS + 2))
                    .filter(e => e.round > fromClock && e.round <= newClock);
                dispatch('world-chapter-start', { worldId: world.id, index });
                const chapter = await summarizeChapter({
                    world: updatedWorld, members, episodes: windowEpisodes, api: { baseUrl, apiKey: api.apiKey || '', model: api.model },
                    fromClock, toClock: newClock,
                    fromLabel: worldTimeLabel(updatedWorld, fromClock),
                    toLabel: worldTimeLabel(updatedWorld, Math.max(fromClock, newClock - 1)),
                    index, prevSynopsis: latestChapter?.synopsis,
                });
                if (chapter) {
                    updatedWorld.chapters = [...(updatedWorld.chapters || []), chapter];
                    updatedWorld.simSummarizedClock = newClock;
                    // 歸檔後清空手機裡屬於這 20 天的私聊/群聊 + 動態互動（已捲進編年史）
                    if (updatedWorld.threads) {
                        updatedWorld.threads = updatedWorld.threads.map(t => ({ ...t, messages: t.messages.filter(m => m.round > newClock) }));
                    }
                    if (updatedWorld.feedReactions) {
                        updatedWorld.feedReactions = Object.fromEntries(
                            Object.entries(updatedWorld.feedReactions).filter(([k]) => (parseInt(k.split('_')[0], 10) || 0) > newClock)
                        );
                    }
                    updatedWorld.updatedAt = Date.now();
                    await DB.saveWorld(updatedWorld);
                    dispatch('world-chapter-done', { worldId: world.id, index, chapterId: chapter.id });
                }
            } catch (e) {
                console.warn('[WorldHome] close-chapter failed:', e);
            }
        }

        // ── 4. world_card 注入各成員 1v1 聊天（與彼方 vr_card 同構；sim 模式不進記憶，跳過） ──
        if (entersMemory) {
            for (const beat of beats) {
                try {
                    await injectWorldCard(world, beat, episode.round, storyTime);
                } catch (e) {
                    console.error(`[WorldHome] card inject failed for ${beat.charName}:`, e);
                }
            }

            // 記憶管線（fire-and-forget，逐角色）
            try {
                const mpEmb = memoryPalaceConfig?.embedding;
                const mpLLMConfigured = memoryPalaceConfig?.lightLLM;
                const mpLLM = (mpLLMConfigured?.baseUrl) ? mpLLMConfigured : { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model };
                if (mpEmb?.baseUrl && mpEmb?.apiKey && mpLLM.baseUrl) {
                    for (const beat of beats) {
                        const char = members.find(m => m.id === beat.charId);
                        if (!char?.memoryPalaceEnabled) continue;
                        const recentMsgs = await DB.getRecentMessagesByCharId(char.id, 50);
                        void processNewMessagesWithAutoArchive(recentMsgs, char.id, char.name, mpEmb as any, mpLLM as any, userProfile?.name || '', false).catch(() => {});
                    }
                }
            } catch { /* 記憶失敗不影響主流程 */ }
        }

        dispatch('world-episode-done', { worldId: world.id, episodeId: episode.id, storyTime, round: episode.round });
        return { ok: true, episode };
    } catch (err) {
        console.error('[WorldHome] episode error:', err);
        return { ok: false, reason: 'error' };
    } finally {
        running.delete(worldId);
        dispatch('world-episode-end', { worldId });
    }
}

/**
 * 單個角色重 roll：只重演某一輪裡某個角色這一拍（用於本輪該角色生成失敗、或用戶想換個寫法）。
 * - direction：用戶給的「大致重寫方向」，沒有就完全重寫。
 * - 之前是「失敗缺這拍」→ 補上後照常落線程/伏筆/關係，真實模式補一張 world_card；
 *   之前已有這拍（用戶想換寫法）→ 只替換這拍內容，不重複落副作用（避免重複加好感/重複消息）。
 */
export async function rerollWorldCharBeat(
    deps: WorldEpisodeDeps & { episodeId: string; charId: string; direction?: string },
): Promise<WorldEpisodeResult> {
    const { world, characters, apiConfig, userProfile, groups, realtimeConfig, episodeId, charId, direction } = deps;
    if (running.has(world.id)) return { ok: false, reason: 'busy' };
    const members = world.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[];
    const char = members.find(m => m.id === charId);
    if (!char) return { ok: false, reason: 'no-char' };
    const memberNames = members.map(m => m.name);
    const worldHomeApi = readWorldHomeApiOverride();
    const api = world.api?.baseUrl ? world.api : (worldHomeApi || apiConfig);
    if (!api.baseUrl) return { ok: false, reason: 'no-api' };
    const baseUrl = api.baseUrl.replace(/\/+$/, '');

    const episodes = await DB.getWorldEpisodes(world.id, 30);
    const episode = episodes.find(e => e.id === episodeId);
    if (!episode) return { ok: false, reason: 'no-episode' };
    const hadBeat = episode.beats.some(b => b.charId === charId);

    running.add(world.id);
    dispatch('world-episode-start', { worldId: world.id, worldName: world.name, storyTime: episode.storyTime, total: 1 });
    dispatch('world-beat-done', { worldId: world.id, stage: 'char', charId, charName: char.name, done: 0, total: 1 });
    try {
        const prevEp = episodes.find(e => e.round === episode.round - 1);
        const otherBeats = episode.beats.filter(b => b.charId !== charId);
        const others = memberNames.filter(n => n !== char.name);
        const recallQueryHint = others.length > 0
            ? `此刻在「${world.name}」共同生活的人：${others.join('、')}。\n我對${others.join('、')}的印象、我和${others.join('、')}之間的關係與過往。`
            : undefined;
        const historyMsgs = await loadCharacterContextMessages(char);
        const contextLimit = Math.max(1, historyMsgs.length);
        const worldChar = alignCharToWorldClock(world, char);
        const payload = await buildChatRequestPayload({
            char: worldChar, userProfile, groups, emojis: [], categories: [],
            historyMsgs, contextLimit, realtimeConfig, recallQueryHint,
            recallEntryPoint: 'world_home',
            // 同上：獨立 API 可能不支持視覺 → 歷史圖片壓平成文本佔位
            stripImages: true,
        });
        const systemPrompt = payload.systemPrompt
            + buildWorldSystemAddendum(world, char, userProfile?.name || '')
            + await buildFullDayScheduleBlock(world, worldChar);
        const latestChapter = (world.chapters || [])[(world.chapters?.length || 0) - 1];
        const priorChapter = (world.timeMode === 'sim' && latestChapter)
            ? { atmosphere: latestChapter.atmosphere, charPerspective: latestChapter.perspectives.find(p => p.charId === char.id)?.text }
            : undefined;
        let turn = buildWorldCharTurn({
            world, char, members, storyTime: episode.storyTime, round: episode.round, lastSummary: prevEp?.summary,
            npcScene: episode.npcScene, npcHooks: episode.npcHooks, beatsSoFar: otherBeats,
            recentPosts: collectRecentPosts(prevEp?.beats || [], otherBeats),
            exposures: buildExposures(world, char.id, char.name),
            priorChapter, userName: userProfile?.name || '',
        });
        if (direction && direction.trim()) {
            turn += `\n\n## 重寫方向（用戶希望這次往這個方向重演，請據此給出全新的一拍）\n${direction.trim()}`;
        }
        const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api.apiKey || 'sk-none'}` },
            body: JSON.stringify({
                model: api.model,
                messages: [{ role: 'system', content: systemPrompt }, ...payload.cleanedApiMessages, { role: 'user', content: turn }],
                temperature: 0.95, stream: false,
            }),
        }, 2, 0, { appName: '家園', charId: char.id, charName: char.name, purpose: `重演 · ${world.name}` });
        const beat = parseCharBeat(data.choices?.[0]?.message?.content || '', char, memberNames, world.npcs.map(n => n.name));
        // 重演這一拍同樣剔除和最近動態重複的 post
        dropDuplicatePosts(beat, collectRecentPosts(prevEp?.beats || [], otherBeats));

        const newBeats = hadBeat ? episode.beats.map(b => b.charId === charId ? beat : b) : [...episode.beats, beat];
        const stillFailed = (episode.failedCharIds || []).filter(id => id !== charId);
        const updatedEp: WorldEpisode = {
            ...episode,
            beats: newBeats,
            failedCharIds: stillFailed.length > 0 ? stillFailed : undefined,
            summary: buildSummary(episode.storyTime, newBeats, episode.npcHooks || []),
        };
        await DB.saveWorldEpisode(updatedEp);

        // 重演會換掉這一拍的動態，但點贊/評論按 `round_charId_idx` 關聯——不清掉舊反應，
        // 上一次的評論就會原樣掛到新動態上（評論對不上號）。這裡把這名角色這一輪的反應全抹掉；
        // 重演不再跑 NPC 引擎，新動態先沒有互動也好過掛錯評論。
        let worldDirty = false;
        if (world.feedReactions) {
            const prefix = `${episode.round}_${charId}_`;
            const kept = Object.fromEntries(Object.entries(world.feedReactions).filter(([k]) => !k.startsWith(prefix)));
            if (Object.keys(kept).length !== Object.keys(world.feedReactions).length) {
                world.feedReactions = kept;
                worldDirty = true;
            }
        }

        // 僅當之前是「失敗缺這拍」時補副作用，避免對已有拍重複加好感/重複消息
        if (!hadBeat) {
            applyBeatToThreads(world, beat, members, episode.round, episode.storyTime);
            collectSeeds(world, beat, episode.round, episode.storyTime);
            applyRelationshipDeltas(world, [beat], members);
            worldDirty = true;
            if (world.timeMode !== 'sim' && world.injectToChat !== false) {
                try { await injectWorldCard(world, beat, episode.round, episode.storyTime); } catch { /* ignore */ }
            }
        }
        if (worldDirty) {
            await DB.saveWorld({ ...world, threads: world.threads, seeds: world.seeds, relationships: world.relationships, feedReactions: world.feedReactions, updatedAt: Date.now() });
        }
        dispatch('world-episode-done', { worldId: world.id, episodeId: updatedEp.id, storyTime: episode.storyTime, round: episode.round });
        return { ok: true, episode: updatedEp };
    } catch (err) {
        console.error('[WorldHome] reroll error:', err);
        return { ok: false, reason: 'error' };
    } finally {
        running.delete(world.id);
        dispatch('world-episode-end', { worldId: world.id });
    }
}
