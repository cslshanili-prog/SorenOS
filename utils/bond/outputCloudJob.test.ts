import { describe, expect, it } from 'vitest';
import {
    bondOutputFireTime, bondOutputJobId, buildBondOutputJob, buildBondOutputMessages, buildBondOutputResult, decideBondOutputFire, inOutputWindow,
    nextFireLocal, parseBondOutputJob, parseBondOutputJobId, parseBondOutputLog, parseBondOutputResult, recordBondOutput, zonedParts, type BondOutputJob,
} from './outputCloudJob';
import { inWindow } from './output';

const DAY = 86400_000;
const HOUR = 3600_000;
// 2026-11-26 13:00 UTC＝台北 21:00
const now = Date.UTC(2026, 10, 26, 13, 0);
const TZ = 'Asia/Taipei';

const job = (over: Partial<BondOutputJob> = {}): BondOutputJob => buildBondOutputJob({
    bondId: 'c1::p1', charId: 'c1', charName: '煦', tzId: TZ, refreshedAt: now - HOUR,
    system: 'SYS', lock: 'LOCK',
    limits: { perBondPerDay: 2, minGapMs: 3 * HOUR, allPerDay: 6 },
    kinds: {
        diary: {
            dueAt: now - HOUR, everyDays: [1, 3], window: { from: '20:00', to: '23:30' }, withNotice: true, taskUuid: 'T-diary',
            diary: {
                base: { selfName: '煦', otherName: 'Liora', recentSummaries: '', recentChat: '', chars: [200, 500] },
                dateTz: TZ, dateOffsetMs: 0, today: '2026-11-26', userPageToday: '今天下雨', writtenToday: false,
            },
        },
        question: { dueAt: now - HOUR, everyDays: [3, 7], withNotice: false, prompt: 'Q-PROMPT' },
        note: { dueAt: now + DAY, everyDays: [3, 7], withNotice: false, prompt: 'N-PROMPT', tags: ['想你'] },
    },
    ...over,
});

describe('羈絆主動產出上雲：契約', () => {
    it('job 編號來回', () => {
        expect(parseBondOutputJobId(bondOutputJobId('c1::p1', 'note'))).toEqual({ bondId: 'c1::p1', kind: 'note' });
        expect(parseBondOutputJobId('schedule-c1')).toBeNull();
        expect(parseBondOutputJob(JSON.stringify(job()))?.bondId).toBe('c1::p1');
        expect(parseBondOutputJob('{"v":2}')).toBeNull();
    });

    it('時區裡的日期與分鐘', () => {
        expect(zonedParts(TZ, now)).toEqual({ dateKey: '2026-11-26', minutes: 21 * 60 });
        expect(zonedParts('UTC', now)).toEqual({ dateKey: '2026-11-26', minutes: 13 * 60 });
    });

    it('投遞時段跟本機那份判斷一樣', () => {
        for (const w of [undefined, { from: '20:00', to: '23:30' }, { from: '22:00', to: '02:00' }, { from: '08:00', to: '08:00' }]) {
            for (const m of [0, 61, 480, 1200, 1300, 1439]) expect(inOutputWindow(w, m)).toBe(inWindow(w, m));
        }
    });

    it('到點時刻落在時段裡（尾巴留 20 分鐘），沒時段在 10～22 點，同一段關係每次算一樣', () => {
        const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
        for (const id of ['a::p', 'b::q', 'c::r', 'd::s']) {
            const t = toMin(bondOutputFireTime(id, 'diary', { from: '20:00', to: '23:30' }));
            expect(t).toBeGreaterThanOrEqual(20 * 60);
            expect(t).toBeLessThan(23 * 60 + 10);
            const free = toMin(bondOutputFireTime(id, 'note', undefined));
            expect(free).toBeGreaterThanOrEqual(10 * 60);
            expect(free).toBeLessThan(22 * 60);
            const midnight = toMin(bondOutputFireTime(id, 'diary', { from: '22:00', to: '02:00' }));
            expect(midnight >= 22 * 60 || midnight < 2 * 60).toBe(true);
            expect(bondOutputFireTime(id, 'diary', undefined)).toBe(bondOutputFireTime(id, 'diary', undefined));
        }
    });

    it('下一次到點：今天還沒過就今天，過了就明天', () => {
        expect(nextFireLocal(TZ, '22:15', now)).toBe('2026-11-26T22:15:00');
        expect(nextFireLocal(TZ, '20:30', now)).toBe('2026-11-27T20:30:00');
        expect(nextFireLocal(TZ, '21:01', now)).toBe('2026-11-27T21:01:00');
    });
});

describe('羈絆主動產出上雲：到點判斷', () => {
    it('到期、在時段裡就寫；日記日期照角色那邊', () => {
        expect(decideBondOutputFire(job(), 'diary', 'T-diary', now, null)).toEqual({ ok: true, day: '2026-11-26', dateKey: '2026-11-26' });
        const shifted = job();
        shifted.kinds.diary!.diary!.dateTz = 'America/Los_Angeles';
        expect(decideBondOutputFire(shifted, 'diary', 'T-diary', now, null)).toMatchObject({ ok: true, dateKey: '2026-11-26' });
        shifted.kinds.diary!.diary!.dateOffsetMs = 2 * DAY;
        expect(decideBondOutputFire(shifted, 'diary', 'T-diary', now, null)).toMatchObject({ ok: true, dateKey: '2026-11-28' });
    });

    it('各種跳過', () => {
        expect(decideBondOutputFire(job(), 'essay', null, now, null)).toEqual({ ok: false, reason: 'kind-off' });
        expect(decideBondOutputFire(job(), 'diary', 'T-old', now, null)).toEqual({ ok: false, reason: 'stale-task' });
        expect(decideBondOutputFire(job(), 'note', null, now, null)).toEqual({ ok: false, reason: 'not-due' });
        const paused = job();
        paused.kinds.question!.pausedUntil = now + DAY;
        expect(decideBondOutputFire(paused, 'question', null, now, null)).toEqual({ ok: false, reason: 'paused' });
        const noStart = job();
        noStart.kinds.question!.dueAt = null;
        expect(decideBondOutputFire(noStart, 'question', null, now, null)).toEqual({ ok: false, reason: 'not-due' });
        const early = job();
        early.kinds.diary!.dueAt = now - DAY;
        expect(decideBondOutputFire(early, 'diary', 'T-diary', now - 3 * HOUR, null)).toEqual({ ok: false, reason: 'out-of-window' });
        const written = job();
        written.kinds.diary!.diary!.writtenToday = true;
        expect(decideBondOutputFire(written, 'diary', 'T-diary', now, null)).toEqual({ ok: false, reason: 'diary-written' });
        // 隔天就不算「今天寫過」了
        expect(decideBondOutputFire(written, 'diary', 'T-diary', now + DAY, null)).toMatchObject({ ok: true, dateKey: '2026-11-27' });
    });

    it('雲端自己的帳：同一種隔區間下限、一段一天兩份、兩份隔三小時、全部一天六份', () => {
        const wrote = recordBondOutput(null, '2026-11-26', 'c1::p1', 'question', now - 4 * HOUR);
        expect(decideBondOutputFire(job({ refreshedAt: now - 5 * HOUR }), 'question', null, now, wrote)).toEqual({ ok: false, reason: 'cloud-wrote-recently' });
        // job 是之後才刷的：本機已經把到期時間推過了，帳上那筆不擋
        expect(decideBondOutputFire(job(), 'question', null, now, wrote)).toMatchObject({ ok: true });
        const gap = recordBondOutput(null, '2026-11-26', 'c1::p1', 'note', now - HOUR);
        expect(decideBondOutputFire(job(), 'question', null, now, gap)).toEqual({ ok: false, reason: 'gap' });
        let two = recordBondOutput(null, '2026-11-26', 'c1::p1', 'note', now - 10 * HOUR);
        two = recordBondOutput(two, '2026-11-26', 'c1::p1', 'essay', now - 6 * HOUR);
        expect(decideBondOutputFire(job(), 'question', null, now, two)).toEqual({ ok: false, reason: 'bond-cap' });
        let all = null as ReturnType<typeof recordBondOutput> | null;
        for (let i = 0; i < 6; i++) all = recordBondOutput(all, '2026-11-26', `x${i}::p`, 'diary', now - (10 - i) * HOUR);
        expect(decideBondOutputFire(job(), 'question', null, now, all)).toEqual({ ok: false, reason: 'all-cap' });
        // 換天歸零（但同一段兩份隔三小時照算）
        expect(decideBondOutputFire(job(), 'question', null, now, { ...all!, day: '2026-11-25' })).toMatchObject({ ok: true });
    });

    it('帳的格式來回、14 天前的種類記錄丟掉', () => {
        const a = recordBondOutput(null, '2026-11-10', 'b', 'diary', now - 16 * DAY);
        const b = recordBondOutput(a, '2026-11-26', 'c', 'note', now);
        expect(Object.keys(b.kinds)).toEqual(['c|note']);
        expect(b.total).toBe(1);
        expect(parseBondOutputLog(JSON.stringify(b))).toEqual(b);
        expect(parseBondOutputLog('nope')).toBeNull();
    });
});

describe('羈絆主動產出上雲：提示詞與結果', () => {
    it('系統＋提示詞＋路線鎖；日記照那天補日期，你那頁只在同一天帶', () => {
        const msgs = buildBondOutputMessages(job(), 'question', '2026-11-26')!;
        expect(msgs).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Q-PROMPT\n\nLOCK' }]);
        const today = buildBondOutputMessages(job(), 'diary', '2026-11-26')![1].content;
        expect(today).toContain('現在是 2026-11-26');
        expect(today).toContain('今天下雨');
        const tomorrow = buildBondOutputMessages(job(), 'diary', '2026-11-27')![1].content;
        expect(tomorrow).toContain('現在是 2026-11-27');
        expect(tomorrow).not.toContain('今天下雨');
        expect(buildBondOutputMessages(job({ lock: '' }), 'question', 'x')![1].content).toBe('Q-PROMPT');
        expect(buildBondOutputMessages(job(), 'essay', 'x')).toBeNull();
    });

    it('結果來回', () => {
        const r = buildBondOutputResult({ bondId: 'c1::p1', charId: 'c1', kind: 'note', dateKey: '2026-11-26', raw: '{"text":"嗨"}', jobRefreshedAt: 1, generatedAt: 2, replyTo: 'e1' });
        expect(parseBondOutputResult(JSON.parse(JSON.stringify(r)))).toEqual(r);
        expect(parseBondOutputResult({ ...r, kind: 'poem' })).toBeNull();
        expect(parseBondOutputResult({ ...r, resultKind: 'schedule-generate' })).toBeNull();
    });
});
