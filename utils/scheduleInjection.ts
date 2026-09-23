/**
 * 日程 → prompt 文本的純渲染層。
 *
 * 零運行時依賴（只 import type），瀏覽器與 Cloudflare Worker 共用同一份：
 *  - 前台聊天走 ContextBuilder.buildScheduleInjection（轉發到這裡）；
 *  - 主動消息到點生成走 utils/amsgFireScene.ts，由 worker 在 fire 時刻按角色時區調用。
 *
 * 放在這裡而不是 utils/context.ts：那個模塊拖著 DB / 記憶宮殿等一堆瀏覽器依賴，
 * worker 引不動。兩邊各寫一份的話，角色在聊天裡和到點生成時會說出不一樣的作息。
 */

import type { DailySchedule, ScheduleSlot } from '../types';

/**
 * 渲染真正會讀到的那部分日程。
 *
 * 單獨立一個類型是給主動消息用的：fire_pack 只帶這些字段上雲。整份 DailySchedule 裡
 * 還掛著每個時段緩存的小劇場（整段演出台詞）和 coverImage（可能是 base64 看板圖），
 * 那些渲染一個字都用不到，帶上去就是白佔幾十上百 KB 的雲端狀態。
 */
export type RenderableSchedule = Pick<DailySchedule, 'slots' | 'flowNarrative'>;

export interface ScheduleInjectionOptions {
    /** ChatApp 主請求需要讓角色看到今天的整張表；主動消息到點場景仍只看當前與下一條。 */
    includeFullDay?: boolean;
    /**
     * 教不教角色改自己的日程。前台聊天和主動消息到點生成都能落地——後者的標籤由
     * worker classifier 摘成 change_schedule directive 隨 push 回來，客戶端落庫
     * （不摘的話會被 sanitize 連 raw 一起剝掉，見 utils/scheduleChangeParse.ts）。
     * 措辭對兩邊都成立：主動消息裡沒有「完整日程表」可指，所以只讓它抄上面出現過的時段。
     */
    includeChangeInstruction?: boolean;
    /**
     * 能不能報鐘點（默認能）。角色關掉「時間感知」時傳 false：日程照給——那是這個
     * 功能自己的開關——但 `07:00` 這種精確鐘點屬於時間感知的範疇，不該從日程塊漏出去。
     * 跟天氣塊的處理對齊（那邊天氣照給、只抽掉 timeLine）。
     * 關掉鐘點時也不教改日程：那條指令拿時段當定位符，角色看不到時刻就寫不出來。
     */
    includeClock?: boolean;
}

/** 意識流獨白按一天三檔取：早 / 午 / 晚。 */
export function getFlowNarrativeKey(hour: number): 'morning' | 'afternoon' | 'evening' {
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}

/** 幾點之前算「還在前一夜裡」。凌晨 0-5 點屬於昨晚的尾巴，不是今天的早晨。 */
const PRE_DAWN_END_HOUR = 5;

/** 當前時刻落在哪一條日程上，以及緊接著的下一條。都可能為 null（表還沒開始 / 表是空的）。 */
export const resolveScheduleSlots = (
    schedule: RenderableSchedule | null,
    now: Date,
): { current: ScheduleSlot | null; next: ScheduleSlot | null } => {
    if (!schedule?.slots?.length) return { current: null, next: null };
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    for (let i = schedule.slots.length - 1; i >= 0; i--) {
        const [h, m] = schedule.slots[i].startTime.split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
        if (currentMinutes >= h * 60 + m) {
            return {
                current: schedule.slots[i],
                next: i < schedule.slots.length - 1 ? schedule.slots[i + 1] : null,
            };
        }
    }
    // 今天第一條還沒到點：沒有「當前」，只有「稍後先做什麼」。
    return { current: null, next: schedule.slots[0] };
};

/**
 * 構建日程注入文本
 *
 * 兩段式，獨立疊加：
 * 1) 當前時段硬事實——每輪都注入，不受 evolvedNarrative 影響
 * 2) 意識流獨白——evolvedNarrative > flowNarrative > 當前 slot innerThought
 */
export const buildScheduleInjection = (
    schedule: RenderableSchedule | null,
    evolvedNarrative?: string,
    now: Date = new Date(),
    options: ScheduleInjectionOptions = {},
): string => {
    if (!schedule || !schedule.slots || schedule.slots.length === 0) return '';
    const { current: currentSlot, next: nextSlot } = resolveScheduleSlots(schedule, now);
    const withClock = options.includeClock !== false;
    /** 報鐘點時寫「活動（07:00）」，不報時只留活動本身。 */
    const withTime = (text: string, startTime: string) => (withClock ? `${text}（${startTime}）` : text);

    // 凌晨還沒輪到今天第一條日程時，人其實還在昨晚裡沒睡。主動消息經常在這個點觸發，
    // 按「今天剛要開始」寫，半夜一點的角色就會頂著清晨的心境說話。
    const isPreDawnCarryOver = !currentSlot && now.getHours() < PRE_DAWN_END_HOUR;

    // 1. 當前時段硬事實（每輪獨立注入）
    let slotHeader = '';
    if (currentSlot) {
        slotHeader = withClock
            ? `當前時段：${currentSlot.startTime} 你正在${currentSlot.activity}`
            : `當前時段：你正在${currentSlot.activity}`;
        if (currentSlot.location) slotHeader += `（${currentSlot.location}）`;
        if (nextSlot) {
            slotHeader += withClock
                ? `\n之後安排：${nextSlot.startTime} ${nextSlot.activity}`
                : `\n之後安排：${nextSlot.activity}`;
        }
        slotHeader += '\n';
    } else if (nextSlot) {
        slotHeader = isPreDawnCarryOver
            ? `夜深了，今天的安排還沒開始，最早的一件是${withTime(nextSlot.activity, nextSlot.startTime)}\n`
            : `今天還沒開始活動，稍後先${withTime(nextSlot.activity, nextSlot.startTime)}\n`;
    }

    // 2. 意識流獨白
    let narrative = '';
    if (evolvedNarrative) {
        narrative = evolvedNarrative;
    } else if (schedule.flowNarrative && Object.keys(schedule.flowNarrative).length > 0) {
        // 前一夜的延續取「晚」檔；其餘照一天三檔走。
        const key = isPreDawnCarryOver ? 'evening' : getFlowNarrativeKey(now.getHours());
        narrative = schedule.flowNarrative[key]
            || schedule.flowNarrative['evening']
            || schedule.flowNarrative['afternoon']
            || schedule.flowNarrative['morning']
            || '';
    } else if (currentSlot?.innerThought) {
        narrative = currentSlot.innerThought;
    }

    // 3. 拼接：硬事實 → 意識流（可選）
    const preamble = `此刻你的心中盤旋著這些想法……\n`;
    const footnote = `\n（不是台詞，不用說出口——讓它影響你的語氣和情緒就好。）`;
    // footnote 只跟著意識流獨白走，管不到上面的日程行——那兩段是「你正在做什麼」的硬事實，
    // 每輪全量注入且貼著生成點。日程是照著聊天記錄生成的（生成側明寫「對話裡提到的事
    // 必須嚴格遵循」，意識系那檔還把「惦記對方」列為推薦動作），對方隨口說的計劃因此
    // 會滲進 slot 的 description；再加上角色能用 CHANGE_SCHEDULE 往裡寫任意文本，
    // 表上就可能出現一件「跟對方有關、每輪都擺在眼前、沒人說過該怎麼對待」的事。
    // 這塊的註釋自己就寫過這條硬事實的推力：表上停在睡覺，角色每輪都被推著去道晚安。
    // 換成「問問書看到哪了」，就是每輪追問進度的由來。
    const scopeNote = '（這張表是你自己的一天，不是給對方列的待辦。裡頭要是有跟對方相關的事，'
        + '那也是你自己的惦記——話趕到了順口帶一句就夠，不用追著問進展，也不用催對方去做。）';

    let out = '';
    if (options.includeFullDay) {
        const rows = schedule.slots.map((slot) => {
            let line = withClock ? `- ${slot.startTime} ${slot.activity}` : `- ${slot.activity}`;
            if (slot.location) line += `（${slot.location}）`;
            if (slot.description) line += `：${slot.description}`;
            return line;
        });
        out += `你今天的完整日程：\n${rows.join('\n')}\n`;
    }
    out += slotHeader;
    if (narrative) {
        out += preamble + narrative + footnote;
    }
    // 能改的是「當前這一條和它之後的」，所以兩者有一個在就有落點。落點優先取下一條；
    // 一天最後一條日程開始之後沒有下一條了，這時用當前這條——那條通常是睡覺，正好是
    // 最需要「我今晚不睡了」這個出口的時候。
    const changeTarget = nextSlot ?? currentSlot;
    if (options.includeChangeInstruction && withClock && changeTarget) {
        out += '\n日程是你早上給自己排的計劃，不是必須履行的命令。真實發生的事跟它對不上時'
            + '（比如這會兒表上寫著睡覺、你卻醒著在跟對方說話），把它改成你實際在做的事就好。\n'
            + '需要時在回覆末尾單獨輸出：'
            + `[[ACTION:CHANGE_SCHEDULE | ${changeTarget.startTime} | 去超市]]`
            + '（時段要原樣抄上面出現過的那幾個；正在進行的這一條和它之後的都能改，已經過去的不能）。';
    }
    // 放塊尾：上面幾段是條件拼的，掛在其中一段裡的話，另一種形態就是裸的。
    out += `\n${scopeNote}`;
    out += '\n';
    return out;
};
