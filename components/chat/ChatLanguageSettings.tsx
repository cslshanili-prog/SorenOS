import React, { useState } from 'react';
import type { ChatLanguageConfig } from '../../types';
import { CHAT_LANGUAGES, MIX_LEVELS, isPresetLanguage, languageLabel, normalizeLanguage, resolveChatLanguage } from '../../utils/chatLanguage';
import { TRANSLATION_LANG_MAX_LENGTH } from '../../utils/translationLang';
import { Row, Toggle } from './ChatSettingsControls';

/**
 * 一排語言膠囊：最前面是「沒選」那顆（跟著人設／不夾雜／不翻譯），最後一顆「自訂」展開輸入框。
 * 選中的自訂語言會多一顆顯示出來。
 */
const LanguagePicker: React.FC<{
    label: string;
    hint: string;
    noneLabel: string;
    value?: string;
    exclude?: string;
    onChange: (v: string | undefined) => void;
}> = ({ label, hint, noneLabel, value, exclude, onChange }) => {
    const [customOpen, setCustomOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const custom = value && !isPresetLanguage(value) ? value : '';
    const chip = (active: boolean) => `px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${active ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`;
    const apply = () => {
        const v = normalizeLanguage(draft);
        if (!v) return;
        onChange(v);
        setDraft('');
        setCustomOpen(false);
    };
    return (
        <div className="px-5 py-4" data-language-picker={label}>
            <div className="text-[15px] font-bold text-slate-800">{label}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{hint}</div>
            <div className="mt-2.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
                <button type="button" role="radio" aria-checked={!value} onClick={() => onChange(undefined)} className={chip(!value)}>{noneLabel}</button>
                {CHAT_LANGUAGES.filter(l => l.value !== exclude).map(l => (
                    <button key={l.value} type="button" role="radio" aria-checked={value === l.value} onClick={() => onChange(l.value)} className={chip(value === l.value)}>
                        {l.label}
                    </button>
                ))}
                {custom && (
                    <button type="button" role="radio" aria-checked onClick={() => onChange(custom)} className={`${chip(true)} max-w-[10rem] truncate`} title={custom}>{custom}</button>
                )}
                <button type="button" onClick={() => setCustomOpen(v => !v)} className={chip(false)} aria-expanded={customOpen}>自訂…</button>
            </div>
            {customOpen && (
                <div className="mt-2 flex gap-1.5">
                    <input
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
                        maxLength={TRANSLATION_LANG_MAX_LENGTH}
                        placeholder="例如 Español、台語、上海話"
                        aria-label={`${label}（自訂）`}
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] text-slate-700 outline-none focus:border-slate-400"
                    />
                    <button type="button" onClick={apply} disabled={!normalizeLanguage(draft)}
                        className="shrink-0 rounded-xl bg-slate-800 px-3 py-2 text-[12px] font-bold text-white disabled:bg-slate-200 disabled:text-slate-400">
                        套用
                    </button>
                </div>
            )}
        </div>
    );
};

/** 聊天設定 ·「聊天語言」（plans/chat-language.md）。草稿由設定頁管，按「完成」才存。 */
const ChatLanguageSettings: React.FC<{ value: ChatLanguageConfig; onChange: (next: ChatLanguageConfig) => void }> = ({ value, onChange }) => {
    const r = resolveChatLanguage(value);
    const set = (patch: Partial<ChatLanguageConfig>) => onChange({ ...value, ...patch });
    const summary = (() => {
        if (!r.speak && !r.mix && !r.translateTo) return '沒有指定：TA 照人設說話，不翻譯。';
        const speak = r.speak ? `說${languageLabel(r.speak)}` : '照人設說話';
        const mix = r.mix ? `，夾雜${languageLabel(r.mix)}（${MIX_LEVELS.find(m => m.value === r.mixLevel)?.label}）` : '';
        const tr = r.translating ? `，翻成${languageLabel(r.translateTo)}給你看` : r.translateTo ? '，跟你讀的語言一樣，不用翻' : '';
        return `${speak}${mix}${tr}。`;
    })();
    const cantonese = [r.speak, r.mix, r.translateTo].some(v => v && /粵|粤|廣東話|cantonese/i.test(v));

    return (
        <section data-chat-language>
            <h2 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">聊天語言 (LANGUAGE)</h2>
            <div className="bg-white rounded-[1.75rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] divide-y divide-slate-100">
                <div className="px-5 py-3 text-[12px] leading-relaxed text-slate-500 bg-slate-50/60 rounded-t-[1.75rem]" data-chat-language-summary>{summary}</div>
                <LanguagePicker
                    label="角色說話語言"
                    hint="TA 主要用這個語言說話（七成以上）。不指定就照人設。"
                    noneLabel="跟著人設"
                    value={r.speak}
                    onChange={v => set({ speak: v })}
                />
                <LanguagePicker
                    label="夾雜第二語言"
                    hint="給雙語人設：說話時自然混用，像口頭禪、情緒上來、某些習慣用另一個語言講的詞。"
                    noneLabel="不夾雜"
                    value={r.mix}
                    exclude={r.speak}
                    onChange={v => set({ mix: v })}
                />
                {r.mix && (
                    <div className="px-5 py-4">
                        <div className="text-[15px] font-bold text-slate-800">混多少</div>
                        <div className="mt-2.5 grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="夾雜比例">
                            {MIX_LEVELS.map(m => (
                                <button key={m.value} type="button" role="radio" aria-checked={r.mixLevel === m.value} onClick={() => set({ mixLevel: m.value })}
                                    className={`rounded-2xl px-2 py-2 text-center transition-colors ${r.mixLevel === m.value ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                    <span className="block text-[12px] font-bold">{m.label}</span>
                                    <span className={`block mt-0.5 text-[10px] ${r.mixLevel === m.value ? 'text-white/70' : 'text-slate-400'}`}>{m.hint}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                <LanguagePicker
                    label="翻譯成"
                    hint="你讀的語言。TA 的訊息會多一份這個語言的譯文，點氣泡右下角的「翻譯」切換。"
                    noneLabel="不翻譯"
                    value={r.translateTo}
                    onChange={v => set({ translateTo: v })}
                />
                {r.translating && (
                    <Row label="原文與譯文同時展開" hint="不用逐條點，氣泡直接上下顯示兩種語言。">
                        <Toggle on={r.expanded} onToggle={() => set({ expanded: !r.expanded })} label="原文與譯文同時展開" />
                    </Row>
                )}
                {cantonese && (
                    <div className="px-5 py-3 text-[11px] leading-relaxed text-amber-700 bg-amber-50/60 rounded-b-[1.75rem]">
                        粵語會請 TA 用廣東話口語寫（係、唔、嘅）。
                    </div>
                )}
            </div>
        </section>
    );
};

export default ChatLanguageSettings;
