/**
 * 角色記得自己跟別人私聊過什麼（關係線第 6 批 6d，上層 7.1「記憶只有一份」）：
 * 跟你私聊時，提示詞多一段「你私下跟別人聊的（用戶不在場）」，每條角色私聊線最近幾則、按時間排、標是跟誰。
 * 說不說、怎麼說由角色決定——八卦、傳話、說溜嘴都從這裡長出來。跟「近期群聊」同一個做法。
 */
import type { Message } from '../types';
import { DB } from './db';
import { getCharNameById } from './charNameRegistry';
import { pairOtherId, pairSpeakerOf, parsePairLineId } from './pairLine';

/** 每條線取最近幾則 */
export const PAIR_CONTEXT_PER_LINE = 12;
/** 全部加起來最多幾則 */
export const PAIR_CONTEXT_TOTAL = 40;
const LINE_MAX = 120;

export interface PairContextSource {
    otherName: string;
    msgs: Array<Pick<Message, 'timestamp' | 'content' | 'metadata' | 'charId'>>;
}

/** 純拼字串：沒有任何一則就回空字串。 */
export function formatPairContext(args: {
    selfId: string;
    selfName: string;
    sources: PairContextSource[];
    formatDate: (ts: number) => string;
    relativeAge?: (ts: number) => string;
}): string {
    const rows = args.sources.flatMap(src => src.msgs.slice(-PAIR_CONTEXT_PER_LINE).map(m => ({ m, otherName: src.otherName })))
        .filter(r => typeof r.m.content === 'string' && r.m.content.trim())
        .sort((a, b) => a.m.timestamp - b.m.timestamp)
        .slice(-PAIR_CONTEXT_TOTAL);
    if (!rows.length) return '';
    const lines = rows.map(({ m, otherName }) => {
        const who = pairSpeakerOf(m) === args.selfId ? `你（${args.selfName}）` : otherName;
        const age = args.relativeAge ? ` · ${args.relativeAge(m.timestamp)}` : '';
        const text = String(m.content).trim().replace(/\n+/g, ' ');
        return `[${args.formatDate(m.timestamp)}${age}] [跟${otherName}私聊] ${who}: ${text.length > LINE_MAX ? `${text.slice(0, LINE_MAX)}…` : text}`;
    });
    return `\n### 【你私下跟別人聊的 · 用戶不在場】
（以下是你最近跟其他人私下的聊天，用戶不在場、也看不到——對你來說這些是只有你們兩個知道的事。你自己都記得；要不要跟用戶提、提多少、怎麼提，照你的性格和你們的關係決定：可以保密、可以八卦、也可能不小心說溜嘴。不要每次都主動彙報。）
${lines.join('\n')}\n`;
}

/** 讀這個角色所有角色私聊線的最近幾則（另一頭的角色已經不在的跳過）。 */
export async function loadPairContextSources(charId: string): Promise<PairContextSource[]> {
    const ids = (await DB.getPairLineIds()).filter(id => parsePairLineId(id)?.includes(charId));
    const out: PairContextSource[] = [];
    for (const pairId of ids) {
        const otherId = pairOtherId(pairId, charId);
        const otherName = otherId ? getCharNameById(otherId) : null;
        if (!otherName) continue;
        const msgs = await DB.getRecentMessagesByCharId(pairId, PAIR_CONTEXT_PER_LINE, true);
        if (msgs.length) out.push({ otherName, msgs });
    }
    return out;
}
