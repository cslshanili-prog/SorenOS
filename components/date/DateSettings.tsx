
import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, DateStyleConfig } from '../../types';
import { resolveUserProfileForChar } from '../../utils/userPersona';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import TokenImg from '../os/TokenImg';
import { DATE_STYLE_PRESETS } from '../../utils/datePrompts';

interface DateSettingsProps {
    char: CharacterProfile;
    onBack: () => void;
}

/** 可摺疊分區卡片：標題常駐，內容默認收起，點標題展開。用原生 <details> 省狀態。 */
const Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({ title, defaultOpen, children }) => (
    <details open={defaultOpen} className="group bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <summary className="list-none cursor-pointer select-none flex items-center justify-between gap-2 px-4 py-3.5 active:bg-slate-50 [&::-webkit-details-marker]:hidden">
            <h3 className="text-xs font-bold text-slate-400 uppercase">{title}</h3>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-slate-300 transition-transform group-open:rotate-180 shrink-0"><path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.168l3.71-3.938a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" /></svg>
        </summary>
        <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
);

const DateSettings: React.FC<DateSettingsProps> = ({ char, onBack }) => {
    const { updateCharacter, addToast, userProfileBase } = useOS();
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 文風與敘事（即時生效：system prompt 每次請求重建，存上就影響下一條回覆）
    const styleConfig = char.dateStyleConfig || {};
    const [extraDraft, setExtraDraft] = useState(styleConfig.extra || '');
    useEffect(() => { setExtraDraft(char.dateStyleConfig?.extra || ''); }, [char.id]);
    const patchStyleConfig = (patch: Partial<DateStyleConfig>) => {
        updateCharacter(char.id, { dateStyleConfig: { ...(char.dateStyleConfig || {}), ...patch } });
    };
    const saveExtraDraft = () => {
        const trimmed = extraDraft.trim();
        if (trimmed === (char.dateStyleConfig?.extra || '')) return;
        patchStyleConfig({ extra: trimmed || undefined });
        addToast(trimmed ? '補充要求已保存' : '補充要求已清空', 'success');
    };
    // 只是 POV 預覽文案裡的示例名字，跟見面走同一套「個人檔案 → 分角色身份指定」
    const userName = resolveUserProfileForChar(userProfileBase, char).name || '用戶';
    const POV_OPTIONS: { id: DateStyleConfig['pov']; label: string; example: string }[] = [
        { id: undefined, label: '默認', example: '不額外指定，隨模型發揮' },
        { id: 'third-name', label: '第三人稱 · 稱名字', example: `${char.name}看著${userName}` },
        { id: 'third-you', label: '第三人稱 · 稱"你"', example: `${char.name}看著你` },
        { id: 'first-you', label: '第一人稱', example: '我看著你' },
    ];

    const triggerUpload = () => fileInputRef.current?.click();

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            // 背景存 Blob：原畫質不重繪，二進制進 blob_assets，字段只存 blobref 令牌
            // （省 ~33% 空間、不佔 JS 堆）。參考 apps/Appearance.tsx 的壁紙上傳。
            const blob = await processImageToBlob(file, { skipCompression: true });
            const ref = await putImageBlob(blob);
            updateCharacter(char.id, { dateBackground: ref });
            addToast('背景已更新', 'success');
        } catch (e: any) {
            addToast(e.message, 'error');
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col" data-date-settings>
            {/* 頁首讓出狀態列：全螢幕 PWA 下返回箭頭會跟時間疊在一起、點不到 */}
            <div className="min-h-16 flex items-center justify-between px-4 pb-2 border-b border-slate-200 bg-white shrink-0 z-20" style={{ paddingTop: 'max(0.5rem, var(--safe-top))' }}>
                <button onClick={onBack} className="p-2 -ml-2 text-slate-600 active:scale-95 transition-transform">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                </button>
                <span className="font-bold text-slate-700">見面設定</span>
                <div className="w-8"></div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-8" style={{ paddingBottom: 'calc(var(--safe-bottom) + 2rem)' }}>
                <p className="text-[11px] text-slate-400 leading-relaxed">角色立繪搬到了「神經鏈接 → 形象」，桌面陪伴和節日活動照常使用。</p>

                <section className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100">
                    <div className="flex items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                            <h3 className="text-xs font-bold text-slate-400 uppercase">淺色閱讀模式</h3>
                            <p className="text-[11px] text-slate-400 mt-1">小說視圖使用淺色背景，減少眼睛疲勞</p>
                        </div>
                        <button
                            onClick={() => updateCharacter(char.id, { dateLightReading: !char.dateLightReading })}
                            type="button"
                            role="switch"
                            aria-checked={!!char.dateLightReading}
                            aria-label="切換淺色閱讀模式"
                            className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${char.dateLightReading ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${char.dateLightReading ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                        </button>
                    </div>
                    <div className="flex items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                            <h3 className="text-xs font-bold text-slate-400 uppercase">閱讀模式顯示頭像</h3>
                            <p className="text-[11px] text-slate-400 mt-1">在雙方的見面記錄旁顯示對應頭像</p>
                        </div>
                        <button
                            onClick={() => updateCharacter(char.id, { dateReadingShowAvatars: !char.dateReadingShowAvatars })}
                            type="button"
                            role="switch"
                            aria-checked={!!char.dateReadingShowAvatars}
                            aria-label="切換閱讀模式頭像"
                            className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${char.dateReadingShowAvatars ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${char.dateReadingShowAvatars ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                        </button>
                    </div>
                </section>

                <Section title="文風與敘事 (Writing Style)">
                    <p className="text-[11px] text-slate-400 mt-1 mb-4">調整見面時 AI 的寫作風格與敘事人稱，修改後從下一條回覆開始生效。</p>

                    {/* 寫作風格 */}
                    <div className="mb-5">
                        <label className="text-[11px] text-slate-500 font-bold mb-2 block">寫作風格</label>
                        <div className="flex flex-wrap gap-2">
                            {DATE_STYLE_PRESETS.map(p => {
                                const active = (styleConfig.style || 'cinematic') === p.id;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => patchStyleConfig({ style: p.id })}
                                        className={`px-3.5 py-2 rounded-full text-xs font-bold transition-all active:scale-95 ${active ? 'bg-primary text-white shadow-md shadow-primary/20' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                                    >
                                        {p.label}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                            {DATE_STYLE_PRESETS.find(p => p.id === (styleConfig.style || 'cinematic'))?.hint}
                        </p>
                    </div>

                    {/* 敘事人稱 */}
                    <div className="mb-5">
                        <label className="text-[11px] text-slate-500 font-bold mb-2 block">敘事人稱</label>
                        <div className="space-y-2">
                            {POV_OPTIONS.map(opt => {
                                const active = styleConfig.pov === opt.id;
                                return (
                                    <button
                                        key={opt.id || 'default'}
                                        onClick={() => patchStyleConfig({ pov: opt.id })}
                                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left transition-all active:scale-[0.98] ${active ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-slate-100 bg-slate-50 hover:bg-slate-100'}`}
                                    >
                                        <span className={`text-xs font-bold ${active ? 'text-primary' : 'text-slate-600'}`}>{opt.label}</span>
                                        <span className="text-[11px] text-slate-400 italic">{opt.example}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 細節深挖引導 */}
                    <div className="mb-5 flex items-center justify-between">
                        <div className="pr-4">
                            <label className="text-[11px] text-slate-500 font-bold block">細節深挖引導</label>
                            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">教 AI 從任何一句話裡挖出可寫的細節，並每輪給一條不同的聚焦線索，減少空話和模型口癖。</p>
                        </div>
                        <button
                            onClick={() => patchStyleConfig({ digDeeper: styleConfig.digDeeper === false ? undefined : false })}
                            className={`w-12 h-7 rounded-full transition-colors relative shrink-0 ${styleConfig.digDeeper !== false ? 'bg-primary' : 'bg-slate-200'}`}
                        >
                            <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${styleConfig.digDeeper !== false ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                        </button>
                    </div>

                    {/* 自定義補充 */}
                    <div>
                        <label className="text-[11px] text-slate-500 font-bold mb-2 block">自定義補充（可選）</label>
                        <textarea
                            value={extraDraft}
                            onChange={e => setExtraDraft(e.target.value)}
                            onBlur={saveExtraDraft}
                            placeholder="比如：多寫環境互動；不要寫心理活動；對話佔比多一些……"
                            className="w-full h-20 px-4 py-3 bg-slate-100 rounded-xl text-sm resize-none focus:ring-1 focus:ring-primary/30 outline-none transition-all leading-relaxed"
                        />
                        <p className="text-[10px] text-slate-300 mt-1">點別處會自動保存；這段會照原樣用上，比上面的風格優先。</p>
                    </div>
                </Section>

                <Section title="背景 (Background)">
                    <div 
                        onClick={triggerUpload}
                        className="aspect-video bg-slate-200 rounded-xl overflow-hidden relative border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer hover:border-primary group"
                    >
                        {char.dateBackground ? (
                            <>
                                <TokenImg value={char.dateBackground} className="w-full h-full object-cover" />
                                <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><span className="text-white text-xs font-bold">更換背景</span></div>
                            </>
                        ) : <span className="text-slate-400 text-xs">+ 上傳背景圖</span>}
                    </div>
                </Section>
                
                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
            </div>

        </div>
    );
};

export default DateSettings;
