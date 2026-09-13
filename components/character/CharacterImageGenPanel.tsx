
import React, { useRef } from 'react';
import { CharacterProfile } from '../../types';
import TokenImg from '../os/TokenImg';
import { processImageToBlob } from '../../utils/file';
import { putImageBlob } from '../../utils/blobRef';

interface CharacterImageGenPanelProps {
    value: CharacterProfile['imageGenCharConfig'];
    onChange: (value: CharacterProfile['imageGenCharConfig']) => void;
}

const CharacterImageGenPanel: React.FC<CharacterImageGenPanelProps> = ({ value, onChange }) => {
    const fileRef = useRef<HTMLInputElement>(null);

    const patch = (updates: Partial<NonNullable<CharacterProfile['imageGenCharConfig']>>) => {
        onChange({ ...(value || {}), ...updates });
    };

    const handleUpload = async (file: File) => {
        const blob = await processImageToBlob(file, { skipCompression: true });
        const ref = await putImageBlob(blob);
        patch({ referenceImage: ref });
    };

    return (
        <div>
            <div className="flex justify-between items-center mb-2 px-1">
                <label className="text-[10px] font-bold text-pink-500 uppercase tracking-widest">生图设定（仅这个角色）</label>
            </div>

            <div className="space-y-3 bg-slate-50 border border-slate-200 rounded-2xl p-3.5">
                <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1 pr-3">
                        <p className="text-xs font-bold text-slate-700">开启参考图</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">生成时带上下面的参考图（脸部锁定），是否真的生效取决于生图引擎是否支持。</p>
                    </div>
                    <button
                        onClick={() => patch({ referenceEnabled: !value?.referenceEnabled })}
                        className={`w-10 h-6 rounded-full p-1 transition-colors flex items-center flex-shrink-0 ${value?.referenceEnabled ? 'bg-primary' : 'bg-slate-300'}`}
                    >
                        <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${value?.referenceEnabled ? 'translate-x-4' : ''}`} />
                    </button>
                </div>

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">专属人物特征提示词</label>
                    <textarea
                        value={value?.characterPrompt || ''}
                        onChange={e => patch({ characterPrompt: e.target.value })}
                        placeholder="只影响这个角色生图效果的描述，如发色瞳色、常穿的衣服"
                        rows={2}
                        className="w-full bg-white border border-slate-200/60 rounded-xl px-3 py-2 text-xs resize-none focus:bg-white transition-all"
                    />
                </div>

                <div>
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block">参考图（锁脸/选取脸部）</label>
                    <div
                        onClick={() => fileRef.current?.click()}
                        className="h-24 bg-white rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center cursor-pointer hover:border-pink-300 overflow-hidden relative"
                    >
                        {value?.referenceImage
                            ? <TokenImg value={value.referenceImage} className="w-full h-full object-cover" alt="参考图" />
                            : <span className="text-xs text-slate-400">点击上传参考图</span>}
                        {value?.referenceImage && <span className="absolute z-10 text-xs bg-white/80 px-2 py-1 rounded">更换</span>}
                    </div>
                    <input type="file" ref={fileRef} className="hidden" accept="image/*" onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])} />
                    {value?.referenceImage && (
                        <button onClick={() => patch({ referenceImage: undefined })} className="text-[10px] text-red-400 mt-1">
                            移除参考图
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default React.memo(CharacterImageGenPanel);
