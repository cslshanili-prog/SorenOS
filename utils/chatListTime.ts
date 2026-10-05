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

const SHORT_WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 兩個時間戳在用戶設備時區是不是同一天（聊天視窗日期分隔、氣泡分組用）。 */
export function isSameLocalDay(a: number, b: number): boolean {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * 聊天視窗裡一天一次的日期分隔（像 LINE）：今天、昨天，其他「9/28（週一）」，跨年加年份。
 * 跟氣泡上的鐘點一樣照用戶設備時區，不照角色時區（見 docs/character-timezone.md）。
 */
export function formatChatDateDivider(timestamp: number, now: number = Date.now()): string {
    const msg = new Date(timestamp);
    const cur = new Date(now);
    const msgDay = new Date(msg.getFullYear(), msg.getMonth(), msg.getDate()).getTime();
    const curDay = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate()).getTime();
    const deltaDays = Math.round((curDay - msgDay) / (24 * 60 * 60 * 1000));
    if (deltaDays === 0) return '今天';
    if (deltaDays === 1) return '昨天';
    const md = `${msg.getMonth() + 1}/${msg.getDate()}（${SHORT_WEEKDAYS[msg.getDay()]}）`;
    return msg.getFullYear() === cur.getFullYear() ? md : `${msg.getFullYear()}/${md}`;
}
