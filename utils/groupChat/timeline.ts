import { Message } from '../../types';
import { messageLogText } from './format';
import { formatRelativeAge } from './relativeTime';

export const DEFAULT_MEMBER_TIMELINE_CAP = 40;

/** 時間線單行正文的截斷長度——比舊版"50 字"寬鬆，保住情緒細節又不至於撐爆 prompt */
const LINE_MAX_CHARS = 80;

const truncate = (text: string, max: number): string =>
    text.length > max ? `${text.slice(0, max)}…` : text;

const formatTime = (ts: number): string => {
    const d = new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
};

export interface MemberTimelineOptions {
    /** 該成員的私聊消息（建議 DB.getRecentMessagesByCharId(id, cap, true) 取最近 cap 條） */
    privateMsgs: Message[];
    /** 群聊消息（當前群，內存裡已有的即可） */
    groupMsgs: Message[];
    /** 合併排序後取末 N 條 */
    cap: number;
    /** 群消息說話人解析：charId → 顯示名（user 角色不經過它） */
    resolveSpeaker: (m: Message) => string;
    /** 表情包 URL → 名稱（佔位符用） */
    stickerName?: (url: string) => string;
}

/**
 * 構建某成員的"私聊 + 群聊合併時間線"——按時間戳升序、帶來源標籤。
 * 這是群聊裡角色感情與私聊銜接的關鍵：舊版只帶"最後 10 條私聊 × 截斷 50 字"
 * 且與群歷史隔離，角色看不到兩條線的先後關係。
 *
 * 輸出形如：
 *   [私聊][07-10 22:14] 用戶: 今天好累……
 *   [私聊][07-10 22:15] 我: 那早點睡，別刷手機了
 *   [群聊][07-11 09:02] 小夏: 早啊！
 */
export function buildMemberTimeline(opts: MemberTimelineOptions): string {
    const { privateMsgs, groupMsgs, cap, resolveSpeaker, stickerName } = opts;

    const tagged = [
        ...privateMsgs.slice(-cap).map(m => ({ m, isGroup: false })),
        ...groupMsgs.slice(-cap).map(m => ({ m, isGroup: true })),
    ];
    tagged.sort((a, b) => a.m.timestamp - b.m.timestamp);

    return tagged
        .slice(-cap)
        .map(({ m, isGroup }) => {
            const tag = isGroup ? '[群聊]' : '[私聊]';
            // 私聊行的"我"= 該成員本人；群聊行用真名，成員才能分清誰說的
            const speaker = m.role === 'user' ? '用戶' : (isGroup ? resolveSpeaker(m) : '我');
            const text = truncate(messageLogText(m, stickerName), LINE_MAX_CHARS);
            return `${tag}[${formatTime(m.timestamp)} · ${formatRelativeAge(m.timestamp)}] ${speaker}: ${text}`;
        })
        .join('\n');
}
