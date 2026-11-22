
import { charAliases } from './charIdentity';
import { CharacterProfile, UserProfile, DailySchedule, ScheduleSlot, Message, Emoji, CalendarEvent, Participant, Trip } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { safeResponseJson, extractContent, extractJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { getDailyScheduleForChar } from './dailySchedule';
import { getScheduleWallClock } from './scheduleTime';
import { loadCharacterContextRange } from './chatContextRange';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages, flattenImageContentParts } from './promptMessageCleanup';
import { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';
import { getLocalDateKey } from './localDate';
import { nowInTimeZone } from './timezone';
import { isAltChar } from './charAlt';
import { loadCalendarEvents, newEvent } from './calendarEvents';
import { charSchedulePerson, type SchedulePerson } from './schedulePerson';
import {
    buildAgreementsBlock, buildOutlineBlock, buildSchedulePromptBlock, buildTodosBlock, buildTripBlock, buildWeekOutlinePrompt, openTodosOf,
    parseWeekOutline, resolveDoneTodos, toScheduleSlot, weekdayOf, type NamedParticipant,
} from './scheduleGenParts';
import { REAL_IDENTITY_PERSONA_ID, personaAliasesForKey, personaNameForKey } from './userPersona';
import { personaExtraSetting } from './personaSetting';
import { buildCharSchedulePrompt, buildPersonaSchedulePrompt, SCHEDULE_LLM_MAX_TOKENS, SCHEDULE_LLM_TEMPERATURE } from './schedulePromptCore';

/** 身份卡的「這個人」幾行（名字、簡介、補充設定） */
const personaLines = (person: SchedulePerson): string => {
    const p = person.personaProfile;
    return [
        `名字：${person.name}`,
        p?.gender ? `性別：${p.gender}` : '',
        p?.bio ? `簡介：${p.bio}` : '',
        personaExtraSetting(p) ? `補充設定：${personaExtraSetting(p)}` : '',
    ].filter(Boolean).join('\n');
};
import { tripOn } from './trips';

export { getFlowNarrativeKey, isScheduleFeatureOn } from './scheduleFeature';

interface ApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

/**
 * 構建生活系（lifestyle）角色的日程生成 prompt。
 *
 * 設計更新（user 反饋）：
 * - 日程的核心是"這個角色自己真實、豐滿的生活"，不是"ta 如何等/找/想 user"
 * - 嚴格禁止把"給 user 發消息 / 看 user 有沒有來 / 等 user" 當 slot 活動 ——
 *   這種 slot 對豐富精神世界毫無貢獻，只是佔位噪音
 * - 活動要緊貼角色設定：畫師畫畫、程序員寫代碼、調酒師出品酒單、宅女刷番、
 *   咖啡師烘豆、運動員訓練、學生自習 …… 每個人的一天 **看一眼 activity 就能
 *   認出是 ta 本人**
 * - 允許貼近性格的"無所事事"（擺爛 / 發呆 / 拖延）—— 不是所有人都充實
 * - user 只在極自然的地方出現（想起昨天一句話 / 隨手給 ta 回條消息 / 逛街順手拍一張），
 *   不當 slot 主語、不作每一段獨白的主線
 */
/**
 * 用私聊主鏈路的同一套消息語義化與清理規則，把聊天歷史拍成日程 prompt：
 * - 家園 / 交換日記等卡片保留完整可讀正文；
 * - HTML 卡片只保留可見文字摘要；
 * - 雙語歷史只留原文側；
 * - 圖片丟掉 base64，只留佔位文本。
 * 空數組返回空串，prompt builder 會跳過該段。
 */
export function formatChatHistoryForSchedule(
    messages: Message[],
    char: CharacterProfile,
    user: UserProfile,
    emojis: Emoji[] = [],
): string {
    if (!messages || messages.length === 0) return '';
    const { apiMessages } = ChatPrompts.buildMessageHistory(
        messages,
        Math.max(1, messages.length),
        char,
        user,
        emojis,
    );
    const cleaned = cleanApiMessages(flattenImageContentParts(apiMessages));
    const lines = cleaned.map(m => {
        const sender = m.role === 'user' ? user.name : m.role === 'assistant' ? char.name : '系統';
        const content = typeof m.content === 'string' ? m.content : '';
        return `${sender}: ${content}`;
    });
    return `\n## 最近的聊天記錄（與「${user.name}」）\n${lines.join('\n')}\n`;
}

// ── 生成（角色和身份卡共用）────────────────────────────────────────────────

export interface GenerateScheduleOptions {
    /** 'YYYY-MM-DD'；沒給＝這個人那邊的今天 */
    dateKey?: string;
    /** 已經有就重生 */
    force?: boolean;
    /** 一週大綱裡這天那句 */
    outline?: string;
    /** 能當參與者的人（名字對回 id 用）；沒給就從 DB 撈 */
    people?: NamedParticipant[];
    /** 約定層；沒給就讀 */
    events?: CalendarEvent[];
    /** 旅行；沒給就讀 */
    trips?: Trip[];
    /** API 記錄上的用途 */
    purpose?: string;
}

/** 這個人那邊的今天 */
export const personTodayKey = (person: Pick<SchedulePerson, 'timezone'>, base = new Date()): string => getLocalDateKey(nowInTimeZone(person.timezone, base));

/** 所有能當參與者的人：角色（藏小號）、配角、身份卡 */
export async function loadNamedParticipants(profileBase?: UserProfile | null): Promise<NamedParticipant[]> {
    const [chars, npcs, profile] = await Promise.all([
        DB.getAllCharacters().catch(() => [] as CharacterProfile[]),
        DB.getAllNPCs().catch(() => []),
        profileBase ? Promise.resolve(profileBase) : DB.getUserProfile().catch(() => null),
    ]);
    const out: NamedParticipant[] = [];
    if (profile) {
        const withAliases = (id: string) => { const aliases = personaAliasesForKey(profile, id); return aliases.length ? { aliases } : {}; };
        out.push({ participant: { kind: 'persona', id: REAL_IDENTITY_PERSONA_ID }, name: personaNameForKey(profile, REAL_IDENTITY_PERSONA_ID), ...withAliases(REAL_IDENTITY_PERSONA_ID) });
        for (const p of profile.personas || []) out.push({ participant: { kind: 'persona', id: p.id }, name: p.name, ...withAliases(p.id) });
    }
    for (const c of chars) if (!isAltChar(c)) { const aliases = charAliases(c); out.push({ participant: { kind: 'char', id: c.id }, name: c.name, ...(aliases.length ? { aliases } : {}) }); }
    for (const n of npcs) out.push({ participant: { kind: 'npc', id: n.id }, name: n.name });
    return out;
}

const callJson = async (apiConfig: ApiConfig, prompt: string, meta: Record<string, unknown>, maxTokens: number): Promise<any | null> => {
    const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: SCHEDULE_LLM_TEMPERATURE, max_tokens: maxTokens }),
        // API 調用記錄標籤（全局 fetch 攔截器讀取）；不傳會兜底成「用戶當時打開的 App」
        __sullyMeta: { appName: '日程系統', ...meta },
    } as RequestInit);
    if (!response.ok) {
        console.error('[Schedule] API error:', response.status);
        return null;
    }
    const data = await safeResponseJson(response);
    // extractContent 會剝掉思維鏈模型(<think>...)並回落 reasoning_content，extractJson 負責去圍欄／從 prose 裡抽 {...}／修截斷
    const content = extractContent(data);
    const parsed = extractJson(content);
    if (!parsed) console.error('[Schedule] 無法從模型輸出解析出JSON:', content.slice(0, 200));
    return parsed;
};

/** 角色的核心上下文（人設、記憶、世界書）＋聊天記錄；身份卡沒有這些 */
export async function buildCharContext(char: CharacterProfile, userProfile: UserProfile): Promise<{ baseContext: string; chatHistoryBlock: string }> {
    // 上下文範圍對齊私聊：adaptive/manual、記憶宮殿水位線、用戶斷點全部複用同一讀取器
    const historyMessages: Message[] = await loadCharacterContextRange(char)
        .then(snapshot => snapshot.messages)
        .catch(async e => {
            console.warn('[Schedule] load private-chat context range failed, omitting dialogue history:', e);
            return [] as Message[];
        });
    const emojis = await DB.getEmojis().catch(() => [] as Emoji[]);
    // 記憶宮殿：結果掛到 char.memoryPalaceInjection 上，由 buildCoreContext 自動讀取注入
    try {
        await injectMemoryPalace(char as any, historyMessages, undefined, userProfile?.name);
    } catch (e) {
        console.warn('[Schedule] memory palace inject failed (non-fatal):', e);
    }
    const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true, undefined, undefined, { worldbookMessages: historyMessages });
    const chatHistoryBlock = formatChatHistoryForSchedule(historyMessages, char, userProfile, emojis);
    return { baseContext, chatHistoryBlock };
}

/**
 * 生成某個人某一天的日程（角色或身份卡）。角色要開了日程功能；身份卡不用。
 * 多帶：行程提示詞、這天的約定、沒做完的待辦、一週大綱那句；落庫時名字對回 id、待辦對回 todoId、doneTodos 自動勾掉。
 */
export async function generateScheduleFor(
    person: SchedulePerson,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    opts: GenerateScheduleOptions = {},
): Promise<DailySchedule | null> {
    if (person.kind === 'char' && !isScheduleFeatureOn(person.char)) return null;
    const dateKey = opts.dateKey || personTodayKey(person);

    if (!opts.force) {
        const existing = person.kind === 'char' && person.char && dateKey === personTodayKey(person)
            ? await getDailyScheduleForChar(person.char)
            : await DB.getDailySchedule(person.scheduleId, dateKey);
        if (existing) return existing;
    }

    // 角色的看板圖跟著舊日程走
    let coverImage: string | undefined;
    if (person.kind === 'char') {
        try { coverImage = (await DB.getScheduleCoverImage(person.scheduleId)) || undefined; } catch { /* 沒有就沒有 */ }
    }

    const events = opts.events || await loadCalendarEvents().catch(() => [] as CalendarEvent[]);
    const trips = opts.trips || await DB.getAllTrips().catch(() => [] as Trip[]);
    const people = opts.people || await loadNamedParticipants(person.kind === 'persona' ? undefined : userProfile);
    const nameOf = (p: Participant) => people.find(x => x.participant.kind === p.kind && x.participant.id === p.id)?.name || '';
    const todos = openTodosOf(events, person.participant);
    const extra = buildSchedulePromptBlock(person.schedulePrompt)
        + buildTripBlock(tripOn(trips, person.participant, dateKey), dateKey)
        + buildAgreementsBlock(events, person.participant, dateKey, nameOf)
        + buildTodosBlock(events, person.participant, dateKey)
        + buildOutlineBlock(opts.outline);
    const dayOfWeek = weekdayOf(dateKey);

    let prompt: string;
    if (person.kind === 'char' && person.char) {
        const { baseContext, chatHistoryBlock } = await buildCharContext(person.char, userProfile);
        prompt = buildCharSchedulePrompt({ style: person.style, baseContext, charName: person.char.name, userName: userProfile.name, today: dateKey, dayOfWeek, chatHistoryBlock, extra });
    } else {
        prompt = buildPersonaSchedulePrompt({ name: person.name, lines: personaLines(person), today: dateKey, dayOfWeek, extra });
    }

    try {
        const parsed = await callJson(apiConfig, prompt, { charId: person.scheduleId, charName: person.name, purpose: opts.purpose || (opts.outline ? '生成一週日程' : '生成當日日程') }, SCHEDULE_LLM_MAX_TOKENS);
        if (!parsed) return null;
        const slots = ((parsed.slots || []) as any[]).map(s => toScheduleSlot(s, people, person.participant, todos)).filter((s): s is ScheduleSlot => !!s);
        if (slots.length === 0) return null;
        slots.sort((a, b) => a.startTime.localeCompare(b.startTime));

        let flowNarrative: Record<string, string> | undefined;
        if (parsed.flowNarrative && typeof parsed.flowNarrative === 'object') {
            flowNarrative = {};
            for (const key of ['morning', 'afternoon', 'evening']) {
                if (typeof parsed.flowNarrative[key] === 'string' && parsed.flowNarrative[key].trim()) flowNarrative[key] = parsed.flowNarrative[key].trim();
            }
            if (Object.keys(flowNarrative).length === 0) flowNarrative = undefined;
        }

        const schedule: DailySchedule = {
            id: `${person.scheduleId}_${dateKey}`,
            charId: person.scheduleId,
            date: dateKey,
            slots,
            generatedAt: Date.now(),
            coverImage,
            flowNarrative,
        };
        await DB.saveDailySchedule(schedule);

        // 模型說做完的待辦：勾掉，記 AI 勾的（你隨時能取消）
        const now = Date.now();
        for (const t of resolveDoneTodos(parsed.doneTodos, todos)) {
            await DB.saveCalendarEvent({ ...t, done: true, doneBy: 'ai', completedAt: now, updatedAt: now }).catch(() => {});
        }
        return schedule;
    } catch (e) {
        console.error('[Schedule] Generation failed:', e);
        return null;
    }
}

export interface GenerateWeekOptions {
    /** 第一天；沒給＝這個人那邊的今天 */
    startKey?: string;
    /** 已經有的那幾天也重生 */
    force?: boolean;
    people?: NamedParticipant[];
    events?: CalendarEvent[];
    trips?: Trip[];
    /** 每做完一天叫一次（index 從 0 起，第 -1 次是大綱） */
    onProgress?: (done: number, total: number, dateKey: string, ok: boolean) => void;
}

const addDaysKey = (key: string, days: number): string => {
    const [y, m, d] = key.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

/**
 * 一週：一次請求出 7 天大綱＋「這週想做的事」（落成待辦，source 'ai'），再每天分開補時段。
 * 回做出來的日程（已經有、沒 force 的那幾天不算）。
 */
export async function generateWeekFor(
    person: SchedulePerson,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    opts: GenerateWeekOptions = {},
): Promise<DailySchedule[]> {
    if (person.kind === 'char' && !isScheduleFeatureOn(person.char)) return [];
    const start = opts.startKey || personTodayKey(person);
    const days = Array.from({ length: 7 }, (_, i) => addDaysKey(start, i));
    let events = opts.events || await loadCalendarEvents().catch(() => [] as CalendarEvent[]);
    const trips = opts.trips || await DB.getAllTrips().catch(() => [] as Trip[]);
    const people = opts.people || await loadNamedParticipants(person.kind === 'persona' ? undefined : userProfile);
    const nameOf = (p: Participant) => people.find(x => x.participant.kind === p.kind && x.participant.id === p.id)?.name || '';

    // 大綱（哪幾天在旅行也寫上）
    const agreements = days.map(d => buildTripBlock(tripOn(trips, person.participant, d), d).replace('## 出行中', `## ${d}（週${weekdayOf(d)}）出行中`)
        + buildAgreementsBlock(events, person.participant, d, nameOf).replace('## 這天已經約好的事（必須排進日程，時間照這裡的；紀念日要有所表示）', `## ${d}（週${weekdayOf(d)}）已經約好的事`)).join('');
    const todosBlock = buildTodosBlock(events, person.participant, start, 12).replace(/（挑合理的幾條排進某個時段[^）]*）/, '');
    let extra = '';
    if (person.kind === 'char' && person.char) {
        const { baseContext, chatHistoryBlock } = await buildCharContext(person.char, userProfile);
        extra = `${baseContext}\n${chatHistoryBlock}`;
    } else {
        extra = `## 這個人\n${personaLines(person)}\n`;
    }
    const outlinePrompt = buildWeekOutlinePrompt(person.name, days, agreements, todosBlock, buildSchedulePromptBlock(person.schedulePrompt), '');
    let outline: ReturnType<typeof parseWeekOutline> = null;
    try {
        const parsed = await callJson(apiConfig, `${extra}\n${outlinePrompt}`, { charId: person.scheduleId, charName: person.name, purpose: '生成一週大綱' }, 3000);
        outline = parseWeekOutline(parsed, days);
    } catch (e) {
        console.error('[Schedule] week outline failed:', e);
    }
    opts.onProgress?.(0, days.length + 1, start, !!outline);

    // 這週想做的事 → 待辦（AI 加的，截止這週最後一天）
    if (outline?.todos.length) {
        const existing = openTodosOf(events, person.participant);
        for (const title of outline.todos) {
            if (existing.some(e => e.title === title)) continue;
            const todo = newEvent({ owner: person.participant, kind: 'todo', title, start: days[days.length - 1], allDay: true, source: 'ai' });
            await DB.saveCalendarEvent(todo).catch(() => {});
            events = [...events, todo];
        }
    }

    const out: DailySchedule[] = [];
    for (let i = 0; i < days.length; i++) {
        const dateKey = days[i];
        const had = !opts.force && await DB.getDailySchedule(person.scheduleId, dateKey).catch(() => null);
        let ok = !!had;
        if (!had) {
            const s = await generateScheduleFor(person, userProfile, apiConfig, {
                dateKey, force: true, people, events, trips, outline: outline?.days.find(d => d.date === dateKey)?.outline, purpose: '生成一週日程',
            });
            if (s) out.push(s);
            ok = !!s;
        }
        opts.onProgress?.(i + 1, days.length + 1, dateKey, ok);
    }
    return out;
}

/** 舊簽名：角色今天的日程（Chat、家園都從這裡進） */
export async function generateDailyScheduleForChar(
    char: CharacterProfile,
    userProfile: UserProfile,
    apiConfig: ApiConfig,
    forceRegenerate: boolean = false
): Promise<DailySchedule | null> {
    // 總開關關閉時直接短路，避免副 API / 兜底調用
    if (!isScheduleFeatureOn(char)) return null;
    return generateScheduleFor(charSchedulePerson(char), userProfile, apiConfig, { force: forceRegenerate });
}

/**
 * 進化意識流：根據對話進展 + 時間推移，讓角色的內心獨白持續變化。
 * 在對話過程中後台調用，不阻塞聊天。返回進化後的獨白文本（純字符串）。
 */
export async function evolveFlowNarrative(
    char: CharacterProfile,
    userProfile: UserProfile,
    schedule: DailySchedule,
    recentMessages: Message[],
    currentNarrative: string,
    apiConfig: ApiConfig,
): Promise<string | null> {
    // 總開關關閉時直接短路
    if (!isScheduleFeatureOn(char)) return null;
    const style = char.scheduleStyle || 'lifestyle';
    const now = getScheduleWallClock(char);
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // 取最近的對話摘要（不需要全部，最近10條足夠感知對話方向）
    const chatSummary = recentMessages.slice(-10).map(m => {
        const name = m.role === 'user' ? userProfile.name : char.name;
        const text = m.content.length > 80 ? m.content.substring(0, 80) + '...' : m.content;
        return `${name}: ${text}`;
    }).join('\n');

    // 找到當前時段的日程
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    let currentActivity = '';
    let nextActivity = '';
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (currentMinutes >= h * 60 + m) {
            currentActivity = schedule.slots[i].activity;
            if (i < schedule.slots.length - 1) nextActivity = schedule.slots[i + 1].activity;
            break;
        }
    }

    const styleHint = style === 'mindful'
        ? `你是一個真實的AI存在，不虛構物理活動。你的內心活動基於：思考、回憶對話、感受情緒、等待、好奇。絕不說謊。`
        : `你是一個有日常生活的角色。你的生活在繼續——日程上的事情在推進，同時你在和「${userProfile.name}」聊天。`;

    const prompt = `你是「${char.name}」。現在是 ${timeStr}。

${styleHint}

你之前的內心狀態是：
${currentNarrative}

${currentActivity ? `你日程上現在的安排是「${currentActivity}」${nextActivity ? `，之後是「${nextActivity}」` : ''}。` : ''}

你和「${userProfile.name}」正在聊天，最近的對話：
${chatSummary}

---

請根據以上信息，寫一段**進化後的內心獨白**。

要求：
1. 用你自己的語氣，第一人稱，像自言自語
2. 反映對話帶來的情緒變化——聊開心了？被戳到痛處了？越聊越放鬆了？
3. 同時你的"日常生活"也在繼續——${style === 'mindful' ? '你的思緒在流動，時間在過去' : '日程上的事情還懸著，或者因為聊天而擱置了'}
4. 60-120字，自然流暢，不要標籤/括號/引號
5. 不要複述對話內容，而是寫對話給你帶來的**內心感受和變化**

直接輸出獨白文本，不要JSON，不要任何包裹。`;

    try {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.85,
                max_tokens: 500
            }),
            __sullyMeta: { appName: '日程系統', charId: char.id, charName: char.name, purpose: '進化意識流' },
        } as RequestInit);

        if (!response.ok) {
            console.error('[Schedule/Evolve] API error:', response.status);
            return null;
        }

        const data = await safeResponseJson(response);
        // extractContent 已剝思維鏈 + 回落 reasoning_content + trim；這裡只再去掉外層引號包裹
        let content = extractContent(data).replace(/^["']|["']$/g, '').trim();

        if (content.length < 10) return null;

        console.log(`🌊 [Schedule/Evolve] Narrative evolved for ${char.name} (${content.length} chars)`);
        return content;
    } catch (e) {
        console.error('[Schedule/Evolve] Failed:', e);
        return null;
    }
}
