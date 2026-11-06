import React, { useEffect, useState } from 'react';
import type { CharacterProfile } from '../../types';
import { describeLength } from '../../utils/dateExtras';

// 見面設定裡的劇情大綱、開場白、回應字數三塊。內建規則和自訂預設都吃這三項：
// 大綱進預設的「場景」佔位（{{scenario}} 也讀它），字數蓋預設裡讀字數的 getglobalvar。
// 輸入先放草稿，點別處才存，免得每打一個字就寫一次 DB。

type Greeting = NonNullable<CharacterProfile['dateGreetings']>[number];

interface Props {
    char: CharacterProfile;
    updateCharacter: (id: string, patch: Partial<CharacterProfile>) => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }>;
}

const makeGreetingId = () => `dg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
const toNumber = (value: string): number | undefined => {
    const n = Math.floor(Number(value));
    return value.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};

const DateStoryExtras: React.FC<Props> = ({ char, updateCharacter, addToast, Section }) => {
    const [scenario, setScenario] = useState(char.dateScenario || '');
    const [greetings, setGreetings] = useState<Greeting[]>(char.dateGreetings || []);
    const [minDraft, setMinDraft] = useState(char.dateResponseLength?.min ? String(char.dateResponseLength.min) : '');
    const [maxDraft, setMaxDraft] = useState(char.dateResponseLength?.max ? String(char.dateResponseLength.max) : '');
    useEffect(() => {
        setScenario(char.dateScenario || '');
        setGreetings(char.dateGreetings || []);
        setMinDraft(char.dateResponseLength?.min ? String(char.dateResponseLength.min) : '');
        setMaxDraft(char.dateResponseLength?.max ? String(char.dateResponseLength.max) : '');
    }, [char.id]);

    const saveScenario = () => {
        const trimmed = scenario.trim();
        if (trimmed === (char.dateScenario || '')) return;
        updateCharacter(char.id, { dateScenario: trimmed || undefined });
        addToast(trimmed ? '劇情大綱已保存' : '劇情大綱已清空', 'success');
    };

    const saveGreetings = (next: Greeting[]) => {
        const cleaned = next.map(g => ({ ...g, text: g.text.trim() })).filter(g => g.text);
        const before = JSON.stringify(char.dateGreetings || []);
        if (JSON.stringify(cleaned) === before) return;
        updateCharacter(char.id, {
            dateGreetings: cleaned.length ? cleaned : undefined,
            // 開場白都刪光了就退回讓模型寫
            ...(cleaned.length ? {} : { dateOpeningSource: undefined }),
        });
    };
    const editGreeting = (id: string, text: string) => setGreetings(list => list.map(g => (g.id === id ? { ...g, text } : g)));
    const addGreeting = () => setGreetings(list => [...list, { id: makeGreetingId(), text: '' }]);
    const removeGreeting = (id: string) => {
        const next = greetings.filter(g => g.id !== id);
        setGreetings(next);
        saveGreetings(next);
    };
    const hasGreetings = greetings.some(g => g.text.trim());
    const openingSource = char.dateOpeningSource || 'generate';

    const saveLength = () => {
        const min = toNumber(minDraft);
        const max = toNumber(maxDraft);
        const prev = char.dateResponseLength || {};
        if (min === prev.min && max === prev.max) return;
        updateCharacter(char.id, { dateResponseLength: min || max ? { ...(min ? { min } : {}), ...(max ? { max } : {}) } : undefined });
    };
    const lengthPreview = describeLength({ min: toNumber(minDraft), max: toNumber(maxDraft) });

    return (
        <>
            <Section title="劇情大綱 (Scenario)">
                <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">這次見面想往哪走：地點、背景、正在發生的事。角色會照著方向寫，細節自己發揮。用自訂預設時填進預設的「場景」位置。</p>
                <textarea
                    value={scenario}
                    onChange={e => setScenario(e.target.value)}
                    onBlur={saveScenario}
                    rows={5}
                    placeholder="例：雨夜，兩人被困在打烊的書店裡，{{char}}其實早就認出了{{user}}……"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y"
                />
                <p className="text-[10px] text-slate-300 mt-1">點別處會自動保存；清空就不帶大綱。</p>
            </Section>

            <Section title="開場白 (Greetings)">
                <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">寫好幾段開場，感知頁可以選「用開場白」，每次隨機挑一段，重新感知就換一段。可以用 {'{{char}}'}、{'{{user}}'}。赴約那次還是讓模型寫，才接得上邀約。</p>
                <div className="space-y-3">
                    {greetings.map((g, i) => (
                        <div key={g.id} className="relative">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-[11px] font-bold text-slate-500">開場白 {i + 1}</span>
                                <button onClick={() => removeGreeting(g.id)} aria-label={`刪除開場白 ${i + 1}`} className="text-[11px] text-slate-300 hover:text-red-400">刪除</button>
                            </div>
                            <textarea
                                value={g.text}
                                onChange={e => editGreeting(g.id, e.target.value)}
                                onBlur={() => saveGreetings(greetings)}
                                rows={4}
                                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary/30 resize-y"
                            />
                        </div>
                    ))}
                </div>
                <button onClick={addGreeting} className="mt-3 w-full py-2.5 border border-dashed border-primary/40 text-primary text-sm font-bold rounded-xl active:scale-95">+ 新增開場白</button>
                {hasGreetings && (
                    <div className="mt-4 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-slate-500 font-bold">預設開場</span>
                        <div role="radiogroup" aria-label="預設開場" className="flex rounded-full bg-slate-100 p-1 text-xs">
                            {([['generate', '模型寫'], ['greeting', '用開場白']] as const).map(([value, label]) => (
                                <button key={value} role="radio" aria-checked={openingSource === value}
                                    onClick={() => updateCharacter(char.id, { dateOpeningSource: value })}
                                    className={`rounded-full px-3 py-1 transition ${openingSource === value ? 'bg-white text-primary font-bold shadow-sm' : 'text-slate-400'}`}>
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </Section>

            <Section title="回應字數 (Length)">
                <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">每輪正文大概寫多長，只填一邊也可以。自訂預設裡有讀字數的變數（像「字数总要求」）就直接蓋過去，沒有才另外補一句。</p>
                <div className="flex items-center gap-2">
                    <input type="number" inputMode="numeric" min={1} value={minDraft} onChange={e => setMinDraft(e.target.value)} onBlur={saveLength} placeholder="最少" aria-label="最少字數"
                        className="w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary/30" />
                    <span className="text-slate-300">–</span>
                    <input type="number" inputMode="numeric" min={1} value={maxDraft} onChange={e => setMaxDraft(e.target.value)} onBlur={saveLength} placeholder="最多" aria-label="最多字數"
                        className="w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary/30" />
                    <span className="text-xs text-slate-400">字</span>
                </div>
                <p className="text-[10px] text-slate-300 mt-1">{lengthPreview ? `會跟模型說：大約 ${lengthPreview}` : '不填就不限制'}</p>
            </Section>
        </>
    );
};

export default DateStoryExtras;
