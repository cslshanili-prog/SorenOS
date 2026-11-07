import React, { useEffect, useState } from 'react';
import type { CharacterProfile, DateStory, DateStoryTime } from '../../types';
import { patchDateStory } from '../../utils/dateStory';
import { formatStoryClock, makeDateClock } from '../../utils/dateStoryTime';
import { nowInTimeZone, resolveCharTimeZone } from '../../utils/timezone';

// 見面設定的「時間」：真實／自定義 × 流動／靜止（utils/dateStoryTime.ts）。
// 進行中的故事改這場的，從改的那一刻起算；沒有就是下一場的，開新故事時從故事開始那一刻起算。

interface Props {
    char: CharacterProfile;
    story: DateStory | null;
    updateCharacter: (id: string, patch: Partial<CharacterProfile>) => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }>;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 角色那邊此刻的牆上時間，給自定義欄位當起點 */
const charWallNow = (tz?: string) => {
    const d = nowInTimeZone(tz, new Date());
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const DateStoryTimeSettings: React.FC<Props> = ({ char, story, updateCharacter, addToast, Section }) => {
    const tz = resolveCharTimeZone(char);
    const saved: DateStoryTime = (story ? story.time : char.dateNextStoryTime) || { source: 'real', flow: 'flowing' };
    const [customDraft, setCustomDraft] = useState(saved.customStart || '');
    useEffect(() => { setCustomDraft(saved.customStart || ''); }, [char.id, story?.id, saved.customStart]);
    // 預覽每 30 秒走一次
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(t); }, []);

    const save = (next: DateStoryTime) => {
        const value: DateStoryTime | undefined = next.source === 'real' && next.flow === 'flowing' ? undefined : next;
        if (story) void patchDateStory(story.id, { time: value ? { ...value, anchorAt: Date.now() } : undefined });
        else updateCharacter(char.id, { dateNextStoryTime: value });
    };
    const setSource = (source: DateStoryTime['source']) => {
        if (source === saved.source) return;
        const customStart = source === 'custom' ? (saved.customStart || charWallNow(tz)) : saved.customStart;
        save({ ...saved, source, customStart });
    };
    const setFlow = (flow: DateStoryTime['flow']) => { if (flow !== saved.flow) save({ ...saved, flow }); };
    const saveCustom = () => {
        if (!customDraft || customDraft === saved.customStart) return;
        save({ ...saved, customStart: customDraft });
        addToast('故事時間已更新', 'success');
    };

    const preview = makeDateClock(char, story ? { ...story, time: saved.source === 'real' && saved.flow === 'flowing' ? undefined : { ...saved, anchorAt: saved.anchorAt } } : null)
        ?? { now: Date.now() };
    const segment = <T extends string>(value: T, options: readonly (readonly [T, string])[], onPick: (v: T) => void, label: string) => (
        <div role="radiogroup" aria-label={label} className="flex rounded-full bg-slate-100 p-1 text-xs w-fit">
            {options.map(([v, text]) => (
                <button key={v} role="radio" aria-checked={value === v} onClick={() => onPick(v)}
                    className={`rounded-full px-3 py-1 transition ${value === v ? 'bg-white text-primary font-bold shadow-sm' : 'text-slate-400'}`}>{text}</button>
            ))}
        </div>
    );

    return (
        <Section title="時間 (Time)">
            <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">{story ? '這場故事' : '下一場故事'}裡是幾點。自定義的時間是{char.name}那邊的時間。</p>
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-slate-500 font-bold">時間來源</span>
                    {segment(saved.source, [['real', '真實'], ['custom', '自定義']] as const, setSource, '時間來源')}
                </div>
                {saved.source === 'custom' && (
                    <input type="datetime-local" value={customDraft} onChange={e => setCustomDraft(e.target.value)} onBlur={saveCustom} aria-label="故事裡的時間"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-primary/30" />
                )}
                <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-slate-500 font-bold">時間</span>
                    {segment(saved.flow, [['flowing', '流動'], ['frozen', '靜止']] as const, setFlow, '時間流動')}
                </div>
                <p className="text-[10px] text-slate-400 leading-relaxed" data-story-clock>
                    {saved.source === 'real' && saved.flow === 'flowing' && '跟著現實時間走（原本的樣子）。'}
                    {saved.source === 'real' && saved.flow === 'frozen' && (story ? '停在切換的那一刻：' : '停在故事開始那一刻。')}
                    {saved.source === 'custom' && saved.flow === 'flowing' && (story ? '從填的時間起，跟著現實往前走：' : '故事開始時從填的時間起，跟著現實往前走。')}
                    {saved.source === 'custom' && saved.flow === 'frozen' && '停在填的時間：'}
                    {(story || saved.source === 'custom') && !(saved.source === 'real' && saved.flow === 'flowing') && (
                        <span className="font-bold text-slate-500"> 故事裡現在是 {formatStoryClock(preview, tz)}</span>
                    )}
                </p>
                {char.dateTimeAwarenessEnabled === false && <p className="text-[10px] text-amber-500">這個角色關了「線下時間感知」，見面的提示詞不帶時間，這裡的設定不會生效。</p>}
            </div>
        </Section>
    );
};

export default DateStoryTimeSettings;
