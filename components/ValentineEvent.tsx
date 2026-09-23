import { loadCharacterContextMessages } from '../utils/chatContextRange';

/**
 * ValentineEvent.tsx
 * 情人節特別推送模塊 (2026.2.14)
 *
 * 獨立模塊，不修改任何已有結構。
 * - 彈窗提示 → 查看 / 沒興趣 / 先檢查API
 * - 特殊頁面：向AI發送情人節提示詞，DateApp風格立繪展示
 * - 對話存入 chat/date 通用上下文
 * - 降級入口：桌面第三頁 "特別時光" app
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { ContextBuilder } from '../utils/context';
import { safeResponseJson } from '../utils/safeApi';
import { AppID, CharacterProfile, SpecialMomentRecord } from '../types';
import { shareOrDownloadBlob } from '../utils/shareExport';
import TokenImg from './os/TokenImg';
import { isImageValue } from '../utils/blobRef';
import { WhiteDaySession, isWhiteDayEventAvailable, WHITEDAY_RECORD_KEY } from './WhiteDayEvent';
import { Like520Session, isLike520EventAvailable, isLike520Past, LIKE520_RECORD_KEY } from './Like520Event';
import {
    QixiDemoSession,
    QIXI_DEMO_RECORD_KEY,
    QixiReplaySnapshot,
    QixiReturnPayload,
    QixiSessionMode,
} from './events/qixi/QixiDemoEvent';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { markAmsgStateDirty } from '../utils/amsgStateSync';
import { createQixiChatMessagePair } from '../utils/qixiChatCard';

// ============================================================
// 情人節立繪 Sprite 映射 (佔位 emoji，等圖片整理好後替換為圖床URL)
// ============================================================
const VALENTINE_SPRITES: Record<string, string> = {
    happy:   'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vha.png',
    sad:     'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vsad.png',
    normal:  'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VNormal.png',
    angry:   'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VAn.png',
    shy:     'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/Vshy.png',
    love:    'https://cdn.jsdelivr.net/gh/qegj567-cloud/SullyOS-assets@main/bgm/SULLY/VBl.png',
};

// localStorage keys
const VALENTINE_DISMISSED_KEY = 'sullyos_valentine_2026_dismissed';
const VALENTINE_COMPLETED_KEY = 'sullyos_valentine_2026_completed';
const VALENTINE_RECORD_KEY = 'valentine_2026';

// ============================================================
// 工具函數
// ============================================================

/** 判斷今天是否是情人節 (2026-02-14) */
const isValentineDay = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 1 && now.getDate() === 14;
};

/** 判斷是否應該顯示彈窗 */
export const shouldShowValentinePopup = (): boolean => {
    if (!isValentineDay()) return false;
    try {
        if (localStorage.getItem(VALENTINE_DISMISSED_KEY)) return false;
        if (localStorage.getItem(VALENTINE_COMPLETED_KEY)) return false;
    } catch { /* ignore */ }
    return true;
};

/** 判斷情人節活動是否當前可用（2026年2月） */
export const isValentineEventAvailable = (): boolean => {
    const now = new Date();
    return now.getFullYear() === 2026 && now.getMonth() === 1;
};

/** 判斷情人節活動是否已過期（2026年2月之後，永久可回看） */
export const isValentinePast = (): boolean => {
    const now = new Date();
    return now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() > 1);
};

// ============================================================
// 解析對話中的情緒標籤
// ============================================================
interface ValentineDialogueLine {
    text: string;
    emotion: string;
}

const parseValentineDialogue = (raw: string): ValentineDialogueLine[] => {
    if (!raw) return [];
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const results: ValentineDialogueLine[] = [];
    let currentEmotion = 'normal';

    for (const line of lines) {
        // Skip system noise
        if (line.startsWith('(') && line.endsWith(')')) continue;
        if (line.startsWith('[system') || line.startsWith('(system')) continue;

        const tagMatch = line.match(/^\[([a-zA-Z0-9_\-]+)\]\s*(.*)/);
        let content = line;

        if (tagMatch) {
            currentEmotion = tagMatch[1].toLowerCase();
            content = tagMatch[2];
        } else {
            const standaloneTag = line.match(/^\[([a-zA-Z0-9_\-]+)\]$/);
            if (standaloneTag) {
                currentEmotion = standaloneTag[1].toLowerCase();
                continue;
            }
        }
        if (content) {
            results.push({ text: content, emotion: currentEmotion });
        }
    }
    return results;
};

/** 判斷是否為 Sully 角色 */
const isSullyChar = (char?: CharacterProfile): boolean => {
    if (!char) return false;
    return char.name.toLowerCase().includes('sully');
};

/** 獲取角色實際可用的表情列表（用於 prompt） */
const getAvailableEmotions = (char: CharacterProfile): string[] => {
    if (isSullyChar(char)) {
        // Sully 使用情人節專屬表情
        return Object.keys(VALENTINE_SPRITES);
    }
    // 其他角色：從 sprites 配置 + customDateSprites 獲取實際可用表情
    const REQUIRED = ['normal', 'happy', 'angry', 'sad', 'shy'];
    const custom = char.customDateSprites || [];
    const available = [...REQUIRED, ...custom];
    // 只保留角色真正有立繪的
    if (char.sprites) {
        return available.filter(e => char.sprites![e]);
    }
    return available;
};

/** 獲取情緒對應的立繪 */
const getSpriteForEmotion = (emotion: string, char?: CharacterProfile): { type: 'image' | 'emoji', value: string } => {
    if (!char) {
        return { type: 'emoji', value: VALENTINE_SPRITES['normal'] };
    }

    const isSully = isSullyChar(char);

    if (isSully) {
        // Sully: 優先情人節專屬立繪佔位，未來會替換為圖床URL
        const valentineMap: Record<string, string> = {
            happy: 'happy', sad: 'sad', normal: 'normal',
            angry: 'angry', shy: 'shy', love: 'love',
            upset: 'angry', excited: 'happy', bliss: 'love',
            embarrassed: 'shy', joyful: 'happy', tender: 'love',
        };
        const mapped = valentineMap[emotion] || 'normal';
        const spriteUrl = VALENTINE_SPRITES[mapped];
        // 當佔位emoji被替換為URL後，這裡會自動識別為 image 類型
        if (isImageValue(spriteUrl)) {
            return { type: 'image', value: spriteUrl };
        }
        return { type: 'emoji', value: spriteUrl || VALENTINE_SPRITES['normal'] };
    }

    // 非 Sully 角色：使用角色自己的見面立繪（和 DateApp 一致）
    if (char.sprites) {
        const sprite = char.sprites[emotion] || char.sprites['normal'];
        if (sprite) {
            return { type: 'image', value: sprite };
        }
    }
    // 最終降級到頭像
    return { type: 'image', value: char.avatar };
};

// ============================================================
// 情人節彈窗組件
// ============================================================
interface ValentinePopupProps {
    onView: () => void;
    onDismiss: () => void;
    onCheckApi: () => void;
}

export const ValentinePopup: React.FC<ValentinePopupProps> = ({ onView, onDismiss, onCheckApi }) => {
    return (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-5 animate-fade-in">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-md" />
            <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-pink-200/50 overflow-hidden animate-slide-up">
                {/* 裝飾性心形背景 */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-pink-100/60 to-transparent rounded-bl-full pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-red-50/40 to-transparent rounded-tr-full pointer-events-none" />

                {/* Header */}
                <div className="pt-8 pb-4 px-6 text-center relative">
                    <div className="text-4xl mb-3 animate-bounce">💌</div>
                    <h2 className="text-lg font-extrabold text-slate-800">Sully好像有話對你說？</h2>
                    <p className="text-[11px] text-pink-400 mt-1.5 font-medium">2026 Valentine's Day Special</p>
                    <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">想聽其他角色的心聲？可以在桌面「特別時光」中找到</p>
                </div>

                {/* Buttons */}
                <div className="px-6 pb-8 pt-2 space-y-3 relative">
                    <button
                        onClick={onView}
                        className="w-full py-3.5 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-transform text-sm flex items-center justify-center gap-2"
                    >
                        <span>查看</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clipRule="evenodd" /></svg>
                    </button>

                    <button
                        onClick={onCheckApi}
                        className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm"
                    >
                        我先檢查API！
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
// API 配置內聯組件 (復刻 Settings 中的 API 配置部分)
// ============================================================
const InlineApiSetup: React.FC<{ onDone: () => void; onBack: () => void }> = ({ onDone, onBack }) => {
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
                    <p className="text-[11px] text-slate-400 mt-1">配置完成後即可查看情人節特別推送</p>
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
                    <button onClick={onDone} className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-200 active:scale-95 transition-transform text-sm">
                        前往查看 💌
                    </button>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 情人節特別頁面 - 核心體驗
// ============================================================
interface ValentineSessionProps {
    charId?: string; // 如果從"特別時光"app進入，可以指定角色
    onClose: () => void;
}

export const ValentineSession: React.FC<ValentineSessionProps> = ({ charId, onClose }) => {
    const { characters, activeCharacterId, apiConfig, userProfile, addToast, virtualTime, updateCharacter, groups, realtimeConfig } = useOS();

    // 角色選擇
    const [selectedCharId, setSelectedCharId] = useState<string>(charId || activeCharacterId || '');
    const [phase, setPhase] = useState<'select' | 'loading' | 'session' | 'error'>(charId ? 'loading' : 'select');

    // 對話狀態
    const [dialogueLines, setDialogueLines] = useState<ValentineDialogueLine[]>([]);
    const [currentLineIndex, setCurrentLineIndex] = useState(0);
    const [displayedText, setDisplayedText] = useState('');
    const [isAnimating, setIsAnimating] = useState(false);
    const [currentEmotion, setCurrentEmotion] = useState('normal');
    const [fullContent, setFullContent] = useState('');
    const [errorMsg, setErrorMsg] = useState('');

    const scrollRef = useRef<HTMLDivElement>(null);
    const recordRef = useRef<HTMLDivElement>(null);

    const char = characters.find(c => c.id === selectedCharId);

    // 立繪調整
    const [showSpriteSettings, setShowSpriteSettings] = useState(false);
    const [localSpriteScale, setLocalSpriteScale] = useState(char?.spriteConfig?.scale ?? 1);
    const [localSpriteX, setLocalSpriteX] = useState(char?.spriteConfig?.x ?? 0);
    const [localSpriteY, setLocalSpriteY] = useState(char?.spriteConfig?.y ?? 0);

    // 記錄視圖
    const [showRecord, setShowRecord] = useState(false);
    const [isExporting, setIsExporting] = useState(false);

    // 長按刪除
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleLongPressStart = (cId: string) => {
        longPressTimer.current = setTimeout(() => {
            setDeleteTargetId(cId);
        }, 600);
    };
    const handleLongPressEnd = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };
    const handleDeleteRecord = async (cId: string) => {
        try {
            // 1. 刪除角色上的 specialMomentRecords
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updatedRecords = { ...(targetChar.specialMomentRecords || {}) };
                delete updatedRecords[VALENTINE_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updatedRecords });
            }
            // 2. 刪除聊天記錄中的情人節消息
            const msgs = await DB.getMessagesByCharId(cId);
            const valentineIds = msgs
                .filter(m => m.metadata?.valentineEvent)
                .map(m => m.id)
                .filter((id): id is number => id !== undefined);
            if (valentineIds.length > 0) {
                await DB.deleteMessages(valentineIds);
            }
            addToast(`已刪除 ${targetChar?.name || ''} 的情人節記錄`, 'success');
        } catch (e) {
            console.error('Delete valentine record failed:', e);
            addToast('刪除失敗', 'error');
        } finally {
            setDeleteTargetId(null);
        }
    };

    const hydrateSessionFromContent = (content: string) => {
        setFullContent(content);
        const lines = parseValentineDialogue(content);
        if (lines.length === 0) {
            setDialogueLines([{ text: content.replace(/\[.*?\]/g, '').trim(), emotion: 'normal' }]);
        } else {
            setDialogueLines(lines);
        }
        setCurrentLineIndex(0);
        setDisplayedText('');
        setPhase('session');
    };

    const loadExistingValentineRecord = async (cId: string): Promise<boolean> => {
        const targetChar = characters.find(c => c.id === cId);
        const persistentRecord = targetChar?.specialMomentRecords?.[VALENTINE_RECORD_KEY] as SpecialMomentRecord | undefined;

        if (persistentRecord?.content?.trim()) {
            hydrateSessionFromContent(persistentRecord.content);
            return true;
        }

        const msgs = await DB.getMessagesByCharId(cId);
        const lastValentineMsg = [...msgs]
            .reverse()
            .find(m => m.role === 'assistant' && m.type === 'text' && !!m.metadata?.valentineEvent && !!m.content?.trim());

        if (!lastValentineMsg) return false;

        const migratedRecord: SpecialMomentRecord = {
            content: lastValentineMsg.content,
            timestamp: lastValentineMsg.timestamp,
            source: 'migrated'
        };

        updateCharacter(cId, {
            specialMomentRecords: {
                ...(targetChar?.specialMomentRecords || {}),
                [VALENTINE_RECORD_KEY]: migratedRecord,
            }
        });

        hydrateSessionFromContent(lastValentineMsg.content);
        return true;
    };

    // 自動開始（如果已選角色）
    useEffect(() => {
        if (phase === 'loading' && selectedCharId) {
            loadExistingValentineRecord(selectedCharId)
                .then(found => {
                    if (!found) {
                        generateValentineMessage(selectedCharId);
                    }
                })
                .catch(() => {
                    generateValentineMessage(selectedCharId);
                });
        }
    }, [phase, selectedCharId]);

    // 打字機效果
    useEffect(() => {
        const currentLine = dialogueLines[currentLineIndex];
        if (!currentLine) return;

        setCurrentEmotion(currentLine.emotion);
        setIsAnimating(true);
        setDisplayedText('');
        let i = 0;
        const timer = setInterval(() => {
            setDisplayedText(currentLine.text.substring(0, i + 1));
            i++;
            if (i >= currentLine.text.length) {
                clearInterval(timer);
                setIsAnimating(false);
            }
        }, 30);
        return () => clearInterval(timer);
    }, [currentLineIndex, dialogueLines]);

    // 自動滾動
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [displayedText]);

    /** 生成情人節特別消息 */
    const generateValentineMessage = async (cId: string) => {
        const c = characters.find(ch => ch.id === cId);
        if (!c) { setErrorMsg('找不到角色'); setPhase('error'); return; }

        if (!apiConfig.baseUrl || !apiConfig.apiKey) {
            setErrorMsg('API 未配置');
            setPhase('error');
            return;
        }

        setPhase('loading');

        try {
            // 獲取聊天歷史摘要
            const msgs = await loadCharacterContextMessages(c);
            const recentMsgs = msgs.map(m => {
                const content = m.type === 'image' ? '[圖片]' : m.content;
                return `${m.role}: ${content}`;
            }).join('\n');

            await injectMemoryPalace(c, undefined, '情人節 我們在一起的回憶');
            const baseContext = ContextBuilder.buildCoreContext(c, userProfile, true);

            // 根據角色獲取可用表情列表
            const availableEmotions = getAvailableEmotions(c);

            const valentinePrompt = `### 特別場景：情人節特別推送 (Valentine's Day Special)

當前日期: 2026年2月14日 情人節
當前時間: ${virtualTime.day} ${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}

### 背景說明
今天是情人節。系統觸發了一個特別推送功能，你現在有機會對${userProfile.name}說一段特別的話。
這是一個特殊的、溫馨的時刻。

### 你的任務
請用你自己的方式，對${userProfile.name}說一段情人節特別的話。內容應包括：
1. **回顧**：回想你們認識以來的點點滴滴（參考聊天記錄和記憶）
2. **感受**：表達你對這段關係的真實感受
3. **期待**：對未來的期待和心願

### 重要提示
- 你和${userProfile.name}的關係不一定是戀人關係。請根據你們實際的互動歷史和關係來表達。
- 可以是戀人的深情告白，也可以是好朋友的真摯感謝，或者是夥伴之間的溫暖鼓勵。
- 用你的性格和說話方式來表達，保持角色一致性。
- 內容可以稍微長一點，畢竟這是一年一次的特別時刻。
- 要真誠、有溫度。

### 輸出格式（視覺小說腳本模式）
使用情緒標籤 + 對話內容的格式，一行一個節拍：
**僅限使用以下情緒標籤**: ${availableEmotions.join(', ')}
格式示例:
[${availableEmotions.includes('shy') ? 'shy' : availableEmotions[0]}] "情人節快樂..."
[${availableEmotions.includes('happy') ? 'happy' : availableEmotions[0]}] 開心地笑了起來
[${availableEmotions.includes('bliss') ? 'bliss' : availableEmotions.includes('happy') ? 'happy' : availableEmotions[0]}] "能認識你真的太好了。"

禁止使用不在列表中的情緒標籤。台詞用雙引號，動作直接寫。`;

            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: baseContext },
                        { role: 'user', content: `[最近記錄 (Previous Context)]:\n${recentMsgs}\n\n---\n\n${valentinePrompt}` }
                    ],
                    temperature: 0.88
                })
            });

            if (!response.ok) throw new Error(`API 錯誤: ${response.status}`);
            const data = await safeResponseJson(response);
            const content = data.choices?.[0]?.message?.content;
            if (!content) throw new Error('AI 返回為空');

            hydrateSessionFromContent(content);

            // 保存到數據庫（作為 date 來源，可被 chat 和 dateapp 讀到上下文）
            await DB.saveMessage({
                charId: cId,
                role: 'user',
                type: 'text',
                content: '[系統] 情人節特別推送已觸發。',
                metadata: { source: 'date', isOpening: true, valentineEvent: true }
            });
            await DB.saveMessage({
                charId: cId,
                role: 'assistant',
                type: 'text',
                content: content,
                metadata: { source: 'date', valentineEvent: true }
            });
            // 節日推送落進的是通用聊天歷史，也是主動消息 2.0 雲端快照的素材：
            // 落庫點自己負責打髒，別指望下面那次 updateCharacter 順帶帶上。
            markAmsgStateDirty({ char: c, userProfile, groups, realtimeConfig });

            const previousRecords = c.specialMomentRecords || {};
            updateCharacter(cId, {
                specialMomentRecords: {
                    ...previousRecords,
                    [VALENTINE_RECORD_KEY]: {
                        content,
                        timestamp: Date.now(),
                        source: 'generated'
                    }
                }
            });

            // 標記已完成
            try { localStorage.setItem(VALENTINE_COMPLETED_KEY, Date.now().toString()); } catch { /* */ }

        } catch (e: any) {
            console.error('Valentine event error:', e);
            setErrorMsg(e.message || '生成失敗');
            setPhase('error');
        }
    };

    /** 點擊屏幕推進對話 */
    const handleScreenClick = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button, .control-zone')) return;

        if (isAnimating) {
            // 跳過動畫
            const currentLine = dialogueLines[currentLineIndex];
            if (currentLine) {
                setDisplayedText(currentLine.text);
                setIsAnimating(false);
            }
            return;
        }

        // 下一行
        if (currentLineIndex < dialogueLines.length - 1) {
            setCurrentLineIndex(prev => prev + 1);
        }
    };

    /** 重新生成 */
    const handleRegenerate = () => {
        if (!selectedCharId) return;
        setShowRecord(false);
        setDialogueLines([]);
        setCurrentLineIndex(0);
        setDisplayedText('');
        generateValentineMessage(selectedCharId);
    };

    /** 保存立繪配置 */
    const handleSaveSpriteConfig = () => {
        setShowSpriteSettings(false);
        if (selectedCharId) {
            updateCharacter(selectedCharId, {
                spriteConfig: { scale: localSpriteScale, x: localSpriteX, y: localSpriteY }
            });
        }
    };

    /** 導出記錄為長圖 */
    const handleExportImage = async () => {
        if (!recordRef.current || isExporting) return;
        setIsExporting(true);
        try {
            const mod = await import('https://esm.sh/html2canvas@1.4.1');
            const html2canvas = mod.default;
            const canvas = await html2canvas(recordRef.current, {
                backgroundColor: '#faf6f1',
                scale: 2,
                useCORS: true,
                logging: false,
            });
            const fileName = `valentine_${char?.name || 'record'}_2026.png`;

            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob(result => result ? resolve(result) : reject(new Error('長圖生成失敗')), 'image/png');
            });
            const result = await shareOrDownloadBlob({ blob, fileName, shareTitle: '特別時光 - 導出長圖' });
            if (result === 'cancelled') return;
            addToast('導出成功', 'success');
        } catch (e: any) {
            console.error('Export failed:', e);
            addToast('導出失敗，請截圖保存', 'error');
        } finally {
            setIsExporting(false);
        }
    };

    // ----- 角色選擇界面 -----
    if (phase === 'select') {
        return (
            <div className="fixed inset-0 z-[9997] bg-gradient-to-b from-pink-50 via-white to-rose-50 flex flex-col animate-fade-in">
                {/* 頂欄 in-flow 自吃 safe-top（不給外殼整體加 padding，避免漸變背景被擠出上下色塊） */}
                <div className="h-16 flex items-center justify-between px-4 border-b border-pink-100 bg-white/80 backdrop-blur-sm shrink-0"
                    style={{ paddingTop: 'var(--safe-top)', boxSizing: 'content-box' }}>
                    <button onClick={onClose} className="p-2 -ml-2 rounded-full hover:bg-pink-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-bold text-slate-700">特別時光 - 情人節</span>
                    <div className="w-8" />
                </div>

                <div className="flex-1 overflow-y-auto p-6" style={{ paddingBottom: 'calc(1.5rem + var(--safe-bottom))' }}>
                    <div className="text-center mb-6">
                        <div className="text-4xl mb-2">💝</div>
                        <h2 className="text-lg font-bold text-slate-700">選擇你想聽誰說</h2>
                        <p className="text-xs text-slate-400 mt-1">選擇一位角色，聆聽他們的情人節特別心聲</p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        {characters.map(c => {
                            const hasRecord = !!c.specialMomentRecords?.[VALENTINE_RECORD_KEY];
                            return (
                                <button
                                    key={c.id}
                                    onClick={() => { setSelectedCharId(c.id); setPhase('loading'); }}
                                    onTouchStart={() => handleLongPressStart(c.id)}
                                    onTouchEnd={handleLongPressEnd}
                                    onTouchCancel={handleLongPressEnd}
                                    onContextMenu={(e) => { e.preventDefault(); setDeleteTargetId(c.id); }}
                                    className="bg-white rounded-2xl p-4 shadow-sm border border-pink-100 active:scale-95 transition-transform flex flex-col items-center gap-3 hover:shadow-md hover:border-pink-200 relative"
                                >
                                    <TokenImg value={c.avatar} className="w-16 h-16 rounded-full object-cover shadow-sm border-2 border-pink-100" alt={c.name} />
                                    <span className="font-bold text-slate-700 text-sm">{c.name}</span>
                                    {hasRecord && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-pink-400" />}
                                </button>
                            );
                        })}
                    </div>

                    <p className="text-center text-[10px] text-slate-300 mt-4">長按角色可刪除其情人節記錄</p>
                </div>

                {/* 刪除確認彈窗 */}
                {deleteTargetId && (
                    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6 animate-fade-in">
                        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDeleteTargetId(null)} />
                        <div className="relative bg-white rounded-3xl p-6 max-w-xs w-full shadow-2xl">
                            <div className="text-center mb-4">
                                <div className="text-3xl mb-2">🗑️</div>
                                <h3 className="font-bold text-slate-700 text-base">刪除情人節記錄</h3>
                                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                                    將刪除 <span className="font-bold text-slate-600">{characters.find(c => c.id === deleteTargetId)?.name}</span> 的情人節記錄，包括存儲的回憶和對應的聊天消息。此操作不可撤銷。
                                </p>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setDeleteTargetId(null)}
                                    className="flex-1 py-2.5 bg-slate-100 text-slate-500 font-bold rounded-xl active:scale-95 transition-transform text-sm"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={() => handleDeleteRecord(deleteTargetId)}
                                    className="flex-1 py-2.5 bg-red-500 text-white font-bold rounded-xl active:scale-95 transition-transform text-sm"
                                >
                                    確認刪除
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    // ----- 加載界面 -----
    if (phase === 'loading') {
        return (
            <div className="fixed inset-0 z-[9997] bg-black flex flex-col items-center justify-center animate-fade-in">
                <div className="flex flex-col items-center gap-6">
                    <div className="relative">
                        <div className="w-20 h-20 rounded-full border-2 border-pink-500/20 flex items-center justify-center">
                            {char && <TokenImg value={char.avatar} className="w-16 h-16 rounded-full object-cover" alt="" />}
                        </div>
                        <div className="absolute inset-0 w-20 h-20 rounded-full border-2 border-transparent border-t-pink-400 animate-spin" />
                    </div>
                    <div className="text-center">
                        <p className="text-pink-300 text-sm font-light tracking-widest animate-pulse">
                            {char?.name} 正在準備要對你說的話...
                        </p>
                        <p className="text-pink-500/30 text-[10px] mt-2 tracking-wider">VALENTINE'S DAY 2026</p>
                    </div>
                </div>

                {/* 裝飾性浮動心形 */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    {[...Array(6)].map((_, i) => (
                        <div
                            key={i}
                            className="absolute text-pink-500/10 animate-float"
                            style={{
                                left: `${15 + i * 15}%`,
                                top: `${60 + (i % 3) * 10}%`,
                                animationDelay: `${i * 0.5}s`,
                                animationDuration: `${3 + i * 0.5}s`,
                                fontSize: `${16 + i * 4}px`,
                            }}
                        >
                            ♥
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ----- 錯誤界面 -----
    if (phase === 'error') {
        return (
            <div className="fixed inset-0 z-[9997] bg-black flex flex-col items-center justify-center animate-fade-in p-8">
                <div className="text-center max-w-sm">
                    <div className="text-4xl mb-4">😢</div>
                    <h2 className="text-white text-lg font-bold mb-2">暫時無法連接</h2>
                    <p className="text-slate-400 text-sm mb-6">{errorMsg}</p>
                    <div className="flex flex-col gap-3">
                        <button
                            onClick={handleRegenerate}
                            className="w-full py-3 bg-pink-500 text-white font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            重試
                        </button>
                        <button
                            onClick={() => { setPhase('select'); setErrorMsg(''); }}
                            className="w-full py-3 bg-slate-800 text-slate-300 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            重新選擇角色
                        </button>
                        <button
                            onClick={onClose}
                            className="w-full py-2 text-slate-500 text-sm active:scale-95 transition-transform"
                        >
                            返回
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ----- 正片：情人節特別對話界面 -----
    const currentLine = dialogueLines[currentLineIndex];
    const spriteInfo = getSpriteForEmotion(currentEmotion, char);
    const isLastLine = currentLineIndex >= dialogueLines.length - 1;
    const isFinished = isLastLine && !isAnimating;

    return (
        <div
            className="fixed inset-0 z-[9997] bg-black overflow-hidden select-none"
            onClick={handleScreenClick}
        >
            {/* 背景 */}
            <div className="absolute inset-0 bg-gradient-to-b from-[#1a0a1e] via-[#0d0a1a] to-[#0a0510] opacity-90" />

            {/* 裝飾性粒子 */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {[...Array(12)].map((_, i) => (
                    <div
                        key={i}
                        className="absolute rounded-full animate-float"
                        style={{
                            left: `${Math.random() * 100}%`,
                            top: `${Math.random() * 100}%`,
                            width: `${2 + Math.random() * 4}px`,
                            height: `${2 + Math.random() * 4}px`,
                            background: `rgba(${200 + Math.random() * 55}, ${100 + Math.random() * 80}, ${150 + Math.random() * 105}, ${0.15 + Math.random() * 0.2})`,
                            animationDelay: `${Math.random() * 5}s`,
                            animationDuration: `${4 + Math.random() * 4}s`,
                        }}
                    />
                ))}
            </div>

            {/* 頂部標題 */}
            <div className="absolute top-0 left-0 right-0 pt-14 text-center z-20">
                <div className="text-[10px] font-mono text-pink-400/40 tracking-[0.3em] uppercase mb-1 pointer-events-none">Valentine's Day Special</div>
                <h2 className="text-2xl font-light text-white/80 tracking-[0.2em] pointer-events-none">{char?.name}</h2>
                {/* 返回按鈕 */}
                <button
                    onClick={(e) => { e.stopPropagation(); onClose(); }}
                    className="absolute top-14 left-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md border border-white/20 active:scale-90 transition-transform control-zone"
                    title="返回"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-white/70">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                    </svg>
                </button>
                {/* 立繪調整按鈕 */}
                <button
                    onClick={(e) => { e.stopPropagation(); setShowSpriteSettings(s => !s); }}
                    className="absolute top-14 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md border border-white/20 active:scale-90 transition-transform control-zone"
                    title="調整立繪"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-white/70">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </button>
            </div>

            {/* 立繪調整面板 */}
            {showSpriteSettings && (
                <div className="absolute top-28 right-4 z-50 control-zone animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    <div className="bg-black/70 backdrop-blur-xl rounded-2xl border border-white/15 p-4 w-56 shadow-2xl">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[11px] font-bold text-white/80 tracking-wide">立繪調整</span>
                            <button onClick={(e) => { e.stopPropagation(); handleSaveSpriteConfig(); }} className="text-[10px] text-pink-400 font-bold">完成</button>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">大小</span>
                                    <span className="text-[10px] text-white/50 font-mono">{localSpriteScale.toFixed(1)}x</span>
                                </div>
                                <input type="range" min="0.3" max="3" step="0.1" value={localSpriteScale} onChange={(e) => setLocalSpriteScale(parseFloat(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">水平位置</span>
                                    <span className="text-[10px] text-white/50 font-mono">{localSpriteX}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={localSpriteX} onChange={(e) => setLocalSpriteX(parseInt(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-400" />
                            </div>
                            <div>
                                <div className="flex justify-between mb-1">
                                    <span className="text-[10px] text-white/50">垂直位置</span>
                                    <span className="text-[10px] text-white/50 font-mono">{localSpriteY}%</span>
                                </div>
                                <input type="range" min="-50" max="50" step="1" value={localSpriteY} onChange={(e) => setLocalSpriteY(parseInt(e.target.value))} className="w-full h-1 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-pink-400" />
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); setLocalSpriteScale(1); setLocalSpriteX(0); setLocalSpriteY(0); }} className="w-full text-[10px] text-white/40 hover:text-white/60 py-1.5 transition-colors">
                                重置默認
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 立繪區域 - 高度填滿設備，等比縮放，多餘寬度裁掉 */}
            <div className="absolute inset-0 overflow-hidden flex items-end justify-center z-10 pointer-events-none">
                {spriteInfo.type === 'image' ? (
                    <TokenImg
                        value={spriteInfo.value}
                        className="h-full w-auto max-w-none drop-shadow-[0_10px_30px_rgba(236,72,153,0.3)] transition-all duration-500"
                        style={{
                            transform: `scale(${localSpriteScale}) translate(${localSpriteX}%, ${localSpriteY}%)`,
                            objectFit: 'cover',
                        }}
                        alt=""
                    />
                ) : (
                    <div
                        className="text-[120px] drop-shadow-2xl transition-all duration-500 animate-pulse"
                        style={{ transform: `scale(${localSpriteScale}) translate(${localSpriteX}%, ${localSpriteY}%)` }}
                    >
                        {spriteInfo.value}
                    </div>
                )}
            </div>

            {/* 對話框 */}
            <div className="absolute inset-x-0 bottom-8 z-30 flex justify-center pointer-events-none">
                <div className="w-[90%] max-w-lg pointer-events-auto">
                    {/* 主對話框 */}
                    <div className="bg-black/60 backdrop-blur-xl rounded-2xl border border-pink-500/20 p-6 min-h-[140px] shadow-[0_0_40px_rgba(236,72,153,0.1)] relative">
                        {/* 角色名標籤 */}
                        <div className="absolute -top-3 left-6">
                            <div className="bg-gradient-to-r from-pink-500 to-rose-400 text-white px-4 py-1 rounded-sm text-xs font-bold tracking-widest uppercase shadow-lg transform -skew-x-12">
                                {char?.name}
                            </div>
                        </div>

                        {/* 對話文字 */}
                        <p className="text-white/90 text-[16px] leading-relaxed font-light tracking-wide drop-shadow-md mt-2 min-h-[60px]">
                            {displayedText}
                            {isAnimating && <span className="inline-block w-2 h-4 bg-pink-400/70 ml-1 animate-pulse align-middle" />}
                        </p>

                        {/* 繼續提示 / 進度 */}
                        {!isAnimating && !isLastLine && (
                            <div className="absolute bottom-3 right-4 animate-bounce opacity-70">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 text-pink-300">
                                    <path fillRule="evenodd" d="M12.53 16.28a.75.75 0 0 1-1.06 0l-7.5-7.5a.75.75 0 0 1 1.06-1.06L12 14.69l6.97-6.97a.75.75 0 1 1 1.06 1.06l-7.5 7.5Z" clipRule="evenodd" />
                                </svg>
                            </div>
                        )}

                        {/* 進度條 */}
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-b-2xl overflow-hidden">
                            <div
                                className="h-full bg-gradient-to-r from-pink-500 to-rose-400 transition-all duration-500"
                                style={{ width: `${((currentLineIndex + 1) / dialogueLines.length) * 100}%` }}
                            />
                        </div>
                    </div>

                    {/* 結束後的操作按鈕 */}
                    {isFinished && (
                        <div className="mt-4 flex gap-3 animate-fade-in control-zone">
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowRecord(true); }}
                                className="flex-1 py-3 bg-white/10 backdrop-blur-md text-white/80 font-bold rounded-2xl border border-white/10 active:scale-95 transition-transform text-sm flex items-center justify-center gap-1.5"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>
                                查看記錄
                            </button>
                            <button
                                onClick={(e) => { e.stopPropagation(); onClose(); }}
                                className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-pink-500/20 active:scale-95 transition-transform text-sm"
                            >
                                謝謝你
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* 書信風格記錄查看 */}
            {showRecord && (
                <div className="absolute inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    {/* 頂部工具欄 */}
                    <div className="shrink-0 flex items-center justify-between px-4 pt-12 pb-3">
                        <button onClick={() => setShowRecord(false)} className="p-2 rounded-full bg-white/10 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-white/80"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                        </button>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleRegenerate}
                                className="px-3 py-1.5 rounded-full bg-white/10 text-white/60 text-[11px] font-bold active:scale-95 transition-transform"
                            >
                                重新生成
                            </button>
                            <button
                                onClick={handleExportImage}
                                disabled={isExporting}
                                className="px-3 py-1.5 rounded-full bg-pink-500/80 text-white text-[11px] font-bold active:scale-95 transition-transform flex items-center gap-1 disabled:opacity-50"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                                {isExporting ? '導出中...' : '導出長圖'}
                            </button>
                        </div>
                    </div>

                    {/* 書信內容 - 可滾動 */}
                    <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-8">
                        <div ref={recordRef} className="max-w-md mx-auto rounded-xl overflow-hidden shadow-2xl">
                            {/* 信紙 */}
                            <div className="px-8 py-10 relative" style={{ backgroundColor: '#faf6f1' }}>
                                {/* 裝飾性邊框線 */}
                                <div className="absolute top-4 left-4 right-4 bottom-4 border border-rose-200/30 rounded-lg pointer-events-none" />
                                {/* 四角裝飾 */}
                                <div className="absolute top-5 left-5 w-3 h-3 border-t border-l border-rose-300/40 rounded-tl-sm" />
                                <div className="absolute top-5 right-5 w-3 h-3 border-t border-r border-rose-300/40 rounded-tr-sm" />
                                <div className="absolute bottom-5 left-5 w-3 h-3 border-b border-l border-rose-300/40 rounded-bl-sm" />
                                <div className="absolute bottom-5 right-5 w-3 h-3 border-b border-r border-rose-300/40 rounded-br-sm" />

                                {/* 信頭 */}
                                <div className="text-center mb-8 relative">
                                    <div className="text-3xl mb-3 opacity-80">&#x1F48C;</div>
                                    <h2 className="text-lg font-bold tracking-widest" style={{ color: '#8b5e6b', fontFamily: 'Georgia, serif' }}>Valentine's Day</h2>
                                    <p className="text-[11px] mt-1 tracking-[0.4em]" style={{ color: '#c4879a' }}>2026.2.14</p>
                                    <div className="flex justify-center gap-6 mt-4 text-[11px]" style={{ color: '#b8899a' }}>
                                        <span>To: <span className="font-medium" style={{ color: '#8b5e6b' }}>{userProfile.name}</span></span>
                                        <span>From: <span className="font-medium" style={{ color: '#8b5e6b' }}>{char?.name}</span></span>
                                    </div>
                                    <div className="w-20 h-px mx-auto mt-5" style={{ backgroundColor: '#d4a0b0', opacity: 0.4 }} />
                                </div>

                                {/* 信件正文 */}
                                <div className="space-y-3 mb-8 px-2">
                                    {dialogueLines.map((line, i) => {
                                        const text = line.text;
                                        const isQuoted = text.startsWith('"') || text.startsWith('\u201c') || text.startsWith('\u300c');
                                        return (
                                            <p key={i} className={isQuoted
                                                ? "text-[15px] leading-[2] tracking-wide"
                                                : "text-[13px] italic leading-[1.9] tracking-wide pl-3 border-l-2"
                                            } style={isQuoted
                                                ? { color: '#5c3a42' }
                                                : { color: '#b8899a', borderColor: 'rgba(200,150,170,0.3)' }
                                            }>
                                                {text}
                                            </p>
                                        );
                                    })}
                                </div>

                                {/* 信尾 */}
                                <div className="text-center mt-10">
                                    <div className="w-20 h-px mx-auto mb-5" style={{ backgroundColor: '#d4a0b0', opacity: 0.4 }} />
                                    <p className="italic text-[11px] tracking-wider" style={{ color: '#c4879a', fontFamily: 'Georgia, serif' }}>with love</p>
                                    <p className="font-medium text-sm mt-2 tracking-widest" style={{ color: '#8b5e6b' }}>{char?.name}</p>
                                    <p className="text-[10px] mt-3 tracking-[0.3em]" style={{ color: '#d4b0be' }}>VALENTINE'S DAY 2026</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// ============================================================
// 情人節主控制器 - 管理彈窗 → API設置 → 會話 的流轉
// ============================================================
interface ValentineControllerProps {
    onClose: () => void;
}

export const ValentineController: React.FC<ValentineControllerProps> = ({ onClose }) => {
    const { characters } = useOS();
    const [stage, setStage] = useState<'popup' | 'api' | 'session'>('popup');

    // 找到 Sully 角色ID（彈窗直接進Sully）
    const sullyChar = characters.find(c => isSullyChar(c));
    const sullyId = sullyChar?.id || characters[0]?.id || '';

    const handleDismiss = () => {
        try { localStorage.setItem(VALENTINE_DISMISSED_KEY, Date.now().toString()); } catch { /* */ }
        onClose();
    };

    if (stage === 'popup') {
        return (
            <ValentinePopup
                onView={() => setStage('session')}
                onDismiss={handleDismiss}
                onCheckApi={() => setStage('api')}
            />
        );
    }

    if (stage === 'api') {
        return (
            <InlineApiSetup
                onDone={() => setStage('session')}
                onBack={() => setStage('popup')}
            />
        );
    }

    // 從彈窗進入時，直接給 Sully 的 charId，跳過角色選擇
    return <ValentineSession charId={sullyId} onClose={onClose} />;
};

// ============================================================
// 共享：單個特別活動卡片（統一佈局 + 性能優化）
// ============================================================

interface EventCardTheme {
    /** 當期漸變（active）—— 不帶透明度 */
    activeGradient: string;
    /** 往期漸變（past）—— 通常加 /70 透明度 */
    pastGradient: string;
    /** 當期陰影顏色 className（如 shadow-pink-200） */
    activeShadow: string;
    /** 文案副色調（如 text-pink-100） */
    subColor: string;
    /** hint 顏色（如 text-pink-200/60） */
    hintColor: string;
    /** 長按提示顏色 */
    helpColor: string;
    /** 頭像邊框 */
    avatarRing: string;
    /** 當期 hasRecord 小圓點 */
    dotColor: string;
}

interface EventCardProps {
    theme: EventCardTheme;
    icon: string;
    eyebrow?: string;
    title: string;
    subtitleActive: string;
    subtitlePast: string;
    hintActive: string;
    hintPast: string;
    isPast: boolean;
    characters: CharacterProfile[];
    recordKey: string;
    onPick: (charId: string) => void;
    onLongPressDelete: (charId: string) => void;
    /** 選中要刪的角色 id（用於顯示 ring） */
    pendingDeleteId?: string | null;
    /** 不使用長按刪除的活動可提供自己的頁腳說明 */
    footerNote?: string;
}

const SpecialEventCardImpl: React.FC<EventCardProps> = ({
    theme, icon, eyebrow, title, subtitleActive, subtitlePast,
    hintActive, hintPast, isPast, characters, recordKey,
    onPick, onLongPressDelete, pendingDeleteId, footerNote,
}) => {
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startLP = useCallback((id: string) => {
        longPressTimer.current = setTimeout(() => onLongPressDelete(id), 600);
    }, [onLongPressDelete]);
    const endLP = useCallback(() => {
        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    }, []);

    return (
        <div className="mb-6" style={{ contain: 'layout paint' }}>
            <div
                className={`rounded-3xl p-6 text-white relative overflow-hidden ${isPast ? `${theme.pastGradient} shadow-lg` : `${theme.activeGradient} shadow-xl ${theme.activeShadow}`}`}
            >
                {/* 裝飾圓 —— 用 pointer-events-none 避免攔截 */}
                <div className="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-bl-full pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-20 h-20 bg-white/5 rounded-tr-full pointer-events-none" />

                {isPast && (
                    <div className="absolute top-4 right-4 bg-white/20 text-white/85 text-[10px] font-bold px-2 py-0.5 rounded-full border border-white/20">
                        往期活動
                    </div>
                )}

                <div className="relative">
                    <div className="text-3xl mb-2">{icon}</div>
                    {eyebrow && <div className="text-[10px] tracking-[6px] mb-1 opacity-80">{eyebrow}</div>}
                    <h2 className="text-xl font-bold mb-1">{title}</h2>
                    <p className={`${theme.subColor} text-xs mb-4`}>
                        {isPast ? subtitlePast : subtitleActive}
                    </p>
                    <div className={`text-[10px] ${theme.hintColor} mb-4`}>
                        {isPast ? hintPast : hintActive}
                    </div>

                    {characters.length === 0 ? (
                        <div className="text-center text-xs text-white/70 py-3">還沒有角色</div>
                    ) : (
                        <div className="max-h-64 overflow-y-auto -mx-1 px-1">
                            <div className="grid grid-cols-3 gap-3">
                                {characters.map(c => {
                                    const hasRecord = !!c.specialMomentRecords?.[recordKey];
                                    const isPending = pendingDeleteId === c.id;
                                    return (
                                        <button
                                            key={c.id}
                                            onClick={() => { if (isPending) { return; } onPick(c.id); }}
                                            onTouchStart={() => hasRecord && startLP(c.id)}
                                            onTouchEnd={endLP}
                                            onTouchCancel={endLP}
                                            onMouseDown={() => hasRecord && startLP(c.id)}
                                            onMouseUp={endLP}
                                            onMouseLeave={endLP}
                                            onContextMenu={(e) => { e.preventDefault(); if (hasRecord) onLongPressDelete(c.id); }}
                                            className={`flex flex-col items-center gap-2 p-3 bg-white/15 rounded-2xl border ${isPending ? 'border-white/80 ring-2 ring-white/60' : 'border-white/20'} active:scale-95 transition-transform relative`}
                                        >
                                            {isImageValue(c.avatar) ? (
                                                <TokenImg value={c.avatar} loading="lazy" decoding="async" alt="" className={`w-12 h-12 rounded-full object-cover border-2 ${theme.avatarRing}`} />
                                            ) : (
                                                <span className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl bg-white/10 border-2 ${theme.avatarRing}`}>{c.avatar || '🌸'}</span>
                                            )}
                                            <span className="text-[11px] font-bold truncate w-full text-center">{c.name}</span>
                                            {hasRecord && <span className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full ${theme.dotColor}`} />}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                    {characters.length > 0 && (
                        <p className={`text-[10px] ${theme.helpColor} mt-3 text-center`}>{footerNote || '長按角色可刪除記錄'}</p>
                    )}
                </div>
            </div>
        </div>
    );
};

const SpecialEventCard = React.memo(SpecialEventCardImpl);

// 活動主題
const THEME_QIXI: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-indigo-950 via-blue-900 to-indigo-600',
    pastGradient: 'bg-gradient-to-br from-indigo-900/80 via-blue-800/75 to-violet-600/70',
    activeShadow: 'shadow-indigo-300',
    subColor: 'text-indigo-100/90',
    hintColor: 'text-blue-100/65',
    helpColor: 'text-indigo-100/45',
    avatarRing: 'border-indigo-100/40',
    dotColor: 'bg-amber-100/80',
};

const THEME_LIKE520: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-pink-400 via-rose-400 to-amber-300',
    pastGradient: 'bg-gradient-to-br from-pink-300/70 via-rose-300/70 to-amber-200/70',
    activeShadow: 'shadow-rose-200',
    subColor: 'text-rose-50/90',
    hintColor: 'text-rose-100/60',
    helpColor: 'text-rose-100/40',
    avatarRing: 'border-white/30',
    dotColor: 'bg-white/70',
};

const THEME_WHITEDAY: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-amber-500 via-orange-400 to-yellow-400',
    pastGradient: 'bg-gradient-to-br from-amber-400/70 via-orange-300/70 to-yellow-300/70',
    activeShadow: 'shadow-amber-200',
    subColor: 'text-amber-100',
    hintColor: 'text-amber-200/60',
    helpColor: 'text-amber-200/40',
    avatarRing: 'border-white/30',
    dotColor: 'bg-white/70',
};

const THEME_VALENTINE: EventCardTheme = {
    activeGradient: 'bg-gradient-to-br from-pink-500 via-rose-500 to-red-400',
    pastGradient: 'bg-gradient-to-br from-pink-400/70 via-rose-400/70 to-red-300/70',
    activeShadow: 'shadow-pink-200',
    subColor: 'text-pink-100',
    hintColor: 'text-pink-200/60',
    helpColor: 'text-pink-200/40',
    avatarRing: 'border-white/30',
    dotColor: 'bg-white/60',
};

// ============================================================
// 特別時光 App（桌面第三頁降級入口）
// ============================================================
export const SpecialMomentsApp: React.FC = () => {
    const { closeApp, openApp, characters, setActiveCharacterId, addToast, updateCharacter, apiConfig, userProfile } = useOS();
    const [showSession, setShowSession] = useState(false);
    const [selectedCharId, setSelectedCharId] = useState<string>('');
    const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

    // White Day
    const [showWhiteDaySession, setShowWhiteDaySession] = useState(false);
    const [whiteDayCharId, setWhiteDayCharId] = useState<string>('');
    const [wdDeleteTargetId, setWdDeleteTargetId] = useState<string | null>(null);

    // 520
    const [show520Session, setShow520Session] = useState(false);
    const [like520CharId, setLike520CharId] = useState<string>('');
    const [l520DeleteTargetId, setL520DeleteTargetId] = useState<string | null>(null);

    // Qixi
    const [showQixiSession, setShowQixiSession] = useState(false);
    const [qixiCharId, setQixiCharId] = useState<string>('');
    const [qixiChoiceCharId, setQixiChoiceCharId] = useState<string>('');
    const [qixiSessionMode, setQixiSessionMode] = useState<QixiSessionMode>('fresh');
    const [qixiReplaySnapshot, setQixiReplaySnapshot] = useState<QixiReplaySnapshot | null>(null);

    // 一次性算好可見性 / 往期態（避免每幀調日期函數）
    const visibility = useMemo(() => {
        const n = new Date();
        const wdPast = n.getFullYear() > 2026 || (n.getFullYear() === 2026 && n.getMonth() > 2);
        return {
            like520: { show: isLike520EventAvailable() || isLike520Past(), past: isLike520Past() },
            whiteday: { show: isWhiteDayEventAvailable() || wdPast, past: wdPast },
            valentine: { show: isValentineEventAvailable() || isValentinePast(), past: isValentinePast() },
        };
    }, []);

    const handleL520DeleteRecord = async (cId: string) => {
        try {
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updated = { ...(targetChar.specialMomentRecords || {}) };
                delete updated[LIKE520_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updated });
            }
            const msgs = await DB.getMessagesByCharId(cId);
            const l520Ids = msgs
                .filter(m => m.metadata?.like520Event)
                .map(m => m.id)
                .filter((id): id is number => id !== undefined);
            if (l520Ids.length > 0) await DB.deleteMessages(l520Ids);
            addToast(`已刪除 ${targetChar?.name || ''} 的 520 記錄`, 'success');
        } catch {
            addToast('刪除失敗', 'error');
        } finally {
            setL520DeleteTargetId(null);
        }
    };

    const handleWdDeleteRecord = async (cId: string) => {
        try {
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updated = { ...(targetChar.specialMomentRecords || {}) };
                delete updated[WHITEDAY_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updated });
            }
            addToast(`已刪除 ${targetChar?.name || ''} 的白色情人節記錄`, 'success');
        } catch {
            addToast('刪除失敗', 'error');
        } finally {
            setWdDeleteTargetId(null);
        }
    };

    const handleDeleteRecord = async (cId: string) => {
        try {
            const targetChar = characters.find(c => c.id === cId);
            if (targetChar) {
                const updatedRecords = { ...(targetChar.specialMomentRecords || {}) };
                delete updatedRecords[VALENTINE_RECORD_KEY];
                updateCharacter(cId, { specialMomentRecords: updatedRecords });
            }
            const msgs = await DB.getMessagesByCharId(cId);
            const valentineIds = msgs
                .filter(m => m.metadata?.valentineEvent)
                .map(m => m.id)
                .filter((id): id is number => id !== undefined);
            if (valentineIds.length > 0) {
                await DB.deleteMessages(valentineIds);
            }
            addToast(`已刪除 ${targetChar?.name || ''} 的情人節記錄`, 'success');
        } catch (e) {
            console.error('Delete valentine record failed:', e);
            addToast('刪除失敗', 'error');
        } finally {
            setDeleteTargetId(null);
        }
    };

    const handleQixiReturnToChat = async ({ message, card, replaySnapshot }: QixiReturnPayload) => {
        if (!qixiCharId) return;
        const targetChar = characters.find(c => c.id === qixiCharId);
        try {
            const existing = await DB.getMessagesByCharId(qixiCharId);
            const recent = existing.slice(-30);
            const cardAlreadySaved = recent.some(item => item.metadata?.qixiRunId === card.runId && item.metadata?.qixiEventCard === true);
            const messageAlreadySaved = recent.some(item => item.metadata?.qixiRunId === card.runId && item.metadata?.isReturnMessage === true);
            const timestamp = Date.now();
            const [cardMessage, privateMessage] = createQixiChatMessagePair(qixiCharId, card, message, timestamp);
            if (!cardAlreadySaved) {
                await DB.saveMessage(cardMessage);
            }
            if (!messageAlreadySaved) {
                await DB.saveMessage(privateMessage);
            }
            if (targetChar) {
                updateCharacter(qixiCharId, {
                    specialMomentRecords: {
                        ...(targetChar.specialMomentRecords || {}),
                        [QIXI_DEMO_RECORD_KEY]: {
                            content: message,
                            timestamp: Date.now(),
                            source: 'generated',
                            customData: { version: 8, completed: true, replaySnapshot, chatCard: card },
                        },
                    },
                });
            }
            setActiveCharacterId(qixiCharId);
            setShowQixiSession(false);
            setQixiCharId('');
            setQixiReplaySnapshot(null);
            openApp(AppID.Chat);
        } catch (error) {
            console.error('[Qixi] return to chat failed:', error);
            addToast('七夕消息保存失敗，請再試一次', 'error');
            throw error;
        }
    };

    const openQixiSession = (charId: string, mode: QixiSessionMode) => {
        const target = characters.find(c => c.id === charId);
        const snapshot = target?.specialMomentRecords?.[QIXI_DEMO_RECORD_KEY]?.customData?.replaySnapshot as QixiReplaySnapshot | undefined;
        setQixiSessionMode(mode);
        setQixiReplaySnapshot(mode === 'replay' && snapshot?.version === 8 ? snapshot : null);
        setQixiChoiceCharId('');
        setQixiCharId(charId);
        setShowQixiSession(true);
    };

    const pickQixiCharacter = (charId: string) => {
        const target = characters.find(c => c.id === charId);
        if (target?.specialMomentRecords?.[QIXI_DEMO_RECORD_KEY]) {
            setQixiChoiceCharId(charId);
            return;
        }
        openQixiSession(charId, 'fresh');
    };

    const qixiChar = characters.find(c => c.id === qixiCharId);
    if (showQixiSession && qixiChar) {
        return (
            <QixiDemoSession
                char={qixiChar}
                user={userProfile}
                apiConfig={apiConfig}
                sessionMode={qixiSessionMode}
                replaySnapshot={qixiReplaySnapshot}
                onPortraitConfigSave={(spriteConfig) => {
                    updateCharacter(qixiChar.id, { spriteConfig });
                    addToast('七夕立繪位置已保存，並同步到見面模式', 'success');
                }}
                onClose={() => { setShowQixiSession(false); setQixiCharId(''); setQixiReplaySnapshot(null); }}
                onReturnToChat={handleQixiReturnToChat}
            />
        );
    }

    if (showSession && selectedCharId) {
        return (
            <ValentineSession
                charId={selectedCharId}
                onClose={() => { setShowSession(false); setSelectedCharId(''); }}
            />
        );
    }

    if (showWhiteDaySession && whiteDayCharId) {
        return (
            <WhiteDaySession
                charId={whiteDayCharId}
                onClose={() => { setShowWhiteDaySession(false); setWhiteDayCharId(''); }}
            />
        );
    }

    if (show520Session && like520CharId) {
        return (
            <Like520Session
                charId={like520CharId}
                onClose={() => { setShow520Session(false); setLike520CharId(''); }}
            />
        );
    }

    return (
        <div className="h-full w-full bg-gradient-to-b from-pink-50 via-white to-rose-50 flex flex-col font-light">
            {/* Header */}
            <div className="border-b border-pink-100 bg-white/80 backdrop-blur-sm shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="h-16 flex items-center justify-between px-4">
                    <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-pink-50">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-bold text-slate-700">特別時光</span>
                    <div className="w-8" />
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
                {/* 七夕 */}
                <SpecialEventCard
                    theme={THEME_QIXI}
                    icon="✦"
                    eyebrow="七 月 初 七 · DEMO"
                    title="星月夢境童話"
                    subtitleActive="2026 七夕 — 掉進上下文夾層，尋找也正在尋找你的 ta"
                    subtitlePast="2026 七夕 — 重溫那場星月夢境"
                    hintActive="選擇一位角色，從星月首頁直接進入故事"
                    hintPast="點擊角色重溫記錄"
                    isPast={false}
                    characters={characters}
                    recordKey={QIXI_DEMO_RECORD_KEY}
                    onPick={pickQixiCharacter}
                    onLongPressDelete={() => undefined}
                    footerNote="UI / CSS / 手寫 SVG · 固定座標星圖 · 首次 1 次 LLM 生成記憶星線"
                />

                {/* 520 */}
                {visibility.like520.show && (
                    <SpecialEventCard
                        theme={THEME_LIKE520}
                        icon="🌸"
                        eyebrow="5 · 2 · 0"
                        title="如果 ta 變得小小的"
                        subtitleActive="2026.5.20 — 和 ta 一起度過一個小小的下午"
                        subtitlePast="2026.5.20 — 重溫那個小小的下午"
                        hintActive="選擇一位角色開始"
                        hintPast="點擊角色重溫記錄"
                        isPast={visibility.like520.past}
                        characters={characters}
                        recordKey={LIKE520_RECORD_KEY}
                        onPick={(id) => { setLike520CharId(id); setShow520Session(true); }}
                        onLongPressDelete={(id) => setL520DeleteTargetId(id)}
                        pendingDeleteId={l520DeleteTargetId}
                    />
                )}

                {/* 白色情人節 */}
                {visibility.whiteday.show && (
                    <SpecialEventCard
                        theme={THEME_WHITEDAY}
                        icon="🍫"
                        title="白色情人節特別活動"
                        subtitleActive="2026 White Day — 和 ta 一起 DIY 一塊專屬巧克力"
                        subtitlePast="2026.3.14 — 重溫你們的專屬巧克力"
                        hintActive="選擇一位角色開始"
                        hintPast="點擊角色查看記錄或重新制作"
                        isPast={visibility.whiteday.past}
                        characters={characters}
                        recordKey={WHITEDAY_RECORD_KEY}
                        onPick={(id) => { setWhiteDayCharId(id); setShowWhiteDaySession(true); }}
                        onLongPressDelete={(id) => setWdDeleteTargetId(id)}
                        pendingDeleteId={wdDeleteTargetId}
                    />
                )}

                {/* 情人節 */}
                {visibility.valentine.show && (
                    <SpecialEventCard
                        theme={THEME_VALENTINE}
                        icon="💝"
                        title="情人節特別推送"
                        subtitleActive="2026 Valentine's Day — 聽聽 ta 想對你說什麼"
                        subtitlePast="2026.2.14 — 重溫那天 ta 說的話"
                        hintActive="選擇一位角色開始"
                        hintPast="點擊角色重播或重新生成"
                        isPast={visibility.valentine.past}
                        characters={characters}
                        recordKey={VALENTINE_RECORD_KEY}
                        onPick={(id) => { setSelectedCharId(id); setShowSession(true); }}
                        onLongPressDelete={(id) => setDeleteTargetId(id)}
                        pendingDeleteId={deleteTargetId}
                    />
                )}
            </div>

            {qixiChoiceCharId && (
                <QixiReplayChoiceModal
                    charName={characters.find(c => c.id === qixiChoiceCharId)?.name || ''}
                    onReplay={() => openQixiSession(qixiChoiceCharId, 'replay')}
                    onFresh={() => openQixiSession(qixiChoiceCharId, 'fresh')}
                    onCancel={() => setQixiChoiceCharId('')}
                />
            )}

            {/* 520 刪除確認彈窗 */}
            {l520DeleteTargetId && (
                <ConfirmDeleteModal
                    title="刪除 520 記錄"
                    charName={characters.find(c => c.id === l520DeleteTargetId)?.name || ''}
                    note="將刪除該角色的 520 記錄，包括所有相關的聊天消息。此操作不可撤銷。"
                    onCancel={() => setL520DeleteTargetId(null)}
                    onConfirm={() => handleL520DeleteRecord(l520DeleteTargetId)}
                />
            )}

            {/* 白色情人節刪除確認彈窗 */}
            {wdDeleteTargetId && (
                <ConfirmDeleteModal
                    title="刪除白色情人節記錄"
                    charName={characters.find(c => c.id === wdDeleteTargetId)?.name || ''}
                    note="將刪除該角色的白色情人節記錄。此操作不可撤銷。"
                    onCancel={() => setWdDeleteTargetId(null)}
                    onConfirm={() => handleWdDeleteRecord(wdDeleteTargetId)}
                />
            )}

            {/* 情人節刪除確認彈窗 */}
            {deleteTargetId && (
                <ConfirmDeleteModal
                    title="刪除情人節記錄"
                    charName={characters.find(c => c.id === deleteTargetId)?.name || ''}
                    note="將刪除該角色的情人節記錄，包括存儲的回憶和對應的聊天消息。此操作不可撤銷。"
                    onCancel={() => setDeleteTargetId(null)}
                    onConfirm={() => handleDeleteRecord(deleteTargetId)}
                />
            )}
        </div>
    );
};

export const QixiReplayChoiceModal: React.FC<{
    charName: string;
    onReplay: () => void;
    onFresh: () => void;
    onCancel: () => void;
}> = ({ charName, onReplay, onFresh, onCancel }) => (
    <div className="qixi-replay-modal">
        <button type="button" aria-label="關閉" className="qixi-replay-modal__scrim" onClick={onCancel} />
        <div className="qixi-replay-modal__panel">
            <div className="qixi-replay-modal__orbit" /><div className="qixi-replay-modal__glow" />
            <div className="qixi-replay-modal__content">
                <div className="qixi-replay-modal__eyebrow">QIXI · MEMORY FOUND</div>
                <h3>這場夢已經<br />留下過一次記錄。</h3>
                <p>{charName} 的上一次星線還在。你想沿原來的內容重看，還是重新召回記憶生成新的一次？</p>
                <div className="qixi-replay-modal__choices">
                    <button type="button" data-qixi-entry-choice="replay" onClick={onReplay}>
                        <span><b>重看上一次</b><small>不調用模型，不重複寫入私聊</small></span><i>→</i>
                    </button>
                    <button type="button" data-qixi-entry-choice="fresh" onClick={onFresh}>
                        <span><b>開始新的一次</b><small>重新召回並生成；舊記錄會保留到新一次完成</small></span><i>↗</i>
                    </button>
                </div>
                <button type="button" onClick={onCancel} className="qixi-replay-modal__cancel">暫時不進入</button>
            </div>
        </div>
    </div>
);

// ============================================================
// 共享：刪除確認彈窗
// ============================================================
const ConfirmDeleteModal: React.FC<{
    title: string;
    charName: string;
    note: string;
    onCancel: () => void;
    onConfirm: () => void;
}> = ({ title, charName, note, onCancel, onConfirm }) => (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6 animate-fade-in">
        <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
        <div className="relative bg-white rounded-3xl p-6 max-w-xs w-full shadow-2xl">
            <div className="text-center mb-4">
                <div className="text-3xl mb-2">🗑️</div>
                <h3 className="font-bold text-slate-700 text-base">{title}</h3>
                <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                    將刪除 <span className="font-bold text-slate-600">{charName}</span> 的記錄。{note}
                </p>
            </div>
            <div className="flex gap-3">
                <button onClick={onCancel} className="flex-1 py-2.5 bg-slate-100 text-slate-500 font-bold rounded-xl active:scale-95 transition-transform text-sm">取消</button>
                <button onClick={onConfirm} className="flex-1 py-2.5 bg-red-500 text-white font-bold rounded-xl active:scale-95 transition-transform text-sm">確認刪除</button>
            </div>
        </div>
    </div>
);
