import React, { useRef, useState } from 'react';
import { ArrowsClockwise, CircleNotch, DownloadSimple, Heart, PaperPlaneTilt, Sparkle, X } from '@phosphor-icons/react';
import type { CharacterProfile, ImageGenApiConfig, TrajectoryMomentPost } from '../../types';
import TokenImg from '../os/TokenImg';
import {
    buildTrajectoryMomentsPrompt, createTrajectoryMomentPost, parseTrajectoryMomentDraft,
} from '../../utils/trajectory';
import { ContextBuilder } from '../../utils/context';
import { safeResponseJson, extractContent, extractJson } from '../../utils/safeApi';
import { generateImage, buildCharacterImagePrompt } from '../../utils/imageGeneration';
import { deleteBlobRefIfUnreferenced, getBlobForRef, migrateDataUrlToRef } from '../../utils/blobRef';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import { processImage } from '../../utils/file';
import { DB } from '../../utils/db';

interface Props {
    char: CharacterProfile;
    posts: TrajectoryMomentPost[];
    onCommit: (next: TrajectoryMomentPost[]) => void;
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

const TrajectoryMomentsTab: React.FC<Props> = ({ char, posts, onCommit, cover, onCommitCover, apiConfig, imageGenConfig, addToast }) => {
    const coverInputRef = useRef<HTMLInputElement>(null);
    const [generating, setGenerating] = useState(false);
    const [detailPost, setDetailPost] = useState<TrajectoryMomentPost | null>(null);
    const [regeneratingPhoto, setRegeneratingPhoto] = useState(false);
    const [savingPhoto, setSavingPhoto] = useState(false);
    const [syncingToChat, setSyncingToChat] = useState(false);

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
        if (!apiConfig?.baseUrl || !apiConfig?.apiKey) { addToast('先在设置里配置好 API', 'info'); return; }
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在设置里开启并配置好生图 API', 'info');
            return;
        }
        setGenerating(true);
        try {
            const roleSettingsBlock = ContextBuilder.buildRoleSettingsContext(char, { skipMemories: true });
            const prompt = buildTrajectoryMomentsPrompt(roleSettingsBlock, posts);
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
            if (!draft) { addToast('这次没解析出动态内容，再试一次', 'error'); return; }

            const imagePrompt = buildCharacterImagePrompt(char, draft.imagePrompt);
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt);
            const image = await migrateDataUrlToRef(dataUrl);

            const post = createTrajectoryMomentPost(draft, image);
            onCommit([post, ...posts]);
            addToast('这条朋友圈生成好了', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 生成失败:', e);
            addToast('生成失败，稍后再试', 'error');
        } finally {
            setGenerating(false);
        }
    };

    // 只重生成照片，文案/点赞/评论原样不动——复用生成当下存下来的 imagePrompt，
    // 保证新照片还是贴合文案描述的场景，不会图文不符。
    const handleRegeneratePhoto = async (post: TrajectoryMomentPost) => {
        if (!imageGenConfig?.charImageGenEnabled || !imageGenConfig?.baseUrl || !imageGenConfig?.model) {
            addToast('先在设置里开启并配置好生图 API', 'info');
            return;
        }
        setRegeneratingPhoto(true);
        try {
            const imagePrompt = buildCharacterImagePrompt(char, post.imagePrompt);
            const { dataUrl } = await generateImage(imageGenConfig, imagePrompt);
            const image = await migrateDataUrlToRef(dataUrl);
            const next = posts.map(p => p.id === post.id ? { ...p, image } : p);
            onCommit(next);
            setDetailPost(prev => prev && prev.id === post.id ? { ...prev, image } : prev);
            void deleteBlobRefIfUnreferenced(post.image);
            addToast('照片已重新生成', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 照片重新生成失败:', e);
            addToast('生成失败，稍后再试', 'error');
        } finally {
            setRegeneratingPhoto(false);
        }
    };

    const handleSavePhoto = async (post: TrajectoryMomentPost) => {
        setSavingPhoto(true);
        try {
            const blob = await getBlobForRef(post.image);
            if (!blob) { addToast('图片已丢失，无法保存', 'error'); return; }
            const result = await shareOrDownloadBlob({ blob, fileName: `Moments-${post.id}.png`, shareTitle: `${char.name} 的朋友圈` });
            if (result !== 'cancelled') addToast(result === 'shared' ? '已打开保存面板' : '已保存到本地', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 照片保存失败:', e);
            addToast('保存失败，稍后再试', 'error');
        } finally {
            setSavingPhoto(false);
        }
    };

    const handleSyncToChat = async (post: TrajectoryMomentPost) => {
        setSyncingToChat(true);
        try {
            const detailLines = [
                post.content,
                `赞：${post.likes}`,
                ...post.comments.map(c => `${c.authorName}：${c.content}`),
            ].filter(Boolean).join('\n');
            const messageId = await DB.saveMessage({
                charId: char.id, role: 'assistant', type: 'phone_card',
                content: `[你手机的 Moments App] ${post.content}`,
                metadata: { phoneCard: { app: 'Moments', title: '一条朋友圈', detail: detailLines, image: post.image } },
            } as any);
            const next = posts.map(p => p.id === post.id ? { ...p, syncedMessageId: messageId } : p);
            onCommit(next);
            setDetailPost(prev => prev && prev.id === post.id ? { ...prev, syncedMessageId: messageId } : prev);
            addToast('已同步到私聊', 'success');
        } catch (e) {
            console.warn('[Trajectory] Moments 同步私聊失败:', e);
            addToast('同步失败，稍后再试', 'error');
        } finally {
            setSyncingToChat(false);
        }
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

                <button onClick={(e) => { e.stopPropagation(); void handleGenerate(); }} disabled={generating} aria-label="生成一条朋友圈"
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
                        还没有动态，点右上角 ✦ 生成 {char.name} 的一条朋友圈
                    </div>
                )}
                {posts.map(post => (
                    <div key={post.id} className="flex gap-2.5">
                        <TokenImg value={char.avatar} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                        <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-bold" style={{ color: '#a78bfa' }}>{char.name}</div>
                            <div className="text-[13px] leading-relaxed mt-0.5 text-white/85">{post.content}</div>
                            <button onClick={() => setDetailPost(post)} className="mt-2 block w-32 aspect-square rounded-lg overflow-hidden bg-white/5">
                                <TokenImg value={post.image} alt="" className="w-full h-full object-cover" />
                            </button>
                            <div className="text-[10px] text-white/35 mt-1.5">{formatTimestamp(post.timestamp)}</div>
                            {(post.likes > 0 || post.comments.length > 0) && (
                                <div className="mt-1.5 rounded-lg px-2.5 py-1.5 flex flex-col gap-1" style={{ background: 'rgba(255,255,255,0.04)' }}>
                                    {post.likes > 0 && (
                                        <div className="flex items-center gap-1.5 text-[11px] text-white/60">
                                            <Heart size={11} weight="fill" style={{ color: '#f472b6' }} /> {post.likes}
                                        </div>
                                    )}
                                    {post.comments.map(c => (
                                        <div key={c.id} className="text-[11px] text-white/60">
                                            <span className="font-bold" style={{ color: '#a78bfa' }}>{c.authorName}</span>：{c.content}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {detailPost && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" onClick={() => setDetailPost(null)}>
                    <div className="absolute inset-0 bg-black/60" />
                    <div className="relative w-full max-w-xs max-h-[85vh] overflow-y-auto no-scrollbar rounded-[2rem] shadow-2xl"
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
                        </div>
                        <div className="aspect-[4/5] bg-white/5">
                            <TokenImg value={detailPost.image} alt="" className="w-full h-full object-cover" />
                        </div>
                        <div className="px-5 pt-4 pb-2">
                            <div className="text-[13px] leading-relaxed text-white/90">{detailPost.content}</div>
                            <div className="text-[11px] text-white/40 mt-1.5">{formatTimestamp(detailPost.timestamp)}</div>
                        </div>
                        {(detailPost.likes > 0 || detailPost.comments.length > 0) && (
                            <div className="mx-5 mb-2 rounded-lg px-2.5 py-2 flex flex-col gap-1" style={{ background: 'rgba(255,255,255,0.04)' }}>
                                {detailPost.likes > 0 && (
                                    <div className="flex items-center gap-1.5 text-[11px] text-white/60">
                                        <Heart size={11} weight="fill" style={{ color: '#f472b6' }} /> {detailPost.likes}
                                    </div>
                                )}
                                {detailPost.comments.map(c => (
                                    <div key={c.id} className="text-[11px] text-white/60">
                                        <span className="font-bold" style={{ color: '#a78bfa' }}>{c.authorName}</span>：{c.content}
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="px-5 pb-5 pt-1">
                            <button onClick={() => void handleSyncToChat(detailPost)} disabled={syncingToChat || !!detailPost.syncedMessageId}
                                className="w-full py-3 rounded-2xl text-[12px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
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

export default TrajectoryMomentsTab;
