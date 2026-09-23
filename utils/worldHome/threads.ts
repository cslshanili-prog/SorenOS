/**
 * 世界內消息線程（私聊 + 世界群聊）的維護邏輯。
 *
 * 這是"手機是真手機"的核心：消息持久在 world.threads 裡、跨角色跨輪傳遞——
 * A 先演繹時發出的私聊/群聊**立刻**落線程，同一輪裡後演繹的 B 構建上下文時
 * 就能收到並回應；下一輪 A 又能看到 B 的回覆。NPC 也能在群裡冒泡。
 */
import type { WorldProfile, WorldThread, WorldChatMessage, WorldCharBeat } from '../../types';

export const GROUP_THREAD_ID = 'group_main';
/** 每條線程截留的消息數（手機 UI 可完整翻閱；prompt 只取尾部一小段） */
export const THREAD_CAP = 120;

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export function dmThreadId(a: string, b: string): string {
    const [x, y] = [a, b].sort();
    return `dm_${x}_${y}`;
}

/** 確保 threads 數組存在且包含世界群聊（成員名單跟隨最新配置）。原地修改並返回。 */
export function ensureThreads(world: WorldProfile): WorldThread[] {
    if (!world.threads) world.threads = [];
    let group = world.threads.find(t => t.id === GROUP_THREAD_ID);
    if (!group) {
        group = { id: GROUP_THREAD_ID, kind: 'group', name: `${world.name}·大家的群`, memberIds: [...world.memberIds], messages: [] };
        world.threads.push(group);
    } else {
        group.memberIds = [...world.memberIds];
        group.name = group.name || `${world.name}·大家的群`;
    }
    return world.threads;
}

function pushMsg(thread: WorldThread, msg: WorldChatMessage) {
    thread.messages.push(msg);
    if (thread.messages.length > THREAD_CAP) thread.messages = thread.messages.slice(-THREAD_CAP);
}

/** 去重歸一化：去掉所有空白再比，避免「同一句只差換行/空格」漏判。 */
const normLine = (s: string): string => s.replace(/\s+/g, '').trim();

/**
 * 同一發送者在近 window 條裡是否已發過一模一樣的內容。
 * 用來擋住模型偶爾把上一輪的私聊/群聊原樣再冒一遍——同一句在不同時間反覆刷屏。
 * 空白內容也判為「重複」直接丟棄。
 */
export function isDuplicateLine(thread: WorldThread, fromId: string, text: string, window = 60): boolean {
    const n = normLine(text);
    if (!n) return true;
    const start = Math.max(0, thread.messages.length - window);
    for (let i = thread.messages.length - 1; i >= start; i--) {
        const m = thread.messages[i];
        if (m.fromId === fromId && normLine(m.text) === n) return true;
    }
    return false;
}

/**
 * 把一個角色 beat 裡的手機消息落進線程（dm → 私聊線程；group → 世界群聊）。
 * 在每個角色演繹完後立刻調用——鏈式後續角色才能在同一輪裡收到。
 */
export function applyBeatToThreads(
    world: WorldProfile,
    beat: WorldCharBeat,
    members: { id: string; name: string }[],
    round: number,
    storyTime: string,
): void {
    const threads = ensureThreads(world);
    // dm 對象可以是成員，也可以是 NPC（角色給鎮上的人發私信）
    const idOf = (name: string) => members.find(m => m.name === name)?.id || world.npcs.find(n => n.name === name)?.id;
    const now = Date.now();

    for (const dm of beat.phone?.dms || []) {
        const otherId = idOf(dm.to);
        if (!otherId || otherId === beat.charId) continue;
        const tid = dmThreadId(beat.charId, otherId);
        let thread = threads.find(t => t.id === tid);
        if (!thread) {
            thread = { id: tid, kind: 'dm', memberIds: [beat.charId, otherId], messages: [] };
            threads.push(thread);
        }
        for (const line of dm.lines) {
            if (isDuplicateLine(thread, beat.charId, line)) continue;
            pushMsg(thread, { id: genId('wm'), fromId: beat.charId, fromName: beat.charName, text: line, round, storyTime, timestamp: now });
        }
    }

    const groupLines = beat.phone?.group || [];
    if (groupLines.length > 0) {
        const group = threads.find(t => t.id === GROUP_THREAD_ID)!;
        for (const line of groupLines) {
            if (isDuplicateLine(group, beat.charId, line)) continue;
            pushMsg(group, { id: genId('wm'), fromId: beat.charId, fromName: beat.charName, text: line, round, storyTime, timestamp: now });
        }
    }
}

/** NPC 在世界群聊裡冒泡（世界引擎一次調用產出，無記憶，純煙火氣）。 */
export function applyNpcGroupLines(
    world: WorldProfile,
    lines: { name: string; line: string }[],
    round: number,
    storyTime: string,
): void {
    if (lines.length === 0) return;
    const threads = ensureThreads(world);
    const group = threads.find(t => t.id === GROUP_THREAD_ID)!;
    const now = Date.now();
    for (const l of lines) {
        const npc = world.npcs.find(n => n.name === l.name);
        if (!npc) continue; // 只收真實存在的 NPC 的發言
        if (isDuplicateLine(group, npc.id, l.line)) continue;
        pushMsg(group, { id: genId('wm'), fromId: npc.id, fromName: npc.name, text: l.line, round, storyTime, timestamp: now });
    }
}

/** NPC 回覆成員的私信（世界引擎一次調用統一產出）。from=NPC 名，to=成員名。 */
export function applyNpcDms(
    world: WorldProfile,
    dms: { from: string; to: string; lines: string[] }[],
    members: { id: string; name: string }[],
    round: number,
    storyTime: string,
): void {
    if (!dms || dms.length === 0) return;
    const threads = ensureThreads(world);
    const now = Date.now();
    for (const dm of dms) {
        const npc = world.npcs.find(n => n.name === dm.from);
        const member = members.find(m => m.name === dm.to);
        if (!npc || !member || !Array.isArray(dm.lines)) continue;
        const tid = dmThreadId(npc.id, member.id);
        let thread = threads.find(t => t.id === tid);
        if (!thread) {
            thread = { id: tid, kind: 'dm', memberIds: [npc.id, member.id], messages: [] };
            threads.push(thread);
        }
        for (const line of dm.lines) {
            if (!line) continue;
            if (isDuplicateLine(thread, npc.id, line)) continue;
            pushMsg(thread, { id: genId('wm'), fromId: npc.id, fromName: npc.name, text: line, round, storyTime, timestamp: now });
        }
    }
}

/**
 * NPC 的私信收件箱：成員發給各 NPC、但 NPC 還沒回（最後一條不是該 NPC 發的）的私聊線程。
 * 供世界引擎參考，讓 NPC 這一輪回復。
 */
export function npcInboxes(world: WorldProfile): { npcName: string; memberName: string; recent: string }[] {
    const out: { npcName: string; memberName: string; recent: string }[] = [];
    const npcIds = new Map(world.npcs.map(n => [n.id, n.name]));
    for (const t of world.threads || []) {
        if (t.kind !== 'dm' || t.messages.length === 0) continue;
        const npcId = t.memberIds.find(id => npcIds.has(id));
        const memberId = t.memberIds.find(id => !npcIds.has(id));
        if (!npcId || !memberId) continue;
        const last = t.messages[t.messages.length - 1];
        if (last.fromId === npcId) continue; // NPC 已回過，跳過
        const recent = t.messages.slice(-6).map(m => `${m.fromName}：${m.text}`).join('\n');
        out.push({ npcName: npcIds.get(npcId)!, memberName: t.messages.find(m => m.fromId === memberId)?.fromName || '', recent });
    }
    return out;
}

/** 取與某成員相關的 dm 線程（手機 UI / prompt 共用）。 */
export function dmThreadsOf(world: WorldProfile, charId: string): WorldThread[] {
    return (world.threads || []).filter(t => t.kind === 'dm' && t.memberIds.includes(charId) && t.messages.length > 0);
}

export function groupThreadOf(world: WorldProfile): WorldThread | null {
    return (world.threads || []).find(t => t.id === GROUP_THREAD_ID) || null;
}

/**
 * 把線程格式化進 prompt（尾部 limit 條）。
 * currentRound 的消息標【剛剛】——通常是同一輪裡先演繹的人剛發來的，提醒模型這是新消息。
 */
export function formatThreadForPrompt(thread: WorldThread, selfId: string, limit: number, currentRound: number): string {
    const msgs = thread.messages.slice(-limit);
    if (msgs.length === 0) return '（還沒有消息）';
    return msgs.map(m => {
        const who = m.fromId === selfId ? '你' : m.fromName;
        const tag = m.round === currentRound ? '【剛剛】' : `[${m.storyTime}]`;
        return `${tag} ${who}：${m.text}`;
    }).join('\n');
}
