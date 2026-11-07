import React, { useMemo, useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { trackEvent } from '../../utils/analytics';
import {
    describeLibraryImage,
    libraryDescribeOptions,
    loadLibraryDescribeChoice,
    saveLibraryDescribeChoice,
} from '../../utils/libraryDescribe';

/**
 * 描述欄右上角：選一個 API（主 API 或預設），讓它看圖寫描述。
 * 寫好直接換掉欄位裡的字；原本有字的話留一顆「還原」，下次動手改就消失。
 */
const LibraryDescribeButton: React.FC<{
    /** 圖（blobref 令牌、data URL 都行）；上傳還沒存的圖給個 async 取 data URL */
    getImageUrl: () => Promise<string> | string;
    current: string;
    onChange: (text: string) => void;
}> = ({ getImageUrl, current, onChange }) => {
    const { apiConfig, apiPresets, addToast } = useOS();
    const options = useMemo(() => libraryDescribeOptions(apiConfig, apiPresets || []), [apiConfig, apiPresets]);
    const [choice, setChoice] = useState(() => loadLibraryDescribeChoice());
    const [busy, setBusy] = useState(false);
    const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
    const selected = options.find(option => option.id === choice) || options[0];

    if (!options.length) {
        return <span className="text-[10px] text-slate-300">設好 API 就能讓 AI 寫</span>;
    }

    const run = async () => {
        if (!selected || busy) return;
        setBusy(true);
        try {
            const text = await describeLibraryImage(selected.api, await getImageUrl());
            setUndo(current.trim() ? { before: current, after: text } : null);
            onChange(text);
            trackEvent('让AI写照片描述');
        } catch (error: any) {
            addToast(`沒寫成：${error?.message || '未知錯誤'}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex min-w-0 items-center gap-1.5">
            {undo && undo.after === current && (
                <button type="button" onClick={() => { onChange(undo.before); setUndo(null); }} className="shrink-0 text-[11px] font-bold text-slate-400 underline-offset-2 hover:underline">
                    還原
                </button>
            )}
            {options.length > 1 && (
                <select
                    aria-label="用哪個 API 寫"
                    value={selected?.id}
                    onChange={event => { setChoice(event.target.value); saveLibraryDescribeChoice(event.target.value); }}
                    className="min-w-0 max-w-[8.5rem] truncate rounded-md bg-transparent py-0.5 text-right text-[11px] text-slate-400 outline-none"
                >
                    {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
            )}
            <button type="button" onClick={run} disabled={busy} title={selected ? `用 ${selected.label}` : undefined}
                className="flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600 transition active:scale-95 disabled:opacity-60">
                {busy ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" /> : <Sparkle size={12} weight="fill" />}
                {busy ? '在看…' : 'AI 寫'}
            </button>
        </div>
    );
};

export default LibraryDescribeButton;
