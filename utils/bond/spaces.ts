/**
 * 羈絆 App 要的清單與數字（plans/bond-batch1.md 3.2、3.3）。純邏輯，不碰資料庫。
 *
 * 空間開了才有（plans/bond-open-spaces.md）：`listPersonaSpaces`／`listPairSpaces` 只回開著的，
 * 背景功能（主動產出、約定判定、留給以後…）一律照它跑。要列「可以開哪些」用 `listKnownPersonaSpaces`。
 */
import type { BondRecord, CalendarEvent, CharacterProfile } from '../../types';
import { acquaintanceDays } from '../chatRelationship';
import { nextOccurrenceDate } from '../anniversary';
import { metDayLabel } from './routes';
import { pairBondId, parseBondId, personaBondId } from './model';
import { isBondOpen } from './openState';

export interface PersonaSpaceEntry {
    id: string;
    charId: string;
    personaKey: string;
}

export interface PairSpaceEntry {
    id: string;
    aId: string;
    bId: string;
}

type CharLike = Pick<CharacterProfile, 'id' | 'altOf' | 'knownPersonaKeys' | 'primaryPersonaKey'>;

/** 身份卡 × 角色：開著的空間（角色還在、不是小號） */
export function listPersonaSpaces(chars: CharLike[], bonds: BondRecord[]): PersonaSpaceEntry[] {
    const alive = new Set(chars.filter(c => !c.altOf).map(c => c.id));
    const out: PersonaSpaceEntry[] = [];
    for (const b of bonds) {
        if (b.kind !== 'persona' || !isBondOpen(b) || !alive.has(b.charId) || !b.personaKey) continue;
        out.push({ id: b.id, charId: b.charId, personaKey: b.personaKey });
    }
    return out;
}

/** 可以開的身份卡 × 角色：每個角色認識的每張卡一段（小號不開）＋表裡已有的；選對象、開新空間用 */
export function listKnownPersonaSpaces(chars: CharLike[], bonds: BondRecord[]): PersonaSpaceEntry[] {
    const seen = new Set<string>();
    const out: PersonaSpaceEntry[] = [];
    for (const c of chars) {
        if (c.altOf) continue;
        const keys = c.knownPersonaKeys?.length ? c.knownPersonaKeys : (c.primaryPersonaKey ? [c.primaryPersonaKey] : []);
        for (const key of keys) {
            const id = personaBondId(c.id, key);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, charId: c.id, personaKey: key });
        }
    }
    // 表裡有、但現在的認識清單沒列到的（例如之前建的、後來改了認識的卡）照樣列
    const alive = new Set(chars.filter(c => !c.altOf).map(c => c.id));
    for (const b of bonds) {
        if (b.kind !== 'persona' || seen.has(b.id) || !alive.has(b.charId) || !b.personaKey) continue;
        seen.add(b.id);
        out.push({ id: b.id, charId: b.charId, personaKey: b.personaKey });
    }
    return out;
}

/** 角色 × 角色：開著的空間；兩邊都還在、都不是小號 */
export function listPairSpaces(bonds: BondRecord[], chars: CharLike[]): PairSpaceEntry[] {
    const ok = new Set(chars.filter(c => !c.altOf).map(c => c.id));
    const ids = new Set<string>(bonds.filter(b => b.kind === 'pair' && isBondOpen(b)).map(b => b.id));
    const out: PairSpaceEntry[] = [];
    for (const id of ids) {
        const parsed = parseBondId(id);
        if (parsed?.kind !== 'pair' || !ok.has(parsed.charId) || !ok.has(parsed.otherCharId)) continue;
        out.push({ id: pairBondId(parsed.charId, parsed.otherCharId), aId: parsed.charId, bId: parsed.otherCharId });
    }
    return out;
}

export interface DayCounter {
    /** 'met' 或起點 id */
    id: string;
    label: string;
    date?: string;
    /** 第幾天（起點當天算第 1 天）；沒填日期或在未來是 null */
    days: number | null;
}

/** 天數清單：相識（讀聊天設定的相識起點）＋自己加的起點 */
export function dayCounters(bond: Pick<BondRecord, 'route' | 'days'>, metDate: string | undefined, todayKey: string): DayCounter[] {
    const met: DayCounter = { id: 'met', label: metDayLabel(bond.route), date: metDate || undefined, days: acquaintanceDays(metDate, todayKey) };
    const extra = bond.days.extra.map(s => ({
        id: s.id,
        label: s.kind === 'together' ? '交往' : s.kind === 'married' ? '結婚' : (s.label?.trim() || '自訂'),
        date: s.date,
        days: acquaintanceDays(s.date, todayKey),
    }));
    return [met, ...extra];
}

export function primaryCounter(bond: Pick<BondRecord, 'route' | 'days'>, metDate: string | undefined, todayKey: string): DayCounter {
    const all = dayCounters(bond, metDate, todayKey);
    return all.find(c => c.id === bond.days.primary) || all[0];
}

export interface NextAnniversary {
    event: CalendarEvent;
    date: string;
    daysLeft: number;
}

/**
 * 下一個紀念日：參與者或擁有者有這個角色的（身份卡 × 角色：也要有那張卡或沒指定卡；角色 × 角色：兩人都在）。
 */
export function nextAnniversary(events: CalendarEvent[], who: { charIds: string[]; personaKey?: string }, todayKey: string): NextAnniversary | null {
    return upcomingAnniversaries(events, who, todayKey, 1)[0] || null;
}

/** 接下來的幾個紀念日（打算送禮選日子用，plans/bond-batch5.md 2.3）；近的在前 */
export function upcomingAnniversaries(events: CalendarEvent[], who: { charIds: string[]; personaKey?: string }, todayKey: string, limit = 5): NextAnniversary[] {
    const people = (e: CalendarEvent) => [e.owner, ...(e.participants || [])];
    const hasChar = (e: CalendarEvent, id: string) => people(e).some(p => p.kind !== 'persona' && p.id === id);
    const personaOk = (e: CalendarEvent) => {
        if (!who.personaKey) return true;
        const personas = people(e).filter(p => p.kind === 'persona');
        return !personas.length || personas.some(p => p.id === who.personaKey);
    };
    const out: NextAnniversary[] = [];
    for (const e of events) {
        if (e.kind !== 'anniversary') continue;
        if (!who.charIds.every(id => hasChar(e, id)) || !personaOk(e)) continue;
        const anchor = e.start.slice(0, 10);
        const date = nextOccurrenceDate({ date: anchor, repeatAnnually: e.repeat === 'yearly' }, todayKey);
        if (date < todayKey) continue;
        const daysLeft = (acquaintanceDays(todayKey, date) ?? 1) - 1;
        out.push({ event: e, date, daysLeft });
    }
    // 同一天先到先列（跟原本 nextAnniversary 取第一個最早的一樣）
    return out.map((x, i) => ({ x, i })).sort((a, b) => (a.x.date < b.x.date ? -1 : a.x.date > b.x.date ? 1 : a.i - b.i)).map(v => v.x).slice(0, limit);
}
