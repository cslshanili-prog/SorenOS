import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useEffect, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { GameSession, GameTheme, CharacterProfile, GameLog, GameActionOption, GameSummary } from '../types';
import { ContextBuilder } from '../utils/context';
import { extractContent, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { trackEvent } from '../utils/analytics';
import Modal from '../components/os/Modal';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { Planet, RocketLaunch, Lightning, LockSimple, DiceFive, Toolbox, FloppyDisk, ArrowsClockwise, DoorOpen } from '@phosphor-icons/react';
import TokenImg from '../components/os/TokenImg';

// --- Themes Configuration (Enhanced) ---
const GAME_THEMES: Record<GameTheme, { bg: string, text: string, accent: string, font: string, border: string, cardBg: string, gradient: string, optionNormal: string, optionChaotic: string, optionEvil: string }> = {
    fantasy: {
        bg: 'bg-[#1a120b]',
        text: 'text-[#e5e5e5]',
        accent: 'text-[#fbbf24]',
        font: 'font-serif',
        border: 'border-[#78350f]',
        cardBg: 'bg-[#2a2018]',
        gradient: 'from-[#451a03] to-[#1a120b]',
        optionNormal: 'bg-[#451a03] border-[#78350f] text-[#fbbf24]',
        optionChaotic: 'bg-[#78350f] border-[#b45309] text-[#fcd34d]',
        optionEvil: 'bg-[#3f0f0f] border-[#7f1d1d] text-[#fca5a5]'
    },
    cyber: {
        bg: 'bg-[#020617]',
        text: 'text-[#94a3b8]',
        accent: 'text-[#22d3ee]',
        font: 'font-mono',
        border: 'border-[#1e293b]',
        cardBg: 'bg-[#0f172a]/80',
        gradient: 'from-[#0f172a] to-[#020617]',
        optionNormal: 'bg-[#0f172a] border-[#1e293b] text-[#22d3ee]',
        optionChaotic: 'bg-[#1e1b4b] border-[#4338ca] text-[#a78bfa]',
        optionEvil: 'bg-[#450a0a] border-[#7f1d1d] text-[#fca5a5]'
    },
    horror: {
        bg: 'bg-[#0f0000]',
        text: 'text-[#d4d4d8]',
        accent: 'text-[#ef4444]',
        font: 'font-serif',
        border: 'border-[#450a0a]',
        cardBg: 'bg-[#2b0e0e]',
        gradient: 'from-[#450a0a] to-[#000000]',
        optionNormal: 'bg-[#2b0e0e] border-[#450a0a] text-[#d4d4d8]',
        optionChaotic: 'bg-[#3f1d1d] border-[#7f1d1d] text-[#fda4af]',
        optionEvil: 'bg-[#450a0a] border-[#991b1b] text-[#ef4444]'
    },
    modern: {
        bg: 'bg-slate-50',
        text: 'text-slate-700',
        accent: 'text-blue-600',
        font: 'font-sans',
        border: 'border-slate-200',
        cardBg: 'bg-white',
        gradient: 'from-slate-100 to-white',
        optionNormal: 'bg-white border-slate-200 text-slate-600',
        optionChaotic: 'bg-yellow-50 border-yellow-200 text-yellow-700',
        optionEvil: 'bg-red-50 border-red-200 text-red-700'
    }
};

// 每累積這麼多條「未歸檔日誌」就觸發一次自動總結
const AUTO_SUMMARY_THRESHOLD = 20;
// 自動總結後保留最近這麼多條日誌不折疊，保證閱讀與劇情連貫
const KEEP_RECENT_AFTER_SUMMARY = 4;
// AI 世界觀生成的可選風格
const WORLD_STYLES = ['高奇幻', '賽博朋克', '克蘇魯恐怖', '武俠江湖', '末世廢土', '校園日常', '懸疑推理', '蒸汽朋克', '西部拓荒', '宮廷權謀'];

// 魯棒解析 AI 世界觀生成結果。
// 兼容三種情況：① 期望的「標題：xxx === 正文」分隔格式；② 模型不聽話仍吐 JSON
// （含被截斷的殘缺 JSON）；③ 完全無結構的純文本。任何情況都不把髒標記露給用戶。
const parseWorldGen = (raw: string): { title: string; worldSetting: string } => {
    let text = raw.trim();
    // 去掉可能的代碼塊圍欄
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

    let title = '';
    let worldSetting = '';

    // 情況②：看起來像 JSON（即使被截斷）—— 用正則摳字段，不依賴 JSON.parse
    if (/"?worldSetting"?\s*:/.test(text) || /^\s*\{/.test(text)) {
        const tMatch = text.match(/"?title"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
        // worldSetting 可能未閉合（被截斷），所以允許匹配到結尾。失敗兜底：從 worldSetting": " 之後切到末尾，剝掉可能的尾閉合符號。
        const wMatch = text.match(/"?worldSetting"?\s*:\s*"((?:[^"\\]|\\.)*?)(?:"\s*[},]|"\s*$|$)/);
        if (tMatch) title = tMatch[1];
        if (wMatch) {
            worldSetting = wMatch[1];
        } else {
            // 極端情況（尾部孤反斜槓等導致整段 wMatch 直接 null）：粗暴 slice 把 worldSetting": " 之後的尾巴當原文，杜絕 title 摳到但正文空的迴歸。
            const tailIdx = text.search(/"?worldSetting"?\s*:\s*"/);
            if (tailIdx >= 0) {
                worldSetting = text.slice(tailIdx).replace(/^"?worldSetting"?\s*:\s*"/, '').replace(/\\?"?\s*\}?\s*$/, '');
            }
        }
        // 還原被轉義的字符：單次掃描，避免 `\\n`（被轉義的反斜槓 + 字面 n）被先一步替換成 `\` + 換行。\\uXXXX 也順手解碼。
        const unescape = (s: string) => s
            .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/\\(["\\nt])/g, (_, c) => c === 'n' ? '\n' : c === 't' ? '\t' : c);
        title = unescape(title);
        worldSetting = unescape(worldSetting);
        // 只在 worldSetting 真摳到時早退，否則繼續落到下面的原文 parser——避免 title 摳到、正文空時返回半截結果。
        if (worldSetting) return { title: title.trim(), worldSetting: worldSetting.trim() };
    }

    // 情況①：分隔符格式
    const titleMatch = text.match(/^\s*(?:[标標][题題]|title)\s*[:：]\s*(.+)$/im);
    if (titleMatch) {
        title = titleMatch[1].trim().replace(/^[《"']|[》"']$/g, '');
        text = text.replace(titleMatch[0], '').trim();
    }
    // 去掉分隔線與可能的「世界觀/正文」標籤
    text = text.replace(/^\s*[=\-—]{2,}\s*$/m, '').trim();
    text = text.replace(/^\s*(?:世界[观觀][设設]定|世界[观觀]|正文|lore)\s*[:：]?\s*/i, '').trim();

    worldSetting = text;
    return { title: title.trim(), worldSetting: worldSetting.trim() };
};

// 投擲一顆 D20
const rollD20 = () => Math.floor(Math.random() * 20) + 1;
// 把骰點結果翻譯成成功度描述，供 GM 判定
const rollFlavor = (n: number) => {
    if (n === 20) return '大成功(Critical Success)';
    if (n === 1) return '大失敗(Critical Failure)';
    if (n >= 15) return '成功(Success)';
    if (n >= 8) return '勉強(Partial)';
    return '失敗(Failure)';
};

// --- Markdown Renderer Component ---
const GameMarkdown: React.FC<{ content: string, theme: any, customStyle?: { fontSize: number, color: string } }> = ({ content, theme, customStyle }) => {
    // Helper: Parse Inline Styles (**bold**, *italic*, `code`)
    const parseInline = (text: string) => {
        const parts = text.split(/(\*\*.*?\*\*|\*.*?\*|`.*?`)/g);
        return parts.map((part, i) => {
            if (part.startsWith('**') && part.endsWith('**')) {
                return <strong key={i} className={`font-bold ${theme.accent}`}>{part.slice(2, -2)}</strong>;
            }
            if (part.startsWith('*') && part.endsWith('*')) {
                return <em key={i} className="italic opacity-70 text-[95%] mx-0.5">{part.slice(1, -1)}</em>;
            }
            if (part.startsWith('`') && part.endsWith('`')) {
                return <code key={i} className="bg-black/20 px-1 py-0.5 rounded font-mono text-[0.9em] opacity-90 mx-0.5">{part.slice(1, -1)}</code>;
            }
            return <span key={i}>{part}</span>;
        });
    };

    // Split by newlines to handle blocks
    const lines = content.split('\n');
    
    // Dynamic Style Object
    const styleObj = {
        fontSize: customStyle ? `${customStyle.fontSize}px` : undefined,
        color: customStyle?.color || undefined
    };

    return (
        <div className="space-y-[0.5em] text-justify leading-relaxed" style={styleObj}>
            {lines.map((line, i) => {
                const trimmed = line.trim();
                if (!trimmed) return <div key={i} className="h-[0.5em]"></div>;
                
                // Headers (Relative sizing)
                if (trimmed.startsWith('### ')) return <h3 key={i} className={`text-[1.1em] font-bold uppercase tracking-wider mt-[0.5em] mb-[0.2em] opacity-90 ${theme.accent}`}>{trimmed.slice(4)}</h3>;
                if (trimmed.startsWith('## ')) return <h3 key={i} className="text-[1.25em] font-bold mt-[0.6em] mb-[0.3em] opacity-95">{trimmed.slice(3)}</h3>;
                if (trimmed.startsWith('# ')) return <h3 key={i} className="text-[1.5em] font-black mt-[0.8em] mb-[0.5em] text-center border-b border-current pb-2 opacity-90">{trimmed.slice(2)}</h3>;
                
                // Blockquotes
                if (trimmed.startsWith('> ')) return <div key={i} className="border-l-2 border-current pl-3 py-1 my-2 italic opacity-70 text-[0.9em] bg-black/5 rounded-r">{parseInline(trimmed.slice(2))}</div>;
                
                // Lists
                if (trimmed.startsWith('- ') || trimmed.startsWith('• ')) {
                    return <div key={i} className="flex gap-2 pl-1"><span className={`opacity-50 ${theme.accent}`}>•</span><span>{parseInline(trimmed.slice(2))}</span></div>;
                }

                // Numbered list
                const numMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
                if (numMatch) {
                    return <div key={i} className="flex gap-2 pl-1"><span className={`font-mono opacity-60 ${theme.accent}`}>{numMatch[1]}.</span><span>{parseInline(numMatch[2])}</span></div>;
                }

                // Separator
                if (trimmed === '---' || trimmed === '***') {
                    return <div key={i} className="h-px bg-current opacity-20 my-[1em]"></div>;
                }

                // Standard Paragraph
                return <div key={i}>{parseInline(trimmed)}</div>;
            })}
        </div>
    );
};

const GameApp: React.FC = () => {
    const { closeApp, characters, userProfile, apiConfig, addToast, updateCharacter, characterGroups } = useOS();
    const [view, setView] = useState<'lobby' | 'create' | 'play'>('lobby');
    const [games, setGames] = useState<GameSession[]>([]);
    const [activeGame, setActiveGame] = useState<GameSession | null>(null);
    const [lobbyPage, setLobbyPage] = useState(0); // 存檔大廳分頁（每頁 5 條）
    
    // Creation State
    const [newTitle, setNewTitle] = useState('');
    const [newWorld, setNewWorld] = useState('');
    const [newTheme, setNewTheme] = useState<GameTheme>('fantasy');
    const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
    const [playerGroupId, setPlayerGroupId] = useState(GROUP_FILTER_ALL); // 邀請隊友的分組篩選
    const [isCreating, setIsCreating] = useState(false);
    // 世界觀 AI 輔助生成
    const [worldStyle, setWorldStyle] = useState<string>('高奇幻');
    const [worldIdea, setWorldIdea] = useState('');        // 用戶額外給的靈感/想法（可選）
    const [isGeneratingWorld, setIsGeneratingWorld] = useState(false);
    // 新遊戲玩法設置
    const [newDiceDisabled, setNewDiceDisabled] = useState(false);            // 關閉骰子（默認每次直接成功）
    const [newArchiveMode, setNewArchiveMode] = useState<'auto' | 'manual'>('auto');
    const [showArchiveHelp, setShowArchiveHelp] = useState(false);            // 歸檔模式問號說明

    // Play State
    const [userInput, setUserInput] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const [isSummarizing, setIsSummarizing] = useState(false); // 自動總結全屏反饋
    const [showArchived, setShowArchived] = useState(false);    // 已歸檔劇情摺疊展開
    const [expandedSummaries, setExpandedSummaries] = useState<Set<string>>(new Set()); // 每段總結對應原文的展開狀態
    // 長按多選 → 轉發到聊天
    const [selectMode, setSelectMode] = useState(false);
    const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
    const [isForwarding, setIsForwarding] = useState(false);
    const [lastRoll, setLastRoll] = useState<number | null>(null); // 最近一次自動骰點結果（瞬時展示）
    const [lastTokenUsage, setLastTokenUsage] = useState<{prompt?: number, completion?: number, total: number} | null>(null);
    const [totalTokensUsed, setTotalTokensUsed] = useState(0);
    
    // [FIX] Use Container Ref instead of Element Ref for safer scrolling
    const logsContainerRef = useRef<HTMLDivElement>(null);

    // 長按刪除存檔卡片
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressFired = useRef(false);
    // 長按日誌進入多選
    const logPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // UI Toggles
    const [showSystemMenu, setShowSystemMenu] = useState(false);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    const [isArchiving, setIsArchiving] = useState(false);
    const [showTools, setShowTools] = useState(false); // Default hidden
    const [showParty, setShowParty] = useState(true);  // Default visible
    const [uiSettings, setUiSettings] = useState<{fontSize: number, color: string}>({ fontSize: 14, color: '' });

    // SAN Lock: Sync from activeGame on load
    const [sanityLocked, setSanityLocked] = useState(false);
    useEffect(() => {
        if (activeGame) setSanityLocked(!!activeGame.sanityLocked);
    }, [activeGame?.id]);

    useEffect(() => {
        loadGames();
    }, []);

    // 刪除/新增存檔後，把頁碼鉗制在有效範圍內
    const LOBBY_PAGE_SIZE = 5;
    useEffect(() => {
        const maxPage = Math.max(0, Math.ceil(games.length / LOBBY_PAGE_SIZE) - 1);
        if (lobbyPage > maxPage) setLobbyPage(maxPage);
    }, [games.length, lobbyPage]);

    // [FIX] Updated Auto-scroll logic: Use scrollTop on container
    useEffect(() => {
        if (view === 'play' && logsContainerRef.current) {
            // Use setTimeout to ensure render is complete, allowing smooth scroll to new bottom
            setTimeout(() => {
                if (logsContainerRef.current) {
                    logsContainerRef.current.scrollTo({
                        top: logsContainerRef.current.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            }, 100);
        }
    }, [activeGame?.logs, view, isTyping]);

    const loadGames = async () => {
        const list = await DB.getAllGames();
        setGames(list.sort((a,b) => b.lastPlayedAt - a.lastPlayedAt));
    };

    // --- Helper: Robust API Call ---
    const fetchGameAPI = async (prompt: string, maxTokens: number = 8000) => {
        const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
            body: JSON.stringify({
                model: apiConfig.model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.9, 
                max_tokens: maxTokens,
                stream: false
            })
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

        const text = await response.text();
        let json: any;
        try {
            json = JSON.parse(text);
        } catch {
            // Try stripping "data: " prefix (common in proxy misconfigurations)
            const cleaned = text.replace(/^data: /, '').trim();
            try {
                json = JSON.parse(cleaned);
            } catch {
                // Detect HTML responses
                if (text.trimStart().startsWith('<')) {
                    throw new Error('API返回了HTML而非JSON，請檢查API地址是否正確');
                }
                throw new Error(`API返回了無法解析的格式: ${text.slice(0, 100)}`);
            }
        }

        if (json.usage?.total_tokens) {
            const usage = {
                prompt: json.usage.prompt_tokens || undefined,
                completion: json.usage.completion_tokens || undefined,
                total: json.usage.total_tokens
            };
            setLastTokenUsage(usage);
            setTotalTokensUsed(prev => prev + json.usage.total_tokens);
        }

        return json;
    };

    // --- Helper: Build Synchronized Context (Neural Link) ---
    const buildSyncContext = async (players: CharacterProfile[]) => {
        let fullContext = "";

        // [優化] 多人同場時，把"用戶檔案 / 共有世界觀 / 被多名角色掛載的世界書"提取到頂部
        // 只鋪一次，避免每個角色塊裡重複貼同一份世界書（去重，省 token 也防串台）。
        const sharedScene = ContextBuilder.buildGroupSharedScene(players, userProfile);
        if (sharedScene.text) {
            fullContext += `${sharedScene.text}\n`;
        }

        for (const p of players) {
            // 1. Base Context (Identity & Worldview)
            // [優化] 記憶讀取：跑團多人同場，不再傾倒每個角色逐日的詳細日記（極易讓 LLM 把
            //   A 的記憶安到 B 頭上 = 串台）。改為 includeDetailedMemories=false（僅長期核心記憶）
            //   + 下方按需注入的記憶宮殿向量召回（只取與當前情境相關的片段）。
            //   同時跳過共享場景裡已鋪過的用戶檔案 / 世界書 / 世界觀，徹底去重。
            await injectMemoryPalace(p);
            const core = ContextBuilder.buildCoreContext(p, userProfile, false, undefined, {
                skipUserProfile: true,
                skipWorldview: sharedScene.worldviewIsShared,
                skipWorldbookIds: sharedScene.sharedWorldbookIds,
            });
            fullContext += `\n<<< 角色檔案: ${p.name} (ID: ${p.id}) >>>\n${core}\n`;

            // 記憶宮殿召回（includeDetailedMemories=false 時 buildCoreContext 不會自動帶，這裡按需補回）
            // [防串台] 召回文本自帶的標題是泛指的"你腦海中浮現…"，多角色同場時"你"會混淆。
            //   這裡用顯式歸屬把它鎖死到當前角色名下，並提醒 LLM 嚴禁挪用給別人。
            if (p.memoryPalaceEnabled && p.memoryPalaceInjection && p.memoryPalaceInjection.trim()) {
                fullContext += `\n【注意：以下記憶宮殿召回【僅屬於 ${p.name}】，是 TA 一個人的私人記憶，絕不可當成其他角色的經歷或挪用給別人】\n`;
                fullContext += `${p.memoryPalaceInjection}\n`;
                fullContext += `【${p.name} 的私人記憶結束】\n`;
            }

            // 2. Neural Link: Private Chat Sync
            try {
                const msgs = await loadCharacterContextMessages(p);
                const privateMsgs = msgs.filter(m => !m.groupId); // Only private chats (Neural Link needs full history)
                
                const lastMsg = privateMsgs[privateMsgs.length - 1];
                const now = Date.now();
                let status = "普通";
                let gapDesc = "未知";
                
                if (lastMsg) {
                    const diffMins = (now - lastMsg.timestamp) / 1000 / 60;
                    if (diffMins < 60) {
                        gapDesc = `剛剛 (${Math.floor(diffMins)}分鐘前)`;
                        status = "熱戀/熟絡 (Hot)";
                    } else if (diffMins < 24 * 60) {
                        gapDesc = `今天 (${Math.floor(diffMins/60)}小時前)`;
                        status = "正常 (Normal)";
                    } else {
                        const days = Math.floor(diffMins / (24 * 60));
                        gapDesc = `${days}天前`;
                        status = "疏遠 (Cold)";
                    }
                    
                    // Get last 8 messages for context
                    const recentLog = privateMsgs.slice(-8).map(m => 
                        `[${m.role === 'user' ? 'Me' : p.name}]: ${m.content.substring(0, 40).replace(/\n/g, ' ')}`
                    ).join('\n');
                    
                    fullContext += `
=== 神經鏈接 (Neural Link): 私聊記憶同步 ===
該角色與玩家的【私聊狀態】：${gapDesc}
關係溫度: ${status}
最近私聊話題 (作為後台記憶，不要直接複述，但要影響你的態度):
${recentLog}

【GM強制指令 (Meta Instruction)】: 
1. **打破第四面牆**: 允許角色表現出“正在和用戶一起玩遊戲”的意識。
2. **關係繼承**: 
   - 如果狀態是"Hot"，跑團時要更有默契，可以吐槽“剛才私聊時你不是這麼說的”。
   - 如果狀態是"Cold"，跑團時可以表現得生疏、傲嬌或抱怨“好久不見怎麼突然拉我來冒險”。
   - **絕對禁止**像陌生人一樣對待玩家。你們是老相識。
=====================================\n`;
                } else {
                    fullContext += `[神經鏈接: 無私聊記錄] (視為初次見面)\n`;
                }
            } catch (e) {
                console.error("Sync failed for", p.name, e);
            }
            fullContext += `<<< 檔案結束 >>>\n`;
        }
        return fullContext;
    };

    // --- AI 世界觀生成 (幫想不出劇本的用戶起一個設定) ---
    const handleGenerateWorld = async () => {
        if (!apiConfig.apiKey) {
            addToast('請先配置 API Key', 'error');
            return;
        }
        setIsGeneratingWorld(true);
        // 只報白名單裡的固定風格；用戶額外填的靈感是自由文本，一個字都不帶
        trackEvent('用 AI 生成世界观', { style: WORLD_STYLES.includes(worldStyle) ? worldStyle : '其他' });
        try {
            // [魯棒性] 改用帶分隔符的純文本格式而非 JSON——即使被截斷也能乾淨解析；
            // 不再限制字數，給足 token 防止半路砍斷。
            const prompt = `你是一位資深的 TRPG（桌面跑團）劇本設計師。請按照指定風格，原創一個適合開團的世界觀設定。
**風格基調**: ${worldStyle}
${worldIdea.trim() ? `**玩家的靈感/想法（請務必圍繞它發揮）**: ${worldIdea.trim()}` : ''}

請嚴格按下面的純文本格式輸出，**不要用 JSON，不要代碼塊，不要額外說明**：

標題：<一個有吸引力的劇本標題>
===
<世界觀正文。請寫充分、生動，篇幅自由不設上限，包含：時代/地點背景與基調氛圍、當前世界的核心矛盾或危機、玩家小隊的處境與初始目標鉤子、一兩個可探索的懸念或勢力。留足玩家發揮空間，不要寫死結局。>`;

            const data = await fetchGameAPI(prompt, 6000);
            const raw = (extractContent(data) || '').trim();
            if (!raw) throw new Error('AI 返回了空響應');

            const parsed = parseWorldGen(raw);
            if (parsed.worldSetting) setNewWorld(parsed.worldSetting);
            if (parsed.title && !newTitle.trim()) setNewTitle(parsed.title);
            addToast('世界觀已生成，可繼續編輯', 'success');
        } catch (e: any) {
            addToast(`生成失敗: ${e.message}`, 'error');
        } finally {
            setIsGeneratingWorld(false);
        }
    };

    // --- Creation Logic ---
    const handleCreateGame = async () => {
        if (!newTitle.trim() || !newWorld.trim() || selectedPlayers.size === 0) {
            addToast('請填寫完整信息並選擇至少一名角色', 'error');
            return;
        }
        
        if (!apiConfig.apiKey) {
            addToast('請先配置 API Key 以生成序章', 'error');
            return;
        }

        setIsCreating(true);

        try {
            const tempId = `game-${Date.now()}`;
            const players = characters.filter(c => selectedPlayers.has(c.id));
            
            // Build Context with Sync
            const playerContext = await buildSyncContext(players);

            // Generate Prologue Prompt
            const prompt = `### TRPG 序章生成 (Game Start)
**劇本標題**: ${newTitle}
**世界觀設定**: ${newWorld}
**玩家**: ${userProfile.name}
**隊友**: ${players.map(p => p.name).join(', ')}

### 角色數據 (包含私聊記憶)
${playerContext}

### 任務
你現在是 **Game Master (GM)**。請為這個冒險故事生成一個**精彩的開場 (Prologue)**。
1. **劇情描述**: 描述這個世界正在發生什麼、小隊所處的環境與正在逼近的事件。**先有世界，再有人**——開場不要圍著玩家轉，而是把舞台和危機鋪開。
2. **角色反應**: 簡要描述隊友們的初始狀態或第一句台詞。請**務必**參考【神經鏈接】中的私聊狀態來決定他們的態度；同時讓每個角色展現**自己的性格與目的**，而不是一上來就眾星捧月地討好玩家。
3. **初始選項**: 給出三個玩家可以採取的行動選項${newDiceDisabled ? '（本場未啟用骰子，玩家行動默認順利成功，選項可以是各種有趣的方向）' : '（每個選項玩家執行時都會自動骰 D20 判定，因此選項應是"有成敗風險的嘗試"而非必然成功的動作）'}。

### 一致性自檢 (Consistency Check)
輸出前，請在心裡核對：每個角色的台詞/行為是否**只**來自 TA 自己的"角色檔案"（性格、記憶、印象）？嚴禁把某個角色的記憶、口癖或人設安到另一個角色身上（防止"串台"）。

### 輸出格式 (Strict JSON)
{
  "gm_narrative": "序章劇情描述...",
  "characters": [
    { "charId": "角色ID", "action": "初始動作", "dialogue": "第一句台詞" }
  ],
  "startLocation": "起始地點名稱",
  "suggested_actions": [
    { "label": "選項1 (中立/正直/推進劇情)", "type": "neutral" },
    { "label": "選項2 (樂子人/搞怪/出其不意)", "type": "chaotic" },
    { "label": "選項3 (邪惡/激進/貪婪)", "type": "evil" }
  ]
}`;

            const data = await fetchGameAPI(prompt);
            const rawContent = extractContent(data);
            if (!rawContent) throw new Error('AI 返回了空響應');

            // Robust JSON extraction: handles code fences, trailing commas, extra prose
            const res = extractJson(rawContent);

            const initialLogs: GameLog[] = [];

            if (res) {
                // Structured response - use parsed JSON
                initialLogs.push({
                    id: 'init-gm',
                    role: 'gm',
                    content: `### 序章 · ${newTitle}\n\n${res.gm_narrative || '冒險開始了...'}`,
                    timestamp: Date.now()
                });

                if (Array.isArray(res.characters)) {
                    for (const charAct of res.characters) {
                        const char = players.find(p => p.id === charAct.charId || p.name === charAct.charId);
                        if (char) {
                            initialLogs.push({
                                id: `init-char-${char.id}`,
                                role: 'character',
                                speakerName: char.name,
                                content: `*${charAct.action || ''}* \n"${charAct.dialogue || ''}"`,
                                timestamp: Date.now()
                            });
                        }
                    }
                }
            } else {
                // JSON parse completely failed - use raw text as GM narrative anyway
                console.warn('[GameApp] JSON extraction failed, using raw text as narrative');
                initialLogs.push({
                    id: 'init-gm',
                    role: 'gm',
                    content: `### 序章 · ${newTitle}\n\n${rawContent}`,
                    timestamp: Date.now()
                });
            }

            const newGame: GameSession = {
                id: tempId,
                title: newTitle,
                theme: newTheme,
                worldSetting: newWorld,
                playerCharIds: Array.from(selectedPlayers),
                logs: initialLogs,
                status: {
                    location: res?.startLocation || 'Unknown',
                    health: 100,
                    sanity: 100,
                    gold: 0,
                    inventory: []
                },
                suggestedActions: res?.suggested_actions || [],
                diceDisabled: newDiceDisabled,
                archiveMode: newArchiveMode,
                createdAt: Date.now(),
                lastPlayedAt: Date.now()
            };

            await DB.saveGame(newGame);
            setGames(prev => [newGame, ...prev]);
            setActiveGame(newGame);
            setView('play');
            trackEvent('创建冒险开团', {
                theme: newTheme,
                dice: newDiceDisabled ? '关' : '开',
                archiveMode: newArchiveMode,
            });

            // Reset form
            setNewTitle('');
            setNewWorld('');
            setWorldIdea('');
            setNewDiceDisabled(false);
            setNewArchiveMode('auto');
            setSelectedPlayers(new Set());

        } catch (e: any) {
            addToast(`創建失敗: ${e.message}`, 'error');
        } finally {
            setIsCreating(false);
        }
    };

    // --- SAN Lock Toggle ---
    const toggleSanityLock = async () => {
        const newVal = !sanityLocked;
        setSanityLocked(newVal);
        if (activeGame) {
            const updated = { ...activeGame, sanityLocked: newVal };
            setActiveGame(updated);
            await DB.saveGame(updated);
            addToast(newVal ? 'SAN 值已鎖定' : 'SAN 值已解鎖', 'info');
        }
        trackEvent('切换 SAN 值锁定', { state: newVal ? '锁定' : '解锁' });
    };

    // --- Dice Toggle (關閉後行動不再自動骰 D20) ---
    const toggleDice = async () => {
        if (!activeGame) return;
        const newDisabled = !activeGame.diceDisabled;
        const updated = { ...activeGame, diceDisabled: newDisabled };
        setActiveGame(updated);
        await DB.saveGame(updated);
        addToast(newDisabled ? '已關閉骰子，行動不再骰點' : '已開啟骰子', 'info');
        trackEvent('切换骰子判定', { state: newDisabled ? '关' : '开' });
    };

    // --- Gameplay Logic ---
    const handleAction = async (actionText: string, isReroll: boolean = false) => {
        if (!activeGame || !apiConfig.apiKey) return;

        let contextLogs = activeGame.logs;
        let updatedGame = activeGame;
        let currentRoll: number | null = null;

        if (!isReroll) {
            const isSystemAction = actionText.startsWith('[System');
            // [優化] 每個玩家行動默認自動骰一顆 D20（不再需要主動點骰子）。
            // 系統消息不骰點；用戶在設置裡關閉骰子時也不骰點。
            if (!isSystemAction && actionText.trim() && !activeGame.diceDisabled) {
                currentRoll = rollD20();
                setLastRoll(currentRoll);
                addToast(`D20 = ${currentRoll} · ${rollFlavor(currentRoll)}`, 'info');
            }

            // Standard Action: Append user log
            const userLog: GameLog = {
                id: `log-${Date.now()}`,
                role: isSystemAction ? 'system' : 'player',
                speakerName: userProfile.name,
                content: actionText,
                timestamp: Date.now(),
                diceRoll: currentRoll ? { result: currentRoll, max: 20 } : undefined
            };

            const updatedLogs = [...activeGame.logs, userLog];
            updatedGame = { ...activeGame, logs: updatedLogs, lastPlayedAt: Date.now(), suggestedActions: [] }; // Clear options while thinking
            setActiveGame(updatedGame);
            await DB.saveGame(updatedGame);
            contextLogs = updatedLogs;
        }

        setUserInput('');
        setIsTyping(true);
        setLastTokenUsage(null);
        addToast('GM 正在推演...', 'info'); // Feedback for Sync

        try {
            // 2. Build Context WITH RELATIONSHIP SYNC
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            const playerContext = await buildSyncContext(players);

            // 3. Build Status Warning
            let statusWarning = "";
            if (activeGame.status.health <= 30) statusWarning += "\n[WARNING: LOW HP] 玩家瀕臨死亡，請描述極度的虛弱、傷痛、視野模糊或瀕死體驗。\n";
            if (activeGame.status.sanity <= 30) statusWarning += "\n[WARNING: LOW SAN] 玩家理智崩潰中，請描述瘋狂、幻聽、幻視或不可名狀的恐懼。\n";
            
            let gameOverTrigger = "";
            if (activeGame.status.health <= 0 || activeGame.status.sanity <= 0) {
                gameOverTrigger = "\n[GAME OVER TRIGGER] 玩家的生命值或理智值已歸零。請生成一個悲慘或瘋狂的結局 (Bad Ending)，結束本次冒險。\n";
            }

            // [優化] 歷史記錄：已歸檔的舊劇情用「前情提要」總結代替，未歸檔日誌保留原文，
            //   並把每條玩家行動的骰點結果一併餵給 GM 用於判定（之前 GM 根本看不到骰點）。
            const serializeLog = (l: GameLog) => {
                const who = l.role === 'gm' ? 'GM' : (l.speakerName || 'System');
                const dice = l.diceRoll ? ` 〔D20=${l.diceRoll.result}/${rollFlavor(l.diceRoll.result)}〕` : '';
                return `[${who}]${dice}: ${l.content}`;
            };
            const summaries = activeGame.summaries || [];
            const recapBlock = summaries.length > 0
                ? `### 前情提要 (Story So Far)\n${summaries.map((s, i) => `【第${i + 1}段】${s.content}`).join('\n\n')}\n\n`
                : '';
            const activeLogText = contextLogs.filter(l => !l.archived).map(serializeLog).join('\n');

            // 當前這步行動的判定提示：開了骰子按 D20 裁定；關了骰子默認直接成功
            const rollInstruction = currentRoll
                ? `\n### 本回合判定\n玩家這次行動擲出了 **D20 = ${currentRoll}（${rollFlavor(currentRoll)}）**。請據此裁定行動的成敗與代價：20=出乎意料的大成功，1=災難性大失敗，高分順利、低分受挫。讓結果自然融入敘事，不要直接複述數字。\n`
                : (activeGame.diceDisabled
                    ? `\n### 判定模式\n本場冒險未啟用骰子，玩家的行動默認視為順利成功（除非劇情邏輯上明顯不可能）。請直接推進正向結果，不要用隨機失敗打斷節奏。\n`
                    : '');

            const prompt = `### TRPG 跑團模式: ${activeGame.title}
**當前劇本**: ${activeGame.worldSetting}
**當前場景**: ${activeGame.status.location}
**隊伍資源**:
- HP: ${activeGame.status.health}%
- SAN: ${activeGame.status.sanity || 100}%
- GOLD: ${activeGame.status.gold || 0}
- 物品: ${activeGame.status.inventory.join(', ') || '空'}

${statusWarning}
${gameOverTrigger}

### 冒險小隊 (The Party)
1. **${userProfile.name}** (玩家/User)
${players.map(p => `2. **${p.name}** (ID: ${p.id}) - 你的隊友`).join('\n')}

### 角色檔案 & 神經鏈接 (Character Sheets & Neural Links)
${playerContext}

${recapBlock}### 冒險記錄 (Recent Log)
${activeLogText}
${rollInstruction}
### GM 指令 (Game Master Instructions)
你現在是這場跑團遊戲的 **主持人 (GM)**。
**現在的狀態**：這是一群真實的朋友（基於神經鏈接中的私聊關係）在一起玩跑團遊戲。

**請遵循以下法則**：
1. **全員「入戲」 (Roleplay First)**:
   - 隊友們是活生生的冒險者，但同時也帶著私聊時的記憶和情感。
   - **拒絕機械感**: 他們應該主動觀察環境、吐槽現狀、互相開玩笑。
   - **私聊影響 (關鍵)**: 請根據【神經鏈接】中的“關係溫度”和“最近話題”來調整每個角色的反應。
   - **隊內互動**: 隊友之間也可以有互動（比如A吐槽B的計劃）。

2. **去玩家中心 · 讓世界自己轉 (關鍵)**:
   - **拒絕修羅場**: 隊友們不是來討好/爭搶玩家的 NPC。不要讓所有人都把注意力黏在玩家身上、搶著對玩家示好。
   - **各有所圖**: 每個角色都帶著**自己的目的、立場和情緒**行動，可以分歧、可以自顧自做事、可以暫時忽略玩家。
   - **因地制宜**: 同一個角色在戰鬥、社交、獨處、危機等不同環境下應表現出**不同側面**，而非一套反應走到底。
   - **劇情自驅**: 世界有自己的節奏——即使玩傢什麼都不做，也會有事件發生、勢力推進、NPC 行動。主動推動主線。

3. **硬核 GM 風格**:
   - **製造衝突**: 不要讓旅途一帆風順。安排陷阱、突發戰鬥、尷尬的社交場面、或者道德困境。
   - **環境描寫**: 描述光影、氣味、聲音，營造沉浸感。
   - **骰點判定**: 嚴格依據【本回合判定】的 D20 結果裁定成敗，骰得低就要有真實代價。
   - **Markdown 排版**: 請在 \`gm_narrative\` 和 \`dialogue\` 中**積極使用 Markdown**。例如：使用 **加粗** 強調重點，使用 *斜體* 描述動作。

4. **生成選項 (Action Options)**:
   - 請根據當前局勢，為玩家提供 3 個可選的行動建議（玩家選擇後都會自動骰 D20，因此選項應是有成敗風險的嘗試）。

### 一致性自檢 (Consistency Check)
輸出前請最後核對一遍：每個角色的台詞、記憶、口癖、性格是否**嚴格來自 TA 各自的"角色檔案"**？絕不能把一個角色的記憶/人設/經歷安到另一個角色身上（防止"串台"）。如發現串台，請改正後再輸出。

### 輸出格式 (Strict JSON)
請僅輸出 JSON，不要包含 Markdown 代碼塊。
{
  "gm_narrative": "GM的劇情描述 (支持Markdown)...",
  "characters": [
    { 
      "charId": "角色ID (必須對應上方列表)", 
      "action": "動作描述", 
      "dialogue": "台詞" 
    }
  ],
  "newLocation": "新地點 (可選)",
  "hpChange": 0,
  "sanityChange": 0,
  "goldChange": 0,
  "newItem": "獲得物品 (可選)",
  "suggested_actions": [
    { "label": "選項1文本", "type": "neutral" },
    { "label": "選項2文本", "type": "chaotic" },
    { "label": "選項3文本", "type": "evil" }
  ]
}`;

            const data = await fetchGameAPI(prompt);
            const rawContent = extractContent(data);
            if (!rawContent) throw new Error('AI 返回了空響應');

            // Robust JSON extraction
            const res = extractJson(rawContent);

            const newLogs: GameLog[] = [];
            const newStatus = { ...updatedGame.status };

            if (res) {
                // Structured response - use parsed JSON
                if (res.gm_narrative) {
                    newLogs.push({
                        id: `gm-${Date.now()}`,
                        role: 'gm',
                        content: res.gm_narrative,
                        timestamp: Date.now()
                    });
                }

                if (Array.isArray(res.characters)) {
                    for (const charAct of res.characters) {
                        const char = players.find(p => p.id === charAct.charId || p.name === charAct.charId);
                        if (char) {
                            const combinedContent = `*${charAct.action || ''}* \n"${charAct.dialogue || ''}"`;
                            newLogs.push({
                                id: `char-${Date.now()}-${Math.random()}`,
                                role: 'character',
                                speakerName: char.name,
                                content: combinedContent,
                                timestamp: Date.now()
                            });
                        }
                    }
                }

                // Update State (Stats)
                if (res.newLocation) newStatus.location = res.newLocation;
                if (res.hpChange) newStatus.health = Math.max(0, Math.min(100, (newStatus.health || 100) + res.hpChange));
                if (res.sanityChange && !sanityLocked) newStatus.sanity = Math.max(0, Math.min(100, (newStatus.sanity || 100) + res.sanityChange));
                if (res.goldChange) newStatus.gold = Math.max(0, (newStatus.gold || 0) + res.goldChange);
                if (res.newItem) newStatus.inventory = [...newStatus.inventory, res.newItem];
            } else {
                // JSON parse completely failed - still show the raw text as GM narrative
                console.warn('[GameApp] JSON extraction failed, using raw text as narrative');
                newLogs.push({
                    id: `gm-${Date.now()}`,
                    role: 'gm',
                    content: rawContent,
                    timestamp: Date.now()
                });
            }

            const finalGame = {
                ...updatedGame,
                logs: [...contextLogs, ...newLogs],
                status: newStatus,
                suggestedActions: res?.suggested_actions || []
            };
            
            setActiveGame(finalGame);
            await DB.saveGame(finalGame);

            // 回合結束後檢查是否需要自動總結歸檔前文
            setIsTyping(false);
            await runAutoSummaryIfNeeded(finalGame);

        } catch (e: any) {
            addToast(`GM 掉線了: ${e.message}`, 'error');
        } finally {
            setIsTyping(false);
        }
    };

    // --- 自動總結 (每累積 AUTO_SUMMARY_THRESHOLD 條未歸檔日誌觸發一次) ---
    // 把舊劇情壓縮成小說式「前情提要」，歸檔摺疊原文（不刪除），並把總結小卡片
    // 發送到參與角色的記憶與聊天上下文裡。
    const runAutoSummaryIfNeeded = async (game: GameSession) => {
        const nonArchived = game.logs.filter(l => !l.archived);
        if (nonArchived.length < AUTO_SUMMARY_THRESHOLD) return;

        // 保留最近 KEEP_RECENT_AFTER_SUMMARY 條不折疊，保證連貫
        const toArchive = nonArchived.slice(0, nonArchived.length - KEEP_RECENT_AFTER_SUMMARY);
        if (toArchive.length < 6) return; // 太少不值得總結

        setIsSummarizing(true);
        try {
            const players = characters.filter(c => game.playerCharIds.includes(c.id));
            const playerNames = players.map(p => p.name).join('、');
            const prevRecap = (game.summaries || []).map((s, i) => `【第${i + 1}段】${s.content}`).join('\n');

            const logText = toArchive.map(l => {
                const who = l.role === 'gm' ? 'GM' : (l.speakerName || 'System');
                return `[${who}]: ${l.content}`;
            }).join('\n');

            const prompt = `你是一位擅長寫小說的記錄者。請把下面這段 TRPG 跑團劇情，總結成一段**連貫、生動、像小說梗概一樣**的前情提要。
${prevRecap ? `\n【已有前情（僅供銜接，不要重複）】\n${prevRecap}\n` : ''}
【本段需要總結的劇情記錄】
${logText}

要求：
1. 用第三人稱敘述，包含【起因 → 經過 → 結果】的來龍去脈。
2. 重點寫清楚**人物之間的關係變化與各自的處境/情緒**（誰和誰更近了/起了衝突/暴露了什麼）。
3. 控制在 200~350 字，文筆流暢，不要分點羅列，不要寫"總結如下"之類的開場白。

直接輸出總結正文：`;

            const data = await fetchGameAPI(prompt, 1500);
            let summaryText = (extractContent(data) || '').trim();
            if (!summaryText) summaryText = '（這段冒險繼續推進了劇情）';

            const newSummary: GameSummary = {
                id: `sum-${Date.now()}`,
                content: summaryText,
                logCount: toArchive.length,
                logIds: toArchive.map(l => l.id),
                createdAt: Date.now(),
            };

            // 摺疊歸檔原文（標記 archived，不刪除）
            const archiveIds = new Set(toArchive.map(l => l.id));
            const archivedLogs = game.logs.map(l => archiveIds.has(l.id) ? { ...l, archived: true } : l);

            const updated: GameSession = {
                ...game,
                logs: archivedLogs,
                summaries: [...(game.summaries || []), newSummary],
            };
            setActiveGame(updated);
            await DB.saveGame(updated);

            // 歸檔模式決定是否把總結推送到角色 chatapp。
            // 'auto' 推送；'manual'（含舊存檔無此字段者）不推送，僅手動歸檔時才送。
            if (game.archiveMode === 'auto') {
                const now = new Date();
                const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                const cardLine = `和【${playerNames}】一起玩《${game.title}》TRPG，${summaryText}`;
                for (const p of players) {
                    const mem = {
                        id: `mem-${Date.now()}-${Math.random()}`,
                        date: dateStr,
                        summary: cardLine,
                        mood: 'fun'
                    };
                    updateCharacter(p.id, { memories: [...(p.memories || []), mem] });
                    await DB.saveMessage({
                        charId: p.id,
                        role: 'system',
                        type: 'text',
                        content: `[TRPG 進度卡: 你正和${playerNames}玩《${game.title}》。${summaryText}]`
                    });
                }
                addToast('已自動總結並歸檔（已同步到角色聊天）', 'success');
            } else {
                addToast('已自動總結並歸檔前文', 'success');
            }
        } catch (e) {
            console.error('[GameApp] auto summary failed', e);
            // 總結失敗不阻塞遊戲，靜默跳過
        } finally {
            setIsSummarizing(false);
        }
    };

    const handleReroll = async () => {
        if (!activeGame || isTyping) return;
        
        // Find index of last user/system action
        const logs = activeGame.logs;
        let lastUserIndex = -1;
        for (let i = logs.length - 1; i >= 0; i--) {
            if (logs[i].role === 'player' || logs[i].role === 'system') {
                lastUserIndex = i;
                break;
            }
        }

        if (lastUserIndex === -1) {
            addToast('沒有可以重新推演的內容。', 'info');
            return;
        }

        // Keep logs up to and including the last user input
        const contextLogs = logs.slice(0, lastUserIndex + 1);
        
        // Optimistic Update
        const rolledBackGame = { ...activeGame, logs: contextLogs };
        setActiveGame(rolledBackGame);
        
        await handleAction("", true); // isReroll = true
        addToast('正在重新推演命運...', 'info');
        trackEvent('重新推演上一段剧情');
    };

    const handleRollbackLog = async (index: number) => {
        if (!activeGame) return;
        if (!confirm("回退到此條記錄？\n(注意：此操作將刪除該條記錄之後的所有內容，但不會自動重置HP/物品狀態，請手動調整)")) return;
        
        const newLogs = activeGame.logs.slice(0, index + 1);
        const updated = { ...activeGame, logs: newLogs };
        await DB.saveGame(updated);
        setActiveGame(updated);
        addToast('時間回溯成功', 'success');
        trackEvent('回退剧情到某条记录');
    };

    const handleRestart = async () => {
        if (!activeGame) return;
        if (!confirm('確定要重置當前遊戲嗎？所有進度將丟失。')) return;

        const initialLog: GameLog = {
            id: 'init',
            role: 'gm',
            content: `歡迎來到 "${activeGame.title}"。\n世界觀載入中...\n${activeGame.worldSetting}`,
            timestamp: Date.now()
        };

        const resetGame: GameSession = {
            ...activeGame,
            logs: [initialLog],
            // 漏清 summaries 會讓舊前情提要繼續顯示在「已歸檔劇情」並被注入下一輪 GM prompt → 串檔。一併清掉 UI 展開狀態。
            summaries: [],
            status: {
                location: 'Start Point',
                health: 100,
                sanity: 100,
                gold: 0,
                inventory: []
            },
            suggestedActions: [],
            lastPlayedAt: Date.now()
        };

        await DB.saveGame(resetGame);
        setActiveGame(resetGame);
        setShowArchived(false);
        setExpandedSummaries(new Set());
        setShowSystemMenu(false);
        addToast('遊戲已重置', 'success');
        trackEvent('重置本局冒险');
    };

    // "Leave" just goes back to lobby (Auto-save is handled by DB calls in handleAction)
    const handleLeave = () => {
        setActiveGame(null);
        setView('lobby');
        setShowSystemMenu(false);
    };

    const handleArchiveAndQuit = async () => {
        if (!activeGame) return;
        setIsArchiving(true);
        setShowSystemMenu(false);
        
        try {
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            const playerNames = players.map(p => p.name).join('、');
            // Increase log context for summary
            const logText = activeGame.logs.slice(-30).map(l => `${l.role}: ${l.content}`).join('\n');
            
            const prompt = `Task: Summarize the key events of this TRPG session into a short clause (what happened).
Game: ${activeGame.title}
Logs:
${logText}
Output: A concise summary in Chinese (e.g. "探索了地牢並擊敗了史萊姆"). No preamble.`;

            const data = await fetchGameAPI(prompt);
            let summary = extractContent(data) || '進行了一場冒險';
            summary = summary.replace(/[。\.]$/, ''); // Remove trailing dot

            // Format: 【角色名們】和【用戶名】一起玩了xxx，發生了xxxx
            const memoryContent = `【${playerNames}】和【${userProfile.name}】一起玩了《${activeGame.title}》，發生了${summary}`;
            
            // Format: YYYY-MM-DD
            const now = new Date();
            const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

            for (const p of players) {
                // 1. Inject into Memory
                const mem = {
                    id: `mem-${Date.now()}-${Math.random()}`,
                    date: dateStr,
                    summary: memoryContent,
                    mood: 'fun'
                };
                updateCharacter(p.id, { memories: [...(p.memories || []), mem] });

                // 2. Inject into Context via System Message
                await DB.saveMessage({
                    charId: p.id,
                    role: 'system',
                    type: 'text',
                    content: `[TRPG 歸檔提醒: 剛剛你們一起玩了《${activeGame.title}》。${summary}。]`
                });
            }
            addToast('記憶傳遞完成 (Chat & Memory)', 'success');
            trackEvent('归档冒险并写进角色记忆');
        } catch (e) {
            console.error(e);
            addToast('歸檔失敗', 'error');
        } finally {
            setIsArchiving(false);
            setView('lobby'); 
            setActiveGame(null);
        }
    };

    // --- 長按多選日誌 → 轉發到聊天 ---
    const startLogPress = (logId: string) => {
        if (selectMode) return;
        cancelLogPress();
        logPressTimer.current = setTimeout(() => {
            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
            setSelectMode(true);
            setSelectedLogIds(new Set([logId]));
        }, 500);
    };
    const cancelLogPress = () => {
        if (logPressTimer.current) { clearTimeout(logPressTimer.current); logPressTimer.current = null; }
    };
    const toggleSelectLog = (logId: string) => {
        setSelectedLogIds(prev => {
            const n = new Set(prev);
            n.has(logId) ? n.delete(logId) : n.add(logId);
            return n;
        });
    };
    const exitSelectMode = () => {
        setSelectMode(false);
        setSelectedLogIds(new Set());
    };

    // 把選中的劇情打包成 trpg_card，轉發進每個參與角色的聊天上下文
    const handleForwardToChat = async () => {
        if (!activeGame || selectedLogIds.size === 0) return;
        setIsForwarding(true);
        try {
            const players = characters.filter(c => activeGame.playerCharIds.includes(c.id));
            // 按劇情原順序取選中的日誌（排除純系統佔位）
            const selected = activeGame.logs.filter(l => selectedLogIds.has(l.id) && l.role !== 'system');
            const excerpt = selected.map(l => ({
                role: l.role,
                speaker: l.role === 'gm' ? 'GM' : (l.speakerName || (l.role === 'player' ? userProfile.name : '')),
                text: l.content,
            }));
            const trpg = {
                gameTitle: activeGame.title,
                theme: activeGame.theme,
                userName: userProfile.name,
                partyNames: players.map(p => p.name),
                excerpt,
                count: excerpt.length,
            };
            for (const p of players) {
                await DB.saveMessage({
                    charId: p.id,
                    role: 'user',
                    type: 'trpg_card',
                    content: `[TRPG遊戲片段]《${activeGame.title}》`,
                    metadata: { trpg },
                });
            }
            addToast(`已轉發到 ${players.length} 位角色的聊天`, 'success');
            trackEvent('转发剧情片段到聊天');
            exitSelectMode();
        } catch (e: any) {
            addToast(`轉發失敗: ${e.message}`, 'error');
        } finally {
            setIsForwarding(false);
        }
    };

    const handleDeleteGame = (e: React.MouseEvent, id: string) => {
        e.stopPropagation();
        setDeleteConfirmId(id);
    };

    // 長按卡片刪除：按住約 550ms 觸發刪除確認，並抑制隨後的點擊進入
    const startLongPress = (id: string) => {
        longPressFired.current = false;
        cancelLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressFired.current = true;
            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(30);
            setDeleteConfirmId(id);
        }, 550);
    };
    const cancelLongPress = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
        }
    };
    const handleCardOpen = (g: GameSession) => {
        if (longPressFired.current) { longPressFired.current = false; return; } // 長按已觸發刪除，忽略點擊
        setActiveGame(g);
        setView('play');
        trackEvent('打开存档继续冒险');
    };

    const confirmDeleteGame = async () => {
        if (!deleteConfirmId) return;
        await DB.deleteGame(deleteConfirmId);
        setGames(prev => prev.filter(g => g.id !== deleteConfirmId));
        setDeleteConfirmId(null);
        addToast('存檔已刪除', 'success');
        trackEvent('删除跑团存档');
    };

    // --- Renderers ---

    // 1. Lobby View (Redesigned)
    if (view === 'lobby') {
        return (
            <div className="h-full w-full bg-[#0a0a0a] flex flex-col font-sans relative overflow-hidden">
                {/* Ambient Background */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-900/50 to-black z-0"></div>
                <div className="absolute inset-0 z-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/stardust.png")' }}></div>

                {/* Header */}
                <div className="shrink-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center justify-between px-6 py-3">
                        <button onClick={closeApp} className="p-2 -ml-2 hover:bg-white/10 rounded-full text-white/70 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="font-black tracking-[0.2em] text-xl text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600">TRPG ADVENTURE</span>
                        <button onClick={() => setView('create')} className="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center text-white border border-white/10 shadow-lg active:scale-95 transition-all hover:bg-white/20">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                        </button>
                    </div>
                </div>

                {/* Games Grid */}
                <div className="px-6 pt-6 pb-2 flex-1 overflow-y-auto no-scrollbar z-10 space-y-4">
                    {games.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-64 text-slate-500 gap-4">
                            <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center border border-white/5 animate-pulse"><Planet size={48} className="text-indigo-400" /></div>
                            <p className="text-xs tracking-widest uppercase">No Active Adventures</p>
                        </div>
                    )}
                    {games.length > 0 && (
                        <p className="text-[10px] text-white/30 tracking-widest uppercase text-center -mt-2">長按卡片可刪除</p>
                    )}
                    {games.slice(lobbyPage * LOBBY_PAGE_SIZE, lobbyPage * LOBBY_PAGE_SIZE + LOBBY_PAGE_SIZE).map(g => {
                        const themeStyle = GAME_THEMES[g.theme] || GAME_THEMES.fantasy;
                        return (
                            <div
                                key={g.id}
                                onClick={() => handleCardOpen(g)}
                                onPointerDown={() => startLongPress(g.id)}
                                onPointerUp={cancelLongPress}
                                onPointerLeave={cancelLongPress}
                                onPointerCancel={cancelLongPress}
                                onContextMenu={(e) => e.preventDefault()}
                                className={`relative overflow-hidden rounded-2xl p-5 cursor-pointer group active:scale-[0.98] transition-all border border-white/5 hover:border-white/20 shadow-lg select-none`}
                            >
                                {/* Card Background */}
                                <div className={`absolute inset-0 bg-gradient-to-br ${themeStyle.gradient} opacity-80 group-hover:opacity-100 transition-opacity`}></div>
                                <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
                                
                                <div className="relative z-10 flex flex-col gap-2">
                                    <div className="flex justify-between items-start">
                                        <h3 className={`font-bold text-lg text-white leading-tight drop-shadow-md font-serif`}>{g.title}</h3>
                                        <span className={`text-[10px] px-2 py-0.5 rounded border border-white/20 text-white/80 uppercase font-mono tracking-wider bg-black/20`}>{g.theme}</span>
                                    </div>
                                    
                                    <p className="text-xs text-white/60 line-clamp-2 leading-relaxed italic font-serif border-l-2 border-white/20 pl-2">
                                        "{g.worldSetting}"
                                    </p>
                                    
                                    <div className="flex justify-between items-end mt-2 pt-2 border-t border-white/10">
                                        <div className="flex -space-x-2">
                                            {characters.filter(c => g.playerCharIds.includes(c.id)).map(c => (
                                                <TokenImg key={c.id} value={c.avatar} className="w-8 h-8 rounded-full border-2 border-black/50 object-cover shadow-sm" />
                                            ))}
                                        </div>
                                        <div className="text-[10px] text-white/40 font-mono">
                                            {new Date(g.lastPlayedAt).toLocaleDateString()}
                                        </div>
                                    </div>
                                </div>

                                {/* Delete Button */}
                                <button onClick={(e) => handleDeleteGame(e, g.id)} className="absolute top-2 right-2 p-2 text-white/20 hover:text-red-400 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        );
                    })}
                </div>

                {/* Pager (每頁 5 條) */}
                {games.length > LOBBY_PAGE_SIZE && (() => {
                    const totalPages = Math.ceil(games.length / LOBBY_PAGE_SIZE);
                    return (
                        <div className="flex items-center justify-center gap-4 px-6 pb-[calc(1rem+var(--safe-bottom,0px))] pt-2 shrink-0 z-10">
                            <button
                                onClick={() => setLobbyPage(p => Math.max(0, p - 1))}
                                disabled={lobbyPage === 0}
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/70 active:scale-95 transition-all disabled:opacity-25 hover:bg-white/10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                            </button>
                            <div className="flex items-center gap-1.5">
                                {Array.from({ length: totalPages }).map((_, i) => (
                                    <button
                                        key={i}
                                        onClick={() => setLobbyPage(i)}
                                        className={`rounded-full transition-all ${i === lobbyPage ? 'w-5 h-1.5 bg-purple-400' : 'w-1.5 h-1.5 bg-white/25 hover:bg-white/40'}`}
                                    />
                                ))}
                            </div>
                            <button
                                onClick={() => setLobbyPage(p => Math.min(totalPages - 1, p + 1))}
                                disabled={lobbyPage >= totalPages - 1}
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/70 active:scale-95 transition-all disabled:opacity-25 hover:bg-white/10"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                            </button>
                        </div>
                    );
                })()}

                {/* Delete Save Confirm Modal (lobby) */}
                <Modal isOpen={!!deleteConfirmId} title="刪除存檔" onClose={() => setDeleteConfirmId(null)} footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                        <button onClick={confirmDeleteGame} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">刪除</button>
                    </div>
                }>
                    <p className="text-sm text-slate-600 text-center py-4">確定要刪除這個存檔嗎？<br/><span className="text-xs text-red-400 mt-1 block">此操作不可恢復。</span></p>
                </Modal>
            </div>
        );
    }

    // 2. Create View
    if (view === 'create') {
        const THEME_META: Record<GameTheme, { label: string; en: string; gradient: string }> = {
            fantasy: { label: '奇幻', en: 'FANTASY', gradient: 'from-amber-700 to-orange-900' },
            cyber: { label: '賽博', en: 'CYBER', gradient: 'from-cyan-600 to-indigo-900' },
            horror: { label: '恐怖', en: 'HORROR', gradient: 'from-red-800 to-black' },
            modern: { label: '現代', en: 'MODERN', gradient: 'from-sky-500 to-slate-700' },
        };
        const canStart = newTitle.trim() && newWorld.trim() && selectedPlayers.size > 0;
        const playerChars = filterCharactersByGroup(characters, characterGroups, playerGroupId); // 邀請隊友：按分組篩選後的候選
        return (
            <div className="h-full w-full bg-[#0a0a0a] text-white flex flex-col font-sans relative overflow-hidden">
                {/* Ambient Background */}
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/30 via-slate-900/40 to-black z-0"></div>
                <div className="absolute inset-0 z-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/stardust.png")' }}></div>

                {/* Header */}
                <div className="shrink-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="flex items-center px-5 py-3">
                        <button onClick={() => setView('lobby')} className="p-2 -ml-2 rounded-full text-white/70 hover:bg-white/10 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg></button>
                        <span className="font-black tracking-[0.15em] text-base ml-1 mb-1 text-transparent bg-clip-text bg-gradient-to-r from-purple-300 to-pink-500">創建新世界</span>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-5 pb-6 space-y-5 z-10 no-scrollbar">
                    {/* 劇本標題 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">劇本標題</label>
                        <input value={newTitle} onChange={e => setNewTitle(e.target.value)} className="w-full bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-sm text-white placeholder-white/25 focus:border-purple-400/60 focus:bg-white/10 outline-none transition-all" placeholder="例如：勇者鬥惡龍" />
                    </div>

                    {/* 世界觀設定 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">世界觀設定 (Lore)</label>
                        <textarea value={newWorld} onChange={e => setNewWorld(e.target.value)} className="w-full h-36 bg-white/5 border border-white/10 rounded-2xl px-4 py-3.5 text-sm leading-relaxed text-white placeholder-white/25 focus:border-purple-400/60 focus:bg-white/10 outline-none resize-none transition-all" placeholder="描述你的世界... 沒思路的話，用下方 AI 幫你生成" />

                        {/* AI 世界觀生成面板 */}
                        <div className="mt-3 rounded-2xl p-4 bg-gradient-to-br from-purple-500/10 to-pink-500/5 border border-purple-400/20 backdrop-blur-sm">
                            <div className="flex items-center gap-2 mb-3">
                                <span className="w-1 h-3.5 rounded-full bg-gradient-to-b from-purple-400 to-pink-400"></span>
                                <span className="text-xs font-bold text-purple-200">沒思路？讓 AI 幫你寫</span>
                            </div>

                            {/* 風格選擇 */}
                            <div className="grid grid-cols-5 gap-1.5 mb-3">
                                {WORLD_STYLES.map(s => (
                                    <button
                                        key={s}
                                        onClick={() => setWorldStyle(s)}
                                        className={`px-1 py-1.5 rounded-lg text-[10px] font-medium border transition-all active:scale-95 ${worldStyle === s ? 'bg-purple-500 text-white border-purple-400 shadow-lg shadow-purple-500/30' : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10'}`}
                                    >{s}</button>
                                ))}
                            </div>

                            {/* 額外靈感輸入 (可選) */}
                            <input
                                value={worldIdea}
                                onChange={e => setWorldIdea(e.target.value)}
                                className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2.5 text-xs text-white placeholder-white/25 focus:border-purple-400/60 outline-none transition-all mb-3"
                                placeholder="再補充點想法？(可選，如：主角是失憶的賞金獵人)"
                            />

                            <button
                                onClick={handleGenerateWorld}
                                disabled={isGeneratingWorld}
                                className="w-full text-xs font-bold py-2.5 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-60 shadow-lg shadow-purple-500/20"
                            >
                                {isGeneratingWorld ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> 正在生成「{worldStyle}」世界...</> : <>生成世界觀</>}
                            </button>
                        </div>
                    </div>

                    {/* 畫風主題 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">畫風主題</label>
                        <div className="grid grid-cols-4 gap-2">
                            {(['fantasy', 'cyber', 'horror', 'modern'] as GameTheme[]).map(t => {
                                const meta = THEME_META[t];
                                const active = newTheme === t;
                                return (
                                    <button key={t} onClick={() => setNewTheme(t)} className={`relative overflow-hidden rounded-xl py-4 flex flex-col items-center gap-0.5 border transition-all active:scale-95 ${active ? 'border-white/60 ring-1 ring-white/40' : 'border-white/10'}`}>
                                        <div className={`absolute inset-0 bg-gradient-to-br ${meta.gradient} ${active ? 'opacity-90' : 'opacity-40'} transition-opacity`}></div>
                                        <span className="relative text-sm font-bold tracking-wide">{meta.label}</span>
                                        <span className="relative text-[8px] font-mono tracking-[0.2em] opacity-70">{meta.en}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* 玩法設置 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2">玩法設置</label>
                        <div className="rounded-2xl border border-white/10 bg-white/5 divide-y divide-white/10">
                            {/* 骰子開關 */}
                            <div className="flex items-center justify-between p-4">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium flex items-center gap-1.5"><DiceFive size={16} weight="fill" /> 骰子判定 (D20)</span>
                                    <span className="text-[10px] text-white/40 mt-0.5">{newDiceDisabled ? '已關閉：行動默認直接成功' : '開啟：每次行動自動骰點定成敗'}</span>
                                </div>
                                <button
                                    onClick={() => setNewDiceDisabled(v => !v)}
                                    role="switch"
                                    aria-checked={!newDiceDisabled}
                                    className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${newDiceDisabled ? 'bg-white/15' : 'bg-emerald-500'}`}
                                >
                                    <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${newDiceDisabled ? '' : 'translate-x-6'}`}></span>
                                </button>
                            </div>

                            {/* 歸檔模式 */}
                            <div className="p-4">
                                <div className="flex items-center gap-1.5 mb-2.5">
                                    <span className="text-sm font-medium">歸檔模式</span>
                                    <button onClick={() => setShowArchiveHelp(v => !v)} className="w-4 h-4 rounded-full border border-white/30 text-white/50 text-[10px] leading-none flex items-center justify-center hover:bg-white/10 transition-colors">?</button>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={() => setNewArchiveMode('auto')}
                                        className={`rounded-xl p-2.5 text-left border transition-all active:scale-95 ${newArchiveMode === 'auto' ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-white/5'}`}
                                    >
                                        <div className="text-xs font-bold">自動歸檔</div>
                                        <div className="text-[9px] text-white/40 mt-0.5 leading-snug">滿20條總結，並同步進角色聊天</div>
                                    </button>
                                    <button
                                        onClick={() => setNewArchiveMode('manual')}
                                        className={`rounded-xl p-2.5 text-left border transition-all active:scale-95 ${newArchiveMode === 'manual' ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-white/5'}`}
                                    >
                                        <div className="text-xs font-bold">手動歸檔</div>
                                        <div className="text-[9px] text-white/40 mt-0.5 leading-snug">滿20條總結，但不進角色聊天</div>
                                    </button>
                                </div>
                                {showArchiveHelp && (
                                    <div className="mt-2.5 text-[10px] text-white/50 leading-relaxed bg-black/30 rounded-xl p-3 space-y-1.5 border border-white/10">
                                        <p>兩種模式都會<b className="text-white/70">每滿 20 條劇情自動總結一次</b>，總結會一直保留在遊戲的前情提要裡，GM 也會一直記得。區別只在於：</p>
                                        <p><b className="text-purple-300">自動歸檔</b>：每次總結會<b className="text-white/70">立即同步到參與角色的聊天 App</b>（角色會"記得"和你跑過團）。</p>
                                        <p><b className="text-purple-300">手動歸檔</b>：自動總結<b className="text-white/70">不會</b>打擾角色的聊天，只有你在菜單裡點「歸檔記憶並退出」時，才把整段經歷送進角色聊天。</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* 邀請玩家 */}
                    <div>
                        <label className="text-[11px] font-bold text-white/40 uppercase tracking-wider block mb-2 flex items-center justify-between">
                            <span>邀請隊友</span>
                            {selectedPlayers.size > 0 && <span className="text-purple-300 normal-case font-mono">已選 {selectedPlayers.size} 人</span>}
                        </label>
                        {characters.length === 0 ? (
                            <p className="text-xs text-white/30 py-4 text-center bg-white/5 rounded-xl border border-white/10">還沒有角色，先去創建角色吧</p>
                        ) : (
                            <>
                            {/* 分組篩選（沒建分組時不渲染）：只影響可選項的顯示，不影響已勾選隊友 */}
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark value={playerGroupId} onChange={setPlayerGroupId} className="mb-2.5" />
                            {playerChars.length === 0 ? (
                                <p className="text-xs text-white/30 py-4 text-center bg-white/5 rounded-xl border border-white/10">該分組下沒有角色</p>
                            ) : (
                            <div className="grid grid-cols-4 gap-3">
                                {playerChars.map(c => {
                                    const sel = selectedPlayers.has(c.id);
                                    return (
                                        <div key={c.id} onClick={() => { const s = new Set(selectedPlayers); if(s.has(c.id)) s.delete(c.id); else s.add(c.id); setSelectedPlayers(s); }} className={`flex flex-col items-center p-2 rounded-2xl border cursor-pointer transition-all active:scale-95 ${sel ? 'border-purple-400 bg-purple-500/15' : 'border-white/5 hover:bg-white/5'}`}>
                                            <div className="relative">
                                                <TokenImg value={c.avatar} className={`w-12 h-12 rounded-full object-cover transition-all ${sel ? 'ring-2 ring-purple-400 ring-offset-2 ring-offset-[#0a0a0a]' : 'opacity-80'}`} />
                                                {sel && <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-purple-500 rounded-full flex items-center justify-center border-2 border-[#0a0a0a]"><svg viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 text-white"><path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" /></svg></div>}
                                            </div>
                                            <span className={`text-[9px] mt-2 truncate w-full text-center font-medium ${sel ? 'text-purple-200' : 'text-white/50'}`}>{c.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                            )}
                            </>
                        )}
                    </div>
                </div>

                {/* 底部開始按鈕 */}
                <div className="p-4 pb-[calc(1rem+var(--safe-bottom,0px))] border-t border-white/5 bg-black/40 backdrop-blur-md z-10">
                    <button
                        onClick={handleCreateGame}
                        disabled={isCreating || !canStart}
                        className={`w-full py-3.5 font-bold rounded-2xl shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2 ${canStart ? 'bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-purple-500/30' : 'bg-white/10 text-white/30'}`}
                    >
                        {isCreating ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> 生成序章...</> : <><RocketLaunch size={18} /> 開始冒險</>}
                    </button>
                </div>
            </div>
        );
    }

    // 3. Play View
    if (!activeGame) return null;
    const theme = GAME_THEMES[activeGame.theme];
    const activePlayers = characters.filter(c => activeGame.playerCharIds.includes(c.id));

    // [FIX] Changed from absolute inset-0 to h-full relative to fix overscroll and height layout issues
    return (
        <div className={`h-full w-full relative flex flex-col ${theme.bg} ${theme.text} ${theme.font} transition-colors duration-500 overflow-hidden`}>
            
            {/* Header */}
            <div className={`border-b ${theme.border} shrink-0 bg-opacity-90 backdrop-blur z-20 relative`} style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="flex items-center gap-2">
                        <button onClick={handleLeave} className={`p-2 -ml-2 rounded hover:bg-white/10 active:scale-95 transition-transform`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="flex flex-col mb-0.5">
                            <span className="font-bold text-sm tracking-wide line-clamp-1 max-w-[150px]">{activeGame.title}</span>
                            <div className="flex items-center gap-2">
                                <span className="text-[9px] opacity-60 flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                    {activeGame.status.location}
                                </span>
                                {lastTokenUsage && <span className="text-[8px] opacity-40 font-mono inline-flex items-center gap-0.5" title={`Prompt: ${lastTokenUsage.prompt || '?'} | Completion: ${lastTokenUsage.completion || '?'} | Total session: ${totalTokensUsed}`}><Lightning size={10} weight="fill" />{lastTokenUsage.prompt || '?'}/{lastTokenUsage.completion || '?'} (∑{totalTokensUsed})</span>}
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-1 mb-1">
                        {/* Toggle Party HUD */}
                        <button onClick={() => setShowParty(!showParty)} className={`p-2 rounded hover:bg-white/10 active:scale-95 transition-transform ${showParty ? theme.accent : 'opacity-50'}`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" /></svg>
                        </button>
                        <button onClick={() => { setShowSystemMenu(true); trackEvent('打开跑团系统菜单'); }} className={`p-2 -mr-2 rounded hover:bg-white/10 active:scale-95 transition-transform`}>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" /></svg>
                        </button>
                    </div>
                </div>
            </div>

            {/* --- NEW: Party HUD (Collapsible) --- */}
            {showParty && (
                <div className={`flex gap-4 p-3 overflow-x-auto no-scrollbar border-b ${theme.border} bg-black/20 backdrop-blur-sm z-10 shrink-0 animate-slide-down`}>
                    {/* User Avatar */}
                    <div className="relative group shrink-0">
                        <TokenImg value={userProfile.avatar} className="w-10 h-10 rounded-full border-2 border-white/20 object-cover shadow-sm" />
                        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[8px] px-1.5 rounded-full backdrop-blur-sm whitespace-nowrap">YOU</div>
                    </div>
                    {/* Teammates */}
                    {activePlayers.map(p => (
                        <div key={p.id} className="relative group shrink-0 cursor-pointer active:scale-95 transition-transform">
                            <TokenImg value={p.avatar} className="w-10 h-10 rounded-full border-2 border-white/20 object-cover shadow-sm group-hover:border-white/50 transition-colors" />
                            <div className="absolute inset-0 rounded-full ring-2 ring-transparent group-hover:ring-green-400/50 transition-all"></div>
                            {/* Simple Status Indicator (Green Dot) */}
                            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 rounded-full border-2 border-black/50 shadow-sm animate-pulse"></div>
                        </div>
                    ))}
                </div>
            )}

            {/* Stats HUD */}
            <div className={`px-4 py-2 border-b ${theme.border} bg-black/10 backdrop-blur-sm z-10 shrink-0`}>
                <div className="grid grid-cols-3 gap-2">
                    <div className="flex flex-col items-center bg-red-500/20 rounded p-1 border border-red-500/30">
                        <span className="text-[8px] text-red-300 font-bold uppercase">HP (生命)</span>
                        <span className="text-xs font-mono font-bold text-red-100">{activeGame.status.health || 100}</span>
                    </div>
                    <div
                        onClick={toggleSanityLock}
                        className={`flex flex-col items-center bg-blue-500/20 rounded p-1 border cursor-pointer active:scale-95 transition-all ${sanityLocked ? 'border-blue-400 ring-1 ring-blue-400/50' : 'border-blue-500/30'}`}
                    >
                        <span className="text-[8px] text-blue-300 font-bold uppercase flex items-center gap-1">
                            SAN (理智) {sanityLocked && <LockSimple size={10} weight="fill" className="text-blue-400 inline" />}
                        </span>
                        <span className="text-xs font-mono font-bold text-blue-100">{activeGame.status.sanity || 100}</span>
                    </div>
                    <div className="flex flex-col items-center bg-yellow-500/20 rounded p-1 border border-yellow-500/30">
                        <span className="text-[8px] text-yellow-300 font-bold uppercase">GOLD (金幣)</span>
                        <span className="text-xs font-mono font-bold text-yellow-100">{activeGame.status.gold || 0}</span>
                    </div>
                </div>
                {/* Token Statistics */}
                {lastTokenUsage && (
                    <div className="mt-1.5 flex items-center justify-between bg-white/5 rounded px-2 py-1 border border-white/10">
                        <span className="text-[8px] text-white/40 font-mono inline-flex items-center gap-0.5"><Lightning size={10} weight="fill" /> 上下文: {lastTokenUsage.prompt ?? '?'} | 回覆: {lastTokenUsage.completion ?? '?'} | 本次: {lastTokenUsage.total}</span>
                        <span className="text-[8px] text-white/40 font-mono">∑ {totalTokensUsed}</span>
                    </div>
                )}
            </div>

            {/* Stage / Log Area */}
            <div 
                ref={logsContainerRef} // [FIX] Attach Ref to scrollable container
                className="flex-1 overflow-y-auto p-4 space-y-6 no-scrollbar relative animate-fade-in"
            >
                {/* 已歸檔劇情 (自動總結後摺疊灰顯，不刪除) */}
                {(activeGame.logs.some(l => l.archived) || (activeGame.summaries && activeGame.summaries.length > 0)) && (() => {
                    const archivedLogs = activeGame.logs.filter(l => l.archived);
                    const summaries = activeGame.summaries || [];
                    // 把每段總結與它覆蓋的原文對應起來：優先用 logIds，舊總結回退為按 logCount 順序切分
                    let cursor = 0;
                    const groups = summaries.map((s, si) => {
                        let logs: GameLog[];
                        if (s.logIds && s.logIds.length) {
                            const idset = new Set(s.logIds);
                            logs = archivedLogs.filter(l => idset.has(l.id));
                        } else {
                            logs = archivedLogs.slice(cursor, cursor + s.logCount);
                        }
                        cursor += logs.length;
                        return { summary: s, logs, index: si };
                    });
                    const covered = new Set(groups.flatMap(g => g.logs.map(l => l.id)));
                    const orphanLogs = archivedLogs.filter(l => !covered.has(l.id));

                    const renderLogs = (logs: GameLog[]) => (
                        <div className={`pl-3 border-l-2 ${theme.border} space-y-1.5 mt-2`}>
                            {logs.map((log, li) => (
                                <div key={log.id || li} className="text-sm leading-relaxed break-words" data-game-archived-log={log.id}>
                                    <span className="font-bold opacity-70">{log.role === 'gm' ? 'GM' : (log.speakerName || 'System')}: </span>
                                    <GameMarkdown content={log.content} theme={theme} />
                                </div>
                            ))}
                        </div>
                    );

                    return (
                        <div className="my-2">
                            <button
                                onClick={() => setShowArchived(v => !v)}
                                className={`w-full text-[11px] py-2 px-3 rounded-lg border border-dashed ${theme.border} opacity-60 hover:opacity-100 transition-opacity flex items-center justify-center gap-2 font-mono`}
                            >
                                已歸檔 {archivedLogs.length} 條劇情 · {summaries.length} 段前情提要 {showArchived ? '（點擊摺疊）' : '（點擊展開）'}
                            </button>
                            {showArchived && (
                                <div className="mt-3 space-y-4">
                                    {groups.map(g => {
                                        const open = expandedSummaries.has(g.summary.id);
                                        return (
                                            <div key={g.summary.id} className="space-y-2">
                                                {/* 該段原文（默認摺疊，可展開） */}
                                                <button
                                                    onClick={() => setExpandedSummaries(prev => { const n = new Set(prev); n.has(g.summary.id) ? n.delete(g.summary.id) : n.add(g.summary.id); return n; })}
                                                    className={`w-full text-left text-[10px] font-mono opacity-50 hover:opacity-90 transition-opacity flex items-center gap-1.5`}
                                                >
                                                    <span>{open ? '▾' : '▸'}</span>
                                                    <span>第 {g.index + 1} 段 · 完整原文 {g.logs.length} 條 {open ? '' : '(點擊展開)'}</span>
                                                </button>
                                                {open && <div>{renderLogs(g.logs)}</div>}
                                                {/* 原文下面就是這段的總結 */}
                                                <div className={`p-4 rounded-lg border ${theme.border} ${theme.cardBg} text-xs italic leading-relaxed opacity-80`}>
                                                    <div className="text-[10px] font-bold uppercase tracking-widest mb-1 not-italic opacity-70">前情提要 · 第 {g.index + 1} 段</div>
                                                    <GameMarkdown content={g.summary.content} theme={theme} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {/* 尚未被總結覆蓋的歸檔原文（極少見，做個兜底） */}
                                    {orphanLogs.length > 0 && (
                                        <div className="opacity-50">{renderLogs(orphanLogs)}</div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })()}

                {activeGame.logs.map((log, i) => {
                    if (log.archived) return null; // 歸檔日誌在上方摺疊區塊渲染
                    const isGM = log.role === 'gm';
                    const isSystem = log.role === 'system';
                    const isCharacter = log.role === 'character';
                    const charInfo = isCharacter ? activePlayers.find(p => p.name === log.speakerName) : null;

                    let inner: React.ReactNode;
                    if (isSystem) {
                        inner = (
                            <div className="flex flex-col items-center my-4 animate-fade-in gap-1 group">
                                <span className="text-[10px] opacity-50 border-b border-dashed border-current pb-0.5 font-mono">{log.content}</span>
                                <button onClick={() => handleRollbackLog(i)} className="text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">回退到此處</button>
                            </div>
                        );
                    } else if (isGM) {
                        inner = (
                            <div className="animate-fade-in my-4 group relative">
                                <div className={`p-5 rounded-lg border-2 ${theme.border} ${theme.cardBg} shadow-sm relative mx-auto w-full text-sm`}>
                                    <div className="absolute -top-3 left-4 bg-inherit px-2 text-[10px] font-bold uppercase tracking-widest opacity-80 border border-inherit rounded">Game Master</div>
                                    <GameMarkdown content={log.content} theme={theme} customStyle={uiSettings} />
                                </div>
                                <button onClick={() => handleRollbackLog(i)} className="absolute top-2 right-2 text-[9px] bg-red-900/50 text-red-200 px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-800">Rollback</button>
                            </div>
                        );
                    } else if (isCharacter && charInfo) {
                        inner = (
                            <div className="flex gap-3 animate-slide-up group relative">
                                <TokenImg value={charInfo.avatar} className={`w-10 h-10 rounded-full object-cover border ${theme.border} shrink-0 mt-1`} />
                                <div className="flex flex-col max-w-[85%]">
                                    <span className="text-[10px] font-bold opacity-60 mb-1 ml-1">{charInfo.name}</span>
                                    <div className={`px-4 py-2 rounded-2xl rounded-tl-none text-sm ${theme.cardBg} border ${theme.border} shadow-sm relative`}>
                                        <GameMarkdown content={log.content} theme={theme} customStyle={uiSettings} />
                                    </div>
                                    <button onClick={() => handleRollbackLog(i)} className="self-start mt-1 text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">回退</button>
                                </div>
                            </div>
                        );
                    } else {
                        // Player (User) Log
                        inner = (
                            <div className="flex flex-col items-end animate-slide-up group relative">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`text-[10px] font-bold opacity-60`}>{log.speakerName}</span>
                                    {log.diceRoll && (
                                        <span className="text-[10px] bg-white/20 px-1.5 rounded text-yellow-500 font-mono">
                                            <DiceFive size={12} weight="fill" className="inline" /> {log.diceRoll.result}
                                        </span>
                                    )}
                                </div>
                                <div className={`px-4 py-2 rounded-2xl rounded-tr-none text-sm bg-orange-600 text-white shadow-md max-w-[85%]`}>
                                    {log.content}
                                </div>
                                <button onClick={() => handleRollbackLog(i)} className="mt-1 text-[9px] text-red-400 opacity-0 group-hover:opacity-100 transition-opacity hover:underline">回退</button>
                            </div>
                        );
                    }

                    const selected = selectedLogIds.has(log.id);
                    return (
                        <div
                            key={log.id || i}
                            onPointerDown={() => startLogPress(log.id)}
                            onPointerUp={cancelLogPress}
                            onPointerLeave={cancelLogPress}
                            onPointerCancel={cancelLogPress}
                            onClick={() => { if (selectMode) toggleSelectLog(log.id); }}
                            onContextMenu={(e) => { if (selectMode) e.preventDefault(); }}
                            className={`relative ${selectMode ? `cursor-pointer rounded-xl px-1 transition-all ${selected ? 'ring-2 ring-purple-400 bg-purple-500/10' : 'hover:bg-white/[0.03]'}` : ''}`}
                        >
                            {selectMode && (
                                <div className={`absolute left-0 top-1/2 -translate-y-1/2 z-30 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-purple-500 border-purple-400' : 'border-white/40 bg-black/40'}`}>
                                    {selected && <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-white"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.79 6.8-6.79a1 1 0 0 1 1.4 0Z" clipRule="evenodd"/></svg>}
                                </div>
                            )}
                            <div className={selectMode ? 'pointer-events-none select-none pl-5' : ''}>
                                {inner}
                            </div>
                        </div>
                    );
                })}
                {isTyping && <div className="text-xs opacity-50 animate-pulse pl-2 font-mono">GM 正在計算結果...</div>}
                
                {/* [FIX] Removed logsEndRef usage */}
            </div>

            {/* 多選轉發操作欄 */}
            {selectMode && (
                <div className={`p-4 pb-[calc(1rem+var(--safe-bottom,0px))] border-t ${theme.border} bg-black/50 backdrop-blur shrink-0 z-20 flex items-center gap-3 animate-slide-down`}>
                    <button onClick={exitSelectMode} className="px-4 h-11 rounded-xl border border-white/15 text-sm font-bold text-white/70 active:scale-95 transition-transform">取消</button>
                    <span className="text-xs text-white/50 flex-1 text-center">已選 {selectedLogIds.size} 條 · 長按可多選劇情</span>
                    <button
                        onClick={handleForwardToChat}
                        disabled={selectedLogIds.size === 0 || isForwarding}
                        className="px-5 h-11 rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-bold active:scale-95 transition-transform disabled:opacity-40 flex items-center gap-2 shadow-lg shadow-purple-500/20"
                    >
                        {isForwarding ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> 轉發中...</> : '轉發到聊天'}
                    </button>
                </div>
            )}

            {/* Controls */}
            {/* 底部 pb-[calc(1rem+var(--safe-bottom,0px))] 讓內容避開 home 條（--safe-bottom 見 index.html，iOS PWA 下有 JS probe 兜底）*/}
            <div className={`p-4 pb-[calc(1rem+var(--safe-bottom,0px))] border-t ${theme.border} bg-opacity-90 backdrop-blur shrink-0 z-20 transition-colors duration-500 ${selectMode ? 'hidden' : ''}`}>
                
                {/* AI Suggested Options Area */}
                {activeGame.suggestedActions && activeGame.suggestedActions.length > 0 && !isTyping && (
                    <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar pb-1">
                        {activeGame.suggestedActions.map((opt, idx) => {
                            let styleClass = theme.optionNormal;
                            if (opt.type === 'chaotic') styleClass = theme.optionChaotic;
                            if (opt.type === 'evil') styleClass = theme.optionEvil;
                            
                            return (
                                <button 
                                    key={idx} 
                                    onClick={() => handleAction(opt.label)}
                                    className={`flex-1 min-w-[100px] text-[10px] p-2 rounded-lg border ${styleClass} hover:opacity-80 active:scale-95 transition-all text-left leading-tight shadow-sm`}
                                >
                                    <span className="block font-bold opacity-70 uppercase text-[8px] mb-0.5 tracking-wider">{opt.type}</span>
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* Collapsible Action Toolbar — 快捷動作 (執行時自動骰 D20) */}
                {showTools && (
                    <div className="flex gap-2 mb-3 animate-fade-in items-center">
                        <span className={`text-[10px] opacity-50 flex items-center gap-1 shrink-0 ${activeGame.diceDisabled ? 'opacity-30 line-through' : theme.accent}`}>
                            <DiceFive size={16} weight="fill" /> {activeGame.diceDisabled ? '骰子已關' : '自動骰點'}
                            {!activeGame.diceDisabled && lastRoll !== null && <span className="font-mono font-bold no-underline">上次 {lastRoll}</span>}
                        </span>
                        {['調查', '攻擊', '交涉', '潛行', '逃跑'].map(action => (
                            <button key={action} disabled={isTyping} onClick={() => handleAction(action)} className={`flex-1 px-3 py-2 rounded border ${theme.border} hover:bg-white/10 text-xs font-bold transition-colors active:scale-95 disabled:opacity-40`}>{action}</button>
                        ))}
                    </div>
                )}

                <div className="flex gap-2 items-end">
                    {/* Toggle Tools Button */}
                    <button 
                        onClick={() => setShowTools(!showTools)}
                        className={`p-3 h-12 rounded-xl border ${theme.border} hover:bg-white/10 active:scale-95 transition-transform flex items-center justify-center ${showTools ? 'bg-white/20' : ''}`}
                    >
                        <Toolbox size={22} />
                    </button>

                    {/* Reroll Button (Context Sensitive) */}
                    {!isTyping && activeGame.logs.length > 0 && (
                        <button 
                            onClick={handleReroll}
                            className={`p-3 h-12 rounded-xl border ${theme.border} hover:bg-white/10 active:scale-95 transition-transform flex items-center justify-center`}
                            title="重新生成上一輪"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 opacity-70"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        </button>
                    )}

                    <textarea 
                        value={userInput} 
                        onChange={e => setUserInput(e.target.value)} 
                        // Removed onKeyDown Enter submission
                        placeholder="你打算做什麼..." 
                        className={`flex-1 bg-black/20 border ${theme.border} rounded-xl px-3 py-3 outline-none text-sm placeholder-opacity-30 placeholder-current resize-none h-12 leading-tight focus:bg-black/40 transition-colors`}
                    />
                    <button onClick={() => handleAction(userInput)} className={`${theme.accent} font-bold text-sm px-4 h-12 bg-white/10 rounded-xl hover:bg-white/20 active:scale-95 transition-all flex items-center justify-center`}>
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" /></svg>
                    </button>
                </div>
            </div>

            {/* System Menu Modal */}
            <Modal isOpen={showSystemMenu} title="系統菜單" onClose={() => setShowSystemMenu(false)}>
                <div className="space-y-4">
                    {/* UI Settings */}
                    <div className="bg-slate-100 p-3 rounded-xl">
                        <label className="text-xs text-slate-500 font-bold mb-3 block border-b border-slate-200 pb-1">閱讀設置 (Display)</label>
                        <div className="space-y-3">
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-8">字號</span>
                                <input 
                                    type="range" 
                                    min="12" 
                                    max="24" 
                                    step="1"
                                    value={uiSettings.fontSize} 
                                    onChange={e => setUiSettings({...uiSettings, fontSize: parseInt(e.target.value)})} 
                                    className="flex-1 h-1.5 bg-slate-300 rounded-lg appearance-none cursor-pointer accent-orange-500" 
                                />
                                <span className="text-xs font-mono text-slate-600 w-6 text-right">{uiSettings.fontSize}</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-xs text-slate-400 w-8">顏色</span>
                                <input 
                                    type="color" 
                                    value={uiSettings.color || '#e5e5e5'} 
                                    onChange={e => setUiSettings({...uiSettings, color: e.target.value})} 
                                    className="w-full h-8 rounded cursor-pointer bg-white border border-slate-200 p-0.5" 
                                />
                            </div>
                            <button onClick={() => { setUiSettings({ fontSize: 14, color: '' }); trackEvent('恢复默认阅读外观'); }} className="w-full py-1.5 bg-white border border-slate-200 text-slate-500 text-xs rounded-lg active:scale-95 transition-transform">恢復默認</button>
                        </div>
                    </div>

                    {/* 玩法設置 */}
                    <div className="bg-slate-100 p-3 rounded-xl">
                        <label className="text-xs text-slate-500 font-bold mb-3 block border-b border-slate-200 pb-1">玩法設置 (Gameplay)</label>
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col">
                                <span className="text-sm text-slate-700 font-medium flex items-center gap-1.5"><DiceFive size={16} weight="fill" /> 骰子判定 (D20)</span>
                                <span className="text-[10px] text-slate-400 mt-0.5">關閉後，每次行動不再自動骰點</span>
                            </div>
                            <button
                                onClick={toggleDice}
                                role="switch"
                                aria-checked={!activeGame.diceDisabled}
                                className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${activeGame.diceDisabled ? 'bg-slate-300' : 'bg-emerald-500'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${activeGame.diceDisabled ? '' : 'translate-x-6'}`}></span>
                            </button>
                        </div>
                    </div>

                    <button onClick={handleArchiveAndQuit} className="w-full py-3 bg-emerald-500 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                        <FloppyDisk size={18} /> 歸檔記憶並退出
                    </button>
                    <button onClick={handleRestart} className="w-full py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg flex items-center justify-center gap-2">
                        <ArrowsClockwise size={18} /> 重置當前遊戲
                    </button>
                    <button onClick={handleLeave} className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl flex items-center justify-center gap-2">
                        <DoorOpen size={18} /> 暫時離開 (不歸檔)
                    </button>
                </div>
            </Modal>

            {/* Delete Save Confirm Modal */}
            <Modal isOpen={!!deleteConfirmId} title="刪除存檔" onClose={() => setDeleteConfirmId(null)} footer={
                <div className="flex gap-3 w-full">
                    <button onClick={() => setDeleteConfirmId(null)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                    <button onClick={confirmDeleteGame} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">刪除</button>
                </div>
            }>
                <p className="text-sm text-slate-600 text-center py-4">確定要刪除這個存檔嗎？<br/><span className="text-xs text-red-400 mt-1 block">此操作不可恢復。</span></p>
            </Modal>

            {/* Archive Overlay */}
            {isArchiving && (
                <div className="absolute inset-0 bg-black/80 z-50 flex items-center justify-center text-white flex-col gap-4 animate-fade-in">
                    <div className="w-8 h-8 border-4 border-orange-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs tracking-widest font-mono">正在傳遞記憶...</span>
                </div>
            )}

            {/* Auto-Summary Overlay (每 20 條自動總結的全屏反饋) */}
            {isSummarizing && (
                <div className="absolute inset-0 bg-black/85 z-50 flex items-center justify-center text-white flex-col gap-5 animate-fade-in px-8 text-center">
                    <div className="w-10 h-10 border-4 border-purple-400 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-sm tracking-widest font-bold">正在總結前文內容…</span>
                    <span className="text-[11px] opacity-50 font-mono leading-relaxed">歸檔劇情 · 提煉起因經過結果 · 記錄人物關係變化</span>
                </div>
            )}
        </div>
    );
};

export default GameApp;
