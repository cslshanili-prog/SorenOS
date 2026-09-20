
import React, { useRef, useState } from 'react';
import { CharacterProfile } from '../../types';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import FaceCropModal, { FaceBox } from './FaceCropModal';

interface CharacterImageGenPanelProps {
    charName: string;
    value: CharacterProfile['imageGenCharConfig'];
    onChange: (value: CharacterProfile['imageGenCharConfig']) => void;
    /** 系统设置 → 生图API 的总开关（开启角色生图）现在是否打开；关着的话这里只能先配置，实际生图要等总开关打开。 */
    globalImageGenEnabled: boolean;
}

const CharacterImageGenPanel: React.FC<CharacterImageGenPanelProps> = ({ charName, value, onChange, globalImageGenEnabled }) => {
    const fileRef = useRef<HTMLInputElement>(null);
    const [showFaceCrop, setShowFaceCrop] = useState(false);
    const referenceImageUrl = useBlobRefUrl(value?.referenceImage);
    const referenceEnabled = value?.referenceEnabled ?? false;
    const nonSelfieSkipsReference = value?.nonSelfieSkipsReference ?? true;

    const patch = (updates: Partial<NonNullable<CharacterProfile['imageGenCharConfig']>>) => {
        onChange({ ...(value || {}), ...updates });
    };

    const handleUpload = async (file: File) => {
        const blob = await processImageToBlob(file, { skipCompression: true });
        const ref = await putImageBlob(blob);
        // 换了一张新参考图，旧的脸部选区不再对得上，一并清掉，逼用户重选一次。
        patch({ referenceImage: ref, referenceFaceBox: undefined });
    };

    const handleSaveFaceBox = (box: FaceBox) => {
        patch({ referenceFaceBox: box });
        setShowFaceCrop(false);
    };

    return (
        <div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3 mb-4">
                    <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-700 truncate">{charName} · 專屬生圖設定</p>
                        <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">只影響這個角色，不會改動角色卡正文。（參考圖／臉部鎖定目前只有本機聊天生效，主動消息 2.0 的雲端生成對話暫不支援。）</p>
                    </div>
                    <button
                        onClick={() => patch({ referenceEnabled: !referenceEnabled })}
                        className={`shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-bold transition-colors ${
                            referenceEnabled ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'
                        }`}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v9m6.36-6.36a9 9 0 1 1-12.73 0" />
                        </svg>
                        參考圖：{referenceEnabled ? '開啟' : '關閉'}
                    </button>
                </div>

                {!globalImageGenEnabled && (
                    <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-[11px] text-amber-700 leading-relaxed">
                        「系統設置 → 生圖API」的總開關「開啟角色生圖」目前是關閉的，這裡可以先設定，但要等總開關打開才會真的生效。
                    </div>
                )}

                <div className="mb-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">專屬人物特徵提示詞</label>
                    <textarea
                        value={value?.characterPrompt || ''}
                        onChange={e => patch({ characterPrompt: e.target.value })}
                        placeholder="例如：黑色長捲髮、灰藍色眼睛、左眼下有一顆小痣、清冷氣質……"
                        rows={3}
                        className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-xs resize-none focus:bg-white transition-all"
                    />
                    <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">生成該角色圖片時自動追加。</p>
                </div>

                <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-2xl px-3.5 py-3 mb-4">
                    <div className="min-w-0 flex-1 pr-3">
                        <p className="text-xs font-bold text-slate-700">非自拍照不使用參考圖</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">預設開啟；合照、他拍、風景或物件圖僅使用文字提示詞生成。</p>
                    </div>
                    <button
                        onClick={() => patch({ nonSelfieSkipsReference: !nonSelfieSkipsReference })}
                        className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center flex-shrink-0 ${nonSelfieSkipsReference ? 'bg-primary' : 'bg-slate-300'}`}
                    >
                        <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${nonSelfieSkipsReference ? 'translate-x-4' : ''}`} />
                    </button>
                </div>

                {referenceImageUrl && (
                    <div className="mb-3 rounded-xl overflow-hidden border border-slate-200" style={{ aspectRatio: '1 / 1', maxWidth: 120 }}>
                        <img src={referenceImageUrl} alt="參考圖" className="w-full h-full object-cover" />
                    </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                    <button
                        onClick={() => fileRef.current?.click()}
                        className="py-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-bold text-slate-600 flex items-center justify-center gap-1.5 active:scale-95 transition-transform"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
                        </svg>
                        更換參考圖
                    </button>
                    <button
                        onClick={() => referenceImageUrl && setShowFaceCrop(true)}
                        disabled={!referenceImageUrl}
                        className={`py-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-transform ${
                            referenceImageUrl ? 'bg-slate-50 border-slate-200 text-slate-600 active:scale-95' : 'bg-slate-50 border-slate-100 text-slate-300'
                        }`}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 9h.01M15 9h.01M9.5 14.5s.75 1 2.5 1 2.5-1 2.5-1M7 3.34A9 9 0 0 1 21 12a9 9 0 0 1-9 9 9 9 0 0 1-9-9c0-1.5.36-2.92 1-4.17" />
                        </svg>
                        選取臉部{value?.referenceFaceBox ? '（已選）' : ''}
                    </button>
                </div>
                <input type="file" ref={fileRef} className="hidden" accept="image/*" onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
            </div>

            {referenceImageUrl && (
                <FaceCropModal
                    isOpen={showFaceCrop}
                    imageUrl={referenceImageUrl}
                    initialBox={value?.referenceFaceBox}
                    onCancel={() => setShowFaceCrop(false)}
                    onSave={handleSaveFaceBox}
                />
            )}
        </div>
    );
};

export default React.memo(CharacterImageGenPanel);
