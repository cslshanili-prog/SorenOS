import React, { useState } from 'react';

interface Props {
    initialDescription: string;
    /** 這個角色有開參考圖（才顯示「這次一定帶參考圖」） */
    referenceAvailable: boolean;
    /** 上一次被判成非自拍沒帶參考圖：勾選框預設打勾 */
    defaultForceReference: boolean;
    busy: boolean;
    onCancel: () => void;
    onSubmit: (description: string, forceReference: boolean) => void;
}

/**
 * 圖片預覽裡的「✎ 改提示詞」（2026-10-06）：看得到角色當時寫的畫面描述，改完重新生成。
 * 改過的描述會存回這張圖，之後按 ⟳ 就照新的跑。
 */
const ImagePromptEditor: React.FC<Props> = ({ initialDescription, referenceAvailable, defaultForceReference, busy, onCancel, onSubmit }) => {
    const [text, setText] = useState(initialDescription);
    const [forceReference, setForceReference] = useState(defaultForceReference);
    return (
        <div className="absolute inset-x-0 bottom-0 z-20 rounded-t-3xl bg-white p-4 pb-6 text-slate-700 shadow-2xl"
            style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
            onClick={e => e.stopPropagation()}>
            <div className="text-sm font-bold mb-1">畫面描述</div>
            <p className="text-[11px] text-slate-400 leading-relaxed mb-2">
                角色發這張圖時寫的描述。生成時還會自動加上：專屬生圖設定的人物特徵、生圖 API 的補充提示詞，帶參考圖時再加一段鎖臉要求。
            </p>
            <textarea value={text} onChange={e => setText(e.target.value)} rows={5} autoFocus
                className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed resize-none focus:bg-white" />
            {referenceAvailable && (
                <label className="mt-2 flex items-start gap-2 text-[12px] text-slate-600 cursor-pointer select-none">
                    <input type="checkbox" checked={forceReference} onChange={e => setForceReference(e.target.checked)} className="mt-0.5" />
                    <span>這次一定帶參考圖（不管是不是自拍都鎖臉）</span>
                </label>
            )}
            <div className="mt-3 flex gap-2">
                <button type="button" onClick={onCancel} className="flex-1 rounded-2xl bg-slate-100 py-3 text-sm font-bold text-slate-500">取消</button>
                <button type="button" disabled={busy || !text.trim()} onClick={() => onSubmit(text.trim(), forceReference)}
                    className="flex-[2] rounded-2xl bg-slate-900 py-3 text-sm font-bold text-white disabled:opacity-40">
                    {busy ? '生成中…' : '照這段重新生成'}
                </button>
            </div>
        </div>
    );
};

export default ImagePromptEditor;
