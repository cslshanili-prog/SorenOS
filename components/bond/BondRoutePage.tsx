/**
 * 路線設定頁（plans/bond-batch1.md 3.4）：路線四選一、階段、自訂名／稱謂；存的時候問「修正設定」還是「關係真的變了」。
 */
import React, { useMemo, useState } from 'react';
import type { BondRoute } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { BOND_ROUTES, CUSTOM_STAGE, ROUTE_HINT, ROUTE_LABEL, defaultStage, stageForRoute, stageLabel, stagesOf } from '../../utils/bond/routes';
import { applyRouteChange } from '../../utils/bond/model';
import { saveBondRecord } from '../../utils/bond/store';
import { trackEvent } from '../../utils/analytics';

const ROUTE_CHOICES: Array<BondRoute | undefined> = [undefined, ...BOND_ROUTES];

export const BondRoutePage: React.FC<{ space: ResolvedSpace; onBack: () => void; addToast: (m: string, t?: 'success' | 'error' | 'info') => void }> = ({ space, onBack, addToast }) => {
    const { bond } = space;
    const [route, setRoute] = useState<BondRoute | undefined>(bond.route);
    const [stage, setStage] = useState(bond.stage);
    const [label, setLabel] = useState(bond.stageLabel || '');
    const [labelOther, setLabelOther] = useState(bond.stageLabelOther || '');
    const [asking, setAsking] = useState(false);
    const [kind, setKind] = useState<'fix' | 'turn'>('fix');
    const [note, setNote] = useState('');
    const [storyDay, setStoryDay] = useState(space.todayKey);
    const [saving, setSaving] = useState(false);

    const pickRoute = (r: BondRoute | undefined) => {
        setRoute(r);
        setStage(prev => stageForRoute(r, prev === CUSTOM_STAGE ? prev : (r === bond.route ? bond.stage : defaultStage(r))));
    };
    const stages = stagesOf(route);
    const changed = route !== bond.route || stage !== bond.stage || label.trim() !== (bond.stageLabel || '') || labelOther.trim() !== (bond.stageLabelOther || '');
    // 親情線的稱謂：身份卡 × 角色是「TA 是你的什麼」；角色 × 角色兩邊各一格
    const needsLabel = stage === CUSTOM_STAGE || route === 'family';
    const leftIsChar = space.kind === 'pair';

    const preview = useMemo(() => stageLabel({ route, stage, stageLabel: label }), [route, stage, label]);

    const save = async () => {
        setSaving(true);
        try {
            const next = applyRouteChange(bond, { route, stage, stageLabel: label, stageLabelOther: labelOther }, { kind, storyDay, note });
            await saveBondRecord(next.openedBy === 'auto' && !space.saved ? { ...next, openedBy: 'user' } : next);
            trackEvent('设定羁绊路线', {
                路线: route === 'romance' ? '恋爱' : route === 'friendship' ? '友情' : route === 'family' ? '亲情' : '未指定',
                方式: kind === 'fix' ? '修正' : '转折',
                类型: space.kind === 'pair' ? '角色之间' : '我和角色',
            });
            addToast('已經存好了', 'success');
            onBack();
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="路線與關係" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-7">
                <section>
                    <SectionLabel>路 線</SectionLabel>
                    <div className="divide-y bond-hair border-y">
                        {ROUTE_CHOICES.map(r => {
                            const on = r === route;
                            const key = r || 'none';
                            return (
                                <button key={key} type="button" onClick={() => pickRoute(r)} aria-pressed={on}
                                    className="w-full text-left py-3.5 flex gap-3 items-start">
                                    <span className={`mt-1 h-3.5 w-3.5 shrink-0 rounded-full border ${on ? 'border-[var(--bond-accent)] bg-[var(--bond-accent)]' : 'border-[var(--bond-rose)]'}`} />
                                    <span className="min-w-0">
                                        <span className={`bond-serif block text-[15px] ${on ? 'text-[var(--bond-accent)]' : ''}`}>{ROUTE_LABEL[key]}</span>
                                        <span className="block mt-1 text-[12px] leading-relaxed text-[var(--bond-ink-2)]">{ROUTE_HINT[key]}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </section>

                <section>
                    <SectionLabel>現在走到</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {stages.map(s => (
                            <button key={s.id} type="button" className="bond-chip" aria-pressed={stage === s.id} onClick={() => setStage(s.id)}>{s.label}</button>
                        ))}
                    </div>
                    {needsLabel && (
                        <div className="mt-3 space-y-2">
                            {route === 'family' && stage !== CUSTOM_STAGE ? (
                                <>
                                    <label className="block text-[12px] text-[var(--bond-ink-2)]">
                                        {leftIsChar ? `${space.leftName} 是 ${space.rightName} 的…` : `${space.rightName} 是你的…`}
                                        <input className="bond-input mt-1" value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：哥哥、妹妹、媽媽" maxLength={12} />
                                    </label>
                                    {leftIsChar && (
                                        <label className="block text-[12px] text-[var(--bond-ink-2)]">
                                            {`${space.rightName} 是 ${space.leftName} 的…`}
                                            <input className="bond-input mt-1" value={labelOther} onChange={e => setLabelOther(e.target.value)} placeholder="例如：弟弟、姐姐" maxLength={12} />
                                        </label>
                                    )}
                                </>
                            ) : (
                                <label className="block text-[12px] text-[var(--bond-ink-2)]">
                                    你們把這段關係叫作…{route ? `（仍屬${ROUTE_LABEL[route]}路線）` : ''}
                                    <input className="bond-input mt-1" value={label} onChange={e => setLabel(e.target.value)} placeholder="例如：共犯、搭檔" maxLength={12} />
                                </label>
                            )}
                        </div>
                    )}
                    <div className="mt-3 text-[12px] text-[var(--bond-muted)]">預覽：{ROUTE_LABEL[route || 'none']} · {preview}</div>
                </section>

                {asking && (
                    <section className="border-t bond-hair pt-5">
                        <SectionLabel>這次是…</SectionLabel>
                        <div className="space-y-2">
                            {([
                                ['fix', '修正設定', '建立時選錯了（例如你們本來就是戀人）。直接改成現在這樣，不當成一次轉折。'],
                                ['turn', '關係真的變了', '從這天起生效，之前那段照樣成立。角色會知道你們是從什麼時候、怎麼變的。'],
                            ] as const).map(([k, title, hint]) => (
                                <button key={k} type="button" onClick={() => setKind(k)} aria-pressed={kind === k}
                                    className={`w-full text-left rounded-xl border px-3.5 py-3 ${kind === k ? 'border-[var(--bond-accent)] bg-[var(--bond-accent-soft)]' : 'bond-hair bg-[var(--bond-card)]'}`}>
                                    <div className="bond-serif text-[14px]">{title}</div>
                                    <div className="mt-1 text-[12px] leading-relaxed text-[var(--bond-ink-2)]">{hint}</div>
                                </button>
                            ))}
                        </div>
                        {kind === 'turn' && (
                            <div className="mt-3 space-y-2">
                                <label className="block text-[12px] text-[var(--bond-ink-2)]">哪一天（故事裡的日期）
                                    <input type="date" className="bond-input mt-1" value={storyDay} onChange={e => setStoryDay(e.target.value || space.todayKey)} />
                                </label>
                                <label className="block text-[12px] text-[var(--bond-ink-2)]">發生了什麼（可以不寫）
                                    <input className="bond-input mt-1" value={note} onChange={e => setNote(e.target.value)} placeholder="例如：海邊那晚" maxLength={40} />
                                </label>
                            </div>
                        )}
                    </section>
                )}

                {bond.routeLog.length > 0 && (
                    <section className="border-t bond-hair pt-5">
                        <SectionLabel>歷 程</SectionLabel>
                        <ol className="space-y-3">
                            {[...bond.routeLog].reverse().map((c, i) => (
                                <li key={`${c.at}-${i}`} className="text-[12.5px] leading-relaxed">
                                    <div className="text-[var(--bond-muted)] text-[11px]">{c.storyDay} · {c.kind === 'turn' ? '關係變了' : '修正設定'}</div>
                                    <div>
                                        {ROUTE_LABEL[c.from.route || 'none']}・{stageLabel({ route: c.from.route, stage: c.from.stage, stageLabel: c.from.label })}
                                        <span className="mx-1.5 text-[var(--bond-rose)]">→</span>
                                        {ROUTE_LABEL[c.to.route || 'none']}・{stageLabel({ route: c.to.route, stage: c.to.stage, stageLabel: c.to.label })}
                                    </div>
                                    {c.note && <div className="text-[var(--bond-ink-2)]">{c.note}</div>}
                                </li>
                            ))}
                        </ol>
                    </section>
                )}
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                {!asking ? (
                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!changed} onClick={() => setAsking(true)}>存起來</button>
                ) : (
                    <>
                        <button type="button" className="bond-btn flex-1" onClick={() => setAsking(false)}>再想想</button>
                        <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={saving} onClick={save}>{saving ? '存檔中…' : '確定'}</button>
                    </>
                )}
            </div>
        </div>
    );
};
