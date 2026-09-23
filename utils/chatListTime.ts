const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/**
 * Chat 主頁「消息」列表用的短時間戳：今天顯示鐘點，昨天顯示"昨天"，一週內顯示星期幾，
 * 同年顯示"月/日"，跨年顯示"年/月/日"。跟 utils/groupChat/relativeTime.ts 的
 * formatRelativeAge（餵給 LLM 的"約 N 小時前"長描述）是兩回事，這個是給人看的列表時間戳。
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
