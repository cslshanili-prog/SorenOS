/**
 * 音色欄位（MiniMax voice_id／模型、魚聲 reference_id、ElevenLabs Voice ID、語速、拉取可用音色）。
 * 角色編輯頁和身份卡「我的聲音」共用同一塊（plans/user-voice.md）；存的結構都是 CharacterProfile['voiceProfile']。
 */
import React, { useState } from 'react';
import { SlidersHorizontal, SpeakerHigh } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile } from '../../types';
import { fetchMiniMaxVoices, MiniMaxVoiceItem } from '../../utils/minimaxVoice';
import { resolveMiniMaxApiKey } from '../../utils/minimaxApiKey';
import { normalizeElevenLabsVoiceId, synthesizeSpeechElevenLabsDetailed } from '../../utils/elevenLabsTts';
import { canSynthesizeSpeech, synthesizeSpeechDetailed } from '../../utils/ttsRouter';

export type VoiceProfile = NonNullable<CharacterProfile['voiceProfile']>;
type VoiceSource = 'system' | 'voice_cloning' | 'voice_generation';

/** 借音色的殼：TTS 只讀 voiceProfile，其餘欄位給個空殼就行。 */
export const voiceShell = (voiceProfile: CharacterProfile['voiceProfile'], name = '', base?: CharacterProfile): CharacterProfile =>
    ({ ...(base || ({ id: 'voice-shell', name } as CharacterProfile)), voiceProfile });

interface Props {
    value: CharacterProfile['voiceProfile'];
    onChange: (next: VoiceProfile) => void;
    apiConfig: APIConfig;
    addToast: (message: string, type: 'success' | 'error' | 'info') => void;
    /** 試聽時念的名字 */
    speakerName: string;
    title?: string;
    hint?: string;
    /** 說明文字裡「誰」的語速（角色／這張卡） */
    speedOwner?: string;
    /** 角色才有的「捏聲音」 */
    onOpenDesigner?: () => void;
    /** 照目前的語音服務商試聽一句 */
    showPreview?: boolean;
    onVoiceApplied?: (source: VoiceSource) => void;
}

const VoiceProfileFields: React.FC<Props> = ({
    value, onChange, apiConfig, addToast, speakerName,
    title = '角色語音音色',
    hint = '已有 voice_id 可直接填，不依賴查詢。聊天角色配置後，後續接 TTS 可直接讀取。',
    speedOwner = '該角色',
    onOpenDesigner, showPreview, onVoiceApplied,
}) => {
    const vp = value;
    const [isLoadingVoices, setIsLoadingVoices] = useState(false);
    const [isTestingElevenLabsVoice, setIsTestingElevenLabsVoice] = useState(false);
    const [isPreviewing, setIsPreviewing] = useState(false);
    const [voiceOptions, setVoiceOptions] = useState<Record<VoiceSource, MiniMaxVoiceItem[]>>({
        system: [],
        voice_cloning: [],
        voice_generation: [],
    });

    const handleLoadMiniMaxVoices = async () => {
        const minimaxApiKey = resolveMiniMaxApiKey(apiConfig);
        if (!minimaxApiKey) {
            addToast('請先在設置中填入 MiniMax API Key（未填寫時會回退使用通用 API Key）', 'error');
            return;
        }
        setIsLoadingVoices(true);
        try {
            const result = await fetchMiniMaxVoices(minimaxApiKey, 'all');
            setVoiceOptions({
                system: result.system_voice,
                voice_cloning: result.voice_cloning,
                voice_generation: result.voice_generation,
            });
            addToast(`已拉取音色：系統 ${result.system_voice.length} / 復刻 ${result.voice_cloning.length} / 文生 ${result.voice_generation.length}`, 'success');
        } catch (e: any) {
            console.error('[MiniMax Voice] load failed', e);
            addToast(e?.message || '拉取 MiniMax 音色失敗', 'error');
        } finally {
            setIsLoadingVoices(false);
        }
    };

    const applyVoice = (voice: MiniMaxVoiceItem, source: VoiceSource) => {
        onChange({
            ...(vp || {}),
            provider: 'minimax',
            voiceId: voice.voice_id,
            voiceName: voice.voice_name || '',
            source,
            model: vp?.model || 'speech-2.8-hd',
            notes: vp?.notes || '',
        } as VoiceProfile);
        addToast(`已應用音色：${voice.voice_name || voice.voice_id}`, 'success');
        onVoiceApplied?.(source);
    };

    const playPreview = async (url: string) => {
        const release = () => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); };
        const audio = new Audio(url);
        audio.onended = release;
        audio.onerror = release;
        try { await audio.play(); } catch (e) { release(); throw e; }
    };

    const handleTestElevenLabsVoice = async () => {
        if (isTestingElevenLabsVoice) return;
        const voiceId = normalizeElevenLabsVoiceId(vp?.elevenLabsVoiceId);
        if (!voiceId) {
            addToast('請先填寫 ElevenLabs Voice ID', 'info');
            return;
        }
        if (!apiConfig.elevenLabsApiKey?.trim()) {
            addToast('請先在設置 → 其他 API 保存 ElevenLabs Key', 'info');
            return;
        }
        setIsTestingElevenLabsVoice(true);
        try {
            const { url } = await synthesizeSpeechElevenLabsDetailed(
                `你好，我是${speakerName || '你的角色'}。現在能聽見我的聲音嗎？`,
                voiceShell({ ...(vp || {}), elevenLabsVoiceId: voiceId } as VoiceProfile, speakerName),
                apiConfig,
            );
            await playPreview(url);
            addToast('ElevenLabs 試聽已開始', 'success');
        } catch (error: any) {
            addToast(error?.message || 'ElevenLabs 試聽失敗', 'error');
        } finally {
            setIsTestingElevenLabsVoice(false);
        }
    };

    const handlePreview = async () => {
        if (isPreviewing) return;
        const shell = voiceShell(vp, speakerName);
        if (!canSynthesizeSpeech(shell, apiConfig)) {
            addToast('目前的語音服務商還沒配好：先填上面對應那家的音色，Key 在設置 → 其他 API', 'info');
            return;
        }
        setIsPreviewing(true);
        try {
            const { url } = await synthesizeSpeechDetailed(`你好，我是${speakerName || '我'}。現在能聽見我的聲音嗎？`, shell, apiConfig, {
                groupId: apiConfig.minimaxGroupId || undefined,
            });
            await playPreview(url);
        } catch (error: any) {
            addToast(error?.message || '試聽失敗', 'error');
        } finally {
            setIsPreviewing(false);
        }
    };

    return (
           <div className="bg-white rounded-3xl p-4 shadow-sm border border-slate-100 space-y-3">
               <div className="flex items-center justify-between">
                   <label className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest flex items-center gap-1"><SpeakerHigh size={12} /> {title}</label>
                   <div className="flex gap-1.5">
                       {onOpenDesigner && (
                       <button
                           onClick={onOpenDesigner}
                           className="text-[10px] bg-violet-50 text-violet-700 px-2 py-1 rounded font-bold hover:bg-violet-100 flex items-center gap-0.5"
                       >
                           <SlidersHorizontal size={10} weight="bold" /> 捏聲音
                       </button>
                       )}
                       {showPreview && (
                       <button
                           type="button"
                           onClick={() => void handlePreview()}
                           disabled={isPreviewing}
                           className="text-[10px] bg-sky-50 text-sky-700 px-2 py-1 rounded font-bold hover:bg-sky-100 disabled:opacity-60"
                       >
                           {isPreviewing ? '試聽中…' : '試聽'}
                       </button>
                       )}
                       <button
                           onClick={handleLoadMiniMaxVoices}
                           className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-bold hover:bg-emerald-100 disabled:opacity-60"
                           disabled={isLoadingVoices}
                       >
                           {isLoadingVoices ? '拉取中...' : '拉取可用音色'}
                       </button>
                   </div>
               </div>
               <p className="text-[11px] text-slate-500">{hint}</p>

               <div className="rounded-2xl border border-violet-200/60 bg-violet-50/40 p-2.5 space-y-2">
                   <div className="flex items-center justify-between gap-2">
                       <span className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">MiniMax 合成參數</span>
                       <span className="text-[9px] text-slate-400">老角色默認經典</span>
                   </div>
                   <div className="grid grid-cols-2 gap-1 rounded-xl bg-white/80 p-1">
                       {([
                           ['legacy', '經典參數'],
                           ['natural-v2', '新版自然參數'],
                       ] as const).map(([version, label]) => {
                           const activeVersion = vp?.minimaxParamVersion === 'natural-v2' ? 'natural-v2' : 'legacy';
                           return (
                               <button
                                   key={version}
                                   type="button"
                                   onClick={() => onChange({
                                       ...(vp || {}),
                                       minimaxParamVersion: version,
                                   })}
                                   className={`rounded-lg px-2 py-1.5 text-[10px] font-bold transition-colors ${activeVersion === version ? 'bg-violet-500 text-white shadow-sm' : 'text-slate-400'}`}
                               >
                                   {label}
                               </button>
                           );
                       })}
                   </div>
                   <p className="text-[10px] text-slate-400 leading-relaxed">
                       {vp?.minimaxParamVersion === 'natural-v2'
                           ? '對齊捏聲音試聽與聊天、見面、電話參數，保留模型原生韻律，不再自動給每個標點插停頓。'
                           : '保留現有自動停頓、參數限幅和動態情感優先規則，歷史效果不會改變。'}
                   </p>
               </div>

               <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                   <input
                       value={vp?.voiceId || ''}
                       onChange={(e) => onChange({
                           ...(vp || {}),
                           provider: 'minimax',
                           voiceId: e.target.value,
                           voiceName: vp?.voiceName || '',
                           source: vp?.source || 'custom',
                           model: vp?.model || 'speech-2.8-hd',
                           notes: vp?.notes || '',
                       })}
                       className="w-full bg-slate-50 rounded-2xl px-3 py-2 text-xs border border-slate-200"
                       placeholder="voice_id（可直接貼）"
                   />
                   <input
                       value={vp?.model || 'speech-2.8-hd'}
                       onChange={(e) => onChange({
                           ...(vp || {}),
                           provider: 'minimax',
                           voiceId: vp?.voiceId || '',
                           voiceName: vp?.voiceName || '',
                           source: vp?.source || 'custom',
                           model: e.target.value,
                           notes: vp?.notes || '',
                       })}
                       className="w-full bg-slate-50 rounded-2xl px-3 py-2 text-xs border border-slate-200"
                       placeholder="TTS 模型（默認 speech-2.8-hd）"
                   />
               </div>

               {/* 魚聲 Fish Audio 音色：僅當全局語音服務商切到魚聲時生效（設置 → 其他 API） */}
               <div className="rounded-2xl border border-sky-200/60 bg-sky-50/40 p-2.5 space-y-1.5">
                   <div className="text-[10px] font-bold text-sky-600 uppercase tracking-widest">魚聲 Fish 音色</div>
                   <input
                       value={vp?.fishReferenceId || ''}
                       onChange={(e) => onChange({
                           ...(vp || {}),
                           fishReferenceId: e.target.value,
                       })}
                       className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                       placeholder="粘貼 reference_id 或整條 fish.audio 鏈接"
                   />
                   <p className="text-[10px] text-slate-400">從 fish.audio 選好音色後，把那一頁的鏈接（含 ?modelId=…）或 32 位 id 直接貼進來都行，會自動識別。設置里語音選「魚聲 Fish」後{speedOwner}就用它合成；與上面的 MiniMax voice_id 各存各的。</p>
               </div>

               {/* ElevenLabs 音色：角色獨立保存，設置頁只負責 Key / 模型。 */}
               <div className="rounded-2xl border border-violet-200/60 bg-violet-50/40 p-2.5 space-y-1.5">
                   <div className="flex items-center justify-between gap-2">
                       <div className="text-[10px] font-bold text-violet-600 uppercase tracking-widest">ElevenLabs 音色</div>
                       <button
                           type="button"
                           onClick={() => void handleTestElevenLabsVoice()}
                           disabled={isTestingElevenLabsVoice}
                           className="text-[10px] rounded-lg border border-violet-200 bg-white px-2 py-1 font-bold text-violet-600 disabled:opacity-50"
                       >
                           {isTestingElevenLabsVoice ? '試聽中…' : '試聽'}
                       </button>
                   </div>
                   <input
                       value={vp?.elevenLabsVoiceId || ''}
                       onChange={(e) => onChange({
                           ...(vp || {}),
                           elevenLabsVoiceId: e.target.value,
                       })}
                       className="w-full bg-white rounded-2xl px-3 py-2 text-xs border border-slate-200"
                       placeholder="粘貼 Voice ID 或 ElevenLabs 音色頁面鏈接"
                   />
                   <p className="text-[10px] text-slate-400">從 ElevenLabs Voices / Voice Library 複製 Voice ID；也可直接粘貼含 voiceId 的頁面鏈接。設置里語音選 ElevenLabs 後使用，與 MiniMax、魚聲音色分別保存。</p>
               </div>

               {/* 語速：三家 TTS 共用 voiceProfile.speed */}
               <div className="space-y-1 pt-1">
                   <div className="flex items-center justify-between">
                       <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">語速</label>
                       <span className="text-[11px] font-mono text-slate-500">{(vp?.speed ?? 1).toFixed(2)}×</span>
                   </div>
                   <input
                       type="range"
                       min={0.5}
                       max={1.5}
                       step={0.05}
                       value={vp?.speed ?? 1}
                       onChange={(e) => onChange({
                           ...(vp || {}),
                           speed: parseFloat(e.target.value),
                       })}
                       className="w-full accent-primary"
                   />
                   <p className="text-[10px] text-slate-400">越小越慢、越像娓娓道來。1.0 正常；覺得“趕”就拉到 0.85–0.95。MiniMax、魚聲與 ElevenLabs 共用{speedOwner}的語速。</p>
               </div>

               {(voiceOptions.system.length + voiceOptions.voice_cloning.length + voiceOptions.voice_generation.length) > 0 && (
                   <div className="space-y-2 pt-1">
                       {([
                           ['system', '系統音色'],
                           ['voice_cloning', '復刻音色'],
                           ['voice_generation', '文生音色'],
                       ] as const).map(([source, label]) => {
                           const list = voiceOptions[source];
                           if (!list.length) return null;
                           return (
                               <div key={source}>
                                   <div className="text-[10px] text-slate-400 mb-1">{label}</div>
                                   <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                                       {list.slice(0, 50).map((v) => (
                                           <button
                                               key={`${source}-${v.voice_id}`}
                                               onClick={() => applyVoice(v, source)}
                                               className="w-full text-left px-2 py-1 rounded-xl text-xs border border-slate-200 hover:border-emerald-200 hover:bg-emerald-50/40"
                                           >
                                               <div className="font-medium text-slate-700 truncate">{v.voice_name || '未命名音色'}</div>
                                               <div className="text-[10px] text-slate-400 truncate">{v.voice_id}</div>
                                           </button>
                                       ))}
                                   </div>
                               </div>
                           );
                       })}
                   </div>
               )}
           </div>
    );
};

export default VoiceProfileFields;
