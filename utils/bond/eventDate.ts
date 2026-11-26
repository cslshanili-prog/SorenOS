/**
 * 事件日期（plans/bond-batch2.md 1.1）：可以只知道到月、只知道一段時期，或完全不知道。
 * 紀要 3.1：保留不確定性，允許補填，不捏造精確日期。純邏輯，有測試。
 */
import type { BondEventDate } from '../../types';

/** 從記憶的 date 字串（「2026-05-01」「2026年5月」「2026/5/1 夜」…）讀出精度 */
export function eventDateFromText(text: string | undefined | null): BondEventDate {
    const s = String(text || '');
    const m = s.match(/(\d{4})[-/年.](\d{1,2})(?:[-/月.](\d{1,2}))?/);
    if (!m) return { precision: 'unknown' };
    const y = m[1];
    const mo = m[2].padStart(2, '0');
    if (Number(mo) < 1 || Number(mo) > 12) return { precision: 'unknown' };
    if (m[3]) {
        const d = m[3].padStart(2, '0');
        if (Number(d) >= 1 && Number(d) <= 31) return { precision: 'day', date: `${y}-${mo}-${d}` };
    }
    return { precision: 'month', date: `${y}-${mo}` };
}

/** 時間戳 → 那天（本機日期 key 由呼叫端算好傳進來比較安全；這裡給沒有時區需求的地方用） */
export function dayEventDate(dateKey: string): BondEventDate {
    return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? { precision: 'day', date: dateKey } : { precision: 'unknown' };
}

/**
 * 排序用的鍵（字串比較，越大越新）。日期不明的排最舊（空字串），某段時期沒有大概日期的也一樣；
 * 只到月的放在那個月的最前面（「某天」不壓過那個月有確切日期的事）。
 */
export function eventSortKey(d: BondEventDate | undefined): string {
    if (!d) return '';
    if (d.precision === 'day') return d.date;
    if (d.precision === 'month') return `${d.date}-00`;
    if (d.precision === 'period') {
        const s = d.date || '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        if (/^\d{4}-\d{2}$/.test(s)) return `${s}-00`;
        if (/^\d{4}$/.test(s)) return `${s}-00-00`;
        return '';
    }
    return '';
}

/** 月份分段用：'2026-05'；沒有就 ''（放進「日期不明」） */
export function eventMonthKey(d: BondEventDate | undefined): string {
    const key = eventSortKey(d);
    const m = key.match(/^(\d{4})-(\d{2})/);
    return m && m[2] !== '00' ? `${m[1]}-${m[2]}` : (m ? `${m[1]}` : '');
}

/** 給人看：「2026 年 5 月 1 日」「2026 年 5 月某天」「剛認識那陣子」「日期不明」 */
export function formatEventDate(d: BondEventDate | undefined): string {
    if (!d) return '日期不明';
    if (d.precision === 'day') {
        const [y, m, day] = d.date.split('-');
        return `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
    }
    if (d.precision === 'month') {
        const [y, m] = d.date.split('-');
        return `${y} 年 ${Number(m)} 月某天`;
    }
    if (d.precision === 'period') return d.label.trim() || '某段時間';
    return '日期不明';
}

/** 給 AI 看的短寫法：「2026-05-01」「2026-05（哪天不確定）」「剛認識那陣子（大概時間）」「日期不明」 */
export function promptEventDate(d: BondEventDate | undefined): string {
    if (!d || d.precision === 'unknown') return '日期不明';
    if (d.precision === 'day') return d.date;
    if (d.precision === 'month') return `${d.date}（哪天不確定）`;
    return `${d.label.trim() || '某段時間'}（大概時間）`;
}

/** 月份分段標題：「2026 年 5 月」「2026 年」；空鍵是「日期不明」 */
export function formatMonthKey(key: string): string {
    const m = key.match(/^(\d{4})(?:-(\d{2}))?$/);
    if (!m) return '日期不明';
    return m[2] ? `${m[1]} 年 ${Number(m[2])} 月` : `${m[1]} 年`;
}
