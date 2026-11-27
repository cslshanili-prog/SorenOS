/**
 * 主動產出設定（plans/bond-batch3.md 1.4、3.2）：日記、拾光問答、心靈角落、隨筆各一區——
 * 開關、多久一次、篇幅、文風（日記）、投遞時段、同步私聊、暫停；下面寫下一次大概什麼時候。
 * 沒動過的類型照預設：最近 14 天有聊過才算開。
 */
import React, { useEffect, useState } from 'react';
import { Feather } from '@phosphor-icons/react';
import type { APIConfig, BondOutputKind, BondOutputSetting } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { writeOne } from './outputRun';
import { bondOutputCloudKinds } from './outputCloud';
import { DEFAULT_OUTPUT, markOutputDone, nextDueAt, OUTPUT_CHARS_LIMIT, OUTPUT_KIND_LABEL, OUTPUT_KINDS, OUTPUT_LIMITS, resolveOutputChars, resolveOutputSetting } from '../../utils/bond/output';
import ExpandableTextarea from '../common/ExpandableTextarea';
import { updateBond } from '../../utils/bond/store';
import { trackEvent } from '../../utils/analytics';

const KIND_HINT: Record<BondOutputKind, string> = {
    diary: '有值得留下的一天（每日總結、見面）會提早寫；沒有就照區間寫一篇。',
    question: '照最近的事、或從人設出發出一題，先交出並封存自己的答案。',
    note: '你丟來的紙條先回；沒有就丟一張——可以只是一句話。',
    essay: '從還沒寫過的事裡挑一件寫感想，寫成草稿等你收下。',
    wish: '照人設和最近的事寫一個自己的願望，或想跟你一起做的事；寫了只是讓你看見，不等於約好。',
    letter: '寫一封完整的信給你，偶爾慢慢寄；里程碑、紀念日、見面之後、很久沒說話、你的信到了，會提早寫。',
};

const STYLE_PLACEHOLDER: Record<BondOutputKind, string> = {
    diary: '空著＝照角色個性，例如：像寫信、短句、會畫重點',
    question: '空著＝照角色個性，例如：答得直白一點、愛用比喻',
    note: '空著＝照角色個性，例如：像便利貼、一句話就好',
    essay: '空著＝照角色個性，例如：像散文、少一點形容詞',
    wish: '空著＝照角色個性，例如：很具體、像便條上的一句話',
    letter: '空著＝照角色個性，例如：像老派的書信、會寫天氣和近況',
};
const DAY = 86400_000;
const EVENT_LABEL = { diary: '日記', question: '問答', note: '紙條', essay: '隨筆', wish: '願望', letter: '信' } as const;

const whenText = (ts: number | null) => {
    if (!ts) return '還沒排';
    const diff = ts - Date.now();
    if (diff <= 0) return '這幾天、下一個投遞時段';
    const d = Math.round(diff / DAY);
    return d <= 0 ? '今天之內' : `大約 ${d} 天後`;
};

export const BondOutputSettingsPage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    onBack: () => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, apiConfig, onBack, addToast }) => {
    const [bond, setBond] = useState(space.bond);
    const [busy, setBusy] = useState<BondOutputKind | null>(null);
    // 「信」第一次打開：先填幾天一封、幾字（plans/bond-batch5.md 3.3，Liora 定的：不給預先填好的數字）
    const [letterSetup, setLetterSetup] = useState(false);
    const name = space.rightName;
    const cloudKinds = bondOutputCloudKinds(space.id);

    const patch = async (kind: BondOutputKind, p: Partial<BondOutputSetting>, action?: '开' | '关' | '暂停' | '改区间' | '改篇幅' | '改文风') => {
        const next = await updateBond(space.id, b => ({ ...b, output: { ...(b.output || {}), [kind]: { ...(b.output?.[kind] || {}), ...p } } }));
        setBond(next);
        if (action) trackEvent('调整主动产出', { 类型: ({ diary: '日记', question: '问答', note: '纸条', essay: '随笔', wish: '愿望', letter: '信' } as const)[kind], 动作: action });
    };

    const tryNow = async (kind: BondOutputKind) => {
        setBusy(kind);
        try {
            const done = await writeOne({ ...space, bond }, kind, apiConfig);
            setBond(await updateBond(space.id, b => markOutputDone(b, kind, Date.now())));
            addToast(done ? `${name}寫了一份${EVENT_LABEL[kind]}` : `${name}今天已經寫過了`, 'success');
        } catch (e: any) {
            addToast(e?.message || '這次沒寫出來', 'error');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="主動產出" onBack={onBack} />
            {letterSetup && (
                <LetterSetupPage name={name} onBack={() => setLetterSetup(false)}
                    onSave={async (everyDays, chars) => { await patch('letter', { enabled: true, everyDays, chars }, '开'); setLetterSetup(false); addToast(`好，${name}大約每 ${everyDays[0]}～${everyDays[1]} 天寫一封`, 'success'); }} />
            )}
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-8">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    {name}會照這裡的節奏自己寫：有值得留下的事會提早，沒有就到點寫一份。每段關係一天最多 {OUTPUT_LIMITS.perBondPerDay} 份、兩份至少隔 {OUTPUT_LIMITS.minGapMs / 3600_000} 小時；所有關係加起來一天最多 {OUTPUT_LIMITS.allPerDay} 份。沒改過的類型，最近 14 天有聊過才會開始寫。
                </p>
                {OUTPUT_KINDS.map(kind => {
                    const s = resolveOutputSetting(bond, kind);
                    const own = bond.output?.[kind];
                    const on = own && typeof own.enabled === 'boolean' ? own.enabled : s.enabled;
                    const paused = !!s.pausedUntil && s.pausedUntil > Date.now();
                    return (
                        <section key={kind}>
                            <SectionLabel right={
                                <button type="button" className="bond-chip" aria-pressed={on} onClick={() => {
                                    if (kind === 'letter' && !on && !(own?.everyDays && own?.chars)) { setLetterSetup(true); return; }
                                    void patch(kind, { enabled: !on }, on ? '关' : '开');
                                }}>{on ? '開著' : '關著'}</button>
                            }>{OUTPUT_KIND_LABEL[kind]}</SectionLabel>
                            <p className="text-[11.5px] leading-relaxed text-[var(--bond-muted)]">{KIND_HINT[kind]}</p>
                            {on && (
                                <div className="mt-3 space-y-3">
                                    <Row label="多久一次">
                                        <NumberBox value={s.everyDays[0]} onChange={v => patch(kind, { everyDays: [v, Math.max(v, s.everyDays[1])] }, '改区间')} />
                                        <span className="text-[12px] text-[var(--bond-muted)]">～</span>
                                        <NumberBox value={s.everyDays[1]} onChange={v => patch(kind, { everyDays: [Math.min(v, s.everyDays[0]), v] }, '改区间')} />
                                        <span className="text-[12px] text-[var(--bond-muted)]">天</span>
                                    </Row>
                                    <Row label="篇幅">
                                        {(() => {
                                            const [lo, hi] = resolveOutputChars(bond, kind);
                                            return (
                                                <>
                                                    <NumberBox value={lo} min={OUTPUT_CHARS_LIMIT[0]} max={OUTPUT_CHARS_LIMIT[1]} width={76} label="最少幾字"
                                                        onChange={v => patch(kind, { chars: [v, Math.max(v, hi)] }, '改篇幅')} />
                                                    <span className="text-[12px] text-[var(--bond-muted)]">～</span>
                                                    <NumberBox value={hi} min={OUTPUT_CHARS_LIMIT[0]} max={OUTPUT_CHARS_LIMIT[1]} width={76} label="最多幾字"
                                                        onChange={v => patch(kind, { chars: [Math.min(v, lo), v] }, '改篇幅')} />
                                                    <span className="text-[12px] text-[var(--bond-muted)]">字</span>
                                                </>
                                            );
                                        })()}
                                    </Row>
                                    <div className="space-y-1.5">
                                        <span className="block text-[12px] text-[var(--bond-ink-2)]">文風</span>
                                        <StyleBox value={s.style || ''} title={`${OUTPUT_KIND_LABEL[kind]}的文風`} placeholder={STYLE_PLACEHOLDER[kind]}
                                            onCommit={v => { if (v !== (s.style || '')) void patch(kind, { style: v || undefined }, '改文风'); }} />
                                    </div>
                                    <Row label="投遞時段">
                                        {s.window ? (
                                            <>
                                                <input type="time" className="bond-input" style={{ width: 112, flex: 'none' }} value={s.window.from} onChange={e => patch(kind, { window: { from: e.target.value, to: s.window!.to } })} />
                                                <span className="text-[12px] text-[var(--bond-muted)]">～</span>
                                                <input type="time" className="bond-input" style={{ width: 112, flex: 'none' }} value={s.window.to} onChange={e => patch(kind, { window: { from: s.window!.from, to: e.target.value } })} />
                                                <button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={() => patch(kind, { window: undefined })}>全天</button>
                                            </>
                                        ) : (
                                            <button type="button" className="bond-chip" onClick={() => patch(kind, { window: DEFAULT_OUTPUT.diary.window })}>全天（點了改時段）</button>
                                        )}
                                    </Row>
                                    <Row label="同步私聊">
                                        <button type="button" className="bond-chip" aria-pressed={s.syncToChat} onClick={() => patch(kind, { syncToChat: !s.syncToChat })}>
                                            {s.syncToChat ? `寫好後${name}會在私聊說一聲` : '只留在羈絆'}
                                        </button>
                                    </Row>
                                    <Row label="暫停">
                                        {paused ? (
                                            <>
                                                <span className="text-[12px] text-[var(--bond-ink-2)]">暫停到 {new Date(s.pausedUntil!).toLocaleDateString()}</span>
                                                <button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={() => patch(kind, { pausedUntil: undefined })}>恢復</button>
                                            </>
                                        ) : (
                                            [3, 7, 30].map(d => <button key={d} type="button" className="bond-chip" onClick={() => patch(kind, { pausedUntil: Date.now() + d * DAY }, '暂停')}>{d} 天</button>)
                                        )}
                                    </Row>
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-[11.5px] text-[var(--bond-muted)]">
                                            下一次：{paused ? '暫停中' : whenText(nextDueAt(bond, kind))}
                                            {cloudKinds.includes(kind) && <><br />App 關著時由雲端寫</>}
                                        </span>
                                        <button type="button" className="bond-btn" disabled={!!busy} onClick={() => tryNow(kind)}>
                                            <Feather size={14} />{busy === kind ? '寫著…' : '現在寫一份'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </section>
                    );
                })}
                <p className="text-[11px] leading-relaxed text-[var(--bond-muted)] pb-6">
                    同步私聊只管要不要另外傳一則訊息，不管{name}記不記得：寫好的日記、出的題、丟的紙條，{name}本來就知道。
                    App 開著時在這台裝置上寫；這條線開了主動消息 2.0、Worker 也是新版的話，App 關著時由雲端到點寫，同一份不會寫兩次。
                </p>
            </div>
        </div>
    );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-[12px] text-[var(--bond-ink-2)]">{label}</span>
        <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">{children}</div>
    </div>
);

/** 數字格：打字時先放著，離開或按 Enter 才存（才不會打到一半就被夾到最小值） */
const NumberBox: React.FC<{ value: number; onChange: (v: number) => void; min?: number; max?: number; width?: number; label?: string }> = ({ value, onChange, min = 1, max = 60, width = 64, label }) => {
    const [draft, setDraft] = useState(String(value));
    useEffect(() => { setDraft(String(value)); }, [value]);
    const commit = () => {
        const n = Math.round(Number(draft));
        if (!Number.isFinite(n) || draft.trim() === '') { setDraft(String(value)); return; }
        const v = Math.max(min, Math.min(max, n));
        setDraft(String(v));
        if (v !== value) onChange(v);
    };
    return (
        <input type="number" inputMode="numeric" min={min} max={max} aria-label={label} className="bond-input text-center" style={{ width, flex: 'none' }} value={draft}
            onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    );
};

/** 文風：多行、可以全螢幕寫；離開框或全螢幕按完成才存 */
const StyleBox: React.FC<{ value: string; title: string; placeholder: string; onCommit: (v: string) => void }> = ({ value, title, placeholder, onCommit }) => {
    const [draft, setDraft] = useState(value);
    useEffect(() => { setDraft(value); }, [value]);
    return (
        <ExpandableTextarea value={draft} onChange={setDraft} title={title} rows={2} maxLength={400} placeholder={placeholder}
            className="bond-input w-full resize-none leading-relaxed" onBlur={() => onCommit(draft.trim())} onCommit={v => onCommit(v.trim())} />
    );
};

/** 「信」第一次打開的設定（全螢幕）：幾天一封、幾字到幾字都由你填，沒有預先填好的數字 */
const LetterSetupPage: React.FC<{ name: string; onBack: () => void; onSave: (everyDays: [number, number], chars: [number, number]) => void }> = ({ name, onBack, onSave }) => {
    const [d1, setD1] = useState('');
    const [d2, setD2] = useState('');
    const [c1, setC1] = useState('');
    const [c2, setC2] = useState('');
    const num = (v: string) => (v.trim() === '' ? NaN : Math.round(Number(v)));
    const days = [num(d1), num(d2)];
    const chars = [num(c1), num(c2)];
    const daysOk = days.every(n => Number.isFinite(n) && n >= 1 && n <= 60);
    const charsOk = chars.every(n => Number.isFinite(n) && n >= OUTPUT_CHARS_LIMIT[0] && n <= OUTPUT_CHARS_LIMIT[1]);
    const box = (v: string, set: (s: string) => void, label: string, width = 76) => (
        <input type="number" inputMode="numeric" aria-label={label} placeholder="?" className="bond-input text-center" style={{ width, flex: 'none' }} value={v} onChange={e => set(e.target.value)} />
    );
    return (
        <div className="absolute inset-0 z-20 flex flex-col bond-root">
            <BondHeader title={`${name}的信`} onBack={onBack} backLabel="取消" />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6 space-y-7">
                <p className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                    {name}會自己寫信給你：比紙條長、比聊天慢，偶爾慢慢寄、過幾天才到。多久一封、寫多長，你來定。
                </p>
                <section className="space-y-2">
                    <SectionLabel>多 久 一 封</SectionLabel>
                    <div className="flex items-center gap-2">{box(d1, setD1, '最少幾天', 64)}<span className="text-[12px] text-[var(--bond-muted)]">～</span>{box(d2, setD2, '最多幾天', 64)}<span className="text-[12px] text-[var(--bond-muted)]">天一封</span></div>
                    <p className="text-[11px] text-[var(--bond-muted)]">1～60 天。在這個區間裡挑一天寫；里程碑、紀念日、見面之後、很久沒說話、你的信到了，會提早。</p>
                </section>
                <section className="space-y-2">
                    <SectionLabel>寫 多 長</SectionLabel>
                    <div className="flex items-center gap-2">{box(c1, setC1, '最少幾字')}<span className="text-[12px] text-[var(--bond-muted)]">～</span>{box(c2, setC2, '最多幾字')}<span className="text-[12px] text-[var(--bond-muted)]">字</span></div>
                    <p className="text-[11px] text-[var(--bond-muted)]">{OUTPUT_CHARS_LIMIT[0]}～{OUTPUT_CHARS_LIMIT[1]} 字。話少的角色還是可能寫得短一點。</p>
                </section>
                <p className="text-[11px] leading-relaxed text-[var(--bond-muted)]">之後在這頁照樣能改；投遞時段預設晚上 20:00～23:30，信到了會在私聊落一張信封。</p>
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!daysOk || !charsOk}
                    onClick={() => onSave([Math.min(days[0], days[1]), Math.max(days[0], days[1])], [Math.min(chars[0], chars[1]), Math.max(chars[0], chars[1])])}>打開</button>
            </div>
        </div>
    );
};

