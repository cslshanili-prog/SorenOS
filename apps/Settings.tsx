
import { useFirstUseGuideStep } from '../utils/firstUseGuide';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { Capacitor } from '@capacitor/core';
import { extractContent, safeResponseJson } from '../utils/safeApi';
import { extractModelIds, normalizeModelIds } from '../utils/modelList';
import { shareOrDownloadBlob } from '../utils/shareExport';
import { bucketRetryCount, isAnalyticsConfigured, isAnalyticsEnabled, setAnalyticsEnabled, trackEvent } from '../utils/analytics';
import Modal from '../components/os/Modal';
import ImageGenSettingsPanel from '../components/settings/ImageGenSettingsPanel';
import { NotionManager, FeishuManager, RealtimeContextManager, fetchOwmWeather, fetchOpenMeteoWeather } from '../utils/realtimeContext';
import { XhsMcpClient } from '../utils/xhsMcpClient';
import { resolveXhsDeploymentMode } from '../utils/xhsMcpConfig';
import { getMcdToken, setMcdToken as saveMcdToken, isMcdEnabled, setMcdEnabled as saveMcdEnabled, testMcdConnection, resetMcdSession } from '../utils/mcdMcpClient';
import { getLuckinToken, setLuckinToken as saveLuckinToken, isLuckinEnabled, setLuckinEnabled as saveLuckinEnabled, testLuckinConnection, resetLuckinSession } from '../utils/luckinMcpClient';
import { consumeProxyWorkerSettingsFocus, getProxyWorkerUrl, setProxyWorkerUrl, DEFAULT_PROXY_WORKER } from '../utils/proxyWorker';
import { VOICE_ACTING_GUIDE } from '../utils/minimaxTts';
import { FISH_VOICE_ACTING_GUIDE } from '../utils/fishAudioTts';
import {
    DEFAULT_ELEVENLABS_MODEL,
    ELEVENLABS_MODEL_OPTIONS,
    getElevenLabsVoiceActingGuide,
} from '../utils/elevenLabsTts';
import { DATE_VOICE_GUIDE } from '../utils/datePrompts';
import { Sun, Newspaper, NotePencil, Notebook, Book, ForkKnife, Coffee, PlugsConnected } from '@phosphor-icons/react';
import { loadMcpServers, saveMcpServers, createMcpServer, testMcpConnection, resetMcpSession, getMcpUseNativeTools, setMcpUseNativeTools, type McpServerConfig } from '../utils/mcpClient';
import { loadPushConfig, savePushConfig, registerScheduleOnWorker, startHeartbeat, stopHeartbeat, isPushConfigAvailable, ensureSubscribed, sendTestPush, getPushDiagnostics, resetSubscription, deepResetSubscription, type PushDiagnostics } from '../utils/proactivePushConfig';
import { ProactiveChat } from '../utils/proactiveChat';
import { PushVapidSettingsModal } from '../components/settings/PushVapidSettingsModal';
import PushSubscriptionPanel from '../components/settings/PushSubscriptionPanel';
import ActiveMsgGlobalSettingsModal from '../components/settings/ActiveMsgGlobalSettingsModal';
import { syncAmsgLlmCredentials, syncAmsgToolConfig, syncAmsgToolConfigAndPrompts } from '../utils/amsgStateSync';
import { ActiveMsgClient } from '../utils/activeMsgClient';
import VersionInfo from '../components/settings/VersionInfo';
import { isPushVapidReady } from '../utils/pushVapid';
import ApiCallLogModal from '../components/settings/ApiCallLogModal';
import StorageUsagePanel from '../components/settings/StorageUsagePanel';
import McpConnectionConsole from '../components/settings/McpConnectionConsole';
import { DB } from '../utils/db';
import { getBackupReminderState, setBackupReminderIntervalDays, daysSinceLastBackup, BACKUP_REMINDER_MIN_DAYS, BACKUP_REMINDER_MAX_DAYS } from '../utils/backupReminder';
import {
    createAvatarModelBackup,
    getAvatarModelBackupInventory,
    restoreAvatarModelBackup,
    type AvatarModelBackupInventory,
    type AvatarModelBackupProgress,
} from '../utils/avatarModelBackup';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from '../utils/apiConfigNormalize';
import { configFromPreset, findActivePresetId, type PresetSwitchPatch } from '../utils/apiPresetSwitch';
import type { APIConfig, TtsProvider } from '../types';
import { describeImageWithVisionApi, VISION_API_TEST_IMAGE_DATA_URL, visionApiConfigFromPreset } from '../utils/visionApi';
import {
    FIRECRAWL_API_KEYS_URL,
    getFirecrawlApiKey,
    getFirecrawlCreditUsage,
    setFirecrawlApiKey,
    type FirecrawlCreditUsage,
} from '../utils/firecrawl';

// hot_news（news.orz.ai）可選熱榜平台。key 必須與 API 的 ?platform= 完全一致。
const HOTNEWS_PLATFORM_OPTIONS: { key: string; label: string }[] = [
    { key: 'weibo', label: '微博' },
    { key: 'zhihu', label: '知乎' },
    { key: 'baidu', label: '百度' },
    { key: 'bilibili', label: 'B站' },
    { key: 'douyin', label: '抖音' },
    { key: 'jinritoutiao', label: '今日頭條' },
    { key: 'tieba', label: '貼吧' },
    { key: 'hupu', label: '虎撲' },
    { key: 'douban', label: '豆瓣' },
    { key: 'tskr', label: '36氪' },
    { key: 'juejin', label: '掘金' },
    { key: 'sspai', label: '少數派' },
    { key: 'vtex', label: 'V2EX' },
    { key: 'github', label: 'GitHub' },
    { key: 'hackernews', label: 'Hacker News' },
    { key: 'sina_finance', label: '新浪財經' },
    { key: 'eastmoney', label: '東方財富' },
    { key: 'xueqiu', label: '雪球' },
    { key: 'cls', label: '財聯社' },
    { key: 'tenxunwang', label: '騰訊網' },
];

// 「主動消息 Push 加速」面板入口開關。底層邏輯（心跳、訂閱、診斷）全部保留，
// 這裡設為 false 只是把設置頁裡的入口隱藏掉，想恢復改回 true 即可。
const SHOW_PROACTIVE_PUSH_ACCEL_UI = false;
// Firecrawl「方舟計劃」：實現、額度檢測和抓取降級鏈全部保留，默認不向用戶展示配置入口。
// 需要重新啟用時只改為 true。
const SHOW_FIRECRAWL_ARK_UI = false;
const VISION_MODEL_LIST_STORAGE_KEY = 'os_vision_available_models';

const readStoredVisionModels = (): string[] => {
    try {
        return normalizeModelIds(JSON.parse(localStorage.getItem(VISION_MODEL_LIST_STORAGE_KEY) || '[]'));
    } catch {
        return [];
    }
};

const buildModelPickerView = (models: unknown[], filter: string) => {
    const q = filter.trim().toLowerCase();
    const safeModels = normalizeModelIds(models);
    const filtered = q ? safeModels.filter(model => model.toLowerCase().includes(q)) : safeModels;
    let commonPrefix = '';
    if (filtered.length >= 2) {
        let prefix = filtered[0];
        for (let index = 1; index < filtered.length; index += 1) {
            const candidate = filtered[index];
            let cursor = 0;
            while (cursor < prefix.length && cursor < candidate.length && prefix[cursor] === candidate[cursor]) cursor += 1;
            prefix = prefix.slice(0, cursor);
            if (!prefix) break;
        }
        const cut = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('-'));
        if (cut > 3) prefix = prefix.slice(0, cut + 1);
        if (prefix.length >= 4) commonPrefix = prefix;
    }
    return { filtered, commonPrefix };
};

const DiagRow: React.FC<{ label: string; value: string; bad?: boolean }> = ({ label, value, bad }) => (
    <div className="flex items-start justify-between gap-3">
        <span className="text-slate-500 shrink-0">{label}</span>
        <span className={`text-right ${bad ? 'text-rose-600 font-medium' : 'text-slate-700'}`}>{value}</span>
    </div>
);

// 用戶版 MCP 教程（自包含，寫給用戶和他們的 AI 助手看的）。靜態部署的站點
// 看不到倉庫內文檔，所以幫助彈窗只能跳 GitHub 的 blob 頁。
const MCP_USER_GUIDE_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/docs/mcp-user-guide.md';
const PROXY_WORKER_SOURCE_URL = 'https://github.com/qegj567-cloud/SullyOS/blob/master/worker/index.js';

const formatBackupBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
};

/**
 * 設置大板塊的摺疊外殼：默認收起，標題行常顯、點擊開合；
 * actions 放右側動作（配置按鈕 / 狀態 chip / 問號），點擊不觸發開合。
 */
export const SettingsSection: React.FC<{
    icon: React.ReactNode;
    title: string;
    badge?: React.ReactNode;
    actions?: React.ReactNode;
    sectionProps?: Record<string, any>;
    children: React.ReactNode;
}> = ({ icon, title, badge, actions, sectionProps, children }) => {
    const guideStep = useFirstUseGuideStep();
    const [open, setOpen] = useState(() => title === 'API 配置' && guideStep === 0);
    useEffect(() => {
        const reveal = () => { if (title === 'API 配置' && guideStep === 0) setOpen(true); };
        reveal();
        window.addEventListener('sully:guide-navigate', reveal);
        return () => window.removeEventListener('sully:guide-navigate', reveal);
    }, [guideStep, title]);
    return (
        <section {...sectionProps} className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
            <div className={`flex items-center justify-between gap-2 ${open ? 'mb-4' : ''}`}>
                <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                    {icon}
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">{title}</h2>
                    {badge}
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                </button>
                {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
            </div>
            {open && children}
        </section>
    );
};

let mcpToolConfigSyncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMcpToolConfigSync: (() => void) | null = null;

const runMcpToolConfigSync = () => {
    const sync = pendingMcpToolConfigSync;
    mcpToolConfigSyncTimer = null;
    pendingMcpToolConfigSync = null;
    // 上傳本身的失敗重試與底帳在 syncAmsgToolConfig 裡（見 amsgStateSync），這兒只管節流。
    sync?.();
};

/**
 * MCP 卡片沒有「保存」按鈕，改一個字就落盤一次；直接每次都上雲就變成一次按鍵一個請求。
 * 攢到停手 800ms 再傳一次，中途繼續改就順延。
 */
const scheduleMcpToolConfigSync = (sync: () => void) => {
    pendingMcpToolConfigSync = sync;
    if (mcpToolConfigSyncTimer) clearTimeout(mcpToolConfigSyncTimer);
    mcpToolConfigSyncTimer = setTimeout(runMcpToolConfigSync, 800);
};

/** 關掉 MCP 設置就別讓那 800ms 繼續吊著了，攢著的改動當場傳上去。 */
const flushMcpToolConfigSync = () => {
    if (!mcpToolConfigSyncTimer) return;
    clearTimeout(mcpToolConfigSyncTimer);
    runMcpToolConfigSync();
};

/**
 * 舊版通用 MCP 管理卡片。保留一小段遷移期，實際入口已切到新版 MCP 管理面板。
 * 配置存 localStorage（utils/mcpClient），啟用且發現過工具的服務器會在聊天裡
 * 以 function-calling 注入，詳見 docs/mcp-client.md。
 */
const McpServersCard: React.FC<{
    addToast: (msg: string, type?: any) => void;
    /** 服務器清單或「原生 tools」開關變了 → 讓主動消息那邊把新配置重傳上雲 */
    onMcpConfigChanged?: () => void;
}> = ({ addToast, onMcpConfigChanged }) => {
    const { characters, groups } = useOS();
    const [servers, setServers] = useState<McpServerConfig[]>(() => loadMcpServers());
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testStatus, setTestStatus] = useState<Record<string, string>>({});
    const [useNativeTools, setUseNativeToolsState] = useState<boolean>(() => getMcpUseNativeTools());

    const persist = (next: McpServerConfig[]) => {
        setServers(next);
        saveMcpServers(next);
        onMcpConfigChanged?.();
    };

    const update = (id: string, patch: Partial<McpServerConfig>) => {
        persist(servers.map(s => s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
        // URL / 鑑權頭 / 代理變了，舊 session 不能再用
        if (patch.url !== undefined || patch.token !== undefined || patch.customHeaders !== undefined || patch.proxyUrl !== undefined || patch.proxyKey !== undefined) {
            resetMcpSession(id);
        }
    };

    const addServer = () => {
        const s = createMcpServer(`MCP 服務器 ${servers.length + 1}`, '');
        persist([...servers, s]);
        setExpandedId(s.id);
    };

    const removeServer = (id: string) => {
        resetMcpSession(id);
        persist(servers.filter(s => s.id !== id));
    };

    const discover = async (server: McpServerConfig) => {
        if (!server.url.trim()) { addToast('請先填寫服務器 URL', 'error'); return; }
        setTestingId(server.id);
        setTestStatus(prev => ({ ...prev, [server.id]: '' }));
        try {
            const r = await testMcpConnection(server);
            setTestStatus(prev => ({ ...prev, [server.id]: r.ok ? `✅ ${r.message}` : `❌ ${r.message}` }));
            // 失敗原因只上報歸類後的固定枚舉：原始報錯裡可能帶服務器地址和返回內容，不能外發
            if (r.ok) {
                trackEvent('测试 MCP 服务器连接', { result: r.tools?.length ? 'connected' : 'connected-no-tools' });
            } else {
                const msg = r.message || '';
                const failureKind =
                    /超[时時]/.test(msg) ? 'timeout'
                    : /[鉴鑑][权權]失[败敗]/.test(msg) ? 'auth-failed'
                    : /[请請]求失[败敗]/.test(msg) ? 'fetch-failed'
                    : /MCP HTTP/.test(msg) ? 'http-error'
                    : 'other';
                trackEvent('测试 MCP 服务器连接', { result: 'failed', failureKind });
            }
            if (r.ok && r.tools) {
                update(server.id, { tools: r.tools });
            }
        } finally {
            setTestingId(null);
        }
    };

    return (
        <div className="bg-violet-50/60 p-4 rounded-2xl space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <PlugsConnected size={20} weight="fill" className="text-violet-600" />
                    <span className="text-sm font-bold text-violet-700">MCP 工具服務器</span>
                    <span className="text-[9px] bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded-full">通用</span>
                </div>
                <button onClick={addServer} className="text-[11px] font-bold text-violet-600 bg-violet-100 px-2.5 py-1 rounded-lg active:scale-95 transition-transform">+ 添加</button>
            </div>
            <p className="text-[10px] text-violet-700/70 leading-relaxed">
                接入任意標準 MCP 服務器（Streamable HTTP）：填 URL → 測試連接 → 打開開關，角色就能在聊天裡調用這些工具。
                被瀏覽器 CORS 攔住時配「代理 URL」：本地跑 <code className="bg-violet-100/80 px-1 rounded">node scripts/mcp-proxy.mjs</code>，或把 <code className="bg-violet-100/80 px-1 rounded">worker/mcp-proxy</code> 部署到你自己的 Cloudflare 帳號。配置只存本機，詳見 docs/mcp-client.md。
            </p>
            <div className="flex items-center justify-between gap-3 bg-white/70 border border-violet-100 rounded-xl px-3 py-2.5">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <div className="text-xs font-bold text-slate-700">原生 tools 工具調用</div>
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] font-bold text-emerald-700">推薦</span>
                    </div>
                    <p className="text-[10px] text-slate-400 mt-0.5 leading-relaxed">
                        開啟後發送標準 tools，調用更穩定、參數更可靠。只有模型或中轉明確不支持 function calling 時才關閉，退回文字兼容模式。
                    </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                    <input type="checkbox" checked={useNativeTools} onChange={e => {
                        const next = e.target.checked;
                        setUseNativeToolsState(next);
                        setMcpUseNativeTools(next);
                        onMcpConfigChanged?.();
                        trackEvent('切换原生工具调用', { state: next ? 'on' : 'off' });
                    }} className="sr-only peer" />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                </label>
            </div>
            <div className="border-l-2 border-violet-300 pl-3 text-[10px] leading-relaxed text-violet-700/80">
                <p>
                    <b>簡單說：</b>tools / function calling 是聊天模型的一項能力，讓角色用標準格式告訴 API“要調用哪個工具、傳什麼參數”，系統才能真正執行；不支持時，模型可能只會把工具調用寫成普通聊天文字。
                </p>
                <p className="mt-1.5 text-violet-600/75">
                    不知道自己的模型或中轉是否支持？請詢問你所使用的 API 負責人或售賣方，確認是否支持 <b>tools / function calling（函數調用）</b>。拿不準時保持開啟；只有對方明確說不支持，或請求出現 tools / function calling 報錯時再關閉。
                </p>
            </div>
            {servers.map(server => (
                <div key={server.id} className="bg-white/70 border border-violet-100 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                        <button className="flex-1 text-left min-w-0" onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}>
                            <div className="text-xs font-bold text-slate-700 truncate">{server.name || '(未命名)'}</div>
                            <div className="text-[10px] text-slate-400 truncate">
                                {server.url || '未填 URL'}{server.tools?.length ? ` · ${server.tools.length} 個工具` : ' · 未獲取工具'}{server.charIds?.length ? ` · 綁定 ${server.charIds.length} 個聊天` : ''}
                            </div>
                        </button>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                            <input type="checkbox" checked={server.enabled} onChange={e => {
                                if (e.target.checked && !(server.tools?.length)) {
                                    addToast('先點「測試連接」拿到工具清單再啟用', 'error');
                                    trackEvent('启用未测通的 MCP 服务器被拦下');
                                    return;
                                }
                                update(server.id, { enabled: e.target.checked });
                            }} className="sr-only peer" />
                            <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500"></div>
                        </label>
                    </div>
                    {expandedId === server.id && (
                        <div className="space-y-2 pt-1">
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">名稱</label>
                                <input type="text" value={server.name} onChange={e => update(server.id, { name: e.target.value })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm" placeholder="例如：Notion" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">服務器 URL</label>
                                <input type="text" value={server.url} onChange={e => update(server.id, { url: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="https://mcp.example.com/mcp" />
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Bearer Token（可選）</label>
                                <input type="password" value={server.token || ''} onChange={e => update(server.id, { token: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="服務器要求鑑權時填" />
                            </div>
                            <div>
                                <div className="flex items-center justify-between gap-2 mb-1">
                                    <label className="text-[10px] font-bold text-slate-400 uppercase">自定義請求頭（可選）</label>
                                    <button
                                        type="button"
                                        onClick={() => update(server.id, { customHeaders: [...(server.customHeaders || []), { name: '', value: '' }] })}
                                        className="text-[10px] font-bold text-violet-600"
                                    >+ 添加請求頭</button>
                                </div>
                                {(server.customHeaders || []).map((header, index) => (
                                    <div key={index} className="flex gap-1.5 mb-1.5">
                                        <input
                                            type="text"
                                            value={header.name}
                                            onChange={e => update(server.id, { customHeaders: (server.customHeaders || []).map((item, i) => i === index ? { ...item, name: e.target.value } : item) })}
                                            className="min-w-0 flex-[0.9] bg-white/80 border border-violet-200 rounded-xl px-2.5 py-2 text-xs font-mono"
                                            placeholder="XBY-APIKEY"
                                            aria-label={`自定義請求頭 ${index + 1} 名稱`}
                                        />
                                        <input
                                            type="password"
                                            value={header.value}
                                            onChange={e => update(server.id, { customHeaders: (server.customHeaders || []).map((item, i) => i === index ? { ...item, value: e.target.value } : item) })}
                                            className="min-w-0 flex-1 bg-white/80 border border-violet-200 rounded-xl px-2.5 py-2 text-xs font-mono"
                                            placeholder="請求頭的值"
                                            aria-label={`自定義請求頭 ${index + 1} 值`}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => update(server.id, { customHeaders: (server.customHeaders || []).filter((_, i) => i !== index) })}
                                            className="w-9 shrink-0 rounded-xl bg-red-50 text-red-500 text-base"
                                            aria-label={`刪除自定義請求頭 ${index + 1}`}
                                        >×</button>
                                    </div>
                                ))}
                                <p className="text-[10px] text-slate-400 leading-relaxed">
                                    用於 X-API-Key、XBY-APIKEY 等非 Bearer 鑑權；名稱或值留空的行不會發送。
                                </p>
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">代理 URL（可選，留空 = 直連）</label>
                                <input type="text" value={server.proxyUrl || ''} onChange={e => update(server.id, { proxyUrl: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="http://localhost:18061 或你的 Worker 地址" />
                            </div>
                            {(server.proxyUrl || '').trim() && (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">代理密鑰（可選，自部署 Worker 的 PROXY_KEY）</label>
                                    <input type="password" value={server.proxyKey || ''} onChange={e => update(server.id, { proxyKey: e.target.value.trim() })} className="w-full bg-white/80 border border-violet-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="沒設就留空" />
                                </div>
                            )}
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">可用聊天</label>
                                <div className="flex flex-wrap gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => update(server.id, { charIds: [] })}
                                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${!server.charIds?.length ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                    >通用（所有私聊和群聊）</button>
                                </div>
                                {characters.length > 0 && <div className="text-[10px] text-slate-400 mt-2 mb-1">角色</div>}
                                <div className="flex flex-wrap gap-1.5">
                                    {characters.map(c => {
                                        const bound = !!server.charIds?.includes(c.id);
                                        return (
                                            <button
                                                key={c.id}
                                                type="button"
                                                onClick={() => {
                                                    const cur = server.charIds || [];
                                                    update(server.id, { charIds: bound ? cur.filter(id => id !== c.id) : [...cur, c.id] });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${bound ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                            >{c.name}</button>
                                        );
                                    })}
                                </div>
                                {groups.length > 0 && <div className="text-[10px] text-slate-400 mt-2 mb-1">群聊</div>}
                                <div className="flex flex-wrap gap-1.5">
                                    {groups.map(group => {
                                        const bound = !!server.charIds?.includes(group.id);
                                        return (
                                            <button
                                                key={group.id}
                                                type="button"
                                                onClick={() => {
                                                    const cur = server.charIds || [];
                                                    update(server.id, { charIds: bound ? cur.filter(id => id !== group.id) : [...cur, group.id] });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${bound ? 'bg-violet-500 text-white' : 'bg-white/80 border border-violet-200 text-slate-500'}`}
                                            >{group.name}</button>
                                        );
                                    })}
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                    通用 = 所有私聊和群聊都能用；綁定後只有選中的角色或群聊能看到這批工具。
                                </p>
                                {!!server.charIds?.length && server.charIds.some(id => !characters.some(c => c.id === id) && !groups.some(g => g.id === id)) && (
                                    <p className="text-[10px] text-amber-600 mt-1">
                                        ⚠️ 綁定裡有已刪除的角色或群聊，對應綁定不再生效，可重新點選清理。
                                    </p>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => discover(server)} disabled={testingId === server.id} className="flex-1 py-2 bg-violet-100 text-violet-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                                    {testingId === server.id ? '測試中…' : '測試連接'}
                                </button>
                                <button onClick={() => removeServer(server.id)} className="px-4 py-2 bg-red-50 text-red-500 text-xs font-bold rounded-xl active:scale-95 transition-transform">刪除</button>
                            </div>
                            {testStatus[server.id] && (
                                <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${testStatus[server.id].startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                                    {testStatus[server.id]}
                                </div>
                            )}
                            {!!server.tools?.length && (
                                <p className="text-[10px] text-slate-400 leading-relaxed">
                                    工具：{server.tools.map(t => t.name).join('、')}
                                </p>
                            )}
                        </div>
                    )}
                </div>
            ))}
            <p className="text-[10px] text-violet-700/60 leading-relaxed bg-violet-100/40 rounded-lg px-2 py-1.5">
                開啟 MCP 工具後，聊天會改用本地工具請求，本輪思考鏈會讓位給工具調用；發佈、下單、刪除等操作仍會先徵得你的確認。Token、自定義請求頭與配置保存在本機；若配置了代理，請求會按你的設置經該代理轉發。
            </p>
        </div>
    );
};

const Settings: React.FC = () => {
  const {
      apiConfig, updateApiConfig, closeApp, availableModels, setAvailableModels,
      theme, updateTheme, resetAppearance,
      exportSystem, importSystem, addToast, showError, resetSystem, updateCharacter,
      apiPresets, addApiPreset, updateApiPreset, removeApiPreset,
      sysOperation, // Get progress state
      realtimeConfig, updateRealtimeConfig, // 實時感知配置
      // 改工具憑據時要連雲端提示詞一起刷（見 syncAmsgToolConfigAndPrompts）
      characters, groups, userProfile,
      cloudBackupConfig, updateCloudBackupConfig,
      cloudBackupToWebDAV, cloudRestoreFromWebDAV, listCloudBackups,
  } = useOS();
  
  const [localKey, setLocalKey] = useState(apiConfig.apiKey);
  const [localUrl, setLocalUrl] = useState(apiConfig.baseUrl);
  const [localModel, setLocalModel] = useState(String(apiConfig.model || ''));
  const [localStream, setLocalStream] = useState<boolean>(apiConfig.stream === true);
  const [localTemperature, setLocalTemperature] = useState<number>(
    typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85
  );
  const [localVisionEnabled, setLocalVisionEnabled] = useState(apiConfig.visionApi?.enabled === true);
  const [localVisionUrl, setLocalVisionUrl] = useState(apiConfig.visionApi?.baseUrl || '');
  const [localVisionKey, setLocalVisionKey] = useState(apiConfig.visionApi?.apiKey || '');
  const [localVisionModel, setLocalVisionModel] = useState(apiConfig.visionApi?.model || '');
  const [availableVisionModels, setAvailableVisionModels] = useState<string[]>(readStoredVisionModels);
  const [selectedVisionPresetId, setSelectedVisionPresetId] = useState<string | null>(null);
  const [visionStatusMsg, setVisionStatusMsg] = useState('');
  const [testingVisionApi, setTestingVisionApi] = useState(false);
  const [visionTestResult, setVisionTestResult] = useState<string | null>(null);
  const [localMiniMaxKey, setLocalMiniMaxKey] = useState(apiConfig.minimaxApiKey || '');
  const [localMiniMaxGroupId, setLocalMiniMaxGroupId] = useState(apiConfig.minimaxGroupId || '');
  const [localMiniMaxRegion, setLocalMiniMaxRegion] = useState<'domestic' | 'overseas'>(
    apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic'
  );
  const [localAceStepKey, setLocalAceStepKey] = useState(apiConfig.aceStepApiKey || '');
  const [localTtsProvider, setLocalTtsProvider] = useState<TtsProvider>(
    apiConfig.ttsProvider === 'fishaudio' || apiConfig.ttsProvider === 'elevenlabs'
      ? apiConfig.ttsProvider
      : 'minimax'
  );
  const [localFishKey, setLocalFishKey] = useState(apiConfig.fishAudioApiKey || '');
  const [localFishModel, setLocalFishModel] = useState(apiConfig.fishAudioModel || 's2.1-pro');
  const [localElevenLabsKey, setLocalElevenLabsKey] = useState(apiConfig.elevenLabsApiKey || '');
  const [localElevenLabsModel, setLocalElevenLabsModel] = useState(apiConfig.elevenLabsModel || DEFAULT_ELEVENLABS_MODEL);
  const [localElevenLabsStability, setLocalElevenLabsStability] = useState(apiConfig.elevenLabsStability ?? 0.5);
  const [localElevenLabsSimilarityBoost, setLocalElevenLabsSimilarityBoost] = useState(apiConfig.elevenLabsSimilarityBoost ?? 0.8);
  const [localElevenLabsStyle, setLocalElevenLabsStyle] = useState(apiConfig.elevenLabsStyle ?? 0);
  const [localElevenLabsUseSpeakerBoost, setLocalElevenLabsUseSpeakerBoost] = useState(apiConfig.elevenLabsUseSpeakerBoost === true);
  // 自定義語音表演指南（留空 → 用內置默認）。按服務商分別保存。
  const [localVoicePromptMinimax, setLocalVoicePromptMinimax] = useState(apiConfig.voicePrompts?.minimax || '');
  const [localVoicePromptFish, setLocalVoicePromptFish] = useState(apiConfig.voicePrompts?.fishaudio || '');
  const [localVoicePromptElevenLabs, setLocalVoicePromptElevenLabs] = useState(apiConfig.voicePrompts?.elevenlabs || '');
  const [localVoicePromptDate, setLocalVoicePromptDate] = useState(apiConfig.voicePrompts?.dateVoice || '');
  const [showVoicePrompts, setShowVoicePrompts] = useState(false);
  const [showAceStepGuide, setShowAceStepGuide] = useState(false);
  const [otherStatusMsg, setOtherStatusMsg] = useState('');
  // 高級設置（流式/溫度）默認摺疊 — 大多數用戶不需要碰
  const [showApiAdvanced, setShowApiAdvanced] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isLoadingVisionModels, setIsLoadingVisionModels] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  // 就地編輯某條預設：只改預設本身；改的正好是當前生效那條時，生效配置一併跟著走
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editPresetName, setEditPresetName] = useState('');
  const [editPresetUrl, setEditPresetUrl] = useState('');
  const [editPresetKey, setEditPresetKey] = useState('');
  const [editPresetModel, setEditPresetModel] = useState('');
  const [editPresetStream, setEditPresetStream] = useState(false);
  const [editPresetTemperature, setEditPresetTemperature] = useState(0.85);
  const [holdingDeletePresetId, setHoldingDeletePresetId] = useState<string | null>(null);
  const presetDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // UI States
  const [showModelModal, setShowModelModal] = useState(false);
  const [modelFilter, setModelFilter] = useState('');
  const [showVisionModelModal, setShowVisionModelModal] = useState(false);
  const [visionModelFilter, setVisionModelFilter] = useState('');
  const [showExportModal, setShowExportModal] = useState(false); // Used for completion now
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showApiCallLog, setShowApiCallLog] = useState(false);
  const [showRealtimeModal, setShowRealtimeModal] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpHelp, setShowMcpHelp] = useState(false);
  const [showCloudModal, setShowCloudModal] = useState(false);
  const [showGithubModal, setShowGithubModal] = useState(false);
  const [showCloudRestoreModal, setShowCloudRestoreModal] = useState(false);
  const [cloudBackupFiles, setCloudBackupFiles] = useState<import('../types').CloudBackupFile[]>([]);
  const [cloudBackupListState, setCloudBackupListState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [cloudBackupListError, setCloudBackupListError] = useState('');
  const [cloudTestResult, setCloudTestResult] = useState<string>('');
  const [cloudTesting, setCloudTesting] = useState(false);
  const [avatarModelInventory, setAvatarModelInventory] = useState<AvatarModelBackupInventory | null>(null);
  const [avatarModelBackupBusy, setAvatarModelBackupBusy] = useState(false);
  const [avatarModelBackupProgress, setAvatarModelBackupProgress] = useState<AvatarModelBackupProgress | null>(null);

  // 「該備份啦」提醒頻率（1~30 天）。改動即落 localStorage（backupReminder 模塊自管持久化）。
  const [backupReminderDays, setBackupReminderDays] = useState<number>(() => getBackupReminderState().intervalDays);
  const backupDaysAgo = daysSinceLastBackup();
  const hasJournalAppearanceOverride = Boolean(
    theme.journalAppearance
    && ((theme.journalAppearance.preset || 'original') !== 'original'
      || theme.journalAppearance.customCss?.trim())
  );

  const [confirmAppearanceReset, setConfirmAppearanceReset] = useState(false);
  const [resettingAppearance, setResettingAppearance] = useState(false);
  const handleAppearanceEmergencyReset = async () => {
    setResettingAppearance(true);
    try { await resetAppearance(); }
    finally { setResettingAppearance(false); setConfirmAppearanceReset(false); }
  };
  // 一鍵還原全部「聊天白框自定義 CSS」：清掉全局 + 每個角色自帶的。
  // 兼作救援：單角色的壞 CSS 把聊天界面整崩、進不去該角色設置時，從這裡一鍵全清即可恢復。
  const resetAllChromeCss = () => {
    let n = 0;
    if (theme.chatChromeCustomCss) { updateTheme({ chatChromeCustomCss: '' }); n++; }
    (characters || []).forEach((c: any) => {
      if (c?.chromeCustomCss) { updateCharacter(c.id, { chromeCustomCss: '' } as any); n++; }
    });
    addToast(n ? `已還原 ${n} 處聊天白框美化` : '沒有需要還原的白框美化', n ? 'success' : 'info');
  };

  const handleJournalAppearanceEmergencyReset = async () => {
    await updateTheme({ journalAppearance: undefined });
    addToast('已從系統設置還原交換日記原版樣式', 'success');
  };

  // Cloud backup local config state (WebDAV)
  const [cbUrl, setCbUrl] = useState(cloudBackupConfig.webdavUrl);
  const [cbUsername, setCbUsername] = useState(cloudBackupConfig.username);
  const [cbPassword, setCbPassword] = useState(cloudBackupConfig.password);
  const [cbPath, setCbPath] = useState(cloudBackupConfig.remotePath || '/SullyBackup/');

  // GitHub local state
  const [ghToken, setGhToken] = useState(cloudBackupConfig.githubToken || '');
  const [ghRepo, setGhRepo] = useState(cloudBackupConfig.githubRepo || 'sully-backup');
  // 安全默認：舊版曾把代理默認打開。現在舊配置一律視為未重新確認，只有在
  // 新版說明下手動開啟過（consentVersion=1）才保持勾選。
  const [ghUseProxy, setGhUseProxy] = useState(
      cloudBackupConfig.githubUseProxy === true && cloudBackupConfig.githubProxyConsentVersion === 1
  );
  const [ghShowAdvanced, setGhShowAdvanced] = useState(false);
  const [ghTesting, setGhTesting] = useState(false);
  const [ghTestResult, setGhTestResult] = useState<string>('');

  // 主代理 Worker 地址（聯網搜索 / 備份代理 / Notion / 飛書 / MCD·瑞幸 MCP / 網頁抓取 / 出圖都走它）。
  // 入口刻意低調：默認摺疊，普通用戶不需要碰，開箱即用。
  const [focusProxyConfigOnMount] = useState(() => consumeProxyWorkerSettingsFocus());
  const [proxyWorkerInput, setProxyWorkerInput] = useState(getProxyWorkerUrl());
  const [showProxyConfig, setShowProxyConfig] = useState(focusProxyConfigOnMount);
  const proxyConfigSectionRef = useRef<HTMLElement | null>(null);
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(() => isAnalyticsEnabled());
  const [firecrawlKeyInput, setFirecrawlKeyInput] = useState(getFirecrawlApiKey);
  const [firecrawlUsage, setFirecrawlUsage] = useState<FirecrawlCreditUsage | null>(null);
  const [firecrawlChecking, setFirecrawlChecking] = useState(false);
  const [firecrawlCheckResult, setFirecrawlCheckResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
      if (!focusProxyConfigOnMount || !showProxyConfig) return;
      const frame = window.requestAnimationFrame(() => {
          proxyConfigSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return () => window.cancelAnimationFrame(frame);
  }, [focusProxyConfigOnMount, showProxyConfig]);

  // 每次打開實時感知面板時查餘額，不消耗抓取 credit。失敗不影響其他配置。
  useEffect(() => {
      if (!showRealtimeModal) return;
      const key = getFirecrawlApiKey();
      if (!key) return;
      let active = true;
      setFirecrawlChecking(true);
      getFirecrawlCreditUsage(key)
          .then(usage => {
              if (!active) return;
              setFirecrawlUsage(usage);
              setFirecrawlCheckResult({ ok: true, text: 'Firecrawl 已連接' });
          })
          .catch((error: any) => {
              if (!active) return;
              setFirecrawlUsage(null);
              setFirecrawlCheckResult({ ok: false, text: error?.message || 'Firecrawl 連接失敗' });
          })
          .finally(() => { if (active) setFirecrawlChecking(false); });
      return () => { active = false; };
  }, [showRealtimeModal]);

  // 實時感知配置的本地狀態
  const [rtWeatherEnabled, setRtWeatherEnabled] = useState(realtimeConfig.weatherEnabled);
  const [rtWeatherKey, setRtWeatherKey] = useState(realtimeConfig.weatherApiKey);
  const [rtWeatherCity, setRtWeatherCity] = useState(realtimeConfig.weatherCity);
  const [rtNewsEnabled, setRtNewsEnabled] = useState(realtimeConfig.newsEnabled);
  const [rtNewsApiKey, setRtNewsApiKey] = useState(realtimeConfig.newsApiKey || '');
  const [rtNewsPlatforms, setRtNewsPlatforms] = useState<string[]>(realtimeConfig.newsPlatforms || ['weibo', 'zhihu', 'baidu', 'bilibili', 'douyin']);
  const [rtNotionEnabled, setRtNotionEnabled] = useState(realtimeConfig.notionEnabled);
  const [rtNotionKey, setRtNotionKey] = useState(realtimeConfig.notionApiKey);
  const [rtNotionDbId, setRtNotionDbId] = useState(realtimeConfig.notionDatabaseId);
  const [rtNotionNotesDbId, setRtNotionNotesDbId] = useState(realtimeConfig.notionNotesDatabaseId || '');
  const [rtFeishuEnabled, setRtFeishuEnabled] = useState(realtimeConfig.feishuEnabled);
  const [rtFeishuAppId, setRtFeishuAppId] = useState(realtimeConfig.feishuAppId);
  const [rtFeishuAppSecret, setRtFeishuAppSecret] = useState(realtimeConfig.feishuAppSecret);
  const [rtFeishuBaseId, setRtFeishuBaseId] = useState(realtimeConfig.feishuBaseId);
  const [rtFeishuTableId, setRtFeishuTableId] = useState(realtimeConfig.feishuTableId);
  const [rtXhsEnabled, setRtXhsEnabled] = useState(realtimeConfig.xhsEnabled);
  // lite 模式走中心配置的主代理 worker（/api 是 worker/index.js 裡的 XHSLite 橋）。
  // 用戶改了「自定義網絡代理」，lite 模式自動跟著切到新 worker。
  const XHS_LITE_URL = `${getProxyWorkerUrl()}/api`;
  const XHS_RISK_TEXT = '使用提示：Lite 通過網頁接口連接小紅書，平台規則變化時可能出現登錄失效或功能暫時不可用。建議先用小號體驗，並在發佈或互動前確認內容。';
  const XHS_COOKIE_GUIDE = [
    '【獲取小紅書 cookie 教程】',
    '1. 用電腦瀏覽器(Chrome/Edge)登錄實際分配給你的站點：www.xiaohongshu.com 或 www.rednote.com',
    '2. 按 F12 打開開發者工具，切到「Network/網絡」標籤',
    '3. 刷新頁面，點列表最上面那條「explore」(document 類型，發給當前網站的主請求)',
    '4. 右側切到「Headers/標頭」，往下滾到「Request Headers/請求標頭」',
    '5. 找到 cookie: 開頭那一行(很長一串)',
    '6. 複製它後面整段的值：可把 Request Headers 右邊的「Raw」開關打開看純文本更好選，或在值上右鍵 Copy value，或選中後 Ctrl+C',
    '7. 確認這串裡有 a1= 和 web_session= 兩個字段(最關鍵)，粘到「小紅書 Lite」的 cookie 框',
    'Lite 會自動判斷這串 Cookie 屬於國內小紅書還是全球 RedNote；不用自己補 gid、bRequestId 等會隨站點變化的字段。',
    '注意：別用 Console 的 document.cookie，拿不到 web_session(httpOnly)。cookie 數天~數週會過期，失效重複制即可。',
  ].join('\n');
  const _xhsCfgUrl = realtimeConfig.xhsMcpConfig?.serverUrl || '';
  // 部署模式與協議分開保存：本地 Skills 和雲端 Lite 都是 /api，不能再憑路徑判斷。
  const _xhsStoredMode = resolveXhsDeploymentMode(realtimeConfig.xhsMcpConfig, XHS_LITE_URL);
  const _xhsIsLocal = _xhsStoredMode === 'local';
  const [rtXhsMcpEnabled, setRtXhsMcpEnabled] = useState(realtimeConfig.xhsMcpConfig?.enabled || false);
  const [rtXhsMode, setRtXhsMode] = useState<'lite' | 'local'>(_xhsIsLocal ? 'local' : 'lite');
  const [rtXhsLocalUrl, setRtXhsLocalUrl] = useState(_xhsIsLocal ? _xhsCfgUrl : 'http://localhost:18060/mcp');
  const [rtXhsNickname, setRtXhsNickname] = useState(realtimeConfig.xhsMcpConfig?.loggedInNickname || '');
  const [rtXhsUserId, setRtXhsUserId] = useState(realtimeConfig.xhsMcpConfig?.loggedInUserId || '');
  const [rtXhsCookie, setRtXhsCookie] = useState(realtimeConfig.xhsMcpConfig?.cookie || '');
  const [rtXhsPlatform, setRtXhsPlatform] = useState<'xhs' | 'rednote' | undefined>(realtimeConfig.xhsMcpConfig?.platform);
  const [rtXhsGuideOpen, setRtXhsGuideOpen] = useState(false);
  const [rtTestStatus, setRtTestStatus] = useState('');

  // 麥當勞 MCP (token / 啟用態都直接存 localStorage, 不進 realtimeConfig)
  const [mcdToken, setMcdTokenState] = useState(() => getMcdToken());
  const [mcdEnabled, setMcdEnabledState] = useState(() => isMcdEnabled());
  const [mcdTestStatus, setMcdTestStatus] = useState('');
  const [mcdTesting, setMcdTesting] = useState(false);

  // 瑞幸 MCP (與麥當勞同構)
  const [luckinToken, setLuckinTokenState] = useState(() => getLuckinToken());
  const [luckinEnabled, setLuckinEnabledState] = useState(() => isLuckinEnabled());
  const [luckinTestStatus, setLuckinTestStatus] = useState('');
  const [luckinTesting, setLuckinTesting] = useState(false);

  // Proactive Push 加速器（Worker URL / VAPID 公鑰寫死在 proactivePushConfig.ts 常量裡）
  const initialPushCfg = loadPushConfig();
  const ppAvailable = isPushConfigAvailable();
  const [ppEnabled, setPpEnabled] = useState(initialPushCfg.enabled);
  const [ppStatus, setPpStatus] = useState<string>('');
  const [ppBusy, setPpBusy] = useState(false);
  const [showPpConfirm, setShowPpConfirm] = useState(false);
  const [ppDiag, setPpDiag] = useState<PushDiagnostics | null>(null);
  const [ppTestBusy, setPpTestBusy] = useState(false);
  const [ppResetBusy, setPpResetBusy] = useState(false);
  const [ppDeepResetBusy, setPpDeepResetBusy] = useState(false);
  // 連續 zombie 重置失敗次數 — 累計 >= 3 時, "重置訂閱" 按鈕自動 morph 成
  // "深度重置". 不持久化, 刷新頁面歸零 (用戶原話: "刷新頁面正常消失").
  const [ppZombieStreak, setPpZombieStreak] = useState(0);
  const [showAmsg2Modal, setShowAmsg2Modal] = useState(false);
  const [showVapidModal, setShowVapidModal] = useState(false);
  const [vapidReadyTick, setVapidReadyTick] = useState(0); // 關閉 VAPID 彈窗後刷新頂層徽標

  // 模型選擇 Modal 的過濾 + 公共前綴（memo 掉，避免每次 Settings 重渲染都重算）
  const modelPickerView = useMemo(
      () => buildModelPickerView(availableModels, modelFilter),
      [modelFilter, availableModels],
  );
  const visionModelPickerView = useMemo(
      () => buildModelPickerView(availableVisionModels, visionModelFilter),
      [visionModelFilter, availableVisionModels],
  );

  const refreshPpDiag = useCallback(async () => {
      try { setPpDiag(await getPushDiagnostics()); } catch { /* ignore */ }
  }, []);

  const doEnablePushAccelerator = async () => {
      if (ppBusy) return;
      setPpBusy(true);
      setPpStatus('正在連接 Worker…');
      try {
          const res = await fetch(`${initialPushCfg.workerUrl}/health`);
          if (!res.ok) {
              trackEvent('启用主动消息 Push 加速', { result: 'fail', failStage: 'worker_health' });
              trackEvent('启用 Push 加速器的结果', { result: 'worker-unreachable' });
              setPpStatus(`失敗：Worker HTTP ${res.status}`); setPpBusy(false); return;
          }
      } catch (e: any) {
          trackEvent('启用主动消息 Push 加速', { result: 'fail', failStage: 'network' });
          trackEvent('启用 Push 加速器的结果', { result: 'worker-unreachable' });
          setPpStatus(`失敗：${e?.message || '網絡錯誤'}`); setPpBusy(false); return;
      }

      // Step 1: ensure permission + subscription up front, regardless of schedules.
      // This is the fix for the old bug where toggle "succeeded" without ever
      // requesting permission when the user hadn't enabled any character timer yet.
      setPpStatus('正在請求通知權限並創建訂閱…');
      const sub = await ensureSubscribed();
      if (!sub.ok) {
          trackEvent('启用主动消息 Push 加速', { result: 'fail', failStage: 'subscribe' });
          trackEvent('启用 Push 加速器的结果', { result: 'subscribe-failed' });
          setPpStatus(`失敗：${sub.reason || '訂閱創建失敗'}`);
          setPpBusy(false);
          await refreshPpDiag();
          return;
      }

      // Step 2: persist enabled flag and start heartbeat.
      savePushConfig(true);
      setPpEnabled(true);
      startHeartbeat();

      // Step 3: register any existing per-character schedules.
      const schedules = ProactiveChat.getSchedules();
      let okCount = 0;
      for (const s of schedules) {
          if (await registerScheduleOnWorker(s.charId, s.intervalMs)) okCount++;
      }

      if (schedules.length === 0) {
          trackEvent('启用主动消息 Push 加速', { result: 'success' });
          trackEvent('启用 Push 加速器的结果', { result: 'ok-no-schedule' });
          setPpStatus('已啟用（訂閱已建立。暫無主動消息定時，下次開啟角色主動消息時會自動註冊）');
      } else if (okCount < schedules.length) {
          trackEvent('启用主动消息 Push 加速', { result: 'partial' });
          trackEvent('启用 Push 加速器的结果', { result: 'ok-partial-schedule' });
          setPpStatus(`已啟用：${okCount}/${schedules.length} 個定時註冊成功`);
      } else {
          trackEvent('启用主动消息 Push 加速', { result: 'success' });
          trackEvent('启用 Push 加速器的结果', { result: 'ok' });
          setPpStatus(`已啟用，${okCount} 個主動消息定時已註冊`);
      }
      setPpBusy(false);
      await refreshPpDiag();
  };

  const doDisablePushAccelerator = async () => {
      trackEvent('关闭主动消息 Push 加速');
      savePushConfig(false);
      setPpEnabled(false);
      stopHeartbeat();
      setPpStatus('已關閉（主動消息退回本地計時器）');
      await refreshPpDiag();
  };

  const doSendTestPush = async () => {
      if (ppTestBusy) return;
      setPpTestBusy(true);
      setPpStatus('正在讓 Worker 發一條測試推送…');
      const res = await sendTestPush();
      if (res.ok) {
          trackEvent('发送测试推送（主动消息加速）', { result: 'sent' });
          trackEvent('发一条测试推送', { result: 'sent' });
          setPpStatus('測試推送已發出。如果 5 秒內系統通知裡沒出現"推送測試成功"，說明送達環節有問題——看下方診斷面板。');
      } else if (res.deadSubscription) {
          trackEvent('发送测试推送（主动消息加速）', { result: 'dead_subscription' });
          trackEvent('发一条测试推送', { result: 'dead-subscription' });
          setPpStatus('訂閱已被瀏覽器吊銷（zombie endpoint）。請點下方"重置訂閱"重建一次再測。');
      } else {
          trackEvent('发送测试推送（主动消息加速）', { result: 'fail' });
          trackEvent('发一条测试推送', { result: 'failed' });
          setPpStatus(`測試失敗：${res.reason || '未知錯誤'}${res.status ? `（HTTP ${res.status}）` : ''}`);
      }
      setPpTestBusy(false);
      await refreshPpDiag();
  };

  const doResetSubscription = async () => {
      if (ppResetBusy || ppDeepResetBusy) return;
      setPpResetBusy(true);
      setPpStatus('正在重置訂閱…');
      const res = await resetSubscription();
      if (res.ok) {
          trackEvent('重置推送订阅', { result: 'success', attempt: bucketRetryCount(ppZombieStreak) });
          setPpZombieStreak(0);
          setPpStatus('訂閱已重建。可以再點"發一條測試推送"試一下。');
      } else {
          const reason = res.reason || '';
          // 失敗原因指向 zombie endpoint 時累計, 達到 3 次後按鈕自動 morph 成深度重置
          if (/permanently-removed|zombie/i.test(reason)) {
              setPpZombieStreak(c => c + 1);
          }
          // 只上報歸類後的固定枚舉，失敗原文一個字都不帶；重試次數同樣先分桶
          trackEvent('重置推送订阅', {
              result: /permanently-removed|zombie/i.test(reason) ? 'fail_zombie' : 'fail_other',
              attempt: bucketRetryCount(ppZombieStreak),
          });
          setPpStatus(`重置失敗：${reason || '未知錯誤'}`);
      }
      setPpResetBusy(false);
      await refreshPpDiag();
  };

  const doDeepResetSubscription = async () => {
      if (ppDeepResetBusy || ppResetBusy) return;
      setPpDeepResetBusy(true);
      setPpStatus('正在深度重置…');
      const res = await deepResetSubscription();
      // 無論成敗, 按鈕都回歸"重置訂閱" — 下次出問題再次累計觸發 morph
      setPpZombieStreak(0);
      if (res.ok) {
          // ProactiveChat.resume() 把所有 schedule 推回新 SW. deepResetSubscription 內部
          // 不調它是為了避免循環依賴 (ProactiveChat 反向依賴 proactivePushConfig).
          try { ProactiveChat.resume(); } catch (e) { console.warn('[Settings] ProactiveChat.resume failed', e); }
          trackEvent('深度重置推送订阅', { result: 'success' });
          setPpStatus('訂閱已重建。可以再點"發一條測試推送"試一下。');
      } else {
          trackEvent('深度重置推送订阅', { result: 'fail' });
          setPpStatus(`深度重置失敗：${res.reason || '未知錯誤'}`);
      }
      setPpDeepResetBusy(false);
      await refreshPpDiag();
  };

  // Refresh diagnostics whenever the panel is mounted or the toggle changes.
  useEffect(() => {
      void refreshPpDiag();
  }, [refreshPpDiag, ppEnabled]);

  // For web download link
  const [downloadUrl, setDownloadUrl] = useState<string>('');
  const [downloadFileName, setDownloadFileName] = useState('Sully_Backup.zip');
  // 用 ref 跟住當前的 object URL，關彈窗 / 重新導出 / 卸載時都能 revoke 到最新那個，
  // 不受 state 閉包過期影響。
  const downloadUrlRef = useRef<string>('');
  const revokeDownloadUrl = useCallback(() => {
      if (downloadUrlRef.current) {
          URL.revokeObjectURL(downloadUrlRef.current);
          downloadUrlRef.current = '';
      }
      setDownloadUrl('');
  }, []);
  useEffect(() => () => {
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
  }, []);

  const [statusMsg, setStatusMsg] = useState('');
  const [testingApi, setTestingApi] = useState(false);
  const [testApiResult, setTestApiResult] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const avatarModelBackupInputRef = useRef<HTMLInputElement>(null);
  const refreshAvatarModelInventory = useCallback(async () => {
      try {
          setAvatarModelInventory(await getAvatarModelBackupInventory());
      } catch (error) {
          console.warn('[Settings] 讀取模型備份清單失敗', error);
      }
  }, []);
  useEffect(() => { void refreshAvatarModelInventory(); }, [refreshAvatarModelInventory]);

  // 把已保存的配置同步進上面這些輸入框。
  //
  // 三個區塊（主 API / 識圖 / 其他）各同步各的，依賴寫到具體字段值上——**不能**整個
  // apiConfig 當依賴：updateApiConfig 每次都返回新對象，那樣在識圖區點一下保存，
  // 主 API 這邊還沒保存的輸入就被悄悄衝回舊值了，而且界面上完全看不出來。
  useEffect(() => {
      setLocalUrl(apiConfig.baseUrl);
      setLocalKey(apiConfig.apiKey);
      setLocalModel(String(apiConfig.model || ''));
      setLocalStream(apiConfig.stream === true);
      setLocalTemperature(typeof apiConfig.temperature === 'number' ? apiConfig.temperature : 0.85);
  }, [apiConfig.baseUrl, apiConfig.apiKey, apiConfig.model, apiConfig.stream, apiConfig.temperature]);

  useEffect(() => {
      setLocalVisionEnabled(apiConfig.visionApi?.enabled === true);
  }, [apiConfig.visionApi?.enabled]);
  useEffect(() => {
      setLocalVisionUrl(apiConfig.visionApi?.baseUrl || '');
      setLocalVisionKey(apiConfig.visionApi?.apiKey || '');
      setLocalVisionModel(apiConfig.visionApi?.model || '');
  }, [apiConfig.visionApi?.baseUrl || '', apiConfig.visionApi?.apiKey || '', apiConfig.visionApi?.model || '']);

  useEffect(() => {
      setLocalMiniMaxKey(apiConfig.minimaxApiKey || '');
      setLocalMiniMaxGroupId(apiConfig.minimaxGroupId || '');
      setLocalMiniMaxRegion(apiConfig.minimaxRegion === 'overseas' ? 'overseas' : 'domestic');
      setLocalAceStepKey(apiConfig.aceStepApiKey || '');
      setLocalTtsProvider(
          apiConfig.ttsProvider === 'fishaudio' || apiConfig.ttsProvider === 'elevenlabs'
              ? apiConfig.ttsProvider
              : 'minimax'
      );
      setLocalFishKey(apiConfig.fishAudioApiKey || '');
      setLocalFishModel(apiConfig.fishAudioModel || 's2.1-pro');
      setLocalElevenLabsKey(apiConfig.elevenLabsApiKey || '');
      setLocalElevenLabsModel(apiConfig.elevenLabsModel || DEFAULT_ELEVENLABS_MODEL);
      setLocalElevenLabsStability(apiConfig.elevenLabsStability ?? 0.5);
      setLocalElevenLabsSimilarityBoost(apiConfig.elevenLabsSimilarityBoost ?? 0.8);
      setLocalElevenLabsStyle(apiConfig.elevenLabsStyle ?? 0);
      setLocalElevenLabsUseSpeakerBoost(apiConfig.elevenLabsUseSpeakerBoost === true);
      setLocalVoicePromptMinimax(apiConfig.voicePrompts?.minimax || '');
      setLocalVoicePromptFish(apiConfig.voicePrompts?.fishaudio || '');
      setLocalVoicePromptElevenLabs(apiConfig.voicePrompts?.elevenlabs || '');
      setLocalVoicePromptDate(apiConfig.voicePrompts?.dateVoice || '');
  }, [
      apiConfig.minimaxApiKey, apiConfig.minimaxGroupId, apiConfig.minimaxRegion, apiConfig.aceStepApiKey,
      apiConfig.ttsProvider, apiConfig.fishAudioApiKey, apiConfig.fishAudioModel,
      apiConfig.elevenLabsApiKey, apiConfig.elevenLabsModel, apiConfig.elevenLabsStability,
      apiConfig.elevenLabsSimilarityBoost, apiConfig.elevenLabsStyle, apiConfig.elevenLabsUseSpeakerBoost,
      apiConfig.voicePrompts?.minimax, apiConfig.voicePrompts?.fishaudio,
      apiConfig.voicePrompts?.elevenlabs, apiConfig.voicePrompts?.dateVoice,
  ]);

  // 當前生效的是哪條預設 —— 按已保存的配置反查，不額外記狀態。
  // 這樣刷新、手改 URL、導入備份之後，界面上的「使用中」永遠等於請求真的會發去哪。
  const activePresetId = useMemo(
      () => findActivePresetId(apiPresets, apiConfig),
      [apiPresets, apiConfig.baseUrl, apiConfig.apiKey, apiConfig.model],
  );

  /**
   * 把一份配置真正切過去。保存按鈕和點預設走的是同一條路——除了寫進全局配置，
   * 還要把已排程的主動消息憑據一起換掉，否則聊天換了、後台任務還拿舊 Key 打請求。
   */
  const commitApiConfig = (patch: PresetSwitchPatch | Partial<APIConfig>) => {
    updateApiConfig(patch);
    // 支持憑據表的 Worker 上，任務只帶引用，換 Key 只要覆蓋雲端那幾行——不用逐條改任務。
    // 老 Worker 上這句是 no-op，憑據靠下面那條逐條補刷的老路續命。
    syncAmsgLlmCredentials({ ...apiConfig, ...patch });
    // 已排程的主動消息 2.0 AI 任務裡凍結的是排程那一刻的憑據——換 Key / 換模型後
    // 不重傳的話，到點全拿舊憑據打請求（舊 Key 一吊銷就是連環 401）。best-effort：
    // 保存本身不等它，失敗只提示；沒配 2.0 / 沒有 pending AI 任務時它是 no-op。
    // 存量的內聯任務還靠它，所以走引用那條路的用戶這裡照跑（帶 credRefs 的任務
    // 到點只認引用，這一份補刷落在它們身上是無害的空轉）。
    void ActiveMsgClient.refreshApiCredentialsForPendingTasks({ ...apiConfig, ...patch })
      .then((result) => {
        if (result.status === 'partial') {
          addToast(`API 已保存，但有 ${result.failed} 條已排程的主動消息沒換上新憑據，稍後再保存一次可重試。`, 'error');
        }
      })
      .catch((error) => {
        console.warn('[Settings] 刷新已排程任務的 API 憑據失敗', error);
        addToast('API 已保存，但已排程的主動消息憑據刷新失敗，稍後再保存一次可重試。', 'error');
      });
  };

  /**
   * 點預設 = 直接切過去並生效，沒有「載入了但還沒保存」的中間狀態。
   * 上面的輸入框由 apiConfig 同步 effect 自己跟上，不在這裡手動塞。
   * MiniMax / AceStep 那些不歸預設管：一個人通常只有一個語音帳號，換 LLM 不該動它。
   */
  const applyPreset = (preset: typeof apiPresets[0]) => {
      // 已經在用這條也照切：「使用中」只看 URL/Key/Model 三件套，溫度、流式可能被手調過，
      // 再點一下的語義就是「整套回到這條預設存的樣子」。
      commitApiConfig(configFromPreset(preset));
      addToast(`已切換到「${preset.name}」，立即生效`, 'success');
  };

  const openEditPreset = (preset: typeof apiPresets[0]) => {
      cancelPresetDeleteHold();
      const isActive = activePresetId === preset.id;
      setEditingPresetId(preset.id);
      setEditPresetName(preset.name);
      setEditPresetUrl(preset.config.baseUrl || '');
      setEditPresetKey(preset.config.apiKey || '');
      setEditPresetModel(preset.config.model || '');
      // 當前正在使用的預設要接住主表單裡剛改的高級設置：用戶點鉛筆再點保存即可寫回，
      // 不必猜還要額外按一次「用當前配置填入」。非當前/老預設則讀取自身，缺字段才回退。
      setEditPresetStream(
          isActive ? localStream : (typeof preset.config.stream === 'boolean' ? preset.config.stream : localStream),
      );
      setEditPresetTemperature(
          isActive
              ? localTemperature
              : (typeof preset.config.temperature === 'number' ? preset.config.temperature : localTemperature),
      );
  };

  const handleUpdatePreset = () => {
      const preset = apiPresets.find(item => item.id === editingPresetId);
      if (!preset) return;
      const name = editPresetName.trim();
      if (!name) {
          addToast('預設名稱不能為空', 'error');
          return;
      }
      const nextConfig = {
          ...preset.config,
          baseUrl: normalizeApiBaseUrl(editPresetUrl),
          apiKey: normalizeApiCredential(editPresetKey),
          model: normalizeApiModel(editPresetModel),
          stream: editPresetStream,
          temperature: editPresetTemperature,
      };
      // 「正在用的就是這條」要在改之前問，改完值就對不上了
      const wasActive = activePresetId === preset.id;
      updateApiPreset(preset.id, name, nextConfig);
      // 改的正好是當前生效那條 → 生效配置跟著走，否則界面寫著新 Key、請求還在用舊的
      if (wasActive) commitApiConfig(configFromPreset({ ...preset, name, config: nextConfig }));
      setEditingPresetId(null);
      addToast(wasActive ? `「${name}」已更新，當前配置同步生效` : `「${name}」已更新`, 'success');
  };

  const cancelPresetDeleteHold = useCallback(() => {
      if (presetDeleteTimerRef.current) {
          clearTimeout(presetDeleteTimerRef.current);
          presetDeleteTimerRef.current = null;
      }
      setHoldingDeletePresetId(null);
  }, []);

  useEffect(() => () => {
      if (presetDeleteTimerRef.current) clearTimeout(presetDeleteTimerRef.current);
  }, []);

  // 刪預設只是把這張「存檔卡」扔掉：當前生效的配置是拷貝，不受影響。
  const deleteApiPreset = (id: string, name: string) => {
      cancelPresetDeleteHold();
      removeApiPreset(id);
      setEditingPresetId(current => (current === id ? null : current));
      addToast(`已刪除預設: ${name}`, 'success');
  };

  const beginPresetDeleteHold = (id: string, name: string) => {
      cancelPresetDeleteHold();
      setHoldingDeletePresetId(id);
      presetDeleteTimerRef.current = setTimeout(() => {
          presetDeleteTimerRef.current = null;
          setHoldingDeletePresetId(null);
          removeApiPreset(id);
          setEditingPresetId(current => (current === id ? null : current));
          addToast(`已刪除預設: ${name}`, 'success');
      }, 700);
  };

  const handleSavePreset = () => {
      if (!newPresetName.trim()) {
          addToast('請輸入預設名稱', 'error');
          return;
      }
      addApiPreset(newPresetName, {
        baseUrl: normalizeApiBaseUrl(localUrl),
        apiKey: normalizeApiCredential(localKey),
        model: normalizeApiModel(localModel),
        stream: localStream,
        temperature: localTemperature,
      });
      setNewPresetName('');
      setShowPresetModal(false);
      addToast('預設已保存', 'success');
  };

  /**
   * 保存下面這份表單 = 改「當前生效的配置」，**不會**順手覆蓋任何一條預設。
   * 想把改動存回預設，走預設那排的鉛筆（彈窗裡可一鍵填入當前配置）。
   */
  const handleSaveApi = () => {
    const nextConfig = {
      apiKey: normalizeApiCredential(localKey),
      baseUrl: normalizeApiBaseUrl(localUrl),
      model: normalizeApiModel(localModel),
      stream: localStream,
      temperature: localTemperature,
    };
    setLocalKey(nextConfig.apiKey);
    setLocalUrl(nextConfig.baseUrl);
    setLocalModel(nextConfig.model);
    commitApiConfig(nextConfig);
    setStatusMsg('配置已保存');
    setTimeout(() => setStatusMsg(''), 2000);
  };

  const handleSaveVisionApi = (enabled = localVisionEnabled) => {
    const nextVisionApi = {
      enabled,
      baseUrl: normalizeApiBaseUrl(localVisionUrl),
      apiKey: normalizeApiCredential(localVisionKey),
      model: normalizeApiModel(localVisionModel),
    };
    if (nextVisionApi.enabled && (!nextVisionApi.baseUrl || !nextVisionApi.apiKey || !nextVisionApi.model)) {
      addToast('開啟識圖 API 前，請填寫完整的 URL、Key 和 Model', 'error');
      return;
    }
    setLocalVisionUrl(nextVisionApi.baseUrl);
    setLocalVisionKey(nextVisionApi.apiKey);
    setLocalVisionModel(nextVisionApi.model);
    updateApiConfig({ visionApi: nextVisionApi });
    setVisionStatusMsg(nextVisionApi.enabled ? '識圖 API 已接入' : '已關閉，沿用原有識圖方式');
    setTimeout(() => setVisionStatusMsg(''), 2200);
  };

  const handleToggleVisionApi = () => {
    const enabled = !localVisionEnabled;
    setLocalVisionEnabled(enabled);
    if (!enabled) {
      // 關閉立即落盤；保留已保存的憑據，未保存的輸入仍留在表單裡。
      updateApiConfig({ visionApi: {
        baseUrl: '', apiKey: '', model: '', ...apiConfig.visionApi, enabled: false,
      } });
      setVisionStatusMsg('已關閉，沿用原有識圖方式');
    } else if (normalizeApiBaseUrl(localVisionUrl) && normalizeApiCredential(localVisionKey) && normalizeApiModel(localVisionModel)) {
      handleSaveVisionApi(true);
    } else {
      setVisionStatusMsg('請填寫 URL、Key 和 Model，保存後接入');
    }
  };

  const loadVisionApiPreset = (preset: typeof apiPresets[0]) => {
    const next = visionApiConfigFromPreset(preset);
    setSelectedVisionPresetId(preset.id);
    setLocalVisionEnabled(true);
    setLocalVisionUrl(next.baseUrl);
    setLocalVisionKey(next.apiKey);
    setLocalVisionModel(next.model);
    setVisionTestResult(null);
    setVisionStatusMsg(`已載入預設：${preset.name}`);
    setTimeout(() => setVisionStatusMsg(''), 2200);
    addToast(`已把「${preset.name}」填入識圖 API；保存後生效`, 'info');
  };

  const fetchVisionModels = async () => {
    const baseUrl = normalizeApiBaseUrl(localVisionUrl);
    const apiKey = normalizeApiCredential(localVisionKey);
    if (!baseUrl) { setVisionStatusMsg('請先填寫識圖 URL'); return; }
    setIsLoadingVisionModels(true);
    setVisionStatusMsg('正在拉取識圖模型...');
    setVisionTestResult(null);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const models = extractModelIds(await safeResponseJson(response));
      if (models.length === 0) {
        setVisionStatusMsg('模型列表為空或格式不兼容');
        return;
      }
      setAvailableVisionModels(models);
      try { localStorage.setItem(VISION_MODEL_LIST_STORAGE_KEY, JSON.stringify(models)); } catch { /* ignore */ }
      if (!models.includes(normalizeApiModel(localVisionModel))) {
        setLocalVisionModel(models[0]);
        setSelectedVisionPresetId(null);
      }
      setVisionStatusMsg(`獲取到 ${models.length} 個識圖模型`);
      setVisionModelFilter('');
      setShowVisionModelModal(true);
    } catch (error: any) {
      console.error('Fetch Vision Models Error', error);
      setVisionStatusMsg(`拉取失敗${error?.message ? `：${error.message}` : ''}`);
    } finally {
      setIsLoadingVisionModels(false);
    }
  };

  const handleTestVisionApi = async () => {
    const config = {
      enabled: true,
      baseUrl: normalizeApiBaseUrl(localVisionUrl),
      apiKey: normalizeApiCredential(localVisionKey),
      model: normalizeApiModel(localVisionModel),
    };
    if (!config.baseUrl || !config.apiKey || !config.model) {
      setVisionTestResult('❌ 請先填寫完整的 URL、Key 和 Model');
      return;
    }
    setTestingVisionApi(true);
    setVisionTestResult(null);
    try {
      const description = await describeImageWithVisionApi(VISION_API_TEST_IMAGE_DATA_URL, config);
      setVisionTestResult(`✅ 識圖成功 — ${description.slice(0, 80)}`);
      trackEvent('测试识图 API', { result: '成功' });
    } catch (error: any) {
      console.error('Test Vision API Error', error);
      setVisionTestResult(`❌ 識圖失敗：${error?.message || '未知錯誤'}`);
      trackEvent('测试识图 API', { result: '失败' });
    } finally {
      setTestingVisionApi(false);
    }
  };

  const buildOtherApiConfig = (overrides: Partial<APIConfig> = {}): Partial<APIConfig> => ({
      minimaxApiKey: localMiniMaxKey,
      minimaxGroupId: localMiniMaxGroupId,
      minimaxRegion: localMiniMaxRegion,
      aceStepApiKey: localAceStepKey,
      ttsProvider: localTtsProvider,
      fishAudioApiKey: localFishKey,
      fishAudioModel: localFishModel,
      elevenLabsApiKey: localElevenLabsKey,
      elevenLabsModel: localElevenLabsModel,
      elevenLabsStability: localElevenLabsStability,
      elevenLabsSimilarityBoost: localElevenLabsSimilarityBoost,
      elevenLabsStyle: localElevenLabsStyle,
      elevenLabsUseSpeakerBoost: localElevenLabsUseSpeakerBoost,
      voicePrompts: {
        minimax: localVoicePromptMinimax.trim() ? localVoicePromptMinimax : undefined,
        fishaudio: localVoicePromptFish.trim() ? localVoicePromptFish : undefined,
        elevenlabs: localVoicePromptElevenLabs.trim() ? localVoicePromptElevenLabs : undefined,
        dateVoice: localVoicePromptDate.trim() ? localVoicePromptDate : undefined,
      },
      ...overrides,
  });

  const handleSaveOtherApis = () => {
    updateApiConfig(buildOtherApiConfig());
    setOtherStatusMsg('已保存');
    setTimeout(() => setOtherStatusMsg(''), 2000);
  };

  // 選「誰來做語音生成」立即落庫——不需要再點下面的保存。
  // 連同當前「其他 API」草稿一起提交（與保存按鈕同一份 payload）：一是即時生效，
  // 二是避免 [apiConfig] 同步 effect 把剛填、還沒保存的 Key 草稿沖掉。
  const selectTtsProvider = (provider: TtsProvider) => {
    setLocalTtsProvider(provider);
    updateApiConfig(buildOtherApiConfig({ ttsProvider: provider }));
    const providerLabel = provider === 'fishaudio' ? '魚聲 Fish' : provider === 'elevenlabs' ? 'ElevenLabs' : 'MiniMax';
    addToast(`語音生成已切到 ${providerLabel}`, 'success');
  };

  // 選魚聲模型：立即落庫（同上，連帶草稿一起提交，避免被同步 effect 沖掉）。
  const selectFishModel = (model: string) => {
    setLocalFishModel(model);
    updateApiConfig(buildOtherApiConfig({ fishAudioModel: model }));
  };

  // ElevenLabs 模型會改變可用的語音標籤，因此和魚聲模型一樣立即落庫。
  const selectElevenLabsModel = (model: string) => {
    setLocalElevenLabsModel(model);
    updateApiConfig(buildOtherApiConfig({ elevenLabsModel: model }));
  };

  const fetchModels = async () => {
    const baseUrl = normalizeApiBaseUrl(localUrl);
    const apiKey = normalizeApiCredential(localKey);
    if (!baseUrl) { setStatusMsg('請先填寫 URL'); return; }
    setIsLoadingModels(true);
    setStatusMsg('正在連接...');
    try {
        const response = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await safeResponseJson(response);
        // Support common OpenAI-compatible and nested gateway response formats.
        const models = extractModelIds(data);
        if (models.length > 0) {
            setAvailableModels(models);
            if (models.length > 0 && !models.includes(localModel)) setLocalModel(models[0]);
            setStatusMsg(`獲取到 ${models.length} 個模型`);
            setShowModelModal(true); // Open selector immediately
        } else { setStatusMsg('模型列表為空或格式不兼容'); }
    } catch (error: any) {
        console.error(error);
        setStatusMsg(`連接失敗${error?.message ? `：${error.message}` : ''}`);
    } finally {
        setIsLoadingModels(false);
    }
  };

  // 一鍵清理「幽靈表情包」殘留：先 dryRun 掃描，彈確認後才真正刪。
  // 殘留的來歷：舊版本刪角色不會級聯清理表情分類，只對已刪角色可見的專屬分類
  // 會卡在數據庫裡——單聊面板看不到（也刪不掉），群聊面板卻能看到。
  const [isCleaningResidue, setIsCleaningResidue] = useState(false);
  const handleCleanupResidue = async () => {
      if (isCleaningResidue) return;
      setIsCleaningResidue(true);
      try {
          const validIds = (await DB.getAllCharacters()).map(c => c.id);
          const scan = await DB.cleanupEmojiResidue(validIds, { dryRun: true });
          if (scan.removedCategories.length === 0 && scan.fixedCategories.length === 0 && scan.removedEmojiCount === 0) {
              addToast('很乾淨，沒有發現表情包殘留 ✨', 'success');
              return;
          }
          const lines = [
              scan.removedCategories.length > 0 ? `• 刪除 ${scan.removedCategories.length} 個失效專屬分類：${scan.removedCategories.map(c => `「${c.name}」`).join('、')}` : '',
              scan.removedEmojiCount > 0 ? `• 刪除 ${scan.removedEmojiCount} 個隨分類失效/無主的表情` : '',
              scan.fixedCategories.length > 0 ? `• 修復 ${scan.fixedCategories.length} 個分類裡指向已刪角色的綁定：${scan.fixedCategories.map(c => `「${c.name}」`).join('、')}` : '',
          ].filter(Boolean).join('\n');
          if (!window.confirm(`掃描到以下殘留（角色已刪除但表情包還在）：\n\n${lines}\n\n點「確定」清理，此操作不可撤銷。`)) return;
          const report = await DB.cleanupEmojiResidue(validIds);
          addToast(`清理完成：刪除 ${report.removedCategories.length} 個分類、${report.removedEmojiCount} 個表情${report.fixedCategories.length > 0 ? `，修復 ${report.fixedCategories.length} 處綁定` : ''}`, 'success');
      } catch (err) {
          console.error('[Settings] 表情包殘留清理失敗', err);
          addToast('清理失敗，請重試', 'error');
      } finally {
          setIsCleaningResidue(false);
      }
  };

  const handleExport = async (mode: 'text_only' | 'media_only' | 'full') => {
      trackEvent('导出本地备份', { scope: mode });
      try {
          // 二次確認：整包備份（full / text_only）本就包含你的 API 密鑰等設置——這是預期行為，
          // 但絕不能發給別人。media_only 只有媒體、不含密鑰，視為可分享。
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
              const includesSettings = mode !== 'media_only';
              const msg = includesSettings
                  ? '該導出數據包含了明文密鑰，請不要發送給任何人'
                  : '該導出內容安全，可以用於分享';
              if (!window.confirm(`${msg}\n\n點「確定」繼續導出，「取消」中止。`)) {
                  trackEvent('取消导出前的密钥确认', { mode });
                  return;
              }
          }

          // Trigger export (Context handles loading state UI)
          const blob = await exportSystem(mode);
          
          const fileName = `Sully_Backup_${mode}_${new Date().toISOString().slice(0, 10)}.zip`;
          if (!Capacitor.isNativePlatform()) {
              // 網頁額外保留一條手動下載鏈接，作為瀏覽器禁用文件分享/自動下載時的最終救援。
              if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
              const url = URL.createObjectURL(blob);
              downloadUrlRef.current = url;
              setDownloadUrl(url);
              setDownloadFileName(fileName);
              setShowExportModal(true);
          }
          const result = await shareOrDownloadBlob({
              blob,
              fileName,
              shareTitle: 'Sully Backup',
              nativeChunked: true,
          });
          if (result === 'cancelled') return;
      } catch (e: any) {
          // 只報導出檔位，錯誤文案是動態串不能進屬性
          trackEvent('导出备份失败', { mode });
          addToast(e.message, 'error');
      }
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Pass the File object directly to importSystem
      importSystem(file).catch(err => {
          console.error(err);
          // 只上報歸類後的固定枚舉：報錯原文（可能含文件路徑/內容片段）只留在 console
          const rawMessage = String(err?.message || '');
          trackEvent('导入备份失败', {
              source: file.name.toLowerCase().endsWith('.zip') ? 'zip' : 'json',
              reason:
                  /无效的文件格式/.test(rawMessage) ? 'invalid_file_format'
                  : /缺少 data\.json/.test(rawMessage) ? 'missing_data_json'
                  : /manifest\.json 解析失败/.test(rawMessage) ? 'bad_manifest'
                  : /JSON 格式错误/.test(rawMessage) ? 'json_syntax'
                  : 'other',
          });
          const details = err?.stack || err?.message || String(err || '未知錯誤');
          showError('導入失敗', details);
          addToast('導入失敗，錯誤信息已展開', 'error');
      });
      
      if (importInputRef.current) importInputRef.current.value = '';
  };

  const deliverStandaloneBackup = async (blob: Blob, fileName: string, shareTitle: string) => {
      if (!Capacitor.isNativePlatform()) {
          if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
          const url = URL.createObjectURL(blob);
          downloadUrlRef.current = url;
          setDownloadUrl(url);
          setDownloadFileName(fileName);
          setShowExportModal(true);
      }
      await shareOrDownloadBlob({ blob, fileName, shareTitle, nativeChunked: true });
  };

  const handleAvatarModelExport = async () => {
      if (avatarModelBackupBusy) return;
      setAvatarModelBackupBusy(true);
      setAvatarModelBackupProgress({ phase: 'scan', done: 0, total: 1, label: '正在讀取本地模型…' });
      try {
          const blob = await createAvatarModelBackup(setAvatarModelBackupProgress);
          const fileName = `Sully_Models_${new Date().toISOString().slice(0, 10)}_${Date.now()}.zip`;
          await deliverStandaloneBackup(blob, fileName, 'Sully 模型備份');
          addToast(`模型備份已生成（${formatBackupBytes(blob.size)}）`, 'success');
      } catch (error: any) {
          const details = error?.stack || error?.message || String(error || '未知錯誤');
          showError('模型備份導出失敗', details);
          addToast(error?.message || '模型備份導出失敗', 'error');
      } finally {
          setAvatarModelBackupBusy(false);
          setAvatarModelBackupProgress(null);
          void refreshAvatarModelInventory();
      }
  };

  const handleAvatarModelImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      if (!files.length || avatarModelBackupBusy) return;
      setAvatarModelBackupBusy(true);
      let restored = 0;
      let skipped = 0;
      let restoredBytes = 0;
      try {
          for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
              const file = files[fileIndex];
              const result = await restoreAvatarModelBackup(file, progress => {
                  setAvatarModelBackupProgress({
                      ...progress,
                      label: files.length > 1 ? `[${fileIndex + 1}/${files.length}] ${progress.label}` : progress.label,
                  });
              });
              restored += result.restored;
              skipped += result.skipped;
              restoredBytes += result.restoredBytes;
              for (const model of result.models) {
                  updateCharacter(model.characterId, { videoAvatar: model.config });
              }
          }
          await refreshAvatarModelInventory();
          addToast(
              skipped > 0
                  ? `已恢復 ${restored} 個模型，跳過 ${skipped} 個未找到的角色`
                  : `已順序恢復 ${restored} 個模型（${formatBackupBytes(restoredBytes)}）`,
              skipped > 0 ? 'info' : 'success',
          );
      } catch (error: any) {
          const details = error?.stack || error?.message || String(error || '未知錯誤');
          showError('模型備份導入失敗', details);
          addToast(restored > 0 ? `已恢復 ${restored} 個模型後中斷` : '模型備份導入失敗', 'error');
      } finally {
          setAvatarModelBackupBusy(false);
          setAvatarModelBackupProgress(null);
          if (avatarModelBackupInputRef.current) avatarModelBackupInputRef.current.value = '';
      }
  };
  // Cloud Backup Handlers
  const handleTestCloudConnection = async () => {
      setCloudTesting(true);
      setCloudTestResult('');
      try {
          const { testConnection } = await import('../utils/webdavClient');
          const tempConfig = { ...cloudBackupConfig, webdavUrl: cbUrl, username: cbUsername, password: cbPassword, remotePath: cbPath };
          const result = await testConnection(tempConfig);
          setCloudTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          // 失敗原因收斂成固定幾類，地址/帳號/密碼與原始報錯都不上報
          if (result.ok) {
              trackEvent('测试 WebDAV 连接', { result: '成功' });
          } else {
              const m = result.message || '';
              trackEvent('测试 WebDAV 连接', {
                  result: '失败',
                  failure_kind:
                      /认证失败/.test(m) ? 'auth_401'
                      : /无法创建/.test(m) ? 'dir_missing_uncreatable'
                      : /服务器返回/.test(m) ? 'http_status'
                      : 'network_error',
              });
          }
      } catch (e: any) {
          trackEvent('测试 WebDAV 连接', { result: '失败', failure_kind: 'network_error' });
          setCloudTestResult(`✗ ${e.message}`);
      }
      setCloudTesting(false);
  };

  const handleSaveCloudConfig = () => {
      updateCloudBackupConfig({
          enabled: true,
          provider: 'webdav',
          webdavUrl: cbUrl, username: cbUsername, password: cbPassword,
          remotePath: cbPath,
      });
      addToast('雲端備份配置已保存', 'success');
      setShowCloudModal(false);
  };

  // 保存 / 恢復主代理 Worker 地址
  // 主動消息那邊的搜索、Notion、飛書全經這個地址轉發（tool_config.proxyWorkerUrl），
  // 所以改完必須把 tool_config 重傳一次——不然雲端還指著舊地址，角色到點的工具全靜默失靈。
  const handleSaveProxyWorker = () => {
      const raw = proxyWorkerInput.trim();
      if (raw && !/^https?:\/\//i.test(raw)) {
          addToast('地址必須以 http:// 或 https:// 開頭', 'error');
          trackEvent('代理地址格式被拒');
          return;
      }
      setProxyWorkerUrl(raw);                 // 傳空 / 默認地址 → 自動回落默認
      const applied = getProxyWorkerUrl();
      setProxyWorkerInput(applied);
      // 上雲那份的 proxyWorkerUrl 是現算的（讀 getProxyWorkerUrl），所以要在生效之後再傳。
      syncAmsgToolConfig(realtimeConfig);
      if (applied === DEFAULT_PROXY_WORKER) trackEvent('恢复默认代理 Worker', { via: 'save-empty' });
      addToast(applied === DEFAULT_PROXY_WORKER ? '已恢復為默認 Worker' : 'Worker 地址已保存', 'success');
  };

  const handleResetProxyWorker = () => {
      setProxyWorkerUrl('');
      setProxyWorkerInput(getProxyWorkerUrl());
      syncAmsgToolConfig(realtimeConfig);
      trackEvent('恢复默认代理 Worker', { via: 'reset-button' });
      addToast('已恢復為默認 Worker', 'info');
  };

  const handleCheckFirecrawl = async () => {
      const key = firecrawlKeyInput.trim();
      if (!key) {
          setFirecrawlApiKey('');
          setFirecrawlUsage(null);
          setFirecrawlCheckResult({ ok: false, text: '請先填寫 Firecrawl API Key' });
          return;
      }
      setFirecrawlChecking(true);
      setFirecrawlCheckResult(null);
      try {
          const usage = await getFirecrawlCreditUsage(key);
          setFirecrawlApiKey(key);
          setFirecrawlKeyInput(key);
          setFirecrawlUsage(usage);
          setFirecrawlCheckResult({ ok: true, text: 'Key 有效，網頁讀取已啟用' });
          addToast('Firecrawl 已連接', 'success');
      } catch (error: any) {
          setFirecrawlUsage(null);
          setFirecrawlCheckResult({ ok: false, text: error?.message || 'Firecrawl 連接失敗' });
      } finally {
          setFirecrawlChecking(false);
      }
  };

  const handleClearFirecrawl = () => {
      setFirecrawlApiKey('');
      setFirecrawlKeyInput('');
      setFirecrawlUsage(null);
      setFirecrawlCheckResult(null);
      addToast('已停用 Firecrawl，網頁讀取將繼續使用原有兜底', 'info');
  };

  const handleCloudBackup = async (mode: 'text_only' | 'full') => {
      try { await cloudBackupToWebDAV(mode); } catch { /* toast handled in context */ }
  };

  const handleOpenCloudRestore = async () => {
      setShowCloudRestoreModal(true);
      setCloudBackupFiles([]);
      setCloudBackupListState('loading');
      setCloudBackupListError('');
      try {
          const files = await listCloudBackups();
          setCloudBackupFiles(files);
          setCloudBackupListState('ready');
          trackEvent('加载云端备份列表', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav', result: '成功' });
      } catch (error: any) {
          const message = error?.message || '獲取雲端備份列表失敗';
          setCloudBackupListError(message);
          setCloudBackupListState('error');
          trackEvent('加载云端备份列表', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav', result: '失败' });
          addToast(message, 'error');
      }
  };

  const handleCloudRestore = async (file: import('../types').CloudBackupFile) => {
      if (file.status === 'incomplete') {
          addToast(file.statusMessage || '這個備份上傳未完成，暫時不能恢復', 'error');
          return;
      }
      setShowCloudRestoreModal(false);
      try {
          await cloudRestoreFromWebDAV(file);
      } catch (err: any) {
          // 只區分「下載階段」還是「導入階段」，報錯原文只進 showError / console
          trackEvent('从云端恢复失败', {
              provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav',
              stage: /^恢复失败/.test(String(err?.message || '')) ? 'import' : 'download',
          });
          const details = err?.stack || err?.message || String(err || '未知錯誤');
          showError('雲端恢復失敗', details);
      }
  };

  // GitHub backup handlers — single "測試並連接" button does verify-token +
  // ensure-repo, persists owner/login on success so users never type 'owner'.
  const handleTestGithub = async () => {
      if (!ghToken.trim()) {
          trackEvent('测试并连接 GitHub', { result: '失败', failure_stage: 'no_token' });
          setGhTestResult('✗ 請先粘貼 Token');
          return;
      }
      setGhTesting(true);
      setGhTestResult('');
      try {
          const { testConnection } = await import('../utils/githubClient');
          const result = await testConnection({
              ...cloudBackupConfig,
              githubToken: ghToken.trim(),
              githubRepo: ghRepo.trim() || 'sully-backup',
              githubUseProxy: ghUseProxy,
              githubProxyConsentVersion: ghUseProxy ? 1 : undefined,
          });
          setGhTestResult(result.ok ? `✓ ${result.message}` : `✗ ${result.message}`);
          // 失敗時只報卡在哪一步：token 校驗沒過 → 沒有 login，倉庫準備沒過 → 有 login
          trackEvent('测试并连接 GitHub', result.ok
              ? { result: '成功' }
              : { result: '失败', failure_stage: result.login ? 'ensure_repo' : 'verify_token' });
          if (result.ok && result.login) {
              updateCloudBackupConfig({
                  enabled: true,
                  provider: 'github',
                  githubToken: ghToken.trim(),
                  githubOwner: result.login,
                  githubRepo: ghRepo.trim() || 'sully-backup',
                  githubUseProxy: ghUseProxy,
                  githubProxyConsentVersion: ghUseProxy ? 1 : undefined,
              });
          }
      } catch (e: any) {
          trackEvent('测试并连接 GitHub', { result: '失败', failure_stage: 'exception' });
          setGhTestResult(`✗ ${e?.message || '連接失敗'}`);
      }
      setGhTesting(false);
  };

  const handleGithubProxyToggle = (enabled: boolean) => {
      setGhUseProxy(enabled);
      // 勾選本身就是用戶對中轉的明確同意，立即持久化。舊行為只有再次完成
      // “測試並連接”才保存，用戶可能勾完直接關閉，實際上傳仍在走直連。
      updateCloudBackupConfig({
          githubUseProxy: enabled,
          githubProxyConsentVersion: enabled ? 1 : undefined,
      });
      trackEvent('切换 GitHub 备份线路', { route: enabled ? 'cloudflare_worker' : 'direct' });
      addToast(
          enabled ? '已改用應用內 Cloudflare 中轉，下次備份立即生效' : '已改為直連 GitHub 附件域名',
          'info',
      );
  };

  const handleDisableCloud = () => {
      trackEvent('关闭云端备份', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav' });
      updateCloudBackupConfig({ enabled: false });
      setShowCloudModal(false);
      setShowGithubModal(false);
      addToast('雲端備份已關閉', 'info');
  };

  // One-click provider switch — if the target provider was already configured
  // before, just flip the 'provider' field and show a toast. Otherwise open
  // the setup modal. Critically: switching does NOT touch the other side's
  // saved credentials, so old WebDAV users keep their old backups visible
  // when they switch back.
  const switchToGithub = () => {
      trackEvent('切换云端备份服务商', { to: 'github' });
      if (cloudBackupConfig.githubToken && cloudBackupConfig.githubOwner) {
          updateCloudBackupConfig({ provider: 'github' });
          addToast(`已切換到 GitHub @${cloudBackupConfig.githubOwner}`, 'success');
      } else {
          setShowGithubModal(true);
      }
  };
  const switchToWebDAV = () => {
      trackEvent('切换云端备份服务商', { to: 'webdav' });
      if (cloudBackupConfig.webdavUrl && cloudBackupConfig.username) {
          updateCloudBackupConfig({ provider: 'webdav' });
          addToast('已切換回 WebDAV，舊備份依舊在', 'success');
      } else {
          setShowCloudModal(true);
      }
  };

  const confirmReset = () => {
      resetSystem();
      setShowResetConfirm(false);
  };

  // 保存實時感知配置
  const handleSaveRealtimeConfig = () => {
      const updates = {
          weatherEnabled: rtWeatherEnabled,
          weatherApiKey: rtWeatherKey,
          weatherCity: rtWeatherCity,
          newsEnabled: rtNewsEnabled,
          newsApiKey: rtNewsApiKey,
          newsPlatforms: rtNewsPlatforms,
          notionEnabled: rtNotionEnabled,
          notionApiKey: rtNotionKey,
          notionDatabaseId: rtNotionDbId,
          notionNotesDatabaseId: rtNotionNotesDbId || undefined,
          feishuEnabled: rtFeishuEnabled,
          feishuAppId: rtFeishuAppId,
          feishuAppSecret: rtFeishuAppSecret,
          feishuBaseId: rtFeishuBaseId,
          feishuTableId: rtFeishuTableId,
          xhsEnabled: rtXhsEnabled,
          xhsMcpConfig: {
              enabled: rtXhsMcpEnabled,
              mode: rtXhsMode,
              serverUrl: rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl,
              cookie: rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined,
              platform: rtXhsMode === 'lite' ? rtXhsPlatform : undefined,
              loggedInNickname: rtXhsNickname || undefined,
              loggedInUserId: rtXhsUserId || undefined,
              userXsecToken: realtimeConfig.xhsMcpConfig?.userXsecToken,
          }
      };
      updateRealtimeConfig(updates);
      RealtimeContextManager.clearCache();
      const nextRealtimeConfig = { ...realtimeConfig, ...updates };
      // 雲端憑據 + 按配置裁剪過的提示詞一起刷，否則角色到點會照著舊提示詞調已關掉的工具。
      syncAmsgToolConfigAndPrompts(nextRealtimeConfig, { characters, userProfile, groups });
      addToast('實時感知配置已保存', 'success');
      setShowRealtimeModal(false);
  };

  // 測試天氣API連接：填了 key 測 OpenWeatherMap，沒填測免費的 Open-Meteo
  const testWeatherApi = async () => {
      if (!rtWeatherCity) {
          setRtTestStatus('請先填寫城市');
          return;
      }
      setRtTestStatus('正在測試...');
      try {
          const weather = rtWeatherKey
              ? await fetchOwmWeather(rtWeatherCity, rtWeatherKey)
              : await fetchOpenMeteoWeather(rtWeatherCity);
          const source = rtWeatherKey ? 'OpenWeatherMap' : 'Open-Meteo';
          // 刻意不帶數據源名：那等價於「有沒有填天氣 key」，屬於配置狀態
          trackEvent('测试天气数据源连接', { result: 'ok' });
          setRtTestStatus(`連接成功！(${source}) ${weather.city}: ${weather.description}, ${weather.temp}°C`);
      } catch (e: any) {
          trackEvent('测试天气数据源连接', { result: 'failed' });
          setRtTestStatus(`連接失敗: ${e.message}`);
      }
  };

  // 測試Notion連接
  const testNotionApi = async () => {
      if (!rtNotionKey || !rtNotionDbId) {
          setRtTestStatus('請填寫 Notion API Key 和 Database ID');
          return;
      }
      setRtTestStatus('正在測試 Notion 連接...');
      try {
          const result = await NotionManager.testConnection(rtNotionKey, rtNotionDbId);
          trackEvent('测试 Notion 连接', { result: result.success ? 'ok' : 'failed' });
          setRtTestStatus(result.message);
      } catch (e: any) {
          trackEvent('测试 Notion 连接', { result: 'network-error' });
          setRtTestStatus(`網絡錯誤: ${e.message}`);
      }
  };

  // 測試飛書連接
  const testFeishuApi = async () => {
      if (!rtFeishuAppId || !rtFeishuAppSecret || !rtFeishuBaseId || !rtFeishuTableId) {
          setRtTestStatus('請填寫飛書 App ID、App Secret、多維表格 ID 和數據表 ID');
          return;
      }
      setRtTestStatus('正在測試飛書連接...');
      try {
          const result = await FeishuManager.testConnection(rtFeishuAppId, rtFeishuAppSecret, rtFeishuBaseId, rtFeishuTableId);
          trackEvent('测试飞书连接', { result: result.success ? 'ok' : 'failed' });
          setRtTestStatus(result.message);
      } catch (e: any) {
          trackEvent('测试飞书连接', { result: 'network-error' });
          setRtTestStatus(`網絡錯誤: ${e.message}`);
      }
  };

  // 測試小紅書 Bridge 連接
  const testXhsMcp = async () => {
      const urlToUse = rtXhsMode === 'lite' ? XHS_LITE_URL : rtXhsLocalUrl;
      const cookieToUse = rtXhsMode === 'lite' ? (rtXhsCookie.trim() || undefined) : undefined;
      if (!urlToUse) {
          setRtTestStatus('請填寫服務器 URL');
          return;
      }
      if (rtXhsMode === 'lite' && !cookieToUse) {
          setRtTestStatus('請先粘貼小紅書 cookie');
          return;
      }
      setRtTestStatus('正在連接...');
      try {
          const result = await XhsMcpClient.testConnection(
              urlToUse,
              cookieToUse,
          );
          if (result.connected) {
              // 暱稱 / 用戶 ID / xsecToken 一律不帶
              trackEvent('测试小红书桥接连接', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'connected' });
              const toolCount = result.tools?.length || 0;
              const tokenInfo = result.xsecToken ? ' | xsecToken 已獲取' : '';
              const platformInfo = result.platform ? ` | 平台: ${result.platform === 'rednote' ? 'RedNote' : '小紅書'}` : '';
              const loginInfo = result.loggedIn
                  ? `${platformInfo} | ${result.nickname ? `帳號: ${result.nickname}` : '已登錄'}${result.userId ? ` (ID: ${result.userId})` : ''}${tokenInfo}`
                  : ' | 未登錄，請檢查 cookie 或登錄小紅書';
              setRtTestStatus(`連接成功! ${toolCount} 個功能可用${loginInfo}`);
              // 自動填充：只在用戶未手動填寫時覆蓋
              if (result.nickname && !rtXhsNickname) setRtXhsNickname(result.nickname);
              if (result.userId && !rtXhsUserId) setRtXhsUserId(result.userId);
              setRtXhsPlatform(result.platform);
              const xhsUpdates = {
                  xhsMcpConfig: {
                      enabled: rtXhsMcpEnabled,
                      mode: rtXhsMode,
                      serverUrl: urlToUse,
                      cookie: cookieToUse,
                      platform: result.platform,
                      loggedInNickname: rtXhsNickname || result.nickname,
                      loggedInUserId: rtXhsUserId || result.userId,
                      userXsecToken: result.xsecToken,
                  }
              };
              updateRealtimeConfig(xhsUpdates);
              const nextConfig = { ...realtimeConfig, ...xhsUpdates };
              syncAmsgToolConfigAndPrompts(nextConfig, { characters, userProfile, groups });
          } else {
              trackEvent('测试小红书桥接连接', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'failed' });
              setRtTestStatus(`連接失敗: ${result.error}`);
          }
      } catch (e: any) {
          trackEvent('测试小红书桥接连接', { mode: rtXhsMode === 'lite' ? 'lite' : 'local', result: 'network-error' });
          setRtTestStatus(`網絡錯誤: ${e.message}`);
      }
  };

  // 麥當勞 MCP: 改 token / 啟用態都即時落 localStorage; "測試連接"調 initialize+tools/list
  const handleMcdTokenChange = (v: string) => {
      setMcdTokenState(v);
      saveMcdToken(v);
      resetMcdSession();
      setMcdTestStatus('');
  };
  const handleMcdEnabledChange = (v: boolean) => {
      setMcdEnabledState(v);
      saveMcdEnabled(v);
      if (!v) resetMcdSession();
  };
  const testMcdApi = async () => {
      if (!mcdToken.trim()) { setMcdTestStatus('請先填寫 MCP Token'); return; }
      setMcdTesting(true);
      setMcdTestStatus('正在連接麥當勞 MCP...');
      try {
          const r = await testMcdConnection();
          if (r.ok) {
              trackEvent('测试点单 MCP 连接', { provider: 'mcdonalds', result: 'ok' });
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setMcdTestStatus(`✅ ${r.message}${names ? `\n工具: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              trackEvent('测试点单 MCP 连接', { provider: 'mcdonalds', result: 'failed' });
              setMcdTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          trackEvent('测试点单 MCP 连接', { provider: 'mcdonalds', result: 'exception' });
          setMcdTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setMcdTesting(false);
      }
  };

  // 瑞幸 MCP (與麥當勞同構)
  const handleLuckinTokenChange = (v: string) => {
      setLuckinTokenState(v);
      saveLuckinToken(v);
      resetLuckinSession();
      setLuckinTestStatus('');
  };
  const handleLuckinEnabledChange = (v: boolean) => {
      setLuckinEnabledState(v);
      saveLuckinEnabled(v);
      if (!v) resetLuckinSession();
  };
  const testLuckinApi = async () => {
      if (!luckinToken.trim()) { setLuckinTestStatus('請先填寫 MCP Token'); return; }
      setLuckinTesting(true);
      setLuckinTestStatus('正在連接瑞幸 MCP...');
      try {
          const r = await testLuckinConnection();
          if (r.ok) {
              trackEvent('测试点单 MCP 连接', { provider: 'luckin', result: 'ok' });
              const names = (r.tools || []).map(t => t.name).slice(0, 6).join(', ');
              setLuckinTestStatus(`✅ ${r.message}${names ? `\n工具: ${names}${(r.tools || []).length > 6 ? ' ...' : ''}` : ''}`);
          } else {
              trackEvent('测试点单 MCP 连接', { provider: 'luckin', result: 'failed' });
              setLuckinTestStatus(`❌ ${r.message}`);
          }
      } catch (e: any) {
          trackEvent('测试点单 MCP 连接', { provider: 'luckin', result: 'exception' });
          setLuckinTestStatus(`❌ ${e?.message || String(e)}`);
      } finally {
          setLuckinTesting(false);
      }
  };

  return (
    <div className="h-full w-full bg-[#f3f4f8] flex flex-col font-light relative isolate">

      {/* GLOBAL PROGRESS OVERLAY */}
      {sysOperation.status === 'processing' && (
          <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center animate-fade-in">
              <div className="bg-white p-6 rounded-3xl shadow-2xl flex flex-col items-center gap-4 w-64">
                  <div className="w-12 h-12 border-4 border-slate-200 border-t-primary rounded-full animate-spin"></div>
                  <div className="text-sm font-bold text-slate-700 text-center leading-relaxed whitespace-pre-wrap break-words max-w-full">{sysOperation.message}</div>
                  {sysOperation.progress > 0 && (
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${sysOperation.progress}%` }}></div>
                      </div>
                  )}
              </div>
          </div>
      )}

      {/* Header */}
      <div className="bg-[#fffefe] border-b border-slate-200 shrink-0 z-10 sticky top-0" style={{ paddingTop: 'var(--safe-top)' }}>
        <div className="flex items-center px-4 py-3">
        <div className="flex items-center gap-2 w-full">
            <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
            </button>
            <h1 className="text-xl font-medium text-slate-700 tracking-wide">系統設置</h1>
        </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 no-scrollbar pb-20">

        {/* 外觀救急入口統一放在設置頂部，無需進入已被錯誤 CSS 遮住的聊天或日記。 */}
        <SettingsSection
            title="外觀急救"
            badge={hasJournalAppearanceOverride
                ? <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-bold shrink-0">日記美化已啟用</span>
                : undefined}
            icon={
                <div className="p-2 bg-amber-100/70 rounded-xl text-amber-700">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.7} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17 17.25 21a2.12 2.12 0 0 0 3-3l-5.84-5.84M11.42 15.17l2.83-2.83M11.42 15.17l-4.68 4.68a2.121 2.121 0 0 1-3-3l6.59-6.59m4.08 1.9 2.83-2.83m0 0 1.5-1.5a2.121 2.121 0 0 0-3-3l-1.5 1.5m3 3-3-3m-3.91 3.91-4.95-4.95a2.121 2.121 0 0 0-3 3l4.95 4.95" /></svg>
                </div>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                如果交換日記的自定義 CSS 把返回鍵、設置鍵遮住或變得無法點擊，可以從這裡直接清除日記主題與 CSS，不影響日記內容。
            </p>
            <button
                type="button"
                disabled={!hasJournalAppearanceOverride}
                onClick={handleJournalAppearanceEmergencyReset}
                className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white shadow-sm transition active:scale-[.98] disabled:bg-slate-100 disabled:text-slate-400 disabled:shadow-none"
            >
                {hasJournalAppearanceOverride ? '重置交換日記美化' : '交換日記當前為原版'}
            </button>
            <div className="mt-4 border-t border-slate-100 pt-4">
                <p className="text-xs text-slate-500 leading-relaxed">聊天白框 CSS 導致界面異常、無法進入角色設置時，還原全局及全部角色的白框美化，其他聊天外觀設置不受影響。</p>
                <button type="button"
                    onClick={() => { if (window.confirm('確定還原全部聊天白框美化？將清空「全局」以及「每個角色」的自定義 CSS（其它聊天外觀設置不受影響）。')) resetAllChromeCss(); }}
                    className="mt-3 w-full rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white shadow-sm transition active:scale-[.98]">
                    一鍵還原全部聊天白框美化（救援）
                </button>
            </div>
            <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-sm font-bold text-rose-500 uppercase tracking-widest">一鍵還原外觀</h2>
                </div>
                <p className="text-[10px] text-slate-500 mb-3 leading-relaxed">
                    把主題色、壁紙、字體、應用圖標、桌面小組件、裝飾貼紙全部還原成最初始狀態。在不同版本之間反覆導入預設導致圖標錯亂時使用。<br/>
                    <span className="text-slate-400">已保存的外觀預設不會被刪除，隨時還能切回去。</span>
                </p>
                {!confirmAppearanceReset ? (
                    <button onClick={() => setConfirmAppearanceReset(true)}
                        className="w-full py-2.5 bg-white text-rose-500 font-bold text-xs rounded-xl border border-rose-200 active:scale-95 transition-transform flex items-center justify-center gap-2">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></svg>
                        還原為初始外觀
                    </button>
                ) : (
                    <div className="flex gap-2">
                        <button onClick={handleAppearanceEmergencyReset} disabled={resettingAppearance}
                            className="flex-1 py-2.5 bg-rose-500 text-white font-bold text-xs rounded-xl shadow-sm active:scale-95 transition-transform disabled:opacity-50">
                            {resettingAppearance ? '正在還原...' : '確認還原'}
                        </button>
                        <button onClick={() => setConfirmAppearanceReset(false)} disabled={resettingAppearance}
                            className="flex-1 py-2.5 bg-white text-slate-500 font-bold text-xs rounded-xl border border-slate-200 active:scale-95 transition-transform disabled:opacity-50">
                            取消
                        </button>
                    </div>
                )}
            </div>

        </SettingsSection>
        
        {/* 數據備份區域 */}
        <SettingsSection
            title="備份與恢復 (ZIP)"
            icon={
                <div className="p-2 bg-blue-100 rounded-xl text-blue-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" /></svg>
                </div>
            }
        >
            <StorageUsagePanel />

            <div className="mb-3">
                <button onClick={() => handleExport('full')} className="w-full py-4 bg-gradient-to-r from-violet-500 to-purple-600 border border-violet-300 rounded-xl text-xs font-bold text-white shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden mb-3">
                    <div className="absolute top-0 right-0 px-1.5 py-0.5 bg-white/20 text-[9px] text-white rounded-bl-lg font-bold">完整</div>
                    <div className="p-2 bg-white/20 rounded-full"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg></div>
                    <span>整合導出 (文字+媒體)</span>
                </button>
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-3 text-center">以下為分步導出，適合低配設備分次備份</p>

            <div className="grid grid-cols-2 gap-3 mb-3">
                <button onClick={() => handleExport('text_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 relative overflow-hidden">
                    <div className="p-2 bg-blue-50 rounded-full text-blue-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg></div>
                    <span>純文字備份</span>
                </button>
                 <button onClick={() => handleExport('media_only')} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2">
                    <div className="p-2 bg-pink-50 rounded-full text-pink-500"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" /></svg></div>
                    <span>媒體與美化素材</span>
                </button>
            </div>

            <div className="grid grid-cols-1 gap-3 mb-4">
                 <div onClick={() => importInputRef.current?.click()} className="py-4 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-2 cursor-pointer hover:bg-emerald-50 hover:border-emerald-200">
                    <div className="p-2 bg-emerald-100 rounded-full text-emerald-600"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg></div>
                    <span>導入備份 (.zip / .json)</span>
                </div>
                <input type="file" ref={importInputRef} className="hidden" accept=".json,.zip" onChange={handleImport} />
            </div>

            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                • <b>整合導出</b>: 一次性導出文字與圖片媒體；VRM / Live2D 模型請使用下方獨立備份。<br/>
                • <b>純文字備份</b>: 包含所有聊天記錄、角色設定、劇情數據。所有圖片會被移除（減小體積）。<br/>
                • <b>媒體與美化素材</b>: 導出相冊、表情包、聊天圖片、頭像、主題氣泡、壁紙、圖標等圖片資源和外觀配置。<br/>
                • <b>語音範圍</b>: 整合/媒體備份僅包含已收藏語音，以及 Live2D 開機、觸摸預設實際引用的語音；未收藏的聊天、通話等臨時語音不會導出。<br/>
                • 兼容舊版 JSON 備份文件的導入。
            </p>

            <div data-testid="avatar-model-backup-section" className="mb-5 border-y border-violet-100 py-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-xs font-bold text-slate-700">視頻模型 · 單獨備份</h3>
                        <p className="mt-0.5 text-[10px] text-slate-400">VRM / Live2D 不再混進普通數據包</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-bold text-violet-600">
                        {avatarModelInventory
                            ? `${avatarModelInventory.availableCount} 個 · ${formatBackupBytes(avatarModelInventory.totalBytes)}`
                            : '正在掃描…'}
                    </span>
                </div>

                {avatarModelInventory && avatarModelInventory.models.length > 0 && (
                    <div className="mb-3 divide-y divide-slate-100 border-y border-slate-100">
                        {avatarModelInventory.models.map(model => (
                            <div key={model.characterId} className="flex items-center justify-between gap-3 py-2">
                                <div className="min-w-0">
                                    <p className="truncate text-[11px] font-semibold text-slate-600">{model.characterName}</p>
                                    <p className="truncate text-[9px] uppercase tracking-wide text-slate-400">{model.format} · {model.fileName}</p>
                                </div>
                                <span className={`shrink-0 text-[10px] font-medium ${model.available ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {model.available ? formatBackupBytes(model.byteLength) : '文件缺失'}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={handleAvatarModelExport}
                        disabled={avatarModelBackupBusy || !avatarModelInventory?.availableCount}
                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-violet-600 px-3 text-xs font-bold text-white transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V3.75m0 0 4.5 4.5M12 3.75l-4.5 4.5M3.75 15v4.125c0 .621.504 1.125 1.125 1.125h14.25c.621 0 1.125-.504 1.125-1.125V15" /></svg>
                        導出模型包
                    </button>
                    <button
                        type="button"
                        onClick={() => avatarModelBackupInputRef.current?.click()}
                        disabled={avatarModelBackupBusy}
                        className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-violet-200 bg-white px-3 text-xs font-bold text-violet-600 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="h-4 w-4"><path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v12m0 0 4.5-4.5M12 19.5 7.5 15M3.75 9V4.875c0-.621.504-1.125 1.125-1.125h14.25c.621 0 1.125.504 1.125 1.125V9" /></svg>
                        順序導入
                    </button>
                    <input
                        ref={avatarModelBackupInputRef}
                        type="file"
                        accept=".zip,application/zip"
                        multiple
                        className="hidden"
                        onChange={handleAvatarModelImport}
                    />
                </div>

                {avatarModelBackupProgress && (
                    <div className="mt-3" aria-live="polite">
                        <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-violet-600">
                            <span className="truncate">{avatarModelBackupProgress.label}</span>
                            <span className="shrink-0 font-bold">
                                {Math.min(100, Math.round((avatarModelBackupProgress.done / Math.max(1, avatarModelBackupProgress.total)) * 100))}%
                            </span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-violet-100">
                            <div
                                className="h-full rounded-full bg-violet-500 transition-[width] duration-200"
                                style={{ width: `${Math.min(100, Math.round((avatarModelBackupProgress.done / Math.max(1, avatarModelBackupProgress.total)) * 100))}%` }}
                            />
                        </div>
                    </div>
                )}

                <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                    一個 ZIP 可以包含多個角色模型。恢復時請先導入上方普通數據，再導入模型包；系統會逐個讀取、逐個寫入。一次選擇多個模型包時，也會按選擇順序處理。
                </p>
                {avatarModelInventory && avatarModelInventory.missingCount > 0 && (
                    <p className="mt-2 text-[10px] leading-relaxed text-rose-500">
                        有 {avatarModelInventory.missingCount} 個角色只剩模型索引，本地二進制已經丟失，無法導出。
                    </p>
                )}
            </div>
            {/* 備份提醒頻率：糯米機數據只在本機，隔 N 天沒導出會彈一次提醒 */}
            <div className="mb-4 p-3.5 bg-gradient-to-br from-rose-50 to-orange-50 border border-rose-100 rounded-xl">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-bold text-slate-600">備份提醒頻率</span>
                    <span className="text-xs font-bold text-rose-500">每 {backupReminderDays} 天</span>
                </div>
                <input
                    type="range"
                    min={BACKUP_REMINDER_MIN_DAYS}
                    max={BACKUP_REMINDER_MAX_DAYS}
                    step={1}
                    value={backupReminderDays}
                    onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        setBackupReminderDays(v);
                        setBackupReminderIntervalDays(v);
                    }}
                    className="w-full h-2 bg-rose-100 rounded-full appearance-none accent-rose-500"
                />
                <div className="flex justify-between text-[9px] text-slate-400 mt-1 px-0.5">
                    <span>{BACKUP_REMINDER_MIN_DAYS} 天</span>
                    <span>{BACKUP_REMINDER_MAX_DAYS} 天</span>
                </div>
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    超過這個天數沒有導出，就會彈窗提醒一次。
                    {backupDaysAgo == null
                        ? ' 你還沒有導出過備份，記得留一份哦。'
                        : ` 上次備份是在 ${backupDaysAgo} 天前。`}
                </p>
            </div>

            <button onClick={handleCleanupResidue} disabled={isCleaningResidue} className="w-full py-3 mb-2 bg-amber-50 border border-amber-100 text-amber-600 rounded-xl text-xs font-bold flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50">
                {isCleaningResidue ? '正在掃描…' : '一鍵清理表情包殘留'}
            </button>
            <p className="text-[10px] text-slate-400 px-1 mb-4 leading-relaxed">
                清理已刪除角色遺留的「幽靈表情包」：專屬分類的角色沒了之後，單聊表情面板看不到它、群聊面板卻還冒出來。先掃描列出結果，確認後才會刪除。
            </p>

            <button onClick={() => setShowResetConfirm(true)} className="w-full py-3 bg-red-50 border border-red-100 text-red-500 rounded-xl text-xs font-bold flex items-center justify-center gap-2">
                格式化系統 (出廠設置)
            </button>
        </SettingsSection>

        {/* 雲端備份區域 */}
        <SettingsSection
            title="雲端備份"
            icon={
                <div className="p-2 bg-sky-100 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                </div>
            }
        >
            {!cloudBackupConfig.enabled ? (
                <div className="space-y-3 py-2">
                    <p className="text-[11px] text-slate-400 leading-relaxed text-center">
                        把備份上傳到你自己的雲端，換設備、丟手機都不怕。<br/>
                        大文件推薦 <b>GitHub</b>（自動分片上傳）。
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => { trackEvent('连接云端备份服务商', { provider: 'github' }); setShowGithubModal(true); }}
                            className="py-3 px-2 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5 relative"
                        >
                            <span className="absolute top-1 right-1.5 text-[8px] bg-amber-300 text-slate-800 px-1.5 py-0.5 rounded-full font-bold">推薦</span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                            <span>GitHub</span>
                            <span className="text-[9px] text-slate-300 font-normal">大文件自動分片</span>
                        </button>
                        <button
                            onClick={() => { trackEvent('连接云端备份服务商', { provider: 'webdav' }); setShowCloudModal(true); }}
                            className="py-3 px-2 bg-gradient-to-br from-sky-500 to-blue-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1.5"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                            <span>WebDAV</span>
                            <span className="text-[9px] text-sky-100 font-normal">日本/NAS · 需梯子</span>
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-3">
                    <div className={`flex items-center justify-between rounded-xl px-3 py-2 ${cloudBackupConfig.provider === 'github' ? 'bg-slate-100' : 'bg-sky-50'}`}>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                            <span className="text-[11px] text-slate-600 font-medium">
                                已連接 · {cloudBackupConfig.provider === 'github'
                                    ? `GitHub${cloudBackupConfig.githubOwner ? ` (@${cloudBackupConfig.githubOwner})` : ''}`
                                    : 'WebDAV'}
                            </span>
                        </div>
                        <button
                            onClick={() => cloudBackupConfig.provider === 'github' ? setShowGithubModal(true) : setShowCloudModal(true)}
                            className={`text-[10px] font-medium ${cloudBackupConfig.provider === 'github' ? 'text-slate-600' : 'text-sky-500'}`}
                        >
                            修改配置
                        </button>
                    </div>

                    {/* Quick link to the GitHub releases page so the user knows
                        where their backups physically live and can browse /
                        delete them on github.com directly if they want. */}
                    {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                        <a
                            href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                            target="_blank" rel="noopener noreferrer"
                            className="block text-center text-[10px] text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline transition-colors"
                        >
                            🔗 在 GitHub 上查看備份 (github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases) ↗
                        </a>
                    )}

                    {/* Switch-provider hint — shown to existing users so the
                        new GitHub option is discoverable from the connected
                        state, not only on the first-time setup screen. If the
                        other provider was previously configured, the click is
                        a one-shot flip; old credentials and backups stay put. */}
                    {cloudBackupConfig.provider !== 'github' ? (
                        <>
                            <button
                                onClick={switchToGithub}
                                className="w-full py-2 bg-gradient-to-r from-slate-800 to-slate-900 text-white rounded-xl text-[11px] font-bold shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5"><path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0022 12.017C22 6.484 17.522 2 12 2z" /></svg>
                                <span>{cloudBackupConfig.githubToken ? '切換到 GitHub' : '試試 GitHub 備份（大文件自動分片）'}</span>
                            </button>
                            <p className="text-[10px] text-slate-400 text-center">
                                你 WebDAV 上的舊備份不會被動，可隨時切回。
                            </p>
                        </>
                    ) : (
                        <button
                            onClick={switchToWebDAV}
                            className="w-full py-1.5 text-[10px] text-slate-400 hover:text-sky-500 transition-colors"
                        >
                            {cloudBackupConfig.webdavUrl ? '切換回 WebDAV →' : '改用 WebDAV 備份 →'}
                        </button>
                    )}
                    {cloudBackupConfig.lastBackupTime && (
                        <p className="text-[10px] text-slate-400 text-center">
                            上次備份: {new Date(cloudBackupConfig.lastBackupTime).toLocaleString('zh-CN')}
                            {cloudBackupConfig.lastBackupSize && ` (${(cloudBackupConfig.lastBackupSize / 1024 / 1024).toFixed(1)} MB)`}
                        </p>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => handleCloudBackup('text_only')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-sky-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>備份到雲端</span>
                            <span className="text-[9px] text-slate-400">(純文字)</span>
                        </button>
                        <button
                            onClick={() => handleCloudBackup('full')}
                            className="py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex flex-col items-center gap-1"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-violet-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                            <span>備份到雲端</span>
                            <span className="text-[9px] text-slate-400">(完整)</span>
                        </button>
                    </div>

                    <button
                        onClick={handleOpenCloudRestore}
                        className="w-full py-3 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600 shadow-sm active:scale-95 transition-all flex items-center justify-center gap-2"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4 text-emerald-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9.75v6.75m0 0l-3-3m3 3l3-3m-8.25 6a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.233-2.33 3 3 0 013.758 3.848A3.752 3.752 0 0118 19.5H6.75z" /></svg>
                        從雲端恢復
                    </button>
                </div>
            )}

            <p className="text-[10px] text-slate-400 px-1 mt-3 leading-relaxed">
                備份始終存放在你自己的 WebDAV 或 GitHub 帳號中，項目不建立用戶備份數據庫。
                網頁 WebDAV 因跨域限制需要中轉；GitHub 默認直連，網絡受限時可自行開啟中轉。
            </p>
        </SettingsSection>

        {/* AI 連接設置區域 */}
        <SettingsSection
            title="API 配置"
            sectionProps={{ 'data-guide': 'api' }}
            icon={
                <div className="p-2 bg-emerald-100/50 rounded-xl text-emerald-600">
                   <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
                    </svg>
                </div>
            }
            actions={
                <button onClick={() => { setNewPresetName(''); setShowPresetModal(true); }} className="text-[10px] bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    新建預設
                </button>
            }
        >
            {/* Presets List */}
            {apiPresets.length > 0 && (
                <div className="mb-4">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block pl-1">我的預設 (Presets)</label>
                    <div className="flex gap-2 flex-wrap">
                        {apiPresets.map(preset => (
                            <div key={preset.id} className={`flex items-center rounded-lg pl-3 pr-1 py-1 shadow-sm border transition-colors ${
                                activePresetId === preset.id
                                    ? 'bg-primary/5 border-primary/30'
                                    : 'bg-white border-slate-200'
                            }`}>
                                <button type="button" onClick={() => applyPreset(preset)}
                                    title={`切換到 ${preset.name}`}
                                    className={`text-xs font-medium cursor-pointer mr-1.5 transition-colors ${
                                        activePresetId === preset.id ? 'text-primary' : 'text-slate-600 hover:text-primary'
                                    }`}>
                                    {preset.name}
                                    {activePresetId === preset.id && <span className="ml-1 text-[9px] font-bold">· 使用中</span>}
                                </button>
                                <button
                                    type="button"
                                    aria-label={`編輯預設 ${preset.name}`}
                                    title="編輯這條預設"
                                    onClick={(event) => { event.stopPropagation(); openEditPreset(preset); }}
                                    className="p-1 rounded-full text-slate-300 hover:bg-primary/10 hover:text-primary transition-colors">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M13.586 3.586a2 2 0 1 1 2.828 2.828l-.793.793-2.828-2.828.793-.793ZM11.379 5.793 3 14.172V17h2.828l8.38-8.379-2.83-2.828Z" /></svg>
                                </button>
                                <button
                                    type="button"
                                    aria-label={`長按或雙擊刪除預設 ${preset.name}`}
                                    title="長按或雙擊刪除"
                                    onPointerDown={(event) => { event.stopPropagation(); beginPresetDeleteHold(preset.id, preset.name); }}
                                    onPointerUp={cancelPresetDeleteHold}
                                    onPointerCancel={cancelPresetDeleteHold}
                                    onPointerLeave={cancelPresetDeleteHold}
                                    onDoubleClick={(event) => { event.stopPropagation(); deleteApiPreset(preset.id, preset.name); }}
                                    onContextMenu={(event) => event.preventDefault()}
                                    className={`p-1 rounded-full transition-colors select-none touch-none ${
                                        holdingDeletePresetId === preset.id
                                            ? 'bg-red-100 text-red-500 scale-110'
                                            : 'text-slate-300 hover:bg-red-50 hover:text-red-400'
                                    }`}>
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" /></svg>
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="text-[9px] text-slate-300 mt-1.5 pl-1">點名稱直接切換並生效；鉛筆改這條預設的內容；長按或雙擊 × 才會刪除。</p>
                </div>
            )}

            <div className="space-y-4">
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                    <input type="text" value={localUrl} onChange={(e) => setLocalUrl(e.target.value)} placeholder="https://..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                    <input type="password" value={localKey} onChange={(e) => setLocalKey(e.target.value)} placeholder="sk-..." className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                </div>

                {/* 高級（流式 / 溫度）— 默認摺疊，灰色低調，明確寫"不建議修改" */}
                <div className="pt-1">
                    <button
                        type="button"
                        onClick={() => setShowApiAdvanced(v => !v)}
                        className="text-[10px] text-slate-300 hover:text-slate-400 transition-colors flex items-center gap-1 pl-1 active:scale-95"
                    >
                        <span>高級（不建議修改）</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-2.5 h-2.5 transition-transform ${showApiAdvanced ? 'rotate-180' : ''}`}>
                            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                        </svg>
                    </button>
                    {showApiAdvanced && (
                        <div className="mt-2 pl-2 border-l-2 border-slate-100 space-y-3 py-2">
                            <p className="text-[10px] text-slate-300 leading-relaxed">
                                這兩項絕大多數用戶保持默認即可。除非接口報錯"only stream supported"或對回覆風格有強需求，否則不建議改。
                            </p>
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-[10px] text-slate-400">流式輸出 (Stream)</span>
                                    <p className="text-[9px] text-slate-300 mt-0.5">僅在你的 API 強制要求時打開</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setLocalStream(v => !v)}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${localStream ? 'bg-slate-400' : 'bg-slate-200'}`}
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${localStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                            </div>
                            <div>
                                <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-slate-400">溫度 (Temperature)</span>
                                    <span className="text-[10px] font-mono text-slate-400">{localTemperature.toFixed(2)}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="2"
                                    step="0.05"
                                    value={localTemperature}
                                    onChange={(e) => setLocalTemperature(parseFloat(e.target.value))}
                                    className="w-full accent-slate-400 mt-1"
                                />
                                <p className="text-[9px] text-slate-300 mt-0.5">默認 0.85；只作用於聊天和約會的主回覆</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="pt-2">
                     <div className="flex justify-between items-center mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                        <button onClick={fetchModels} disabled={isLoadingModels} className="text-[10px] text-primary font-bold">{isLoadingModels ? 'Fetching...' : '刷新模型列表'}</button>
                    </div>
                    
                    <button
                        onClick={() => setShowModelModal(true)}
                        title={localModel || 'Select Model...'}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm"
                    >
                        <span
                            className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left"
                            style={{ direction: 'rtl', textOverflow: 'ellipsis' }}
                        >
                            <bdi style={{ direction: 'ltr' }}>{localModel || 'Select Model...'}</bdi>
                        </span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 flex-shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                    </button>
                </div>

                <button onClick={handleSaveApi} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-primary/20 bg-primary active:scale-95 transition-all mt-2">
                    {statusMsg || '保存配置'}
                </button>
                {apiPresets.length > 0 && (
                    <p className="text-[9px] text-slate-300 px-1 leading-relaxed">
                        這裡改的是當前生效的配置，不會動上面的預設；要把改動存回某條預設，點它的鉛筆。
                    </p>
                )}

                <button
                    onClick={async () => {
                        if (!localUrl.trim() || !localKey.trim() || !localModel.trim()) return;
                        setTestingApi(true);
                        setTestApiResult(null);
                        try {
                            const res = await fetch(`${localUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localKey.trim()}` },
                                body: JSON.stringify({
                                    model: localModel.trim(),
                                    messages: [{ role: 'user', content: 'Hi' }],
                                    max_tokens: 5,
                                    stream: localStream,
                                }),
                            });
                            if (res.ok) {
                                // 走 safeResponseJson —— 它能透明把 SSE 流響應拼成普通 chat/completion 結構
                                const data = await safeResponseJson(res);
                                const reply = extractContent(data);
                                setTestApiResult(`✅ 連接成功 — 模型回覆: "${reply.slice(0, 30)}"`);
                            } else {
                                const text = await res.text().catch(() => '');
                                setTestApiResult(`❌ HTTP ${res.status}: ${text.slice(0, 100)}`);
                            }
                        } catch (err: any) {
                            setTestApiResult(`❌ 連接失敗: ${err.message}`);
                        } finally {
                            setTestingApi(false);
                        }
                    }}
                    disabled={testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()}
                    className={`w-full py-2.5 rounded-2xl font-bold text-sm border mt-2 active:scale-95 transition-all ${
                        testingApi || !localUrl.trim() || !localKey.trim() || !localModel.trim()
                            ? 'border-slate-200 text-slate-400 bg-slate-50'
                            : 'border-primary/30 text-primary bg-primary/5 hover:bg-primary/10'
                    }`}
                >
                    {testingApi ? '測試中...' : '🧪 測試連接'}
                </button>

                {testApiResult && (
                    <div className={`mt-2 text-xs px-3 py-2 rounded-xl ${
                        testApiResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {testApiResult}
                    </div>
                )}
            </div>
        </SettingsSection>

        {/* 獨立識圖 API：給不支持 image_url 的主模型補視覺能力；可手動從通用模型預設載入。 */}
        <SettingsSection
            title="識圖 API"
            badge={
                <span className={`text-[9px] font-bold px-2 py-1 rounded-full ${
                    apiConfig.visionApi?.enabled
                        ? 'bg-violet-100 text-violet-600'
                        : 'bg-slate-100 text-slate-400'
                }`}>
                    {apiConfig.visionApi?.enabled ? '已接入' : '未接入'}
                </span>
            }
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                </div>
            }
        >
            <div className="space-y-4">
                <div className="rounded-2xl border border-violet-100 bg-violet-50/60 p-3.5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-xs font-bold text-slate-600">接入獨立識圖 API</div>
                            <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                                適合 DeepSeek 等不能直接看圖的主模型。
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={localVisionEnabled}
                            onClick={handleToggleVisionApi}
                            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${localVisionEnabled ? 'bg-violet-500' : 'bg-slate-200'}`}
                        >
                            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${localVisionEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                    </div>
                </div>

                <p className="text-[10px] text-slate-400 leading-relaxed px-1">
                    開啟後，每張聊天圖片只會先交給這裡的視覺模型識別一次，並把結果寫成
                    <span className="font-semibold text-violet-600"> [圖片：模型看到的內容] </span>
                    再發給主 API；之後聊天和重 roll 都直接複用，不會重複識圖扣費。關閉時完全沿用原來的圖片發送邏輯。
                </p>

                <div className="rounded-2xl border border-violet-100 bg-white/70 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <label className="text-[10px] font-bold text-violet-500 uppercase tracking-widest">從模型預設載入</label>
                        <span className="text-[9px] text-slate-300">不會切換主 API</span>
                    </div>
                    {apiPresets.length > 0 ? (
                        <div className="flex gap-2 flex-wrap">
                            {apiPresets.map(preset => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => loadVisionApiPreset(preset)}
                                    className={`max-w-full px-3 py-1.5 rounded-lg border text-[11px] font-medium truncate transition-colors ${
                                        selectedVisionPresetId === preset.id
                                            ? 'bg-violet-100 border-violet-200 text-violet-700'
                                            : 'bg-white border-slate-200 text-slate-500 hover:border-violet-200'
                                    }`}
                                    title={`${preset.name} · ${preset.config.model || '未配置模型'}`}
                                >
                                    {preset.name}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <p className="text-[10px] text-slate-400 leading-relaxed">還沒有模型預設；可先在上方“API 配置”中保存預設，或直接手動填寫。</p>
                    )}
                </div>

                <div className={`space-y-3 transition-opacity ${localVisionEnabled ? 'opacity-100' : 'opacity-50'}`}>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">URL</label>
                        <input
                            type="text"
                            value={localVisionUrl}
                            onChange={event => { setLocalVisionUrl(event.target.value); setSelectedVisionPresetId(null); setVisionTestResult(null); }}
                            disabled={!localVisionEnabled}
                            placeholder="https://.../v1"
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">Key</label>
                        <input
                            type="password"
                            value={localVisionKey}
                            onChange={event => { setLocalVisionKey(event.target.value); setSelectedVisionPresetId(null); setVisionTestResult(null); }}
                            disabled={!localVisionEnabled}
                            placeholder="sk-..."
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all disabled:cursor-not-allowed"
                        />
                    </div>
                    <div>
                        <div className="flex justify-between items-center mb-1.5 pl-1">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                            <button
                                type="button"
                                onClick={fetchVisionModels}
                                disabled={!localVisionEnabled || isLoadingVisionModels}
                                className="text-[10px] text-violet-600 font-bold disabled:text-slate-300"
                            >
                                {isLoadingVisionModels ? 'Fetching...' : '刷新模型列表'}
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowVisionModelModal(true)}
                            disabled={!localVisionEnabled}
                            title={localVisionModel || '選擇或手動輸入模型'}
                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-4 py-3 text-sm text-slate-700 flex justify-between items-center gap-2 active:bg-white transition-all shadow-sm disabled:cursor-not-allowed"
                        >
                            <span className="font-mono overflow-hidden whitespace-nowrap min-w-0 flex-1 text-left text-ellipsis">
                                {localVisionModel || '選擇或手動輸入模型...'}
                            </span>
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 shrink-0"><path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                        </button>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={handleTestVisionApi}
                        disabled={testingVisionApi || !localVisionEnabled || !localVisionUrl.trim() || !localVisionKey.trim() || !localVisionModel.trim()}
                        className="py-3 rounded-2xl font-bold text-violet-600 border border-violet-200 bg-violet-50 active:scale-95 transition-all disabled:opacity-40"
                    >
                        {testingVisionApi ? '識圖測試中…' : '🧪 測試識圖'}
                    </button>
                    <button
                        type="button"
                        onClick={() => handleSaveVisionApi()}
                        disabled={isLoadingVisionModels || testingVisionApi}
                        className="py-3 rounded-2xl font-bold text-white shadow-lg shadow-violet-500/20 bg-violet-500 active:scale-95 transition-all disabled:opacity-50"
                    >
                        保存識圖 API
                    </button>
                </div>
                {visionStatusMsg && (
                    <div className="text-[11px] text-center text-violet-600 bg-violet-50 px-3 py-2 rounded-xl">{visionStatusMsg}</div>
                )}
                <p className="text-[9px] text-slate-300 px-1">測試會發送一張內置紫色圓點圖，確認該模型真的能看圖，並消耗一次極小請求。</p>
                {visionTestResult && (
                    <div className={`text-xs px-3 py-2 rounded-xl leading-relaxed ${
                        visionTestResult.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'
                    }`}>
                        {visionTestResult}
                    </div>
                )}
            </div>
        </SettingsSection>

        {/* API 調用記錄入口 — 點開看最近 5 天各 App / 角色 / 用途的調用明細 */}
        <button
            type="button"
            onClick={() => setShowApiCallLog(true)}
            className="w-full bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50 flex items-center gap-3 active:scale-[0.99] transition-transform text-left"
        >
            <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600 shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25" />
                </svg>
            </div>
            <div className="flex-1 min-w-0">
                <h2 className="text-sm font-semibold text-slate-600 tracking-wider">API 調用記錄</h2>
                <p className="text-[11px] text-slate-400 mt-0.5">最近 5 天：時間 · 哪個 API · 哪個 App · 哪個角色 · 用途</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-300 shrink-0">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
            </svg>
        </button>

        {/* 其他 API 區域 — 非 LLM 類（語音、寫歌等），不會跟隨預設切換 */}
        <SettingsSection
            title="其他 API"
            icon={
                <div className="p-2 bg-amber-100/50 rounded-xl text-amber-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                    </svg>
                </div>
            }
        >
            <p className="text-[11px] text-slate-400 mb-4 leading-relaxed pl-1">
                語音 / 寫歌等非 LLM 類 API。這些設置 <span className="font-semibold text-slate-500">不會隨預設切換</span>，通常只配置一次。
            </p>

            <div className="space-y-4">
                <p className="text-[11px] text-slate-400 -mt-1 pl-1 leading-relaxed">
                    🎙️ 語音生成支持 <span className="font-semibold text-slate-500">MiniMax</span>、<span className="font-semibold text-slate-500">魚聲 Fish</span> 和 <span className="font-semibold text-slate-500">ElevenLabs</span>。三家的配置都會保留，最後在底部選擇當前引擎。
                </p>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax 服務器</label>
                    <div className="flex bg-white/50 border border-slate-200/60 rounded-xl p-1 gap-1">
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('domestic')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'domestic' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            國服
                        </button>
                        <button
                            type="button"
                            onClick={() => setLocalMiniMaxRegion('overseas')}
                            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${localMiniMaxRegion === 'overseas' ? 'bg-primary text-white shadow-sm' : 'text-slate-600 active:bg-white/60'}`}
                        >
                            海外
                        </button>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localMiniMaxRegion === 'overseas'
                            ? '海外站（api.minimax.io）— 請使用海外帳號簽發的 Key。'
                            : '國服（api.minimaxi.com）— 默認，適配國內帳號。'}
                    </p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Key (可選)</label>
                    <input type="password" name="minimax-api-secret" autoComplete="new-password" spellCheck={false} value={localMiniMaxKey} onChange={(e) => setLocalMiniMaxKey(e.target.value)} placeholder="MiniMax API Secret（留空則複用 Key）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">電話 / 音色查詢優先使用這個 Key，空著時回退通用 Key。</p>
                </div>

                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">MiniMax Group ID (可選)</label>
                    <input type="text" value={localMiniMaxGroupId} onChange={(e) => setLocalMiniMaxGroupId(e.target.value)} placeholder="group_id（部分帳號/模型需要）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">如控制台給了 group_id，請填這裡；會透傳到 TTS 請求體和代理日誌。</p>
                </div>

                {/* 魚聲 Fish Audio —— 與 MiniMax 對等的另一套語音系統，中性樣式、不做視覺偏向 */}
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">魚聲 Fish Audio Key</label>
                    <input type="password" name="fish-api-key" autoComplete="new-password" spellCheck={false} value={localFishKey} onChange={(e) => setLocalFishKey(e.target.value)} placeholder="Fish Audio API Key（fish.audio 控制台簽發）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">在 <a href="https://fish.audio/zh-CN/developers/" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">fish.audio 開發者頁</a> 拿 Key（<span className="text-amber-600 font-medium">需梯子</span>）。角色音色在「角色 → 語音」裡填 reference_id。靜態網頁環境會在合成時通過網絡 Worker 轉發 Key 與待合成文字，項目不主動留存。</p>

                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-3 mb-1.5 block pl-1">魚聲模型</label>
                    <select
                        value={localFishModel}
                        onChange={(e) => selectFishModel(e.target.value)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm focus:bg-white transition-all"
                    >
                        <option value="s2.1-pro-free">s2.1-pro-free —— 免費（同款模型 $0，測試/個人首選）</option>
                        <option value="s2.1-pro">s2.1-pro —— 付費，質量/延遲更優，生產推薦</option>
                        <option value="s2-pro">s2-pro —— 上一代，多說話人 / 自然語言控制</option>
                        <option value="s1">s1 —— 舊版，(圓括號) 情緒標籤</option>
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        {localFishModel === 's2.1-pro-free'
                            ? '免費版：和 s2.1-pro 同一個模型、$0，但不保證 TTFA / DPA，適合自用測試。選了立即生效。'
                            : '切換立即生效。角色也可在「角色 → 語音」單獨覆蓋模型（留空則用這裡的全局默認）。'}
                    </p>
                </div>

                {/* ElevenLabs —— Voice ID 在角色頁配置，這裡保存帳號、全局模型和通用聲音參數。 */}
                <div className="group">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1.5 block pl-1">ElevenLabs API Key</label>
                    <input
                        type="password"
                        name="elevenlabs-api-key"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={localElevenLabsKey}
                        onChange={(e) => setLocalElevenLabsKey(e.target.value)}
                        placeholder="ElevenLabs API Key"
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all"
                    />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        在 <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-semibold">ElevenLabs API Keys</a> 創建。角色音色在「角色 → 語音」填寫 Voice ID；網頁端合成會通過項目代理轉發，不寫入服務端存儲。
                    </p>

                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-3 mb-1.5 block pl-1">ElevenLabs 模型</label>
                    <select
                        value={localElevenLabsModel}
                        onChange={(e) => selectElevenLabsModel(e.target.value)}
                        className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-3 py-2.5 text-sm focus:bg-white transition-all"
                    >
                        {ELEVENLABS_MODEL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">
                        Flash v2.5 默認更適合實時聊天；v3 支持更豐富的方括號 Audio Tags。切換後對應的內置語音提示規則也會同步切換。
                    </p>

                    <details className="mt-3 rounded-xl border border-slate-200/60 bg-white/35 px-3 py-2">
                        <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 select-none">聲音參數（高級）</summary>
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {([
                                ['穩定度', localElevenLabsStability, setLocalElevenLabsStability],
                                ['相似度', localElevenLabsSimilarityBoost, setLocalElevenLabsSimilarityBoost],
                                ['風格強度', localElevenLabsStyle, setLocalElevenLabsStyle],
                            ] as const).map(([label, value, setter]) => (
                                <label key={label} className="text-[11px] text-slate-500">
                                    <span className="flex justify-between mb-1"><span>{label}</span><span className="font-mono">{value.toFixed(2)}</span></span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="1"
                                        step="0.05"
                                        value={value}
                                        onChange={(e) => setter(Number(e.target.value))}
                                        className="w-full accent-primary"
                                    />
                                </label>
                            ))}
                            <label className="flex items-center justify-between gap-3 text-[11px] text-slate-500 sm:col-span-2">
                                <span>Speaker Boost（更貼近原音色，可能增加少量延遲）</span>
                                <input
                                    type="checkbox"
                                    checked={localElevenLabsUseSpeakerBoost}
                                    onChange={(e) => setLocalElevenLabsUseSpeakerBoost(e.target.checked)}
                                    className="w-4 h-4 accent-primary"
                                />
                            </label>
                        </div>
                    </details>
                </div>

                {/* 底部：當前語音引擎三選一 —— radio 樣式（配置都在上面，這裡只挑用哪家） */}
                <div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5 block">當前語音引擎（三選一）</label>
                    <p className="text-[11px] text-slate-400 mb-2.5">聊天語音條 / 約會 / 電話用哪一家。上面三家的配置都會保留，這裡只切換當前生效的。</p>
                    <div className="space-y-2">
                        {([
                            ['minimax', 'MiniMax', '國內可直連，默認推薦'],
                            ['fishaudio', '魚聲 Fish', '需科學上網（梯子 / 魔法），否則一直合成失敗'],
                            ['elevenlabs', 'ElevenLabs', '多語言音色豐富；需可訪問 ElevenLabs API'],
                        ] as const).map(([key, name, desc]) => {
                            const active = localTtsProvider === key;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    onClick={() => selectTtsProvider(key)}
                                    className={`w-full flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all ${active ? 'border-primary bg-primary/5 shadow-sm' : 'border-slate-200 bg-white/70 active:bg-white'}`}
                                >
                                    <span className={`shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center ${active ? 'border-primary' : 'border-slate-300'}`}>
                                        {active && <span className="w-2 h-2 rounded-full bg-primary" />}
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className={`text-sm font-semibold ${active ? 'text-primary' : 'text-slate-700'}`}>{name}</span>
                                        <span className="block text-[11px] text-slate-400 mt-0.5">{desc}</span>
                                    </span>
                                    {active && <span className="text-[10px] font-bold text-primary shrink-0">使用中</span>}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 語音提示詞（高級）—— 自定義注入角色 system prompt 的「語音表演指南」，按服務商分別保存 */}
                <div className="group rounded-2xl border border-slate-200/70 bg-slate-50/60 p-3">
                    <button
                        type="button"
                        onClick={() => setShowVoicePrompts(v => !v)}
                        className="w-full flex items-center justify-between text-left"
                    >
                        <span>
                            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">語音提示詞（高級 · 可自定義）</span>
                            <span className="block text-[11px] text-slate-400 mt-0.5">教模型怎麼寫出有情緒、有停頓的語音台詞（聊天 / 電話 / 見面三處）。留空則用內置默認。</span>
                        </span>
                        <span className={`shrink-0 ml-2 text-slate-400 transition-transform ${showVoicePrompts ? 'rotate-180' : ''}`}>▾</span>
                    </button>

                    {showVoicePrompts && (
                        <div className="mt-3 space-y-4">
                            <p className="text-[11px] text-amber-600 leading-relaxed pl-0.5">
                                ⚠️ 這是給模型的格式說明（停頓標記 / 情緒標籤 / 動作詞等），不是角色人設。改壞了可能導致語音標記解析失敗——拿不準就點「清空」回到默認。改完記得點下面的「保存」。
                            </p>

                            {([
                                ['minimax', 'MiniMax 語音指南', localVoicePromptMinimax, setLocalVoicePromptMinimax, VOICE_ACTING_GUIDE, '聊天 + 電話 · MiniMax 引擎時生效'] as const,
                                ['fishaudio', '魚聲 Fish 語音指南', localVoicePromptFish, setLocalVoicePromptFish, FISH_VOICE_ACTING_GUIDE, '聊天 + 電話 · 魚聲引擎時生效'] as const,
                                ['elevenlabs', 'ElevenLabs 語音指南', localVoicePromptElevenLabs, setLocalVoicePromptElevenLabs, getElevenLabsVoiceActingGuide(localElevenLabsModel), '聊天 + 電話 · ElevenLabs 引擎時生效；默認模板隨模型變化'] as const,
                                ['dateVoice', '見面（約會）語音情緒', localVoicePromptDate, setLocalVoicePromptDate, DATE_VOICE_GUIDE, '見面專用 [v:xxx] 規則 · 角色開了見面語音時生效，與引擎無關'] as const,
                            ]).map(([key, title, value, setValue, def, hint]) => {
                                const active = localTtsProvider === key;
                                const usingDefault = !value.trim();
                                return (
                                    <div key={key}>
                                        <div className="flex items-center justify-between mb-1 pl-0.5">
                                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                                {title}
                                                {active && <span className="ml-1.5 text-[9px] font-bold text-primary normal-case tracking-normal">· 當前引擎</span>}
                                            </label>
                                            <span className={`text-[10px] font-medium ${usingDefault ? 'text-slate-400' : 'text-primary'}`}>
                                                {usingDefault ? '使用內置默認' : '已自定義'}
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-slate-400 mb-1.5 pl-0.5">{hint}</p>
                                        <textarea
                                            value={value}
                                            onChange={(e) => setValue(e.target.value)}
                                            placeholder="留空 → 使用內置默認。點下方「載入默認模板」可把內置文案填進來再改。"
                                            rows={6}
                                            spellCheck={false}
                                            className="w-full bg-white/60 border border-slate-200/60 rounded-xl px-3 py-2.5 text-xs font-mono leading-relaxed focus:bg-white transition-all resize-y"
                                        />
                                        <div className="flex items-center justify-between mt-1.5 pl-0.5">
                                            <span className="text-[10px] text-slate-400">{value.length} 字</span>
                                            <span className="flex gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => setValue(def)}
                                                    className="text-[11px] font-semibold text-slate-500 hover:text-primary active:scale-95 transition-all"
                                                >
                                                    載入默認模板
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setValue('')}
                                                    disabled={usingDefault}
                                                    className="text-[11px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all disabled:opacity-30 disabled:pointer-events-none"
                                                >
                                                    清空（恢復默認）
                                                </button>
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="group">
                    <div className="flex items-center justify-between mb-1.5 pl-1">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">寫歌 · Replicate Token (可選)</label>
                        <button
                            type="button"
                            onClick={() => setShowAceStepGuide(v => !v)}
                            className="text-[10px] font-semibold text-rose-500 hover:text-rose-600 active:scale-95 transition-all flex items-center gap-1"
                        >
                            {showAceStepGuide ? '收起' : '怎麼拿？'}
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={`w-3 h-3 transition-transform ${showAceStepGuide ? 'rotate-180' : ''}`}>
                                <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                    <input type="password" name="ace-step-api-token" autoComplete="new-password" spellCheck={false} value={localAceStepKey} onChange={(e) => setLocalAceStepKey(e.target.value)} placeholder="r8_xxx（寫歌 App 調 ACE-Step 出整首歌用）" className="w-full bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:bg-white transition-all" />
                    <p className="text-[11px] text-slate-400 mt-1 pl-1">填了之後，寫歌 App 的歌詞頁可以一鍵調用 ACE-Step 生成真人聲整首歌（約 ¥0.1/首）。生成時 Token、歌詞與風格參數會通過網絡 Worker 轉發給 Replicate，項目不主動留存。</p>

                    {showAceStepGuide && (
                        <div className="mt-3 rounded-2xl overflow-hidden border border-rose-200/60 bg-gradient-to-br from-rose-50 via-orange-50 to-amber-50 shadow-sm animate-slide-down">
                            <div className="px-4 pt-3.5 pb-2 flex items-center gap-2 border-b border-rose-200/40">
                                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-white flex items-center justify-center text-base shadow-sm shadow-rose-500/30">🎤</div>
                                <div className="flex-1">
                                    <div className="text-[12px] font-bold text-stone-700">3 步搞定 Replicate Token</div>
                                    <div className="text-[10px] text-stone-500">讓 ACE-Step 幫你把歌唱出來</div>
                                </div>
                            </div>
                            <div className="px-4 py-3 space-y-2.5">
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">1</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">註冊 Replicate 帳號</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">用 GitHub 一鍵登錄最快。無需郵箱驗證。</p>
                                        <a
                                            href="https://replicate.com/signin"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-rose-600 hover:text-rose-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-rose-200/50"
                                        >
                                            打開註冊頁
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-orange-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">2</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">複製 API Token</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">登錄後訪問 Account → API Tokens，複製以 <span className="font-mono text-rose-600">r8_</span> 開頭的那一串。</p>
                                        <a
                                            href="https://replicate.com/account/api-tokens"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-orange-600 hover:text-orange-700 active:scale-95 transition-all px-2 py-1 rounded-lg bg-white/70 border border-orange-200/50"
                                        >
                                            打開 Token 頁
                                        </a>
                                    </div>
                                </div>
                                <div className="flex gap-2.5">
                                    <span className="shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-[11px] font-bold flex items-center justify-center mt-0.5">3</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-stone-700 font-medium">綁卡充值（必須）</div>
                                        <p className="text-[11px] text-stone-500 leading-relaxed mt-0.5">Replicate 沒有免費試用額度，需先綁信用卡。<span className="text-rose-600 font-semibold">國內卡基本不行</span>，建議 Visa / MC 美區卡。最低充 $1（約 ¥7.3）≈ 50-100 首歌。</p>
                                    </div>
                                </div>
                                <div className="mt-2 pt-2.5 border-t border-rose-200/40 flex gap-2 items-start">
                                    <span className="text-rose-500 text-sm leading-none mt-0.5">💡</span>
                                    <p className="text-[11px] text-stone-500 leading-relaxed">
                                        粘貼到上面輸入框 → 點保存配置 → 進寫歌 App 打開任意一首歌的預覽頁 → 底部「AI 出歌」即可。
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <button onClick={handleSaveOtherApis} className="w-full py-3 rounded-2xl font-bold text-white shadow-lg shadow-amber-500/20 bg-amber-500 active:scale-95 transition-all mt-2">
                    {otherStatusMsg || '保存其他 API'}
                </button>
            </div>
        </SettingsSection>

        {/* 生圖 API 區域 */}
        <SettingsSection
            title="生圖API"
            icon={
                <div className="p-2 bg-pink-100/50 rounded-xl text-pink-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M18 22.5H6a2.25 2.25 0 0 1-2.25-2.25V3.75A2.25 2.25 0 0 1 6 1.5h12a2.25 2.25 0 0 1 2.25 2.25v16.5A2.25 2.25 0 0 1 18 22.5ZM10.5 8.25a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
                    </svg>
                </div>
            }
        >
            <ImageGenSettingsPanel apiConfig={apiConfig} updateApiConfig={updateApiConfig} />
        </SettingsSection>

        {/* 實時感知配置區域 */}
        <SettingsSection
            title="實時感知"
            icon={
                <div className="p-2 bg-violet-100/50 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                    </svg>
                </div>
            }
            actions={
                <button onClick={() => { trackEvent('打开实时感知配置'); setShowRealtimeModal(true); }} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                    配置
                </button>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                讓AI角色感知真實世界：天氣、新聞熱點、當前時間。角色可以根據天氣關心你、聊聊最近的熱點話題。
            </p>

            <div className="grid grid-cols-5 gap-2 text-center">
                <div className={`py-3 rounded-xl text-xs font-bold ${rtWeatherEnabled ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtWeatherEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2600.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f32b.png" className="w-5 h-5 inline" alt="" />}</div>
                    天氣
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNewsEnabled ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNewsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4f0.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" className="w-5 h-5 inline" alt="" />}</div>
                    新聞
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtNotionEnabled ? 'bg-orange-50 text-orange-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtNotionEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    Notion
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtFeishuEnabled ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtFeishuEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d2.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    飛書
                </div>
                <div className={`py-3 rounded-xl text-xs font-bold ${rtXhsEnabled ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400'}`}>
                    <div className="text-lg mb-1">{rtXhsEnabled ? <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d5.png" className="w-5 h-5 inline" alt="" /> : <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4cb.png" className="w-5 h-5 inline" alt="" />}</div>
                    小紅書
                </div>
            </div>
        </SettingsSection>

        {/* 通用 MCP，獨立於實時感知 */}
        <SettingsSection
            title="MCP"
            badge={<span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-bold shrink-0">本機配置</span>}
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <PlugsConnected size={16} weight="fill" />
                </div>
            }
            actions={
                <>
                    <button
                        onClick={() => { trackEvent('打开「MCP 是什么」说明弹窗'); setShowMcpHelp(true); }}
                        aria-label="MCP 是什麼？"
                        className="w-7 h-7 rounded-full border border-slate-200 bg-white text-[12px] font-bold text-slate-400 active:scale-90 transition-all"
                    >?</button>
                    <button onClick={() => { trackEvent('打开MCP工具服务器配置'); setShowMcpModal(true); }} className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform">
                        管理
                    </button>
                </>
            }
        >
            <p className="text-xs text-slate-500 leading-relaxed">
                連接標準 MCP 服務器，讓聊天可以調用資料庫、搜索、筆記或智能家居等工具。
            </p>
            <p className="text-[10px] text-slate-400 mt-2 leading-relaxed border-l-2 border-violet-200 pl-2">
                需要自行準備 Streamable HTTP 服務；不配置不會影響內置 Sully、記憶或普通聊天。
            </p>
            {(() => {
                const list = loadMcpServers();
                if (!list.length) return null;
                const on = list.filter(s => s.enabled && s.tools?.length);
                const toolCount = on.reduce((n, s) => n + (s.tools?.length || 0), 0);
                return (
                    <p className="text-[10px] text-slate-400 mt-2">
                        已配置 {list.length} 個服務器 · {on.length} 個啟用中{toolCount ? ` · 共 ${toolCount} 個工具` : ''}
                    </p>
                );
            })()}
        </SettingsSection>

        {/* ───────── 推送憑據 (VAPID) ───────── */}
        {/* VAPID 公私鑰：主動消息 2.0 部署 Worker 時用的就是這一對（一鍵部署自動沿用，手動部署照著填 env）。 */}
        {/* vapidReadyTick: VAPID 彈窗關閉後 +1, 讓本節點 re-render 重讀 isPushVapidReady(). */}
        <SettingsSection
            title="推送憑據 (VAPID)"
            sectionProps={{ 'data-vapid-tick': vapidReadyTick }}
            icon={
                <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
                    </svg>
                </div>
            }
            actions={
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${isPushVapidReady() ? 'bg-violet-100 text-violet-600' : 'bg-rose-100 text-rose-600'}`}>
                    {isPushVapidReady() ? '已配置' : '未配置'}
                </span>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                主動消息 2.0 的 Worker 用這對密鑰籤推送：一鍵部署會自動沿用，手動部署時把它們填進 Worker 的環境變量。重新生成之後要重新部署 Worker 才能生效。
            </p>
            <button
                type="button"
                onClick={() => setShowVapidModal(true)}
                className={`w-full py-2.5 rounded-xl text-xs font-bold ${isPushVapidReady() ? 'bg-white text-violet-700 border border-violet-200 hover:bg-violet-50' : 'bg-violet-500 text-white hover:bg-violet-600 shadow-md shadow-violet-200'}`}
            >
                {isPushVapidReady() ? '查看 / 重新生成' : '生成 VAPID 密鑰對 →'}
            </button>
        </SettingsSection>

        {/* ───────── 推送訂閱狀態（診斷 + 重置） ───────── */}
        <SettingsSection
            title="推送訂閱狀態"
            icon={
                <div className="p-2 bg-sky-100/60 rounded-xl text-sky-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
                    </svg>
                </div>
            }
        >
            <PushSubscriptionPanel addToast={addToast} />
        </SettingsSection>

        {/* ───────── 主動消息 Push 加速器（開關） ───────── */}
        {SHOW_PROACTIVE_PUSH_ACCEL_UI && ppAvailable && (
        <SettingsSection
            title="主動消息 Push 加速"
            icon={
                <div className="p-2 bg-teal-100/60 rounded-xl text-teal-600">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
                    </svg>
                </div>
            }
            actions={
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${ppEnabled ? 'bg-teal-100 text-teal-600' : 'bg-slate-100 text-slate-400'}`}>
                    {ppEnabled ? '已啟用' : '未啟用'}
                </span>
            }
        >
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                讓主動消息在瀏覽器後台標籤裡也能準點觸發。AI 仍在本地生成，雲端只管"到點喊醒瀏覽器"。
                瀏覽器進程被完全關閉時無法喚醒——下次打開 app 會自動補跑漏掉的主動消息，
                你看到的就是"開 app 即有"，不會半路彈窗打擾你。
            </p>

            {ppStatus && (
                <div className={`mb-3 p-3 rounded-xl text-xs font-medium text-center ${ppStatus.includes('成功') || ppStatus.includes('已啟用') || ppStatus.includes('OK') ? 'bg-emerald-100 text-emerald-700' : ppStatus.includes('失敗') || ppStatus.includes('錯誤') || ppStatus.includes('拒絕') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                    {ppStatus}
                </div>
            )}

            <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2.5">
                <div>
                    <p className="text-[11px] text-slate-600 font-medium">啟用 Push 加速</p>
                    <p className="text-[10px] text-slate-400">關閉則退回純本地計時器</p>
                </div>
                <button
                    disabled={ppBusy}
                    onClick={() => {
                        if (ppBusy) return;
                        trackEvent('切换主动消息Push加速', { action: ppEnabled ? 'disable' : 'enable' });
                        if (ppEnabled) {
                            void doDisablePushAccelerator();
                        } else {
                            setShowPpConfirm(true);
                        }
                    }}
                    className={`w-10 h-5 rounded-full transition-colors ${ppEnabled ? 'bg-teal-500' : 'bg-slate-300'} ${ppBusy ? 'opacity-60' : ''}`}
                >
                    <div className={`w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${ppEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
            </div>

            {/* ───── 診斷面板 ───── */}
            <div className="mt-4 bg-slate-50/70 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-slate-600">Web Push 狀態</p>
                    <button
                        onClick={() => {
                            // 全部是瀏覽器/設備狀態的固定枚舉，不含端點地址、也不含任何用戶配置值
                            trackEvent('刷新 Web Push 诊断', ppDiag ? {
                                permission: ppDiag.permission,
                                subscription: !ppDiag.endpoint ? 'none' : ppDiag.endpointDead ? 'dead' : 'active',
                                swState: ppDiag.swState === 'activated' ? 'activated' : ppDiag.swState === 'none' ? 'none' : 'other',
                                platform: ppDiag.capacitorNative ? 'capacitor_native' : ppDiag.iosNeedsPwa ? 'ios_needs_pwa' : 'normal',
                            } : undefined);
                            void refreshPpDiag();
                        }}
                        className="text-[10px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 hover:bg-slate-50"
                    >
                        刷新
                    </button>
                </div>

                {ppDiag ? (
                    <div className="space-y-1.5 text-[11px]">
                        <DiagRow
                            label="瀏覽器支持"
                            value={
                                ppDiag.capacitorNative ? '否（當前在 App 裡運行）' :
                                ppDiag.supported ? '是' : '否（瀏覽器缺少推送相關 API）'
                            }
                            bad={!ppDiag.supported || ppDiag.capacitorNative}
                        />
                        <DiagRow
                            label="通知權限"
                            value={
                                ppDiag.permission === 'granted' ? '已授權' :
                                ppDiag.permission === 'denied' ? '已拒絕（請到瀏覽器站點設置手動開啟）' :
                                ppDiag.permission === 'default' ? '未決定' :
                                '不可用'
                            }
                            bad={ppDiag.permission !== 'granted'}
                        />
                        <DiagRow
                            label="Service Worker"
                            value={
                                ppDiag.swState === 'activated' ? `已激活（scope: ${ppDiag.swScope || '?'}）` :
                                ppDiag.swState === 'none' ? '未註冊' :
                                `${ppDiag.swState}（scope: ${ppDiag.swScope || '?'}）`
                            }
                            bad={ppDiag.swState !== 'activated'}
                        />
                        <DiagRow
                            label="訂閱"
                            value={
                                !ppDiag.endpoint ? '不存在' :
                                ppDiag.endpointDead ? '已失效（zombie endpoint）' :
                                '已建立'
                            }
                            bad={!ppDiag.endpoint || ppDiag.endpointDead}
                        />
                        <DiagRow label="推送通道" value={ppDiag.channel} />
                        <DiagRow
                            label="最近一次喚醒"
                            value={
                                ppDiag.lastWakeAt
                                    ? `${new Date(ppDiag.lastWakeAt).toLocaleString()}${ppDiag.lastWakeChar ? `（${ppDiag.lastWakeChar}）` : ''}`
                                    : '從未'
                            }
                        />
                        {ppDiag.endpoint && (
                            <div className="pt-2 mt-2 border-t border-slate-200">
                                <p className="text-[10px] text-slate-400 mb-1">訂閱端點（前 60 字符）</p>
                                <p className={`text-[10px] font-mono break-all leading-relaxed ${ppDiag.endpointDead ? 'text-rose-600' : 'text-slate-500'}`}>{ppDiag.endpoint.slice(0, 60)}…</p>
                            </div>
                        )}
                        {ppDiag.endpointDead && (
                            <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded-lg text-[10px] text-rose-700 leading-relaxed">
                                訂閱地址是 <code className="font-mono">permanently-removed.invalid</code>——瀏覽器已經把這個訂閱吊銷了
                                （常見原因：長期不訪問、通知權限切換過、瀏覽器清理過站點數據）。<br/>
                                這個域名是 RFC 保留 TLD，全球永遠不會解析；Worker 試圖把 push 投遞過去就會回 HTTP 530。<br/>
                                點下方<b>"重置訂閱"</b>會清掉這條死訂閱並重建一個新的。
                            </div>
                        )}
                        {ppDiag.iosNeedsPwa && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                檢測到 iOS Safari，但當前不是已添加到主屏幕的 PWA。<br/>
                                iOS 的 Web Push 必須先把網站"添加到主屏幕"啟動後才能用。
                            </div>
                        )}
                        {ppDiag.capacitorNative && (
                            <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-relaxed">
                                你現在是在<b>打包好的 App</b>裡運行（不是瀏覽器網頁）。<br/>
                                這個"Push 加速器"只對網頁版生效——App 裡沒有網頁推送通道，但<b>不影響你正常用</b>：
                                主動消息會通過 App 的本地通知發出，App 在後台/鎖屏也能收到。<br/>
                                下面的"測試推送 / 重置訂閱"按鈕在 App 裡點了也沒用，可以直接忽略這個面板。
                            </div>
                        )}
                    </div>
                ) : (
                    <p className="text-[10px] text-slate-400">加載中…</p>
                )}

                {(() => {
                    const inDeepMode = ppZombieStreak >= 3;
                    const resetLabel = inDeepMode
                        ? (ppDeepResetBusy ? '深度重置中…' : '深度重置')
                        : (ppResetBusy ? '重置中…' : '重置訂閱');
                    const resetBusy = ppResetBusy || ppDeepResetBusy;
                    return (
                        <div className="mt-4 grid grid-cols-2 gap-2">
                            <button
                                disabled={ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative}
                                onClick={() => void doSendTestPush()}
                                className={`py-2 rounded-xl text-xs font-bold ${ppTestBusy || resetBusy || !ppDiag?.endpoint || ppDiag?.endpointDead || ppDiag?.capacitorNative ? 'bg-slate-200 text-slate-400' : 'bg-teal-500 text-white hover:bg-teal-600'}`}
                            >
                                {ppTestBusy ? '測試中…' : '發一條測試推送'}
                            </button>
                            <button
                                disabled={resetBusy || ppTestBusy || ppDiag?.capacitorNative}
                                onClick={() => inDeepMode ? void doDeepResetSubscription() : void doResetSubscription()}
                                className={`py-2 rounded-xl text-xs font-bold border ${resetBusy || ppTestBusy || ppDiag?.capacitorNative ? 'bg-slate-100 text-slate-400 border-slate-200' : inDeepMode || ppDiag?.endpointDead ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                            >
                                {resetLabel}
                            </button>
                        </div>
                    );
                })()}
                <p className="text-[10px] text-slate-400 mt-2 leading-relaxed">
                    "測試推送"會讓 Worker 立刻給你這台設備發一條 push，5 秒內系統通知裡出現"推送測試成功"= 鏈路通。
                    "重置訂閱"會清掉舊訂閱再建一個，適合訂閱失效或換瀏覽器後用。
                    {ppZombieStreak >= 3 && <><br/>連續幾次都沒成，已切到"深度重置"——點一下做一次更徹底的清理。</>}
                </p>
            </div>
        </SettingsSection>
        )}

        {/* ───────── 主動消息 2.0（定時推送） ───────── */}
        <section className="bg-white/80 rounded-3xl p-5 shadow-sm border border-white/50">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="p-2 bg-violet-100/60 rounded-xl text-violet-600">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                        </svg>
                    </div>
                    <h2 className="text-sm font-semibold text-slate-600 tracking-wider">主動消息 2.0</h2>
                </div>
                <button
                    onClick={() => { trackEvent('打开主动消息2.0配置'); setShowAmsg2Modal(true); }}
                    className="text-[10px] bg-violet-100 text-violet-600 px-3 py-1.5 rounded-full font-bold shadow-sm active:scale-95 transition-transform"
                >
                    配置
                </button>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed">
                角色到點自動給你發消息，App 關著也能收。需要你自己部署一個 Cloudflare Worker（自帶 D1 數據庫 + 定時觸發），在配置裡填地址即可。聊天上雲（即時對話）與定時主動消息都由它承擔。
            </p>
        </section>

        {/* 自定義網絡代理 — 刻意低調的高級入口。默認摺疊，不主動指引基本發現不了。
            普通用戶無需配置：默認走作者部署的公共 Worker，所有功能開箱即用。 */}
        {!showProxyConfig ? (
            <button
                onClick={() => setShowProxyConfig(true)}
                className="w-full text-center text-[10px] text-slate-300 hover:text-slate-400 py-1 transition-colors"
            >
                · 自定義網絡代理 ·
            </button>
        ) : (
            <section ref={proxyConfigSectionRef} className="scroll-mt-4 bg-white/60 rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-2">
                    <h2 className="text-xs font-semibold text-slate-500">自定義網絡代理 (Worker)</h2>
                    <button onClick={() => { setShowProxyConfig(false); setProxyWorkerInput(getProxyWorkerUrl()); }} className="text-[10px] text-slate-400">收起</button>
                </div>

                <div className="text-[10px] text-slate-500 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-2 mb-3 leading-relaxed">
                    <b>一般無需修改這裡。</b>默認地址負責靜態網頁環境中需要跨域轉發的聯網功能；
                    GitHub 備份仍默認直連，只有你在備份設置中主動開啟中轉後才會使用 Worker。
                    如果你部署了自己的 <b>worker/index.js</b>，可以在這裡換成自己的實例。
                </div>

                <div className="mb-3 rounded-xl border border-sky-100 bg-sky-50/80 px-3 py-2.5 text-[10px] leading-relaxed text-sky-900">
                    <p className="mb-1.5 font-bold">部署自己的 Worker</p>
                    <ol className="space-y-1">
                        <li><b>1.</b> 在 Cloudflare 控制台進入 Workers &amp; Pages，新建一個 Worker。</li>
                        <li><b>2.</b> 打開並複製完整的 <a href={PROXY_WORKER_SOURCE_URL} target="_blank" rel="noreferrer" className="font-bold underline underline-offset-2">worker/index.js 源碼</a>，替換編輯器裡的默認代碼，然後部署。</li>
                        <li><b>3.</b> 複製部署得到的 <b>https://xxx.workers.dev</b> 地址，粘貼到下方並保存。</li>
                    </ol>
                </div>

                <input
                    type="text"
                    value={proxyWorkerInput}
                    onChange={(e) => setProxyWorkerInput(e.target.value)}
                    placeholder={DEFAULT_PROXY_WORKER}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-200 mb-2"
                />

                <div className="grid grid-cols-2 gap-2">
                    <button onClick={handleResetProxyWorker} className="py-2 bg-slate-100 rounded-xl text-[11px] font-bold text-slate-500 active:scale-95 transition-transform">
                        恢復默認
                    </button>
                    <button onClick={handleSaveProxyWorker} className="py-2 bg-slate-700 rounded-xl text-[11px] font-bold text-white active:scale-95 transition-transform">
                        保存
                    </button>
                </div>

                <p className="text-[10px] text-slate-400 px-1 mt-2 leading-relaxed">
                    只填到域名（如 <b>{DEFAULT_PROXY_WORKER}</b>），不要帶 /search、/webdav、/api 等路徑。
                    聯網搜索 / 備份代理 / Notion / 飛書 / 點單 / 網頁抓取 / 出圖 / 小紅書 Lite / 音樂 都會切到這裡填的 Worker。
                    （音樂播放器裡還留了一個獨立地址框，單獨填了就以那個為準。）
                </p>
            </section>
        )}

        {/* ───────── 使用統計 ─────────
            只在配了統計環境變量的構建裡顯示。自部署實例本來就一個統計請求都不發，
            給個關不掉也沒東西可關的開關只會更讓人犯嘀咕。 */}
        {isAnalyticsConfigured() && (
        <SettingsSection
            title="使用統計"
            icon={
                <div className="p-2 bg-slate-100/60 rounded-xl text-slate-500">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
                    </svg>
                </div>
            }
        >
            <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-bold text-slate-600">參與使用統計</span>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                            type="checkbox"
                            checked={analyticsEnabled}
                            onChange={e => {
                                setAnalyticsEnabledState(e.target.checked);
                                setAnalyticsEnabled(e.target.checked);
                            }}
                            className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-500"></div>
                    </label>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed">
                    只數「哪個頁面被打開了、哪個功能被用了一次」，記憶條數 / 角色數落在哪個區間，
                    以及你這台設備打開頁面花了多久（瀏覽器自己測的毫秒數）。
                    不碰你和角色的任何對話、記憶、設定，不碰你輸入的任何文字，不碰 API 和 MCP 配置。
                </p>
                <p className="text-xs text-slate-500 leading-relaxed">
                    Soren 的功能已經多到我們自己也掃不完，但「哪些真的有人用、大家配置時卡在哪一步」
                    基本靠猜。留著這個開關開著能幫我們看清這些，好把精力放在有人用的地方。
                    不想參與就關掉，功能一點不受影響。
                </p>
                <p className="text-[10px] text-slate-400 leading-relaxed">
                    瀏覽器開了 Do Not Track 的話，不用動這個開關也會自動跳過。
                    關掉之後當場就不再發，下次啟動連統計腳本都不會加載。想自己核實的話，按 F12 打開 Network 面板，
                    這個頁面發出的每一個請求裝了什麼都在你自己的瀏覽器裡。
                </p>
            </div>
        </SettingsSection>
        )}

        <VersionInfo />

      </div>

      {/* 主動消息 Push 加速 · 啟用前確認 */}
      <Modal
          isOpen={showPpConfirm}
          title="啟用 Push 加速？"
          onClose={() => setShowPpConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button
                      onClick={() => { trackEvent('在 Push 加速启用确认弹窗做出选择', { choice: 'cancel' }); setShowPpConfirm(false); }}
                      className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl"
                  >
                      取消
                  </button>
                  <button
                      onClick={() => {
                          trackEvent('在 Push 加速启用确认弹窗做出选择', { choice: 'confirm' });
                          setShowPpConfirm(false);
                          void doEnablePushAccelerator();
                      }}
                      className="flex-1 py-3 bg-teal-500 text-white font-bold rounded-2xl shadow-lg shadow-teal-200"
                  >
                      我知道了，啟用
                  </button>
              </div>
          }
      >
          <div className="space-y-3 text-[12px] leading-relaxed text-slate-600">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="font-bold text-amber-800 mb-1">啟用後會做三件事</p>
                  <ol className="list-decimal pl-4 space-y-1 text-amber-900">
                      <li>瀏覽器會彈 <b>"允許發送通知？"</b> 的系統對話框——請點"允許"，不然沒法在後台喚醒</li>
                      <li>瀏覽器生成一個 <b>推送訂閱憑證</b>（只是一個"門鈴地址"，不含任何聊天內容），上傳到 Cloudflare</li>
                      <li>開著本應用的標籤頁時，每 2 分鐘給 Cloudflare 發一次心跳；關掉 5 分鐘 Cloudflare 自動停止喊你</li>
                  </ol>
              </div>

              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <p className="font-bold text-emerald-800 mb-1">誰能看到什麼</p>
                  <div className="space-y-1.5 text-emerald-900">
                      <p><b>Cloudflare 能看到：</b>推送訂閱憑證 + 角色 ID（一串隨機字符串）+ 間隔分鐘數。<b>看不到</b>聊天內容、角色人設、AI 回覆、API Key、你是誰。</p>
                      <p><b>瀏覽器廠商的推送服務（Google / Mozilla / Apple）：</b>知道你某時刻收到一條 push，內容是加密的，他們讀不到。</p>
                      <p><b>你的 AI 接口供應商：</b>和平時聊天一樣，到點時瀏覽器在<b>本地</b>直接調你在"API 配置"裡填的那個接口，走你自己的 key。Cloudflare 完全不碰這一步。</p>
                  </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="font-bold text-slate-700 mb-1">一句話</p>
                  <p className="text-slate-700">聊天記錄和 AI 請求只在你自己和 AI 提供商之間，和現在沒開 Push 加速時完全一樣。Cloudflare 只是一個"到點按門鈴"的鬧鐘。</p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
                  <p className="font-bold text-blue-800 mb-1">不會主動彈通知打擾你</p>
                  <p className="text-blue-900">瀏覽器後台標籤 → 靜默觸發，進 app 就看到。瀏覽器整個關掉 → 下次打開 app 自動補跑，開 app 即有。中間不彈"有人想找你"那種窗口擾你。</p>
              </div>
          </div>
      </Modal>

      {/* Cloud Config Modal */}
      <Modal isOpen={showCloudModal} title="雲端備份配置" onClose={() => setShowCloudModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
                  <p className="text-[10px] text-rose-700 leading-relaxed">
                      <b>🪜 需要梯子</b><br/>
                      InfiniCloud 是日本的服務，國內直連通常打不開註冊頁、也無法同步備份。<b>註冊和之後每次同步都需要保持梯子開啟</b>，否則會連接失敗或超時。
                  </p>
              </div>
              <div className="bg-sky-50 rounded-xl p-3">
                  <p className="text-[10px] text-sky-700 leading-relaxed">
                      <b>快速上手 (InfiniCloud, 免費 20GB):</b><br/>
                      1. 註冊 <a href="https://infini-cloud.net/" target="_blank" rel="noopener noreferrer" className="text-sky-600 underline font-bold hover:text-sky-800">infini-cloud.net ↗</a>（郵箱驗證）<br/>
                      2. 登錄後 <b>My Page</b> 最底 → 勾選 <b>Turn on Apps Connection</b><br/>
                      3. 頂欄 <b>Apps</b> → 複製 <b>WebDAV URL</b> / <b>Connection ID</b> / <b>Apps Password</b><br/>
                      4. 用戶名填 <b>Connection ID</b>（不是郵箱），密碼填 <b>Apps Password</b>
                  </p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ Apps Password ≠ 登錄密碼</b><br/>
                      <b>Apps Password</b> 是 <b>Apps</b> 頁面裡顯示在 <b>WebDAV URL</b>、<b>Connection ID</b> <b>下方</b>的一串<b>可複製</b>的應用專用密碼，往下滾就能看到。直接把它複製粘貼到上面的"密碼"框即可，用帳號登錄密碼會 401。
                  </p>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">WebDAV 地址</label>
                  <input type="url" value={cbUrl} onChange={(e) => setCbUrl(e.target.value)} placeholder="https://xxx.infini-cloud.net/dav/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">用戶名</label>
                      <input type="text" value={cbUsername} onChange={(e) => setCbUsername(e.target.value)} placeholder="郵箱或用戶名" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
                  <div>
                      <label className="text-[11px] text-slate-500 font-medium mb-1 block">密碼</label>
                      <input type="password" value={cbPassword} onChange={(e) => setCbPassword(e.target.value)} placeholder="應用專用密碼" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
                  </div>
              </div>
              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">備份目錄</label>
                  <input type="text" value={cbPath} onChange={(e) => setCbPath(e.target.value)} placeholder="/SullyBackup/" className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none" />
              </div>
              <button onClick={handleTestCloudConnection} disabled={cloudTesting || !cbUrl || !cbUsername || !cbPassword} className="w-full py-2.5 bg-slate-100 border border-slate-200 rounded-xl text-xs font-bold text-slate-600 disabled:opacity-40">
                  {cloudTesting ? '測試中...' : '測試連接'}
              </button>
              {cloudTestResult && (
                  <p className={`text-[11px] text-center font-medium ${cloudTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>{cloudTestResult}</p>
              )}
              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowCloudModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">取消</button>
                  <button onClick={handleSaveCloudConfig} disabled={!cbUrl || !cbUsername || !cbPassword} className="py-2.5 bg-sky-500 rounded-xl text-xs font-bold text-white disabled:opacity-40">保存配置</button>
              </div>
              {cloudBackupConfig.enabled && (
                  <button onClick={() => { trackEvent('关闭云端备份', { provider: cloudBackupConfig.provider === 'github' ? 'github' : 'webdav' }); updateCloudBackupConfig({ enabled: false }); setShowCloudModal(false); addToast('雲端備份已關閉', 'info'); }} className="w-full py-2 text-[11px] text-red-400 font-medium">關閉雲端備份</button>
              )}
          </div>
      </Modal>

      {/* GitHub Backup Modal — minimum-input flow: paste a token, we figure
          out owner via /user and auto-create a private 'sully-backup' repo. */}
      <Modal isOpen={showGithubModal} title="GitHub 備份" onClose={() => setShowGithubModal(false)}>
          <div className="space-y-4 p-1">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] text-slate-700 leading-relaxed">
                      <b>三步連接 GitHub：</b><br/>
                      ① 點下面按鈕跳到 GitHub 創建 Token<br/>
                      ② 複製 token，回來粘到下面框裡<br/>
                      ③ 點 <b>測試並連接</b> — 我們會自動幫你建好私有倉庫 <code className="bg-white px-1 rounded">{ghRepo || 'sully-backup'}</code>
                  </p>
                  <p className="text-[10px] text-slate-500 leading-relaxed border-t border-slate-200 pt-2">
                      <b>連接成功不等於上傳一定能通。</b> GitHub 網頁、帳號接口和 ZIP 附件上傳分別使用
                      <code className="mx-0.5 bg-white px-1 rounded">github.com</code>、
                      <code className="mx-0.5 bg-white px-1 rounded">api.github.com</code>、
                      <code className="mx-0.5 bg-white px-1 rounded">uploads.github.com</code>。
                      不同網絡、梯子分流和 iOS PWA 可能只接管其中一部分，所以會出現“網頁能進但上傳失敗”或“開著梯子反而不通”。
                  </p>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <p className="text-[10px] text-amber-800 leading-relaxed">
                      <b>⚠️ 在 GitHub 那一頁只改一處:</b><br/>
                      把 <b>Expiration</b>(有效期)下拉框 <b>從 90天 改成 No expiration</b>（永不過期）。
                      不改的話 90 天后 token 過期，備份會突然 401。<br/>
                      其它都別動 —— Note 已經填好「Sully 備份」，<b>repo</b> 權限已經勾上了，
                      直接拉到最底點綠色 <b>Generate token</b> 即可。
                  </p>
              </div>

              <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=Sully%20%E5%A4%87%E4%BB%BD"
                  target="_blank" rel="noopener noreferrer"
                  onClick={() => trackEvent('跳去 GitHub 创建 Token')}
                  className="block w-full py-3 bg-gradient-to-br from-slate-800 to-slate-900 text-white rounded-xl text-xs font-bold text-center shadow-sm active:scale-95 transition-all"
              >
                  ① 去 GitHub 創建 Token ↗
              </a>

              <div>
                  <label className="text-[11px] text-slate-500 font-medium mb-1 block">② Personal Access Token</label>
                  <input
                      type="password"
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 focus:ring-1 focus:ring-slate-300 outline-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-relaxed">
                      Token 保存在本機配置中。GitHub 默認直連；如果附件域名不通，可在下方高級選項開啟應用內中轉。
                      僅在你手動開啟後，Token 才會隨 GitHub 請求經過所選 Worker，項目不會主動留存。
                  </p>
              </div>

              <button
                  onClick={handleTestGithub}
                  disabled={ghTesting || !ghToken.trim()}
                  className="w-full py-3 bg-gradient-to-r from-emerald-500 to-green-600 text-white rounded-xl text-xs font-bold shadow-sm active:scale-95 transition-all disabled:opacity-40"
              >
                  {ghTesting ? '連接中...' : '③ 測試並連接'}
              </button>
              {ghTestResult && (
                  <p className={`text-[11px] text-center font-medium ${ghTestResult.startsWith('✓') ? 'text-green-600' : 'text-red-500'}`}>
                      {ghTestResult}
                  </p>
              )}
              {ghTestResult.startsWith('✓') && cloudBackupConfig.githubOwner && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1.5">
                      <p className="text-[11px] text-emerald-800 font-medium">
                          🎉 備份會上傳到這裡:
                      </p>
                      <a
                          href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                          target="_blank" rel="noopener noreferrer"
                          className="block text-[10px] text-emerald-700 font-mono break-all underline hover:text-emerald-900"
                      >
                          github.com/{cloudBackupConfig.githubOwner}/{cloudBackupConfig.githubRepo || 'sully-backup'}/releases ↗
                      </a>
                      <p className="text-[10px] text-emerald-700 leading-relaxed">
                          每次備份會創建一個新的 release（帶時間戳）。想看 / 刪除舊備份就去這個網址。
                      </p>
                  </div>
              )}

              <button
                  onClick={() => { if (!ghShowAdvanced) trackEvent('展开 GitHub 高级选项'); setGhShowAdvanced(v => !v); }}
                  className="w-full text-[10px] text-slate-400 underline-offset-2 hover:underline"
              >
                  {ghShowAdvanced ? '收起高級選項 ▲' : '高級選項 ▼'}
              </button>
              {ghShowAdvanced && (
                  <div className="space-y-3 bg-slate-50 rounded-xl p-3">
                      <div>
                          <label className="text-[11px] text-slate-500 font-medium mb-1 block">備份倉庫名</label>
                          <input
                              type="text"
                              value={ghRepo}
                              onChange={(e) => setGhRepo(e.target.value)}
                              placeholder="sully-backup"
                              className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-mono focus:border-slate-500 outline-none"
                          />
                          <p className="text-[10px] text-slate-400 mt-1">不存在會自動創建為私有倉庫。</p>
                      </div>
                      <label className="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer">
                          <input
                              type="checkbox"
                              checked={ghUseProxy}
                              onChange={(e) => handleGithubProxyToggle(e.target.checked)}
                              className="rounded"
                          />
                          <span>應用內 Cloudflare 中轉（與手機 / 電腦的梯子是兩回事）</span>
                      </label>
                      <p className="text-[10px] text-slate-500 leading-relaxed pl-5">
                          <b>{ghUseProxy ? '當前線路：瀏覽器 → Cloudflare Worker → GitHub。' : '當前線路：瀏覽器 → GitHub 直連。'}</b>
                          勾選狀態會立即保存，不必重新連接。系統梯子可能因規則分流、節點或 PWA 未接管而漏掉
                          <code className="mx-0.5 bg-white px-1 rounded">uploads.github.com</code>；應用內中轉是另一條獨立線路，也可能被某些網絡攔截。
                      </p>
                      <p className="text-[10px] text-slate-400 leading-relaxed pl-5">
                          中轉只負責轉發，備份仍存放在你的 GitHub 私有倉庫；項目不建立備份數據庫，也不主動留存 Token 或備份文件。
                          大於 32MB 時會自動分片，並在全部完成後發佈。
                      </p>
                  </div>
              )}

              <div className="grid grid-cols-2 gap-3 pt-2">
                  <button onClick={() => setShowGithubModal(false)} className="py-2.5 bg-slate-100 rounded-xl text-xs font-bold text-slate-500">關閉</button>
                  {cloudBackupConfig.enabled && cloudBackupConfig.provider === 'github' ? (
                      <button onClick={handleDisableCloud} className="py-2.5 bg-red-50 text-red-500 rounded-xl text-xs font-bold">斷開 GitHub</button>
                  ) : (
                      <button
                          onClick={() => setShowGithubModal(false)}
                          disabled={!cloudBackupConfig.enabled || cloudBackupConfig.provider !== 'github'}
                          className="py-2.5 bg-slate-800 text-white rounded-xl text-xs font-bold disabled:opacity-30"
                      >
                          完成
                      </button>
                  )}
              </div>
          </div>
      </Modal>

      {/* Cloud Restore Modal */}
      <Modal isOpen={showCloudRestoreModal} title="從雲端恢復" onClose={() => setShowCloudRestoreModal(false)}>
          <div className="space-y-2 p-1">
              {cloudBackupListState === 'loading' ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">正在加載雲端備份列表...</p></div>
              ) : cloudBackupListState === 'error' ? (
                  <div className="text-center py-7 px-3 space-y-3">
                      <p className="text-[11px] text-red-500 leading-relaxed">{cloudBackupListError || '獲取雲端備份列表失敗'}</p>
                      <button onClick={handleOpenCloudRestore} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-[11px] font-bold">重新加載</button>
                  </div>
              ) : cloudBackupListState === 'ready' && cloudBackupFiles.length === 0 ? (
                  <div className="text-center py-8"><p className="text-[11px] text-slate-400">雲端還沒有備份</p></div>
              ) : (
                  <>
                      <p className="text-[10px] text-slate-400 mb-2">選擇要恢復的備份文件:</p>
                      <div className="max-h-[50vh] overflow-y-auto space-y-2">
                          {cloudBackupFiles.map((file, i) => file.status === 'incomplete' ? (
                              <div key={file.href || i} className="w-full p-3 bg-amber-50/70 border border-amber-200 rounded-xl text-left">
                                  <div className="flex items-start justify-between gap-2">
                                      <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-bold">上傳未完成</span>
                                  </div>
                                  <p className="text-[10px] text-amber-700 mt-1 leading-relaxed">{file.statusMessage || '附件不完整，不能恢復'}</p>
                                  <div className="flex items-center justify-between gap-3 mt-2">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('zh-CN') : '未知時間'}</span>
                                      {cloudBackupConfig.provider === 'github' && cloudBackupConfig.githubOwner && (
                                          <a
                                              href={`https://github.com/${cloudBackupConfig.githubOwner}/${cloudBackupConfig.githubRepo || 'sully-backup'}/releases`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-[10px] text-amber-700 font-semibold hover:underline"
                                          >去 GitHub 查看 ↗</a>
                                      )}
                                  </div>
                              </div>
                          ) : (
                              <button key={file.href || i} onClick={() => handleCloudRestore(file)} className="w-full p-3 bg-white border border-slate-200 rounded-xl text-left hover:bg-sky-50 hover:border-sky-200 transition-colors active:scale-[0.98]">
                                  <p className="text-[11px] text-slate-700 font-medium truncate">{file.name}</p>
                                  <div className="flex items-center gap-3 mt-1">
                                      <span className="text-[10px] text-slate-400">{file.lastModified ? new Date(file.lastModified).toLocaleString('zh-CN') : '未知時間'}</span>
                                      <span className="text-[10px] text-slate-400">{file.size > 0 ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
                                  </div>
                              </button>
                          ))}
                      </div>
                  </>
              )}
          </div>
      </Modal>

      {/* 模型選擇 Modal */}
      <Modal isOpen={showModelModal} title="選擇模型" onClose={() => setShowModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = modelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localModel}
                            onChange={(e) => setLocalModel(e.target.value)}
                            placeholder="手動輸入模型名稱..."
                            className="flex-1 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowModelModal(false)}
                            className="px-4 py-2.5 bg-primary text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            確定
                        </button>
                    </div>
                    {availableModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={modelFilter}
                                onChange={(e) => setModelFilter(e.target.value)}
                                placeholder={`🔍 搜索 ${availableModels.length} 個模型...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-primary focus:bg-white transition-all"
                            />
                            {modelFilter && (
                                <button
                                    onClick={() => setModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >
                                    ×
                                </button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>共同前綴:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(下方已弱化顯示)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(m => {
                            const suffix = commonPrefix && m.startsWith(commonPrefix) ? m.slice(commonPrefix.length) : m;
                            const selected = m === localModel;
                            return (
                                <button
                                    key={m}
                                    onClick={() => { setLocalModel(m); setShowModelModal(false); }}
                                    title={m}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-primary/10 text-primary font-bold ring-1 ring-primary/20' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== m && (
                                            <span className={selected ? 'text-primary/40 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0"></div>}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableModels.length === 0
                                    ? '列表為空，可手動輸入或點擊"刷新模型列表"拉取'
                                    : `沒有匹配 "${modelFilter}" 的模型`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* 識圖 API 使用獨立模型列表，避免覆蓋主 API 的模型選擇。 */}
      <Modal isOpen={showVisionModelModal} title="選擇識圖模型" onClose={() => setShowVisionModelModal(false)}>
        {(() => {
            const { filtered, commonPrefix } = visionModelPickerView;
            return (
                <div className="space-y-3 p-1">
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={localVisionModel}
                            onChange={(event) => {
                                setLocalVisionModel(event.target.value);
                                setSelectedVisionPresetId(null);
                                setVisionTestResult(null);
                            }}
                            placeholder="手動輸入視覺模型名稱..."
                            className="flex-1 min-w-0 bg-white/50 border border-slate-200/60 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-violet-500 focus:bg-white transition-all"
                        />
                        <button
                            onClick={() => setShowVisionModelModal(false)}
                            className="px-4 py-2.5 bg-violet-500 text-white text-sm font-bold rounded-xl active:scale-95 transition-all"
                        >
                            確定
                        </button>
                    </div>
                    {availableVisionModels.length > 0 && (
                        <div className="relative">
                            <input
                                type="text"
                                value={visionModelFilter}
                                onChange={(event) => setVisionModelFilter(event.target.value)}
                                placeholder={`🔍 搜索 ${availableVisionModels.length} 個識圖模型...`}
                                className="w-full bg-slate-50 border border-slate-200/60 rounded-xl px-4 py-2 text-xs focus:outline-violet-500 focus:bg-white transition-all"
                            />
                            {visionModelFilter && (
                                <button
                                    onClick={() => setVisionModelFilter('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs px-2"
                                >×</button>
                            )}
                        </div>
                    )}
                    {commonPrefix && (
                        <div className="text-[10px] text-slate-400 px-1 flex items-center gap-1 flex-wrap">
                            <span>共同前綴:</span>
                            <code className="font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded break-all">{commonPrefix}</code>
                            <span className="text-slate-300">(下方已弱化顯示)</span>
                        </div>
                    )}
                    <div className="max-h-[40vh] overflow-y-auto no-scrollbar space-y-2">
                        {filtered.length > 0 ? filtered.map(model => {
                            const suffix = commonPrefix && model.startsWith(commonPrefix) ? model.slice(commonPrefix.length) : model;
                            const selected = model === localVisionModel;
                            return (
                                <button
                                    key={model}
                                    onClick={() => {
                                        setLocalVisionModel(model);
                                        setSelectedVisionPresetId(null);
                                        setVisionTestResult(null);
                                        setShowVisionModelModal(false);
                                    }}
                                    title={model}
                                    className={`w-full text-left px-4 py-3 rounded-xl text-sm font-mono flex justify-between items-start gap-2 ${selected ? 'bg-violet-100 text-violet-700 font-bold ring-1 ring-violet-200' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
                                >
                                    <span className="break-all min-w-0 flex-1 leading-relaxed">
                                        {commonPrefix && suffix !== model && (
                                            <span className={selected ? 'text-violet-400 font-normal' : 'text-slate-400 font-normal'}>{commonPrefix}</span>
                                        )}
                                        <span>{suffix}</span>
                                    </span>
                                    {selected && <div className="w-2 h-2 rounded-full bg-violet-500 mt-1.5 shrink-0" />}
                                </button>
                            );
                        }) : (
                            <div className="text-center text-slate-400 py-8 text-xs">
                                {availableVisionModels.length === 0
                                    ? '列表為空，可手動輸入或點擊“刷新模型列表”拉取'
                                    : `沒有匹配 "${visionModelFilter}" 的模型`}
                            </div>
                        )}
                    </div>
                </div>
            );
        })()}
      </Modal>

      {/* API 調用記錄頁面 */}
      <ApiCallLogModal isOpen={showApiCallLog} onClose={() => setShowApiCallLog(false)} />

      {/* Preset Name Modal */}
      <Modal isOpen={showPresetModal} title="新建預設" onClose={() => setShowPresetModal(false)} footer={<button onClick={handleSavePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">新建</button>}>
          <div className="space-y-2">
              <label className="text-[10px] font-bold text-slate-400 uppercase">預設名稱 (例如: DeepSeek)</label>
              <input value={newPresetName} onChange={e => setNewPresetName(e.target.value)} className="w-full bg-slate-100 rounded-xl px-4 py-3 text-sm focus:outline-primary" autoFocus placeholder="Name..." />
              <p className="text-[10px] text-slate-400 leading-relaxed pt-1">會保存上面表單裡的 URL / Key / Model，以及高級設置中的流式與溫度。</p>
          </div>
      </Modal>

      {/* 編輯預設：只改這條預設本身；正在用它的話，當前配置一併跟著走 */}
      <Modal
          isOpen={!!editingPresetId}
          title="編輯預設"
          onClose={() => setEditingPresetId(null)}
          footer={<button onClick={handleUpdatePreset} className="w-full py-3 bg-primary text-white font-bold rounded-2xl">保存</button>}
      >
          <div className="space-y-3">
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">名稱</label>
                  <input value={editPresetName} onChange={e => setEditPresetName(e.target.value)} placeholder="預設名稱" className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">URL</label>
                  <input value={editPresetUrl} onChange={e => setEditPresetUrl(e.target.value)} placeholder="https://..." className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Key</label>
                  <input type="password" value={editPresetKey} onChange={e => setEditPresetKey(e.target.value)} placeholder="sk-..." className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Model</label>
                  <input value={editPresetModel} onChange={e => setEditPresetModel(e.target.value)} placeholder="模型名稱" className="w-full bg-slate-100 rounded-xl px-4 py-2.5 text-sm font-mono focus:outline-primary" />
              </div>
              <div className="rounded-xl border border-slate-100 bg-slate-50/70 px-3 py-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                      <div>
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">流式輸出 (Stream)</p>
                          <p className="text-[9px] text-slate-300 mt-0.5">隨這條預設獨立保存</p>
                      </div>
                      <button
                          type="button"
                          aria-label="預設流式輸出"
                          aria-pressed={editPresetStream}
                          onClick={() => setEditPresetStream(value => !value)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${editPresetStream ? 'bg-primary' : 'bg-slate-200'}`}
                      >
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${editPresetStream ? 'translate-x-4' : 'translate-x-0.5'}`} />
                      </button>
                  </div>
                  <div>
                      <div className="flex items-center justify-between">
                          <label htmlFor="edit-preset-temperature" className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">溫度 (Temperature)</label>
                          <span className="text-[10px] font-mono text-slate-400">{editPresetTemperature.toFixed(2)}</span>
                      </div>
                      <input
                          id="edit-preset-temperature"
                          type="range"
                          min="0"
                          max="2"
                          step="0.05"
                          value={editPresetTemperature}
                          onChange={event => setEditPresetTemperature(parseFloat(event.target.value))}
                          className="w-full accent-primary mt-1"
                      />
                  </div>
              </div>
              <button
                  type="button"
                  onClick={() => {
                      setEditPresetUrl(localUrl);
                      setEditPresetKey(localKey);
                      setEditPresetModel(localModel);
                      setEditPresetStream(localStream);
                      setEditPresetTemperature(localTemperature);
                      addToast('已填入當前配置', 'info');
                  }}
                  className="w-full py-2 bg-slate-100 text-slate-500 text-xs font-bold rounded-xl active:scale-95 transition-transform"
              >
                  用當前完整配置填入
              </button>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                  {editingPresetId && activePresetId === editingPresetId
                      ? '這條正在使用中，保存後當前配置會一起換成新的值。'
                      : '只改這條預設，當前生效的配置不受影響。'}
              </p>
          </div>
      </Modal>

      {/* 強制導出 Modal */}
      <Modal isOpen={showExportModal} title="備份下載" onClose={() => { revokeDownloadUrl(); setShowExportModal(false); }} footer={
          <div className="flex gap-2 w-full">
               <button onClick={() => { revokeDownloadUrl(); setShowExportModal(false); }} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">關閉</button>
          </div>
      }>
          <div className="space-y-4 text-center py-4">
              <div className="w-16 h-16 bg-green-100 text-green-500 rounded-full flex items-center justify-center mx-auto mb-2">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
              </div>
              <p className="text-sm font-bold text-slate-700">備份文件已生成！</p>
              <p className="text-xs text-slate-500">如果瀏覽器沒有自動下載，請點擊下方鏈接。</p>
              {downloadUrl && <a href={downloadUrl} download={downloadFileName} className="text-primary text-sm underline block py-2">點擊手動下載 .zip</a>}
          </div>
      </Modal>

      {/* 實時感知配置 Modal */}
      <Modal
          isOpen={showRealtimeModal}
          title="實時感知配置"
          onClose={() => setShowRealtimeModal(false)}
          footer={<button onClick={handleSaveRealtimeConfig} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg">保存配置</button>}
      >
          <div className="space-y-5 max-h-[60vh] overflow-y-auto no-scrollbar">
              {/* 天氣配置 */}
              <div className="bg-emerald-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Sun size={20} weight="fill" />
                          <span className="text-sm font-bold text-emerald-700">天氣感知</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtWeatherEnabled} onChange={e => setRtWeatherEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                      </label>
                  </div>
                  {rtWeatherEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">OpenWeatherMap API Key（可選）</label>
                              <input type="password" value={rtWeatherKey} onChange={e => setRtWeatherKey(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="留空則用免費的 Open-Meteo，無需註冊" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">城市</label>
                              <input type="text" value={rtWeatherCity} onChange={e => setRtWeatherCity(e.target.value)} className="w-full bg-white/80 border border-emerald-200 rounded-xl px-3 py-2 text-sm" placeholder="北京 / Beijing / Shanghai" />
                          </div>
                          <button onClick={testWeatherApi} className="w-full py-2 bg-emerald-100 text-emerald-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">測試天氣API</button>
                      </div>
                  )}
              </div>

              {/* 新聞配置 */}
              <div className="bg-blue-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Newspaper size={20} weight="fill" />
                          <span className="text-sm font-bold text-blue-700">新聞熱點</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNewsEnabled} onChange={e => setRtNewsEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  {rtNewsEnabled && (
                      <div className="space-y-2">
                          <p className="text-xs text-blue-600/70">默認主源：中文多平台熱榜（免鑑權，聊天時角色會自動捕捉熱點）。選擇要關注的平台：</p>
                          <div className="flex flex-wrap gap-1.5">
                              {HOTNEWS_PLATFORM_OPTIONS.map(p => {
                                  const active = rtNewsPlatforms.includes(p.key);
                                  return (
                                      <button
                                          key={p.key}
                                          type="button"
                                          onClick={() => setRtNewsPlatforms(prev => prev.includes(p.key) ? prev.filter(k => k !== p.key) : [...prev, p.key])}
                                          className={`text-[11px] px-2.5 py-1 rounded-full font-bold transition-colors active:scale-95 ${active ? 'bg-blue-500 text-white shadow-sm' : 'bg-white/80 text-slate-500 border border-blue-200'}`}
                                      >
                                          {p.label}
                                      </button>
                                  );
                              })}
                          </div>
                          {rtNewsPlatforms.length === 0 && (
                              <p className="text-[10px] text-rose-500/80">未選任何平台時會回落到 Brave / Hacker News。</p>
                          )}
                          <details className="border-t border-blue-200/50 pt-2 mt-1 group">
                              <summary className="text-[10px] font-bold text-slate-400 uppercase cursor-pointer select-none list-none flex items-center gap-1.5">
                                  <span className="transition-transform group-open:rotate-90">›</span>
                                  Brave Search（回落源 · <span className="text-rose-400">不建議配置</span>）
                              </summary>
                              <div className="mt-2 space-y-1.5">
                                  <p className="text-[10px] text-slate-400/90 leading-relaxed">
                                      上面的中文熱榜在國內場景比 Brave 好用一萬倍，<b className="text-slate-500">基本不需要配這個</b>。
                                      它只是熱榜徹底拉不到時的英文回落，配了反而可能蓋掉中文熱點。除非你清楚自己在做什麼，否則留空即可。
                                  </p>
                                  <input type="password" value={rtNewsApiKey} onChange={e => setRtNewsApiKey(e.target.value)} className="w-full bg-white/60 border border-slate-200 rounded-xl px-3 py-2 text-sm font-mono text-slate-500" placeholder="（不建議）brave.com/search/api" />
                                  <p className="text-[10px] text-slate-400/70">僅當中文熱榜拉取失敗時才啟用；都不可用時再兜底 Hacker News（英文）。</p>
                              </div>
                          </details>
                      </div>
                  )}
              </div>

              {/* Firecrawl 網頁讀取：方舟計劃默認隱藏，代碼與降級能力保留。 */}
              {SHOW_FIRECRAWL_ARK_UI && (
              <div className="bg-amber-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                          <PlugsConnected size={20} weight="fill" className="text-amber-600 shrink-0" />
                          <div className="min-w-0">
                              <span className="text-sm font-bold text-amber-800">Firecrawl 網頁讀取</span>
                              <p className="text-[10px] text-amber-700/60">網頁分享抓取增強 · 可選</p>
                          </div>
                      </div>
                      <a
                          href={FIRECRAWL_API_KEYS_URL}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 text-[10px] bg-white border border-amber-200 text-amber-700 px-2.5 py-1.5 rounded-full font-bold"
                      >
                          前往免費註冊 ↗
                      </a>
                  </div>

                  <p className="text-[10px] text-amber-800/70 leading-relaxed">
                      聊天裡粘貼普通網頁時，原有提取失敗後會自動用 Firecrawl 讀取動態頁面；再失敗仍會回落 Jina 與 Worker，不會因額度耗盡讓分享失效。免費計劃目前每月約 1,000 頁。
                  </p>

                  {!firecrawlKeyInput.trim() && (
                      <ol className="rounded-xl border border-amber-200/80 bg-white/70 px-3 py-2 text-[10px] text-amber-900/75 leading-relaxed space-y-1">
                          <li><b>1.</b> 點擊“前往免費註冊”，在 Firecrawl 註冊或登錄。</li>
                          <li><b>2.</b> 進入 API Keys，創建並複製一個以 <b>fc-</b> 開頭的 Key。</li>
                          <li><b>3.</b> 回到這裡粘貼，點擊“保存並檢查額度”。</li>
                      </ol>
                  )}

                  <input
                      type="password"
                      value={firecrawlKeyInput}
                      onChange={e => {
                          setFirecrawlKeyInput(e.target.value);
                          setFirecrawlCheckResult(null);
                          setFirecrawlUsage(null);
                      }}
                      className="w-full bg-white/90 border border-amber-200 rounded-xl px-3 py-2 text-sm font-mono"
                      placeholder="fc-..."
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                  />

                  <div className="grid grid-cols-2 gap-2">
                      <button
                          type="button"
                          onClick={handleClearFirecrawl}
                          disabled={firecrawlChecking || !firecrawlKeyInput}
                          className="py-2 bg-white/80 border border-amber-200 text-amber-700 text-xs font-bold rounded-xl disabled:opacity-40 active:scale-95 transition-transform"
                      >
                          清除
                      </button>
                      <button
                          type="button"
                          onClick={() => void handleCheckFirecrawl()}
                          disabled={firecrawlChecking}
                          className="py-2 bg-amber-500 text-white text-xs font-bold rounded-xl disabled:opacity-50 active:scale-95 transition-transform"
                      >
                          {firecrawlChecking ? '檢查中…' : '保存並檢查額度'}
                      </button>
                  </div>

                  {firecrawlUsage && (
                      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[10px] text-emerald-800 leading-relaxed">
                          <b>剩餘 {firecrawlUsage.remainingCredits.toLocaleString()} / {firecrawlUsage.planCredits.toLocaleString()} credits</b>
                          {firecrawlUsage.billingPeriodEnd && (
                              <span> · {new Date(firecrawlUsage.billingPeriodEnd).toLocaleDateString('zh-CN')} 刷新</span>
                          )}
                      </div>
                  )}
                  {firecrawlCheckResult && !firecrawlUsage && (
                      <p className={`text-[10px] leading-relaxed ${firecrawlCheckResult.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {firecrawlCheckResult.ok ? '✓ ' : '✗ '}{firecrawlCheckResult.text}
                      </p>
                  )}

                  <p className="text-[9px] text-slate-400 leading-relaxed">
                      Key 僅保存在當前設備，並由設備直接連接 Firecrawl，不經過項目 Worker。請求明確關閉 Firecrawl 頁面緩存；請勿分享需要登錄的私密鏈接。
                  </p>
              </div>
              )}

              {/* Notion 配置 */}
              <div className="bg-orange-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <NotePencil size={20} weight="fill" />
                          <span className="text-sm font-bold text-orange-700">Notion 日記</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtNotionEnabled} onChange={e => setRtNotionEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-orange-500"></div>
                      </label>
                  </div>
                  {rtNotionEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Notion Integration Token</label>
                              <input type="password" value={rtNotionKey} onChange={e => setRtNotionKey(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="ntn_... 或 secret_..." />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">Database ID</label>
                              <input type="text" value={rtNotionDbId} onChange={e => setRtNotionDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="從數據庫URL複製" />
                          </div>
                          <button onClick={testNotionApi} className="w-full py-2 bg-orange-100 text-orange-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">測試Notion連接</button>
                          <div className="border-t border-orange-200/50 pt-2 mt-2">
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">筆記數據庫 ID（可選）</label>
                              <input type="text" value={rtNotionNotesDbId} onChange={e => setRtNotionNotesDbId(e.target.value)} className="w-full bg-white/80 border border-orange-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="用戶日常筆記的數據庫ID" />
                              <p className="text-[10px] text-orange-500/60 leading-relaxed mt-1">
                                  填寫后角色可以偶爾看到你的筆記標題，溫馨地提起你寫的內容。留空則不啟用。
                              </p>
                          </div>
                          <p className="text-[10px] text-orange-500/70 leading-relaxed">
                               1. 在 <a href="https://www.notion.so/my-integrations" target="_blank" className="underline">Notion開發者</a> 創建Integration（新版 Token 以 ntn_ 開頭，老版以 secret_ 開頭，都能用）<br/>
                               2. 創建一個日記數據庫，添加"Name"(標題)和"Date"(日期)屬性<br/>
                               3. 在數據庫右上角菜單中 Connect 你的 Integration<br/>
                               Token 保存在本機配置中；啟用後，所選數據庫的請求會由網絡 Worker 轉發，項目不主動留存日記內容。
                          </p>
                      </div>
                  )}
              </div>

              {/* 飛書配置 (中國區替代) */}
              <div className="bg-indigo-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Notebook size={20} weight="fill" />
                          <span className="text-sm font-bold text-indigo-700">飛書日記</span>
                          <span className="text-[9px] bg-indigo-100 text-indigo-500 px-1.5 py-0.5 rounded-full">中國區</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtFeishuEnabled} onChange={e => setRtFeishuEnabled(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                      Notion 的中國區替代方案，無需翻牆。使用飛書多維表格存儲日記。
                  </p>
                  {rtFeishuEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">飛書 App ID</label>
                              <input type="text" value={rtFeishuAppId} onChange={e => setRtFeishuAppId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="cli_xxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">飛書 App Secret</label>
                              <input type="password" value={rtFeishuAppSecret} onChange={e => setRtFeishuAppSecret(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="xxxxxxxxxxxxxxxx" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">多維表格 App Token</label>
                              <input type="text" value={rtFeishuBaseId} onChange={e => setRtFeishuBaseId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="從多維表格URL中獲取" />
                          </div>
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">數據表 Table ID</label>
                              <input type="text" value={rtFeishuTableId} onChange={e => setRtFeishuTableId(e.target.value)} className="w-full bg-white/80 border border-indigo-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="tblxxxxxxxx" />
                          </div>
                           <button onClick={testFeishuApi} className="w-full py-2 bg-indigo-100 text-indigo-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">測試讀取連接</button>
                           <p className="rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-700">
                               測試不會新增記錄，只驗證憑據、讀取權限和 Table ID。讀取成功但寫入提示 Forbidden，說明還缺新增記錄權限。
                           </p>
                           <p className="text-[10px] text-indigo-500/70 leading-relaxed">
                                1. 在 <a href="https://open.feishu.cn/app" target="_blank" className="underline">飛書開放平台</a> 創建企業自建應用，獲取 App ID 和 Secret<br/>
                                2. 開通「查看、評論、編輯和管理多維表格」權限，創建併發布新版本，完成管理員審批<br/>
                                3. 在目標多維表格的「添加文檔應用」中加入該應用，並授予可編輯權限（開了高級權限時也要允許新增記錄）<br/>
                                4. 添加字段: 標題(文本)、內容(文本)、日期(日期)、心情(文本)、角色(文本)<br/>
                                5. 從多維表格 URL 中獲取 App Token 和 Table ID<br/>
                                App Secret 保存在本機配置中；啟用後，多維表格請求會由網絡 Worker 轉發，項目不主動留存表格內容。
                           </p>
                      </div>
                  )}
              </div>

              {/* 小紅書自動化 */}
              <div className="bg-red-50/50 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-red-700">小紅書 · 本地</span>
                          <span className="text-[9px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded-full">MCP 兼容 / Skills</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'local'} onChange={e => { if (e.target.checked) { setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('local'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-red-500/70 leading-relaxed">
                      本地模式繼續可用：xiaohongshu-mcp 走 MCP 協議，xhs-bridge / Skills 走本地 /api。MCP 保留兼容，但不再承諾隨其上游版本持續適配；新配置建議使用下方持續維護的 Lite。
                  </p>
                  {rtXhsMcpEnabled && rtXhsMode === 'local' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">服務器 URL</label>
                              <input value={rtXhsLocalUrl} onChange={e => setRtXhsLocalUrl(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="http://localhost:18060/mcp" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-red-100 text-red-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">測試連接</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小紅書暱稱</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px]" placeholder="手動填寫" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">用戶 ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-red-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="可選，用於查看主頁" />
                              </div>
                          </div>
                          <p className="text-[10px] text-red-500/70 leading-relaxed">
                              <b>MCP 模式:</b> 下載 xiaohongshu-mcp + 運行腳本，URL 填 http://localhost:18060/mcp（代理則 18061/mcp）<br/>
                              <b>Skills 模式:</b> URL 填 http://localhost:18061/api（需 Python + xhs-bridge.mjs，額外支持視頻/長文）<br/>
                              系統按 URL 結尾自動判斷（/mcp 或 /api）。
                          </p>
                      </div>
                  )}
              </div>

              {/* 小紅書 Lite (雲端) */}
              <div className="bg-rose-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Book size={20} weight="fill" />
                          <span className="text-sm font-bold text-rose-700">小紅書 Lite</span>
                          <span className="text-[9px] bg-rose-100 text-rose-500 px-1.5 py-0.5 rounded-full">持續維護</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={rtXhsMcpEnabled && rtXhsMode === 'lite'} onChange={e => { if (e.target.checked) { if (!window.confirm(XHS_RISK_TEXT + '\n\n確定要開啟嗎？')) return; setRtXhsMcpEnabled(true); setRtXhsEnabled(true); setRtXhsMode('lite'); } else { setRtXhsMcpEnabled(false); setRtXhsEnabled(false); } }} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-rose-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-rose-500/70 leading-relaxed">
                      免電腦、免掃碼：粘貼一次小紅書 / RedNote cookie，即可搜索、瀏覽、看詳情及互動；國內小紅書還支持發帖(帶圖)。地址已內置，無需填寫。
                  </p>
                  <p className="text-[10px] text-amber-700 leading-relaxed bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">{XHS_RISK_TEXT}</p>
                  {rtXhsMcpEnabled && rtXhsMode === 'lite' && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小紅書 Cookie</label>
                              <textarea value={rtXhsCookie} onChange={e => { setRtXhsCookie(e.target.value); setRtXhsPlatform(undefined); }} rows={2} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[10px] font-mono resize-y" placeholder="a1=...; web_session=...; （從瀏覽器登錄後複製完整 cookie）" />
                          </div>
                          <button onClick={testXhsMcp} className="w-full py-2 bg-rose-100 text-rose-600 text-xs font-bold rounded-xl active:scale-95 transition-transform">測試連接</button>
                          <div className="grid grid-cols-2 gap-2">
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">小紅書暱稱</label>
                                  <input value={rtXhsNickname} onChange={e => setRtXhsNickname(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px]" placeholder="測試連接後自動獲取" />
                              </div>
                              <div>
                                  <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">用戶 ID</label>
                                  <input value={rtXhsUserId} onChange={e => setRtXhsUserId(e.target.value)} className="w-full bg-white/80 border border-rose-200 rounded-xl px-3 py-2 text-[11px] font-mono" placeholder="自動獲取" />
                              </div>
                          </div>
                          <div>
                              <button type="button" onClick={() => { if (!rtXhsGuideOpen) trackEvent('展开获取 cookie 教程'); setRtXhsGuideOpen(v => !v); }} className="text-[11px] font-bold text-rose-600 underline">📖 點擊獲取 cookie 教程 {rtXhsGuideOpen ? '▲' : '▼'}</button>
                              {rtXhsGuideOpen && (
                                  <div className="mt-1 bg-white/70 rounded-lg p-2 space-y-1.5">
                                      <pre className="text-[10px] text-slate-600 whitespace-pre-wrap font-sans leading-relaxed">{XHS_COOKIE_GUIDE}</pre>
                                      <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(XHS_COOKIE_GUIDE); trackEvent('复制 cookie 教程文本', { result: 'copied' }); addToast('教程已複製，可粘貼去問別的 AI', 'success'); } catch { trackEvent('复制 cookie 教程文本', { result: 'clipboard-failed' }); addToast('複製失敗，請長按手動選擇', 'error'); } }} className="w-full py-1.5 bg-rose-100 text-rose-600 text-[11px] font-bold rounded-lg active:scale-95 transition-transform">複製教程</button>
                                  </div>
                              )}
                          </div>
                          <p className="text-[10px] text-slate-400 leading-relaxed bg-slate-100/60 rounded-lg px-2 py-1.5">
                              使用說明：Cookie 保存在本機配置中；使用 Lite 時會隨請求發送到網絡 Worker，用於登錄校驗和接口簽名，當前開源 Worker 不主動留存。建議使用小號，並在退出帳號或 Cookie 失效後及時更新。
                          </p>
                      </div>
                  )}
              </div>

              {/* 麥當勞 MCP */}
              <div className="bg-yellow-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <ForkKnife size={20} weight="fill" className="text-yellow-600" />
                          <span className="text-sm font-bold text-yellow-700">麥當勞</span>
                          <span className="text-[9px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full">官方 MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={mcdEnabled} onChange={e => handleMcdEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-yellow-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                      啟用後，在聊天裡點 + 號 → 第二頁 → 麥當勞，發送"麥請求"激活，角色就能為你查菜單、查門店、點麥樂送/到店取餐/團餐、積分兌券、查活動。
                  </p>
                  {mcdEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (個人)</label>
                              <input type="password" value={mcdToken} onChange={e => handleMcdTokenChange(e.target.value)} className="w-full bg-white/80 border border-yellow-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="去 open.mcd.cn/mcp 申請" />
                          </div>
                          <button onClick={testMcdApi} disabled={mcdTesting} className="w-full py-2 bg-yellow-100 text-yellow-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {mcdTesting ? '測試中…' : '測試連接'}
                          </button>
                          {mcdTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${mcdTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : mcdTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {mcdTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-yellow-700/70 leading-relaxed">
                              1. 訪問 <a href="https://open.mcd.cn/mcp" target="_blank" className="underline">open.mcd.cn/mcp</a> 用麥當勞帳號登錄申請 Token<br/>
                              2. Token 保存在本機配置中；使用點單功能時會隨 MCP 請求由網絡 Worker 轉發，項目不主動留存<br/>
                              3. 下單類操作涉及真實支付，角色會先複述清單等你確認再下單<br/>
                              4. 僅中國大陸 (不含港澳台)
                          </p>
                      </div>
                  )}
              </div>

              {/* 瑞幸 MCP */}
              <div className="bg-blue-50/60 p-4 rounded-2xl space-y-3">
                  <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                          <Coffee size={20} weight="fill" className="text-blue-600" />
                          <span className="text-sm font-bold text-blue-700">瑞幸咖啡</span>
                          <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full">官方 MCP</span>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" checked={luckinEnabled} onChange={e => handleLuckinEnabledChange(e.target.checked)} className="sr-only peer" />
                          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                  </div>
                  <p className="text-[10px] text-blue-700/70 leading-relaxed">
                      啟用後，在聊天裡點 + 號 → 第二頁 → 瑞一杯，發送"瑞一杯"激活，角色就能為你查門店、搜咖啡、選規格、下單到店自提、查取餐碼。
                  </p>
                  {luckinEnabled && (
                      <div className="space-y-2">
                          <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">MCP Token (個人)</label>
                              <input type="password" value={luckinToken} onChange={e => handleLuckinTokenChange(e.target.value)} className="w-full bg-white/80 border border-blue-200 rounded-xl px-3 py-2 text-sm font-mono" placeholder="去 open.lkcoffee.com 登錄後複製" />
                          </div>
                          <button onClick={testLuckinApi} disabled={luckinTesting} className="w-full py-2 bg-blue-100 text-blue-700 text-xs font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60">
                              {luckinTesting ? '測試中…' : '測試連接'}
                          </button>
                          {luckinTestStatus && (
                              <div className={`p-2 rounded-lg text-[11px] whitespace-pre-line leading-relaxed ${luckinTestStatus.startsWith('✅') ? 'bg-emerald-50 text-emerald-700' : luckinTestStatus.startsWith('❌') ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-600'}`}>
                                  {luckinTestStatus}
                              </div>
                          )}
                          <p className="text-[10px] text-blue-700/70 leading-relaxed">
                              1. 訪問 <a href="https://open.lkcoffee.com" target="_blank" className="underline">open.lkcoffee.com</a> 用瑞幸帳號登錄，複製 Token（有效期約 1 個月）<br/>
                              2. Token 保存在本機配置中；使用點單功能時會隨 MCP 請求由網絡 Worker 轉發，項目不主動留存<br/>
                              3. 下單類操作涉及真實支付，角色會先複述清單等你確認再下單<br/>
                              4. 上游需經 Worker 代理 (/mcp/luckin)，請確保已部署最新 worker
                          </p>
                      </div>
                  )}
              </div>

              {/* 測試狀態 */}
              {rtTestStatus && (
                  <div className={`p-3 rounded-xl text-xs font-medium text-center ${rtTestStatus.includes('成功') ? 'bg-emerald-100 text-emerald-700' : rtTestStatus.includes('失敗') || rtTestStatus.includes('錯誤') ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                      {rtTestStatus}
                  </div>
              )}
          </div>
      </Modal>

      {/* 通用 MCP 管理（從實時感知裡獨立出來） */}
      <Modal isOpen={showMcpModal} title="MCP" onClose={() => { setShowMcpModal(false); flushMcpToolConfigSync(); }}>
          <div className="space-y-4">
              <McpConnectionConsole addToast={addToast} onMcpConfigChanged={() => {
                  // MCP 配置變更只需重傳 tool_config：提示詞塊與 tools 數組由 worker 在 fire 時
                  // 從 tool_config 現場生成（見 mcpFireCore），不經過 fire_pack，沒有陳舊問題，
                  // 所以不用像實時感知那樣連提示詞一起刷（syncAmsgToolConfigAndPrompts）。
                  // 這一份尤其不能傳丟：刪掉的服務器要是沒同步上去，worker 半夜還會帶著
                  // 舊 token 去直連它。重試和底帳由 syncAmsgToolConfig 負責。
                  scheduleMcpToolConfigSync(() => syncAmsgToolConfig(realtimeConfig));
              }} />
          </div>
      </Modal>

      {/* MCP 幫助 Modal —— 面向完全不懂 MCP 的用戶，講清用途與部署方式 */}
      <Modal isOpen={showMcpHelp} title="MCP 是什麼？" onClose={() => setShowMcpHelp(false)}>
          <div className="space-y-3 text-xs text-slate-600 leading-relaxed">
              <div className="bg-violet-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-violet-700">MCP 工具服務器</p>
                  <p>
                      MCP（Model Context Protocol）是一套開放協議。接上資料庫、聯網搜索、筆記或智能家居後，
                      Sully 可以在聊天中調用它們。MCP 配置不會覆蓋角色設定、關係或記憶。
                  </p>
              </div>
              <div className="bg-sky-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-sky-700">🏠 為什麼服務器要自己準備？</p>
                  <p>
                      Soren 的核心前端可以靜態部署，也沒有強制所有 MCP 流量經過項目方的中央代理。
                      URL 和憑據默認留在本機，工具服務器需要你自己準備，三選一：
                  </p>
                  <p>
                      ☁️ <b>用現成的雲端 MCP 服務</b>：對方給你一個公網 https 地址（可能還有 Token），直接填進配置即可。<br/>
                      🖥️ <b>跑在自己電腦上</b>：電腦上的瀏覽器直接填 <code className="bg-white/80 px-1 rounded">http://localhost:端口</code>；
                      想在手機上也能用，再配個內網穿透（如 Cloudflare Tunnel）。<br/>
                      🚀 <b>自己部署到雲上</b>：VPS / Cloudflare / Zeabur 等，任何設備隨時可用。
                  </p>
              </div>
              <div className="bg-amber-50/60 rounded-xl p-3 space-y-1.5">
                  <p className="font-bold text-amber-700">🚧 測試連接報「Failed to fetch」？</p>
                  <p>
                      八成是瀏覽器的 CORS 跨域攔截（靜態網頁的另一個代價）。能改服務器就在服務器端配好 CORS；
                      改不了就在配置裡填「代理 URL」——本地跑一個小代理，或把倉庫裡的 Worker 代理部署到你自己的
                      Cloudflare 帳號，教程裡都有現成步驟。
                  </p>
              </div>
              <div className="space-y-2">
                  <a
                      href={MCP_USER_GUIDE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => trackEvent('跳转 MCP 完整教程')}
                      className="block w-full py-2.5 bg-violet-500 text-white text-center text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >📖 打開完整教程（含部署示例）</a>
                  <button
                      type="button"
                      onClick={async () => {
                          const text = `請閱讀這份教程，然後一步一步教我把 MCP 工具服務器接入 Soren。先問清楚我想接什麼工具、準備部署在哪（雲端/本地電腦/本地+內網穿透），再給對應路線的步驟：\n${MCP_USER_GUIDE_URL}`;
                          try { await navigator.clipboard.writeText(text); trackEvent('复制 MCP 部署指引给 AI', { result: 'copied' }); addToast('已複製，去粘貼給你的 AI 吧', 'success'); }
                          catch { trackEvent('复制 MCP 部署指引给 AI', { result: 'clipboard-failed' }); addToast('複製失敗，請手動複製教程鏈接', 'error'); }
                      }}
                      className="w-full py-2.5 bg-violet-100 text-violet-700 text-xs font-bold rounded-xl active:scale-95 transition-transform"
                  >🤖 複製鏈接給你的 AI，讓它帶你部署</button>
                  <p className="text-[10px] text-slate-400 text-center">教程是自包含的，任何 AI 助手讀完都能帶你走完全程。</p>
              </div>
          </div>
      </Modal>

      {/* 確認重置 Modal */}
      <Modal
          isOpen={showResetConfirm}
          title="系統警告"
          onClose={() => setShowResetConfirm(false)}
          footer={
              <div className="flex gap-2 w-full">
                  <button onClick={() => setShowResetConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl">取消</button>
                  <button onClick={confirmReset} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200">確認格式化</button>
              </div>
          }
      >
          <div className="flex flex-col items-center gap-3 py-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-12 h-12 text-red-500"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>
              <p className="text-center text-sm text-slate-600 font-medium">
                  這將<span className="text-red-500 font-bold">永久刪除</span>所有角色、聊天記錄和設置，且無法恢復！
              </p>
          </div>
      </Modal>

      <PushVapidSettingsModal
        open={showVapidModal}
        onClose={() => { setShowVapidModal(false); setVapidReadyTick((n) => n + 1); }}
      />
      <ActiveMsgGlobalSettingsModal
        isOpen={showAmsg2Modal}
        onClose={() => setShowAmsg2Modal(false)}
        addToast={addToast}
        realtimeConfig={realtimeConfig}
        onOpenVapid={() => { setShowAmsg2Modal(false); setShowVapidModal(true); }}
      />

    </div>
  );
};

export default Settings;
