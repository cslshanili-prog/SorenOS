import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { GalleryImage } from '../../types';
import {
    BATCH_DESCRIBE_MAX_CONSECUTIVE_FAILURES,
    describeLibraryImage,
    libraryDescribeOptions,
    loadLibraryDescribeChoice,
    runBatchDescribe,
    saveLibraryDescribeChoice,
    type BatchDescribeProgress,
    type BatchDescribeResult,
} from '../../utils/libraryDescribe';

/**
 * 批次 AI 寫：把眼前（照目前的篩選）還沒描述的照片一張張補上描述。
 * 每張一次看圖請求，寫好就存；可以中途停。連續失敗幾張就自己停（多半是模型不會看圖）。
 */
const LibraryBatchDescribeSheet: React.FC<{
    photos: GalleryImage[];
    save: (image: GalleryImage, description: string) => Promise<void>;
    onClose: (result: BatchDescribeResult | null) => void;
}> = ({ photos, save, onClose }) => {
    const { apiConfig, apiPresets } = useOS();
    const options = useMemo(() => libraryDescribeOptions(apiConfig, apiPresets || []), [apiConfig, apiPresets]);
    const [choice, setChoice] = useState(() => loadLibraryDescribeChoice());
    const selected = options.find(option => option.id === choice) || options[0];
    // 開單那一刻的清單：跑的時候寫好的會從「還沒描述」裡消失，別讓總數跟著跳
    const [queue] = useState(photos);
    const [progress, setProgress] = useState<BatchDescribeProgress | null>(null);
    const [result, setResult] = useState<BatchDescribeResult | null>(null);
    const cancelled = useRef(false);
    const running = !!progress && !result;
    useEffect(() => () => { cancelled.current = true; }, []);

    const start = async () => {
        if (!selected || running) return;
        cancelled.current = false;
        setProgress({ done: 0, total: queue.length, succeeded: 0, failed: 0 });
        const outcome = await runBatchDescribe(queue, {
            describe: image => describeLibraryImage(selected.api, image.url),
            save,
            onProgress: setProgress,
            isCancelled: () => cancelled.current,
        });
        setResult(outcome);
    };

    const close = () => {
        if (running) { cancelled.current = true; return; }
        onClose(result);
    };

    const summary = result && (
        result.stoppedBy === 'failures'
            ? `連續 ${BATCH_DESCRIBE_MAX_CONSECUTIVE_FAILURES} 張沒寫成，先停下來了：${result.lastError || '未知錯誤'}。這個模型可能不會看圖，換一個試試。`
            : result.stoppedBy === 'cancelled'
                ? `停下來了：寫好 ${result.succeeded} 張${result.failed ? `、${result.failed} 張沒寫成` : ''}，剩下的下次再補。`
                : `寫好 ${result.succeeded} 張${result.failed ? `，${result.failed} 張沒寫成（${result.lastError || '未知錯誤'}），可以再跑一次補` : ''}。`
    );

    return (
        <div className="fixed inset-0 z-[300] flex items-end justify-center bg-black/40 sm:items-center" onClick={() => { if (!running) close(); }}>
            <div className="w-full rounded-t-2xl bg-white p-5 text-slate-700 sm:max-w-sm sm:rounded-2xl" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 1.25rem)' }} onClick={e => e.stopPropagation()}>
                <h3 className="flex items-center gap-1.5 text-base font-bold"><Sparkle size={16} weight="fill" className="text-primary" />批次 AI 寫描述</h3>
                <p className="mt-1.5 text-[12px] leading-relaxed text-slate-500">
                    這樣篩有 <b>{queue.length}</b> 張照片還沒描述，角色看不到它們。讓 AI 一張張看圖補上，每張一次請求；寫好就存，之後還能自己改。
                </p>

                {!options.length ? (
                    <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-700">先在設定裡填好主 API 或 API 預設（要能看圖）。</p>
                ) : (
                    <label className="mt-4 block">
                        <span className="text-[11px] font-bold text-slate-400">用哪個 API</span>
                        <select value={selected?.id} disabled={running}
                            onChange={event => { setChoice(event.target.value); saveLibraryDescribeChoice(event.target.value); }}
                            className="mt-1 w-full rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none disabled:opacity-60">
                            {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                        </select>
                    </label>
                )}

                {progress && (
                    <div className="mt-4" aria-live="polite">
                        <div className="flex justify-between text-[11px] text-slate-400">
                            <span>{running ? '在看…' : '好了'}</span>
                            <span className="font-mono">{progress.done} / {progress.total}{progress.failed ? ` · ${progress.failed} 張沒寫成` : ''}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
                        </div>
                    </div>
                )}
                {summary && <p className={`mt-3 text-[12px] leading-relaxed ${result?.stoppedBy === 'failures' ? 'text-red-500' : 'text-slate-500'}`}>{summary}</p>}

                <div className="mt-5 flex gap-2">
                    <button type="button" onClick={close} className="flex-1 rounded-xl bg-slate-100 py-2.5 text-sm font-bold text-slate-600 active:scale-95">
                        {running ? '停下來' : result ? '完成' : '取消'}
                    </button>
                    {!result && (
                        <button type="button" onClick={() => void start()} disabled={!selected || running || !queue.length}
                            className="flex-1 rounded-xl bg-primary py-2.5 text-sm font-bold text-white active:scale-95 disabled:opacity-50">
                            {running ? `${progress?.done ?? 0} / ${queue.length}` : `開始（${queue.length} 張）`}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LibraryBatchDescribeSheet;
