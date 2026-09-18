import React, { useEffect, useRef, useState } from 'react';
import { ArrowsClockwise, Heart } from '@phosphor-icons/react';
import type { CharacterProfile, SocialPost } from '../../types';
import TokenImg from '../os/TokenImg';
import { DB } from '../../utils/db';
import { filterMomentsVisibleToChar } from '../../utils/trajectory';
import { processImage } from '../../utils/file';
import { migrateDataUrlToRef } from '../../utils/blobRef';

interface Props {
    char: CharacterProfile;
    cover: string | undefined;
    onCommitCover: (next: string) => void;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const formatTimestamp = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const TrajectoryMomentsTab: React.FC<Props> = ({ char, cover, onCommitCover, addToast }) => {
    const [posts, setPosts] = useState<SocialPost[]>([]);
    const [loading, setLoading] = useState(true);
    const coverInputRef = useRef<HTMLInputElement>(null);

    const load = async () => {
        setLoading(true);
        try {
            const all = await DB.getSocialPosts();
            const visible = filterMomentsVisibleToChar(all, char).sort((a, b) => b.timestamp - a.timestamp);
            setPosts(visible);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); }, [char.id]);

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

                <button onClick={(e) => { e.stopPropagation(); load(); }} aria-label="刷新朋友圈" disabled={loading}
                    className="absolute top-3 right-4 w-8 h-8 rounded-full bg-black/30 flex items-center justify-center text-white/85 disabled:opacity-50">
                    <ArrowsClockwise size={15} weight="bold" className={loading ? 'animate-spin' : ''} />
                </button>

                <div className="absolute right-4 bottom-3 flex items-end gap-2">
                    <span className="text-[13px] font-bold text-white drop-shadow">{char.name}</span>
                    <TokenImg value={char.avatar} alt="" className="w-11 h-11 rounded-xl object-cover border-2 border-white/20" />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-4 pb-28 space-y-4">
                {!loading && posts.length === 0 && (
                    <div className="text-center pt-10 text-[12px] text-white/40">
                        还没有 {char.name} 能看到的动态
                    </div>
                )}
                {posts.map(post => (
                    <div key={post.id} className="flex gap-2.5">
                        <TokenImg value={post.authorAvatar} alt="" className="w-9 h-9 rounded-lg object-cover shrink-0" />
                        <div className="min-w-0 flex-1">
                            <div className="text-[12.5px] font-bold" style={{ color: '#a78bfa' }}>{post.authorName}</div>
                            {post.content && <div className="text-[13px] leading-relaxed mt-0.5 text-white/85">{post.content}</div>}
                            {post.images.length > 0 && (
                                <div className="grid grid-cols-3 gap-1.5 mt-2 max-w-[240px]">
                                    {post.images.slice(0, 9).map((img, i) => (
                                        <div key={i} className="aspect-square rounded-lg overflow-hidden bg-white/5">
                                            <TokenImg value={img} alt="" className="w-full h-full object-cover" />
                                        </div>
                                    ))}
                                </div>
                            )}
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
        </div>
    );
};

export default TrajectoryMomentsTab;
