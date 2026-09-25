import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, ChatCircle, Camera, Trash, Globe, LockSimple, X, Plus } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import TokenImg from '../os/TokenImg';
import Modal from '../os/Modal';
import type { MomentActor, MomentComment, MomentPost, MomentVisibility } from '../../types';
import {
    actorDisplayName, actorFor, buildFriendGraph, displayLikeCount, momentFeedFor, USER_ID, visibleComments, visibleLikes,
} from '../../utils/momentsPool';
import {
    addMomentComment, createMomentPost, deleteMomentComment, deleteMomentPost, MOMENTS_CHANGED_EVENT, toggleMomentLike,
} from '../../utils/momentsStore';
import { replyAsAuthor, shouldAuthorReply } from '../../utils/momentsReply';
import { formatChatListTimestamp } from '../../utils/chatListTime';
import { processImage } from '../../utils/file';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import { trackEvent } from '../../utils/analytics';

/**
 * 單一貼文池的時間線（路線圖第 6 項）。viewerId 決定是誰的視角：
 * - 'user'：Chat「動態」分頁，可以發文、按讚、留言；
 * - 角色 id：只能看、不能互動（查手機的軌跡 Moments 是深色版面，自己畫，只共用 utils/momentsPool 的邏輯）。
 * 誰看得到什麼全在 utils/momentsPool.ts。
 */

export const MAX_MOMENT_IMAGES = 9;

interface Props {
    viewerId: string;
    /** 用戶視角才能發文和互動 */
    interactive: boolean;
    /** 時間線上方的內容（封面、生成按鈕…） */
    header?: React.ReactNode;
    emptyHint?: string;
}

const MomentsFeed: React.FC<Props> = ({ viewerId, interactive, header, emptyHint }) => {
    const { characters, npcs, userProfile, apiConfig, addToast, updateCharacter } = useOS();
    const [posts, setPosts] = useState<MomentPost[] | null>(null);
    const [composerOpen, setComposerOpen] = useState(false);
    const [commentTarget, setCommentTarget] = useState<{ postId: string; replyTo?: MomentComment } | null>(null);
    const [commentDraft, setCommentDraft] = useState('');
    const [confirmDelete, setConfirmDelete] = useState<MomentPost | null>(null);
    const [viewer, setViewer] = useState<string | null>(null);

    const reload = useCallback(() => {
        DB.getAllMomentPosts().then(setPosts).catch(() => setPosts([]));
    }, []);
    useEffect(() => {
        reload();
        window.addEventListener(MOMENTS_CHANGED_EVENT, reload);
        return () => window.removeEventListener(MOMENTS_CHANGED_EVENT, reload);
    }, [reload]);

    const graph = useMemo(() => buildFriendGraph(characters, npcs), [characters, npcs]);
    const feed = useMemo(() => (posts ? momentFeedFor(viewerId, posts, graph) : null), [posts, viewerId, graph]);
    const userName = userProfile.name || '我';
    const nameOf = (actor: MomentActor) => (actor.id === viewerId && viewerId === USER_ID ? '我' : actorDisplayName(actor, characters, npcs, userName));
    const avatarOf = (actor: MomentActor): string | undefined => {
        if (actor.kind === 'user') return userProfile.avatar;
        if (actor.kind === 'npc') return npcs.find(n => n.id === actor.id)?.avatar;
        if (actor.kind === 'character') return characters.find(c => c.id === actor.id)?.avatar;
        return undefined;
    };
    const me = useMemo(() => actorFor(USER_ID, characters, npcs, userName)!, [characters, npcs, userName]);

    const handleLike = async (post: MomentPost) => {
        const liked = post.likes.some(l => l.actor.id === USER_ID);
        await toggleMomentLike(post.id, me);
        if (!liked) trackEvent('朋友圈点赞');
    };

    const submitComment = async () => {
        if (!commentTarget) return;
        const text = commentDraft.trim();
        if (!text) return;
        const post = posts?.find(p => p.id === commentTarget.postId);
        const comment = await addMomentComment(commentTarget.postId, me, text, commentTarget.replyTo?.id);
        setCommentDraft('');
        setCommentTarget(null);
        if (!comment || !post) return;
        trackEvent('朋友圈留言');
        // 用戶在角色的貼文底下留言 → 作者過一會兒回
        if (shouldAuthorReply(post, comment)) {
            const char = characters.find(c => c.id === post.author.id);
            if (char) {
                const fresh = await DB.getMomentPost(post.id);
                void replyAsAuthor({
                    char, post: fresh || post, userComment: comment, userName, apiConfig, characters, npcs,
                    delayMs: 3000 + Math.random() * 5000,
                });
            }
        }
    };

    const removeLegacy = (charId: string, oldId: string) => {
        updateCharacter(charId, cur => ({
            phoneState: {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                trajectoryMoments: (cur.phoneState?.trajectoryMoments || []).filter(p => p.id !== oldId),
            },
        }));
    };

    const doDelete = async () => {
        if (!confirmDelete) return;
        await deleteMomentPost(confirmDelete, removeLegacy);
        setConfirmDelete(null);
        addToast('已刪除', 'success');
    };

    return (
        <div className="relative">
            {header}
            {interactive && (
                <div className="px-4 pt-3">
                    <button onClick={() => setComposerOpen(true)}
                        className="w-full flex items-center gap-3 bg-white rounded-2xl px-4 py-3 border border-slate-100 shadow-sm active:scale-[0.99] transition-transform text-left">
                        <TokenImg value={userProfile.avatar} className="w-9 h-9 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                        <span className="flex-1 text-sm text-slate-400">分享這一刻…</span>
                        <Camera size={20} className="text-slate-400" />
                    </button>
                </div>
            )}

            {feed === null ? (
                <div className="py-16 text-center text-xs text-slate-400">載入中…</div>
            ) : feed.length === 0 ? (
                <div className="py-16 px-8 text-center text-xs text-slate-400 leading-relaxed">{emptyHint || '還沒有動態'}</div>
            ) : (
                <div className="divide-y divide-slate-100">
                    {feed.map(post => {
                        const likes = visibleLikes(viewerId, post, graph);
                        const comments = visibleComments(viewerId, post, graph);
                        const likeCount = displayLikeCount(viewerId, post, graph);
                        const isOwn = post.author.id === viewerId;
                        const iLiked = post.likes.some(l => l.actor.id === USER_ID);
                        return (
                            <article key={post.id} className="flex gap-3 px-4 py-4">
                                <TokenImg value={avatarOf(post.author)} className="w-10 h-10 rounded-lg object-cover bg-slate-100 shrink-0" alt="" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-indigo-900/80">{nameOf(post.author)}</div>
                                    {post.content && <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap break-words leading-relaxed">{post.content}</p>}
                                    {post.images.length > 0 && (
                                        <div className={`mt-2 grid gap-1 ${post.images.length === 1 ? 'grid-cols-1 max-w-[70%]' : post.images.length === 4 ? 'grid-cols-2 max-w-[66%]' : 'grid-cols-3'}`}>
                                            {post.images.map((img, i) => (
                                                <button key={i} onClick={() => setViewer(img)} className={post.images.length === 1 ? '' : 'aspect-square'}>
                                                    <TokenImg value={img} className={`w-full ${post.images.length === 1 ? 'max-h-64 object-cover rounded-lg' : 'h-full object-cover rounded-md'} bg-slate-100`} alt="" />
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
                                        <span>{formatChatListTimestamp(post.createdAt)}</span>
                                        {isOwn && post.visibility.mode !== 'friends' && (
                                            <span className="flex items-center gap-0.5">
                                                {post.visibility.mode === 'public' ? <Globe size={11} /> : <LockSimple size={11} />}
                                                {post.visibility.mode === 'public' ? '公開' : `指定 ${post.visibility.allow?.length || 0} 人`}
                                            </span>
                                        )}
                                        {isOwn && interactive && (
                                            <button onClick={() => setConfirmDelete(post)} className="text-slate-400 hover:text-rose-500" aria-label="刪除">
                                                <Trash size={13} />
                                            </button>
                                        )}
                                        <span className="flex-1" />
                                        {interactive && (
                                            <>
                                                <button onClick={() => void handleLike(post)} aria-label={iLiked ? '取消讚' : '讚'}
                                                    className={`flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 ${iLiked ? 'text-rose-500' : 'text-slate-500'}`}>
                                                    <Heart size={14} weight={iLiked ? 'fill' : 'regular'} />
                                                </button>
                                                <button onClick={() => { setCommentTarget({ postId: post.id }); setCommentDraft(''); }} aria-label="留言"
                                                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-slate-50 text-slate-500">
                                                    <ChatCircle size={14} />
                                                </button>
                                            </>
                                        )}
                                    </div>
                                    {(likeCount > 0 || comments.length > 0) && (
                                        <div className="mt-2 rounded-md bg-slate-50 text-[12px] leading-relaxed">
                                            {likeCount > 0 && (
                                                <div className="px-2.5 py-1.5 flex items-start gap-1.5 text-indigo-900/70">
                                                    <Heart size={12} weight="fill" className="mt-1 shrink-0 text-rose-400" />
                                                    <span className="break-words">
                                                        {likes.map(l => nameOf(l.actor)).join('、')}
                                                        {post.legacyLikeCount ? `${likes.length ? ' 等 ' : ''}${likeCount} 人` : ''}
                                                    </span>
                                                </div>
                                            )}
                                            {comments.length > 0 && (
                                                <div className={`px-2.5 py-1.5 space-y-1 ${likeCount > 0 ? 'border-t border-slate-100' : ''}`}>
                                                    {comments.map(c => {
                                                        const target = c.replyTo ? post.comments.find(x => x.id === c.replyTo) : undefined;
                                                        const mine = c.actor.id === USER_ID;
                                                        return (
                                                            <div key={c.id} className="flex items-start gap-1 group">
                                                                <button
                                                                    disabled={!interactive || mine}
                                                                    onClick={() => { setCommentTarget({ postId: post.id, replyTo: c }); setCommentDraft(''); }}
                                                                    className="flex-1 text-left text-slate-700 break-words disabled:cursor-default">
                                                                    <span className="font-bold text-indigo-900/70">{nameOf(c.actor)}</span>
                                                                    {target && <><span className="text-slate-400"> 回覆 </span><span className="font-bold text-indigo-900/70">{nameOf(target.actor)}</span></>}
                                                                    <span>：{c.content}</span>
                                                                </button>
                                                                {interactive && mine && (
                                                                    <button onClick={() => void deleteMomentComment(post.id, c.id)} aria-label="刪除留言" className="shrink-0 text-slate-300 hover:text-rose-400 pt-0.5">
                                                                        <X size={11} />
                                                                    </button>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}

            {/* 留言輸入列 */}
            {commentTarget && (
                // 釘在 --app-height 的底邊（鍵盤升起時就是鍵盤上方），不用 bottom-0：iOS 全屏 PWA 的版面視窗不跟鍵盤變矮
                <div className="sully-chat-inputbar fixed inset-x-0 z-50 bg-white border-t border-slate-200 px-3 pt-2 pb-[calc(var(--safe-bottom)+0.5rem)] flex items-center gap-2"
                    style={{ top: 'var(--app-height, 100%)', transform: 'translateY(-100%)' }}>
                    <input
                        autoFocus
                        value={commentDraft}
                        onChange={e => setCommentDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submitComment(); }}
                        placeholder={commentTarget.replyTo ? `回覆 ${nameOf(commentTarget.replyTo.actor)}` : '留言…'}
                        className="flex-1 bg-slate-100 rounded-full px-4 py-2 text-sm"
                    />
                    <button onClick={() => void submitComment()} disabled={!commentDraft.trim()}
                        className="px-4 py-2 rounded-full bg-primary text-white text-xs font-bold disabled:opacity-40">發送</button>
                    <button onClick={() => setCommentTarget(null)} className="p-2 text-slate-400" aria-label="取消"><X size={16} /></button>
                </div>
            )}

            {interactive && (
                <MomentComposer
                    isOpen={composerOpen}
                    onClose={() => setComposerOpen(false)}
                    onPost={async (content, images, visibility) => {
                        await createMomentPost({ author: me, content, images, visibility });
                        trackEvent('朋友圈发文', { visibility: visibility.mode, hasImage: images.length > 0 ? 'yes' : 'no' });
                        setComposerOpen(false);
                        addToast('發出去了', 'success');
                    }}
                />
            )}

            <Modal isOpen={!!confirmDelete} title="刪除這條動態？" onClose={() => setConfirmDelete(null)}
                footer={<div className="flex gap-2 w-full">
                    <button onClick={() => setConfirmDelete(null)} className="flex-1 py-3 rounded-2xl bg-slate-100 text-slate-600 font-bold">取消</button>
                    <button onClick={() => void doDelete()} className="flex-1 py-3 rounded-2xl bg-rose-500 text-white font-bold">刪除</button>
                </div>}>
                <p className="text-sm text-slate-500">刪掉之後留言和讚也會一起消失。</p>
            </Modal>

            {viewer && (
                <div className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center" onClick={() => setViewer(null)}>
                    <TokenImg value={viewer} className="max-w-full max-h-full object-contain" alt="" />
                </div>
            )}
        </div>
    );
};

// ── 發文 ──────────────────────────────────────────────────────────────

const MomentComposer: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    onPost: (content: string, images: string[], visibility: MomentVisibility) => Promise<void>;
}> = ({ isOpen, onClose, onPost }) => {
    const { characters, npcs, addToast } = useOS();
    const [content, setContent] = useState('');
    const [images, setImages] = useState<string[]>([]);
    const [mode, setMode] = useState<MomentVisibility['mode']>('friends');
    const [allow, setAllow] = useState<string[]>([]);
    const [posting, setPosting] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        setContent(''); setImages([]); setMode('friends'); setAllow([]); setPosting(false);
    }, [isOpen]);

    const addImages = async (files: FileList | null) => {
        if (!files) return;
        const room = MAX_MOMENT_IMAGES - images.length;
        const picked = Array.from(files).slice(0, room);
        try {
            const refs: string[] = [];
            for (const f of picked) refs.push(await migrateDataUrlToRef(await processImage(f, { maxWidth: 1280, quality: 0.85, forceJpeg: true })));
            setImages(prev => [...prev, ...refs].slice(0, MAX_MOMENT_IMAGES));
        } catch (e: any) {
            addToast(e?.message || '圖片讀取失敗', 'error');
        }
    };

    const canPost = (content.trim() || images.length > 0) && (mode !== 'custom' || allow.length > 0) && !posting;
    const people = [
        ...characters.map(c => ({ id: c.id, name: c.name, avatar: c.avatar, npc: false })),
        ...npcs.map(n => ({ id: n.id, name: n.name, avatar: n.avatar, npc: true })),
    ];

    return (
        <Modal isOpen={isOpen} title="發動態" onClose={onClose}
            footer={<button disabled={!canPost}
                onClick={async () => { setPosting(true); try { await onPost(content, images, mode === 'custom' ? { mode, allow } : { mode }); } finally { setPosting(false); } }}
                className="w-full py-3 rounded-2xl bg-primary text-white font-bold disabled:opacity-40">{posting ? '發送中…' : '發表'}</button>}>
            <div className="space-y-3">
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} placeholder="這一刻的想法…"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none" />
                <div className="grid grid-cols-3 gap-1.5">
                    {images.map((img, i) => (
                        <div key={i} className="relative aspect-square">
                            <TokenImg value={img} className="w-full h-full object-cover rounded-lg bg-slate-100" alt="" />
                            <button onClick={() => setImages(prev => prev.filter((_, j) => j !== i))} aria-label="移除這張"
                                className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/50 text-white flex items-center justify-center"><X size={11} /></button>
                        </div>
                    ))}
                    {images.length < MAX_MOMENT_IMAGES && (
                        <button onClick={() => fileRef.current?.click()} aria-label="加照片"
                            className="aspect-square rounded-lg border-2 border-dashed border-slate-200 text-slate-400 flex items-center justify-center"><Plus size={22} /></button>
                    )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={e => { void addImages(e.target.files); e.target.value = ''; }} />
                <div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5">誰可以看</div>
                    <div className="flex gap-1.5">
                        {([['friends', '朋友可見'], ['public', '公開'], ['custom', '指定的人']] as const).map(([key, label]) => (
                            <button key={key} onClick={() => setMode(key)}
                                className={`flex-1 py-2 rounded-xl text-xs font-bold border ${mode === key ? 'bg-violet-100 border-violet-300 text-violet-700' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>{label}</button>
                        ))}
                    </div>
                    <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
                        {mode === 'friends' ? '所有角色，以及關係清單裡有你的 NPC。' : mode === 'public' ? '所有角色和 NPC 都看得到。' : '只有下面勾選的人看得到。'}
                    </p>
                    {mode === 'custom' && (
                        <div className="mt-2 max-h-48 overflow-y-auto no-scrollbar space-y-1">
                            {people.map(p => {
                                const on = allow.includes(p.id);
                                return (
                                    <button key={p.id} onClick={() => setAllow(prev => on ? prev.filter(x => x !== p.id) : [...prev, p.id])}
                                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl border text-left ${on ? 'bg-violet-50 border-violet-200' : 'bg-white border-slate-100'}`}>
                                        <TokenImg value={p.avatar} className="w-7 h-7 rounded-full object-cover bg-slate-100" alt="" />
                                        <span className="flex-1 text-xs font-bold text-slate-700 truncate">{p.name}{p.npc && <span className="ml-1 text-[9px] text-teal-500">NPC</span>}</span>
                                        <span className={`w-4 h-4 rounded border ${on ? 'bg-violet-500 border-violet-500' : 'border-slate-300'}`} />
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
};

export default MomentsFeed;
