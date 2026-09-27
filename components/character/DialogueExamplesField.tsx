import React, { useState } from 'react';
import { Plus, Scissors, X } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, FixedLine } from '../../types';
import {
    clampExamplesCutoff, DEFAULT_EXAMPLES_CUTOFF, EXAMPLES_CUTOFF_MAX, EXAMPLES_CUTOFF_MIN, EXAMPLES_MIN_WINDOW,
    extractDialogueExamples, type ExtractedExamples,
} from '../../utils/dialogueExamples';
import { trackEvent } from '../../utils/analytics';
import { FIXED_LINES_MAX, newFixedLineId, normalizeFixedLines } from '../../utils/fixedLines';

type Patch = Partial<Pick<CharacterProfile, 'systemPrompt' | 'dialogueExamples' | 'dialogueExamplesCutoff' | 'dialogueExamplesAlways' | 'fixedLines'>>;

interface Props {
    char: CharacterProfile;
    apiConfig: APIConfig;
    onChange: (patch: Patch) => void;
    addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
}

/**
 * 神經鏈接 · 角色編輯頁的「對話範例」（見 utils/dialogueExamples.ts）：
 * 範例欄、聊到幾則之後不再附上、一直附上；底下的固定台詞清單（見 utils/fixedLines.ts）；
 * 和「從核心指令拆出」（範例和固定台詞分開搬，先給用戶看、確認了才搬）。
 */
const DialogueExamplesField: React.FC<Props> = ({ char, apiConfig, onChange, addToast }) => {
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<ExtractedExamples | null>(null);
    const [cutoffDraft, setCutoffDraft] = useState<string | null>(null);
    const value = char.dialogueExamples || '';
    const always = !!char.dialogueExamplesAlways;
    const cutoff = clampExamplesCutoff(char.dialogueExamplesCutoff);
    const lines = char.fixedLines || [];
    // 編輯中允許空白行（剛按「新增」還沒填），存檔時才由 normalizeFixedLines 清掉空的
    const setLines = (next: FixedLine[]) => onChange({ fixedLines: next.length ? next : undefined });
    const updateLine = (id: string, patch: Partial<FixedLine>) => setLines(lines.map(l => (l.id === id ? { ...l, ...patch } : l)));

    const handleExtract = async () => {
        if (busy) return;
        if (!char.systemPrompt?.trim()) { addToast('核心指令是空的，沒有東西可以拆', 'info'); return; }
        setBusy(true);
        try {
            const result = await extractDialogueExamples(char.systemPrompt, apiConfig);
            if (!result.found && !result.fixedFound) {
                addToast(result.missed ? 'AI 找到的段落跟原文對不上，這次沒有動人設，可以再試一次' : '核心指令裡沒找到對話範例或固定台詞', 'info');
                return;
            }
            setPreview(result);
        } catch (e: any) {
            addToast(e?.message || '拆分失敗', 'error');
        } finally {
            setBusy(false);
        }
    };

    const applyPreview = () => {
        if (!preview) return;
        const patch: Patch = { systemPrompt: preview.persona };
        if (preview.found) patch.dialogueExamples = value.trim() ? `${value.trim()}\n\n${preview.examples}` : preview.examples;
        if (preview.fixedFound) patch.fixedLines = normalizeFixedLines([...lines, ...preview.fixedLines]);
        onChange(patch);
        trackEvent('拆出对话范例');
        addToast([
            preview.found ? `${preview.found} 段範例` : '',
            preview.fixedFound ? `${preview.fixedFound} 句固定台詞` : '',
        ].filter(Boolean).join('、') + ' 已搬過去', 'success');
        setPreview(null);
    };

    const commitCutoff = () => {
        if (cutoffDraft === null) return;
        const n = Number(cutoffDraft);
        const next = clampExamplesCutoff(Number.isFinite(n) && cutoffDraft.trim() ? n : DEFAULT_EXAMPLES_CUTOFF);
        onChange({ dialogueExamplesCutoff: next === DEFAULT_EXAMPLES_CUTOFF ? undefined : next });
        setCutoffDraft(null);
    };

    return (
        <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">對話範例 (Dialogue Examples)</label>
                <button
                    type="button"
                    onClick={handleExtract}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1 text-[11px] font-bold text-white active:scale-95 disabled:opacity-50"
                >
                    <Scissors size={12} weight="bold" /> {busy ? '找範例中…' : '從核心指令拆出'}
                </button>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                寫幾段 TA 說話的示範，可以用 {'{{char}}'}、{'{{user}}'}。送給 AI 時會標成「口吻示範、不是發生過的事」，AI 就不會照抄句子或當成真的記憶。
            </p>
            <textarea
                value={value}
                onChange={e => onChange({ dialogueExamples: e.target.value })}
                className="w-full h-32 bg-white rounded-3xl p-5 text-sm shadow-sm resize-none focus:ring-1 focus:ring-primary/20 transition-all vr-reader-scroll"
                placeholder={'{{user}}：週末要不要去看電影？\n{{char}}：……看什麼。'}
            />
            {value.trim() && (
                <div className="mt-2 rounded-3xl bg-white px-5 py-4 shadow-sm space-y-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <div className="text-[13px] font-bold text-slate-700">一直附上</div>
                            <div className="text-[11px] leading-relaxed text-slate-400">不管聊了多久，每輪都把範例送給 AI</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={always}
                            aria-label="一直附上對話範例"
                            onClick={() => onChange({ dialogueExamplesAlways: !always || undefined })}
                            className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${always ? 'bg-slate-800' : 'bg-slate-200'}`}
                        >
                            <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${always ? 'translate-x-5' : ''}`} />
                        </button>
                    </div>
                    {!always && (
                        <div>
                            <div className="flex items-center gap-2 text-[13px] font-bold text-slate-700">
                                <span>私聊聊到</span>
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min={EXAMPLES_CUTOFF_MIN}
                                    max={EXAMPLES_CUTOFF_MAX}
                                    aria-label="聊到幾則之後不再附上範例"
                                    value={cutoffDraft ?? String(cutoff)}
                                    onChange={e => setCutoffDraft(e.target.value)}
                                    onBlur={commitCutoff}
                                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                    className="w-16 rounded-xl bg-slate-50 px-2 py-1 text-center text-[13px] outline-none focus:ring-1 focus:ring-primary/30"
                                />
                                <span>則之後不再附上</span>
                            </div>
                            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                                聊久了，聊天記錄裡全是 TA 自己的原話，那才是最好的範例，就不用再多付一份 token（{EXAMPLES_CUTOFF_MIN}～{EXAMPLES_CUTOFF_MAX}，預設 {DEFAULT_EXAMPLES_CUTOFF}）。每輪帶的聊天記錄少於 {EXAMPLES_MIN_WINDOW} 則時會一直附上；見面、通話等其他地方照舊附上。
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* 固定台詞 */}
            <div className="mt-4">
                <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block mb-1.5">固定台詞 (Fixed Lines)</label>
                <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                    同人卡的經典對白：對方說了左邊那句，TA 這一輪就原樣說出右邊那句，一字不改（簡繁、標點、空白不計，但句子要大致一樣）。左邊不填就是招牌台詞，劇情合適時說。跟範例不同，聊多久都在。
                </p>
                <div className="space-y-2">
                    {lines.map(line => (
                        <div key={line.id} className="flex items-start gap-2 rounded-3xl bg-white p-3 shadow-sm">
                            <div className="min-w-0 flex-1 space-y-1.5">
                                <input
                                    value={line.trigger || ''}
                                    onChange={e => updateLine(line.id, { trigger: e.target.value })}
                                    aria-label="對方說"
                                    placeholder="對方說（不填＝招牌台詞）"
                                    className="w-full rounded-xl bg-slate-50 px-3 py-2 text-[13px] outline-none focus:ring-1 focus:ring-primary/30"
                                />
                                <input
                                    value={line.reply}
                                    onChange={e => updateLine(line.id, { reply: e.target.value })}
                                    aria-label="TA 回"
                                    placeholder="TA 回（一字不改）"
                                    className="w-full rounded-xl bg-slate-50 px-3 py-2 text-[13px] font-bold text-slate-700 outline-none focus:ring-1 focus:ring-primary/30"
                                />
                            </div>
                            <button type="button" aria-label="刪除這句固定台詞" onClick={() => setLines(lines.filter(l => l.id !== line.id))}
                                className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100">
                                <X size={14} weight="bold" />
                            </button>
                        </div>
                    ))}
                </div>
                {lines.length < FIXED_LINES_MAX && (
                    <button type="button" onClick={() => setLines([...lines, { id: newFixedLineId(), reply: '' }])}
                        className="mt-2 flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-[12px] font-bold text-slate-600 shadow-sm active:scale-95">
                        <Plus size={12} weight="bold" /> 新增一句
                    </button>
                )}
            </div>

            {preview && (
                <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/30 p-4 sm:items-center" onClick={() => setPreview(null)}>
                    <div role="dialog" aria-label="確認搬移對話範例" className="w-full max-w-md rounded-[1.75rem] bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
                        <div className="text-[15px] font-bold text-slate-800">
                            找到{[preview.found ? ` ${preview.found} 段對話範例` : '', preview.fixedFound ? ` ${preview.fixedFound} 句固定台詞` : ''].filter(Boolean).join('、')}
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                            這些會從核心指令搬出來（原文一字不改）。核心指令 {(char.systemPrompt || '').length} 字 → {preview.persona.length} 字。
                            {preview.missed > 0 && ` 另有 ${preview.missed} 段跟原文對不上，沒有動。`}
                        </p>
                        <div className="mt-3 max-h-[45vh] overflow-y-auto space-y-3">
                            {preview.found > 0 && (
                                <div>
                                    <div className="mb-1 text-[11px] font-bold text-slate-500">→ 對話範例（學口吻、不照抄）</div>
                                    <pre className="whitespace-pre-wrap rounded-2xl bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600 font-sans">{preview.examples}</pre>
                                </div>
                            )}
                            {preview.fixedFound > 0 && (
                                <div>
                                    <div className="mb-1 text-[11px] font-bold text-slate-500">→ 固定台詞（一字不改）</div>
                                    <div className="space-y-1.5 rounded-2xl bg-slate-50 p-3 text-[12px] leading-relaxed text-slate-600">
                                        {preview.fixedLines.map(line => (
                                            <div key={line.id}>{line.trigger ? <>對方說「{line.trigger}」→ </> : <span className="text-slate-400">招牌台詞 · </span>}「{line.reply}」</div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="mt-4 flex gap-2">
                            <button type="button" onClick={() => setPreview(null)} className="flex-1 rounded-full bg-slate-100 py-2.5 text-[13px] font-bold text-slate-600 active:scale-95">取消</button>
                            <button type="button" onClick={applyPreview} className="flex-1 rounded-full bg-slate-800 py-2.5 text-[13px] font-bold text-white active:scale-95">搬過去</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DialogueExamplesField;
