import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Heart, ChatCircle, Trash, Globe, LockSimple, X, Plus, ArrowsClockwise, CaretLeft, DotsThree, PencilSimple, ImageSquare } from '@phosphor-icons/react';
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
    updateMomentPostFields,
} from '../../utils/momentsStore';
import { replyAsAuthor, shouldAuthorReply } from '../../utils/momentsReply';
import { generateCharacterMoment, pickRefreshPosters } from '../../utils/momentsGenerate';
import { normalizeMomentsSettings } from '../../utils/momentsSettings';
import { formatChatListTimestamp } from '../../utils/chatListTime';
import { processImage } from '../../utils/file';
import { deleteBlobRefIfUnreferenced, migrateDataUrlToRef } from '../../utils/blobRef';
import { trackEvent } from '../../utils/analytics';

/**
 * 單一貼文池的用戶視角時間線（路線圖第 6 項）：Chat 主頁「動態」分頁和 Dock 上的「朋友圈」App 共用。
 * - 頁頂：封面（點一下換）、頭像、名字、選填格言；右上 ↻ 讓隨機幾位角色各發一篇、＋ 發文。
 * - 自己的貼文 … 選單可以編輯、刪除；別人的可以按讚、留言、回覆留言。
 * 誰看得到什麼全在 utils/momentsPool.ts。查手機的軌跡 Moments（角色視角）是深色版面，自己畫。
 */

export const MAX_MOMENT_IMAGES = 9;

interface Props {
    /** 有傳就在封面左上角顯示返回鍵（整頁的朋友圈 App） */
    onBack?: () => void;
    emptyHint?: string;
}

const MomentsFeed: React.FC<Props> = ({ onBack, emptyHint }) => {
    const { characters, npcs, userProfile, apiConfig, addToast, updateCharacter } = useOS();
    const viewerId = USER_ID;
    const [posts, setPosts] = useState<MomentPost[] | null>(null);
    const [composer, setComposer] = useState<{ editing?: MomentPost } | null>(null);
    const [commentTarget, setCommentTarget] = useState<{ postId: string; replyTo?: MomentComment } | null>(null);
    const [commentDraft, setCommentDraft] = useState('');
    const [confirmDelete, setConfirmDelete] = useState<MomentPost | null>(null);
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [viewer, setViewer] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

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
    const nameOf = (actor: MomentActor) => (actor.id === USER_ID ? '我' : actorDisplayName(actor, characters, npcs, userName));
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

    // ↻：隨機挑 1～3 位角色各發一篇（朋友圈互動設定裡被單獨關掉的角色不挑）
    const handleRefresh = async () => {
        if (refreshing) return;
        const disabled = new Set(normalizeMomentsSettings(userProfile.momentsSettings).disabledPosterIds);
        const posters = pickRefreshPosters(characters.filter(c => !disabled.has(c.id) && !c.chatBlock));
        if (posters.length === 0) { addToast('還沒有可以發文的角色', 'info'); return; }
        setRefreshing(true);
        trackEvent('朋友圈重整让角色发文');
        let ok = 0;
        const failed: string[] = [];
        try {
            for (const char of posters) {
                try {
                    const recent = (posts || []).filter(p => p.author.id === char.id).slice(0, 5);
                    await generateCharacterMoment({ char, apiConfig, recent });
                    ok += 1;
                } catch (e) {
                    console.warn(`[Moments] ${char.name} 發文失敗`, e);
                    failed.push(char.name);
                }
            }
        } finally {
            setRefreshing(false);
        }
        if (ok > 0) addToast(`${ok} 篇新動態`, 'success');
        if (failed.length) addToast(`${failed.join('、')} 這次沒發出來`, 'error');
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
        <div className="relative bg-white min-h-full">
            <ProfileHeader
                onBack={onBack}
                refreshing={refreshing}
                onRefresh={() => void handleRefresh()}
                onCompose={() => setComposer({})}
            />

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
                            <article key={post.id} className="px-5 py-5">
                                <div className="flex items-center gap-3">
                                    <TokenImg value={avatarOf(post.author)} className="w-11 h-11 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                    <div className="flex-1 min-w-0 text-[15px] font-semibold text-slate-800 truncate">{nameOf(post.author)}</div>
                                    {isOwn && (
                                        <div className="relative">
                                            <button onClick={() => setMenuFor(menuFor === post.id ? null : post.id)} aria-label="更多" className="p-1.5 text-slate-400">
                                                <DotsThree size={22} weight="bold" />
                                            </button>
                                            {menuFor === post.id && (
                                                <>
                                                    <div className="fixed inset-0 z-30" onClick={() => setMenuFor(null)} />
                                                    <div className="absolute right-0 top-8 z-40 w-28 bg-white rounded-xl shadow-lg border border-slate-100 overflow-hidden text-sm">
                                                        <button onClick={() => { setMenuFor(null); setComposer({ editing: post }); }}
                                                            className="w-full flex items-center gap-2 px-3 py-2.5 text-slate-700 hover:bg-slate-50"><PencilSimple size={15} />編輯</button>
                                                        <button onClick={() => { setMenuFor(null); setConfirmDelete(post); }}
                                                            className="w-full flex items-center gap-2 px-3 py-2.5 text-rose-500 hover:bg-rose-50"><Trash size={15} />刪除</button>
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                                {post.content && <p className="mt-3 text-[15px] text-slate-700 whitespace-pre-wrap break-words leading-relaxed">{post.content}</p>}
                                {post.images.length > 0 && (
                                    <div className={`mt-3 grid gap-1.5 ${post.images.length === 1 ? 'grid-cols-1 max-w-[75%]' : post.images.length === 4 ? 'grid-cols-2 max-w-[70%]' : 'grid-cols-3'}`}>
                                        {post.images.map((img, i) => (
                                            <button key={i} onClick={() => setViewer(img)} className={post.images.length === 1 ? '' : 'aspect-square'}>
                                                <TokenImg value={img} className={`w-full ${post.images.length === 1 ? 'max-h-72 object-cover rounded-2xl' : 'h-full object-cover rounded-lg'} bg-slate-100`} alt="" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                                    <span>{formatChatListTimestamp(post.createdAt)}</span>
                                    {isOwn && post.visibility.mode !== 'friends' && (
                                        <span className="flex items-center gap-0.5">
                                            {post.visibility.mode === 'public' ? <Globe size={12} /> : <LockSimple size={12} />}
                                            {post.visibility.mode === 'public' ? '公開' : `指定 ${post.visibility.allow?.length || 0} 人`}
                                        </span>
                                    )}
                                    <span className="flex-1" />
                                    <button onClick={() => void handleLike(post)} aria-label={iLiked ? '取消讚' : '讚'}
                                        className={`p-1 ${iLiked ? 'text-rose-500' : 'text-slate-400'}`}>
                                        <Heart size={20} weight={iLiked ? 'fill' : 'regular'} />
                                    </button>
                                    <button onClick={() => { setCommentTarget({ postId: post.id }); setCommentDraft(''); }} aria-label="留言"
                                        className="p-1 text-slate-400">
                                        <ChatCircle size={20} />
                                    </button>
                                </div>
                                {likeCount > 0 && (
                                    <div className="mt-2 flex items-start gap-1.5 text-[13px] text-slate-600">
                                        <Heart size={14} className="mt-0.5 shrink-0 text-slate-400" />
                                        <span className="break-words">
                                            {likes.map(l => nameOf(l.actor)).join('、')}
                                            {post.legacyLikeCount ? `${likes.length ? ' 等 ' : ''}${likeCount} 人` : ''} 讚了
                                        </span>
                                    </div>
                                )}
                                {comments.length > 0 && (
                                    <div className="mt-3 space-y-3">
                                        {comments.map(c => {
                                            const target = c.replyTo ? post.comments.find(x => x.id === c.replyTo) : undefined;
                                            const mine = c.actor.id === USER_ID;
                                            return (
                                                <div key={c.id} className={`flex gap-2.5 ${target ? 'pl-6' : ''}`}>
                                                    <TokenImg value={avatarOf(c.actor)} className="w-7 h-7 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs text-slate-400">{nameOf(c.actor)}</div>
                                                        <div className="text-[14px] text-slate-700 break-words leading-relaxed">
                                                            {target && <><span className="text-slate-400">回覆 </span><span className="text-slate-500">{nameOf(target.actor)}</span>：</>}
                                                            {c.content}
                                                        </div>
                                                        <div className="mt-0.5 flex items-center gap-3 text-[11px] text-slate-400">
                                                            <span>{formatChatListTimestamp(c.at)}</span>
                                                            {!mine && (
                                                                <button onClick={() => { setCommentTarget({ postId: post.id, replyTo: c }); setCommentDraft(''); }}>回覆</button>
                                                            )}
                                                            <span className="flex-1" />
                                                            {mine && (
                                                                <button onClick={() => void deleteMomentComment(post.id, c.id)} aria-label="刪除留言" className="text-slate-300 hover:text-rose-400">
                                                                    <Trash size={14} />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
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

            <MomentComposer
                isOpen={!!composer}
                editing={composer?.editing}
                onClose={() => setComposer(null)}
                onPost={async (content, images, visibility) => {
                    const editing = composer?.editing;
                    if (editing) {
                        await updateMomentPostFields(editing.id, { content: content.trim(), images, visibility });
                        // 編輯時拿掉的照片：沒人用了就回收
                        for (const img of editing.images) if (!images.includes(img)) void deleteBlobRefIfUnreferenced(img);
                        trackEvent('朋友圈编辑贴文');
                        addToast('已更新', 'success');
                    } else {
                        await createMomentPost({ author: me, content, images, visibility });
                        trackEvent('朋友圈发文', { visibility: visibility.mode, hasImage: images.length > 0 ? 'yes' : 'no' });
                        addToast('發出去了', 'success');
                    }
                    setComposer(null);
                }}
            />

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

// ── 頁頂：封面、頭像、名字、格言 ────────────────────────────────────────

const ProfileHeader: React.FC<{
    onBack?: () => void;
    refreshing: boolean;
    onRefresh: () => void;
    onCompose: () => void;
}> = ({ onBack, refreshing, onRefresh, onCompose }) => {
    const { userProfile, updateUserProfile, addToast } = useOS();
    const coverRef = useRef<HTMLInputElement>(null);
    const [editingMotto, setEditingMotto] = useState(false);
    const [mottoDraft, setMottoDraft] = useState('');
    const cover = userProfile.momentsCover;
    const motto = userProfile.momentsMotto?.trim();

    const uploadCover = async (file: File | undefined) => {
        if (!file) return;
        try {
            const ref = await migrateDataUrlToRef(await processImage(file, { maxWidth: 1600, quality: 0.85, forceJpeg: true }));
            const old = userProfile.momentsCover;
            updateUserProfile({ momentsCover: ref });
            if (old && old !== ref) window.setTimeout(() => void deleteBlobRefIfUnreferenced(old), 1500);
        } catch (e: any) {
            addToast(e?.message || '圖片讀取失敗', 'error');
        }
    };

    const saveMotto = () => {
        updateUserProfile({ momentsMotto: mottoDraft.trim() || undefined });
        setEditingMotto(false);
    };

    const iconBtn = 'w-9 h-9 rounded-full bg-black/25 backdrop-blur-sm text-white flex items-center justify-center active:scale-90 transition-transform';

    return (
        <div className="relative pb-4">
            <div className="relative h-64 bg-gradient-to-b from-slate-300 to-slate-100 cursor-pointer" onClick={() => coverRef.current?.click()}>
                {cover ? (
                    <TokenImg value={cover} className="w-full h-full object-cover" alt="" />
                ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 gap-1.5">
                        <ImageSquare size={30} />
                        <span className="text-[11px] tracking-wider">點一下換封面</span>
                    </div>
                )}
                <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-white to-transparent" />
                <input ref={coverRef} type="file" accept="image/*" className="hidden" onChange={e => { void uploadCover(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4" style={{ paddingTop: onBack ? 'calc(var(--safe-top) + 0.75rem)' : '0.75rem' }}>
                {onBack ? <button onClick={onBack} aria-label="返回" className={iconBtn}><CaretLeft size={18} weight="bold" /></button> : <span />}
                <div className="flex items-center gap-2">
                    <button onClick={onRefresh} disabled={refreshing} aria-label="讓角色們發新動態" className={`${iconBtn} disabled:opacity-60`}>
                        <ArrowsClockwise size={18} weight="bold" className={refreshing ? 'animate-spin' : ''} />
                    </button>
                    <button onClick={onCompose} aria-label="發動態" className={iconBtn}><Plus size={18} weight="bold" /></button>
                </div>
            </div>
            <div className="relative -mt-12 px-5">
                <TokenImg value={userProfile.avatar} className="w-24 h-24 rounded-full object-cover bg-slate-100 border-4 border-white shadow-md" alt="" />
                <div className="mt-2 text-xl font-bold text-slate-800">{userProfile.name || '我'}</div>
                {editingMotto ? (
                    <input
                        autoFocus
                        value={mottoDraft}
                        maxLength={60}
                        onChange={e => setMottoDraft(e.target.value)}
                        onBlur={saveMotto}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveMotto(); }}
                        placeholder="寫一句格言（選填）"
                        className="mt-1 w-full bg-slate-50 rounded-lg px-2 py-1 text-sm text-slate-600"
                    />
                ) : (
                    <button onClick={() => { setMottoDraft(userProfile.momentsMotto || ''); setEditingMotto(true); }}
                        className={`mt-1 text-left text-sm ${motto ? 'text-slate-500' : 'text-slate-300'}`}>
                        {motto || '點這裡寫一句格言'}
                    </button>
                )}
            </div>
        </div>
    );
};

// ── 發文／編輯 ──────────────────────────────────────────────────────────

const MomentComposer: React.FC<{
    isOpen: boolean;
    /** 有傳就是編輯這篇（帶入原本的內容、照片、可見範圍） */
    editing?: MomentPost;
    onClose: () => void;
    onPost: (content: string, images: string[], visibility: MomentVisibility) => Promise<void>;
}> = ({ isOpen, editing, onClose, onPost }) => {
    const { characters, npcs, addToast } = useOS();
    const [content, setContent] = useState('');
    const [images, setImages] = useState<string[]>([]);
    const [mode, setMode] = useState<MomentVisibility['mode']>('friends');
    const [allow, setAllow] = useState<string[]>([]);
    const [posting, setPosting] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        setContent(editing?.content || '');
        setImages(editing?.images || []);
        setMode(editing?.visibility.mode || 'friends');
        setAllow(editing?.visibility.allow || []);
        setPosting(false);
    }, [isOpen, editing]);

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
        <Modal isOpen={isOpen} title={editing ? '編輯動態' : '發動態'} onClose={onClose}
            footer={<button disabled={!canPost}
                onClick={async () => { setPosting(true); try { await onPost(content, images, mode === 'custom' ? { mode, allow } : { mode }); } finally { setPosting(false); } }}
                className="w-full py-3 rounded-2xl bg-primary text-white font-bold disabled:opacity-40">{posting ? '儲存中…' : editing ? '儲存' : '發表'}</button>}>
            <div className="space-y-3">
                <textarea value={content} onChange={e => setContent(e.target.value)} rows={4} placeholder="這一刻的想法…"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none" />
                <div className="grid grid-cols-3 gap-1.5">
                    {images.map((img, i) => (
                        <div key={`${img}-${i}`} className="relative aspect-square">
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
