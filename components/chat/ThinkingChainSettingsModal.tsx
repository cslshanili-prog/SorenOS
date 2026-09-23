import React, { useEffect, useMemo, useState } from 'react';
import { THINKING_CHAIN_PRESETS, resolveThinkingChainStyle, PsycheDecor, ThinkingChainStyleId } from './MessageItem';
import { validateScopedCss } from '../../utils/scopedCss';

interface ThinkingChainSettingsValue {
    enabled: boolean;
    styleId: ThinkingChainStyleId;
    customColors: { bg: string; accent: string; text: string };
    customPrompt: string;
    /** 疊加在任意風格之上的自定義 CSS，選擇器限定 .sully-psyche 開頭 */
    customCss: string;
}

// 心象卡片自定義 CSS 的作用域白名單（.sully-psyche 及其 -card/-title/-preview/-body 子類）
const PSYCHE_SELECTOR_REGEX = /^\.sully-psyche\b/;
const PSYCHE_SCOPE_HINT = '.sully-psyche / .sully-psyche-card / -title / -preview / -body';

const PSYCHE_CSS_EXAMPLE = `.sully-psyche-card {
  background: linear-gradient(135deg, #1a1a2e, #16213e) !important;
  border: 1px solid rgba(233, 69, 96, 0.5) !important;
  border-radius: 16px !important;
}
.sully-psyche-title {
  color: #e94560 !important;
  letter-spacing: 0.6em !important;
}
.sully-psyche-body {
  color: #f0f0f0 !important;
}`;

interface Props {
    isOpen: boolean;
    onClose: () => void;
    value: ThinkingChainSettingsValue;
    onChange: (next: Partial<ThinkingChainSettingsValue>) => void;
}

const SAMPLE_CHAIN = '又叫乖乖貓咪……煩死了。算了也沒那麼煩，比起這個——午飯吃沒吃？她又拿力學所當藉口，呵，老一套。算了，先罵一句再問。';

const STYLE_LIST: Array<{ id: ThinkingChainStyleId; name: string; sub: string }> = [
    { id: 'echo',     name: '心象',  sub: '暗紫 × 暖金，二次元卡牌' },
    { id: 'whisper',  name: '心聲',  sub: '羊皮紙暖色，私密日記' },
    { id: 'minimal',  name: '極簡',  sub: '純白單色，OOC 調試視圖' },
    { id: 'ink',      name: '墨跡',  sub: '宣紙朱印，水墨卷軸' },
    { id: 'neon',     name: '腦域',  sub: '賽博青光，神經接駁' },
    { id: 'terminal', name: '內核',  sub: '黑底綠字，終端日誌' },
    { id: 'stellar',  name: '星語',  sub: '深空夜藍，綴星獨白' },
    { id: 'tama',     name: '心寵',  sub: '拓麻歌子，液晶點陣屏' },
    { id: 'pixel',    name: '像素',  sub: 'JRPG 對話框，硬影粗框' },
    { id: 'muji',     name: '素淨',  sub: '性冷淡暖灰，大片留白' },
    { id: 'ins',      name: 'ins',   sub: '白卡軟影，feed 碎碎念' },
    { id: 'custom',   name: '自定',  sub: '三色調教，配你自己的味' },
];

const ColorField: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
    <label className="flex items-center gap-3 text-[12px]">
        <span className="w-12 text-slate-500 shrink-0">{label}</span>
        <input
            type="color"
            value={value.startsWith('#') ? value : '#1f2937'}
            onChange={e => onChange(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer border border-slate-200"
        />
        <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            className="flex-1 px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] font-mono focus:outline-none focus:border-indigo-300"
            placeholder="#rrggbb 或 css 漸變"
        />
    </label>
);

// 摺疊態 + 展開態的迷你預覽，用 resolveThinkingChainStyle 渲染，避免重複樣式邏輯
const StylePreview: React.FC<{ styleId: ThinkingChainStyleId; customColors: ThinkingChainSettingsValue['customColors']; compact?: boolean }> = ({ styleId, customColors, compact }) => {
    const spec = resolveThinkingChainStyle(styleId, customColors);
    return (
        <div className="sully-psyche relative">
        <div
            className="sully-psyche-card relative overflow-hidden"
            style={{
                background: spec.bg,
                border: `${spec.borderWidth || '1px'} solid ${spec.border}`,
                borderRadius: spec.radius,
                boxShadow: spec.cardShadow,
                padding: compact ? '6px 8px' : '10px 12px',
            }}
        >
            {spec.showCorners && (
                <>
                    <span aria-hidden className="absolute top-1 left-1 w-1.5 h-1.5 border-t border-l" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute top-1 right-1 w-1.5 h-1.5 border-t border-r" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute bottom-1 left-1 w-1.5 h-1.5 border-b border-l" style={{ borderColor: spec.accent }} />
                    <span aria-hidden className="absolute bottom-1 right-1 w-1.5 h-1.5 border-b border-r" style={{ borderColor: spec.accent }} />
                </>
            )}
            <div className="relative flex items-center gap-1.5">
                <span className="sully-psyche-title" style={{ color: spec.accent, fontSize: compact ? 9 : 11, letterSpacing: '0.3em', fontFamily: spec.fontFamily, fontWeight: 600 }}>
                    {spec.titleZh}
                </span>
                <span style={{ color: spec.text, opacity: 0.6, fontSize: compact ? 6 : 7, letterSpacing: '0.25em' }}>
                    {spec.titleEn}
                </span>
            </div>
            {!compact && (
                <div
                    className={`sully-psyche-preview mt-1 truncate ${spec.italic ? 'italic' : ''}`}
                    style={{ color: spec.text, fontFamily: spec.fontFamily, fontSize: 10.5 }}
                >
                    <span style={{ color: spec.accent }}>{spec.quoteLeft}</span>
                    {SAMPLE_CHAIN.slice(0, 24)}…
                    <span style={{ color: spec.accent }}>{spec.quoteRight}</span>
                    {spec.decoKind === 'termHud' && <span className="animate-pulse" style={{ color: spec.accent, marginLeft: 2 }}>▊</span>}
                </div>
            )}
            {spec.overlay === 'scanlines' && (
                <div
                    aria-hidden
                    className="absolute inset-0 pointer-events-none opacity-[0.13]"
                    style={{ background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(94, 234, 212, 0.6) 3px, transparent 4px)' }}
                />
            )}
            {spec.overlay === 'dotMatrix' && (
                <div
                    aria-hidden
                    className="absolute inset-0 pointer-events-none opacity-[0.18]"
                    style={{ background: 'radial-gradient(rgba(60, 80, 40, 0.55) 0.5px, transparent 0.6px)', backgroundSize: '3px 3px' }}
                />
            )}
        </div>
        {/* 破格裝飾：渲染在卡片外層，跟聊天裡的真實結構一致 */}
        <PsycheDecor spec={spec} compact={compact} />
        </div>
    );
};

const ThinkingChainSettingsModal: React.FC<Props> = ({ isOpen, onClose, value, onChange }) => {
    const [draftPrompt, setDraftPrompt] = useState(value.customPrompt || '');
    const [draftCss, setDraftCss] = useState(value.customCss || '');
    useEffect(() => { if (isOpen) setDraftPrompt(value.customPrompt || ''); }, [isOpen, value.customPrompt]);
    useEffect(() => { if (isOpen) setDraftCss(value.customCss || ''); }, [isOpen, value.customCss]);
    const cssValidation = useMemo(
        () => validateScopedCss(draftCss, PSYCHE_SELECTOR_REGEX, PSYCHE_SCOPE_HINT),
        [draftCss],
    );
    if (!isOpen) return null;

    const commitPrompt = () => onChange({ customPrompt: draftPrompt });
    // 有語法/作用域問題的 CSS 不落庫（避免壞樣式外溢到聊天頁），但草稿保留在輸入框裡
    const commitCss = () => { if (cssValidation.isValid) onChange({ customCss: draftCss }); };

    return (
        <div
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-[1px]"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl max-h-[85vh] overflow-y-auto no-scrollbar shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="sticky top-0 z-10 bg-white px-5 pt-5 pb-3 border-b border-slate-100">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-bold text-slate-800">心象 · 設置</h2>
                            <p className="text-[11px] text-slate-400 mt-0.5">關於「心象」卡片的所有調教都在這裡</p>
                        </div>
                        <button
                            onClick={() => { commitPrompt(); commitCss(); onClose(); }}
                            className="text-[12px] font-bold text-indigo-500 active:scale-95 transition"
                        >
                            完成
                        </button>
                    </div>
                </div>

                <div className="p-5 space-y-6">
                    {/* 0. 這是什麼 / 看不見怎麼辦 */}
                    <section className="rounded-2xl bg-amber-50/70 border border-amber-200/70 px-3.5 py-3 text-[11px] leading-[1.7] text-slate-600">
                        <div className="font-bold text-amber-700 mb-1 text-[11.5px]">⚠ 先看這裡：「心象」到底是什麼</div>
                        <p>
                            這是 AI 模型**自己原生輸出的思考鏈**——模型自帶的思考過程。
                        </p>
                        <p className="mt-2">
                            正因如此——**它的本質決定了它不會像角色台詞那樣鮮活**，更像看一個演員在化妝間的喃喃自語，而不是舞台上的台詞。這個功能本來就是給"喜歡看大模型思維鏈"的用戶準備的彩蛋，**不一定適合每個人**。
                        </p>
                        <p className="mt-2">
                            還有一點同樣由這個本質決定:思維鏈**不進入上下文**,也**不會成為角色真實回覆的一部分**——它只反映當前模型這一輪的思考瞬間。所以**下一輪,角色不會記得自己上一輪在想什麼**,ta 只會基於真正發出去的那段回覆(以及對話歷史)往下走。
                        </p>
                        <p className="mt-2">
                            如果你看到思考鏈覺得跳戲 / 影響沉浸感 / 覺得太"AI"——直接關掉就好，不會有任何損失，角色回覆本身完全不受影響。
                        </p>
                        <p className="mt-2 text-slate-500">看不太懂上面在說啥？去問給你 API 的人，他/她會比這裡講得清楚。</p>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">開了但沒看到「心象」卡片？</div>
                            <ul className="list-disc pl-4 space-y-0.5">
                                <li><b>你的模型不帶思考鏈</b> → 請問你 API 提供者哪些模型支持 thinking，或自己查找</li>
                                <li><b>這一輪模型沒思考</b>（短回覆 / 模型自己判斷不需要） → 正常現象，下一輪可能就有</li>
                                <li><b>代理拒絕轉發 thinking 字段</b> → 跟 API 提供方確認對應模型是否啟用了 extended thinking</li>
                            </ul>
                        </div>
                        <div className="mt-2.5 pt-2.5 border-t border-amber-200/60">
                            <div className="font-bold text-amber-700 mb-1 text-[11.5px]">思考鏈一直是英文怎麼辦？</div>
                            <p>
                                這通常**不是模型本身的問題**——同一個模型走官方渠道（Anthropic / OpenAI / 智譜直連等）能正常保持中文，是中轉 API 把 system prompt 截短或改寫造成的。可以試：
                            </p>
                            <ul className="list-disc pl-4 space-y-0.5 mt-1">
                                <li>下面「追加提示詞」裡再加一條肘擊：「thinking 必須中文，禁止英文」</li>
                                <li>直接在聊天裡跟角色說一句「用中文想」</li>
                                <li>換一個跑得動官克的渠道</li>
                            </ul>
                        </div>
                    </section>

                    {/* 1. 總開關 */}
                    <section>
                        <div className="flex items-center justify-between cursor-pointer" onClick={() => onChange({ enabled: !value.enabled })}>
                            <div>
                                <div className="text-[13px] font-bold text-slate-700">顯示思考過程</div>
                                <div className="text-[10.5px] text-slate-400 mt-0.5">關閉后角色回覆不再帶「心象」卡片，已存的舊消息保留。</div>
                            </div>
                            <div className={`shrink-0 ml-3 w-10 h-6 rounded-full p-1 transition-colors flex items-center ${value.enabled ? 'bg-indigo-500' : 'bg-slate-200'}`}>
                                <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${value.enabled ? 'translate-x-4' : ''}`} />
                            </div>
                        </div>
                    </section>

                    {/* 2. 卡片風格 */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2.5">卡片風格</h3>
                        <div className="grid grid-cols-2 gap-2.5">
                            {STYLE_LIST.map(item => {
                                const active = value.styleId === item.id;
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => onChange({ styleId: item.id })}
                                        className={`text-left rounded-xl p-2 border transition-all ${active ? 'border-indigo-400 ring-2 ring-indigo-100' : 'border-slate-200 hover:border-slate-300'}`}
                                    >
                                        <StylePreview styleId={item.id} customColors={value.customColors} compact />
                                        <div className="mt-1.5 flex items-baseline gap-1.5">
                                            <span className="text-[12px] font-bold text-slate-700">{item.name}</span>
                                            <span className="text-[9.5px] text-slate-400">{item.sub}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {value.styleId === 'custom' && (
                            <div className="mt-3 p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                                <div className="text-[10.5px] font-bold text-slate-500 mb-1">三色調教</div>
                                <ColorField
                                    label="背景"
                                    value={value.customColors.bg}
                                    onChange={bg => onChange({ customColors: { ...value.customColors, bg } })}
                                />
                                <ColorField
                                    label="點綴"
                                    value={value.customColors.accent}
                                    onChange={accent => onChange({ customColors: { ...value.customColors, accent } })}
                                />
                                <ColorField
                                    label="正文"
                                    value={value.customColors.text}
                                    onChange={text => onChange({ customColors: { ...value.customColors, text } })}
                                />
                                <div className="text-[9.5px] text-slate-400 leading-relaxed mt-1.5">
                                    背景支持 CSS 漸變（例：linear-gradient(135deg, #1a1a2e, #16213e)）。
                                </div>
                            </div>
                        )}

                        {/* 實時大預覽（自定義 CSS 合法時同步作用到預覽上） */}
                        {cssValidation.isValid && draftCss.trim() && <style>{draftCss}</style>}
                        <div className="mt-3 px-1">
                            <div className="text-[9.5px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">實時預覽</div>
                            <StylePreview styleId={value.styleId} customColors={value.customColors} />
                        </div>
                    </section>

                    {/* 2.5 CSS 美化 —— 疊加在任意風格之上，機制同氣泡工坊 */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2">CSS 美化（進階）</h3>
                        <p className="text-[10.5px] text-slate-400 mb-2 leading-relaxed">
                            在上面選好的風格基礎上，再用 CSS 精修心象卡片。可用類名：
                            <code className="text-indigo-400">.sully-psyche-card</code>（卡片）、
                            <code className="text-indigo-400">.sully-psyche-title</code>（標題）、
                            <code className="text-indigo-400">.sully-psyche-preview</code>（摺疊首句）、
                            <code className="text-indigo-400">.sully-psyche-body</code>（展開正文）。
                            想覆蓋風格自帶的顏色時記得加 <code className="text-indigo-400">!important</code>。
                        </p>
                        <textarea
                            value={draftCss}
                            onChange={e => setDraftCss(e.target.value)}
                            onBlur={commitCss}
                            spellCheck={false}
                            placeholder={'.sully-psyche-card {\n  border-radius: 16px !important;\n}'}
                            className={`w-full h-32 bg-slate-50 rounded-xl p-3 text-[11px] font-mono resize-none border focus:outline-none ${cssValidation.isValid ? 'border-slate-200 focus:border-indigo-300' : 'border-red-300 focus:border-red-400'}`}
                        />
                        {!cssValidation.isValid && (
                            <div className="mt-1 space-y-0.5">
                                {cssValidation.errors.slice(0, 3).map((err, i) => (
                                    <div key={i} className="text-[9.5px] text-red-400 leading-relaxed">{err}</div>
                                ))}
                                <div className="text-[9px] text-slate-400">有錯誤時不會保存，修好後自動生效。</div>
                            </div>
                        )}
                        <div className="mt-1.5 flex items-center gap-2">
                            <button
                                onClick={() => setDraftCss(PSYCHE_CSS_EXAMPLE)}
                                className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition"
                            >
                                填入示例
                            </button>
                            {value.customCss && (
                                <button
                                    onClick={() => { setDraftCss(''); onChange({ customCss: '' }); }}
                                    className="text-[10px] px-2 py-1 rounded-lg bg-slate-100 text-slate-500 active:scale-95 transition"
                                >
                                    清空還原
                                </button>
                            )}
                            <span className="text-[9px] text-slate-300 ml-auto">留空 = 不做額外美化</span>
                        </div>
                    </section>

                    {/* 3. 追加提示詞 */}
                    <section>
                        <h3 className="text-[10.5px] font-bold text-slate-400 uppercase tracking-wider mb-2">追加提示詞</h3>
                        <p className="text-[10.5px] text-slate-400 mb-2 leading-relaxed">
                            原生提示詞（讓模型用角色第一人稱、中文意識流思考）保持不變；這裡寫的內容**追加在最後**作為「用戶對內心獨白的額外要求」。
                        </p>
                        <textarea
                            value={draftPrompt}
                            onChange={e => setDraftPrompt(e.target.value)}
                            onBlur={commitPrompt}
                            placeholder="比如：思考時偶爾切到日語 / 多寫一些感官細節 / 想到用戶時用暱稱…"
                            className="w-full h-28 bg-slate-50 rounded-xl p-3 text-[12px] resize-none border border-slate-200 focus:outline-none focus:border-indigo-300"
                        />
                        <div className="text-[9.5px] text-slate-400 mt-1">留空 = 僅使用原生提示詞。</div>
                    </section>
                </div>
            </div>
        </div>
    );
};

export default ThinkingChainSettingsModal;
export type { ThinkingChainSettingsValue };
