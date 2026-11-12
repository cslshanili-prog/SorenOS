/**
 * 角色私聊「讓他們聊一輪」／「以某某身份說一句」（關係線第 6 批 6c）：讀寫角色私聊線的那一半。
 * 引擎照用查手機的雙 LLM（runRealConversation）：A 用 A 自己的檔案說，B 用 B 自己的回。
 * 訊息逐則寫進線（utils/pairLine.ts），查手機的紀錄、好感、瞭解、話題盒照舊記在兩邊的聯繫人上。
 */
import type { CharacterProfile, ConvTopic, PhoneContact, UserProfile } from '../types';
import { DB } from './db';
import {
    applyRealConversationToPhoneState, flipTranscript, normName, parseTranscript, runRealConversation,
    serializeTurns, summarizeConversation, topicText, type MiniApiConfig, type RealConversationResult,
} from './relationshipChat';
import { newPairMessages, pairLineId, pairSpeakerOf, pairTranscript } from './pairLine';

type Updater = (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;

export const contactOf = (owner: Pick<CharacterProfile, 'phoneState'>, partner: Pick<CharacterProfile, 'id' | 'name'>): PhoneContact | undefined =>
    owner.phoneState?.contacts?.find(c => c.linkedCharId === partner.id || normName(c.name) === normName(partner.name));

export async function loadPairMessages(aId: string, bId: string) {
    return (await DB.getMessagesByCharId(pairLineId(aId, bId), true)).sort((x, y) => x.timestamp - y.timestamp || x.id - y.id);
}

/** 這一輪誰先開口：最後說話的是誰，就換另一個；還沒聊過就照傳進來的順序。 */
export function nextOpener(msgs: Array<{ metadata?: any; charId: string }>, aId: string, bId: string): [string, string] {
    const last = msgs.length ? pairSpeakerOf(msgs[msgs.length - 1] as any) : undefined;
    return last === aId ? [bId, aId] : [aId, bId];
}

export interface PairRoundResult {
    result: RealConversationResult;
    /** A 視角的完整腳本（含這一輪） */
    aFull: string;
    bFull: string;
    added: number;
    /** 冒充 B 那種：A 有沒有回 */
    aReplied: boolean;
}

/**
 * 跑一輪：A 說、B 回（給了 asB 就是你冒充 B 說的，只讓 A 回）。新說的話逐則存進線。
 * 不動手機狀態，呼叫端照自己的場合處理（查手機會落卡片到私聊，角色私聊頁不會）。
 */
export async function runPairRound(args: {
    a: CharacterProfile;
    b: CharacterProfile;
    userA: UserProfile;
    userB: UserProfile;
    samePersona: boolean;
    api: MiniApiConfig;
    asB?: string;
    now?: number;
}): Promise<PairRoundResult> {
    const { a, b } = args;
    const pairId = pairLineId(a.id, b.id);
    const msgs = await loadPairMessages(a.id, b.id);
    const aToB = contactOf(a, b);
    const bToA = contactOf(b, a);
    const aAll = parseTranscript(pairTranscript(msgs, a.id));
    const archived = Math.min(aToB?.archivedThru ?? 0, aAll.length);
    const recent = aAll.slice(archived);
    const result = await runRealConversation({
        a, b, user: args.userA, userB: args.userB, samePersona: args.samePersona, api: args.api,
        affinityA: aToB?.affinity ?? 0, affinityB: bToA?.affinity ?? 0,
        existingDetail: serializeTurns(recent),
        aNote: bToA?.note, bNote: aToB?.note,
        bLearned: aToB?.learned, aLearned: bToA?.learned,
        aSummary: topicText(aToB?.topicBox), bSummary: topicText(bToA?.topicBox),
        aReplyTo: args.asB,
    });
    const now = args.now ?? Date.now();
    const fresh = newPairMessages({ pairId, aId: a.id, bId: b.id, aDetail: result.aDetail, existingLines: recent.length, now });
    let seenA = false;
    for (const m of fresh) {
        const speaker = m.metadata?.pairSpeakerId;
        if (speaker === a.id) seenA = true;
        // 你冒充 B 說的那幾行：標起來（頁面上看得出來；B 也會記得「自己說過」）
        if (args.asB && !seenA && speaker === b.id) m.metadata = { ...m.metadata, impersonated: true };
        await DB.saveMessage(m as any);
    }
    const aFull = serializeTurns([...aAll.slice(0, archived), ...parseTranscript(result.aDetail)]);
    return {
        result, aFull, bFull: flipTranscript(aFull), added: fresh.length,
        aReplied: parseTranscript(result.aDetail).slice(-1)[0]?.isMe === true,
    };
}

/** 角色私聊頁用：好感、瞭解、紀錄寫回兩邊手機（不落卡片到你的私聊、不播報加刪友）。 */
export function commitPairToPhones(args: {
    a: CharacterProfile; b: CharacterProfile; round: PairRoundResult; updateCharacter: Updater; now?: number;
}): void {
    const { a, b, round, updateCharacter } = args;
    const now = args.now ?? Date.now();
    const side = (owner: CharacterProfile, partner: CharacterProfile, detail: string, delta: number, learnedNew: string) => {
        updateCharacter(owner.id, cur => ({
            phoneState: applyRealConversationToPhoneState(cur.phoneState, {
                partnerName: partner.name, partnerCharId: partner.id, detail, delta, learnedNew,
                partnerNote: contactOf(cur, partner)?.note,
                timestamp: now, recordId: `rec-${now}-${Math.random()}`,
            }).phoneState,
        }));
    };
    side(a, b, round.aFull, round.result.aDelta, round.result.aLearnedNew);
    side(b, a, round.bFull, round.result.bDelta, round.result.bLearnedNew);
}

export const PAIR_ARCHIVE_EVERY = 100;

/**
 * 聊滿 100 條：A、B 各自第一人稱濃縮成一條話題盒記憶，推進兩邊聯繫人的水位線（原文照留在線上）。
 * 回傳歸檔到第幾條；沒滿 100 回 0。
 */
export async function archivePairIfNeeded(args: {
    a: CharacterProfile; b: CharacterProfile; aFull: string; api: MiniApiConfig; updateCharacter: Updater;
}): Promise<number> {
    const { a, b, aFull, api, updateCharacter } = args;
    const lines = parseTranscript(aFull);
    const startMark = contactOf(a, b)?.archivedThru ?? 0;
    let mark = startMark;
    const aTopics: ConvTopic[] = [];
    const bTopics: ConvTopic[] = [];
    while (lines.length - mark >= PAIR_ARCHIVE_EVERY) {
        const aChunk = serializeTurns(lines.slice(mark, mark + PAIR_ARCHIVE_EVERY));
        const [aSum, bSum] = await Promise.all([
            summarizeConversation({ api, speakerName: a.name, otherName: b.name, transcript: aChunk }),
            summarizeConversation({ api, speakerName: b.name, otherName: a.name, transcript: flipTranscript(aChunk) }),
        ]);
        const ts = Date.now();
        const mk = () => `tp-${ts}-${Math.random().toString(36).slice(2, 7)}`;
        if (aSum) aTopics.push({ id: mk(), text: aSum, createdAt: ts, span: PAIR_ARCHIVE_EVERY });
        if (bSum) bTopics.push({ id: mk(), text: bSum, createdAt: ts, span: PAIR_ARCHIVE_EVERY });
        mark += PAIR_ARCHIVE_EVERY;
    }
    if (mark === startMark) return 0;
    const push = (owner: CharacterProfile, partner: CharacterProfile, topics: ConvTopic[]) => updateCharacter(owner.id, cur => ({
        phoneState: {
            ...cur.phoneState, records: cur.phoneState?.records || [],
            contacts: (cur.phoneState?.contacts || []).map(c => (c.linkedCharId === partner.id || normName(c.name) === normName(partner.name))
                ? { ...c, topicBox: [...(c.topicBox || []), ...topics], archivedThru: mark } : c),
        },
    }));
    push(a, b, aTopics);
    push(b, a, bTopics);
    return mark;
}
