import React from 'react';
import { useOS } from '../context/OSContext';
import { hasGuideApi, setGuideStep, setVectorGuideSkipped, useFirstUseGuideStep } from '../utils/firstUseGuide';

export function MainApiMemoryChoice() {
    const step = useFirstUseGuideStep();
    const { apiConfig, updateMemoryPalaceConfig } = useOS();
    if (step !== 1) return null;
    return <div className="mb-3 rounded-xl bg-white/80 p-3 text-xs leading-relaxed text-emerald-800">
        <button data-guide="use-main-api" type="button" disabled={!hasGuideApi(apiConfig)} className="font-bold underline disabled:opacity-40" onClick={() => updateMemoryPalaceConfig({
            lightLLM: { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model },
        })}>我想暫時只用主 API</button>
        <p className="mt-1">將剛才保存的主 API 配置複製給副 API，用它整理記憶。無需另買服務；後續整理會消耗主 API 額度，也可以隨時換成便宜的聊天模型。</p>
    </div>;
}

export function SkipVectorMemoryChoice() {
    const step = useFirstUseGuideStep();
    const { memoryPalaceConfig } = useOS();
    if (step !== 1) return null;
    return <div className="mt-3 border-t border-violet-200 pt-3 text-xs leading-relaxed text-slate-600">
        <button type="button" disabled={!hasGuideApi(memoryPalaceConfig.lightLLM)} className="font-bold text-violet-700 underline disabled:opacity-40" onClick={() => {
            setVectorGuideSkipped(true);
            setGuideStep(3);
        }}>暫時跳過向量記憶</button>
        <p className="mt-1">先完成上方副 API 的選擇即可跳過。跳過後繼續學習聊天，不開啟向量記憶和全自動記憶；之後可在「記憶宮殿」補配。</p>
    </div>;
}
