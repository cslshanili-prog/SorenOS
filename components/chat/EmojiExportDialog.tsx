import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Emoji } from '../../types';
import Modal from '../os/Modal';
import { prepareEmojiExport } from '../../utils/emojiExport';
import { shareOrDownloadBlob } from '../../utils/shareExport';

export default function EmojiExportDialog({ emojis, title = '表情包', onClose }: { emojis: Pick<Emoji, 'name' | 'url'>[]; title?: string; onClose: () => void }) {
    const [file, setFile] = useState<{ blob: Blob; fileName: string } | null>(null);
    const [error, setError] = useState('');
    const [sharing, setSharing] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setFile(null); setError('');
        prepareEmojiExport(emojis, title).then(result => { if (!cancelled) setFile(result); }, e => { if (!cancelled) setError(e instanceof Error ? e.message : '讀取原文件失敗'); });
        return () => { cancelled = true; };
    }, [emojis, title]);
    const share = async () => {
        if (!file || sharing) return;
        setSharing(true); setError('');
        try {
            const result = await shareOrDownloadBlob({ ...file, shareTitle: title, nativeChunked: true });
            if (result !== 'cancelled') onClose();
        } catch (e) { setError(e instanceof Error ? e.message : '無法拉起分享，請重試'); }
        finally { setSharing(false); }
    };
    return createPortal(<Modal isOpen title="下載表情原圖" onClose={onClose} footer={<button disabled={!file || sharing} onClick={share} className="w-full py-3 bg-primary text-white rounded-2xl disabled:opacity-40">{sharing ? '正在分享…' : '分享 / 保存文件'}</button>}>
        <p className="text-sm text-slate-600">{file ? `${emojis.length} 張表情已準備好。${emojis.length > 1 ? 'ZIP 內保留每張圖片的原始格式與動圖。' : '保留原始格式與動圖。'}` : error ? '文件準備失敗，請關閉後重試。' : '正在讀取表情原文件…'}</p>
        {error && <p role="alert" className="mt-3 text-sm text-red-500">{error}</p>}
    </Modal>, document.body);
}
