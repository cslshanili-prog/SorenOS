
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { markAmsgStateDirtyForAll } from '../utils/amsgStateSync';
import { GalleryImage, LibraryAccess } from '../types';
import { safeResponseJson } from '../utils/safeApi';
import ConfirmDialog from '../components/os/ConfirmDialog';
import TokenImg from '../components/os/TokenImg';
import LibraryAccessPicker from '../components/library/LibraryAccessPicker';
import LibraryDescribeButton from '../components/library/LibraryDescribeButton';
import LibraryGenerateView from '../components/library/LibraryGenerateView';
import LibraryBatchDescribeSheet from '../components/library/LibraryBatchDescribeSheet';
import { pickUndescribedPhotos } from '../utils/libraryDescribe';
import { trackEvent } from '../utils/analytics';
import { processImageToBlob } from '../utils/file';
import { blobToDataUrl, getBlobForRef, putImageBlob } from '../utils/blobRef';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { formatLibraryFileSize } from '../utils/libraryArchive';
import { getLocalDateKey } from '../utils/localDate';
import { Star, UploadSimple, NotePencil, MagicWand, FileText, FilePdf, DownloadSimple, Sparkle } from '@phosphor-icons/react';
import {
    CONTENT_FAVORITES_CHANGED_EVENT,
    getContentFavoriteById,
    makeImageContentFavoriteId,
    removeContentFavoriteById,
    saveGalleryImageContentFavorite,
} from '../utils/contentFavorites';
import {
    LIBRARY_DESCRIPTION_MAX,
    LIBRARY_SOURCES,
    LIBRARY_SOURCE_LABEL,
    LibraryFilter,
    describeLibraryAccess,
    filterLibraryImages,
    isLibraryFile,
    isLibraryAccessEmpty,
    librarySourceOf,
    makeLibraryImageId,
    normalizeLibraryDescription,
    resolveLibraryAccess,
} from '../utils/library';

const DESCRIPTION_HINT = '寫給角色看的：畫面裡有什麼、在哪裡、什麼時候。有描述的照片，分配到的角色才知道它在、能傳給你。';

/**
 * 資料庫（原本的相簿）：所有照片放在一起，按來源、按「哪個角色能用」篩；
 * 每張可以寫描述、分配給誰；也能自己上傳現成的圖。設計見 plans/asset-library-design.md。
 */
const Gallery: React.FC = () => {
    const { closeApp, characters, characterGroups, apiConfig, addToast, userProfileBase, groups, realtimeConfig } = useOS();
    // 角色手邊的照片也烤在主動消息的 fire_pack 裡（utils/libraryPrompt.ts）：描述、分配、增刪都讓雲端那份跟著刷新。
    // 門在 markAmsgStateDirty 裡，沒開主動消息的角色自己會被篩掉
    const markLibraryChanged = () => markAmsgStateDirtyForAll({ characters, userProfileBase, groups, realtimeConfig });
    const [view, setView] = useState<'grid' | 'detail' | 'upload' | 'generate'>('grid');
    const [images, setImages] = useState<GalleryImage[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [filter, setFilter] = useState<LibraryFilter>({ source: 'all' });
    // 照片／文件（協同歸檔的文檔）兩個分頁
    const [tab, setTab] = useState<'photos' | 'files'>('photos');
    const [selectedImage, setSelectedImage] = useState<GalleryImage | null>(null);
    const [isReviewing, setIsReviewing] = useState(false);
    const [showChatContext, setShowChatContext] = useState(false);
    const [imageFavorited, setImageFavorited] = useState(false);
    const [descriptionDraft, setDescriptionDraft] = useState('');
    const [savedHint, setSavedHint] = useState(false);
    const [confirmDialog, setConfirmDialog] = useState<{ isOpen: boolean; title: string; message: string; variant: 'danger' | 'warning' | 'info'; onConfirm: () => void; } | null>(null);

    // 上傳
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [upload, setUpload] = useState<{ blob: Blob; previewUrl: string; description: string; access: LibraryAccess } | null>(null);
    const [uploading, setUploading] = useState(false);

    const reload = useCallback(async () => {
        const all = await DB.getGalleryImages().catch(() => [] as GalleryImage[]);
        setImages(all.sort((a, b) => b.timestamp - a.timestamp));
        setLoaded(true);
    }, []);

    useEffect(() => { void reload(); }, [reload]);
    useEffect(() => () => { if (upload) URL.revokeObjectURL(upload.previewUrl); }, [upload?.previewUrl]);

    const photos = useMemo(() => images.filter(image => !isLibraryFile(image)), [images]);
    const files = useMemo(() => images.filter(isLibraryFile), [images]);
    const shownImages = useMemo(() => filterLibraryImages(photos, filter, characters), [photos, filter, characters]);
    // 批次 AI 寫：照目前的篩選，還沒描述的照片
    const undescribedShown = useMemo(() => pickUndescribedPhotos(shownImages), [shownImages]);
    const [batchDescribing, setBatchDescribing] = useState(false);
    const saveBatchDescription = async (image: GalleryImage, description: string) => {
        const saved = await DB.updateGalleryImage(image.id, { description: normalizeLibraryDescription(description) });
        if (!saved) throw new Error('找不到這張圖');
        setImages(prev => prev.map(img => (img.id === saved.id ? saved : img)));
    };
    const shownFiles = useMemo(() => filterLibraryImages(files, { source: 'all', charId: filter.charId }, characters), [files, filter.charId, characters]);
    const sourceCounts = useMemo(() => {
        const base = filter.charId ? filterLibraryImages(photos, { source: 'all', charId: filter.charId }, characters) : photos;
        const counts: Record<string, number> = { all: base.length };
        for (const image of base) counts[librarySourceOf(image)] = (counts[librarySourceOf(image)] || 0) + 1;
        return counts;
    }, [photos, filter.charId, characters]);

    const charName = (id?: string) => characters.find(c => c.id === id)?.name;

    const sourceLine = (image: GalleryImage): string => {
        const name = charName(image.charId) || '已刪除的角色';
        switch (librarySourceOf(image)) {
            case 'chat_char': return `${name} 在私聊傳給你的`;
            case 'chat_user': return `你在私聊傳給 ${name} 的`;
            case 'date_moment': return `和 ${name} 見面時拍的`;
            case 'generated': {
                const who = (image.generation?.subjects || []).map(key => (key === 'user' ? '你' : charName(key))).filter(Boolean);
                return `在資料庫生成的${who.length ? `（${who.join('、')}）` : ''}`;
            }
            case 'collab': return `${name} 的協同工作${image.file?.sessionTitle ? `「${image.file.sessionTitle}」` : ''}歸檔的`;
            default: return '你上傳的';
        }
    };

    const tileBadge = (image: GalleryImage): string | null => {
        const source = librarySourceOf(image);
        if (source === 'chat_char') return `${charName(image.charId) || 'TA'} 傳的`;
        if (source === 'date_moment') return '見面';
        if (source === 'upload') return '上傳';
        if (source === 'generated') return '生成';
        if (source === 'collab') return '協同';
        return null;
    };

    const openDetail = (img: GalleryImage) => {
        setSelectedImage(img);
        setDescriptionDraft(img.description || '');
        setShowChatContext(false);
        setSavedHint(false);
        setView('detail');
    };

    const patchSelected = async (patch: Partial<GalleryImage>) => {
        if (!selectedImage) return;
        try {
            const saved = await DB.updateGalleryImage(selectedImage.id, patch);
            if (!saved) throw new Error('找不到這張圖');
            setSelectedImage(saved);
            setImages(prev => prev.map(img => (img.id === saved.id ? saved : img)));
            markLibraryChanged();
            setSavedHint(true);
            window.setTimeout(() => setSavedHint(false), 1500);
        } catch (error: any) {
            addToast(`沒存成：${error?.message || '未知錯誤'}`, 'error');
        }
    };

    const commitDescription = () => {
        if (!selectedImage) return;
        const next = normalizeLibraryDescription(descriptionDraft);
        if (next === (selectedImage.description || undefined)) return;
        void patchSelected({ description: next });
    };

    const refreshSelectedFavorite = useCallback(async () => {
        if (!selectedImage) {
            setImageFavorited(false);
            return;
        }
        const favorite = await getContentFavoriteById(makeImageContentFavoriteId(selectedImage.url)).catch(() => null);
        setImageFavorited(!!favorite);
    }, [selectedImage?.id]);

    useEffect(() => {
        void refreshSelectedFavorite();
        window.addEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshSelectedFavorite);
        return () => window.removeEventListener(CONTENT_FAVORITES_CHANGED_EVENT, refreshSelectedFavorite);
    }, [refreshSelectedFavorite]);

    const handleToggleImageFavorite = async () => {
        if (!selectedImage) return;
        const favoriteId = makeImageContentFavoriteId(selectedImage.url);
        try {
            if (imageFavorited) {
                await removeContentFavoriteById(favoriteId);
                setImageFavorited(false);
                addToast('已取消收藏圖片', 'info');
                return;
            }
            await saveGalleryImageContentFavorite(selectedImage, charName(selectedImage.charId) || '資料庫');
            setImageFavorited(true);
            addToast('已收藏圖片（僅保存引用）', 'success');
            trackEvent('收藏相册图片');
        } catch (error) {
            console.warn('[Gallery] favorite image failed', error);
            addToast('收藏失敗，請稍後重試', 'error');
        }
    };

    const leaveDetail = () => {
        commitDescription();
        setView('grid');
        setSelectedImage(null);
    };

    const handleBack = () => {
        if (view === 'detail') leaveDetail();
        else if (view === 'upload') { setUpload(null); setView('grid'); }
        else if (view === 'generate') setView('grid');
        else closeApp();
    };

    const handleDeleteImage = () => {
        if (!selectedImage) return;
        const source = librarySourceOf(selectedImage);
        setConfirmDialog({
            isOpen: true,
            title: isLibraryFile(selectedImage) ? '刪除文件' : '刪除照片',
            message: source === 'collab'
                ? '從資料庫刪掉這份？協同文件櫃裡那份不受影響。'
                : source.startsWith('chat') || source === 'date_moment'
                ? '從資料庫刪掉這張？聊天／見面記錄裡的那張不受影響。'
                : '確定要刪除這張照片嗎？',
            variant: 'danger',
            onConfirm: async () => {
                await DB.deleteGalleryImage(selectedImage.id);
                setImages(prev => prev.filter(img => img.id !== selectedImage.id));
                markLibraryChanged();
                setView('grid');
                setSelectedImage(null);
                addToast(isLibraryFile(selectedImage) ? '文件已刪除' : '照片已刪除', 'success');
                trackEvent('删除一张照片');
                setConfirmDialog(null);
            }
        });
    };

    // 文件：交給系統分享面板，不支援就下載
    const handleOpenFile = async () => {
        if (!selectedImage) return;
        try {
            const blob = await getBlobForRef(selectedImage.url);
            if (!blob) throw new Error('文件已經不存在');
            const result = await shareOrDownloadBlob({ blob, fileName: selectedImage.file?.name || '文件', shareTitle: selectedImage.file?.name || '文件' });
            if (result === 'shared') addToast('已打開系統分享面板', 'success');
            else if (result === 'downloaded') addToast('文件已下載', 'success');
        } catch (error: any) {
            addToast(`打不開：${error?.message || '未知錯誤'}`, 'error');
        }
    };

    // ---------- 上傳 ----------

    const handlePickFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const blob = await processImageToBlob(file, { maxWidth: 2048, quality: 0.9 });
            setUpload({ blob, previewUrl: URL.createObjectURL(blob), description: '', access: { mode: 'all' } });
            setView('upload');
        } catch (error: any) {
            addToast(error?.message || '圖片讀不出來', 'error');
        }
    };

    const handleSaveUpload = async () => {
        if (!upload || uploading) return;
        setUploading(true);
        try {
            const url = await putImageBlob(upload.blob);
            const image: GalleryImage = {
                id: makeLibraryImageId(),
                charId: '',
                url,
                timestamp: Date.now(),
                sender: 'user',
                origin: 'upload',
                access: upload.access,
                savedDate: getLocalDateKey(new Date()),
                ...(normalizeLibraryDescription(upload.description) ? { description: normalizeLibraryDescription(upload.description) } : {}),
            };
            await DB.saveGalleryImage(image);
            markLibraryChanged();
            trackEvent('上传到资料库', { 分配: upload.access.mode === 'all' ? '共用' : upload.access.mode === 'worlds' ? '按世界' : upload.access.mode === 'none' ? '只有我' : '指定角色', 描述: image.description ? '有' : '没有' });
            setUpload(null);
            setFilter({ source: 'all' });
            await reload();
            setView('grid');
            addToast('存進資料庫了', 'success');
        } catch (error: any) {
            addToast(`沒存成：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setUploading(false);
        }
    };

    // ---------- 讓角色點評（你在私聊傳給角色的照片才有） ----------

    const reviewer = selectedImage && librarySourceOf(selectedImage) === 'chat_user'
        ? characters.find(c => c.id === selectedImage.charId)
        : undefined;

    const handleReview = async () => {
        if (!selectedImage || !reviewer || !apiConfig.apiKey) {
            addToast('缺少配置或圖片信息', 'error');
            return;
        }
        const char = reviewer;

        setIsReviewing(true);
        trackEvent('让角色点评这张照片');
        try {
            const chatContextStr = selectedImage.chatContext?.length
                ? `\n\nContext: This photo was shared during a conversation. Here's what was being discussed:\n${selectedImage.chatContext.join('\n')}\n\nIMPORTANT: Your comment should feel natural given the conversation context above. Do NOT say things that contradict or are completely unrelated to what was being talked about.`
                : '';

            const dateStr = selectedImage.savedDate
                ? `\nThis photo is from ${selectedImage.savedDate}.`
                : '';

            const systemContent = `You are ${char.name}. ${char.systemPrompt || 'You are a helpful assistant.'}
Task: The user sent you a photo. Comment on it briefly (1-3 sentences) based on your personality.${dateStr}${chatContextStr}
Style: Casual, conversational, strictly NO AI-assistant tone. React as if you received this on a chat app.
CRITICAL: Stay in character. If there's conversation context, your comment should naturally fit that context. Don't say anything that would be bizarre given what you two were just talking about.`;

            const payload = {
                model: apiConfig.model,
                messages: [
                    { role: 'system', content: systemContent },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: "Look at this photo I sent you." },
                            { type: 'image_url', image_url: { url: selectedImage.url } }
                        ]
                    }
                ],
                max_tokens: 8000,
                temperature: 0.7,
                stream: false
            };

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiConfig.apiKey}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                let errorMsg = `HTTP Error ${response.status}`;
                try {
                    const errData = await safeResponseJson(response);
                    errorMsg = errData.error?.message || JSON.stringify(errData.error) || errorMsg;
                    if (errorMsg.includes('vision') || errorMsg.includes('image')) {
                        errorMsg = '當前模型可能不支持圖片識別(Vision)，請切換模型。';
                    }
                } catch (e) {
                    const text = await response.text();
                    if (text) errorMsg = text.slice(0, 100);
                }
                throw new Error(errorMsg);
            }

            const data = await safeResponseJson(response);
            const choice = data.choices?.[0];

            if (choice?.finish_reason === 'content_filter') {
                throw new Error('AI 拒絕回覆 (圖片可能包含敏感內容)');
            }

            let reviewText = choice?.message?.content;
            if (!reviewText && choice?.message?.reasoning_content) {
                reviewText = choice.message.reasoning_content;
            }
            if (!reviewText && choice?.text) reviewText = choice.text;
            if (!reviewText && choice?.delta?.content) reviewText = choice.delta.content;

            if (!reviewText) {
                const debugStr = JSON.stringify(choice || data);
                console.warn('AI Empty Response Structure:', data);
                throw new Error(`AI 返回內容為空. Raw: ${debugStr.substring(0, 100)}...`);
            }

            await DB.updateGalleryImageReview(selectedImage.id, reviewText);

            const updatedImage = { ...selectedImage, review: reviewText, reviewTimestamp: Date.now() };
            setSelectedImage(updatedImage);
            setImages(prev => prev.map(img => img.id === selectedImage.id ? updatedImage : img));

            addToast('點評生成成功', 'success');

        } catch (e: any) {
            console.error('Review Error:', e);
            addToast(`點評失敗: ${e.message}`, 'error');
        } finally {
            setIsReviewing(false);
        }
    };

    // ---------- 畫面 ----------

    const renderFilters = (withSource = true) => (
        <div className="shrink-0 space-y-2 border-b border-slate-100 bg-white/70 px-3 pb-2.5 pt-2">
            {withSource && <div role="radiogroup" aria-label="來源" className="no-scrollbar flex gap-1.5 overflow-x-auto">
                {([['all', '全部'], ...LIBRARY_SOURCES.map(source => [source, LIBRARY_SOURCE_LABEL[source]])] as [LibraryFilter['source'], string][]).map(([value, label]) => {
                    const count = sourceCounts[value] || 0;
                    const on = filter.source === value;
                    return (
                        <button key={value} role="radio" aria-checked={on} onClick={() => setFilter(prev => ({ ...prev, source: value }))}
                            className={`shrink-0 rounded-full border px-3 py-1 text-[11px] font-bold transition ${on ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>
                            {label}{count ? ` ${count}` : ''}
                        </button>
                    );
                })}
            </div>}
            {characters.length > 0 && (
                <div role="radiogroup" aria-label="哪個角色能用" className="no-scrollbar flex items-center gap-2 overflow-x-auto">
                    <span className="shrink-0 text-[10px] font-bold text-slate-400">誰能用</span>
                    <button role="radio" aria-checked={!filter.charId} onClick={() => setFilter(prev => ({ ...prev, charId: undefined }))}
                        className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold transition ${!filter.charId ? 'bg-slate-200 text-slate-700' : 'text-slate-400'}`}>
                        不限
                    </button>
                    {characters.map(char => {
                        const on = filter.charId === char.id;
                        return (
                            <button key={char.id} role="radio" aria-checked={on} aria-label={char.name} title={char.name}
                                onClick={() => setFilter(prev => ({ ...prev, charId: on ? undefined : char.id }))}
                                className={`flex shrink-0 items-center gap-1 rounded-full py-0.5 pl-0.5 pr-2 transition ${on ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-200'}`}>
                                <span className="relative flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-[9px] font-bold text-slate-500">
                                    {char.name.charAt(0)}
                                    {char.avatar && <TokenImg value={char.avatar} alt="" className="absolute inset-0 h-full w-full object-cover" onError={event => { event.currentTarget.style.display = 'none'; }} />}
                                </span>
                                <span className="max-w-[5rem] truncate text-[11px] font-bold">{char.name}</span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const renderTabs = () => (
        <div role="tablist" aria-label="照片或文件" className="shrink-0 bg-white/70 px-3 pt-2">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
                {([['photos', '照片', photos.length], ['files', '文件', files.length]] as const).map(([value, label, count]) => (
                    <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
                        className={`rounded-lg py-1.5 text-[12px] font-bold transition ${tab === value ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>
                        {label}{count ? <span className="ml-1 font-mono text-[10px] opacity-60">{count}</span> : null}
                    </button>
                ))}
            </div>
        </div>
    );

    const renderFiles = () => (
        <div className="min-h-0 flex-1 overflow-y-auto animate-fade-in">
            {shownFiles.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-8 py-20 text-center">
                    <FileText size={40} weight="duotone" className="text-slate-300" />
                    <span className="text-sm text-slate-400">{files.length ? '這樣篩沒有文件' : '還沒有文件'}</span>
                    {!files.length && <span className="text-[11px] leading-relaxed text-slate-400">在協同工作的文件櫃長按一份文件，選「歸檔到資料庫」就會放進來。</span>}
                </div>
            ) : (
                <div className="bg-white">
                    {shownFiles.map(item => (
                        <button key={item.id} onClick={() => openDetail(item)} className="flex w-full items-center gap-3 border-b border-slate-100 px-4 py-3 text-left active:bg-slate-50">
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-500">
                                {/pdf/i.test(item.file?.mime || '') ? <FilePdf size={20} weight="duotone" /> : <FileText size={20} weight="duotone" />}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[13px] font-semibold text-slate-700">{item.file?.name || '未命名文件'}</span>
                                <span className="mt-0.5 block truncate text-[10px] text-slate-400">
                                    {[charName(item.charId), item.file?.sessionTitle, formatLibraryFileSize(item.file?.size || 0), item.savedDate].filter(Boolean).join(' · ')}
                                </span>
                            </span>
                            {item.description && <NotePencil size={14} className="shrink-0 text-slate-300" aria-label="有描述" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderGrid = () => (
        <>
            {renderTabs()}
            {tab === 'files' ? (
                <>
                    {characters.length > 0 && renderFilters(false)}
                    {renderFiles()}
                </>
            ) : (
            <>
            {renderFilters()}
            {undescribedShown.length > 0 && (
                <div className="flex shrink-0 items-center gap-2 border-b border-slate-100 bg-amber-50/70 px-3 py-2">
                    <span className="min-w-0 flex-1 text-[11px] leading-snug text-amber-700">{undescribedShown.length} 張還沒描述，角色看不到它們</span>
                    <button type="button" onClick={() => setBatchDescribing(true)}
                        className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-slate-600 shadow-sm active:scale-95">
                        <Sparkle size={12} weight="fill" />批次 AI 寫
                    </button>
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5 animate-fade-in">
                {shownImages.length === 0 ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 py-20 text-slate-300">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="h-14 w-14 opacity-40"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg>
                        <span className="text-sm">{!loaded ? '讀取中…' : photos.length ? '這樣篩沒有照片' : '還沒有照片'}</span>
                        {loaded && !photos.length && <span className="max-w-[16rem] text-center text-[11px] leading-relaxed text-slate-400">私聊、見面裡傳的照片會自動放進來；右上角也能自己上傳或生成。</span>}
                    </div>
                ) : (
                    <div className="grid grid-cols-3 gap-1">
                        {shownImages.map(img => {
                            const badge = tileBadge(img);
                            return (
                                <button key={img.id} onClick={() => openDetail(img)} className="relative aspect-square overflow-hidden rounded-sm bg-slate-100">
                                    {/* 圖存的是 blobref 令牌，TokenImg 解析成 objectURL；舊的 base64 / http 圖原樣透傳 */}
                                    <TokenImg value={img.url} className="h-full w-full object-cover transition-transform duration-300 hover:scale-105" loading="lazy" />
                                    {badge && <div className="absolute left-1.5 top-1.5 max-w-[85%] truncate rounded-full bg-black/50 px-1.5 py-0.5 text-[8px] font-bold tracking-wide text-white">{badge}</div>}
                                    {img.review && <div className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary shadow-sm ring-2 ring-white"></div>}
                                    <div className="absolute bottom-0 left-0 right-0 flex items-end justify-between bg-gradient-to-t from-black/50 to-transparent px-1.5 pb-1 pt-3">
                                        <span className="font-mono text-[8px] text-white/80">{img.savedDate || ''}</span>
                                        {img.description && <NotePencil size={10} weight="bold" className="text-white/90" aria-label="有描述" />}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            </>
            )}
        </>
    );

    const renderReview = () => reviewer && selectedImage && (
        <section className="space-y-2">
            <h3 className="text-[11px] font-bold text-slate-400">{reviewer.name} 怎麼說</h3>
            {selectedImage.review ? (
                <div className="rounded-2xl bg-slate-50 p-3">
                    <div className="flex items-start gap-2.5">
                        <TokenImg value={reviewer.avatar} className="h-8 w-8 rounded-full object-cover" />
                        <p className="flex-1 select-text text-[14px] leading-relaxed text-slate-700">「{selectedImage.review}」</p>
                    </div>
                    <div className="mt-2 flex justify-end">
                        <button onClick={handleReview} disabled={isReviewing} className="px-2 py-1 text-[11px] font-bold text-slate-400 hover:text-primary">
                            {isReviewing ? '想一下…' : '重新生成'}
                        </button>
                    </div>
                </div>
            ) : (
                <button onClick={handleReview} disabled={isReviewing}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white py-2.5 text-[13px] font-bold text-slate-600 active:scale-[0.98]">
                    {isReviewing ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-200 border-t-slate-600"></span>正在思考…</> : <>讓 TA 點評照片</>}
                </button>
            )}
            {selectedImage.chatContext && selectedImage.chatContext.length > 0 && (
                <>
                    <button onClick={() => setShowChatContext(!showChatContext)} className="text-[11px] text-slate-400 hover:text-slate-600">
                        {showChatContext ? '收起當時的對話' : '查看當時的對話'}
                    </button>
                    {showChatContext && (
                        <div className="max-h-40 space-y-1.5 overflow-y-auto rounded-xl bg-slate-50 p-3">
                            {selectedImage.chatContext.map((line, i) => (
                                <div key={i} className="text-[11px] leading-relaxed text-slate-500">{line}</div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </section>
    );

    const renderDetail = () => {
        if (!selectedImage) return null;
        const access = resolveLibraryAccess(selectedImage);
        const isFile = isLibraryFile(selectedImage);
        return (
            <div className="relative flex h-full flex-col bg-black animate-fade-in">
                <div className="pointer-events-none absolute left-0 top-0 z-50 flex w-full items-start justify-between p-4" style={{ paddingTop: 'max(1rem, var(--safe-top))' }}>
                    <button onClick={leaveDetail} aria-label="返回" className="pointer-events-auto rounded-full border border-white/10 bg-black/40 p-2 text-white backdrop-blur-md transition-transform hover:bg-black/60 active:scale-95">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-6 w-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <div className="pointer-events-auto flex items-center gap-2">
                        {!isFile && (
                            <button onClick={() => void handleToggleImageFavorite()} className={`rounded-full border border-white/10 p-2 text-white backdrop-blur-md transition-transform active:scale-95 ${imageFavorited ? 'bg-amber-500/80' : 'bg-black/40 hover:bg-black/60'}`} aria-label={imageFavorited ? '取消收藏圖片' : '收藏圖片'}>
                                <Star size={20} weight={imageFavorited ? 'fill' : 'regular'} />
                            </button>
                        )}
                        <button onClick={handleDeleteImage} aria-label={isFile ? '刪除文件' : '刪除照片'} className="rounded-full border border-white/10 bg-black/40 p-2 text-white backdrop-blur-md transition-transform hover:bg-red-600/60 active:scale-95">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-5 w-5"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                        </button>
                    </div>
                </div>

                <div className="relative flex h-[46%] w-full shrink-0 items-center justify-center overflow-hidden bg-black" style={{ paddingTop: 'var(--safe-top)' }}>
                    {isFile ? (
                        <div className="flex flex-col items-center gap-3 px-8 text-center text-white">
                            {/pdf/i.test(selectedImage.file?.mime || '') ? <FilePdf size={56} weight="duotone" className="text-white/70" /> : <FileText size={56} weight="duotone" className="text-white/70" />}
                            <p className="max-w-full break-all text-[15px] font-semibold">{selectedImage.file?.name || '未命名文件'}</p>
                            <p className="text-[11px] text-white/50">{formatLibraryFileSize(selectedImage.file?.size || 0)}</p>
                            <button onClick={() => void handleOpenFile()} className="mt-1 flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[13px] font-bold text-slate-800 active:scale-95">
                                <DownloadSimple size={15} weight="bold" />打開／下載
                            </button>
                        </div>
                    ) : (
                        <TokenImg value={selectedImage.url} className="max-h-full max-w-full object-contain" alt={selectedImage.description || '照片'} />
                    )}
                </div>

                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto rounded-t-3xl bg-white px-5 pb-8 pt-5">
                    <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-[12px] text-slate-500">{sourceLine(selectedImage)}{selectedImage.savedDate ? ` · ${selectedImage.savedDate}` : ''}</p>
                        <span className={`shrink-0 text-[11px] font-bold text-emerald-500 transition-opacity ${savedHint ? 'opacity-100' : 'opacity-0'}`}>已儲存</span>
                    </div>

                    <section className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <h3 className="shrink-0 text-[11px] font-bold text-slate-400">{isFile ? '備註' : '描述'}</h3>
                            {!isFile && (
                                <LibraryDescribeButton
                                    getImageUrl={() => selectedImage.url}
                                    current={descriptionDraft}
                                    onChange={text => { setDescriptionDraft(text); void patchSelected({ description: normalizeLibraryDescription(text) }); }}
                                />
                            )}
                        </div>
                        <textarea
                            value={descriptionDraft}
                            onChange={event => setDescriptionDraft(event.target.value.slice(0, LIBRARY_DESCRIPTION_MAX))}
                            onBlur={commitDescription}
                            rows={3}
                            placeholder={isFile ? '這份文件是什麼、什麼時候用得上' : DESCRIPTION_HINT}
                            className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:border-slate-400"
                        />
                        <div className="text-right font-mono text-[10px] text-slate-300">{descriptionDraft.length}/{LIBRARY_DESCRIPTION_MAX}</div>
                    </section>

                    <section className="space-y-2">
                        <div className="flex items-baseline justify-between">
                            <h3 className="text-[11px] font-bold text-slate-400">誰能用</h3>
                            <span className="text-[11px] text-slate-400">{describeLibraryAccess(access, characters, characterGroups)}</span>
                        </div>
                        <LibraryAccessPicker value={access} onChange={next => void patchSelected({ access: next })} characters={characters} worlds={characterGroups} />
                        {isLibraryAccessEmpty(access) && <p className="text-[11px] text-amber-600">現在沒有角色能用這{isFile ? '份' : '張'}。</p>}
                        {isFile && <p className="text-[11px] leading-relaxed text-slate-400">文件現在只是收在這裡，角色在私聊還不會讀資料庫的文件；要角色傳文件，照舊用協同的文件櫃。</p>}
                    </section>

                    {renderReview()}
                </div>
            </div>
        );
    };

    const renderUpload = () => upload && (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-10 pt-4 animate-fade-in">
            <div className="flex max-h-[40vh] items-center justify-center overflow-hidden rounded-2xl bg-slate-900">
                <img src={upload.previewUrl} alt="要上傳的圖" className="max-h-[40vh] max-w-full object-contain" />
            </div>
            <button onClick={() => fileInputRef.current?.click()} className="text-[12px] font-bold text-slate-400 underline-offset-2 hover:underline">換一張</button>
            <section className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                    <h3 className="shrink-0 text-[11px] font-bold text-slate-400">描述</h3>
                    <LibraryDescribeButton
                        getImageUrl={() => blobToDataUrl(upload.blob)}
                        current={upload.description}
                        onChange={text => setUpload(prev => prev && { ...prev, description: text })}
                    />
                </div>
                <textarea
                    value={upload.description}
                    onChange={event => setUpload(prev => prev && { ...prev, description: event.target.value.slice(0, LIBRARY_DESCRIPTION_MAX) })}
                    rows={3}
                    placeholder={DESCRIPTION_HINT}
                    className="w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-slate-700 outline-none focus:border-slate-400"
                />
            </section>
            <section className="space-y-2">
                <h3 className="text-[11px] font-bold text-slate-400">誰能用</h3>
                <LibraryAccessPicker value={upload.access} onChange={next => setUpload(prev => prev && { ...prev, access: next })} characters={characters} worlds={characterGroups} />
            </section>
            <button onClick={handleSaveUpload} disabled={uploading}
                className="w-full rounded-2xl bg-slate-800 py-3 text-[14px] font-bold text-white shadow-sm transition active:scale-[0.98] disabled:opacity-50">
                {uploading ? '存進去中…' : '存進資料庫'}
            </button>
        </div>
    );

    return (
        <div className="relative flex h-full w-full flex-col bg-slate-50 font-light">
            <ConfirmDialog isOpen={!!confirmDialog} title={confirmDialog?.title || ''} message={confirmDialog?.message || ''} variant={confirmDialog?.variant} confirmText="確認" onConfirm={confirmDialog?.onConfirm || (() => setConfirmDialog(null))} onCancel={() => setConfirmDialog(null)} />
            <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickFile} />

            {view !== 'detail' && view !== 'generate' && (
                <div className="sticky top-0 z-10 shrink-0 border-b border-slate-100/60 bg-white/80 backdrop-blur-xl" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex h-16 items-center px-4">
                        <button onClick={handleBack} aria-label="返回" className="-ml-2 rounded-full p-2 transition-transform hover:bg-black/5 active:scale-90">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-6 w-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <h1 className="ml-2 text-lg font-semibold tracking-tight text-slate-800">{view === 'upload' ? '上傳到資料庫' : '資料庫'}</h1>
                        {view === 'grid' && <span className="ml-2 font-mono text-xs text-slate-400">{images.length}</span>}
                        {view === 'grid' && (
                            <div className="ml-auto flex items-center gap-1.5">
                                <button onClick={() => setView('generate')} className="flex items-center gap-1 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-bold text-slate-700 active:scale-95">
                                    <MagicWand size={14} weight="bold" />生成
                                </button>
                                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1.5 text-[12px] font-bold text-white active:scale-95">
                                    <UploadSimple size={14} weight="bold" />上傳
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {view === 'grid' && renderGrid()}
            {batchDescribing && (
                <LibraryBatchDescribeSheet
                    photos={undescribedShown}
                    save={saveBatchDescription}
                    onClose={result => {
                        setBatchDescribing(false);
                        if (result?.succeeded) markLibraryChanged();
                    }}
                />
            )}
            {view === 'detail' && renderDetail()}
            {view === 'upload' && renderUpload()}
            {/* 生圖頁自己有深色標題列；存完留在原頁（暫存的圖還在），回資料庫才看得到新存的 */}
            {view === 'generate' && <LibraryGenerateView onBack={() => setView('grid')} onSaved={() => { markLibraryChanged(); setFilter({ source: 'all' }); void reload(); }} />}
        </div>
    );
};

export default Gallery;
