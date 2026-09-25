import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, CircleNotch, DownloadSimple, Heart, PaperPlaneTilt, Sparkle, Trash, X } from '@phosphor-icons/react';
import type { CharacterProfile, ImageGenApiConfig, MomentActor, MomentPost } from '../../types';
import TokenImg from '../os/TokenImg';
import { buildTrajectoryMomentsPrompt, parseTrajectoryMomentDraft } from '../../utils/trajectory';
import { useOS } from '../../context/OSContext';
import {
    actorDisplayName, buildFriendGraph, displayLikeCount, momentFeedFor, visibleComments, visibleLikes,
} from '../../utils/momentsPool';
import { createMomentPost, deleteMomentPost, MOMENTS_CHANGED_EVENT, updateMomentPostFields } from '../../utils/momentsStore';
import { trackEvent } from '../../utils/analytics';
import { ContextBuilder } from '../../utils/context';
import { safeResponseJson, extractContent, extractJson } from '../../utils/safeApi';
import { generateImage, buildCharacterImagePrompt, resolveCharacterReferenceImage } from '../../utils/imageGeneration';
import { deleteBlobRefIfUnreferenced, getBlobForRef, migrateDataUrlToRef } from '../../utils/blobRef';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import { processImage } from '../../utils/file';
import { DB } from '../../utils/db';

/**
 * 查手機 → 軌跡 → Moments：單一貼文池的角色視角（路線圖第 6 項）。看到的是這個角色看得到的整個池子，
 * 不只 TA 自己發的；「✦ 生成一條」寫進池子，作者是 TA、朋友可見。同步到私聊、存照片、重生照片、刪除
 * 只對 TA 自己發的有效。用戶在這裡只是偷看，不能按讚留言。
 */
interface Props {
    char: CharacterProfile;
    cover: string | undefined;
    onCommitCover: (next: string) => void;
    apiConfig: { baseUrl: string; apiKey: string; model: string } | null | undefined;
    imageGenConfig: ImageGenApiConfig | undefined;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const formatTimestamp = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const TrajectoryMomentsTab: React.FC<Props> = ({ char, cover, onCommitCover, apiConfig, imageGenConfig, addToast }) => {
    const { characters, npcs, userProfile, updateCharacter } = useOS();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const [generating, setGenerating] = useState(false);
    const [pool, setPool] = useState<MomentPost[]>([]);
    const [detailId, setDetailId] = useState<string | null>(null);

    const reload = useCallback(() => { DB.getAllMomentPosts().then(setPool).catch(() => setPool([])); }, []);
    useEffect(() => {
        reload();
        window.addEventListener(MOMENTS_CHANGED_EVENT, reload);
        return () => window.removeEventListener(MOMENTS_CHANGED_EVENT, reload);
    }, [reload]);
    const graph = useMemo(() => buildFriendGraph(characters, npcs), [characters, npcs]);
    const posts = useMemo(() => momentFeedFor(char.id, pool, graph), [pool, char.id, graph]);
    const ownPosts = useMemo(() => posts.filter(p => p.author.id === char.id), [posts, char.id]);
    const detailPost = posts.find(p => p.id === detailId) || null;
    const setDetailPost = (post: MomentPost | null) => setDetailId(post?.id || null);
    const userName = userProfile.name || '用戶';
    const nameOf = (actor: MomentActor) => actorDisplayName(actor, characters, npcs, userName);
    const avatarOf = (actor: MomentActor): string | undefined => {
        if (actor.kind === 'user') return userProfile.avatar;
        if (actor.kind === 'npc') return npcs.find(n => n.id === actor.id)?.avatar;
        if (actor.kind === 'character') return characters.find(c => c.id === actor.id)?.avatar;
        return undefined;
    };
    const [regeneratingPhoto, setRegeneratingPhoto] = useState(false);
    const [savingPhoto, setSavingPhoto] = useState(false);
    const [syncingToChat, setSyncingToChat] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

    useEffect(() => { setConfirmDeleteOpen(false); }, [detailPost?.id]);

    const handleCoverUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        try {
            const base64 = await processImage(file);
            onCommitCover(await migrateDataUrlToRef(base64));
        } catch (err: any) {
            addToast(err.message, 'error');
        }
    };

    const handleGenerate = async () => {
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('先在設置裡配置好 API', 'info'); return; }
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在設置裡開啟並配置好生圖 API', 'info');
            return;
        }
        setGenerating(true);
        try {
            const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
            const prompt = buildTrajectoryMomentsPrompt(roleSettingsBlock, ownPosts.map(p => ({ content: p.content })));
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
            const draft = parseTrajectoryMomentDraft(extractJson(extractContent(data)));
            if (!draft) { addToast('這次沒解析出動態內容，再試一次', 'error'); return; }

            const imagePrompt = buildCharacterImagePrompt(char, draft.imagePrompt);
            const referenceBlob = await resolveCharacterReferenceImage(char, { description: draft.content });
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt, referenceBlob || undefined);
            const image = await migrateDataUrlToRef(dataUrl);

            await createMomentPost({
                author: { kind: 'character', id: char.id, name: char.name },
                content: draft.content,
                images: [image],
                imagePrompt: draft.imagePrompt,
                source: 'manual',
            });
            trackEvent('角色视角生成一条朋友圈');
            addToast('這條朋友圈生成好了', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 生成失敗:', e);
            addToast('生成失敗，稍後再試', 'error');
        } finally {
            setGenerating(false);
        }
    };

    // 只重生成照片，文案/點贊/評論原樣不動——複用生成當下存下來的 imagePrompt，
    // 保證新照片還是貼合文案描述的場景，不會圖文不符。
    const handleRegeneratePhoto = async (post: MomentPost) => {
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在設置裡開啟並配置好生圖 API', 'info');
            return;
        }
        setRegeneratingPhoto(true);
        try {
            const imagePrompt = buildCharacterImagePrompt(char, post.imagePrompt || post.content);
            const referenceBlob = await resolveCharacterReferenceImage(char, { description: post.content });
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt, referenceBlob || undefined);
            const image = await migrateDataUrlToRef(dataUrl);
            const old = post.images[0];
            await updateMomentPostFields(post.id, { images: [image, ...post.images.slice(1)] });
            if (old) void deleteBlobRefIfUnreferenced(old);
            addToast('照片已重新生成', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 照片重新生成失敗:', e);
            addToast('生成失敗，稍後再試', 'error');
        } finally {
            setRegeneratingPhoto(false);
        }
    };

    const handleSavePhoto = async (post: MomentPost) => {
        setSavingPhoto(true);
        try {
            const blob = post.images[0] ? await getBlobForRef(post.images[0]) : null;
            if (!blob) { addToast('圖片已丟失，無法保存', 'error'); return; }
            const result = await shareOrDownloadBlob({ blob, fileName: `Moments-${post.id}.png`, shareTitle: `${char.name} 的朋友圈` });
            if (result !== 'cancelled') addToast(result === 'shared' ? '已打開保存面板' : '已保存到本地', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 照片保存失敗:', e);
            addToast('保存失敗，稍後再試', 'error');
        } finally {
            setSavingPhoto(false);
        }
    };

    const handleDelete = async (post: MomentPost) => {
        await deleteMomentPost(post, (charId, oldId) => updateCharacter(charId, cur => ({
            phoneState: {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                trajectoryMoments: (cur.phoneState?.trajectoryMoments || []).filter(p => p.id !== oldId),
            },
        })));
        setDetailPost(null);
        addToast('已刪除', 'success');
    };

    const handleSyncToChat = async (post: MomentPost) => {
        setSyncingToChat(true);
        try {
            const detailLines = [
                post.content,
                `贊：${displayLikeCount(char.id, post, graph)}`,
                ...visibleComments(char.id, post, graph).map(c => `${nameOf(c.actor)}：${c.content}`),
            ].filter(Boolean).join('\n');
            const messageId = await DB.saveMessage({
                charId: char.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的 Moments App] ${post.content}`,
                metadata: { phoneCard: { app: 'Moments', title: '一條朋友圈', detail: detailLines, image: post.images[0] } },
            } as any);
            await updateMomentPostFields(post.id, { syncedMessageId: messageId });
            addToast('已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 同步私聊失敗:', e);
            addToast('同步失敗，稍後再試', 'error');
        } finally {
            setSyncingToChat(false);
        }
    };

    // 這個角色看得到的讚和留言（微信式：只看得到自己朋友的）
    const renderInteractions = (post: MomentPost, className: string) => {
        const likeCount = displayLikeCount(char.id, post, graph);
        const comments = visibleComments(char.id, post, graph);
        if (likeCount === 0 && comments.length === 0) return null;
        const likeNames = visibleLikes(char.id, post, graph).map(l => nameOf(l.actor));
        return (
            <div className={`${className} rounded-lg px-2.5 py-1.5 flex flex-col gap-1`} style={{ background: 'rgba(255,255,255,0.04)' }}>
                {likeCount > 0 && (
                    <div className="flex items-start gap-1.5 text-[11px] text-white/60">
                        <Heart size={11} weight="fill" className="mt-0.5 shrink-0" style={{ color: '#f472b6' }} />
                        <span>{likeNames.length ? `${likeNames.join('、')}${post.legacyLikeCount ? ` 等 ${likeCount} 人` : ''}` : likeCount}</span>
                    </div>
                )}
                {comments.map(c => {
                    const target = c.replyTo ? post.comments.find(x => x.id === c.replyTo) : undefined;
                    return (
                        <div key={c.id} className="text-[11px] text-white/60 break-words">
                            <span className="font-bold" style={{ color: '#a78bfa' }}>{nameOf(c.actor)}</span>
                            {target && <><span className="text-white/35"> 回覆 </span><span className="font-bold" style={{ color: '#a78bfa' }}>{nameOf(target.actor)}</span></>}
                            ：{c.content}
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="flex-1 min-h-0 flex flex-col text-white/90">
            <div className="relative h-44 shrink-0 cursor-pointer" onClick={() => coverInputRef.current?.click()}>
                {cover ? (
                    <TokenImg value={cover} alt="" className="w-full h-full object-cover" />
                ) : (
                    <div className="w-full h-full" style={{ background: 'linear-gradient(135deg, #4c3a7a, #1a1626)' }} />
                )}
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(10,8,15,0.85) 100%)' }} />
                <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={handleCoverUpload} />

                <button onClick={(e) => { e.stopPropagation(); void handleGenerate(); }} disabled={generating} aria-label="生成一條朋友圈"
                    className="absolute top-3 right-4 w-8 h-8 rounded-full bg-black/30 flex items-center justify-center text-white/85 disabled:opacity-50">
                    {generating ? <CircleNotch size={15} weight="bold" className="animate-spin" /> : <Sparkle size={15} weight="bold" />}
                </button>

                <div className="absolute right-4 bottom-3 flex items-end gap-2">
                    <span className="text-[13px] font-bold text-white drop-shadow">{char.name}</span>
                    <TokenImg value={char.avatar} alt="" className="w-11 h-11 rounded-xl object-cover border-2 border-white/20" />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-4 pb-28 space-y-4">
                {posts.length === 0 && (
                    <div className="text-center pt-10 text-[12px] text-white/40">
                        還沒有動態，點右上角 ✦ 生成 {char.name} 的一條朋友圈
                    </div>
                )}
                {posts.map(post => (
                    <div key={post.id} className="flex gap-2.5">
                        <TokenImg value={avatarOf(post.author)} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0 bg-white/5" />
                        <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-bold" style={{ color: '#a78bfa' }}>{nameOf(post.author)}</div>
                            {post.content && <div className="text-[13px] leading-relaxed mt-0.5 text-white/85 whitespace-pre-wrap break-words">{post.content}</div>}
                            {post.images.length > 0 && (
                                <button onClick={() => setDetailPost(post)} className="mt-2 block w-32 aspect-square rounded-lg overflow-hidden bg-white/5 relative">
                                    <TokenImg value={post.images[0]} alt="" className="w-full h-full object-cover" />
                                    {post.images.length > 1 && <span className="absolute bottom-1 right-1 px-1.5 rounded bg-black/50 text-[10px]">+{post.images.length - 1}</span>}
                                </button>
                            )}
                            <button onClick={() => setDetailPost(post)} className="text-[10px] text-white/35 mt-1.5 block">{formatTimestamp(post.createdAt)}</button>
                            {renderInteractions(post, 'mt-1.5')}
                        </div>
                    </div>
                ))}
            </div>

            {detailPost && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" onClick={() => setDetailPost(null)}>
                    <div className="absolute inset-0 bg-black/60" />
                    <div className="relative w-full max-w-xs max-h-[85vh] overflow-y-auto no-scrollbar rounded-[2rem] shadow-2xl"
                        style={{ background: '#1a1626' }} onClick={e => e.stopPropagation()}>
                        <button onClick={() => setDetailPost(null)} aria-label="關閉"
                            className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80">
                            <X size={14} weight="bold" />
                        </button>
                        {detailPost.author.id === char.id && <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
                            {detailPost.images.length > 0 && <button onClick={() => void handleSavePhoto(detailPost)} disabled={savingPhoto} aria-label="保存照片"
                                className="w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80 disabled:opacity-50">
                                <DownloadSimple size={14} weight="bold" />
                            </button>}
                            {detailPost.images.length > 0 && <button onClick={() => void handleRegeneratePhoto(detailPost)} disabled={regeneratingPhoto} aria-label="重新生成照片"
                                className="w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80 disabled:opacity-50">
                                <ArrowsClockwise size={14} weight="bold" className={regeneratingPhoto ? 'animate-spin' : ''} />
                            </button>}
                            <button onClick={() => setConfirmDeleteOpen(true)} aria-label="刪除"
                                className="w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-rose-200">
                                <Trash size={14} weight="bold" />
                            </button>
                        </div>}
                        {confirmDeleteOpen && (
                            <div className="absolute inset-0 z-20 flex items-center justify-center p-6 rounded-[2rem]" style={{ background: 'rgba(10,8,15,0.94)' }}>
                                <div className="text-center">
                                    <div className="text-[13px] font-bold text-white/90 mb-1">刪除這條朋友圈？</div>
                                    <div className="text-[11px] text-white/45 mb-4">刪除後無法恢復</div>
                                    <div className="flex gap-2 justify-center">
                                        <button onClick={() => setConfirmDeleteOpen(false)}
                                            className="px-4 py-2 rounded-xl text-[12px] font-bold" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}>
                                            取消
                                        </button>
                                        <button onClick={() => void handleDelete(detailPost)}
                                            className="px-4 py-2 rounded-xl text-[12px] font-bold" style={{ background: 'rgba(244,63,94,0.18)', color: '#fca5a5', border: '1px solid rgba(244,63,94,0.35)' }}>
                                            確認刪除
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                        {detailPost.images.length > 0 ? (
                            <div className="aspect-[4/5] bg-white/5">
                                <TokenImg value={detailPost.images[0]} alt="" className="w-full h-full object-cover" />
                            </div>
                        ) : <div className="h-12" />}
                        {detailPost.images.length > 1 && (
                            <div className="grid grid-cols-4 gap-1 px-5 pt-2">
                                {detailPost.images.slice(1).map((img, i) => (
                                    <TokenImg key={i} value={img} alt="" className="aspect-square w-full object-cover rounded-md bg-white/5" />
                                ))}
                            </div>
                        )}
                        <div className="px-5 pt-4 pb-2">
                            <div className="text-[12px] font-bold mb-1" style={{ color: '#a78bfa' }}>{nameOf(detailPost.author)}</div>
                            <div className="text-[13px] leading-relaxed text-white/90 whitespace-pre-wrap break-words">{detailPost.content}</div>
                            <div className="text-[11px] text-white/40 mt-1.5">{formatTimestamp(detailPost.createdAt)}</div>
                        </div>
                        {renderInteractions(detailPost, 'mx-5 mb-2')}
                        {detailPost.author.id === char.id ? <div className="px-5 pb-5 pt-1">
                            <button onClick={() => void handleSyncToChat(detailPost)} disabled={syncingToChat || !!detailPost.syncedMessageId}
                                className="w-full py-3 rounded-2xl text-[12px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                                style={{ background: 'rgba(167,139,250,0.14)', color: '#c4b5fd', border: '1px solid rgba(167,139,250,0.25)' }}>
                                <PaperPlaneTilt size={15} weight="bold" />
                                {detailPost.syncedMessageId ? '已同步到私聊' : (syncingToChat ? '同步中…' : '同步到私聊')}
                            </button>
                        </div> : <div className="h-4" />}
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrajectoryMomentsTab;
