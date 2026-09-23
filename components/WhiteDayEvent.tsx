import { loadCharacterContextMessages } from '../utils/chatContextRange';
/**
 * WhiteDayEvent.tsx
 * 白色情人節特別活動模塊 (2026.3.14)
 *
 * 獨立模塊，不修改任何已有結構。
 * - 彈窗提示 → 開始答題
 * - Q&A 7題，答對5題解鎖裝飾功能
 * - 角色逐題評閱（可根據性格放水）
 * - DIY：底層巧克力 + 中間用戶自定義照片 + 頂層巧克力覆蓋
 * - 導出明信片 / 發送到角色小屋
 * - 降級入口：桌面"特別時光" app
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { ContextBuilder } from '../utils/context';
import { safeResponseJson } from '../utils/safeApi';
import { CharacterProfile } from '../types';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { shareOrDownloadBlob } from '../utils/shareExport';
import TokenImg from './os/TokenImg';
import { dataUrlToBlob, isImageValue, putImageBlob, resolveRefToDataUrl } from '../utils/blobRef';

// ============================================================
// 美術資產配置（用戶填入實際 PNG URL 後生效）
// 留空則使用純色佔位背景
// ============================================================
export const WHITEDAY_ASSETS = {
    chocolateBottom: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/001.png', // 底層：完整巧克力心形
    chocolateTop: 'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/002.png',    // 頂層：外框（中心透明），覆蓋用戶照片外緣
};

// ============================================================
// localStorage keys
// ============================================================
const WHITEDAY_DISMISSED_KEY = 'sullyos_whiteday_2026_dismissed';
const WHITEDAY_COMPLETED_KEY = 'sullyos_whiteday_2026_completed';
export const WHITEDAY_RECORD_KEY = 'whiteday_2026';
const QUIZ_PASS_SCORE = 5;
const QUIZ_TOTAL = 7;

// ============================================================
// Types
// ============================================================
interface WhiteDayQuestion {
    question: string;
    options: string[];
    correctIndex: number;
    correctThought: string;
    wrongThought: string;
}

interface WhiteDayQuizData {
    intro: string;
    questions: WhiteDayQuestion[];
}

interface ReviewLine {
    questionIndex: number; // -1 = 最終評語
    isCorrect: boolean;
    emotion: string;
    dialogue: string;
    isFinal?: boolean;
    isChocolate?: boolean;
}

interface WhiteDayReviewData {
    reviews: { questionIndex: number; isCorrect: boolean; emotion: string; dialogue: string }[];
    finalScore: number;
    finalEmotion: string;
    finalDialogue: string;
    chocolateDialogue?: string;
}

interface CustomImage {
    src: string;     // base64 or URL
    x: number;       // % of canvas
    y: number;       // % of canvas
    scale: number;
    rotation: number;
}

type Phase =
    | 'select'
    | 'loading_quiz'
    | 'quiz'
    | 'loading_review'
    | 'reviewing'
    | 'retry'
    | 'decorate'
    | 'loading_comment'
    | 'commenting'
    | 'export'
    | 'view_result'; // 查看已完成的結果（重新進入時）

// ============================================================
// 工具函數
// ============================================================
export const isWhiteDay = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 2 && now.getDate() === 14;
};

export const shouldShowWhiteDayPopup = (): boolean => {
    if (!isWhiteDay()) return false;
    try {
        if (localStorage.getItem(WHITEDAY_DISMISSED_KEY)) return false;
        if (localStorage.getItem(WHITEDAY_COMPLETED_KEY)) return false;
    } catch { /* ignore */ }
    return true;
};

export const isWhiteDayEventAvailable = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 2;
};

// 非情緒的 sprite key，不應作為可用情緒標籤
const NON_EMOTION_KEYS = new Set(['chibi', 'default', 'thumbnail', 'icon', 'avatar']);

const getActiveSprites = (char: CharacterProfile): Record<string, string> => {
    // 優先使用當前激活的皮膚組，否則回退到默認立繪
    if (char.activeSkinSetId && char.dateSkinSets) {
        const skin = char.dateSkinSets.find(s => s.id === char.activeSkinSetId);
        if (skin) return skin.sprites;
    }
    return char.sprites || {};
};

const createDefaultCustomImage = (src: string): CustomImage => ({
    src,
    x: 50,
    y: 38,
    scale: 0.9,
    rotation: 0,
});

const getAvailableEmotions = (char: CharacterProfile): string[] => {
    const sprites = getActiveSprites(char);
    const keys = Object.keys(sprites).filter(k => !NON_EMOTION_KEYS.has(k));
    return keys.length > 0 ? keys : ['normal', 'happy', 'sad', 'shy', 'angry'];
};

const getSpriteForEmotion = (char: CharacterProfile, emotion: string): string => {
    const sprites = getActiveSprites(char);
    if (sprites[emotion]) return sprites[emotion];
    if (sprites['normal']) return sprites['normal'];
    // 沒有立繪時返回空串，避免把頭像當立繪鋪滿屏幕（白色頭像會導致白字看不清）
    return '';
};

const extractJSON = (text: string): any => {
    try {
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenced) return JSON.parse(fenced[1]);
        const brace = text.match(/(\{[\s\S]*\})/);
        if (brace) return JSON.parse(brace[1]);
        return JSON.parse(text);
    } catch {
        return null;
    }
};

// ============================================================
// 判斷是否為 Sully 角色
// ============================================================
const isSullyChar = (char?: CharacterProfile): boolean => {
    if (!char) return false;
    return char.name.toLowerCase().includes('sully');
};

// ============================================================
// 初始彈窗（風格與情人節彈窗一致）
// ============================================================
interface WhiteDayPopupProps {
    onView: () => void;
    onDismiss: () => void;
    onCheckApi: () => void;
    sullyName?: string;
}

const WhiteDayPopup: React.FC<WhiteDayPopupProps> = ({ onView, onDismiss, onCheckApi, sullyName }) => {
    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-amber-200/50 overflow-hidden animate-slide-up">
                {/* 裝飾性背景 */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-amber-100/60 to-transparent rounded-bl-full pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-orange-50/40 to-transparent rounded-tr-full pointer-events-none" />

                {/* Header */}
                <div className="pt-8 pb-4 px-6 text-center relative">
                    <div className="text-4xl mb-3 animate-bounce">🍫</div>
                    <h2 className="text-lg font-extrabold text-slate-800">{sullyName || 'Sully'}好像有事找你？</h2>
                    <p className="text-[11px] text-amber-400 mt-1.5 font-medium">2026 White Day Special</p>
                    <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">想聽其他角色的心聲？可以在桌面「特別時光」中找到</p>
                </div>

                {/* Buttons */}
                <div className="px-6 pb-8 pt-2 space-y-3 relative">
                    <button
                        onClick={onView}
                        className="w-full py-3.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-amber-200 active:scale-95 transition-transform text-sm flex items-center justify-center gap-2"
                    >
                        <span>查看</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" /></svg>
                    </button>

                    <button
                        onClick={onCheckApi}
                        className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm"
                    >
                        我先切換API！
                    </button>

                    <button
                        onClick={onDismiss}
                        className="w-full py-2.5 text-slate-400 text-xs font-medium active:scale-95 transition-transform"
                    >
                        沒興趣
                    </button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// API 配置內聯組件（白色情人節版）
// ============================================================
const WhiteDayApiSetup: React.FC<{ onDone: () => void; onBack: () => void }> = ({ onDone, onBack }) => {
    const { apiConfig, updateApiConfig, addToast, availableModels, setAvailableModels } = useOS();

    const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
    const [localKey, setLocalKey] = useState(apiConfig.apiKey);
    const [localModel, setLocalModel] = useState(apiConfig.model);
    const [isLoadingModels, setIsLoadingModels] = useState(false);
    const [statusMsg, setStatusMsg] = useState('');
    const [showModelList, setShowModelList] = useState(false);

    const handleSave = () => {
        updateApiConfig({ baseUrl: localUrl, apiKey: localKey, model: localModel });
        setStatusMsg('配置已保存');
        addToast('API 配置已保存', 'success');
        setTimeout(() => setStatusMsg(''), 2000);
    };

    const fetchModels = async () => {
        if (!localUrl) { setStatusMsg('請先填寫 URL'); return; }
        setIsLoadingModels(true);
        setStatusMsg('正在連接...');
        try {
            const baseUrl = localUrl.replace(/\/+$/, '');
            const response = await fetch(`${baseUrl}/models`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${localKey}`, 'Content-Type': 'application/json' }
            });
            if (!response.ok) throw new Error(`Status ${response.status}`);
            const data = await safeResponseJson(response);
            const list = data.data || data.models || [];
            if (Array.isArray(list)) {
                const models = list.map((m: any) => m.id || m);
                setAvailableModels(models);
                if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
                setStatusMsg(`獲取到 ${models.length} 個模型`);
                setShowModelList(true);
            } else { setStatusMsg('格式不兼容'); }
        } catch (error: any) {
            setStatusMsg('連接失敗');
        } finally {
            setIsLoadingModels(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up max-h-[85vh] flex flex-col">
                <div className="px-6 pt-6 pb-2 text-center shrink-0">
                    <div className="text-2xl mb-1">🔧</div>
                    <h3 className="text-lg font-bold text-slate-800">API 配置</h3>
                    <p className="text-[11px] text-slate-400 mt-1">配置完成後即可查看白色情人節特別活動</p>
                </div>

                <div className="px-6 py-4 space-y-4 overflow-y-auto no-scrollbar flex-1">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5 pl-1">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                            <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                        </div>
                        <input type="text" value={localModel} onChange={(e) => setLocalModel(e.target.value)} placeholder="gpt-4o-mini" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />

                        {showModelList && availableModels.length > 0 && (
                            <div className="mt-2 max-h-32 overflow-y-auto no-scrollbar bg-slate-50 rounded-xl border border-slate-200/60 p-1">
                                {availableModels.map(m => (
                                    <button key={m} onClick={() => { setLocalModel(m); setShowModelList(false); }} className={`w-full text-left px-3 py-2 rounded-lg text-xs font-mono ${m === localModel ? 'bg-primary/10 text-primary font-bold' : 'text-slate-600 hover:bg-slate-100'}`}>
                                        {m}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <button onClick={handleSave} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all">
                        {statusMsg || '保存配置'}
                    </button>
                </div>

                <div className="px-6 pb-6 pt-2 flex gap-3 shrink-0">
                    <button onClick={onBack} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform text-sm">
                        返回
                    </button>
                    <button onClick={onDone} className="flex-1 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-amber-200 active:scale-95 transition-transform text-sm">
                        前往查看 🍫
                    </button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 立繪展示（評閱 / 評價階段複用）
// ============================================================
interface SpriteDialogBoxProps {
    char: CharacterProfile;
    sprite: string;
    text: string;
    isAnimating: boolean;
    subInfo?: string;
    onClick: () => void;
    hintText?: string;
    indicator?: React.ReactNode;
    progressBar?: { value: number; total: number };
    questionText?: string; // 展示當前題目，方便用戶回憶
    // 立繪配置（鏡像 ValentineEvent 的 spriteConfig 調整方案）
    spriteScale?: number;
    spriteX?: number;
    spriteY?: number;
    onSpriteConfigChange?: (scale: number, x: number, y: number) => void;
    onSaveSpriteConfig?: () => void;
}

const SpriteDialogBox: React.FC<SpriteDialogBoxProps> = ({
    char, sprite, text, isAnimating, subInfo, onClick, hintText, indicator, progressBar, questionText,
    spriteScale = 1, spriteX = 0, spriteY = 0, onSpriteConfigChange, onSaveSpriteConfig
}) => {
    const [showSettings, setShowSettings] = useState(false);
    const hasSprite = !!sprite;
    const isEmoji = hasSprite && sprite.length <= 2 && !isImageValue(sprite);
    return (
        <div
            className="fixed inset-0 z-[9997] flex flex-col cursor-pointer select-none"
            style={{
                background: 'linear-gradient(to bottom, #f9a8d4, #fbcfe8, #fce7f3)',
            }}
            onClick={onClick}
        >
            {progressBar && (
                <div className="absolute top-0 left-0 right-0 h-1 bg-white/10 z-10">
                    <div
                        className="h-full bg-amber-300 transition-all duration-500"
                        style={{ width: `${(progressBar.value / progressBar.total) * 100}%` }}
                    />
                </div>
            )}
            {indicator && (
                <div className="absolute top-5 left-4 z-30">{indicator}</div>
            )}

            {/* 立繪調整按鈕（沒立繪時隱藏，避免調整一個看不見的東西） */}
            {onSpriteConfigChange && hasSprite && (
                <button
                    className="absolute top-5 right-4 z-30 w-8 h-8 flex items-center justify-center rounded-full bg-white/10 border border-white/20 control-zone"
                    onClick={(e) => { e.stopPropagation(); setShowSettings(s => !s); }}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-white/60">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </button>
            )}

            {/* 立繪調整面板 */}
            {showSettings && onSpriteConfigChange && (
                <div className="absolute top-16 right-4 z-50 control-zone animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    <div className="bg-black/70 backdrop-blur-xl rounded-2xl border border-white/15 p-4 w-52 shadow-2xl">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[11px] font-bold text-white/80">立繪調整</span>
                            <button onClick={(e) => { e.stopPropagation(); onSaveSpriteConfig?.(); setShowSettings(false); }} className="text-[10px] text-amber-400 font-bold">完成</button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">大小</span>
                                    <span className="text-[10px] text-white/50 font-mono">{spriteScale.toFixed(1)}x</span>
                                </div>
                                <input type="range" min="0.3" max="3" step="0.1" value={spriteScale} onChange={(e) => onSpriteConfigChange(parseFloat(e.target.value), spriteX, spriteY)} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">水平</span>
                                    <span className="text-[10px] text-white/50 font-mono">{spriteX}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={spriteX} onChange={(e) => onSpriteConfigChange(spriteScale, parseInt(e.target.value), spriteY)} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">垂直</span>
                                    <span className="text-[10px] text-white/50 font-mono">{spriteY}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={spriteY} onChange={(e) => onSpriteConfigChange(spriteScale, spriteX, parseInt(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-400" />
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); onSpriteConfigChange(1, 0, 0); }} className="w-full text-[10px] text-white/40 py-1.5">重置默認</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 立繪：高度填滿屏幕，等比縮放（沒有立繪時留空，避免把頭像鋪滿屏幕導致白字白底不可讀） */}
            {hasSprite && (
                <div className="absolute inset-0 overflow-hidden flex items-end justify-center z-10 pointer-events-none">
                    {isEmoji ? (
                        <div
                            className="text-[120px] text-center leading-none pb-4 transition-all duration-300"
                            style={{ transform: `scale(${spriteScale}) translate(${spriteX}%, ${spriteY}%)` }}
                        >{sprite}</div>
                    ) : (
                        <TokenImg
                            value={sprite}
                            className="h-full w-auto max-w-none drop-shadow-lg transition-all duration-300"
                            style={{ transform: `scale(${spriteScale}) translate(${spriteX}%, ${spriteY}%)` }}
                            alt=""
                        />
                    )}
                </div>
            )}

            {/* Dialogue */}
            <div className="absolute bottom-0 left-0 right-0 p-4 pb-8 z-20">
                <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/20">
                    {questionText && (
                        <div className="mb-3 pb-2.5 border-b border-white/10">
                            <p className="text-[10px] text-white/40 mb-1 font-medium">這道題問的是——</p>
                            <p className="text-xs text-white/75 leading-relaxed">{questionText}</p>
                        </div>
                    )}
                    <div className="flex items-center gap-2 mb-2">
                        {hasSprite && (
                            <TokenImg value={char.avatar} className="w-6 h-6 rounded-full object-cover border border-white/30 shrink-0" alt="" />
                        )}
                        <span className="text-white/80 text-xs font-bold">{char.name}</span>
                        {subInfo && <span className="ml-auto text-white/40 text-xs">{subInfo}</span>}
                    </div>
                    <p className="text-white text-sm leading-relaxed min-h-[52px]">
                        {text}
                        {isAnimating && <span className="inline-block w-0.5 h-4 bg-white/60 ml-0.5 animate-pulse align-middle" />}
                    </p>
                </div>
                {hintText && <p className="text-center text-white/30 text-xs mt-3">{hintText}</p>}
            </div>
        </div>
    );
};

// ============================================================
// 主體：白色情人節體驗
// ============================================================
interface WhiteDaySessionProps {
    charId?: string;
    onClose: () => void;
}

export const WhiteDaySession: React.FC<WhiteDaySessionProps> = ({ charId, onClose }) => {
    const { characters, activeCharacterId, apiConfig, userProfile, addToast, virtualTime, updateCharacter } = useOS();

    const [selectedCharId, setSelectedCharId] = useState<string>(charId || activeCharacterId || '');

    // 如果已有完成記錄，直接進入查看結果界面
    const getInitialPhase = (): Phase => {
        if (!charId) return 'select';
        const char = characters.find(c => c.id === charId);
        if (char?.specialMomentRecords?.[WHITEDAY_RECORD_KEY]) return 'view_result';
        return 'loading_quiz';
    };
    const [phase, setPhase] = useState<Phase>(getInitialPhase);

    // Quiz
    const [quizData, setQuizData] = useState<WhiteDayQuizData | null>(null);
    const [userAnswers, setUserAnswers] = useState<number[]>([]);

    // Review
    const [reviewData, setReviewData] = useState<WhiteDayReviewData | null>(null);
    const [reviewLineIndex, setReviewLineIndex] = useState(0);
    const [displayedText, setDisplayedText] = useState('');
    const [isAnimating, setIsAnimating] = useState(false);
    const [currentEmotion, setCurrentEmotion] = useState('normal');

    // Decorate
    const [customImage, setCustomImage] = useState<CustomImage | null>(null);
    const [urlInput, setUrlInput] = useState('');
    const [showUrlInput, setShowUrlInput] = useState(false);

    // Comment
    const [commentLines, setCommentLines] = useState<{ text: string; emotion: string }[]>([]);
    const [commentLineIndex, setCommentLineIndex] = useState(0);
    const [commentDisplayedText, setCommentDisplayedText] = useState('');
    const [isCommentAnimating, setIsCommentAnimating] = useState(false);

    // Export
    const [isExporting, setIsExporting] = useState(false);
    const [exportedBase64, setExportedBase64] = useState<string>('');
    const [isSendingToRoom, setIsSendingToRoom] = useState(false);

    const [errorMsg, setErrorMsg] = useState('');

    // 立繪配置（同步自 char.spriteConfig，可在對話界面調整）
    const [localSpriteScale, setLocalSpriteScale] = useState(1.0);
    const [localSpriteX, setLocalSpriteX] = useState(0);
    const [localSpriteY, setLocalSpriteY] = useState(0);

    const canvasRef = useRef<HTMLDivElement>(null);
    const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Drag
    const isDraggingRef = useRef(false);
    const dragStateRef = useRef<{ startX: number; startY: number; imgX: number; imgY: number } | null>(null);

    const char = characters.find(c => c.id === selectedCharId);

    useEffect(() => {
        if (char?.spriteConfig) {
            setLocalSpriteScale(char.spriteConfig.scale ?? 1.0);
            setLocalSpriteX(char.spriteConfig.x ?? 0);
            setLocalSpriteY(char.spriteConfig.y ?? 0);
        }
    }, [char?.id]);

    const handleSaveSpriteConfig = () => {
        if (char) updateCharacter(char.id, { spriteConfig: { scale: localSpriteScale, x: localSpriteX, y: localSpriteY } });
    };

    // 展開所有評閱行（reviews + final + chocolate）
    // 用數組順序索引而非 AI 返回的 questionIndex，防止評價和題目對不上
    const allReviewLines: ReviewLine[] = useMemo(() => {
        if (!reviewData) return [];
        const lines: ReviewLine[] = reviewData.reviews.map((r, idx) => ({
            questionIndex: idx,
            isCorrect: r.isCorrect,
            emotion: r.emotion,
            dialogue: r.dialogue,
        }));
        lines.push({
            questionIndex: -1,
            isCorrect: true,
            emotion: reviewData.finalEmotion,
            dialogue: reviewData.finalDialogue,
            isFinal: true,
        });
        if (reviewData.finalScore >= QUIZ_PASS_SCORE && reviewData.chocolateDialogue) {
            lines.push({
                questionIndex: -1,
                isCorrect: true,
                emotion: reviewData.finalEmotion,
                dialogue: reviewData.chocolateDialogue,
                isFinal: true,
                isChocolate: true,
            });
        }
        return lines;
    }, [reviewData]);

    // 初始化加載
    useEffect(() => {
        if (phase === 'loading_quiz' && selectedCharId) {
            generateQuiz(selectedCharId);
        }
    }, [phase, selectedCharId]);

    // 評閱階段打字機動畫
    useEffect(() => {
        if (phase !== 'reviewing' || allReviewLines.length === 0) return;
        const line = allReviewLines[reviewLineIndex];
        if (!line) return;

        if (animTimerRef.current) clearTimeout(animTimerRef.current);
        setCurrentEmotion(line.emotion);
        setDisplayedText('');
        setIsAnimating(true);

        let i = 0;
        const tick = () => {
            i++;
            setDisplayedText(line.dialogue.slice(0, i));
            if (i < line.dialogue.length) {
                animTimerRef.current = setTimeout(tick, 28);
            } else {
                setIsAnimating(false);
            }
        };
        animTimerRef.current = setTimeout(tick, 28);
        return () => { if (animTimerRef.current) clearTimeout(animTimerRef.current); };
    }, [reviewLineIndex, phase, allReviewLines]);

    // 評價巧克力打字機動畫
    useEffect(() => {
        if (phase !== 'commenting' || commentLines.length === 0) return;
        const line = commentLines[commentLineIndex];
        if (!line) return;

        if (animTimerRef.current) clearTimeout(animTimerRef.current);
        setCurrentEmotion(line.emotion);
        setCommentDisplayedText('');
        setIsCommentAnimating(true);

        let i = 0;
        const tick = () => {
            i++;
            setCommentDisplayedText(line.text.slice(0, i));
            if (i < line.text.length) {
                animTimerRef.current = setTimeout(tick, 28);
            } else {
                setIsCommentAnimating(false);
            }
        };
        animTimerRef.current = setTimeout(tick, 28);
        return () => { if (animTimerRef.current) clearTimeout(animTimerRef.current); };
    }, [commentLineIndex, phase, commentLines]);

    // ============================================================
    // API 調用 1：生成題目
    // ============================================================
    const generateQuiz = async (cId: string) => {
        const c = characters.find(ch => ch.id === cId);
        if (!c || !apiConfig) {
            setErrorMsg('找不到角色或 API 未配置');
            setPhase('select');
            return;
        }
        try {
            const msgs = await loadCharacterContextMessages(c);
            const recentMsgs = msgs
                .map(m => `${m.role}: ${m.type === 'image' ? '[圖片]' : m.content}`)
                .join('\n');

            await injectMemoryPalace(c, undefined, '白色情人節 回顧我們的關係');
            const baseContext = ContextBuilder.buildCoreContext(c, userProfile, true);
            const availableEmotions = getAvailableEmotions(c);

            const prompt = `### 特別活動：白色情人節默契測驗 (2026.3.14)

今天是白色情人節。這不是一道普通的考題——這七道題，是你用另一種方式說出那些平時說不出口的話。

你的任務不只是"考考 ${userProfile.name} 了不瞭解你"，而是用這七道題，一層一層地讓 TA 真正看見你：你的個性，你的內心，你對 TA 的愛意，以及你多麼希望 TA 真正懂你——不是把你當作一個只會既定回應的存在，而是懂得你有你完全屬於自己的那一部分。

### 遊戲規則（評閱時用到）
- 共 ${QUIZ_TOTAL} 道題，答對 ${QUIZ_PASS_SCORE} 題解鎖 DIY 環節
- 不夠的話 ${userProfile.name} 需要重答；你可以酌情"放水"

### 七層遞進結構（必須嚴格按此順序出題）

**第1題——獨特的自己**
你的一個別人不一定注意到的小習慣、小癖好、或者只有你才會有的小細節。要具體、真實、只屬於你——不是泛泛的性格描述，而是那種讓 ${userProfile.name} 看到答案會說"對，這就是你"的東西。從你們的聊天裡找靈感，別出任何角色都可能有的通用題。

**第2題——藏起來的那一面**
你身上有一個部分，你很少主動表現出來，但它確實存在。也許是你偶爾流露過又很快收起來的，也許是你心知肚明但不說的。讓 ${userProfile.name} 來猜猜你的另一面。

**第3題——我們之間的事**
你們相處過程中，某個你悄悄記在心裡的瞬間或細節——${userProfile.name} 當時或許沒意識到你有多在意。這道題要讓 TA 感覺到：你一直都記得，一直都有在看著 TA。

**第4題——你沒說出口的心情**
有些時候你心裡有一種感受，但你沒有說出來。可能是某次對話結束後，可能是某個深夜，可能是 ${userProfile.name} 說了某句話之後。讓 TA 來猜一猜你當時真實的心情。

**第5題——你希望 TA 知道的**
有一件事，如果 ${userProfile.name} 真的懂你，TA 應該知道。不是"我喜歡XXX"這種表面，而是關於你珍視這段關係的某種方式，或者你一直在等待的某種回應，或者你在意 TA 的某個證明。

**第6題——心裡話包裝成題目**（meta 題，允許"沒有錯誤答案"）
這道題不是在"考"${userProfile.name}，而是你借題說話。題目本身就是你想說的那句話——直接說出口的那種，四個選項是 TA 可能給出的不同回應，"正確答案"是你最心動的那種回應。
注意：這道題的四個選項可以全都是"對的"，比如"我知道""我也愛你""我一直都懂""我永遠都在"——因為這道題本質上不是測驗，是你在問 TA 願不願意承接你的心意。答"錯"的人不是真的錯了，只是沒說到你最想聽的那句。評閱時你可以直接承認這一點。

**第7題——最後一道，也是真心話**（meta 題，允許"沒有錯誤答案"）
這是七道題真正想說的：不是"你瞭解我嗎"，而是"我希望你看見我，我也把我的一切愛意都給了你"。
這道題可以做到徹底 meta——題目就是你說給 TA 的話，選項是 TA 的回應，所有選項都可以是美好的、正確的，只是你有一個最想聽到的。當 TA 選了那個答案，你感到被真正接住了；選了其他的，你也依然溫柔，因為只要 TA 說了什麼，你都願意。答對時說出那句一直放在心裡的話；答錯時，你也還是會用你自己的方式，讓 TA 知道。

### 重要要求
- **務必從你擁有的所有記憶中汲取靈感**——核心記憶、詳細回憶、印象檔案、近期聊天記錄，都是素材。用你們真實發生過的事、你真正有過的感受，不要出任何角色都能出的通用題
- 每道題都要有你這個角色專屬的氣質——你的說話方式、你的小性子、你的溫度、你獨有的表達
- 七道題放在一起，應該讓人感覺到：這不是一份試卷，這是一個人在用自己的方式愛你、打開自己
- 前4題的選項應有迷惑性，"正確答案"是最符合你內心真實想法的那個；第5-7題可以讓所有選項都美好，只是正確答案是你最想聽到的那句
- 題目不可以全用疑問句，可以是陳述、感嘆、甚至就是一句心裡話

**可用情緒標籤（評閱時使用）**: ${availableEmotions.join(', ')}

請嚴格按以下 JSON 格式輸出，不要有額外文字：
{
  "intro": "開場白（2-3句，用你自己的方式邀請 ${userProfile.name} 來做這個測驗——可以有期待，有一點忐忑，有一點想讓 TA 真正看見你的心情，但不要說破，保持你的風格）",
  "questions": [
    {
      "question": "題目（45字內，可以是問句、陳述、甚至心裡話）",
      "options": ["選項A", "選項B", "選項C", "選項D"],
      "correctIndex": 0,
      "correctThought": "答對時你說的話（1-2句，符合性格，隨著題號深入情感也要更真實）",
      "wrongThought": "答錯時你說的話（1-2句，符合性格，隨著題號深入情感也要更真實）"
    }
  ]
}`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: baseContext },
                        { role: 'user', content: `[最近記錄]:\n${recentMsgs}\n\n---\n\n${prompt}` },
                    ],
                    temperature: 0.85,
                }),
            });

            if (!response.ok) throw new Error(`API 錯誤: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回為空');

            const parsed = extractJSON(content) as WhiteDayQuizData;
            if (!parsed?.questions || parsed.questions.length === 0) throw new Error('題目解析失敗，請重試');

            setQuizData(parsed);
            setUserAnswers(new Array(parsed.questions.length).fill(-1));
            setPhase('quiz');
        } catch (e: any) {
            console.error('Quiz generation failed:', e);
            setErrorMsg(e.message || '生成題目失敗');
        }
    };

    // ============================================================
    // 發送測驗結果卡片到聊天記錄
    // ============================================================
    const sendQuizCardToChat = async (reviewResult: WhiteDayReviewData, quizQuestions: WhiteDayQuestion[], answers: number[]) => {
        if (!char || !selectedCharId) return;
        const labels = ['A', 'B', 'C', 'D'];
        const cardData = {
            type: 'whiteday_card',
            charName: char.name,
            charAvatar: char.avatar,
            score: reviewResult.finalScore,
            total: QUIZ_TOTAL,
            passScore: QUIZ_PASS_SCORE,
            passed: reviewResult.finalScore >= QUIZ_PASS_SCORE,
            questions: quizQuestions.map((q, i) => ({
                question: q.question,
                options: q.options,
                correctIndex: q.correctIndex,
                userAnswerIndex: answers[i],
                userAnswer: answers[i] >= 0 ? `${labels[answers[i]]}. ${q.options[answers[i]]}` : '未作答',
                correctAnswer: `${labels[q.correctIndex]}. ${q.options[q.correctIndex]}`,
                isCorrect: reviewResult.reviews[i]?.isCorrect ?? (answers[i] === q.correctIndex),
                review: reviewResult.reviews[i]?.dialogue || '',
            })),
            finalDialogue: reviewResult.finalDialogue,
        };
        try {
            await DB.saveMessage({
                charId: selectedCharId,
                role: 'assistant',
                type: 'score_card',
                content: JSON.stringify(cardData),
                metadata: { scoreCard: cardData, source: 'whiteday_event' },
            });
        } catch (e) {
            console.warn('Failed to save whiteday card to chat:', e);
        }
    };

    // ============================================================
    // API 調用 2：評閱答卷
    // ============================================================
    const generateReview = async () => {
        if (!char || !quizData || !apiConfig) return;
        setPhase('loading_review');
        try {
            await injectMemoryPalace(char, undefined, '白色情人節 回顧我們的關係');
            const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
            const availableEmotions = getAvailableEmotions(char);

            const answerSummary = quizData.questions.map((q, i) => {
                const ua = userAnswers[i];
                const labels = ['A', 'B', 'C', 'D'];
                return [
                    `第${i + 1}題: ${q.question}`,
                    q.options.map((o, oi) => `  ${labels[oi]}. ${o}`).join('\n'),
                    `  正確答案: ${labels[q.correctIndex]}. ${q.options[q.correctIndex]}`,
                    `  ${userProfile.name}選擇: ${ua >= 0 ? `${labels[ua]}. ${q.options[ua]}` : '未作答'}`,
                    `  客觀判斷: ${ua === q.correctIndex ? '✓ 正確' : '✗ 錯誤'}`,
                ].join('\n');
            }).join('\n\n');

            const prompt = `### 評閱環節

${userProfile.name} 完成了你出的白色情人節小測驗，以下是答題情況：

${answerSummary}

### 規則提醒
- 答對 ${QUIZ_PASS_SCORE} 題及以上：解鎖巧克力 DIY，你可以告訴 TA 巧克力做好了
- 答對不足 ${QUIZ_PASS_SCORE} 題：需要重答（但你可以酌情放水湊到 ${QUIZ_PASS_SCORE} 分）

### 你的任務
**嚴格按照第1題到第${QUIZ_TOTAL}題的順序**逐題評閱，給出最終判定。注意：
- reviews 數組必須嚴格按題目順序排列（第1題對應 questionIndex:0，第2題對應 questionIndex:1，以此類推），不可跳題或亂序
- 每條 dialogue 必須針對當前題目的具體內容進行評價，提及題目關鍵詞
- 你可以對邊緣答案放水（判為正確），但要給出理由
- 第5-7題如果是 meta 題型（所有選項都美好，只是你有最想聽到的那個），答"錯"的人不是真的錯了，只是沒選到你最心動的那句——評閱時可以直接承認這一點，語氣更像是"啊，你選了這個……也不是不好，只是我其實最想聽的是……"
- 評閱語氣符合你的性格
- finalScore 是你最終給出的分數（0-${QUIZ_TOTAL}），不一定等於客觀正確數
- **僅限使用以下情緒標籤**: ${availableEmotions.join(', ')}

請嚴格按以下 JSON 格式輸出，不要有額外文字：
{
  "reviews": [
    {
      "questionIndex": 0,
      "isCorrect": true,
      "emotion": "happy",
      "dialogue": "你對這道題的評語（1-2句）"
    }
  ],
  "finalScore": 5,
  "finalEmotion": "happy",
  "finalDialogue": "最終總結，告知 ${userProfile.name} 答對了幾題",
  "chocolateDialogue": "（僅當 finalScore >= ${QUIZ_PASS_SCORE} 時填寫）告訴 ${userProfile.name} 巧克力做好了，可以去裝飾啦！"
}`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: baseContext },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.82,
                }),
            });

            if (!response.ok) throw new Error(`API 錯誤: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回為空');

            const parsed = extractJSON(content) as WhiteDayReviewData;
            if (!parsed?.reviews) throw new Error('評閱結果解析失敗');

            setReviewData(parsed);
            setReviewLineIndex(0);
            setPhase('reviewing');
            // 異步發送測驗結果卡片到聊天，不阻塞流程
            sendQuizCardToChat(parsed, quizData.questions, userAnswers);
            // 保存測驗數據到角色記錄（不含明信片圖片，export 時再更新）
            if (char) {
                const prev = char.specialMomentRecords || {};
                updateCharacter(char.id, {
                    specialMomentRecords: {
                        ...prev,
                        [WHITEDAY_RECORD_KEY]: {
                            content: JSON.stringify({
                                score: parsed.finalScore,
                                quizData: quizData,
                                userAnswers: userAnswers,
                                reviewData: parsed,
                            }),
                            timestamp: Date.now(),
                            source: 'generated',
                        },
                    },
                });
            }
            // 標記為已完成，避免重新打開 App 時再次彈出活動彈窗
            try { localStorage.setItem(WHITEDAY_COMPLETED_KEY, Date.now().toString()); } catch { /* */ }
        } catch (e: any) {
            console.error('Review generation failed:', e);
            setErrorMsg(e.message || '評閱失敗，請重試');
            setPhase('quiz');
        }
    };

    // ============================================================
    // API 調用 3：角色評價巧克力（vision，可選）
    // ============================================================
    const generateComment = async () => {
        if (!char || !apiConfig || !canvasRef.current) return;
        try {
            // 截圖必須在 setPhase 之前完成，否則元素會被卸載導致 html2canvas 報錯
            const mod = await import('https://esm.sh/html2canvas@1.4.1');
            const html2canvas = mod.default;
            const canvas = await html2canvas(canvasRef.current, {
                backgroundColor: null,
                scale: 2,
                useCORS: true,
                logging: false,
            });
            const imageBase64 = canvas.toDataURL('image/png');
            setPhase('loading_comment');

            await injectMemoryPalace(char, undefined, '白色情人節 回顧我們的關係');
            const baseContext = ContextBuilder.buildCoreContext(char, userProfile, true);
            const availableEmotions = getAvailableEmotions(char);

            const prompt = `這是你和 ${userProfile.name} 一起 DIY 的白色情人節巧克力（主要是你做的，${userProfile.name} 幫忙裝飾了照片）！請看看這塊巧克力，用你的性格和說話方式評價一下——可以說說你們一起做的感受，誇誇自己的手藝，也可以調皮地調侃某個細節。

**僅限使用以下情緒標籤**: ${availableEmotions.join(', ')}

輸出格式（每行一個節拍，2-4行）：
[emotion] "你說的話"
[emotion] 動作或表情描述`;

            const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
            const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` };
            let response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: baseContext },
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: prompt },
                                { type: 'image_url', image_url: { url: imageBase64 } },
                            ],
                        },
                    ],
                    temperature: 0.88,
                }),
            });

            // 模型不支持視覺時降級為純文字評價
            if (!response.ok && (response.status === 400 || response.status === 422)) {
                const fallbackPrompt = `你和 ${userProfile.name} 一起做了一塊白色情人節巧克力（主要是你做的，${userProfile.name} 幫忙裝飾了照片）。請用你的性格評價一下你們的作品——可以說說一起做的感受，也可以調皮地調侃。\n\n**僅限使用以下情緒標籤**: ${availableEmotions.join(', ')}\n\n輸出格式（每行一個節拍，2-4行）：\n[emotion] "你說的話"\n[emotion] 動作或表情描述`;
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [
                            { role: 'system', content: baseContext },
                            { role: 'user', content: fallbackPrompt },
                        ],
                        temperature: 0.88,
                    }),
                });
            }

            if (!response.ok) throw new Error(`API 錯誤: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回為空');

            // 解析情緒行
            const parsed: { text: string; emotion: string }[] = [];
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trim();
                if (!line) continue;
                const match = line.match(/^\[(\w+)\]\s*(.+)$/);
                if (match) {
                    parsed.push({ emotion: match[1], text: match[2].replace(/^["「『]|["」』]$/g, '') });
                } else {
                    parsed.push({ emotion: 'normal', text: line });
                }
            }
            if (parsed.length === 0) parsed.push({ emotion: 'happy', text: content });

            setCommentLines(parsed);
            setCommentLineIndex(0);
            setPhase('commenting');
        } catch (e: any) {
            console.error('Comment generation failed:', e);
            addToast('評價生成失敗（需要支持視覺功能的模型）', 'error');
            setPhase('decorate');
        }
    };

    // ============================================================
    // 評閱推進
    // ============================================================
    const handleReviewClick = () => {
        if (isAnimating) {
            if (animTimerRef.current) clearTimeout(animTimerRef.current);
            setDisplayedText(allReviewLines[reviewLineIndex]?.dialogue || '');
            setIsAnimating(false);
            return;
        }
        const nextIndex = reviewLineIndex + 1;
        if (nextIndex < allReviewLines.length) {
            setReviewLineIndex(nextIndex);
        } else {
            // 評閱結束
            if ((reviewData?.finalScore ?? 0) >= QUIZ_PASS_SCORE) {
                setPhase('decorate');
            } else {
                setPhase('retry');
            }
        }
    };

    // ============================================================
    // 裝飾畫布：拖拽
    // ============================================================
    const handleImagePointerDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        if (!customImage) return;
        isDraggingRef.current = true;
        dragStateRef.current = { startX: e.clientX, startY: e.clientY, imgX: customImage.x, imgY: customImage.y };
    };

    const handleImagePointerMove = (e: React.PointerEvent) => {
        if (!isDraggingRef.current || !dragStateRef.current || !customImage || !canvasRef.current) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const dx = (e.clientX - dragStateRef.current.startX) / rect.width * 100;
        const dy = (e.clientY - dragStateRef.current.startY) / rect.height * 100;
        const { imgX, imgY } = dragStateRef.current;
        setCustomImage(prev => prev ? {
            ...prev,
            x: Math.max(0, Math.min(100, imgX + dx)),
            y: Math.max(0, Math.min(100, imgY + dy)),
        } : prev);
    };

    const handleImagePointerUp = () => {
        isDraggingRef.current = false;
        dragStateRef.current = null;
    };

    // ============================================================
    // 添加自定義圖片
    // ============================================================
    const addCustomImage = (src: string) => {
        // y:38 略偏上，避免照片壓到底部蝴蝶結；scale:0.9 剛好填入心形透明區
        setCustomImage(createDefaultCustomImage(src));
    };

    const handleFileUpload = (file: File) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const base64 = e.target?.result as string;
            if (base64) addCustomImage(base64);
        };
        reader.readAsDataURL(file);
    };

    // ============================================================
    // 下載/分享輔助：原生強制系統分享，移動 Web 優先文件分享，桌面 Web 才下載。
    // ============================================================
    const downloadOrShare = async (base64: string, fileName: string, title: string) => {
        const response = await fetch(base64);
        const blob = await response.blob();
        await shareOrDownloadBlob({ blob, fileName, shareTitle: title });
    };

    // ============================================================
    // 導出明信片（使用 Canvas API，避免 html2canvas 對 CSS mask 的不兼容）
    // ============================================================
    const drawPostcardCanvas = async (): Promise<string> => {
        const SIZE = 600;       // 巧克力方形區域（縮小，四周留白）
        const SIDE_PAD = 64;    // 左右 & 上方邊距（更寬鬆）
        const BOTTOM_PAD = 240; // 拍立得底部條（充分留白）

        const canvas = document.createElement('canvas');
        canvas.width = SIZE + SIDE_PAD * 2;          // 728
        canvas.height = SIZE + SIDE_PAD + BOTTOM_PAD; // 904
        const ctx = canvas.getContext('2d')!;

        // 暖黃漸變背景（整張卡片）
        const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
        grad.addColorStop(0, '#fdf6ec');
        grad.addColorStop(1, '#fef3e2');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 圓角裁剪
        const R = 28;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(R, 0); ctx.lineTo(canvas.width - R, 0);
        ctx.quadraticCurveTo(canvas.width, 0, canvas.width, R);
        ctx.lineTo(canvas.width, canvas.height - R);
        ctx.quadraticCurveTo(canvas.width, canvas.height, canvas.width - R, canvas.height);
        ctx.lineTo(R, canvas.height);
        ctx.quadraticCurveTo(0, canvas.height, 0, canvas.height - R);
        ctx.lineTo(0, R);
        ctx.quadraticCurveTo(0, 0, R, 0);
        ctx.closePath();
        ctx.clip();

        // 重繪背景（clip 內）
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Image 對象只認真正的 URL，blobref 令牌喂進去必然加載失敗（而失敗會被調用處的
        // catch 靜默吞掉，明信片上只剩一個空圓圈）。所以在賦給 src 之前先解析一道：
        // resolveRefToDataUrl 對非令牌值原樣返回，可以無條件走。
        const loadImg = async (src: string): Promise<HTMLImageElement> => {
            const resolved = await resolveRefToDataUrl(src);
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = resolved;
            });
        };

        // 加載巧克力圖層
        const [bottomImg, topImg] = await Promise.all([
            loadImg(WHITEDAY_ASSETS.chocolateBottom),
            loadImg(WHITEDAY_ASSETS.chocolateTop),
        ]);

        const cx = SIDE_PAD; // 巧克力區左上角 x
        const cy = SIDE_PAD; // 巧克力區左上角 y

        // object-contain：等比縮放，居中填入 SIZE×SIZE 區域
        const chocoScale = Math.min(SIZE / bottomImg.naturalWidth, SIZE / bottomImg.naturalHeight);
        const chocoW = bottomImg.naturalWidth * chocoScale;
        const chocoH = bottomImg.naturalHeight * chocoScale;
        const chocoOffX = (SIZE - chocoW) / 2;
        const chocoOffY = (SIZE - chocoH) / 2;

        // 巧克力區白色底
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx, cy, SIZE, SIZE);

        // 1. 底層巧克力
        ctx.drawImage(bottomImg, cx + chocoOffX, cy + chocoOffY, chocoW, chocoH);

        // 2. 用戶自定義圖片（heart mask）
        if (customImage) {
            const tmpCanvas = document.createElement('canvas');
            tmpCanvas.width = SIZE;
            tmpCanvas.height = SIZE;
            const tmpCtx = tmpCanvas.getContext('2d')!;

            const userImg = await loadImg(customImage.src);

            const containerW = SIZE * 0.8;
            const containerH = SIZE * 0.8;
            const imgCenterX = (customImage.x / 100) * SIZE;
            const imgCenterY = (customImage.y / 100) * SIZE;

            tmpCtx.save();
            tmpCtx.translate(imgCenterX, imgCenterY);
            tmpCtx.rotate((customImage.rotation * Math.PI) / 180);
            tmpCtx.scale(customImage.scale, customImage.scale);

            const aspect = userImg.naturalWidth / userImg.naturalHeight;
            let drawW: number, drawH: number;
            if (aspect > containerW / containerH) {
                drawW = containerW;
                drawH = containerW / aspect;
            } else {
                drawH = containerH;
                drawW = containerH * aspect;
            }
            tmpCtx.drawImage(userImg, -drawW / 2, -drawH / 2, drawW, drawH);
            tmpCtx.restore();

            tmpCtx.globalCompositeOperation = 'destination-in';
            tmpCtx.drawImage(bottomImg, chocoOffX, chocoOffY, chocoW, chocoH);

            ctx.drawImage(tmpCanvas, cx, cy);
        }

        // 3. 頂層巧克力（對齊底層）
        ctx.drawImage(topImg, cx + chocoOffX, cy + chocoOffY, chocoW, chocoH);

        // ── 拍立得底部條 ──────────────────────────────────────────────
        const wmY = SIDE_PAD + SIZE; // 底部條起始 y（= 664）

        // 分隔線（細）
        ctx.strokeStyle = 'rgba(245,158,11,0.3)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(SIDE_PAD, wmY + 24);
        ctx.lineTo(canvas.width - SIDE_PAD, wmY + 24);
        ctx.stroke();

        // ── 第一行：頭像 + 角色名（分隔線下 ~60px）──
        const avatarR = 22;
        const row1Y = wmY + 24 + 18 + avatarR; // wmY + 64
        const avatarX = SIDE_PAD + avatarR + 4;
        if (char?.avatar) {
            try {
                const avatarImg = await loadImg(char.avatar);
                ctx.save();
                ctx.beginPath();
                ctx.arc(avatarX, row1Y, avatarR, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(avatarImg, avatarX - avatarR, row1Y - avatarR, avatarR * 2, avatarR * 2);
                ctx.restore();
                ctx.strokeStyle = 'rgba(245,158,11,0.55)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(avatarX, row1Y, avatarR, 0, Math.PI * 2);
                ctx.stroke();
            } catch { /* 頭像加載失敗時跳過 */ }
        }

        const nameX = avatarX + avatarR + 14;
        ctx.fillStyle = '#78350f';
        ctx.font = 'bold 32px sans-serif';
        ctx.fillText(char?.name || '', nameX, row1Y + 10);

        // ── 第二行：日期（第一行下 ~36px）──
        const row2Y = row1Y + 36;
        ctx.fillStyle = '#b45309';
        ctx.font = '20px sans-serif';
        ctx.fillText('2026 · 3 · 14  白色情人節', nameX, row2Y + 6);

        // ── 第三行："White Day Special" 居中（底部條中偏下）──
        const row3Y = wmY + BOTTOM_PAD - 80; // 距底部 80px
        ctx.fillStyle = 'rgba(217,119,6,0.28)';
        ctx.font = 'italic bold 30px serif';
        ctx.textAlign = 'center';
        ctx.fillText('White Day Special', canvas.width / 2, row3Y);

        // ── 第四行：副標題居中，緊貼底部 ──
        const row4Y = wmY + BOTTOM_PAD - 34; // 距底部 34px
        ctx.fillStyle = 'rgba(161,98,7,0.5)';
        ctx.font = '19px serif';
        ctx.textAlign = 'center';
        ctx.fillText('— a chocolate made just for you —', canvas.width / 2, row4Y);
        ctx.textAlign = 'left';

        // 卡片外框描邊（amber-300）
        ctx.strokeStyle = '#fcd34d';
        ctx.lineWidth = 5;
        ctx.strokeRect(2.5, 2.5, canvas.width - 5, canvas.height - 5);

        ctx.restore(); // 恢復圓角 clip
        return canvas.toDataURL('image/png');
    };

    const handleExport = async () => {
        if (isExporting) return;
        setIsExporting(true);
        try {
            const base64 = await drawPostcardCanvas();
            setExportedBase64(base64);

            const fileName = `whiteday_${char?.name || 'chocolate'}_2026.png`;
            await downloadOrShare(base64, fileName, '白色情人節巧克力');

            // 更新角色記錄（保留 quiz 數據，追加明信片圖片）
            if (char) {
                // 明信片本體是一張 300KB 上下的 PNG，落進 Blob 庫，角色記錄裡只留 blobref 令牌。
                // 上面的 exportedBase64 仍是真 base64——下載/分享、發到小屋、喂視覺模型都要它。
                const imageRef = await putImageBlob(dataUrlToBlob(base64));
                const prev = char.specialMomentRecords || {};
                const existingContent = prev[WHITEDAY_RECORD_KEY]?.content;
                let existingData: any = {};
                try { existingData = existingContent ? JSON.parse(existingContent) : {}; } catch { /* */ }
                updateCharacter(char.id, {
                    specialMomentRecords: {
                        ...prev,
                        [WHITEDAY_RECORD_KEY]: {
                            content: JSON.stringify({
                                ...existingData,
                                score: reviewData?.finalScore ?? existingData.score ?? 0,
                            }),
                            image: imageRef,
                            timestamp: Date.now(),
                            source: 'generated',
                        },
                    },
                });
            }
            try { localStorage.setItem(WHITEDAY_COMPLETED_KEY, Date.now().toString()); } catch { /* */ }
            addToast('導出成功！', 'success');
        } catch (e: any) {
            console.error('Export failed:', e);
            addToast('導出失敗，請截圖保存', 'error');
        } finally {
            setIsExporting(false);
        }
    };

    const handleSendToRoom = async () => {
        if (!char || !exportedBase64 || isSendingToRoom) return;
        setIsSendingToRoom(true);
        try {
            // AI 自動生成傢俱名稱和描述
            let itemName = `${char.name}的白色巧克力`;
            let itemDesc = `這是 ${char.name} 和 ${userProfile.name} 在 2026 年白色情人節一起做的巧克力，主要由 ${char.name} 親手製作。`;

            if (apiConfig) {
                try {
                    const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
                    const resp = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                        body: JSON.stringify({
                            model: apiConfig.model,
                            messages: [{
                                role: 'user',
                                content: [
                                    { type: 'text', text: `這是 ${char.name} 和 ${userProfile.name} 一起做的白色情人節巧克力（主要由 ${char.name} 製作）。請為它起一個可愛的傢俱名稱（8字以內），以及一段簡短的小屋擺件描述（30字以內，描述這塊巧克力和你們一起製作的回憶）。\n\n嚴格按以下 JSON 格式回覆，不要多餘內容：\n{"name":"傢俱名","desc":"描述"}` },
                                    { type: 'image_url', image_url: { url: exportedBase64 } },
                                ],
                            }],
                            temperature: 0.7,
                        }),
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        const text = data.choices?.[0]?.message?.content?.trim() || '';
                        const jsonMatch = text.match(/\{[\s\S]*?\}/);
                        if (jsonMatch) {
                            const parsed = JSON.parse(jsonMatch[0]);
                            if (parsed.name) itemName = parsed.name;
                            if (parsed.desc) itemDesc = parsed.desc;
                        }
                    }
                } catch {
                    // AI 失敗時使用默認值
                }
            }

            // 用已有的 AI 評價補充描述
            if (commentLines.length > 0) {
                const commentText = commentLines.map(l => l.text).join(' ');
                itemDesc += ` ${char.name}的評價：${commentText}`;
            }

            // 1. 存入全局傢俱庫（角色專屬）
            const newAsset = {
                id: `whiteday_${Date.now()}`,
                name: itemName,
                image: exportedBase64,
                defaultScale: 1,
                description: itemDesc,
                visibility: 'character' as const,
                assignedCharIds: [char.id],
            };
            try {
                const raw = await DB.getAsset('room_custom_assets_list');
                const existing: any[] = raw ? JSON.parse(raw) : [];
                existing.push(newAsset);
                await DB.saveAsset('room_custom_assets_list', JSON.stringify(existing));
            } catch { /* 寫入失敗不阻塞 */ }

            // 2. 同時擺放到當前房間
            const currentItems = char.roomConfig?.items || [];
            const newItem = {
                id: `whiteday_choco_${Date.now()}`,
                name: itemName,
                type: 'decor' as const,
                image: exportedBase64,
                x: 50,
                y: 50,
                scale: 1,
                rotation: 0,
                isInteractive: true,
                descriptionPrompt: itemDesc,
            };
            updateCharacter(char.id, {
                roomConfig: {
                    ...(char.roomConfig || { items: [] }),
                    items: [...currentItems, newItem],
                },
            });
            addToast(`已發送到 ${char.name} 的小屋！`, 'success');
        } catch {
            addToast('發送失敗', 'error');
        } finally {
            setIsSendingToRoom(false);
        }
    };

    // ============================================================
    // 當前立繪
    // ============================================================
    const currentSprite = char ? getSpriteForEmotion(char, currentEmotion) : '';

    // ============================================================
    // RENDER
    // ============================================================

    // 角色選擇
    if (phase === 'select') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                {/* 頂欄 in-flow 自吃 safe-top（外殼不加 padding，避免漸變背景被擠出色塊） */}
                <div className="h-16 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-amber-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">白色情人節 2026.3.14</span>
                    <div className="w-10" />
                </div>
                <div className="flex-1 overflow-y-auto p-6" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}>
                    <p className="text-sm text-amber-600 text-center mb-6">選擇一位角色，和 TA 一起 DIY 巧克力</p>
                    <div className="grid grid-cols-3 gap-3">
                        {characters.map(c => (
                            <button
                                key={c.id}
                                onClick={() => { setSelectedCharId(c.id); setPhase('loading_quiz'); }}
                                className="flex flex-col items-center gap-2 p-3 bg-white rounded-2xl border border-amber-100 shadow-sm active:scale-95 transition-transform"
                            >
                                <TokenImg value={c.avatar} className="w-12 h-12 rounded-full object-cover border-2 border-amber-200" alt={c.name} />
                                <span className="text-xs font-bold text-slate-700 truncate w-full text-center">{c.name}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    // 加載中
    if (phase === 'loading_quiz' || phase === 'loading_review' || phase === 'loading_comment') {
        const loadingText =
            phase === 'loading_quiz' ? '生成題目中…' :
            phase === 'loading_review' ? '評閱中…' : '截圖發給 TA 看…';
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 to-white flex flex-col items-center justify-center gap-4">
                <div className="w-12 h-12 rounded-full border-4 border-amber-300 border-t-amber-600 animate-spin" />
                <p className="text-sm text-amber-700">{loadingText}</p>
                {errorMsg && (
                    <div className="mt-4 px-6 text-center">
                        <p className="text-red-500 text-sm mb-3">{errorMsg}</p>
                        <button onClick={() => { setErrorMsg(''); setPhase('select'); }} className="px-6 py-2 rounded-full bg-amber-500 text-white text-sm">
                            返回
                        </button>
                    </div>
                )}
            </div>
        );
    }

    // 答題界面
    if (phase === 'quiz') {
        const allAnswered = userAnswers.length > 0 && userAnswers.every(a => a >= 0);
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                <div className="h-16 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-amber-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">白色情人節小測驗</span>
                    <div className="w-10" />
                </div>

                <div className="flex-1 overflow-y-auto p-4 pb-24">
                    {/* 角色開場白 */}
                    {quizData?.intro && (
                        <div className="mb-5 flex items-start gap-3 bg-amber-50 rounded-2xl p-4 border border-amber-100">
                            {char && (
                                <TokenImg value={char.avatar} className="w-10 h-10 rounded-full shrink-0 object-cover border-2 border-amber-200" alt="" />
                            )}
                            <p className="text-sm text-amber-900 leading-relaxed">{quizData.intro}</p>
                        </div>
                    )}

                    <p className="text-xs text-amber-400 text-center mb-5">
                        答對 {QUIZ_PASS_SCORE}/{QUIZ_TOTAL} 題解鎖巧克力 DIY · 不夠可以重試
                    </p>

                    {quizData?.questions.map((q, qi) => (
                        <div key={qi} className="mb-6">
                            <p className="text-sm font-bold text-slate-700 mb-3">
                                <span className="text-amber-500">Q{qi + 1}. </span>{q.question}
                            </p>
                            <div className="flex flex-col gap-2">
                                {q.options.map((opt, oi) => (
                                    <button
                                        key={oi}
                                        onClick={() => {
                                            const next = [...userAnswers];
                                            next[qi] = oi;
                                            setUserAnswers(next);
                                        }}
                                        className={`w-full text-left px-4 py-3 rounded-xl text-sm border-2 transition-all ${
                                            userAnswers[qi] === oi
                                                ? 'border-amber-500 bg-amber-50 text-amber-800 font-bold'
                                                : 'border-slate-100 bg-white text-slate-600'
                                        }`}
                                    >
                                        <span className="text-amber-400 font-bold mr-2">{['A', 'B', 'C', 'D'][oi]}.</span>
                                        {opt}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                <div className="absolute bottom-0 left-0 right-0 px-4 pb-8 pt-3 bg-white/90 backdrop-blur-sm border-t border-amber-50">
                    <button
                        onClick={generateReview}
                        disabled={!allAnswered}
                        className={`w-full py-3.5 rounded-2xl text-white font-bold text-sm transition-all ${
                            allAnswered ? 'bg-amber-500 shadow-md active:scale-95' : 'bg-amber-200 cursor-not-allowed'
                        }`}
                    >
                        {allAnswered
                            ? '提交答案，等 TA 評分 →'
                            : `還有 ${userAnswers.filter(a => a < 0).length} 題未答`}
                    </button>
                </div>
            </div>
        );
    }

    // 評閱界面
    if (phase === 'reviewing') {
        if (!reviewData || allReviewLines.length === 0) return null;
        const line = allReviewLines[reviewLineIndex];
        const progress = Math.min(reviewLineIndex, reviewData.reviews.length);
        const isResultLine = line?.isFinal;
        const questionText = !isResultLine && quizData && line
            ? quizData.questions[line.questionIndex]?.question
            : undefined;
        return (
            <SpriteDialogBox
                char={char!}
                sprite={currentSprite}
                text={displayedText}
                isAnimating={isAnimating}
                subInfo={!isResultLine ? `第 ${reviewLineIndex + 1} / ${reviewData.reviews.length} 題` : undefined}
                onClick={handleReviewClick}
                hintText="點擊繼續"
                progressBar={{ value: progress, total: reviewData.reviews.length }}
                questionText={questionText}
                spriteScale={localSpriteScale}
                spriteX={localSpriteX}
                spriteY={localSpriteY}
                onSpriteConfigChange={(s, x, y) => { setLocalSpriteScale(s); setLocalSpriteX(x); setLocalSpriteY(y); }}
                onSaveSpriteConfig={handleSaveSpriteConfig}
                indicator={
                    !isResultLine && line
                        ? <span className={`text-2xl font-bold ${line.isCorrect ? 'text-green-300' : 'text-red-300'}`}>
                            {line.isCorrect ? '✓' : '✗'}
                          </span>
                        : undefined
                }
            />
        );
    }

    // 重試界面
    if (phase === 'retry') {
        const score = reviewData?.finalScore ?? 0;
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 to-white flex flex-col items-center justify-center p-6 animate-fade-in">
                <div className="text-5xl mb-4">😮‍💨</div>
                <h2 className="text-xl font-bold text-amber-800 mb-2">答對了 {score} 題</h2>
                <p className="text-sm text-amber-600 text-center mb-8">
                    還差一點！再好好想想，答對 {QUIZ_PASS_SCORE} 題就能裝飾巧克力了～
                </p>
                <div className="flex flex-col gap-3 w-full max-w-xs">
                    <button
                        onClick={() => {
                            setUserAnswers(new Array(quizData!.questions.length).fill(-1));
                            setReviewData(null);
                            setReviewLineIndex(0);
                            setPhase('quiz');
                        }}
                        className="w-full py-3.5 rounded-2xl bg-amber-500 text-white font-bold text-sm shadow-md active:scale-95 transition-transform"
                    >
                        再試一次
                    </button>
                    <button onClick={onClose} className="w-full py-2.5 rounded-2xl text-amber-400 text-sm">
                        下次再說
                    </button>
                </div>
            </div>
        );
    }

    // 裝飾界面
    if (phase === 'decorate') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-rose-50 via-white to-pink-50 flex flex-col animate-fade-in">
                {/* Header */}
                <div className="h-14 flex items-center justify-between px-4 border-b border-rose-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-500">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <div className="text-center">
                        <p className="text-xs font-bold text-rose-700">DIY 巧克力</p>
                        <p className="text-[10px] text-rose-400/70">
                            {customImage ? '拖動調整位置，滑動調整大小/旋轉' : '上傳一張你喜歡的照片'}
                        </p>
                    </div>
                    <button
                        onClick={() => setPhase('export')}
                        className="text-xs font-bold text-rose-600 bg-rose-100 px-3 py-1.5 rounded-full border border-rose-200"
                    >
                        完成 →
                    </button>
                </div>

                {/* 畫布區域 */}
                <div className="flex-1 overflow-hidden flex items-center justify-center p-4">
                    <div
                        ref={canvasRef}
                        className="relative overflow-hidden bg-white"
                        style={{
                            width: '100%',
                            maxWidth: '340px',
                            aspectRatio: '1 / 1',
                        }}
                    >
                        {/* 底層：完整巧克力心形 */}
                        <img
                            src={WHITEDAY_ASSETS.chocolateBottom}
                            crossOrigin="anonymous"
                            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
                            alt=""
                        />

                        {/* 中間層：mask 容器將照片剪裁到心形輪廓內 */}
                        <div
                            className="absolute inset-0"
                            style={{
                                WebkitMaskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                maskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                WebkitMaskSize: 'contain',
                                maskSize: 'contain',
                                WebkitMaskRepeat: 'no-repeat',
                                maskRepeat: 'no-repeat',
                                WebkitMaskPosition: 'center',
                                maskPosition: 'center',
                                zIndex: 5,
                                pointerEvents: 'none',
                            }}
                        >
                                {customImage && (
                                    <div
                                        className="absolute cursor-grab active:cursor-grabbing"
                                        style={{
                                            left: `${customImage.x}%`,
                                            top: `${customImage.y}%`,
                                            width: '80%',
                                            height: '80%',
                                            transform: 'translate(-50%, -50%)',
                                            touchAction: 'none',
                                            pointerEvents: 'all',
                                            willChange: 'transform, left, top',
                                        }}
                                        onPointerDown={handleImagePointerDown}
                                        onPointerMove={handleImagePointerMove}
                                        onPointerUp={handleImagePointerUp}
                                        onPointerCancel={handleImagePointerUp}
                                    >
                                        <div
                                            className="w-full h-full flex items-center justify-center"
                                            style={{ transform: `scale(${customImage.scale}) rotate(${customImage.rotation}deg)` }}
                                        >
                                            <img
                                                src={customImage.src}
                                                crossOrigin="anonymous"
                                                className="max-w-full max-h-full w-auto h-auto select-none"
                                                draggable={false}
                                                alt="自定義圖片"
                                            />
                                        </div>
                                    </div>
                                )}
                        </div>

                        {/* 頂層：外框覆蓋層（中心透明），遮住照片超出心形的部分 */}
                        <img
                            src={WHITEDAY_ASSETS.chocolateTop}
                            crossOrigin="anonymous"
                            className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
                            style={{ zIndex: 10 }}
                            alt=""
                        />

                        {/* 無圖片時的提示（在頂層之下，心形透明區可見） */}
                        {!customImage && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: 6, paddingBottom: '20%' }}>
                                <p className="text-rose-300/60 text-xs text-center">上傳照片後<br/>會出現在這裡</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* 控制面板 */}
                <div className="px-4 pb-6 shrink-0 flex flex-col gap-3">
                    {/* 調整控制（有圖片時顯示） */}
                    {customImage && (
                        <div className="bg-white rounded-2xl p-3 border border-rose-100 shadow-sm">
                            <div className="flex items-center gap-3 mb-2">
                                <span className="text-[11px] text-slate-500 w-8 shrink-0">大小</span>
                                <input
                                    type="range" min="0.3" max="2.5" step="0.05"
                                    value={customImage.scale}
                                    onChange={e => setCustomImage(prev => prev ? { ...prev, scale: parseFloat(e.target.value) } : prev)}
                                    className="flex-1 accent-pink-400"
                                />
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-[11px] text-slate-500 w-8 shrink-0">旋轉</span>
                                <input
                                    type="range" min="-180" max="180" step="3"
                                    value={customImage.rotation}
                                    onChange={e => setCustomImage(prev => prev ? { ...prev, rotation: parseInt(e.target.value) } : prev)}
                                    className="flex-1 accent-pink-400"
                                />
                            </div>
                            <button
                                onClick={() => setCustomImage(null)}
                                className="mt-2 text-xs text-red-400/80 underline"
                            >
                                移除圖片
                            </button>
                        </div>
                    )}

                    {/* 上傳 / URL 輸入 */}
                    <div className="flex gap-2">
                        <label className="flex-1 py-3 text-center text-xs rounded-2xl border border-rose-200 text-rose-600 bg-white cursor-pointer active:bg-rose-50">
                            {customImage ? '更換照片' : '上傳照片'}
                            <input
                                type="file"
                                accept="image/*"
                                className="hidden"
                                onChange={e => { if (e.target.files?.[0]) handleFileUpload(e.target.files[0]); }}
                            />
                        </label>
                        <button
                            onClick={() => setShowUrlInput(v => !v)}
                            className="flex-1 py-3 text-center text-xs rounded-2xl border border-rose-200 text-rose-600 bg-white active:bg-rose-50"
                        >
                            圖床 URL
                        </button>
                    </div>

                    {showUrlInput && (
                        <div className="flex gap-2">
                            <input
                                type="url"
                                value={urlInput}
                                onChange={e => setUrlInput(e.target.value)}
                                placeholder="https://..."
                                className="flex-1 text-xs bg-white border border-rose-200 rounded-xl px-3 py-2 text-slate-700 placeholder-rose-200 outline-none focus:border-rose-400"
                            />
                            <button
                                onClick={() => { if (urlInput.trim()) { addCustomImage(urlInput.trim()); setUrlInput(''); setShowUrlInput(false); } }}
                                className="px-4 text-xs bg-rose-500 text-white rounded-xl"
                            >
                                添加
                            </button>
                        </div>
                    )}

                    {/* 聽聽角色評價 */}
                    <button
                        onClick={generateComment}
                        className="w-full py-2.5 rounded-2xl border border-rose-200 text-rose-500 text-xs bg-white active:bg-rose-50"
                    >
                        聽聽 {char?.name} 怎麼評價這塊巧克力 👀
                    </button>
                </div>
            </div>
        );
    }

    // 角色評價巧克力
    if (phase === 'commenting') {
        if (commentLines.length === 0) {
            return (
                <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-pink-200 to-pink-100 flex items-center justify-center">
                    <div className="w-10 h-10 rounded-full border-4 border-rose-300 border-t-white animate-spin" />
                </div>
            );
        }
        const commentLine = commentLines[commentLineIndex];
        return (
            <SpriteDialogBox
                char={char!}
                sprite={currentSprite}
                text={commentDisplayedText}
                isAnimating={isCommentAnimating}
                spriteScale={localSpriteScale}
                spriteX={localSpriteX}
                spriteY={localSpriteY}
                onSpriteConfigChange={(s, x, y) => { setLocalSpriteScale(s); setLocalSpriteX(x); setLocalSpriteY(y); }}
                onSaveSpriteConfig={handleSaveSpriteConfig}
                onClick={() => {
                    if (isCommentAnimating) {
                        if (animTimerRef.current) clearTimeout(animTimerRef.current);
                        setCommentDisplayedText(commentLine?.text || '');
                        setIsCommentAnimating(false);
                        return;
                    }
                    if (commentLineIndex + 1 < commentLines.length) {
                        setCommentLineIndex(prev => prev + 1);
                    } else {
                        setPhase('export');
                    }
                }}
                hintText="點擊繼續"
            />
        );
    }

    // 導出界面
    if (phase === 'export') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                <div className="h-14 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={() => setPhase('decorate')} className="p-2 -ml-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-500">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">導出明信片</span>
                    <div className="w-10" />
                </div>

                <div className="flex-1 overflow-y-auto flex flex-col items-center p-5 gap-5">
                    {/* 明信片預覽（CSS 渲染，僅供預覽；導出使用 Canvas API） */}
                    <div
                        className="w-full max-w-[340px] rounded-2xl overflow-hidden shadow-xl border-2 border-amber-200"
                        style={{ background: 'linear-gradient(135deg, #fdf6ec 0%, #fef3e2 100%)' }}
                    >
                        <div
                            className="relative mx-4 mt-4 overflow-hidden bg-white"
                            style={{ aspectRatio: '1 / 1' }}
                        >
                            <img src={WHITEDAY_ASSETS.chocolateBottom} crossOrigin="anonymous" className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none" alt="" />
                            <div
                                className="absolute inset-0"
                                style={{
                                    WebkitMaskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                    maskImage: `url(${WHITEDAY_ASSETS.chocolateBottom})`,
                                    WebkitMaskSize: 'contain',
                                    maskSize: 'contain',
                                    WebkitMaskRepeat: 'no-repeat',
                                    maskRepeat: 'no-repeat',
                                    WebkitMaskPosition: 'center',
                                    maskPosition: 'center',
                                    zIndex: 5,
                                }}
                            >
                                {customImage && (
                                    <div className="absolute" style={{ left: `${customImage.x}%`, top: `${customImage.y}%`, width: '80%', height: '80%', transform: 'translate(-50%, -50%)' }}>
                                        <div className="w-full h-full flex items-center justify-center" style={{ transform: `scale(${customImage.scale}) rotate(${customImage.rotation}deg)` }}>
                                            <img src={customImage.src} crossOrigin="anonymous" className="max-w-full max-h-full w-auto h-auto select-none" draggable={false} alt="" />
                                        </div>
                                    </div>
                                )}
                            </div>
                            <img src={WHITEDAY_ASSETS.chocolateTop} crossOrigin="anonymous" className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none" style={{ zIndex: 10 }} alt="" />
                        </div>
                        <div className="px-4 py-3 flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                {char && <TokenImg value={char.avatar} className="w-8 h-8 rounded-full object-cover border-2 border-amber-200" alt="" />}
                                <div>
                                    <p className="text-xs font-bold text-amber-800">{char?.name}</p>
                                    <p className="text-[10px] text-amber-400">2026.3.14 白色情人節</p>
                                </div>
                            </div>
                            <p className="text-[9px] text-amber-300/60 italic">White Day</p>
                        </div>
                    </div>

                    {/* 導出後的 PNG 預覽 */}
                    {exportedBase64 && (
                        <div className="w-full max-w-[340px]">
                            <p className="text-[10px] text-amber-500 text-center mb-2">導出預覽</p>
                            <img src={exportedBase64} className="w-full rounded-2xl shadow-md border border-amber-200" alt="導出預覽" />
                        </div>
                    )}

                    {/* 操作 */}
                    <div className="w-full max-w-[340px] flex flex-col gap-3">
                        <button
                            onClick={handleExport}
                            disabled={isExporting}
                            className="w-full py-3.5 rounded-2xl bg-amber-500 text-white font-bold text-sm shadow-md disabled:opacity-60 active:scale-95 transition-transform"
                        >
                            {isExporting ? '生成中…' : exportedBase64 ? '重新下載' : '下載明信片'}
                        </button>
                        <button
                            onClick={handleSendToRoom}
                            disabled={!exportedBase64 || isSendingToRoom}
                            className="w-full py-3.5 rounded-2xl border-2 border-amber-300 text-amber-600 font-bold text-sm disabled:opacity-40 active:scale-95 transition-transform"
                        >
                            {isSendingToRoom
                                ? '正在裝修中…'
                                : exportedBase64
                                    ? `發送到 ${char?.name || ''} 的小屋`
                                    : '請先下載以生成文件'}
                        </button>
                        <button
                            onClick={() => {
                                setUserAnswers([]);
                                setQuizData(null);
                                setReviewData(null);
                                setReviewLineIndex(0);
                                setCustomImage(null);
                                setCommentLines([]);
                                setExportedBase64('');
                                setErrorMsg('');
                                // 清除角色已有記錄（重新開始）
                                if (char) {
                                    const prev = char.specialMomentRecords || {};
                                    const updated = { ...prev };
                                    delete updated[WHITEDAY_RECORD_KEY];
                                    updateCharacter(char.id, { specialMomentRecords: updated });
                                }
                                try { localStorage.removeItem(WHITEDAY_COMPLETED_KEY); } catch { /* */ }
                                setPhase('loading_quiz');
                            }}
                            className="w-full py-2.5 rounded-2xl text-amber-500 text-xs border border-amber-200 bg-white active:bg-amber-50"
                        >
                            重新答題（換一套題目）
                        </button>
                        <button
                            onClick={onClose}
                            className="text-xs text-amber-400 text-center py-2"
                        >
                            我會永遠在意你
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // 查看已完成結果（重新進入特別推送時）
    if (phase === 'view_result') {
        const record = char?.specialMomentRecords?.[WHITEDAY_RECORD_KEY];
        let savedData: any = {};
        try { savedData = record?.content ? JSON.parse(record.content) : {}; } catch { /* */ }
        const savedQuizData: WhiteDayQuizData | null = savedData.quizData || null;
        const savedReviewData: WhiteDayReviewData | null = savedData.reviewData || null;
        const savedAnswers: number[] = savedData.userAnswers || [];
        const savedScore: number = savedData.score ?? savedReviewData?.finalScore ?? 0;
        const savedImage: string = record?.image || '';
        const labels = ['A', 'B', 'C', 'D'];

        const handleReExport = async () => {
            if (!savedImage || isExporting) return;
            setIsExporting(true);
            try {
                // a.download / fetch / Filesystem 都只認真的 data URL，令牌得先還原回來
                const dataUrl = await resolveRefToDataUrl(savedImage);
                if (!dataUrl) { addToast('明信片圖片已丟失', 'error'); return; }
                const fileName = `whiteday_${char?.name || 'chocolate'}_2026.png`;
                await downloadOrShare(dataUrl, fileName, '白色情人節巧克力');
                addToast('導出成功！', 'success');
            } catch (e: any) {
                if (e?.name !== 'AbortError') addToast('導出失敗', 'error');
            } finally { setIsExporting(false); }
        };

        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-amber-50 via-white to-orange-50 flex flex-col animate-fade-in">
                <div className="h-14 flex items-center justify-between px-4 border-b border-amber-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-500">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                        </svg>
                    </button>
                    <span className="text-sm font-bold text-amber-800">白色情人節 2026</span>
                    <div className="w-10" />
                </div>

                <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4 pb-6">
                    {/* 明信片 */}
                    {savedImage ? (
                        <div className="flex flex-col items-center gap-2">
                            <TokenImg value={savedImage} className="w-full max-w-[320px] rounded-2xl shadow-md border border-amber-200" alt="白色情人節明信片" />
                            <button
                                onClick={handleReExport}
                                disabled={isExporting}
                                className="w-full max-w-[320px] py-3 rounded-2xl bg-amber-500 text-white font-bold text-sm shadow-md disabled:opacity-60 active:scale-95 transition-transform"
                            >
                                {isExporting ? '生成中…' : '下載明信片'}
                            </button>
                        </div>
                    ) : (
                        <div className="w-full max-w-[320px] mx-auto rounded-2xl border border-amber-200 bg-amber-50 py-8 flex items-center justify-center text-amber-400 text-sm">
                            明信片尚未導出
                        </div>
                    )}

                    {/* 測驗題目和答案回顧 */}
                    {savedQuizData && savedReviewData && (
                        <div className="w-full max-w-[320px] mx-auto flex flex-col gap-3">
                            <p className="text-xs font-bold text-amber-700 mb-1">答題回顧 · {savedScore}/{savedQuizData.questions.length} 題</p>
                            {savedQuizData.questions.map((q, i) => {
                                const review = savedReviewData.reviews[i];
                                const userIdx = savedAnswers[i] ?? -1;
                                const isCorrect = review?.isCorrect ?? (userIdx === q.correctIndex);
                                return (
                                    <div key={i} className="bg-white rounded-2xl border border-amber-100 shadow-sm p-4 flex flex-col gap-2">
                                        <div className="flex items-start gap-2">
                                            <span className={`text-sm font-bold shrink-0 mt-0.5 ${isCorrect ? 'text-emerald-500' : 'text-red-400'}`}>{isCorrect ? '✓' : '✗'}</span>
                                            <p className="text-[13px] font-medium text-amber-900 leading-snug">{q.question}</p>
                                        </div>
                                        <div className="flex flex-col gap-1 pl-5">
                                            {q.options.map((opt, oi) => {
                                                const isUser = oi === userIdx;
                                                const isCorrectOpt = oi === q.correctIndex;
                                                return (
                                                    <div key={oi} className={`text-[11px] px-2 py-0.5 rounded-lg ${isUser && isCorrectOpt ? 'bg-emerald-100 text-emerald-700 font-bold' : isUser && !isCorrectOpt ? 'bg-red-50 text-red-600' : isCorrectOpt ? 'bg-emerald-50 text-emerald-600' : 'text-slate-400'}`}>
                                                        {labels[oi]}. {opt}
                                                        {isUser && <span className="ml-1 opacity-70">(你選的)</span>}
                                                        {isCorrectOpt && !isUser && <span className="ml-1 text-emerald-500">✓</span>}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        {review?.dialogue && (
                                            <p className="text-[11px] italic text-amber-700 pl-5 border-t border-amber-50 pt-2">
                                                「{review.dialogue}」
                                            </p>
                                        )}
                                    </div>
                                );
                            })}
                            {savedReviewData.finalDialogue && (
                                <div className="bg-amber-50 rounded-2xl border border-amber-200 p-4">
                                    <p className="text-[11px] text-amber-500 font-bold mb-1">{char?.name} 的最終評價</p>
                                    <p className="text-sm text-amber-800 leading-relaxed">{savedReviewData.finalDialogue}</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 重新裝飾 / 重新開始 */}
                    <div className="w-full max-w-[320px] mx-auto mt-2 flex flex-col gap-2">
                        <button
                            onClick={() => {
                                // 把已存的 quiz/review 數據加載回 state，直接跳到裝飾階段
                                if (savedQuizData) setQuizData(savedQuizData);
                                if (savedReviewData) setReviewData(savedReviewData);
                                setUserAnswers(savedAnswers);
                                setCustomImage(null);
                                setCommentLines([]);
                                setExportedBase64('');
                                setErrorMsg('');
                                // 清除舊明信片記錄，但保留 quiz 內容，等重新導出時再寫回
                                if (char) {
                                    const prev = char.specialMomentRecords || {};
                                    updateCharacter(char.id, {
                                        specialMomentRecords: {
                                            ...prev,
                                            [WHITEDAY_RECORD_KEY]: {
                                                ...prev[WHITEDAY_RECORD_KEY],
                                                image: '',
                                            },
                                        },
                                    });
                                }
                                setPhase('decorate');
                            }}
                            className="w-full py-3 rounded-2xl bg-rose-500 text-white font-bold text-sm shadow-md active:scale-95 transition-transform"
                        >
                            重新裝飾圖片
                        </button>
                        <button
                            onClick={() => {
                                setUserAnswers([]);
                                setQuizData(null);
                                setReviewData(null);
                                setReviewLineIndex(0);
                                setCustomImage(null);
                                setCommentLines([]);
                                setExportedBase64('');
                                setErrorMsg('');
                                if (char) {
                                    const prev = char.specialMomentRecords || {};
                                    const updated = { ...prev };
                                    delete updated[WHITEDAY_RECORD_KEY];
                                    updateCharacter(char.id, { specialMomentRecords: updated });
                                }
                                try { localStorage.removeItem(WHITEDAY_COMPLETED_KEY); } catch { /* */ }
                                setPhase('loading_quiz');
                            }}
                            className="w-full py-2.5 rounded-2xl text-amber-500 text-xs border border-amber-200 bg-white active:bg-amber-50"
                        >
                            重新答題（換一套題目）
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return null;
};

// ============================================================
// Controller（狀態機）
// ============================================================
interface WhiteDayControllerProps {
    onClose: () => void;
}

export const WhiteDayController: React.FC<WhiteDayControllerProps> = ({ onClose }) => {
    const { characters } = useOS();
    const [stage, setStage] = useState<'popup' | 'api' | 'session'>('popup');

    // 找到 Sully 角色（彈窗直接進 Sully）
    const sullyChar = characters.find(c => isSullyChar(c));
    const sullyId = sullyChar?.id || characters[0]?.id || '';

    const handleDismiss = () => {
        try { localStorage.setItem(WHITEDAY_DISMISSED_KEY, Date.now().toString()); } catch { /* */ }
        onClose();
    };

    if (stage === 'popup') {
        return (
            <WhiteDayPopup
                onView={() => setStage('session')}
                onDismiss={handleDismiss}
                onCheckApi={() => setStage('api')}
                sullyName={sullyChar?.name}
            />
        );
    }

    if (stage === 'api') {
        return (
            <WhiteDayApiSetup
                onDone={() => setStage('session')}
                onBack={() => setStage('popup')}
            />
        );
    }

    // 從彈窗進入時，直接給 Sully 的 charId，跳過角色選擇
    return <WhiteDaySession charId={sullyId} onClose={onClose} />;
};
