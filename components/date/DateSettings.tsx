
import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, DateStyleConfig } from '../../types';
import { resolveUserProfileForChar } from '../../utils/userPersona';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';
import { DATE_STYLE_PRESETS } from '../../utils/datePrompts';
import { DB } from '../../utils/db';
import { copyBuiltinMeetingPreset, deleteMeetingPresetRecord, duplicateMeetingPresetRecord, importStPresetFile, MEETING_PRESET_UPDATED_EVENT } from '../../utils/meetingPreset/store';
import { buildStPreset, stPresetFileName } from '../../utils/meetingPreset/stExport';
import { shareOrDownloadFile } from '../../utils/shareExport';
import type { MeetingPresetRecord } from '../../utils/meetingPreset/types';
import MeetingPresetManager from './MeetingPresetManager';
import ObserveSettings from './ObserveSettings';
import { isScheduleFeatureOn } from '../../utils/scheduleFeature';
import DateStoryExtras from './DateStoryExtras';
import { DATE_STORY_UPDATED_EVENT, loadActiveDateStory } from '../../utils/dateStory';
import type { DateStory } from '../../types';
import DateAppearanceSettings from './DateAppearanceSettings';
import DateSummarySettings from './DateSummarySettings';
import DateStoryTimeSettings from './DateStoryTimeSettings';

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

    // 自訂預設：所有角色共用一份清單，這個角色選哪份記在 dateMeetingPresetId
    const presetInputRef = useRef<HTMLInputElement>(null);
    const [presets, setPresets] = useState<MeetingPresetRecord[]>([]);
    const [managingPresetId, setManagingPresetId] = useState<string | null>(null);
    const [presetMenu, setPresetMenu] = useState<MeetingPresetRecord | 'builtin' | null>(null);
    const [importing, setImporting] = useState(false);
    useEffect(() => {
        const load = () => { DB.getMeetingPresets().then(setPresets).catch(() => setPresets([])); };
        load();
        window.addEventListener(MEETING_PRESET_UPDATED_EVENT, load);
        return () => window.removeEventListener(MEETING_PRESET_UPDATED_EVENT, load);
    }, []);
    // 進行中的故事（劇情大綱跟著故事走）
    const [story, setStory] = useState<DateStory | null>(null);
    useEffect(() => {
        let cancelled = false;
        const load = () => { loadActiveDateStory(char).then(next => { if (!cancelled) setStory(next); }).catch(() => {}); };
        load();
        window.addEventListener(DATE_STORY_UPDATED_EVENT, load);
        return () => { cancelled = true; window.removeEventListener(DATE_STORY_UPDATED_EVENT, load); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [char.id, char.activeDateStoryId]);
    const activePresetId = presets.some(p => p.id === char.dateMeetingPresetId) ? char.dateMeetingPresetId : undefined;
    const handlePresetFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (presetInputRef.current) presetInputRef.current.value = '';
        if (!file) return;
        setImporting(true);
        try {
            const record = await importStPresetFile(await file.text(), file.name);
            updateCharacter(char.id, { dateMeetingPresetId: record.id });
            addToast(`已匯入「${record.name}」，${char.name}的見面改用這份預設`, 'success');
        } catch (err: any) {
            addToast(err?.message || '匯入失敗', 'error');
        } finally {
            setImporting(false);
        }
    };
    const handleDeletePreset = async (preset: MeetingPresetRecord) => {
        if (!window.confirm(`刪除預設「${preset.name}」？用這份預設的角色會改回內建規則。`)) return;
        await deleteMeetingPresetRecord(preset.id);
        if (char.dateMeetingPresetId === preset.id) updateCharacter(char.id, { dateMeetingPresetId: undefined });
        addToast('已刪除', 'success');
    };
    const handleDuplicatePreset = async (preset: MeetingPresetRecord) => {
        const copy = await duplicateMeetingPresetRecord(preset);
        addToast(`已複製成「${copy.name}」`, 'success');
    };
    const handleCopyBuiltin = async () => {
        const copy = await copyBuiltinMeetingPreset(char.dateStyleConfig);
        addToast(`已複製成「${copy.name}」，點一下就能換成它`, 'success');
    };
    const handleExportPreset = async (preset: MeetingPresetRecord) => {
        try {
            const content = JSON.stringify(buildStPreset(preset.doc), null, 2);
            const result = await shareOrDownloadFile({ content, fileName: stPresetFileName(preset.doc), mimeType: 'application/json', shareTitle: preset.name });
            if (result === 'downloaded') addToast('已匯出', 'success');
        } catch (err: any) {
            addToast(err?.message || '匯出失敗', 'error');
        }
    };

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

                <Section title="預設 (Preset)" defaultOpen>
                    <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">可以匯入 SillyTavern 的對話補全預設，條目、變數、正則照預設跑。預設清單所有角色共用，選哪一份是每個角色自己的；點一下就換成那份，一次只跑標著「使用中」的那份，剛匯入的會自動選上。</p>
                    <div className="space-y-2">
                        <div className={`flex items-center gap-2 px-4 py-3 rounded-xl border transition-all ${!activePresetId ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-slate-100 bg-slate-50'}`}>
                            <button onClick={() => updateCharacter(char.id, { dateMeetingPresetId: undefined })} className="flex-1 min-w-0 flex items-center gap-3 text-left">
                                <span className={`text-sm font-bold ${!activePresetId ? 'text-primary' : 'text-slate-600'}`}>內建規則</span>
                                {!activePresetId && <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-white">使用中</span>}
                                <span className="text-[11px] text-slate-400 truncate">下面的文風與敘事</span>
                            </button>
                            <button onClick={() => setPresetMenu('builtin')} aria-label="內建規則 的更多操作" className="p-1.5 text-slate-400 active:scale-95">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" className="w-5 h-5"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                            </button>
                        </div>
                        {presets.map(preset => {
                            const active = activePresetId === preset.id;
                            return (
                                <div key={preset.id} className={`flex items-center gap-2 px-4 py-3 rounded-xl border transition-all ${active ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-slate-100 bg-slate-50'}`}>
                                    <button onClick={() => updateCharacter(char.id, { dateMeetingPresetId: preset.id })} className="flex-1 min-w-0 text-left">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            <span className={`text-sm font-bold truncate ${active ? 'text-primary' : 'text-slate-600'}`}>{preset.name}</span>
                                            {active && <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-white">使用中</span>}
                                        </div>
                                        <div className="text-[11px] text-slate-400">開 {preset.doc.prompts.filter(p => p.enabled).length} / {preset.doc.prompts.length} 條 · 正則 {preset.doc.regexScripts.length}</div>
                                    </button>
                                    <button onClick={() => setManagingPresetId(preset.id)} className="px-3 py-1.5 rounded-lg bg-white text-xs font-bold text-slate-600 border border-slate-200 active:scale-95">管理</button>
                                    <button onClick={() => setPresetMenu(preset)} aria-label={`${preset.name} 的更多操作`} className="p-1.5 text-slate-400 active:scale-95">
                                        <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" className="w-5 h-5"><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></svg>
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <button onClick={() => presetInputRef.current?.click()} disabled={importing}
                        className="mt-3 w-full py-2.5 border border-dashed border-primary/40 text-primary text-sm font-bold rounded-xl active:scale-95 disabled:opacity-50">
                        {importing ? '匯入中…' : '+ 匯入 SillyTavern 預設（.json）'}
                    </button>
                    <input type="file" ref={presetInputRef} className="hidden" accept=".json,application/json" onChange={handlePresetFile} />
                </Section>

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
                    <div className="p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <h3 className="text-xs font-bold text-slate-400 uppercase">故事進行中關閉線上功能</h3>
                                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">有一場故事還沒完結時，{char.name}不傳主動消息、不排定時消息；完結後自動恢復，先停下的主動消息照原樣排回去。朋友圈照常。</p>
                            </div>
                            <button
                                onClick={() => updateCharacter(char.id, { dateOfflineMode: !char.dateOfflineMode })}
                                type="button"
                                role="switch"
                                aria-checked={!!char.dateOfflineMode}
                                aria-label="切換故事進行中關閉線上功能"
                                className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${char.dateOfflineMode ? 'bg-primary' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${char.dateOfflineMode ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                            </button>
                        </div>
                        {char.dateOfflineMode && (
                            <p className="text-[10px] mt-2 text-slate-400" data-date-offline-status>
                                {char.dateOfflinePause
                                    ? `暫停中${char.dateOfflinePause.tasks.length ? `：${char.dateOfflinePause.tasks.length} 條主動消息先停著，完結後排回去` : ''}${char.dateOfflinePause.resuming ? '（有幾條還沒排回去，下次打開見面再試）' : ''}`
                                    : char.activeDateStoryId ? '正在暫停…' : '現在沒有進行中的故事，開始一場就會生效。'}
                            </p>
                        )}
                    </div>
                    <div className="p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <h3 className="text-xs font-bold text-slate-400 uppercase">線下情緒獨立</h3>
                                <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">開著時見面的情緒跟著這場故事走：開場帶著私聊當下的情緒進來，之後每則見面回覆都評估一次、只寫進這場故事，私聊那份不受影響。關著就跟私聊共用一份。</p>
                            </div>
                            <button
                                onClick={() => updateCharacter(char.id, { dateEmotionIndependent: !char.dateEmotionIndependent })}
                                type="button"
                                role="switch"
                                aria-checked={!!char.dateEmotionIndependent}
                                aria-label="切換線下情緒獨立"
                                className={`w-12 h-7 shrink-0 rounded-full transition-colors relative ${char.dateEmotionIndependent ? 'bg-primary' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute left-0 top-0.5 w-6 h-6 bg-white rounded-full shadow-md transition-transform ${char.dateEmotionIndependent ? 'translate-x-5' : 'translate-x-0.5'}`}></div>
                            </button>
                        </div>
                        {char.dateEmotionIndependent && !(char.emotionConfig?.enabled && isScheduleFeatureOn(char)) && (
                            <p className="text-[10px] mt-2 text-amber-600">{char.name}的情緒系統還沒開（私聊設定 →「日程與情緒 Buff」），見面不會評估情緒。</p>
                        )}
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

                <ObserveSettings char={char} usingCustomPreset={!!activePresetId} />

                <Section title={activePresetId ? '文風與敘事（用自訂預設時不生效）' : '文風與敘事 (Writing Style)'}>
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

                <DateStoryExtras char={char} updateCharacter={updateCharacter} addToast={addToast} Section={Section} story={story} />

                <DateStoryTimeSettings char={char} story={story} updateCharacter={updateCharacter} addToast={addToast} Section={Section} />

                <DateSummarySettings char={char} story={story} Section={Section} />

                <Section title="畫面美化 (Appearance)">
                    <DateAppearanceSettings char={char} updateCharacter={updateCharacter} addToast={addToast} onPickBackground={triggerUpload} />
                </Section>
                
                <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileUpload} />
            </div>

            {presetMenu && (
                <div className="fixed inset-0 z-[300] bg-black/40 flex items-end sm:items-center justify-center" onClick={() => setPresetMenu(null)}>
                    <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-2" style={{ paddingBottom: 'calc(var(--safe-bottom) + 0.5rem)' }} onClick={e => e.stopPropagation()}>
                        {presetMenu === 'builtin' ? (
                            <p className="px-4 py-3 text-xs text-slate-400 leading-relaxed">內建規則不能直接改。複製出來是一份一般的自訂預設，文風、人稱、深挖照{char.name}現在的設定先開好，可以自己增刪條目、改內容、匯出。</p>
                        ) : (
                            <div className="px-4 py-3 text-xs text-slate-400 truncate">{presetMenu.name}</div>
                        )}
                        {(presetMenu === 'builtin' ? [
                            ['複製成自訂預設', () => handleCopyBuiltin(), 'text-slate-700'],
                        ] as const : [
                            ['複製一份', () => handleDuplicatePreset(presetMenu), 'text-slate-700'],
                            ['匯出（SillyTavern .json）', () => handleExportPreset(presetMenu), 'text-slate-700'],
                            ['刪除', () => handleDeletePreset(presetMenu), 'text-red-500'],
                        ] as const).map(([label, action, color]) => (
                            <button key={label} onClick={() => { const target = action; setPresetMenu(null); void target(); }}
                                className={`w-full px-4 py-3 text-left text-sm font-bold rounded-xl active:bg-slate-50 ${color}`}>{label}</button>
                        ))}
                        <button onClick={() => setPresetMenu(null)} className="w-full px-4 py-3 text-sm text-slate-400 rounded-xl active:bg-slate-50">取消</button>
                    </div>
                </div>
            )}
            {managingPresetId && <MeetingPresetManager presetId={managingPresetId} onClose={() => setManagingPresetId(null)} />}
        </div>
    );
};

export default DateSettings;
