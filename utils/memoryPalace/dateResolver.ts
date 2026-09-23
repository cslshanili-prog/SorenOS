/**
 * Memory Palace — 日期引用解析
 *
 * 聊天裡出現"去年12月""3月4號""上週""昨天"這類日期引用時，
 * 向量相似度/BM25 都不可靠（記憶內容裡是"12月15日"，query 裡是"十二月"
 * 或"去年12月"，兩者 embedding 向量不對齊；BM25 分詞也對不上）。
 *
 * 本模塊把 query 文本里的日期引用解析成絕對 [start, end) 時間戳區間，
 * 供 pipeline 另起一路按 createdAt 查記憶，融入召回池。
 *
 * 設計原則：
 * - 寬鬆優先：哪怕只命中"去年"或"3月"這種粗範圍也給出結果，寧可多不要錯過
 * - 歧義時選最近：孤立的"3月"→ 最近一次出現過的 3 月（跨年時往前找）
 * - 只處理常見中文/數字表達，不套 NLU 模型
 */

import { includesAnyScript } from '../scriptKey';

export interface DateRange {
    /** 區間起點（毫秒時間戳，含） */
    start: number;
    /** 區間終點（毫秒時間戳，不含） */
    end: number;
    /** 人類可讀標籤，用於日誌 */
    label: string;
    /** exact = 日級精確；fuzzy = 月/周/年級粗粒度 */
    confidence: 'exact' | 'fuzzy';
}

// 中文數字（只處理 1-31，夠用於月份和日期）
const CN_DIGIT: Record<string, number> = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};
function cnNumToInt(s: string): number | null {
    // "十二" → 12, "二十" → 20, "二十三" → 23, "十" → 10, "九" → 9
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    if (CN_DIGIT[s] !== undefined) return CN_DIGIT[s];
    // 十X
    const m1 = /^十([一二三四五六七八九])$/.exec(s);
    if (m1) return 10 + CN_DIGIT[m1[1]];
    // X十 / X十Y
    const m2 = /^([一二三四五六七八九])十([一二三四五六七八九])?$/.exec(s);
    if (m2) return CN_DIGIT[m2[1]] * 10 + (m2[2] ? CN_DIGIT[m2[2]] : 0);
    return null;
}

function startOfDay(y: number, m0: number, d: number): number {
    return new Date(y, m0, d, 0, 0, 0, 0).getTime();
}

function daysInMonth(y: number, m0: number): number {
    return new Date(y, m0 + 1, 0).getDate();
}

/** 把日級定位成 [當天 00:00, 次日 00:00) */
function dayRange(y: number, m0: number, d: number, label: string): DateRange {
    const start = startOfDay(y, m0, d);
    return { start, end: startOfDay(y, m0, d + 1), label, confidence: 'exact' };
}

/** 把月級定位成 [1 號 00:00, 次月 1 號 00:00) */
function monthRange(y: number, m0: number, label: string): DateRange {
    const start = startOfDay(y, m0, 1);
    const end = startOfDay(y, m0 + 1, 1);
    return { start, end, label, confidence: 'fuzzy' };
}

/** 把年級定位成 [1 月 1 日 00:00, 次年 1 月 1 日 00:00) */
function yearRange(y: number, label: string): DateRange {
    const start = startOfDay(y, 0, 1);
    const end = startOfDay(y + 1, 0, 1);
    return { start, end, label, confidence: 'fuzzy' };
}

/**
 * 給定月份（1-12），結合當前日期，選定"最近一次出現該月份"的年份。
 * 例：now=2026-04，query="12月" → 2025-12（過去的 12 月）
 *     now=2026-04，query="3月"  → 2026-03（當年剛過）
 *     now=2026-04，query="5月"  → 2025-05（今年還沒到，指向去年）
 */
function resolveNearestPastMonth(targetMonth1: number, now: Date): number {
    const y = now.getFullYear();
    const m1 = now.getMonth() + 1;
    return targetMonth1 <= m1 ? y : y - 1;
}

// ─── 主解析 ────────────────────────────────────────────

export function resolveDateReferences(query: string, now: Date = new Date()): DateRange[] {
    const ranges: DateRange[] = [];
    const seenLabels = new Set<string>();
    const push = (r: DateRange | null) => {
        if (!r) return;
        if (seenLabels.has(r.label)) return;
        seenLabels.add(r.label);
        ranges.push(r);
    };

    const curY = now.getFullYear();
    const curM0 = now.getMonth();
    const curD = now.getDate();

    // 相對年（前年/去年/今年/明年）可單獨出現，也可"去年12月"這種組合
    //   先捕獲組合，再處理單獨

    // 1) 相對年 + 月 + 日：去年12月15日 / 去年12月15號
    for (const m of query.matchAll(/(前年|去年|今年|明年)\s*(\d{1,2}|[一二三四五六七八九十]+)\s*月\s*(\d{1,2}|[一二三四五六七八九十]+)\s*[日号號]/gu)) {
        const yOff = { '前年': -2, '去年': -1, '今年': 0, '明年': 1 }[m[1]]!;
        const mm = cnNumToInt(m[2]);
        const dd = cnNumToInt(m[3]);
        if (mm && dd && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
            const y = curY + yOff;
            if (dd <= daysInMonth(y, mm - 1)) {
                push(dayRange(y, mm - 1, dd, m[0]));
            }
        }
    }

    // 2) 相對年 + 月：去年12月
    for (const m of query.matchAll(/(前年|去年|今年|明年)\s*(\d{1,2}|[一二三四五六七八九十]+)\s*月(?![\d一二三四五六七八九十份])/gu)) {
        const yOff = { '前年': -2, '去年': -1, '今年': 0, '明年': 1 }[m[1]]!;
        const mm = cnNumToInt(m[2]);
        if (mm && mm >= 1 && mm <= 12) {
            push(monthRange(curY + yOff, mm - 1, m[0]));
        }
    }

    // 3) 相對年：去年（無緊跟月份）
    for (const m of query.matchAll(/(前年|去年|今年|明年)(?![\d一二三四五六七八九十])/gu)) {
        const yOff = { '前年': -2, '去年': -1, '今年': 0, '明年': 1 }[m[1]]!;
        push(yearRange(curY + yOff, m[0]));
    }

    // 4) 絕對年月日：2024年12月15日 / 24年12月15號 / 2024-12-15 / 2024/12/15
    for (const m of query.matchAll(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/g)) {
        let y = parseInt(m[1], 10);
        if (y < 100) y += 2000;
        const mm = parseInt(m[2], 10);
        const dd = parseInt(m[3], 10);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth(y, mm - 1)) {
            push(dayRange(y, mm - 1, dd, m[0]));
        }
    }
    for (const m of query.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)) {
        const y = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const dd = parseInt(m[3], 10);
        if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth(y, mm - 1)) {
            push(dayRange(y, mm - 1, dd, m[0]));
        }
    }

    // 5) 絕對年月：2024年12月 / 24年12月
    for (const m of query.matchAll(/(\d{2,4})\s*年\s*(\d{1,2})\s*月(?![\d日号號])/g)) {
        let y = parseInt(m[1], 10);
        if (y < 100) y += 2000;
        const mm = parseInt(m[2], 10);
        if (mm >= 1 && mm <= 12) {
            push(monthRange(y, mm - 1, m[0]));
        }
    }

    // 6) 僅年：2024年（無緊跟月份）
    for (const m of query.matchAll(/(\d{4})\s*年(?![\d一二三四五六七八九十])/g)) {
        const y = parseInt(m[1], 10);
        push(yearRange(y, m[0]));
    }

    // 7) 孤立月日：3月4號 / 12月15日 / 3/4 / 12-15（無年份）→ 最近一次出現
    //    原本用 (?<![\d年]) 排除"前面緊跟數字或年"的情況。iOS Safari <16.4 的 JSC 不支持後行斷言,
    //    改成匹配後用 m.index 檢查前一字符, 行為等價 (見 utils/lookbehindFree.test.ts)。
    for (const m of query.matchAll(/(\d{1,2}|[一二三四五六七八九十]+)\s*月\s*(\d{1,2}|[一二三四五六七八九十]+)\s*[日号號]/gu)) {
        const idx = m.index ?? 0;
        if (idx > 0 && /[\d年]/u.test(query[idx - 1])) continue;  // 等價於 (?<![\d年])
        const mm = cnNumToInt(m[1]);
        const dd = cnNumToInt(m[2]);
        if (mm && dd && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
            const y = resolveNearestPastMonth(mm, now);
            if (dd <= daysInMonth(y, mm - 1)) {
                push(dayRange(y, mm - 1, dd, m[0]));
            }
        }
    }

    // 8) 孤立月：3月 / 十二月（無年份、無後續日/號）
    //    同 7): (?<![\d年]) 改成 m.index 檢查前一字符, 避開舊 iOS 不支持的後行斷言。
    for (const m of query.matchAll(/(\d{1,2}|[一二三四五六七八九十]+)\s*月(?![\d日号號份一二三四五六七八九十])/gu)) {
        const idx = m.index ?? 0;
        if (idx > 0 && /[\d年]/u.test(query[idx - 1])) continue;  // 等價於 (?<![\d年])
        const mm = cnNumToInt(m[1]);
        if (mm && mm >= 1 && mm <= 12) {
            const y = resolveNearestPastMonth(mm, now);
            push(monthRange(y, mm - 1, m[0]));
        }
    }

    // 9) 相對日：昨天/前天/今天/明天/後天/大前天/大後天
    const dayOffsets: Record<string, number> = {
        '大前天': -3, '前天': -2, '昨天': -1, '今天': 0,
        '明天': 1, '後天': 2, '大後天': 3,
    };
    for (const [kw, off] of Object.entries(dayOffsets)) {
        if (includesAnyScript(query, kw)) {
            const target = new Date(curY, curM0, curD + off);
            push(dayRange(target.getFullYear(), target.getMonth(), target.getDate(), kw));
        }
    }

    // 10) 相對周：上週/上禮拜/本週/這週/下週/下禮拜
    //    本週 = 週一 00:00 到週日 23:59
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 週一=1..週日=7
    const thisMondayD = curD - (dayOfWeek - 1);
    const thisMonday0 = startOfDay(curY, curM0, thisMondayD);
    if (/上\s*([个個])?\s*(周|週|[礼禮]拜|星期)/.test(query)) {
        push({
            start: startOfDay(curY, curM0, thisMondayD - 7),
            end: thisMonday0,
            label: '上週',
            confidence: 'fuzzy',
        });
    }
    if (/(本|[这這])\s*(周|週|[礼禮]拜|星期)/.test(query)) {
        push({
            start: thisMonday0,
            end: startOfDay(curY, curM0, thisMondayD + 7),
            label: '本週',
            confidence: 'fuzzy',
        });
    }
    if (/下\s*([个個])?\s*(周|週|[礼禮]拜|星期)/.test(query)) {
        push({
            start: startOfDay(curY, curM0, thisMondayD + 7),
            end: startOfDay(curY, curM0, thisMondayD + 14),
            label: '下週',
            confidence: 'fuzzy',
        });
    }

    // 11) 相對月：上個月/上月/本月/這個月/下個月
    if (/上\s*([个個])?\s*月(?![\d一二三四五六七八九十份])/.test(query)) {
        push(monthRange(curY, curM0 - 1, '上個月'));
    }
    if (/(本|[这這]\s*[个個]?)\s*月(?![\d一二三四五六七八九十份])/.test(query)) {
        push(monthRange(curY, curM0, '本月'));
    }
    if (/下\s*([个個])?\s*月(?![\d一二三四五六七八九十份])/.test(query)) {
        push(monthRange(curY, curM0 + 1, '下個月'));
    }

    // 12) 最近 / 最近一週 / 最近幾天（粗粒度，取 7 天）
    if (/最近(一[周週]|[几幾]天|[这這](一|[几幾])?天)?/.test(query)) {
        const end = startOfDay(curY, curM0, curD + 1); // 含今天
        push({ start: startOfDay(curY, curM0, curD - 6), end, label: '最近', confidence: 'fuzzy' });
    }

    return ranges;
}
