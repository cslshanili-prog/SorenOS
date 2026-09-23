import React, { useMemo, useState } from 'react';
import { CircleNotch, DownloadSimple, X } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import TokenImg from '../os/TokenImg';
import { TermHeader } from '../../apps/CheckPhone';
import { getBlobForRef } from '../../utils/blobRef';
import { shareOrDownloadBlob } from '../../utils/shareExport';

const ACCENT = '#a78bfa';

interface AlbumPhoto {
    id: string;
    image: string;
    timestamp: number;
    source: 'OOTD' | 'Moments';
}

interface Props {
    targetChar: CharacterProfile;
    onBack: () => void;
    addToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const formatTimestamp = (ts: number): string => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 只收「軌跡」自己生成的照片（OOTD + Moments），不連同聊天室/見面等別處的生圖——
// 範圍窄一些但工程量小、邊界清楚，不用另開一條全域寫入管線。
const TrajectoryAlbum: React.FC<Props> = ({ targetChar, onBack, addToast }) => {
    const photos = useMemo<AlbumPhoto[]>(() => {
        const ootd = (targetChar.phoneState?.trajectoryOotd || []).map(p => ({ id: p.id, image: p.image, timestamp: p.timestamp, source: 'OOTD' as const }));
        const moments = (targetChar.phoneState?.trajectoryMoments || []).map(p => ({ id: p.id, image: p.image, timestamp: p.timestamp, source: 'Moments' as const }));
        return [...ootd, ...moments].sort((a, b) => b.timestamp - a.timestamp);
    }, [targetChar.phoneState?.trajectoryOotd, targetChar.phoneState?.trajectoryMoments]);

    const [detailPhoto, setDetailPhoto] = useState<AlbumPhoto | null>(null);
    const [saving, setSaving] = useState(false);

    const handleSave = async (photo: AlbumPhoto) => {
        setSaving(true);
        try {
            const blob = await getBlobForRef(photo.image);
            if (!blob) { addToast('圖片已丟失，無法保存', 'error'); return; }
            const result = await shareOrDownloadBlob({ blob, fileName: `Album-${photo.id}.png`, shareTitle: `${targetChar.name} 的相簿` });
            if (result !== 'cancelled') addToast(result === 'shared' ? '已打開保存面板' : '已保存到本地', 'success');
        } catch (e) {
            console.warn('[Trajectory] 相簿照片保存失敗:', e);
            addToast('保存失敗，稍後再試', 'error');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden text-white"
            style={{ background: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)' }}>
            <TermHeader title="Album" sub={`${targetChar.name} 的相簿`} accent={ACCENT} onBack={onBack} />

            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-3 pb-8">
                {photos.length === 0 ? (
                    <div className="text-center pt-16 text-[12px] text-white/40">
                        還沒有照片，去 OOTD / Moments 生成一些吧
                    </div>
                ) : (
                    <div className="grid grid-cols-3 gap-2">
                        {photos.map(photo => (
                            <button key={`${photo.source}-${photo.id}`} onClick={() => setDetailPhoto(photo)}
                                className="aspect-square rounded-xl overflow-hidden bg-white/5 border border-white/10">
                                <TokenImg value={photo.image} alt="" className="w-full h-full object-cover" />
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {detailPhoto && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6" onClick={() => setDetailPhoto(null)}>
                    <div className="absolute inset-0 bg-black/70" />
                    <div className="relative w-full max-w-xs rounded-[2rem] overflow-hidden shadow-2xl"
                        style={{ background: '#1a1626' }} onClick={e => e.stopPropagation()}>
                        <button onClick={() => setDetailPhoto(null)} aria-label="關閉"
                            className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80">
                            <X size={14} weight="bold" />
                        </button>
                        <button onClick={() => void handleSave(detailPhoto)} disabled={saving} aria-label="保存照片"
                            className="absolute top-3 left-3 z-10 w-7 h-7 rounded-full bg-black/40 flex items-center justify-center text-white/80 disabled:opacity-50">
                            {saving ? <CircleNotch size={14} weight="bold" className="animate-spin" /> : <DownloadSimple size={14} weight="bold" />}
                        </button>
                        <div className="aspect-[4/5] bg-white/5">
                            <TokenImg value={detailPhoto.image} alt="" className="w-full h-full object-cover" />
                        </div>
                        <div className="px-5 py-3.5 flex items-center justify-between">
                            <span className="text-[10px] tracking-[0.2em] uppercase" style={{ color: ACCENT }}>{detailPhoto.source}</span>
                            <span className="text-[11px] text-white/50">{formatTimestamp(detailPhoto.timestamp)}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TrajectoryAlbum;
