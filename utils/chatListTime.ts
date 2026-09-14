const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/**
 * Chat 主页「消息」列表用的短时间戳：今天显示钟点，昨天显示"昨天"，一周内显示星期几，
 * 同年显示"月/日"，跨年显示"年/月/日"。跟 utils/groupChat/relativeTime.ts 的
 * formatRelativeAge（喂给 LLM 的"约 N 小时前"长描述）是两回事，这个是给人看的列表时间戳。
 */
export function formatChatListTimestamp(timestamp: number, now: number = Date.now()): string {
    const msg = new Date(timestamp);
    const cur = new Date(now);
    const msgDay = new Date(msg.getFullYear(), msg.getMonth(), msg.getDate()).getTime();
    const curDay = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()).getTime();
    const deltaDays = Math.round((curDay - msgDay) / (24 * 60 * 60 * 1000));

    if (deltaDays <= 0) {
        return `${String(msg.getHours()).padStart(2, '0')}:${String(msg.getMinutes()).padStart(2, '0')}`;
    }
    if (deltaDays === 1) return '昨天';
    if (deltaDays < 7) return WEEKDAY_NAMES[msg.getDay()];
    if (msg.getFullYear() === cur.getFullYear()) return `${msg.getMonth() + 1}/${msg.getDate()}`;
    return `${msg.getFullYear()}/${msg.getMonth() + 1}/${msg.getDate()}`;
}
