import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CaretLeft, CaretRight, CheckCircle, DownloadSimple, FloppyDisk, Minus, Plus, Sparkle, Trash } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { GalleryImage, ImageGenPreset, ImageStylePreset, LibraryAccess, LibraryGenKind } from '../../types';
import TokenImg from '../os/TokenImg';
import ExpandableTextarea from '../common/ExpandableTextarea';
import LibraryAccessPicker from './LibraryAccessPicker';
import LibraryDescribeButton from './LibraryDescribeButton';
import { trackEvent } from '../../utils/analytics';
import { DB } from '../../utils/db';
import { deleteBlobRefIfUnreferenced, getBlobForRef, migrateDataUrlToRef, resolveRefToDataUrl } from '../../utils/blobRef';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import { getLocalDateKey } from '../../utils/localDate';
import { personaAvatarForKey, personaNameForKey, profileForPersonaKey, REAL_IDENTITY_PERSONA_ID, resolveUserProfileForChar } from '../../utils/userPersona';
import { LIBRARY_DESCRIPTION_MAX, makeLibraryImageId, normalizeLibraryDescription } from '../../utils/library';
import { describeDefaultPick, isImageFeatureOff, newStyleId, STYLE_NONE } from '../../utils/imageStyle';
import {
    LIBRARY_GEN_KINDS, LIBRARY_GEN_PROMPT_MAX, LibraryGenSubject, canGenerateInLibrary, defaultLibraryGenAccess,
    describeLibraryGenLock, generateLibraryImage, libraryGenSubjectError, subjectKey, writeLibraryPromptWithAI,
} from '../../utils/libraryGenerate';
import { FACE_LOCK_LEVELS, faceLockLabel, faceLockOf, strongestFaceLock, type FaceLockLevel } from '../../utils/faceLock';
import { addLibraryGenDrafts, loadLibraryGenDrafts, newLibraryGenDraftId, saveLibraryGenDrafts, type LibraryGenDraft } from '../../utils/libraryGenDrafts';

const MAX_COUNT = 4;
const SIZE_OPTIONS = ['1024x1024', '1024x1536', '1536x1024'];
const QUALITY_OPTIONS: Array<{ value: string; label: string }> = [{ value: 'auto', label: 'Auto' }, { value: 'standard', label: 'Standard' }, { value: 'hd', label: 'HD' }];
const AI_WRITE_KEY = 'soren-library-gen-ai-write';
type Tab = 'scene' | 'people' | 'thing' | 'params';
const TABS: Array<{ key: Tab; label: string }> = [
    { key: 'scene', label: '想拍什麼' }, { key: 'people', label: '人物' }, { key: 'thing', label: '物品/風景' }, { key: 'params', label: '參數' },
];
const KIND_LABEL: Record<LibraryGenKind, string> = { solo: '獨照', group: '合照', object: '物品', scenery: '風景' };

const accent = 'text-[#c9a4f5]';
const field = 'w-full rounded-2xl bg-[#e4ddd6] px-4 py-3 text-[13px] leading-relaxed text-slate-700 outline-none placeholder:text-slate-400';
const darkSelect = 'min-w-0 flex-1 rounded-xl border border-white/10 bg-[#24232b] px-3 py-2 text-[12px] text-white/80 outline-none';

/**
 * 資料庫：在這裡生成（plans/library-generate-redesign.md）。查手機的深色風格：
 * 上面固定的預覽框＋這次生的縮圖（暫存在裝置上，自己刪才清）→ 四個分頁（想拍什麼／人物／物品風景／參數）
 * → 這次送出的提示詞 → 底部張數、生成、存進資料庫（另一頁：描述、誰能用）。
 */
const LibraryGenerateView: React.FC<{ onSaved: (image: GalleryImage) => void; onBack: () => void }> = ({ onSaved, onBack }) => {
    const { characters, characterGroups, apiConfig, updateApiConfig, userProfile, userProfileBase, personaLinesEnabled, addToast } = useOS();
    const imageConfig = apiConfig.imageGenConfig;
    const [tab, setTab] = useState<Tab>('scene');
    /** 現在拍哪一類：人物那兩頁＝拍人，物品／風景那頁＝拍東西 */
    const [mode, setMode] = useState<'people' | 'thing'>('people');
    const [sceneText, setSceneText] = useState('');
    const [thingText, setThingText] = useState('');
    const [thingKind, setThingKind] = useState<'object' | 'scenery'>('object');
    const [picked, setPicked] = useState<string[]>([]);
    const [aiWrite, setAiWrite] = useState(() => { try { return localStorage.getItem(AI_WRITE_KEY) === '1'; } catch { return false; } });
    const [count, setCount] = useState(1);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState('');
    const [elapsed, setElapsed] = useState(0);
    const [drafts, setDrafts] = useState<LibraryGenDraft[]>(() => loadLibraryGenDrafts());
    const [selectedId, setSelectedId] = useState<string | null>(() => loadLibraryGenDrafts()[0]?.id || null);
    const [showSent, setShowSent] = useState(false);
    // 參數
    const [presetId, setPresetId] = useState('');
    const [apiId, setApiId] = useState('');
    const [styleId, setStyleId] = useState('');
    const [styleDraft, setStyleDraft] = useState<ImageStylePreset | null>(null);
    const [size, setSize] = useState('');
    const [quality, setQuality] = useState('');
    const [presetName, setPresetName] = useState('');
    /** 這次的鎖臉強度；空＝照每個人自己的設定（合照取最強） */
    const [faceLockPick, setFaceLockPick] = useState<'' | FaceLockLevel>('');
    // 存進資料庫
    const [saving, setSaving] = useState<LibraryGenDraft | null>(null);
    const [description, setDescription] = useState('');
    const [access, setAccess] = useState<LibraryAccess>({ mode: 'all' });
    const [savingBusy, setSavingBusy] = useState(false);
    const topRef = useRef<HTMLDivElement>(null);

    const persist = (next: LibraryGenDraft[]) => { setDrafts(next); saveLibraryGenDrafts(next); };
    const selected = drafts.find(d => d.id === selectedId) || null;
    const styles = imageConfig?.stylePresets || [];
    const apis = imageConfig?.apiPresets || [];
    const presets = imageConfig?.genPresets || [];

    useEffect(() => {
        if (!busy) return;
        setElapsed(0);
        const started = Date.now();
        const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => window.clearInterval(t);
    }, [busy]);

    // 人物：開著關係線時你的每張身份卡都能選；關著就是「你」一個（長相照第一個選到的角色認識的那張）
    const firstChar = characters.find(c => picked.includes(c.id));
    const userForPhoto = useMemo(() => (firstChar ? resolveUserProfileForChar(userProfileBase, firstChar) : userProfile), [firstChar, userProfileBase, userProfile]);
    const userChips = useMemo(() => personaLinesEnabled
        ? [REAL_IDENTITY_PERSONA_ID, ...(userProfileBase.personas || []).map(p => p.id)].map(key => ({
            key: `user:${key}`, name: personaNameForKey(userProfileBase, key), avatar: personaAvatarForKey(userProfileBase, key), profile: profileForPersonaKey(userProfileBase, key), personaKey: key,
        }))
        : [{ key: 'user', name: '你', avatar: userForPhoto.avatar, profile: userForPhoto, personaKey: undefined as string | undefined }],
    [personaLinesEnabled, userProfileBase, userForPhoto]);
    const subjects: LibraryGenSubject[] = useMemo(() => picked.flatMap((key): LibraryGenSubject[] => {
        const u = userChips.find(x => x.key === key);
        if (u) return [{ type: 'user', profile: u.profile, ...(u.personaKey ? { personaKey: u.personaKey } : {}) }];
        const char = characters.find(c => c.id === key);
        return char ? [{ type: 'char', char }] : [];
    }), [picked, characters, userChips]);

    const kind: LibraryGenKind = mode === 'thing' ? thingKind : subjects.length > 1 ? 'group' : 'solo';
    const text = mode === 'thing' ? thingText : sceneText;
    const blockReason = mode === 'people'
        ? (!subjects.length ? '先到「人物」選這次拍誰' : libraryGenSubjectError(kind, subjects.length) || (!sceneText.trim() ? '先在「想拍什麼」寫動作、場景' : null))
        : (!thingText.trim() ? '先寫想拍什麼' : null);

    const switchTab = (next: Tab) => {
        setTab(next);
        if (next === 'scene' || next === 'people') setMode('people');
        if (next === 'thing') setMode('thing');
    };
    const togglePerson = (key: string) => setPicked(prev => (prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]));

    // 畫風：選了某一套就把那套抄一份出來改；改過就照改過的生，可以另存或覆寫
    const baseStyle = styles.find(st => st.id === styleId) || null;
    const styleDirty = !!(styleDraft && baseStyle && (styleDraft.prompt !== baseStyle.prompt || (styleDraft.portraitPrompt || '') !== (baseStyle.portraitPrompt || '') || (styleDraft.negativePrompt || '') !== (baseStyle.negativePrompt || '')));
    const pickStyleId = (id: string) => {
        setStyleId(id);
        const st = styles.find(x => x.id === id);
        setStyleDraft(st ? { ...st } : null);
    };
    const applyPreset = (id: string) => {
        setPresetId(id);
        const p = presets.find(x => x.id === id);
        if (!p) return;
        setApiId(p.apiId || '');
        pickStyleId(p.styleId || '');
        setSize(p.size || '');
        setQuality(p.quality || '');
    };
    const writeStyles = (next: ImageStylePreset[]) => updateApiConfig({ imageGenConfig: { ...(imageConfig || {}), stylePresets: next } });
    const saveStyleAs = () => {
        if (!styleDraft) return;
        const id = newStyleId();
        const { builtinKey: _b, ...rest } = styleDraft;
        writeStyles([...styles, { ...rest, id, name: `${styleDraft.name}（改）` }]);
        setStyleId(id);
        setStyleDraft({ ...rest, id, name: `${styleDraft.name}（改）` });
        addToast('另存成新畫風了', 'success');
    };
    const overwriteStyle = () => {
        if (!styleDraft || !window.confirm(`覆寫畫風「${styleDraft.name}」？用到它的地方都會跟著變。`)) return;
        writeStyles(styles.map(st => (st.id === styleDraft.id ? { ...styleDraft } : st)));
        addToast('畫風覆寫好了', 'success');
    };
    const savePreset = () => {
        const name = presetName.trim();
        if (!name) { addToast('先幫這組參數取個名字', 'info'); return; }
        const p: ImageGenPreset = { id: `gp-${Date.now().toString(36)}`, name, ...(apiId ? { apiId } : {}), ...(styleId ? { styleId } : {}), ...(size ? { size } : {}), ...(quality ? { quality } : {}) };
        updateApiConfig({ imageGenConfig: { ...(imageConfig || {}), genPresets: [...presets, p] } });
        setPresetId(p.id);
        setPresetName('');
        addToast(`存成生圖預設「${name}」`, 'success');
    };

    const run = async () => {
        if (busy || !canGenerateInLibrary(imageConfig)) return;
        if (blockReason) { addToast(blockReason, 'info'); return; }
        setBusy(true);
        window.setTimeout(() => topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
        try {
            let scene = text.trim();
            if (aiWrite) {
                setProgress('AI 正在寫提示詞…');
                scene = await writeLibraryPromptWithAI({ kind, text: scene, names: subjects.map(s => (s.type === 'char' ? s.char.name : userChips.find(u => u.profile === s.profile)?.name || '你')), api: apiConfig });
            }
            let made = 0;
            for (let i = 0; i < count; i++) {
                setProgress(count > 1 ? `正在畫第 ${i + 1}／${count} 張…` : '正在畫…');
                try {
                    const r = await generateLibraryImage({
                        kind, prompt: scene, subjects: mode === 'people' ? subjects : [], imageConfig,
                        ...(apiId ? { apiId } : {}),
                        ...(styleDirty ? { styleOverride: styleDraft } : styleId ? { styleId } : {}),
                        ...(size ? { size } : {}), ...(quality ? { quality } : {}),
                        ...(faceLockPick ? { faceLock: faceLockPick } : {}),
                    });
                    if (r.apiFallbackFrom) addToast(`「${r.apiFallbackFrom}」沒回應，這張改用全域那組 API`, 'info');
                    const ref = await migrateDataUrlToRef(r.dataUrl);
                    const draft: LibraryGenDraft = {
                        id: newLibraryGenDraftId(), ref, kind, userPrompt: text.trim(), scenePrompt: scene,
                        ...(r.sentPrompt ? { sentPrompt: r.sentPrompt } : {}), ...(r.sentNegativePrompt ? { sentNegativePrompt: r.sentNegativePrompt } : {}),
                        subjects: mode === 'people' ? subjects.map(subjectKey) : [],
                        locked: r.lockedCount, wanted: r.wantedLocks, peopleCount: r.peopleCount,
                        ...(r.lockError ? { lockError: r.lockError } : {}), ...(r.faceLockNote ? { faceLockNote: r.faceLockNote } : {}), createdAt: Date.now(),
                    };
                    setDrafts(prev => {
                        const { next, dropped } = addLibraryGenDrafts(prev, [draft]);
                        dropped.forEach(d => { if (!d.savedImageId) void deleteBlobRefIfUnreferenced(d.ref); });
                        saveLibraryGenDrafts(next);
                        return next;
                    });
                    setSelectedId(draft.id);
                    made++;
                    trackEvent('在资料库生成照片', { 类型: ({ solo: '独照', group: '合照', object: '物品', scenery: '风景' } as const)[kind] });
                } catch (error: any) {
                    addToast(`第 ${i + 1} 張沒生成成：${error?.message || '未知錯誤'}`, 'error');
                    if (!made && i === 0) break;
                }
            }
        } catch (error: any) {
            addToast(`沒生成成：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
            setProgress('');
        }
    };

    const removeDraft = (d: LibraryGenDraft) => {
        const next = drafts.filter(x => x.id !== d.id);
        persist(next);
        if (selectedId === d.id) setSelectedId(next[0]?.id || null);
        if (!d.savedImageId) void deleteBlobRefIfUnreferenced(d.ref);
    };
    const clearDrafts = () => {
        if (!drafts.length || !window.confirm(`刪掉這裡暫存的 ${drafts.length} 張？已經存進資料庫的不受影響。`)) return;
        drafts.forEach(d => { if (!d.savedImageId) void deleteBlobRefIfUnreferenced(d.ref); });
        persist([]);
        setSelectedId(null);
    };
    // 下載走統一的分享／存檔（見 utils/shareExport.ts）：手機拉起分享面板，選「儲存影像」直接進相簿；
    // 不能 preferDownloadOnWeb——iOS 會跳去一頁檔案預覽，還要再點「更多」才存得下來。
    const download = async (d: LibraryGenDraft) => {
        try {
            const blob = await getBlobForRef(d.ref);
            if (!blob) throw new Error('找不到這張圖');
            await shareOrDownloadBlob({ blob, fileName: `soren-${new Date(d.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png` });
        } catch { addToast('下載失敗', 'error'); }
    };

    const openSave = (d: LibraryGenDraft) => {
        setSaving(d);
        setDescription(d.userPrompt.slice(0, LIBRARY_DESCRIPTION_MAX));
        const subs = d.subjects.flatMap((key): LibraryGenSubject[] => {
            const char = characters.find(c => c.id === key);
            if (char) return [{ type: 'char', char }];
            return key === 'user' || key.startsWith('user:') ? [{ type: 'user', profile: userProfile }] : [];
        });
        setAccess(defaultLibraryGenAccess(d.kind, subs));
    };
    const save = async () => {
        if (!saving || savingBusy) return;
        setSavingBusy(true);
        try {
            const image: GalleryImage = {
                id: makeLibraryImageId(), charId: '', url: saving.ref, timestamp: Date.now(), sender: 'user', origin: 'generated', access,
                savedDate: getLocalDateKey(new Date()),
                generation: { kind: saving.kind, prompt: saving.sentPrompt || saving.scenePrompt, subjects: saving.subjects, locked: saving.locked, wanted: saving.wanted },
                ...(normalizeLibraryDescription(description) ? { description: normalizeLibraryDescription(description) } : {}),
            };
            await DB.saveGalleryImage(image);
            persist(drafts.map(d => (d.id === saving.id ? { ...d, savedImageId: image.id } : d)));
            addToast('存進資料庫了', 'success');
            setSaving(null);
            onSaved(image);
        } catch (error: any) {
            addToast(`沒存成：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setSavingBusy(false);
        }
    };

    const personChip = (key: string, name: string, avatar: string | undefined, hasRef: boolean) => {
        const on = picked.includes(key);
        return (
            <button key={key} type="button" role="checkbox" aria-checked={on} aria-label={name} onClick={() => togglePerson(key)} className="flex min-w-0 flex-col items-center gap-1">
                <span className={`relative block h-12 w-12 overflow-hidden rounded-full bg-white/10 ring-2 transition ${on ? 'ring-[#c9a4f5]' : 'ring-transparent opacity-60'}`}>
                    <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white/40">{name.charAt(0)}</span>
                    {avatar && <TokenImg value={avatar} alt="" className="relative h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}
                    {on && <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm font-bold text-white">{picked.length > 1 ? picked.indexOf(key) + 1 : '✓'}</span>}
                </span>
                <span className={`w-full truncate text-center text-[10px] ${on ? 'font-bold text-white' : 'text-white/50'}`}>{name}</span>
                <span className={`text-[9px] ${hasRef ? 'text-emerald-300' : 'text-white/25'}`}>{hasRef ? '會鎖臉' : '沒參考圖'}</span>
            </button>
        );
    };
    const hasRef = (cfg?: { referenceEnabled?: boolean; referenceImage?: string }) => !!(cfg?.referenceEnabled && cfg.referenceImage);
    const aiToggle = (
        <div className="flex items-center gap-3 border-t border-white/10 pt-3">
            <Sparkle size={18} className={accent} weight="fill" />
            <div className="min-w-0 flex-1">
                <div className={`text-[13px] font-bold ${accent}`}>AI 幫我寫提示詞</div>
                <div className="text-[10px] text-white/50">先用 AI 把你寫的擴寫成一段提示詞再開始生圖（多一次 API 請求）</div>
            </div>
            <button type="button" role="switch" aria-checked={aiWrite} aria-label="AI 幫我寫提示詞"
                onClick={() => { const v = !aiWrite; setAiWrite(v); try { localStorage.setItem(AI_WRITE_KEY, v ? '1' : '0'); } catch { /* 記不住就算了 */ } }}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${aiWrite ? 'bg-[#b98ae8]' : 'bg-white/15'}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${aiWrite ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
        </div>
    );

    if (!canGenerateInLibrary(imageConfig)) {
        return (
            <div className="flex flex-1 flex-col bg-[#17161c] text-white">
                {header(onBack)}
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
                    {isImageFeatureOff(imageConfig, 'library') ? (<>
                        <p className="text-sm font-bold text-white/70">資料庫的生圖關掉了</p>
                        <p className="text-[12px] leading-relaxed text-white/40">到「設置 → 生圖API → 各處畫風」把「資料庫生圖」改回來，就能在這裡生成照片。</p>
                    </>) : (<>
                        <p className="text-sm font-bold text-white/70">還沒設生圖 API</p>
                        <p className="text-[12px] leading-relaxed text-white/40">到「設置 → 生圖 API」填好網址和模型，就能在這裡生成照片。</p>
                    </>)}
                </div>
            </div>
        );
    }

    const defaultPick = describeDefaultPick(imageConfig, { feature: 'library' });

    return (
        <div className="relative flex min-h-0 flex-1 flex-col bg-[#17161c] text-white">
            {header(onBack)}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-28">
                {/* 預覽 */}
                <div ref={topRef} className="px-4 pt-3">
                    <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[#2a2733] to-[#231a33]">
                        {selected ? (
                            <TokenImg value={selected.ref} alt="生成的照片" className={`h-full w-full object-contain transition-opacity ${busy ? 'opacity-40' : ''}`} />
                        ) : !busy && (
                            <div className="flex flex-col items-center gap-3 text-white/40">
                                <Sparkle size={34} weight="light" />
                                <span className="text-[11px]">選好 API 與提示詞，點「生成」</span>
                            </div>
                        )}
                        {busy && (
                            <div role="status" aria-live="polite" className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/30">
                                <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
                                <span className="text-[13px] font-bold">{progress || '正在畫…'}</span>
                                <span className="text-[11px] text-white/60">已經 {elapsed} 秒，通常一張要 20～60 秒</span>
                            </div>
                        )}
                        {selected && !busy && (
                            <button type="button" onClick={() => download(selected)} aria-label="下載" className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/40 text-white/90">
                                <DownloadSimple size={18} weight="bold" />
                            </button>
                        )}
                    </div>
                    {selected && (
                        <p className="mt-1.5 text-center text-[10px] text-white/40">
                            {KIND_LABEL[selected.kind]}{selected.peopleCount ? ` · ${describeLibraryGenLock(selected.locked, selected.wanted, selected.lockError, selected.peopleCount)}` : ''}{selected.savedImageId ? ' · 已存進資料庫' : ''}
                        </p>
                    )}
                    {drafts.length > 0 && (
                        <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
                            {drafts.map(d => (
                                <div key={d.id} className="relative shrink-0">
                                    <button type="button" onClick={() => setSelectedId(d.id)} aria-label="看這張" aria-pressed={d.id === selectedId}
                                        className={`block h-16 w-16 overflow-hidden rounded-xl border-2 bg-white/10 ${d.id === selectedId ? 'border-[#c9a4f5]' : 'border-transparent opacity-70'}`}>
                                        <TokenImg value={d.ref} alt="" className="h-full w-full object-cover" />
                                    </button>
                                    {d.savedImageId && <CheckCircle size={16} weight="fill" className="absolute left-1 top-1 text-emerald-300 drop-shadow" />}
                                    {d.id === selectedId && (
                                        <button type="button" onClick={() => removeDraft(d)} aria-label="刪掉這張暫存" className="absolute inset-0 m-auto flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white">
                                            <Trash size={15} weight="bold" />
                                        </button>
                                    )}
                                </div>
                            ))}
                            <button type="button" onClick={clearDrafts} className="shrink-0 px-2 text-[10px] text-white/40 underline-offset-2 hover:underline">全部刪除</button>
                        </div>
                    )}
                </div>

                {/* 分頁 */}
                <div role="tablist" className="mt-3 grid grid-cols-4 border-b border-white/10">
                    {TABS.map(t => (
                        <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => switchTab(t.key)}
                            className={`relative py-2.5 text-[12px] font-bold ${tab === t.key ? accent : 'text-white/70'}`}>
                            {t.label}
                            {tab === t.key && <span className="absolute inset-x-6 -bottom-px h-0.5 rounded-full bg-[#c9a4f5]" />}
                        </button>
                    ))}
                </div>

                <div className="space-y-3 px-4 pt-4">
                    {tab === 'scene' && (<>
                        <ExpandableTextarea tone="dark" title="想拍什麼" value={sceneText} onChange={setSceneText} maxLength={LIBRARY_GEN_PROMPT_MAX} rows={4}
                            placeholder={LIBRARY_GEN_KINDS[subjects.length > 1 ? 1 : 0].placeholder} className={`${field} resize-none`} />
                        <p className="text-center text-[10px] text-white/40">寫地點、動作、表情、光線就好，長相會照每個人自己的設定和參考圖。{subjects.length ? `（這次：${subjects.length > 1 ? `合照 ${subjects.length} 人` : '獨照'}）` : '（先到「人物」選這次拍誰）'}</p>
                        <p className="text-center text-[10px] text-white/30">這格是拍人用的。只拍物品或風景的話不用填，直接到「物品／風景」分頁寫。</p>
                        {aiToggle}
                    </>)}

                    {tab === 'people' && (<>
                        <p className="text-[11px] text-white/50">選一個是獨照，選好幾個是合照。{personaLinesEnabled ? '你的每張身份卡都能選。' : picked.some(k => k === 'user') ? `你的長相照「${userForPhoto.name}」。` : ''}</p>
                        <div className="grid grid-cols-4 gap-3">
                            {userChips.map(u => personChip(u.key, u.name, u.avatar, hasRef(u.profile.imageGenConfig)))}
                            {characters.filter(c => !c.altOf).map(char => personChip(char.id, char.name, char.avatar, hasRef(char.imageGenCharConfig)))}
                        </div>
                    </>)}

                    {tab === 'thing' && (<>
                        <div role="radiogroup" aria-label="拍什麼" className="grid grid-cols-2 gap-1 rounded-xl bg-white/5 p-1">
                            {(['object', 'scenery'] as const).map(k => (
                                <button key={k} role="radio" aria-checked={thingKind === k} onClick={() => setThingKind(k)}
                                    className={`rounded-lg py-1.5 text-[12px] font-bold ${thingKind === k ? 'bg-[#c9a4f5] text-[#17161c]' : 'text-white/60'}`}>{KIND_LABEL[k]}</button>
                            ))}
                        </div>
                        <ExpandableTextarea tone="dark" title={`想拍什麼（${KIND_LABEL[thingKind]}）`} value={thingText} onChange={setThingText} maxLength={LIBRARY_GEN_PROMPT_MAX} rows={4}
                            placeholder={LIBRARY_GEN_KINDS.find(k => k.kind === thingKind)!.placeholder} className={`${field} resize-none`} />
                        <p className="text-center text-[10px] text-white/40">畫面裡不會有人。這頁只看上面這格，「想拍什麼」和「人物」分頁不用填，在這頁按生成就是拍{KIND_LABEL[thingKind]}。</p>
                        {aiToggle}
                    </>)}

                    {tab === 'params' && (
                        <div className="space-y-3 text-[12px]">
                            {presets.length > 0 && (
                                <label className="flex items-center gap-2"><span className="w-14 shrink-0 text-white/50">生圖預設</span>
                                    <select value={presetId} onChange={e => applyPreset(e.target.value)} className={darkSelect}>
                                        <option value="">不套</option>
                                        {presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                </label>
                            )}
                            <label className="flex items-center gap-2"><span className="w-14 shrink-0 text-white/50">API</span>
                                <select value={apiId} onChange={e => setApiId(e.target.value)} className={darkSelect}>
                                    <option value="">照設定{defaultPick.apiName ? `（${defaultPick.apiName}）` : ''}</option>
                                    {apis.map(a => <option key={a.id} value={a.id}>{a.name || a.model}{a.model && a.name !== a.model ? ` · ${a.model}` : ''}</option>)}
                                </select>
                            </label>
                            <label className="flex items-center gap-2"><span className="w-14 shrink-0 text-white/50">畫風</span>
                                <select value={styleId} onChange={e => pickStyleId(e.target.value)} className={darkSelect}>
                                    <option value="">照設定（{defaultPick.styleName}）</option>
                                    <option value={STYLE_NONE}>這次不套</option>
                                    {styles.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
                                </select>
                            </label>
                            {mode === 'people' && subjects.some(sub => hasRef(sub.type === 'char' ? sub.char.imageGenCharConfig : sub.profile.imageGenConfig)) && (<>
                                <label className="flex items-center gap-2"><span className="w-14 shrink-0 text-white/50">鎖臉</span>
                                    <select value={faceLockPick} onChange={e => setFaceLockPick(e.target.value as '' | FaceLockLevel)} className={darkSelect} aria-label="這次的鎖臉強度">
                                        <option value="">照每個人的設定（{faceLockLabel(strongestFaceLock(subjects.map(sub => faceLockOf(sub.type === 'char' ? sub.char.imageGenCharConfig : sub.profile.imageGenConfig))))}）</option>
                                        {FACE_LOCK_LEVELS.map(l => <option key={l.key} value={l.key}>{l.label}</option>)}
                                    </select>
                                </label>
                                <p className="text-[10px] leading-relaxed text-amber-300/80">這次有人鎖臉：平衡只對長相、畫法照畫風；還原盡量像參考圖，畫風很容易被帶走。不管哪檔，參考圖跟畫風同一種風格效果最好。</p>
                            </>)}
                            {styleDraft && (
                                <div className="space-y-2 rounded-2xl border border-white/10 bg-white/5 p-3">
                                    <div className="text-[10px] text-white/50">改這次用的畫風（不存也照改過的生）</div>
                                    <ExpandableTextarea tone="dark" title={`${styleDraft.name}・每次都加`} value={styleDraft.prompt} onChange={v => setStyleDraft({ ...styleDraft, prompt: v })} rows={3} className={`${field} resize-none text-[12px]`} />
                                    <ExpandableTextarea tone="dark" title={`${styleDraft.name}・畫面有人時才加`} value={styleDraft.portraitPrompt || ''} onChange={v => setStyleDraft({ ...styleDraft, portraitPrompt: v || undefined })} rows={2} placeholder="畫面有人時才加" className={`${field} resize-none text-[12px]`} />
                                    <ExpandableTextarea tone="dark" title={`${styleDraft.name}・避免`} value={styleDraft.negativePrompt || ''} onChange={v => setStyleDraft({ ...styleDraft, negativePrompt: v || undefined })} rows={2} placeholder="避免（負面提示詞）" className={`${field} resize-none text-[12px]`} />
                                    {styleDirty && (
                                        <div className="flex gap-2">
                                            <button type="button" onClick={saveStyleAs} className="flex-1 rounded-xl bg-white/10 py-2 font-bold text-white/80">另存成新畫風</button>
                                            <button type="button" onClick={overwriteStyle} className="flex-1 rounded-xl bg-[#c9a4f5] py-2 font-bold text-[#17161c]">覆寫這套</button>
                                        </div>
                                    )}
                                </div>
                            )}
                            <div className="flex items-center gap-2"><span className="w-14 shrink-0 text-white/50">尺寸</span>
                                <div className="flex flex-1 flex-wrap gap-1.5">
                                    {['', ...SIZE_OPTIONS].map(v => (
                                        <button key={v || 'default'} type="button" onClick={() => setSize(v)} aria-pressed={size === v}
                                            className={`rounded-lg px-2.5 py-1.5 font-bold ${size === v ? 'bg-[#c9a4f5] text-[#17161c]' : 'bg-white/10 text-white/60'}`}>{v || '照設定'}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="flex items-center gap-2"><span className="w-14 shrink-0 text-white/50">畫質</span>
                                <div className="flex flex-1 flex-wrap gap-1.5">
                                    {[{ value: '', label: '照設定' }, ...QUALITY_OPTIONS].map(q => (
                                        <button key={q.value || 'default'} type="button" onClick={() => setQuality(q.value)} aria-pressed={quality === q.value}
                                            className={`rounded-lg px-2.5 py-1.5 font-bold ${quality === q.value ? 'bg-[#c9a4f5] text-[#17161c]' : 'bg-white/10 text-white/60'}`}>{q.label}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 border-t border-white/10 pt-3">
                                <input value={presetName} onChange={e => setPresetName(e.target.value.slice(0, 20))} placeholder="幫這組參數取個名字"
                                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#24232b] px-3 py-2 text-white/80 outline-none placeholder:text-white/30" />
                                <button type="button" onClick={savePreset} className="shrink-0 rounded-xl bg-white/10 px-3 py-2 font-bold text-white/80">存成生圖預設</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* 這次送出的提示詞 */}
                <div className="mt-4 border-t border-white/10 px-4 pt-3">
                    <button type="button" onClick={() => setShowSent(v => !v)} aria-expanded={showSent} className="flex items-center gap-1.5 text-[11px] font-bold text-white/80">
                        {showSent ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}這次送出的提示詞
                    </button>
                    {/* 不做內層捲動：框裡一捲，手指放在這塊上整頁就滑不動（它佔了大半個螢幕）；要收起來按上面那行 */}
                    {showSent && (
                        <div className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-white/5 p-3 text-[11px] leading-relaxed text-white/60">
                            {selected?.sentPrompt || selected?.scenePrompt || '生成之後這裡會顯示真的送出去的那段（AI 寫的、加了畫風的都看得到）。'}
                            {selected?.sentNegativePrompt && <div className="mt-2 text-white/40">負面：{selected.sentNegativePrompt}</div>}
                            {selected?.faceLockNote && <div className="mt-2 text-white/40">{selected.faceLockNote}</div>}
                        </div>
                    )}
                </div>
            </div>

            {/* 底部 */}
            <div className="absolute inset-x-0 bottom-0 border-t border-white/10 bg-[#17161c] px-4 pt-3" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                <div className="flex items-center gap-2">
                    <div className="flex h-11 shrink-0 items-center rounded-xl bg-white text-slate-700">
                        <button type="button" aria-label="少一張" disabled={count <= 1} onClick={() => setCount(c => Math.max(1, c - 1))} className="px-3 disabled:opacity-30"><Minus size={14} weight="bold" /></button>
                        <span className="w-5 text-center text-[14px] font-bold" aria-label="張數">{count}</span>
                        <button type="button" aria-label="多一張" disabled={count >= MAX_COUNT} onClick={() => setCount(c => Math.min(MAX_COUNT, c + 1))} className="px-3 disabled:opacity-30"><Plus size={14} weight="bold" /></button>
                    </div>
                    <button type="button" onClick={run} disabled={busy}
                        className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#c9a4f5] text-[15px] font-bold text-[#17161c] transition active:scale-[0.98] disabled:opacity-50 ${blockReason ? 'opacity-70' : ''}`}>
                        <Sparkle size={18} weight="fill" />{busy ? '生成中…' : `生成${mode === 'people' && subjects.length ? `（${KIND_LABEL[kind]}）` : mode === 'thing' ? `（${KIND_LABEL[kind]}）` : ''}`}
                    </button>
                    {selected && (
                        <button type="button" onClick={() => openSave(selected)} disabled={busy || !!selected.savedImageId} aria-label={selected.savedImageId ? '已存進資料庫' : '存進資料庫'}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-slate-700 disabled:opacity-40">
                            {selected.savedImageId ? <CheckCircle size={20} weight="fill" className="text-emerald-500" /> : <FloppyDisk size={20} weight="bold" />}
                        </button>
                    )}
                </div>
            </div>

            {/* 存進資料庫 */}
            {saving && (
                <div role="dialog" aria-label="存進資料庫" className="absolute inset-0 z-30 flex flex-col bg-[#e7e0d9] text-slate-700">
                    <div className="flex h-[72px] items-end justify-between px-4 pb-3" style={{ marginTop: 'var(--safe-top)' }}>
                        <h2 className="text-[15px] font-bold">存進資料庫</h2>
                        <button type="button" onClick={() => setSaving(null)} aria-label="關閉" className="text-2xl leading-none text-slate-600">×</button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-24">
                        <div className="overflow-hidden rounded-3xl bg-slate-900">
                            <TokenImg value={saving.ref} alt="要存的照片" className="max-h-[38vh] w-full object-contain" />
                        </div>
                        <section className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <h3 className="text-[12px] font-bold text-slate-600">描述</h3>
                                <LibraryDescribeButton getImageUrl={() => resolveRefToDataUrl(saving.ref)} current={description} onChange={setDescription} />
                            </div>
                            <ExpandableTextarea title="描述" value={description} onChange={setDescription} maxLength={LIBRARY_DESCRIPTION_MAX} rows={3}
                                className="w-full resize-none rounded-2xl bg-white px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none" />
                            <p className="text-[10px] text-slate-500">角色傳照片時讀的就是這段。</p>
                        </section>
                        <section className="space-y-2">
                            <h3 className="text-[12px] font-bold text-slate-600">誰能用</h3>
                            <LibraryAccessPicker value={access} onChange={setAccess} characters={characters} worlds={characterGroups} />
                        </section>
                    </div>
                    <div className="absolute inset-x-0 bottom-0 px-4 pt-2" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
                        <button type="button" onClick={save} disabled={savingBusy} className="w-full rounded-2xl bg-slate-700 py-3 text-[14px] font-bold text-white disabled:opacity-50">
                            {savingBusy ? '存進去中…' : '存進資料庫'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

function header(onBack: () => void) {
    return (
        <div className="shrink-0 border-b border-white/5 bg-[#17161c]" style={{ paddingTop: 'var(--safe-top)' }}>
          <div className="relative flex h-[72px] items-end justify-center px-4 pb-2">
            <button type="button" onClick={onBack} aria-label="返回" className="absolute bottom-2 left-4 flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/80">
                <CaretLeft size={18} weight="bold" />
            </button>
            <div className="text-center">
                <div className="text-[16px] font-bold tracking-[0.12em] text-white">IMG GENERATION</div>
                <div className={`text-[10px] ${accent}`}>AI 生圖</div>
            </div>
          </div>
        </div>
    );
}

export default LibraryGenerateView;
