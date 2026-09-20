import React, { useEffect, useMemo, useState } from 'react';
import { ArrowsClockwise, CalendarBlank, CircleNotch, DownloadSimple, PaperPlaneTilt, Sparkle, Trash, X } from '@phosphor-icons/react';
import type { CharacterProfile, ImageGenApiConfig, TrajectoryOotdPost } from '../../types';
import TokenImg from '../os/TokenImg';
import {
    buildTrajectoryOotdPrompt, createTrajectoryOotdPost, groupTrajectoryOotdByDate, parseTrajectoryOotdDraft,
} from '../../utils/trajectory';
import { ContextBuilder } from '../../utils/context';
import { safeResponseJson, extractContent, extractJson } from '../../utils/safeApi';
import { generateImage, buildCharacterImagePrompt, resolveCharacterReferenceImage } from '../../utils/imageGeneration';
import { deleteBlobRefIfUnreferenced, getBlobForRef, migrateDataUrlToRef } from '../../utils/blobRef';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import { DB } from '../../utils/db';

interface Props {
    char: CharacterProfile;
    posts: TrajectoryOotdPost[];
    onCommit: (next: TrajectoryOotdPost[]) => void;
    apiConfig: { baseUrl: string; apiKey: string; model: string } | null | undefined;
    imageGenConfig: ImageGenApiConfig | undefined;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const formatDateHeading = (dateKey: string): string => {
    const [, m, d] = dateKey.split('-');
    return `${parseInt(m, 10)}月${parseInt(d, 10)}日`;
};

const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const TrajectoryOotdTab: React.FC<Props> = ({ char, posts, onCommit, apiConfig, imageGenConfig, addToast }) => {
    const [dateFilter, setDateFilter] = useState<string>('all');
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [detailPost, setDetailPost] = useState<TrajectoryOotdPost | null>(null);
    const [regeneratingPhoto, setRegeneratingPhoto] = useState(false);
    const [savingPhoto, setSavingPhoto] = useState(false);
    const [syncingToChat, setSyncingToChat] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    useEffect(() => { setConfirmDeleteOpen(false); }, [detailPost?.id]);

    const grouped = useMemo(() => groupTrajectoryOotdByDate(posts), [posts]);
    const visibleGroups = dateFilter === 'all' ? grouped : grouped.filter(g => g.dateKey === dateFilter);

    const handleGenerate = async () => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('先在设置里配置好 API', 'info'); return; }
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在设置里开启并配置好生图 API', 'info');
            return;
        }
        setGenerating(true);
        try {
            const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
            const prompt = buildTrajectoryOotdPrompt(roleSettingsBlock, posts);
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [{ role: 'system', content: roleSettingsBlock }, { role: 'user', content: prompt }],
                    temperature: 0.95,
                }),
            });
            if (!response.ok) throw new Error(`API Error ${response.status}`);
            const data = await safeResponseJson(response);
            const draft = parseTrajectoryOotdDraft(extractJson(extractContent(data)));
            if (!draft) { addToast('这次没解析出穿搭内容，再试一次', 'error'); return; }

            const imagePrompt = buildCharacterImagePrompt(char, draft.imagePrompt);
            const referenceBlob = await resolveCharacterReferenceImage(char, { forceSelfie: true });
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt, referenceBlob || undefined);
            const image = await migrateDataUrlToRef(dataUrl);

            const post = createTrajectoryOotdPost(draft, image);
            onCommit([post, ...posts]);
            addToast('今天的穿搭生成好了', 'success');
        } catch (e) {
            console.warn('[Trajectory] OOTD 生成失败:', e);
            addToast('生成失败，稍后再试', 'error');
        } finally {
            setGenerating(false);
        }
    };

    // 只重生成照片，文案（风格/配色/上下装等）原样不动——复用生成当下存下来的 imagePrompt，
    // 保证新照片还是贴合这身穿搭的文字描述，不会图文不符。
    const handleRegeneratePhoto = async (post: TrajectoryOotdPost) => {
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在设置里开启并配置好生图 API', 'info');
            return;
        }
        setRegeneratingPhoto(true);
        try {
            const imagePrompt = buildCharacterImagePrompt(char, post.imagePrompt);
            const referenceBlob = await resolveCharacterReferenceImage(char, { forceSelfie: true });
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt, referenceBlob || undefined);
            const image = await migrateDataUrlToRef(dataUrl);
            const next = posts.map(p => p.id === post.id ? { ...p, image } : p);
            onCommit(next);
            setDetailPost(prev => prev && prev.id === post.id ? { ...prev, image } : prev);
            void deleteBlobRefIfUnreferenced(post.image);
            addToast('照片已重新生成', 'success');
        } catch (e) {
            console.warn('[Trajectory] OOTD 照片重新生成失败:', e);
            addToast('生成失败，稍后再试', 'error');
        } finally {
            setRegeneratingPhoto(false);
        }
    };

    const handleSavePhoto = async (post: TrajectoryOotdPost) => {
        setSavingPhoto(true);
        try {
            const blob = await getBlobForRef(post.image);
            if (!blob) { addToast('图片已丢失，无法保存', 'error'); return; }
            const result = await shareOrDownloadBlob({ blob, fileName: `OOTD-${post.id}.png`, shareTitle: `${char.name} 的穿搭` });
            if (result !== 'cancelled') addToast(result === 'shared' ? '已打开保存面板' : '已保存到本地', 'success');
        } catch (e) {
            console.warn('[Trajectory] OOTD 照片保存失败:', e);
            addToast('保存失败，稍后再试', 'error');
        } finally {
            setSavingPhoto(false);
        }
    };

    const handleDelete = (post: TrajectoryOotdPost) => {
        onCommit(posts.filter(p => p.id !== post.id));
        void deleteBlobRefIfUnreferenced(post.image);
        setDetailPost(null);
        addToast('已删除', 'success');
    };

    const handleSyncToChat = async (post: TrajectoryOotdPost) => {
        setSyncingToChat(true);
        try {
            const detailLines = [
                `风格：${post.style}`,
                post.colors.length ? `配色：${post.colors.join('、')}` : null,
                post.tops ? `上装：${post.tops}` : null,
                post.bottoms ? `下装：${post.bottoms}` : null,
                post.shoes ? `鞋履：${post.shoes}` : null,
                post.accessories.length ? `配饰：${post.accessories.join('、')}` : null,
            ].filter(Boolean).join('\n');
            const messageId = await DB.saveMessage({
                charId: char.id, role: 'assistant', type: 'phone_card',
                content: `[你手机的 OOTD App] ${post.style} · ${post.tops || post.bottoms || '今天的穿搭'}`,
                metadata: { phoneCard: { app: 'OOTD', title: `${post.style} 穿搭`, detail: detailLines, image: post.image } },
            } as any);
            const next = posts.map(p => p.id === post.id ? { ...p, syncedMessageId: messageId } : p);
            onCommit(next);
            setDetailPost(prev => prev && prev.id === post.id ? { ...prev, syncedMessageId: messageId } : prev);
            addToast('已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] OOTD 同步私聊失败:', e);
            addToast('同步失败，稍后再试', 'error');
        } finally {
            setSyncingToChat(false);
        }
    };

    return (
        <div className="flex-1 min-h-0 flex flex-col text-white/90">
            <div className="shrink-0 flex items-center justify-between px-5 pt-3 pb-2">
                <div className="text-[11px] tracking-widest text-white/40">
                    {dateFilter === 'all' ? `共 ${posts.length} 条` : formatDateHeading(dateFilter)}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => setShowDatePicker(v => !v)} aria-label="按日期筛选"
                        className="w-8 h-8 rounded-full flex items-center justify-center transition"
                        style={{ color: dateFilter !== 'all' ? '#a78bfa' : 'rgba(255,255,255,0.6)', background: dateFilter !== 'all' ? 'rgba(167,139,250,0.12)' : 'transparent' }}>
                        <CalendarBlank size={17} weight={dateFilter !== 'all' ? 'fill' : 'light'} />
                    </button>
                    <button onClick={handleGenerate} disabled={generating} aria-label="生成今天的穿搭"
                        className="w-8 h-8 rounded-full flex items-center justify-center transition disabled:opacity-50"
                        style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.12)' }}>
                        {generating ? <CircleNotch size={16} weight="bold" className="animate-spin" /> : <Sparkle size={16} weight="bold" />}
                    </button>
                </div>
            </div>

            {showDatePicker && (
                <div className="shrink-0 px-5 pb-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                    <button onClick={() => { setDateFilter('all'); setShowDatePicker(false); }}
                        className="shrink-0 px-3 py-1 rounded-full text-[11px] font-bold"
                        style={{ background: dateFilter === 'all' ? '#a78bfa' : 'rgba(255,255,255,0.08)', color: dateFilter === 'all' ? '#15111f' : 'rgba(255,255,255,0.6)' }}>
                        全部
                    </button>
                    {grouped.map(g => (
                        <button key={g.dateKey} onClick={() => { setDateFilter(g.dateKey); setShowDatePicker(false); }}
                            className="shrink-0 px-3 py-1 rounded-full text-[11px] font-bold"
                            style={{ background: dateFilter === g.dateKey ? '#a78bfa' : 'rgba(255,255,255,0.08)', color: dateFilter === g.dateKey ? '#15111f' : 'rgba(255,255,255,0.6)' }}>
                            {formatDateHeading(g.dateKey)}
                        </button>
                    ))}
                </div>
            )}

            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-28 space-y-5">
                {posts.length === 0 && (
                    <div className="text-center pt-16 text-[12px] text-white/40">
                        还没有穿搭记录，点右上角 ✦ 生成 {char.name} 今天的穿搭
                    </div>
                )}
                {visibleGroups.map(g => (
                    <div key={g.dateKey}>
                        <div className="text-[11px] text-white/35 mb-2 tracking-wide">{formatDateHeading(g.dateKey)}</div>
                        <div className="grid grid-cols-3 gap-2.5">
                            {g.posts.map(p => (
                                <button key={p.id} onClick={() => setDetailPost(p)} className="text-left">
                                    <div className="aspect-square rounded-xl overflow-hidden bg-white/5 border border-white/10">
                                        <TokenImg value={p.image} alt="" className="w-full h-full object-cover" />
                                    </div>
                                    <div className="text-[9px] text-white/40 mt-1">{formatTime(p.timestamp)}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            {detailPost && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" onClick={() => setDetailPost(null)}>
                    <div className="absolute inset-0 bg-black/60" />
                    <div className="relative w-full max-w-xs rounded-[2rem] overflow-hidden shadow-2xl"
                        style={{ background: '#1a1626' }} onClick={e => e.stopPropagation()}>
                        <button onClick={() => setDetailPost(null)} aria-label="关闭"
                            className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80">
                            <X size={14} weight="bold" />
                        </button>
                        <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
                            <button onClick={() => void handleSavePhoto(detailPost)} disabled={savingPhoto} aria-label="保存照片"
                                className="w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80 disabled:opacity-50">
                                <DownloadSimple size={14} weight="bold" />
                            </button>
                            <button onClick={() => void handleRegeneratePhoto(detailPost)} disabled={regeneratingPhoto} aria-label="重新生成照片"
                                className="w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80 disabled:opacity-50">
                                <ArrowsClockwise size={14} weight="bold" className={regeneratingPhoto ? 'animate-spin' : ''} />
                            </button>
                            <button onClick={() => setConfirmDeleteOpen(true)} aria-label="删除"
                                className="w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-rose-200">
                                <Trash size={14} weight="bold" />
                            </button>
                        </div>
                        {confirmDeleteOpen && (
                            <div className="absolute inset-0 z-20 flex items-center justify-center p-6 rounded-[2rem]" style={{ background: 'rgba(10,8,15,0.94)' }}>
                                <div className="text-center">
                                    <div className="text-[13px] font-bold text-white/90 mb-1">删除这条穿搭记录？</div>
                                    <div className="text-[11px] text-white/45 mb-4">删除后无法恢复</div>
                                    <div className="flex gap-2 justify-center">
                                        <button onClick={() => setConfirmDeleteOpen(false)}
                                            className="px-4 py-2 rounded-xl text-[12px] font-bold" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
                                            取消
                                        </button>
                                        <button onClick={() => handleDelete(detailPost)}
                                            className="px-4 py-2 rounded-xl text-[12px] font-bold" style={{ background: 'rgba(244,63,94,0.18)', color: '#fca5a5', border: '1px solid rgba(244,63,94,0.35)' }}>
                                            确认删除
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                        <div className="aspect-[4/5] bg-white/5">
                            <TokenImg value={detailPost.image} alt="" className="w-full h-full object-cover" />
                        </div>
                        <div className="px-5 pt-4 pb-2">
                            <div className="text-[10px] tracking-[0.2em] text-white/40 uppercase">Outfit of the Day</div>
                            <div className="text-[12px] text-white/60 mt-0.5">
                                {new Date(detailPost.timestamp).getMonth() + 1}/{new Date(detailPost.timestamp).getDate()} {formatTime(detailPost.timestamp)}
                            </div>
                        </div>
                        <div className="px-5 pb-5 pt-1 space-y-2 text-[11.5px]">
                            {[
                                ['STYLE', detailPost.style],
                                ['COLOR', detailPost.colors.join('、') || '—'],
                                ['TOPS', detailPost.tops || '—'],
                                ['BOTTOMS', detailPost.bottoms || '—'],
                                ['SHOE', detailPost.shoes || '—'],
                                ['ACCESSORY', detailPost.accessories.join('、') || '—'],
                            ].map(([label, value]) => (
                                <div key={label} className="flex items-start justify-between gap-3 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                                    <span className="text-white/35 tracking-widest text-[9px] shrink-0 pt-0.5">{label}</span>
                                    <span className="text-white/85 text-right">{value}</span>
                                </div>
                            ))}
                            <button onClick={() => void handleSyncToChat(detailPost)} disabled={syncingToChat || !!detailPost.syncedMessageId}
                                className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                                style={{ background: 'rgba(167,139,250,0.14)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.25)' }}>
                                <PaperPlaneTilt size={15} weight="bold" />
                                {detailPost.syncedMessageId ? '已同步到私聊' : (syncingToChat ? '同步中…' : '同步到私聊')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrajectoryOotdTab;
