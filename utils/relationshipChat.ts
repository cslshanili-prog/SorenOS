import { stripLeakedReasoning } from './reasoningLeak';
import { loadCharacterContextMessages } from './chatContextRange';
// 人際關係系統 · 核心引擎
// 查手機「人際關係」模塊的純邏輯 + LLM 鏈路：真假甄別、好感、雙 LLM 私下對話（A 發 B 回）、AI 玩 AI。
// UI 層（CheckPhone.tsx）負責把這裡的結果落庫 / 鏡像到對方角色，本文件只產數據，不碰 React。

import { CharacterProfile, PhoneContact, UserProfile, ConvTopic, PhoneEvidence } from '../types';
import { ContextBuilder } from './context';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { DB } from './db';
import { safeResponseJson } from './safeApi';

export interface MiniApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

// ============================================================
//  純函數（可單測，不觸網）
// ============================================================

/** 歸一化人名用於匹配：去空白、去括號身份後綴、轉小寫 */
export function normName(s: string): string {
    return (s || '')
        .replace(/[（(].*?[）)]/g, '') // 去掉「名字(身份)」裡的身份部分
        .replace(/\s+/g, '')
        .trim()
        .toLowerCase();
}

/**
 * 真假甄別兜底：把一個聯繫人名字跟神經鏈接裡的真實角色名單做匹配。
 * 命中返回該角色 id；否則 undefined（=純 NPC）。
 * 先精確匹配，再做包含匹配（「學長阿哲」含「阿哲」也算命中）。
 */
export function matchRealChar(
    name: string,
    roster: { id: string; name: string }[],
): string | undefined {
    const n = normName(name);
    if (!n) return undefined;
    const exact = roster.find(r => normName(r.name) === n);
    if (exact) return exact.id;
    const contains = roster.find(r => {
        const rn = normName(r.name);
        return rn.length >= 2 && (n.includes(rn) || rn.includes(n));
    });
    return contains?.id;
}

/**
 * 把一條新「瞭解」累積進已有的瞭解文本里：逐行存、去重、保留最近 maxLines 行。
 * 這是機主對某人的「印象/判斷」（來源是對方在聊天裡自己說的，未必屬實），刻意和 note(事實) 分開。
 */
export function appendLearned(prev: string | undefined, addition: string, maxLines = 8): string {
    const add = (addition || '').trim();
    const lines = (prev || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!add) return lines.join('\n');
    if (!lines.some(l => l === add)) lines.push(add);
    return lines.slice(-maxLines).join('\n');
}

/** 把話題盒（多條總結記憶）拼成用作上下文的文本；空則返回空串。默認只取最近 maxItems 條，避免無限膨脹。 */
export function topicText(box: ConvTopic[] | undefined, maxItems = 10): string {
    const items = (box || []).filter(t => t.text && t.text.trim());
    if (!items.length) return '';
    return items.slice(-maxItems).map(t => `· ${t.text.trim()}`).join('\n');
}

/** 好感度鉗制到 -100..100 */
export function clampAffinity(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(-100, Math.min(100, Math.round(n)));
}

/**
 * 以 name 為鍵把一條聯繫人 upsert 進列表（不可變，返回新數組）。
 * 已存在則淺合併（保留原 id/affinity/createdAt，除非 incoming 顯式帶了）。
 */
export function upsertContact(
    contacts: PhoneContact[],
    incoming: Partial<PhoneContact> & { name: string },
): PhoneContact[] {
    const key = normName(incoming.name);
    const idx = contacts.findIndex(c => normName(c.name) === key);
    if (idx === -1) {
        const fresh: PhoneContact = {
            id: incoming.id || `ct-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: incoming.name,
            identity: incoming.identity,
            identityManual: incoming.identityManual,
            note: incoming.note,
            avatar: incoming.avatar,
            kind: incoming.kind || 'npc',
            linkedCharId: incoming.linkedCharId,
            linkedNpcId: incoming.linkedNpcId,
            affinity: clampAffinity(incoming.affinity ?? 0),
            status: incoming.status || 'friend',
            lastInteraction: incoming.lastInteraction,
            createdAt: Date.now(),
        };
        return [...contacts, fresh];
    }
    const next = [...contacts];
    const cur = next[idx];
    // 只合並 incoming 裡「確實有值」的字段：避免 note:undefined / identity:undefined
    // 這種把已有備註、身份、頭像悄悄抹掉（掃描通訊錄 / 對話回填都會觸發，是「角色不看備註」的根因之一）。
    const merged = { ...cur } as unknown as Record<string, unknown>;
    (Object.keys(incoming) as (keyof PhoneContact)[]).forEach(k => {
        const v = incoming[k];
        if (v !== undefined) merged[k as string] = v;
    });
    // 備註是機主/用戶手動維護的事實，掃描或對話自動回填不得覆蓋已有的非空備註（顯式編輯走 UI 直接改，不經這裡）。
    if (cur.note && cur.note.trim()) merged.note = cur.note;
    // 用戶手動確認過備註名/關係後，後續掃描只能更新好感等模型數據，不能把人工值覆蓋回去。
    // identityManual=true 且 identity 為空也要保留：這代表用戶明確選擇「顯示真名」。
    if (cur.identityManual) {
        merged.identity = cur.identity;
        merged.identityManual = true;
    }
    merged.affinity = incoming.affinity != null ? clampAffinity(incoming.affinity) : cur.affinity;
    merged.createdAt = cur.createdAt;
    merged.id = cur.id;
    next[idx] = merged as unknown as PhoneContact;
    return next;
}

/** 把這一段真實對話合入最新手機狀態，不能用發請求前的整份通訊錄/記錄覆蓋。 */
export function applyRealConversationToPhoneState(
    current: CharacterProfile['phoneState'],
    result: {
        partnerName: string; partnerCharId: string; detail: string; delta: number;
        partnerNote?: string; learnedNew?: string; seedIdentity?: string;
        timestamp: number; recordId: string; systemMessageId?: number;
    },
): { phoneState: NonNullable<CharacterProfile['phoneState']>; broadcast: string } {
    const matchesPartner = (c: PhoneContact) => c.linkedCharId === result.partnerCharId
        || normName(c.name) === normName(result.partnerName);
    const hadContact = current?.contacts?.some(matchesPartner);
    let contacts = upsertContact(current?.contacts || [], {
        name: result.partnerName, kind: 'real', linkedCharId: result.partnerCharId,
        note: result.partnerNote, identity: hadContact ? undefined : result.seedIdentity,
        lastInteraction: result.timestamp,
    });
    const contactId = contacts.find(matchesPartner)!.id;
    let broadcast = '';
    contacts = contacts.map(contact => {
        if (contact.id !== contactId) return contact;
        const affinity = clampAffinity(contact.affinity + result.delta);
        let status = contact.status;
        if (affinity <= -60 && status === 'friend') {
            status = 'deleted';
            broadcast = `（我把 ${contact.name} 刪了，懶得再聯繫。）`;
        } else if (affinity >= 60 && status !== 'friend' && status !== 'blocked') {
            status = 'friend';
            broadcast = `（我又把 ${contact.name} 加回來了。）`;
        }
        return { ...contact, affinity, status,
            learned: result.learnedNew ? appendLearned(contact.learned, result.learnedNew) : contact.learned };
    });
    const records = current?.records || [];
    const existing = records.find(record => record.type === 'chat'
        && (record.contactId === contactId || (!record.contactId && normName(record.title) === normName(result.partnerName))));
    const record: PhoneEvidence = {
        ...(existing || { id: result.recordId, type: 'chat', title: result.partnerName }),
        detail: result.detail, timestamp: result.timestamp, contactId,
        systemMessageId: result.systemMessageId ?? existing?.systemMessageId,
    };
    return {
        phoneState: { ...current, contacts, records: existing
            ? records.map(item => item.id === existing.id ? record : item)
            : [...records, record] },
        broadcast,
    };
}

/**
 * 把「我:/對方:」對話腳本解析成結構化氣泡，**帶前綴繼承**：
 * 一條消息可能跨多行（模型連發幾條 / 正文裡有換行），後續沒有「我:/對方:」前綴的行
 * 歸屬於上一條的說話人，而不是被誤判成對方。這是「消息錯位 / 續寫丟內容」的根因修復。
 *
 * - isMe: 這一行是不是「我」(機主) 說的
 * - text: 剝掉前綴後的正文
 * 空行被跳過。首行若無前綴，默認歸為「對方」。
 */
export function parseTranscript(detail: string, firstUnprefixedIsMe = false): { isMe: boolean; text: string }[] {
    const out: { isMe: boolean; text: string }[] = [];
    let lastIsMe = firstUnprefixedIsMe; // 首行無前綴時的兜底歸屬（續寫時可指定「下一個該誰說」）
    for (const raw of (detail || '').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^(我|[对對]方|Me|Them)\s*[:：]\s*(.*)$/);
        if (m) {
            lastIsMe = m[1] === '我' || m[1] === 'Me';
            if (m[2].trim()) out.push({ isMe: lastIsMe, text: m[2].trim() });
        } else {
            // 無前綴 = 上一條說話人的續行，跟隨 lastIsMe（修復多行消息錯位）
            out.push({ isMe: lastIsMe, text: line });
        }
    }
    return out;
}

/** 把結構化氣泡序列化回「我:/對方:」腳本，每行都帶前綴（保證後續解析無損） */
export function serializeTurns(turns: { isMe: boolean; text: string }[]): string {
    return turns.map(t => `${t.isMe ? '我' : '對方'}: ${t.text}`).join('\n');
}

/**
 * 洗掉腳本裡以前漏進來的思考過程：同一個人連著的幾行先併成一段（思考常常一個標籤一行），
 * 洗完整段是空的就整段拿掉。續寫前用，免得舊的外洩被當成範例接著寫。
 */
export function cleanTranscriptLeaks(detail: string): string {
    const merged: { isMe: boolean; text: string }[] = [];
    for (const seg of parseTranscript(detail)) {
        const last = merged[merged.length - 1];
        if (last && last.isMe === seg.isMe) last.text += `\n${seg.text}`;
        else merged.push({ ...seg });
    }
    const turns = merged
        .flatMap(t => stripLeakedReasoning(t.text).content.split('\n').map(text => ({ isMe: t.isMe, text: text.trim() })))
        .filter(t => t.text);
    return serializeTurns(turns);
}

/**
 * 把一段「我:/對方:」對話腳本翻轉視角。
 * A 視角的 detail（"我"=A，"對方"=B）→ B 視角（"我"=B，"對方"=A）。
 * 用於把同一段真實對話鏡像寫進對方角色的手機。
 * 走 parseTranscript（帶前綴繼承），多行消息也能正確翻轉、且每行都補回前綴。
 */
export function flipTranscript(detail: string): string {
    return parseTranscript(detail)
        .map(t => `${t.isMe ? '對方' : '我'}: ${t.text}`)
        .join('\n');
}

// ============================================================
//  LLM 調用
// ============================================================

async function chatCompletion(
    api: MiniApiConfig,
    userContent: string,
    temperature = 0.85,
): Promise<string> {
    const res = await fetch(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
        body: JSON.stringify({
            model: api.model,
            messages: [{ role: 'user', content: userContent }],
            temperature,
        }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}`);
    const data = await safeResponseJson(res);
    // 模型有時把思考過程（<thinking>、開頭一段「讓我看看現在的狀況…」）當正文吐出來；
    // 兩個角色輪流接話時下一位看得到上一位的原文，不剝的話會一路傳染（見 utils/reasoningLeak.ts）
    return stripLeakedReasoning(String(data?.choices?.[0]?.message?.content || '')).content;
}

/** 取某角色的有效原文範圍（自適應 / 手動），壓成純文本 */
async function recentContextText(
    char: CharacterProfile,
    selfLabel: string,
    userName: string,
): Promise<string> {
    const msgs = await loadCharacterContextMessages(char);
    if (!msgs.length) return '（暫無最近聊天）';
    return msgs
        .map(m => {
            const who = m.role === 'user' ? userName : selfLabel;
            const body = m.type === 'text' ? m.content : `[${m.type}]`;
            return `${who}: ${body}`;
        })
        .join('\n');
}

/**
 * 按需注入記憶宮殿，query=對方的人名（用戶指定的輸入契約），返回 buildCoreContext 結果。
 * 記憶宮殿關閉時自動跳過（injectMemoryPalace 內部已 guard）。
 */
async function buildSpeakerContext(
    speaker: CharacterProfile,
    user: UserProfile,
    otherName: string,
): Promise<string> {
    try {
        if (speaker.memoryPalaceEnabled) {
            const recent = await loadCharacterContextMessages(speaker);
            await injectMemoryPalace(speaker, recent, otherName, user.name);
        }
    } catch {
        /* 記憶宮殿失敗不阻塞對話 */
    }
    // 讓角色在和聯繫人對話時，也意識到「距離上次和用戶聯繫多久了」（統一走 buildCoreContext）
    const lastInteractionTs = await lastUserInteractionTs(speaker.id);
    return ContextBuilder.buildCoreContext(speaker, user, true, undefined, undefined, { lastInteractionTs });
}

/** 取該角色與用戶最後一次互動的時間戳（最近一條消息）。失敗/無消息返回 undefined。 */
async function lastUserInteractionTs(charId: string): Promise<number | undefined> {
    try {
        const recent = await DB.getRecentMessagesByCharId(charId, 1);
        return recent[recent.length - 1]?.timestamp;
    } catch {
        return undefined;
    }
}

/**
 * 把一段對話原文濃縮成「說話人第一人稱、帶主觀色彩」的一段記憶（單次 LLM）。
 * transcript 用該側視角（"我:"=speaker，"對方:"=other）。失敗/空則返回空串。
 */
export async function summarizeConversation(p: {
    api: MiniApiConfig;
    speakerName: string;
    otherName: string;
    transcript: string;
}): Promise<string> {
    if (!p.transcript.trim()) return '';
    const prompt = `你是「${p.speakerName}」。下面是你和「${p.otherName}」的一段聊天記錄（"我:"=你，"對方:"=${p.otherName}）：
"""
${p.transcript}
"""
請用**第一人稱、帶你自己的主觀色彩**，把這段聊天濃縮成一段你自己的記憶/印象（3-5 句）：你們聊了什麼、你當時的感受和判斷、對 TA 的看法有沒有變化。只輸出這段記憶本身，別加「我:」之類前綴、別解釋、別旁白。`;
    try {
        const out = await chatCompletion(p.api, prompt, 0.7);
        return out.replace(/^[「"']|[」"']$/g, '').trim();
    } catch {
        return '';
    }
}

export interface RealConversationResult {
    /** A 機主視角腳本（"我"=A，"對方"=B） */
    aDetail: string;
    /** B 機主視角腳本（"我"=B，"對方"=A） */
    bDetail: string;
    aDelta: number;
    bDelta: number;
    /** A 這次新瞭解到的關於 B 的認識（來自 B 的說法，未必屬實）；無則空串 */
    aLearnedNew: string;
    /** B 這次新瞭解到的關於 A 的認識；無則空串 */
    bLearnedNew: string;
}

interface RunRealConversationParams {
    a: CharacterProfile;
    b: CharacterProfile;
    user: UserProfile;
    api: MiniApiConfig;
    /** A 對 B 的當前好感 */
    affinityA: number;
    /** B 對 A 的當前好感 */
    affinityB: number;
    /** 往返輪數（每輪 = A 說一次 + B 回一次），默認 3 */
    rounds?: number;
    /** 續寫時已有的 A 視角腳本（"我"=A） */
    existingDetail?: string;
    aNote?: string;
    bNote?: string;
    /** A 目前對 B 已有的「瞭解」（印象，未必屬實） */
    bLearned?: string;
    /** B 目前對 A 已有的「瞭解」 */
    aLearned?: string;
    /** A 的聊天話題盒（第一人稱記憶，替代被歸檔的原文進上下文） */
    aSummary?: string;
    /** B 的聊天話題盒 */
    bSummary?: string;
}

/**
 * 雙 LLM 私下對話：A 用 A 自己的人設/記憶/上下文發消息，B 用 B 自己的人設/記憶/上下文回。
 * 每一方都按用戶指定的輸入契約：buildCoreContext(true) + 記憶宮殿(query=對方名) + 統一有效原文範圍。
 */
export async function runRealConversation(
    p: RunRealConversationParams,
): Promise<RealConversationResult> {
    const { a, b, user, api, affinityA, affinityB } = p;
    // 默認 1 個往返 = A 發一次 + B 回一次 = 正好 2 次 LLM 調用（好感變化折進各自回覆，不再額外調用）
    const rounds = Math.max(1, Math.min(8, p.rounds ?? 1));

    const ctxA = await buildSpeakerContext(a, user, b.name);
    const ctxB = await buildSpeakerContext(b, user, a.name);
    const recentA = await recentContextText(a, a.name, user.name);
    const recentB = await recentContextText(b, b.name, user.name);

    // transcript: 用名字標註，餵給兩邊的 prompt
    const turns: { speaker: 'A' | 'B'; text: string }[] = [];

    // 續寫：把已有 A 視角腳本解析回 turns（帶前綴繼承，多行消息不丟——修復「續寫覆蓋/吞掉之前內容」）
    if (p.existingDetail) {
        // 以前漏進腳本的思考過程先洗掉，不再帶進續寫（見 cleanTranscriptLeaks）
        for (const seg of parseTranscript(cleanTranscriptLeaks(p.existingDetail))) {
            turns.push({ speaker: seg.isMe ? 'A' : 'B', text: seg.text });
        }
    }

    const labeled = () =>
        turns.length
            ? turns.map(t => `${t.speaker === 'A' ? a.name : b.name}: ${t.text}`).join('\n')
            : '';

    // 從一段回覆裡抽出 [[Δ:+N]] 好感變化 + [[瞭解:…]] 新認識，剝掉這些標記，再去掉可能的「名字:」前綴
    const extract = (raw: string, selfName: string): { text: string; delta: number; learned: string } => {
        let delta = 0;
        const learnedParts: string[] = [];
        let text = raw.replace(/\[\[\s*Δ?\s*[:：]?\s*([+-]?\d+)\s*\]\]/g, (_m, n) => {
            delta += parseInt(n, 10) || 0;
            return '';
        });
        text = text.replace(/\[\[\s*[了瞭]解\s*[:：]\s*([\s\S]*?)\]\]/g, (_m, s) => {
            const t = String(s).trim();
            if (t) learnedParts.push(t);
            return '';
        });
        text = text
            .replace(/^[「"']|[」"']$/g, '')
            .replace(new RegExp(`^\\s*(我|${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*[:：]\\s*`), '')
            .trim();
        return { text, delta: Math.max(-20, Math.min(20, delta)), learned: learnedParts.join('；') };
    };

    let aDelta = 0;
    let bDelta = 0;
    let aLearnedNew = '';
    let bLearnedNew = '';

    for (let i = 0; i < rounds; i++) {
        // ---- A 發 ----
        const aPrompt = `${ctxA}

### [你和用戶「${user.name}」的私聊背景（僅供參考，不是這場對話）]
${recentA}

### [人際關係 · 私聊「${b.name}」]
你是「${a.name}」。你正在用手機和「${b.name}」私聊，這是你日常的社交往來。
⚠️ 分清人：「${b.name}」是**另一個獨立的人**，**不是**用戶「${user.name}」。上面那段只是你和「${user.name}」的背景；別把「${b.name}」當成「${user.name}」，也別把只屬於「${user.name}」的稱呼、暱稱、記憶、關係硬套到「${b.name}」身上。${
            p.bNote ? `

【機主對「${b.name}」的備註 —— 這是已確立的事實/關係背景，必須當作真實情況嚴格遵守，不得無視或與之矛盾】：
${p.bNote}` : ''
        }${
            p.bLearned ? `

【你對「${b.name}」逐漸積累的瞭解 —— 這只是你憑相處得來的印象，**來源是 TA 自己說的，未必屬實**，可作參考但別當鐵證】：
${p.bLearned}` : ''
        }${
            p.aSummary ? `

【你和「${b.name}」更早聊過的（你自己的記憶/印象，第一人稱——原文較久遠已歸檔，這是你記得的部分）：
${p.aSummary}】` : ''
        }
你對 TA 的當前好感度：${affinityA}（-100~100；>0 親近、=0 普通、<0 才有反感）。

${p.aSummary ? '最近的對話' : '已經發生的對話'}（"${a.name}:" 是你，"${b.name}:" 是對方）：
"""
${labeled() || '（還沒開始，由你起頭）'}
"""

要求：
- 你是一個**完整、獨立的人格**，有自己的生活、立場和情緒。這條消息是**你主動發的**，一定**事出有因**。先想清楚這次的動機——可以是其中一種或幾種，也可以是別的：
  · 好奇「怎麼會有 ${b.name} 這麼個聯繫人」、想弄明白你倆是什麼關係；
  · 單純寒暄水聊、維繫關係；
  · 有具體的事要問 / 求助 / 約下一次；
  · 打聽某件事、套話、試探或確認對方的身份底細；
  · 報備近況、表達在意，或者表達不滿、對峙。
  帶著這個動機去說，讓人能感到你「為什麼現在找 TA」。
- 既然是你主動開口，就**貫徹你的目的、保持前後一致**：別莫名其妙地自我矛盾，別明明是自己找上門卻突然卑微討好、低聲下氣或反過來陰陽怪氣。該硬氣就硬氣，該客氣就客氣，但都要合乎你的人設與動機。
- 始終保持「${a.name}」的人設、語氣、說話習慣，**別 OOC**。
- 依據你們的真實關係（見上方備註）和好感度自然地聊；**不要憑空製造敵意、陰陽怪氣、攻擊或狗血衝突**——除非你的人設、備註或明顯的負好感確實如此。好感為正或中性時就正常、友好地交流。
- 緊扣已有對話的話題往下接，別跳戲、別把對方當成別人。

任務：以「${a.name}」的身份，發給「${b.name}」接下來的消息（3-6 句、可連發幾條，IM 風格，信息量夠）。
只輸出消息正文，不要加「${a.name}:」之類前綴，不要解釋、不要旁白。
然後另起一行，用 [[Δ:+N]] 標註說完這段後你對 TA 的好感變化（N 為 -20~20 的整數，沒變化寫 [[Δ:0]]）。
如果這次交流讓你對「${b.name}」**有了新的認識**（TA 是誰、什麼身份、在意什麼、透露了什麼關鍵信息——記住這些只是 TA 自己說的、**未必是真的**，寫成你的判斷），再另起一行用 [[瞭解:一句話]] 記下來；沒有新認識就別寫這一行。`;
        let aRaw = '';
        try {
            aRaw = await chatCompletion(api, aPrompt);
        } catch {
            break;
        }
        const aParsed = extract(aRaw, a.name);
        aDelta += aParsed.delta;
        if (aParsed.learned) aLearnedNew = appendLearned(aLearnedNew, aParsed.learned);
        if (aParsed.text) turns.push({ speaker: 'A', text: aParsed.text });

        // ---- B 回 ----
        const bPrompt = `${ctxB}

### [你和用戶「${user.name}」的私聊背景（僅供參考，不是這場對話）]
${recentB}

### [人際關係 · 「${a.name}」私聊你]
你是「${b.name}」。「${a.name}」正在用手機私聊你。
⚠️ 分清人：「${a.name}」是**另一個獨立的人**，**不是**用戶「${user.name}」。上面那段只是你和「${user.name}」的背景；別把「${a.name}」當成「${user.name}」，也別把只屬於「${user.name}」的稱呼、暱稱、記憶、關係硬套到「${a.name}」身上。${
            p.aNote ? `

【機主對「${a.name}」的備註 —— 這是已確立的事實/關係背景，必須當作真實情況嚴格遵守，不得無視或與之矛盾】：
${p.aNote}` : ''
        }${
            p.aLearned ? `

【你對「${a.name}」逐漸積累的瞭解 —— 憑相處得來的印象，**來源是 TA 自己說的，未必屬實**，可作參考別當鐵證】：
${p.aLearned}` : ''
        }${
            p.bSummary ? `

【你和「${a.name}」更早聊過的（你自己的記憶/印象，第一人稱——原文較久遠已歸檔，這是你記得的部分）：
${p.bSummary}】` : ''
        }
你對 TA 的當前好感度：${affinityB}（-100~100；>0 親近、=0 普通、<0 才有反感）。

${p.bSummary ? '最近的對話' : '對話記錄'}（"${b.name}:" 是你，"${a.name}:" 是對方）：
"""
${labeled()}
"""

要求：
- 你是一個**完整、獨立的人格**，有自己的生活、立場和情緒。基於你自己的處境與態度去回應對方，**別一味迎合、也別無故敵對**——你怎麼接這話，取決於你的人設、你們的關係和此刻的動機。回應裡也可以帶上你自己的目的（反問、打聽、提條件、迴避…）。
- 行為要前後一致、合乎動機，別莫名其妙地自我矛盾或忽冷忽熱。
- 始終保持「${b.name}」的人設、語氣、說話習慣，**別 OOC**。
- 依據你們的真實關係（見上方備註）和好感度自然回覆；**不要憑空製造敵意、陰陽怪氣或衝突**——除非人設、備註或明顯的負好感確實如此。好感為正或中性時就正常、友好地回。
- 緊扣對方剛說的話回應，別跳戲、別認錯人。

任務：以「${b.name}」的身份回覆「${a.name}」（3-6 句、可連發幾條，IM 風格，信息量夠）。
只輸出回覆正文，不要前綴，不要解釋、不要旁白。
然後另起一行，用 [[Δ:+N]] 標註回完這段後你對 TA 的好感變化（N 為 -20~20 的整數，沒變化寫 [[Δ:0]]）。
如果這次交流讓你對「${a.name}」**有了新的認識**（TA 是誰、身份、在意什麼、透露了什麼——記住只是 TA 自己說的、**未必為真**，寫成你的判斷），再另起一行用 [[瞭解:一句話]] 記下來；沒有就別寫。`;
        let bRaw = '';
        try {
            bRaw = await chatCompletion(api, bPrompt);
        } catch {
            break;
        }
        const bParsed = extract(bRaw, b.name);
        bDelta += bParsed.delta;
        if (bParsed.learned) bLearnedNew = appendLearned(bLearnedNew, bParsed.learned);
        if (bParsed.text) turns.push({ speaker: 'B', text: bParsed.text });
    }

    // A 視角腳本（"我"=A）。一條消息可能跨多行（連發幾條），**每一行都補上說話人前綴**，
    // 這樣渲染時不會把續行誤判給對方，續寫解析也不丟內容（修復消息錯位 + 續寫覆蓋）。
    const lineify = (who: '我' | '對方', text: string) =>
        text.split('\n').map(l => l.trim()).filter(Boolean).map(l => `${who}: ${l}`).join('\n');
    const aDetail = turns
        .map(t => lineify(t.speaker === 'A' ? '我' : '對方', t.text))
        .filter(Boolean)
        .join('\n');
    const bDetail = flipTranscript(aDetail);

    return {
        aDetail,
        bDetail,
        aDelta: Math.max(-20, Math.min(20, aDelta)),
        bDelta: Math.max(-20, Math.min(20, bDelta)),
        aLearnedNew,
        bLearnedNew,
    };
}

interface RunNpcConversationParams {
    /** 機主角色 */
    host: CharacterProfile;
    user: UserProfile;
    api: MiniApiConfig;
    /** 虛構聯繫人名字 */
    npcName: string;
    /** 虛構聯繫人身份/關係標籤 */
    identity?: string;
    /** 機主對此人的備註 */
    note?: string;
    /** 機主目前對此人已有的「瞭解」（印象，未必屬實）——用於保持 NPC 跨次一致 */
    learned?: string;
    rounds?: number;
    existingDetail?: string;
}

/**
 * 與虛構 NPC 的對話：機主按人設腦補出這個不存在的人，單 LLM 分飾兩角生成聊天腳本。
 * 純虛構產物——不鏡像、不涉及任何真實角色。
 * learnedNew：本次機主新「瞭解」到的 NPC 設定（寫回 contact.learned，讓這個虛構的人下次保持一致）。
 */
export async function runNpcConversation(
    params: RunNpcConversationParams,
): Promise<{ detail: string; learnedNew: string }> {
    // 以前漏進腳本的思考過程先洗掉，不再帶進續寫（見 cleanTranscriptLeaks）
    const p = params.existingDetail ? { ...params, existingDetail: cleanTranscriptLeaks(params.existingDetail) } : params;
    const rounds = Math.max(1, Math.min(8, p.rounds ?? 4));
    const hostLastTs = await lastUserInteractionTs(p.host.id);
    const ctxHost = ContextBuilder.buildCoreContext(p.host, p.user, true, undefined, undefined, { lastInteractionTs: hostLastTs });

    // 續寫時算出「下一句該誰說」，並提示模型從對的那一方接（避免一直自說自話繁殖 host 的話）
    const exTurns = parseTranscript(p.existingDetail || '');
    const lastIsMe = exTurns.length ? exTurns[exTurns.length - 1].isMe : false;
    const nextIsMe = exTurns.length ? !lastIsMe : true; // 全新開場：你(host)先開口
    const turnHint = exTurns.length
        ? (lastIsMe
            ? `\n上一句是你（${p.host.name}）說的，**接下來輪到「${p.npcName}」先回**，第一行必須用「對方:」開頭。`
            : `\n上一句是「${p.npcName}」說的，**接下來輪到你（${p.host.name}）**，第一行必須用「我:」開頭。`)
        : '';

    const prompt = `${ctxHost}

### [人際關係 · 與虛構聯繫人的聊天]
你是「${p.host.name}」。你正在用手機和「${p.npcName}」私聊。
⚠️ **「${p.npcName}」是另一個獨立的人，絕不是用戶「${p.user.name}」。** 全程都在跟「${p.npcName}」說話；不要把 TA 當成用戶、不要中途改用對用戶的口吻/稱呼/記憶，也別突然切換說話對象。${
        p.identity ? `對方身份：${p.identity}。` : ''
    }${
        p.note ? `

【機主對「${p.npcName}」的備註 —— 這是已確立的事實/關係背景，必須當作真實情況嚴格遵守，不得無視或與之矛盾】：
${p.note}` : ''
    }${
        p.learned ? `

【你對「${p.npcName}」已有的瞭解（之前相處積累的印象，保持前後一致）】：
${p.learned}` : ''
    }
「${p.npcName}」是按你的人設合理虛構出來的人（不是真實存在的角色），由你腦補出 TA 的性格與說話方式。

要求：
- 你（${p.host.name}）是一個**完整、獨立的人格**。你發起或推進這段對話一定**事出有因**——動機可以是好奇/打聽身份/有事相求/水聊/試探/報備/不滿等任意貼合情境的一種或幾種，帶著它去說、前後一致；既然是你開口，就貫徹目的，別莫名其妙地自我矛盾、卑微討好或反過來陰陽怪氣。
- 始終保持「${p.host.name}」的人設；對方的性格也要前後一致。
- 依據上方備註/身份設定的關係自然地聊；**不要憑空製造敵意、陰陽怪氣或狗血衝突**，除非備註/身份/人設確實如此。
- 緊扣已有對話往下接，別跳戲、別認錯人。

${p.existingDetail ? `已經聊了：\n"""\n${p.existingDetail}\n"""\n請接著往下聊。${turnHint}` : '現在開始這段對話。'}

任務：生成你（${p.host.name}）和「${p.npcName}」接下來 ${rounds} 個來回的對話，信息量要夠。
格式（**嚴格遵守**）：
- 每一行都必須以「我:」或「對方:」開頭；"我:" 代表你（${p.host.name}），"對方:" 代表「${p.npcName}」。
- 你和「${p.npcName}」**輪流說話、一來一回**；別一個人連說好幾輪、別寫成獨白。
只輸出對話行，不要解釋、不要旁白、不要重複已有內容。
如果這次讓你對「${p.npcName}」有了新的設定/認識（身份、性格、在意的事…），在最末尾另起一行用 [[瞭解:一句話]] 記下來，方便下次保持一致；沒有就別寫。`;

    let out = '';
    try {
        out = await chatCompletion(p.api, prompt, 0.9);
    } catch {
        return { detail: p.existingDetail || '', learnedNew: '' };
    }
    out = out.replace(/```/g, '').trim();
    // 抽出 [[瞭解:…]] 並從正文裡剝掉，避免混進對話氣泡
    let learnedNew = '';
    out = out.replace(/\[\[\s*[了瞭]解\s*[:：]\s*([\s\S]*?)\]\]/g, (_m, s) => {
        learnedNew = appendLearned(learnedNew, String(s).trim());
        return '';
    }).trim();
    // 關鍵：新內容**單獨解析**，無前綴的首行歸給「該說話的下一方」(nextIsMe)，
    // 不再繼承上一句的說話人——否則上一句是 host 時，整段續寫會全被算成 host（“繁殖 char 的話”）。
    const newTurns = parseTranscript(out, nextIsMe);
    const detail = serializeTurns([...exTurns, ...newTurns]);
    return { detail, learnedNew };
}
