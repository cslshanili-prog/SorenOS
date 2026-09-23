// 角色自定義時區（異國戀 / 角色身處異國等場景）。
// 與「時間感知強化」完全獨立：時間感知管「距離上次聊天多久」的提示詞，
// 這裡管「角色活在哪個時區」——開啟後，注入給該角色的「當前時間 / 消息時間戳 /
// 夜間判斷」都按這個時區折算，讓 ta 真的活在自己的本地時間裡。兩者可任意組合。

import { CharacterProfile } from '../types';

/** 常用時區清單（友好中文標籤）。用 IANA id，自動處理夏令時。 */
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
    { id: 'Asia/Shanghai', label: '北京 / 上海 (UTC+8)' },
    { id: 'Asia/Tokyo', label: '東京 / 首爾 (UTC+9)' },
    { id: 'Asia/Bangkok', label: '曼谷 / 河內 (UTC+7)' },
    { id: 'Asia/Kolkata', label: '印度 (UTC+5:30)' },
    { id: 'Asia/Dubai', label: '迪拜 (UTC+4)' },
    { id: 'Europe/Moscow', label: '莫斯科 (UTC+3)' },
    { id: 'Europe/Paris', label: '巴黎 / 柏林 / 羅馬 (UTC+1/+2)' },
    { id: 'Europe/London', label: '倫敦 (UTC+0/+1)' },
    { id: 'America/Sao_Paulo', label: '聖保羅 (UTC-3)' },
    { id: 'America/New_York', label: '紐約 / 多倫多 (UTC-5/-4)' },
    { id: 'America/Chicago', label: '芝加哥 (UTC-6/-5)' },
    { id: 'America/Denver', label: '丹佛 (UTC-7/-6)' },
    { id: 'America/Los_Angeles', label: '洛杉磯 / 西雅圖 (UTC-8/-7)' },
    { id: 'Australia/Sydney', label: '悉尼 (UTC+10/+11)' },
    { id: 'Pacific/Auckland', label: '奧克蘭 (UTC+12/+13)' },
];

/** 取角色當前生效的時區 id；未開啟自定義時區時返回 undefined（= 跟隨本機）。 */
export const resolveCharTimeZone = (
    char?: Pick<CharacterProfile, 'customTimezoneEnabled' | 'customTimezone'> | null,
): string | undefined =>
    char?.customTimezoneEnabled && char.customTimezone ? char.customTimezone : undefined;

/** 時區 id → 友好標籤；不在清單裡就原樣返回 id。 */
export const tzLabel = (tz: string): string =>
    COMMON_TIMEZONES.find(t => t.id === tz)?.label || tz;

/**
 * 時區 id → 一個詞的地名，給界面上空間緊張的地方用（如日程卡的時鐘角標）。
 * 「紐約 / 多倫多 (UTC-5/-4)」→「紐約」；不在清單裡就取 IANA id 的末段。
 */
export const tzShortLabel = (tz: string): string => {
    const label = COMMON_TIMEZONES.find(t => t.id === tz)?.label;
    if (label) return label.split('/')[0].replace(/\s*\(.*$/, '').trim();
    return tz.split('/').pop()?.replace(/_/g, ' ') || tz;
};

/**
 * 返回一個「本地 getter（getHours/getMinutes/getDay/getFullYear…）讀出來正好是 `tz`
 * 當地牆上時間」的 Date。tz 為空或非法時，原樣返回 base（本機時間）。
 * 這樣所有現有用 new Date().getHours() 之類讀取的代碼都不用改讀取方式，只換一下這個源。
 */
export const nowInTimeZone = (tz?: string, base: Date = new Date()): Date => {
    if (!tz) return base;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).formatToParts(base);
        const map: Record<string, string> = {};
        for (const p of parts) map[p.type] = p.value;
        let hour = parseInt(map.hour, 10);
        if (hour === 24) hour = 0; // 某些環境 24:00 表示午夜
        return new Date(
            parseInt(map.year, 10), parseInt(map.month, 10) - 1, parseInt(map.day, 10),
            hour, parseInt(map.minute, 10), parseInt(map.second, 10),
        );
    } catch {
        return base;
    }
};

/** 把某個時間戳折算成 `tz` 當地牆上時間對應的時間戳（用於歷史消息時間戳顯示）。 */
export const tsInTimeZone = (ts: number, tz?: string): number =>
    tz ? nowInTimeZone(tz, new Date(ts)).getTime() : ts;

/**
 * `nowInTimeZone` 的逆運算：把一段「角色當地的牆上時間」文本換算回真實時刻。
 *
 * 角色寫 `[schedule_message | 2026-07-26 21:00:00 | ...]` 時，它唯一看得到的鐘是
 * 自己時區的（prompt 裡注入的就是角色當地時間）。直接 `new Date(文本)` 會按**設備**
 * 時區解釋，異國戀角色的定時消息會整體偏一個時差——角色想約今晚，實際可能已經過期。
 *
 * tz 為空時行為與 `new Date(文本)` 完全一致。文本非法時返回 NaN，交給調用方判。
 */
export const wallClockToTimestamp = (wallClockText: string, tz?: string): number => {
    // 'YYYY-MM-DD HH:MM:SS' 裡的空格換成 T，避免個別引擎把它當非法格式
    const asDeviceLocal = new Date(wallClockText.trim().replace(' ', 'T')).getTime();
    if (!tz || Number.isNaN(asDeviceLocal)) return asDeviceLocal;

    // 找真實時刻 t，使 nowInTimeZone(tz, t) 讀出來正好是這串牆上時間。
    // 先按當前猜測算一次時差再修正；跑兩輪是為了讓夏令時切換附近也收斂。
    let t = asDeviceLocal;
    for (let i = 0; i < 2; i++) {
        const drift = nowInTimeZone(tz, new Date(t)).getTime() - asDeviceLocal;
        if (drift === 0) break;
        t -= drift;
    }
    return t;
};

/** 注入聊天 prompt 的時差提示（異國戀核心）。tz 為空時返回空串。 */
export const tzAwarenessNote = (tz?: string): string => {
    if (!tz) return '';
    return `\n⏳ 注意：你身處「${tzLabel(tz)}」時區，上面的「當前時間」是你那邊的本地時間。`
        + `對方（用戶）可能在不同的時區，你們之間存在時差——聊天時把這點考慮進去`
        + `（比如你這邊已是深夜要睡了，對方那邊也許才下午）。\n`;
};

/**
 * 「距離上次互動多久」統一口徑（供 buildCoreContext 注入，查手機/人際關係等無內聯消息流的
 * 路徑共用同一份措辭，替代各 App 各寫一份的 getTimeGapHint）。
 * 純時長，與時區無關（間隔是絕對差值）。lastTs 為空返回空串。
 * 聊天內聯那份（ChatPrompts.getTimeGapHint）刻意保留：它貼在最後一條消息後、帶深夜判斷，位置語義更好。
 */
export const interactionGapNote = (lastTs?: number, nowTs: number = Date.now()): string => {
    if (!lastTs) return '';
    const diffMs = nowTs - lastTs;
    if (diffMs < 0) return '';
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(hours / 24);
    if (mins < 5) return `⌛ 你和對方剛剛還在聯繫。\n`;
    const span = mins < 60 ? `${mins} 分鐘` : hours < 24 ? `${hours} 小時` : `${days} 天`;
    const feel = days >= 1 ? '已經有一陣子沒聯繫了' : '不久前剛聯繫過';
    return `⌛ 距離你和對方上次聯繫，已經過去 ${span}（${feel}）——請把這種體感自然帶入當下的狀態與心情。\n`;
};
