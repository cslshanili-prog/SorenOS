import React, { useMemo, useState } from 'react';
import ExpandableTextarea from '../common/ExpandableTextarea';
import type { MeetingRegexScript } from '../../utils/meetingPreset/types';
import { parseStRegex, REGEX_PLACEMENT, runRegexScript } from '../../utils/meetingPreset/regex';

/**
 * 預設裡的一條正則（欄位照 SillyTavern 的 regex 擴充）：改名稱、查找、替換、作用範圍、套用時機，
 * 下面有個試跑框，貼一段文字看結果。改了立刻存（照預設管理頁那套延遲存檔）。
 */

type Mode = 'store' | 'display' | 'prompt' | 'both';

const MODES: { mode: Mode; label: string; hint: string }[] = [
    { mode: 'store', label: '改存下的原文', hint: '收到回覆時就改，存進記錄的是改過的' },
    { mode: 'display', label: '只改顯示', hint: '記錄不動，畫面上才換（美化、卡片多半是這種）' },
    { mode: 'prompt', label: '只改送出', hint: '記錄不動，送給模型的歷史才換（省 token、藏思維鏈）' },
    { mode: 'both', label: '顯示和送出', hint: '記錄不動，畫面和送出都換' },
];

const modeOf = (script: MeetingRegexScript): Mode =>
    script.markdownOnly && script.promptOnly ? 'both' : script.markdownOnly ? 'display' : script.promptOnly ? 'prompt' : 'store';

const modePatch = (mode: Mode): Pick<MeetingRegexScript, 'markdownOnly' | 'promptOnly'> => ({
    markdownOnly: mode === 'display' || mode === 'both',
    promptOnly: mode === 'prompt' || mode === 'both',
});

export const newMeetingRegexScript = (): MeetingRegexScript => ({
    id: `rx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    scriptName: '新的正則',
    findRegex: '',
    replaceString: '',
    trimStrings: [],
    placement: [REGEX_PLACEMENT.aiOutput],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
});

const fieldClass = 'w-full px-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-[13px] font-mono leading-relaxed outline-none focus:border-slate-300 select-text';
const label = (text: string) => <span className="block text-[11px] font-bold text-slate-400 mb-1">{text}</span>;

const MeetingRegexEditor: React.FC<{
    script: MeetingRegexScript;
    onChange: (next: MeetingRegexScript) => void;
    onDelete: () => void;
    onClose: () => void;
}> = ({ script, onChange, onDelete, onClose }) => {
    const [sample, setSample] = useState('');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const patch = (p: Partial<MeetingRegexScript>) => onChange({ ...script, ...p });
    const invalid = !!script.findRegex.trim() && !parseStRegex(script.findRegex);
    const mode = modeOf(script);
    const preview = useMemo(
        () => (sample ? runRegexScript({ ...script, disabled: false }, sample, { charName: '角色', userName: '你', vars: {}, globalVars: {} }) : ''),
        [sample, script],
    );
    const togglePlacement = (value: number) => {
        const has = script.placement.includes(value);
        patch({ placement: has ? script.placement.filter(p => p !== value) : [...script.placement, value].sort() });
    };
    const depthValue = (value: string): number | null => (value.trim() === '' ? null : Math.max(0, Math.round(Number(value)) || 0));

    return (
        <div className="fixed inset-0 z-[310] bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="p-4 border-b border-slate-100 flex items-center gap-2">
                    <input value={script.scriptName} onChange={e => patch({ scriptName: e.target.value })} aria-label="正則名稱"
                        className="flex-1 min-w-0 font-bold text-slate-700 outline-none" />
                    <button onClick={onClose} className="text-sm text-primary font-bold px-2">完成</button>
                </div>
                <div className="p-4 space-y-4 overflow-y-auto">
                    <label className="block">
                        {label('查找（/正則/旗標，或直接寫要找的字）')}
                        <ExpandableTextarea title="尋找（正則）" mono value={script.findRegex} rows={3} onChange={v => patch({ findRegex: v })}
                            placeholder="/<thinking>[\s\S]*?<\/thinking>/g" className={`${fieldClass} resize-y ${invalid ? 'border-red-300' : ''}`} />
                        {invalid && <span className="text-[11px] text-red-500">這條正則寫法有錯，現在不會生效。</span>}
                    </label>
                    <label className="block">
                        {label('替換成（$1 是第一個括號、{{match}} 是整段；可以寫 HTML）')}
                        <ExpandableTextarea title="替換成" mono value={script.replaceString} rows={6} onChange={v => patch({ replaceString: v })}
                            className={`${fieldClass} resize-y`} />
                    </label>
                    <label className="block">
                        {label('從捕獲內容裡刪掉的字（一行一個，選填）')}
                        <textarea value={script.trimStrings.join('\n')} rows={2}
                            onChange={e => patch({ trimStrings: e.target.value.split('\n').filter(line => line !== '') })}
                            className={`${fieldClass} resize-y`} />
                    </label>

                    <div>
                        {label('作用在')}
                        <div className="flex gap-2">
                            {([[REGEX_PLACEMENT.userInput, '用戶輸入'], [REGEX_PLACEMENT.aiOutput, 'AI 輸出']] as const).map(([value, text]) => (
                                <button key={value} type="button" role="checkbox" aria-checked={script.placement.includes(value)} onClick={() => togglePlacement(value)}
                                    className={`px-3 py-1.5 rounded-full text-xs font-bold ${script.placement.includes(value) ? 'bg-primary text-white' : 'bg-slate-100 text-slate-500'}`}>{text}</button>
                            ))}
                        </div>
                    </div>

                    <div>
                        {label('什麼時候改')}
                        <div className="grid grid-cols-2 gap-2">
                            {MODES.map(option => (
                                <button key={option.mode} type="button" role="radio" aria-checked={mode === option.mode} onClick={() => patch(modePatch(option.mode))}
                                    className={`rounded-xl border px-3 py-2 text-left transition ${mode === option.mode ? 'border-primary bg-primary/5' : 'border-slate-100 bg-slate-50'}`}>
                                    <span className={`block text-xs font-bold ${mode === option.mode ? 'text-primary' : 'text-slate-600'}`}>{option.label}</span>
                                    <span className="block text-[10px] leading-snug text-slate-400 mt-0.5">{option.hint}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                            {label('最小深度')}
                            <input type="number" min={0} value={script.minDepth ?? ''} placeholder="不限" onChange={e => patch({ minDepth: depthValue(e.target.value) })} className={fieldClass} />
                        </label>
                        <label className="block">
                            {label('最大深度')}
                            <input type="number" min={0} value={script.maxDepth ?? ''} placeholder="不限" onChange={e => patch({ maxDepth: depthValue(e.target.value) })} className={fieldClass} />
                        </label>
                    </div>
                    <p className="-mt-2 text-[10px] leading-relaxed text-slate-400">深度 0 是最新的一則，1 是前一則，以此類推。兩格都空就是每一則都改。</p>

                    <label className="flex items-center justify-between gap-3">
                        <span className="text-[13px] text-slate-600">編輯訊息後也跑</span>
                        <input type="checkbox" checked={script.runOnEdit} onChange={e => patch({ runOnEdit: e.target.checked })} className="h-4 w-4 accent-slate-700" />
                    </label>

                    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 space-y-2">
                        {label('試跑（貼一段模型的回覆看看）')}
                        <textarea value={sample} rows={4} onChange={e => setSample(e.target.value)} placeholder="貼一段文字…"
                            className={`${fieldClass} bg-white resize-y`} />
                        {sample && (
                            <>
                                <span className="block text-[11px] font-bold text-slate-400">結果{preview === sample ? '（沒有變化，查找沒對上）' : ''}</span>
                                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl bg-white p-3 text-[12px] leading-relaxed text-slate-600 select-text">{preview}</pre>
                            </>
                        )}
                    </div>

                    {confirmDelete ? (
                        <div className="flex gap-2">
                            <button onClick={() => setConfirmDelete(false)} className="flex-1 py-2.5 rounded-xl bg-slate-100 text-sm font-bold text-slate-500">留著</button>
                            <button onClick={onDelete} className="flex-1 py-2.5 rounded-xl bg-red-500 text-sm font-bold text-white">確定刪除</button>
                        </div>
                    ) : (
                        <button onClick={() => setConfirmDelete(true)} className="w-full py-2.5 rounded-xl border border-red-100 text-sm font-bold text-red-500">刪除這條正則</button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default MeetingRegexEditor;
