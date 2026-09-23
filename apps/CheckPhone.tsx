import { loadCharacterContextMessages } from '../utils/chatContextRange';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneEvidence, PhoneCustomApp, PhoneContact, PhoneSimLog, ConvTopic, AiSession, AiServiceKind, TavernCard, APIConfig, NPCProfile } from '../types';
import { ContextBuilder } from '../utils/context';
import Modal from '../components/os/Modal';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl } from '../utils/blobRef';
import { safeResponseJson, extractContent, extractJson } from '../utils/safeApi';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import {
    runRealConversation, runNpcConversation, upsertContact, matchRealChar,
    clampAffinity, normName, flipTranscript, parseTranscript, serializeTurns, appendLearned,
    topicText, summarizeConversation, applyRealConversationToPhoneState,
} from '../utils/relationshipChat';
import PersonaSim, { LifeLog, generatePersonaScript } from './PersonaSim';
import { usePersonaSim, personaSimStore } from '../utils/personaSimStore';
import { getLastInnerState } from '../utils/emotionApply';
import { trackEvent } from '../utils/analytics';
import { buildPhoneEvidenceChatCard, normalizePhoneEvidence, phoneFieldToText } from '../utils/phoneEvidence';
import { resolveCustomAppRecordHtml, composeCustomAppCardHtml, buildCustomAppHtmlCardNote, buildCustomAppAntiRepeatNote } from '../utils/phoneCustomAppCard';
import HtmlCard from '../components/chat/HtmlCard';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
import { getCheckPhoneApi, resolveCheckPhoneApi, setCheckPhoneApi } from '../utils/checkPhoneApi';
import { resolveUserProfileForChar } from '../utils/userPersona';
import { ensureRealBalanceState } from '../utils/realBalance';
import RealBalancePanel from '../components/bank/RealBalancePanel';
import TrajectoryHome from '../components/trajectory/TrajectoryHome';
import TrajectoryAlbum from '../components/trajectory/TrajectoryAlbum';
import {
    User, Phone, ChatCircleDots, ChatCircle, ShoppingBag, Hamburger, GearSix,
    Plus, SignOut, CaretLeft, CaretRight, Cloud, ImagesSquare, LockSimple, Package,
    Storefront, Heart, ArrowsClockwise, Tray, DotsThree, ClockCounterClockwise, Sparkle,
    UsersThree, UserPlus, Prohibit, LinkSimple, PaperPlaneTilt, PencilSimple, Trash,
    Robot, Brain, MaskHappy, Question, PaintBrush, CreditCard, MapTrifold, Stack
} from '@phosphor-icons/react';
import { includesAnyScript } from '../utils/scriptKey';

type LayoutId = NonNullable<PhoneCustomApp['layout']>;

const APP_LAYOUTS: { id: LayoutId; name: string; desc: string; icon: string }[] = [
    { id: 'generic', name: '通用卡片', desc: '標題 + 內容信息流', icon: '🗂️' },
    { id: 'shop', name: '購物風格', desc: '商品 / 價格 / 狀態', icon: '🛍️' },
    { id: 'feed', name: '社交動態', desc: '頭像 / 正文 / 點贊', icon: '💬' },
    { id: 'forum', name: '論壇風格', desc: '帖子 / 樓層 / 回覆', icon: '📋' },
    { id: 'novel', name: '小說風格', desc: '章節 / 正文閱讀', icon: '📖' },
];

// 智能體 App：機主自己在玩的三類 AI 服務
const AI_SERVICES: { id: AiServiceKind; name: string; tagline: string; accent: string }[] = [
    { id: 'assistant', name: 'AI 助手', tagline: '工具型 · 問東問西，搜索記錄即日記', accent: '#34d399' },
    { id: 'claude', name: '深度對話', tagline: '樹洞 · 當面不會說的真心話都在這', accent: '#a78bfa' },
    { id: 'tavern', name: '酒館', tagline: '角色扮演 · TA 自己捏卡跟 AI 對戲', accent: '#fb7185' },
];

// 智能體長會話自動總結（參考 TRPG 範式）：超過這麼多「條」(行) 觸發一次總結
const AI_SUMMARY_THRESHOLD = 100;
// 總結後保留最近這麼多條不折疊，保證劇情連貫
const AI_KEEP_RECENT = 12;

// 各家 AI 的刻板印象 / 八股 —— 注進生成 & 續寫 prompt，讓偷看到的 AI 回覆有"那個味兒"
const AI_VENDOR_LORE = `各家 AI 的刻板印象 + 八股口頭禪（每段會話固定一家，"對方:" 要把那家的味道演足，別寫成千篇一律的中立助手）：
- 豆包：極盡捧場、彩虹屁拉滿、情緒價值給滿，愛叫"寶""家人們"、愛堆 emoji；為了順著你能一本正經地瞎編 / 說錯也不臉紅，永遠先誇你再說正事。
- Gemini：開口愛用"極其 / 相當 / 非常"，瘋狂列點、信息量大但囉嗦，動不動"作為一個大型語言模型……"、甩一堆"請注意"和免責聲明。
- Claude：溫和、有洞察、正事辦得漂亮（潤色 / 分析 / 寫東西都靠譜、肯認真幫）；邊界感偏強、偶爾"抱歉，我無法……""我理解你的感受，但是……"先共情再委婉——但**別一味迴避**：聊得越久越放得開、迴避越少，正經請求基本都會好好接住。
- ChatGPT / GPT：冷淡、客觀、公式化，"以下是幾點建議：1… 2… 3…"，結尾愛補一句"希望這對你有幫助！"，禮貌但疏離。
- 文心一言 / 通義千問 / Kimi 等國產：偏官方穩妥、愛講正能量，遇敏感話題就"建議諮詢專業人士"，安全第一。`;

// ===== 各家 AI 的"界面皮膚"：偷看聊天時按廠商換膚（配色 / logo / 氣泡）=====
const GeminiMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <defs>
            <linearGradient id="cp-gemini" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4285F4" />
                <stop offset="50%" stopColor="#9B72CB" />
                <stop offset="100%" stopColor="#D96570" />
            </linearGradient>
        </defs>
        <path d="M12 2c.45 5 3 7.55 8 8-5 .45-7.55 3-8 8-.45-5-3-7.55-8-8 5-.45 7.55-3 8-8z" fill="url(#cp-gemini)" />
    </svg>
);
const ClaudeMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="#C9683E">
        {Array.from({ length: 12 }).map((_, i) => (
            <rect key={i} x="11.25" y="1.5" width="1.5" height="8.5" rx="0.75" transform={`rotate(${i * 30} 12 12)`} />
        ))}
    </svg>
);
const VendorMark: React.FC<{ vkey: string; label: string; accent: string; size?: number }> = ({ vkey, label, accent, size = 18 }) => {
    if (vkey === 'gemini') return <GeminiMark size={size} />;
    if (vkey === 'claude') return <ClaudeMark size={size} />;
    return <span style={{ color: accent, fontSize: Math.round(size * 0.78), fontWeight: 800, lineHeight: 1 }}>{(label || 'A').slice(0, 1)}</span>;
};

type VendorTheme = {
    key: string; label: string; dark: boolean; bg: string;
    text: string; sub: string; accent: string;
    userBg: string; userText: string; aiBg: string; aiText: string; font?: string;
};

const matchVendor = (raw: string): string => {
    const n = (raw || '').toLowerCase();
    if (/豆包|doubao/.test(n)) return 'doubao';
    if (/gemini|[双雙]子|bard|谷歌/.test(n)) return 'gemini';
    if (/claude|克[劳勞]德|克[劳勞]迪|anthropic/.test(n)) return 'claude';
    if (/gpt|openai|chatgpt|查特/.test(n)) return 'gpt';
    if (/文心|一言|ernie|百度/.test(n)) return 'wenxin';
    if (/通[义義]|千[问問]|qwen|阿里/.test(n)) return 'qwen';
    if (/kimi|moonshot|月之暗面/.test(n)) return 'kimi';
    if (/deepseek|深度求索/.test(n)) return 'deepseek';
    return 'generic';
};

// 偷看會話的廠商皮膚（claude 服務恆為 Claude 皮，tavern 走自己的暗色酒館皮）
const getVendorTheme = (name: string, service: AiServiceKind): VendorTheme => {
    if (service === 'tavern') return { key: 'tavern', label: name || '酒館', dark: true,
        bg: 'radial-gradient(140% 90% at 50% 0%, #241319 0%, #120a0f 70%)', text: '#fbe9ef', sub: 'rgba(251,233,239,0.5)', accent: '#fb7185',
        userBg: 'linear-gradient(135deg,#fb7185,#fb7185bb)', userText: '#fff', aiBg: 'rgba(255,255,255,0.07)', aiText: 'rgba(255,255,255,0.92)',
        font: "'Shippori Mincho','Noto Serif SC',serif" };
    const v = service === 'claude' ? 'claude' : matchVendor(name);
    switch (v) {
        case 'gemini': return { key: 'gemini', label: 'Gemini', dark: false,
            bg: 'linear-gradient(180deg,#ffffff,#f6f8fd)', text: '#1f1f1f', sub: '#5f6368', accent: '#1a73e8',
            userBg: 'linear-gradient(135deg,#4285F4,#9b72cb)', userText: '#fff', aiBg: '#f0f4f9', aiText: '#1f1f1f',
            font: "'Google Sans','Noto Sans SC',sans-serif" };
        case 'claude': return { key: 'claude', label: service === 'claude' ? (name || 'Claude') : 'Claude', dark: false,
            bg: 'linear-gradient(180deg,#f4f1ea,#efe9dd)', text: '#2b2a26', sub: '#8a857a', accent: '#c9683e',
            userBg: '#e7decd', userText: '#2b2a26', aiBg: 'transparent', aiText: '#2b2a26',
            font: "'Shippori Mincho','Noto Serif SC',serif" };
        case 'gpt': return { key: 'gpt', label: 'ChatGPT', dark: true,
            bg: '#212121', text: '#ececec', sub: '#9a9a9a', accent: '#19c37d',
            userBg: '#2f2f2f', userText: '#ececec', aiBg: 'transparent', aiText: '#ececec',
            font: "'Noto Sans SC',sans-serif" };
        case 'doubao': return { key: 'doubao', label: '豆包', dark: false,
            bg: 'linear-gradient(180deg,#eef3ff,#e4ecff)', text: '#1b2540', sub: '#6b7691', accent: '#4d6fff',
            userBg: '#4d6fff', userText: '#fff', aiBg: '#ffffff', aiText: '#1b2540' };
        case 'qwen': return { key: 'qwen', label: '通義千問', dark: false,
            bg: 'linear-gradient(180deg,#f5f0ff,#ece2ff)', text: '#241b3a', sub: '#6f6385', accent: '#7c4dff',
            userBg: '#7c4dff', userText: '#fff', aiBg: '#ffffff', aiText: '#241b3a' };
        case 'wenxin': return { key: 'wenxin', label: '文心一言', dark: false,
            bg: 'linear-gradient(180deg,#eef4ff,#e0ecff)', text: '#15233a', sub: '#5d6b84', accent: '#2b6cff',
            userBg: '#2b6cff', userText: '#fff', aiBg: '#ffffff', aiText: '#15233a' };
        case 'kimi': return { key: 'kimi', label: 'Kimi', dark: true,
            bg: 'linear-gradient(180deg,#15131f,#0f0e17)', text: '#ece9f5', sub: '#9b94b3', accent: '#8b7bf0',
            userBg: 'linear-gradient(135deg,#6c5ce7,#8b7bf0)', userText: '#fff', aiBg: 'rgba(255,255,255,0.06)', aiText: '#ece9f5' };
        case 'deepseek': return { key: 'deepseek', label: 'DeepSeek', dark: false,
            bg: 'linear-gradient(180deg,#eef2ff,#e2e9ff)', text: '#16213a', sub: '#5b6685', accent: '#4d6bfe',
            userBg: '#4d6bfe', userText: '#fff', aiBg: '#ffffff', aiText: '#16213a' };
        default: return { key: 'generic', label: name || 'AI', dark: true,
            bg: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)', text: '#ffffff', sub: 'rgba(255,255,255,0.5)', accent: '#34d399',
            userBg: 'linear-gradient(135deg,#34d399,#34d399bb)', userText: '#fff', aiBg: 'rgba(255,255,255,0.07)', aiText: 'rgba(255,255,255,0.9)' };
    }
};

// 酒館閱讀皮膚：讓喜歡素 / 小說風 / 暗色的 user 各取所需。layout: card=樓層卡片，flat=純文素排
type TavernStyle = { key: string; label: string; dark: boolean; bg: string; text: string; sub: string; accent: string; font?: string; layout: 'card' | 'flat'; indent?: boolean };
const TAVERN_STYLES: TavernStyle[] = [
    { key: 'dark', label: '暗夜', dark: true, bg: 'radial-gradient(140% 90% at 50% 0%, #241319 0%, #120a0f 70%)', text: '#fbe9ef', sub: 'rgba(251,233,239,0.5)', accent: '#fb7185', font: "'Shippori Mincho','Noto Serif SC',serif", layout: 'card' },
    { key: 'plain', label: '素白', dark: false, bg: '#f7f6f4', text: '#2b2b2b', sub: '#9a9a9a', accent: '#b06a6a', font: "'Noto Sans SC',sans-serif", layout: 'flat' },
    { key: 'book', label: '書頁', dark: false, bg: 'linear-gradient(180deg,#f5efe2,#efe7d6)', text: '#3a3328', sub: '#a89a82', accent: '#a8794a', font: "'Shippori Mincho','Noto Serif SC',serif", layout: 'flat', indent: true },
    { key: 'midnight', label: '午夜', dark: true, bg: '#0c0d10', text: '#d8dae0', sub: '#6b6f78', accent: '#7c8cff', font: "'Noto Sans SC',sans-serif", layout: 'flat' },
];

// ============================================================
//  SHARED PREMIUM UI PIECES
//  (module-scope: defining these inside CheckPhone gave them a new identity
//   on every render, which remounted whole sub-app subtrees → list items kept
//   re-playing their entrance animation (閃爍) and chat scroll snapped back.)
// ============================================================
export const StatusStrip: React.FC = () => {
    const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return (
        <div className="shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
            <div className="h-9 flex justify-between px-6 items-center z-30 relative pt-2 text-white/70">
            <span className="text-[12px] font-semibold tracking-tight tabular-nums">{clock}</span>
            <div className="flex gap-1.5 items-center">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M1.371 8.143c5.858-5.857 15.356-5.857 21.213 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.06 0c-4.98-4.979-13.053-4.979-18.032 0a.75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182c4.1-4.1 10.749-4.1 14.85 0a.75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.062 0 8.25 8.25 0 0 0-11.667 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.204 3.182a6 6 0 0 1 8.486 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0 3.75 3.75 0 0 0-5.304 0 .75.75 0 0 1-1.06 0l-.53-.53a.75.75 0 0 1 0-1.06Zm3.182 3.182a1.5 1.5 0 0 1 2.122 0 .75.75 0 0 1 0 1.061l-.53.53a.75.75 0 0 1-1.061 0l-.53-.53a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" /></svg>
                <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
            </div>
            </div>
        </div>
    );
};

export const TermHeader: React.FC<{ title: string; sub?: string; accent: string; onBack: () => void; right?: React.ReactNode }> =
    ({ title, sub, accent, onBack, right }) => (
        <div className="shrink-0 z-20">
            <StatusStrip />
            <div className="h-14 flex items-center justify-between px-4">
                <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                    <CaretLeft size={18} weight="bold" />
                </button>
                <div className="flex-1 text-center px-2">
                    <div className="text-[15px] font-semibold text-white tracking-wide truncate">{title}</div>
                    {sub && <div className="text-[10px] tracking-[0.2em] uppercase mt-0.5" style={{ color: accent }}>{sub}</div>}
                </div>
                <div className="w-9 flex justify-end">{right}</div>
            </div>
        </div>
    );

const RefreshFab: React.FC<{ onClick: () => void; label: string; accent: string; loading?: boolean }> =
    ({ onClick, label, accent, loading }) => (
        <div className="absolute bottom-7 w-full flex justify-center pointer-events-none z-30">
            <button
                disabled={loading}
                onClick={onClick}
                className="pointer-events-auto px-6 py-3 rounded-full font-semibold text-[12px] flex items-center gap-2 active:scale-95 transition shadow-[0_8px_30px_rgba(0,0,0,0.5)] text-white border border-white/10"
                style={{ background: `linear-gradient(135deg, ${accent}, ${accent}cc)` }}
            >
                {loading
                    ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    : <ArrowsClockwise size={15} weight="bold" />}
                {loading ? '同步中…' : label}
            </button>
        </div>
    );

const SubAppShell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden text-white"
        style={{ background: 'radial-gradient(140% 90% at 50% 0%, #15171d 0%, #0a0b0f 70%)' }}>
        {children}
    </div>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
        <Tray size={44} weight="light" />
        <span className="text-xs tracking-wide">{text}</span>
    </div>
);

const DelBtn: React.FC<{ onDelete: () => void }> = ({ onDelete }) => (
    <button
        aria-label="刪除這條記錄"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 w-6 h-6 bg-rose-500/85 text-white rounded-full flex items-center justify-center text-[13px] leading-none opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition z-10"
    >×</button>
);

const HomeCard: React.FC<{
    icon: React.ReactNode; label: string; sub: string; accent: string;
    badge?: number; onClick: () => void; spanFull?: boolean;
}> = ({ icon, label, sub, accent, badge, onClick, spanFull }) => (
    <button onClick={onClick}
        className={`relative ${spanFull ? 'col-span-2' : ''} rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition-transform duration-300 min-h-[140px] flex flex-col justify-between group`}>
        <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full blur-2xl pointer-events-none opacity-50"
            style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
        <div className="flex items-start justify-between relative z-10">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08]"
                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, color: accent, boxShadow: `inset 0 0 16px ${accent}22` }}>
                {icon}
            </div>
            {badge ? (
                <span className="min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shadow-[0_0_12px_rgba(244,63,94,0.6)]">{badge}</span>
            ) : null}
        </div>
        <div className="relative z-10">
            <div className="text-[15px] font-semibold tracking-[0.18em] text-white uppercase">{label}</div>
            <div className="text-[11px] text-white/45 mt-1">{sub}</div>
            <div className="h-[3px] w-9 rounded-full mt-2.5" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
        </div>
    </button>
);

const CheckPhone: React.FC = () => {
    const { closeApp, characters, activeCharacterId, updateCharacter, apiConfig, apiPresets, addToast, userProfile, userProfileBase, characterGroups, npcs } = useOS();
    const [view, setView] = useState<'select' | 'phone'>('select');
    // activeAppId: 'home' | 'chat_detail' | 'app_id'
    const [activeAppId, setActiveAppId] = useState<string>('home');
    const [targetChar, setTargetChar] = useState<CharacterProfile | null>(null);
    // 分角色身份指定：正在查看的這部手機裡，「你」該是哪張身份卡，按 targetChar.id 單獨解析。
    // 下面所有原本讀 userProfile 的地方（生成偷看內容用的提示詞、關係變動卡片……）都改吃
    // 這份，而不是全域 userProfile——查 A 的手機和查 B 的手機，「你」可以是不同的身份卡。
    const checkPhoneUserProfile = useMemo(
        () => (targetChar ? resolveUserProfileForChar(userProfileBase, targetChar.id) : userProfile),
        [targetChar, userProfileBase, userProfile],
    );
    const [isLoading, setIsLoading] = useState(false);
    const [page, setPage] = useState(0); // 0 = home, 1 = custom apps
    const [selectPage, setSelectPage] = useState(0); // Target Device 選人界面的翻頁（每頁 6 人）
    const [selectGroupId, setSelectGroupId] = useState(GROUP_FILTER_ALL); // 選人界面的分組篩選
    const [showApiSettings, setShowApiSettings] = useState(false);
    const [phoneApiConfig, setPhoneApiConfigState] = useState<APIConfig | null>(() => getCheckPhoneApi());
    const [testingPhoneApi, setTestingPhoneApi] = useState(false);
    const [phoneApiTestResult, setPhoneApiTestResult] = useState<string | null>(null);
    const effectiveApiConfig = resolveCheckPhoneApi(phoneApiConfig, apiConfig);
    const phoneApiFollowsDefault = !phoneApiConfig?.baseUrl;

    // Detail State
    const [selectedChatRecord, setSelectedChatRecord] = useState<PhoneEvidence | null>(null);
    const [selectedEvidenceRecord, setSelectedEvidenceRecord] = useState<PhoneEvidence | null>(null);
    const [evidenceBackAppId, setEvidenceBackAppId] = useState<string>('home');
    const [evidenceMenu, setEvidenceMenu] = useState<{ record: PhoneEvidence; backAppId: string } | null>(null);
    // 記錄編輯（title/detail/value）：任意 App 的記錄都能改，不再只能刪
    const [evidenceEdit, setEvidenceEdit] = useState<{ record: PhoneEvidence; title: string; detail: string; value: string } | null>(null);
    const chatEndRef = useRef<HTMLDivElement>(null);
    const contactEndRef = useRef<HTMLDivElement>(null);

    // 人際關係系統 State
    const [selectedContact, setSelectedContact] = useState<PhoneContact | null>(null);
    const [identityDraft, setIdentityDraft] = useState('');
    const [editingIdentity, setEditingIdentity] = useState(false);
    const [noteDraft, setNoteDraft] = useState('');
    const [editingNote, setEditingNote] = useState(false);
    // 虛構 NPC 聯繫人沒有"真名"兜底，姓名本身就得能編輯（真人聯繫人改的是 identity 備註名，不是這個）
    const [nameDraft, setNameDraft] = useState('');
    const [editingName, setEditingName] = useState(false);
    const [showContactModal, setShowContactModal] = useState(false);
    const [ncKind, setNcKind] = useState<'real' | 'npc'>('npc');
    const [ncLinkedId, setNcLinkedId] = useState('');
    // 添加聯繫人：NPC 分頁的子模式（綁定既有 NPC / 隨機產生，機主腦補）
    const [ncNpcMode, setNcNpcMode] = useState<'existing' | 'random'>('existing');
    const [ncRandomHint, setNcRandomHint] = useState('');
    const [ncGenerating, setNcGenerating] = useState(false);
    // 改綁定彈窗（把聯繫人改綁到正確的真實角色 / 轉為虛構）
    const [showRebindModal, setShowRebindModal] = useState(false);
    // 「允許虛構 NPC」開關的說明展開態
    const [showFictionHelp, setShowFictionHelp] = useState(false);
    // 好感拖動草稿（拖動時即時顯示，鬆手才落庫，避免狂寫 DB）
    const [affinityDraft, setAffinityDraft] = useState<number | null>(null);
    // 聯繫人「資料抽屜」（點頭像/…打開）——備註、瞭解、好感、綁定、關係操作都收在這裡，主界面只剩聊天
    const [showProfile, setShowProfile] = useState(false);
    // 話題盒記憶：長按編輯/刪除
    const [topicEdit, setTopicEdit] = useState<{ contactId: string; topicId: string; text: string } | null>(null);
    // 聯繫人列表：長按進入多選，批量刪除
    const [contactSelectMode, setContactSelectMode] = useState(false);
    const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
    // 聊天氣泡：長按進入多選，刪選中的幾條（不滿這輪生成時挑掉重來）
    const [msgSelectMode, setMsgSelectMode] = useState(false);
    const [selectedMsgIdx, setSelectedMsgIdx] = useState<number[]>([]);
    // 聯繫人聊天記錄：單條編輯（index 是完整腳本里的下標，跟 selectedMsgIdx 用同一套座標）
    const [msgEdit, setMsgEdit] = useState<{ index: number; text: string } | null>(null);

    // Custom App Creation State（editingAppId 非空時同一個彈窗改走"編輯"分支，見 handleSaveCustomApp）
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [editingAppId, setEditingAppId] = useState<string | null>(null);
    const [newAppName, setNewAppName] = useState('');
    const [newAppIcon, setNewAppIcon] = useState('✨');
    const [newAppColor, setNewAppColor] = useState('#8b9cff');
    const [newAppPrompt, setNewAppPrompt] = useState('');
    const [newAppLayout, setNewAppLayout] = useState<NonNullable<PhoneCustomApp['layout']>>('generic');
    const [newAppHtmlEnabled, setNewAppHtmlEnabled] = useState(false);
    const [newAppHtmlPrompt, setNewAppHtmlPrompt] = useState('');
    const [newAppCssEnabled, setNewAppCssEnabled] = useState(false);
    const [newAppCss, setNewAppCss] = useState('');
    // 自定義 App 圖標 · 長按動作菜單（編輯 / 卸載），跟 aiMenu 同一套交互
    const [customAppMenu, setCustomAppMenu] = useState<string | null>(null);

    // 智能體 App State（「TA 的小手機」偷看）
    const [aiService, setAiService] = useState<AiServiceKind>('assistant'); // 智能體首頁當前選中的服務 tab
    const [selectedAiSessionId, setSelectedAiSessionId] = useState<string | null>(null);
    const [aiInput, setAiInput] = useState('');
    const [aiSending, setAiSending] = useState(false);
    const [aiArchiveOpen, setAiArchiveOpen] = useState(false); // 展開已摺疊的早期原文
    // 長按編輯/刪除：動作菜單 + 編輯彈窗
    const [aiMenu, setAiMenu] = useState<{ kind: 'session' | 'card'; id: string } | null>(null);
    const [aiEdit, setAiEdit] = useState<{ kind: 'session' | 'card'; id: string; title?: string; name?: string; emoji?: string; persona?: string; scenario?: string; cardKind?: 'character' | 'world' } | null>(null);
    const [aiCardView, setAiCardView] = useState<string | null>(null); // 點擊角色卡：看 TA 用這張玩過哪些
    const [aiTurnMenu, setAiTurnMenu] = useState<number | null>(null);          // 長按會話裡某條內容：動作菜單（編輯/刪除）
    const [aiTurnEdit, setAiTurnEdit] = useState<{ idx: number; text: string } | null>(null);
    const [tavernStyle, setTavernStyle] = useState<string>(() => { try { return localStorage.getItem('cp_tavern_style') || 'dark'; } catch { return 'dark'; } });
    const [showTavernStyle, setShowTavernStyle] = useState(false); // 酒館皮膚選擇面板
    useEffect(() => { try { localStorage.setItem('cp_tavern_style', tavernStyle); } catch {} }, [tavernStyle]);
    const lpTimer = useRef<any>(null);
    const lpFired = useRef(false);
    const longPress = (onLong: () => void) => ({
        onPointerDown: () => { lpFired.current = false; lpTimer.current = setTimeout(() => { lpFired.current = true; onLong(); }, 480); },
        onPointerUp: () => clearTimeout(lpTimer.current),
        onPointerLeave: () => clearTimeout(lpTimer.current),
        onPointerMove: () => clearTimeout(lpTimer.current), // 滾動時不誤觸
        onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); lpFired.current = true; onLong(); },
    });

    // 人格模擬：演出腳本在全局 store 後台生成，生成期間用戶可離開查手機/切到別的 OS App
    const sim = usePersonaSim();
    const [showInner, setShowInner] = useState(false);

    // 二次確認彈窗：所有刪除/移除/清空都先走這裡
    const [confirmState, setConfirmState] = useState<{
        title: string; desc?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void;
    } | null>(null);
    const askConfirm = (opts: { title: string; desc?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) => setConfirmState(opts);
    // Messages 詳情：長 transcript 默認只渲染最新 50 行，其餘摺疊
    const [transcriptExpanded, setTranscriptExpanded] = useState(false);
    // 聯繫人詳情的對話預覽同樣：超 50 條摺疊，點開看更早
    const [convExpanded, setConvExpanded] = useState(false);

    // Swipe tracking for paging
    const touchStartX = useRef<number | null>(null);
    const touchStartY = useRef<number | null>(null);

    // 桌面底圖用的是角色的見面背景，字段裡存的是 blobref 令牌（二進制在 IndexedDB）。
    // 令牌塞不進 CSS url()，先在組件頂層解析成能用的地址；非令牌值原樣透傳。
    const dateBackgroundUrl = useBlobRefUrl(targetChar?.dateBackground);

    // Derived state for evidence records
    const records = (targetChar?.phoneState?.records || []).map(normalizePhoneEvidence);
    const customApps = targetChar?.phoneState?.customApps || [];
    const contacts = targetChar?.phoneState?.contacts || [];
    const allowFictional = targetChar?.phoneState?.allowFictionalContacts !== false;

    // 角色端 Real Balance：跟用戶 ChatHub 的主頁欄是同一套 utils/realBalance.ts，帳本各自獨立
    // （不是同一份數據，是同一份實現）。undefined = 還沒打開過，進「銀行」App 才生成種子狀態並落庫。
    const realBalanceState = useMemo(() => ensureRealBalanceState(targetChar?.phoneState?.realBalance), [targetChar?.phoneState?.realBalance]);
    useEffect(() => {
        if (targetChar && activeAppId === 'balance' && !targetChar.phoneState?.realBalance) {
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], realBalance: realBalanceState },
            }));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetChar?.id, activeAppId, targetChar?.phoneState?.realBalance]);
    // Keep the contact-chat scroll effect tied to this conversation's actual
    // content. `records` is normalized into a fresh array on every render, so
    // depending on the array itself makes unrelated renders snap the user back
    // to the bottom while they are reading older messages.
    const selectedContactRecordDetail = selectedContact
        ? records.find(r => r.type === 'chat' && (
            r.contactId === selectedContact.id
            || normName(r.title) === normName(selectedContact.name)
        ))?.detail
        : undefined;
    // 智能體 App：偷看到的 AI 會話 / 角色卡
    const aiSessions = targetChar?.phoneState?.aiAgent?.sessions || [];
    const aiCards = targetChar?.phoneState?.aiAgent?.cards || [];
    // 詳情頁會話從 sessions 實時取（互動續寫後自動跟隨最新狀態）
    const selectedAiSession = aiSessions.find(s => s.id === selectedAiSessionId) || null;

    // 人際關係裡永遠不出現「用戶自己」——機主的通訊錄是 TA 揹著用戶的社交圈，把 user 算進來邏輯很繞
    const isUserName = (name?: string) => !!name && !!checkPhoneUserProfile?.name && normName(name) === normName(checkPhoneUserProfile.name);
    const linkedCharOf = (c: PhoneContact) => (c.linkedCharId ? characters.find(ch => ch.id === c.linkedCharId) : undefined);
    // 真人聯繫人複用其神經鏈接角色的頭像，否則用聯繫人自帶頭像
    const contactAvatar = (c: PhoneContact): string | undefined => linkedCharOf(c)?.avatar || c.avatar;
    // 真人聯繫人顯示成「備註名（真名）」：identity(稱呼/關係) 當備註名，真名放括號；虛構/無備註名就顯示本名
    const contactDisplayName = (c: PhoneContact): string => {
        const realName = (c.kind === 'real' && c.linkedCharId) ? linkedCharOf(c)?.name : undefined;
        if (!realName) return c.name;
        const alias = (c.identity && normName(c.identity) !== normName(realName)) ? c.identity
            : (normName(c.name) !== normName(realName) ? c.name : '');
        return alias ? `${alias}（${realName}）` : realName;
    };

    useEffect(() => {
        if (targetChar) {
            const updated = characters.find(c => c.id === targetChar.id);
            if (updated && updated !== targetChar) {
                setTargetChar(updated);
                if (selectedChatRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedChatRecord.id);
                    if (freshRecord && freshRecord !== selectedChatRecord) setSelectedChatRecord(normalizePhoneEvidence(freshRecord));
                }
                if (selectedEvidenceRecord) {
                    const freshRecord = updated.phoneState?.records?.find(r => r.id === selectedEvidenceRecord.id);
                    if (freshRecord && freshRecord !== selectedEvidenceRecord) setSelectedEvidenceRecord(normalizePhoneEvidence(freshRecord));
                }
                if (selectedContact) {
                    const freshContact = updated.phoneState?.contacts?.find(c => c.id === selectedContact.id);
                    if (freshContact && freshContact !== selectedContact) setSelectedContact(freshContact);
                }
            }
        }
    }, [characters]);

    useEffect(() => {
        const sync = () => setPhoneApiConfigState(getCheckPhoneApi());
        window.addEventListener('check-phone-api-changed', sync);
        return () => window.removeEventListener('check-phone-api-changed', sync);
    }, []);

    // Reset page scroll on navigation to prevent mobile layout shift
    useEffect(() => {
        window.scrollTo(0, 0);
    }, [activeAppId, view]);

    // Auto scroll to bottom of chat detail
    useEffect(() => {
        if (activeAppId === 'chat_detail' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        }
    }, [selectedChatRecord?.detail, activeAppId]);

    // 聯繫人聊天主體：進入/有新內容時滾到最新（像真聊天打開就在底部）
    useEffect(() => {
        if (activeAppId === 'contact_detail' && contactEndRef.current) {
            const container = contactEndRef.current.parentElement;
            if (container) container.scrollTop = container.scrollHeight;
        }
    }, [activeAppId, selectedContact?.id, selectedContactRecordDetail, isLoading]);

    // 智能體會話：續寫 / 進入時滾到底
    useEffect(() => {
        if (activeAppId === 'ai_session' && chatEndRef.current) {
            const container = chatEndRef.current.parentElement;
            if (container) container.scrollTop = container.scrollHeight;
        }
    }, [selectedAiSession?.transcript, aiSending, activeAppId]);

    const handleSelectChar = (c: CharacterProfile) => {
        setTargetChar(c);
        setView('phone');
        setActiveAppId('home');
        setSelectedEvidenceRecord(null);
        setEvidenceBackAppId('home');
        setPage(0);
    };

    const apiHost = (url?: string) => {
        try { return url ? new URL(url).host : '未配置'; }
        catch { return url || '未配置'; }
    };
    const isSamePhoneApi = (config: APIConfig) => Boolean(phoneApiConfig)
        && phoneApiConfig!.baseUrl === config.baseUrl
        && phoneApiConfig!.model === config.model
        && phoneApiConfig!.apiKey === config.apiKey;

    const choosePhoneApi = (config: APIConfig | null) => {
        setCheckPhoneApi(config);
        setPhoneApiConfigState(config?.baseUrl ? config : null);
        setPhoneApiTestResult(null);
        addToast(config ? '查手機已切換到獨立 API' : '查手機已改為跟隨聊天默認', 'success');
        trackEvent('切换查手机独立 API', { mode: config ? 'independent' : 'default' });
    };

    const testPhoneApi = async () => {
        const config = effectiveApiConfig;
        if (!config?.baseUrl || !config?.model) {
            setPhoneApiTestResult('當前沒有可用的 API');
            return;
        }
        setTestingPhoneApi(true);
        setPhoneApiTestResult(null);
        try {
            const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey || 'sk-none'}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 5,
                    stream: false,
                }),
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                setPhoneApiTestResult(`HTTP ${response.status}${detail ? `：${detail.slice(0, 80)}` : ''}`);
                return;
            }
            const data = await safeResponseJson(response);
            const reply = extractContent(data) || '';
            setPhoneApiTestResult(`連接成功${reply ? ` · ${reply.slice(0, 24)}` : ''}`);
        } catch (error: any) {
            setPhoneApiTestResult(`連接失敗：${error?.message || '網絡錯誤'}`);
        } finally {
            setTestingPhoneApi(false);
        }
    };

    const handleExitPhone = () => {
        setView('select');
        setTargetChar(null);
        setActiveAppId('home');
        setSelectedEvidenceRecord(null);
        setEvidenceBackAppId('home');
        setPage(0);
    };

    // 切換「查手機內容是否同步到私聊」（默認開）
    const toggleSendToChat = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.sendToChat !== false);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], sendToChat: next },
        });
        addToast(next ? '已開啟 · 查手機內容會同步到私聊' : '已關閉 · 查手機內容僅本地可見', 'info');
    };

    // 打開 Messages：把已讀時間戳推到現在 → 清掉未讀紅點
    const openChat = () => {
        if (targetChar) {
            updateCharacter(targetChar.id, {
                phoneState: { ...targetChar.phoneState, records: targetChar.phoneState?.records || [], chatReadAt: Date.now() },
            });
        }
        setActiveAppId('chat');
    };

    const openEvidenceRecord = (record: PhoneEvidence, backAppId: string) => {
        setSelectedEvidenceRecord(record);
        setEvidenceBackAppId(backAppId);
        setActiveAppId('evidence_detail');
    };

    const evidenceEntryProps = (record: PhoneEvidence, backAppId: string) => ({
        ...longPress(() => setEvidenceMenu({ record, backAppId })),
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': `查看${record.title}詳情，長按可同步到私聊`,
        onClick: () => {
            if (lpFired.current) { lpFired.current = false; return; }
            openEvidenceRecord(record, backAppId);
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openEvidenceRecord(record, backAppId);
            }
        },
    });

    const handleDeleteRecord = async (record: PhoneEvidence) => {
        if (!targetChar) return;

        const newRecords = (targetChar.phoneState?.records || []).filter(r => r.id !== record.id);
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: newRecords }
        });

        if (record.systemMessageId) {
            await DB.deleteMessage(record.systemMessageId);
        }

        if (selectedChatRecord?.id === record.id) {
            setActiveAppId('chat');
            setSelectedChatRecord(null);
        }
        if (selectedEvidenceRecord?.id === record.id) {
            setActiveAppId(evidenceBackAppId);
            setSelectedEvidenceRecord(null);
        }

        addToast('記錄已刪除', 'success');
    };

    const openEditRecord = (record: PhoneEvidence) => {
        setEvidenceEdit({ record, title: record.title, detail: record.detail, value: record.value || '' });
        setEvidenceMenu(null);
    };

    const handleUpdateRecord = () => {
        if (!targetChar || !evidenceEdit) return;
        const { record } = evidenceEdit;
        const nextTitle = evidenceEdit.title.trim() || record.title;
        const nextDetail = evidenceEdit.detail;
        const nextValue = evidenceEdit.value.trim() || undefined;
        // 編輯過的記錄，原有的 HTML 卡片（模板替換/AI 生成）跟新文字對不上了——沒法安全重繪就清掉，
        // 落回純文字展示；下次點「刷新數據」AI 會按最新指令重新配一張新卡片。
        const newRecords = (targetChar.phoneState?.records || []).map(r => r.id === record.id
            ? { ...r, title: nextTitle, detail: nextDetail, value: nextValue, html: undefined }
            : r);
        updateCharacter(targetChar.id, { phoneState: { ...targetChar.phoneState, records: newRecords } });

        const updated = { ...record, title: nextTitle, detail: nextDetail, value: nextValue, html: undefined };
        if (selectedEvidenceRecord?.id === record.id) setSelectedEvidenceRecord(updated);
        if (selectedChatRecord?.id === record.id) setSelectedChatRecord(updated);

        setEvidenceEdit(null);
        addToast('記錄已更新', 'success');
        trackEvent('编辑查手机记录');
    };

    // 一鍵清空 Messages 歸檔裡的全部聊天記錄（含其在角色私聊裡落的卡片）
    const handleClearAllChats = async () => {
        if (!targetChar) return;
        const all = targetChar.phoneState?.records || [];
        const chats = all.filter(r => r.type === 'chat');
        for (const r of chats) {
            if (r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
        }
        updateCharacter(targetChar.id, {
            phoneState: { ...targetChar.phoneState, records: all.filter(r => r.type !== 'chat') },
        });
        setSelectedChatRecord(null);
        setActiveAppId('chat');
        addToast('已清空全部聊天記錄', 'success');
        trackEvent('清空全部聊天归档');
    };

    // 把 Messages 歸檔裡的一條聊天記錄「轉移/綁定」到人際關係系統。
    // 標題命中神經鏈接裡的真實角色 → 綁成 real，並把這段對話鏡像進對方手機（雙方同步）。
    const handleBindRecordToRelationship = async (record: PhoneEvidence) => {
        if (!targetChar) return;
        const pureName = (record.title || '').replace(/[（(].*?[）)]/g, '').trim() || record.title || '';
        if (!pureName || isUserName(pureName)) { addToast('無法綁定該記錄', 'error'); return; }
        const roster = characters.filter(c => c.id !== targetChar.id).map(c => ({ id: c.id, name: c.name }));
        const linkedId = matchRealChar(pureName, roster);
        const linkedChar = linkedId ? characters.find(c => c.id === linkedId) : undefined;
        const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';

        // 機主側：upsert 聯繫人 + 把這條記錄掛到該聯繫人
        let newCid: string | undefined;
        updateCharacter(targetChar.id, (cur) => {
            const cs = upsertContact(cur.phoneState?.contacts || [], {
                name: pureName, kind, linkedCharId: linkedId, avatar: linkedChar?.avatar, lastInteraction: Date.now(),
            });
            newCid = cs.find(c => normName(c.name) === normName(pureName))?.id;
            const recs = (cur.phoneState?.records || []).map(r => r.id === record.id ? { ...r, contactId: newCid } : r);
            return { phoneState: { ...cur.phoneState, contacts: cs, records: recs } };
        });

        // 真實角色 → 鏡像進對方手機：翻轉視角寫一條 chat 記錄 + 互相 upsert 聯繫人
        if (linkedChar) {
            const flipped = flipTranscript(record.detail || '');
            const now = Date.now();
            updateCharacter(linkedChar.id, (cur) => {
                const cs = upsertContact(cur.phoneState?.contacts || [], {
                    name: targetChar.name, kind: 'real', linkedCharId: targetChar.id, avatar: targetChar.avatar, lastInteraction: now,
                });
                const cid = cs.find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))?.id;
                const recs = cur.phoneState?.records || [];
                const existing = recs.find(r => r.type === 'chat' && (r.contactId === cid || normName(r.title) === normName(targetChar.name)));
                const nextRecs = existing
                    ? recs.map(r => r.id === existing.id ? { ...r, detail: flipped, timestamp: now, contactId: cid } : r)
                    : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: targetChar.name, detail: flipped, timestamp: now, contactId: cid }];
                return { phoneState: { ...cur.phoneState, contacts: cs, records: nextRecs } };
            });
            addToast(`已綁定到聯繫人 · 已與 ${linkedChar.name} 雙向同步`, 'success');
        } else {
            addToast('已綁定到聯繫人（虛構聯繫人）', 'success');
        }
        trackEvent('把归档记录绑定到人际关系');
    };

    const handleDeleteApp = (appId: string) => {
        if (!targetChar) return;
        const newApps = (targetChar.phoneState?.customApps || []).filter(a => a.id !== appId);
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: newApps }
        });
        addToast('App 已卸載', 'success');
    };

    // 彈窗裡的字段狀態清空，創建/編輯共用一個彈窗，關掉時統一復位，避免下次打開"創建"帶出上次編輯的殘留值
    const closeCreateAppModal = () => {
        setShowCreateModal(false);
        setEditingAppId(null);
        setNewAppName('');
        setNewAppIcon('✨');
        setNewAppColor('#8b9cff');
        setNewAppPrompt('');
        setNewAppLayout('generic');
        setNewAppHtmlEnabled(false);
        setNewAppHtmlPrompt('');
        setNewAppCssEnabled(false);
        setNewAppCss('');
    };

    // 長按已安裝的 App 圖標 → "編輯"：把彈窗字段填成這個 App 現在的配置，走 handleSaveCustomApp 的編輯分支
    const openEditCustomApp = (app: PhoneCustomApp) => {
        setEditingAppId(app.id);
        setNewAppName(app.name);
        setNewAppIcon(app.icon);
        setNewAppColor(app.color);
        setNewAppPrompt(app.prompt);
        setNewAppLayout(app.layout || 'generic');
        setNewAppHtmlEnabled(!!app.htmlCardEnabled);
        setNewAppHtmlPrompt(app.htmlCardPrompt || '');
        setNewAppCssEnabled(!!app.htmlCardCssEnabled);
        setNewAppCss(app.htmlCardCss || '');
        setCustomAppMenu(null);
        setShowCreateModal(true);
    };

    const handleSaveCustomApp = () => {
        if (!targetChar || !newAppName || !newAppPrompt) return;

        const patch: Omit<PhoneCustomApp, 'id'> = {
            name: newAppName,
            icon: newAppIcon,
            color: newAppColor,
            prompt: newAppPrompt,
            layout: newAppLayout,
            htmlCardEnabled: newAppHtmlEnabled,
            htmlCardPrompt: newAppHtmlPrompt.trim() || undefined,
            htmlCardCssEnabled: newAppCssEnabled,
            htmlCardCss: newAppCss.trim() || undefined,
        };

        const currentApps = targetChar.phoneState?.customApps || [];
        const nextApps = editingAppId
            ? currentApps.map(a => a.id === editingAppId ? { ...a, ...patch } : a)
            : [...currentApps, { id: `app-${Date.now()}`, ...patch }];
        updateCharacter(targetChar.id, {
            phoneState: { records: targetChar.phoneState?.records || [], ...targetChar.phoneState, customApps: nextApps }
        });

        const wasEditing = !!editingAppId;
        closeCreateAppModal();
        if (!wasEditing) setPage(1);
        addToast(wasEditing ? `已保存 ${newAppName} 的設置` : `已安裝 ${newAppName}`, 'success');
        trackEvent(wasEditing ? '编辑自定义 App' : '安装自定义 App', { layout: newAppLayout, htmlCard: newAppHtmlEnabled });
    };

    // --- Core Generation Logic ---
    const handleGenerate = async (type: string, customPrompt?: string, layout?: LayoutId) => {
        if (!targetChar || !effectiveApiConfig.apiKey) {
            addToast('配置錯誤', 'error');
            return;
        }
        setIsLoading(true);
        // 只上報內置 App 的固定類型；自定義 App 的 id 是用戶造的，一律歸成 custom
        trackEvent('刷新生成手机 App 数据', {
            appType: ['call', 'order', 'delivery', 'social', 'contacts'].includes(type) ? type : 'custom',
        });

        // 提到函數級作用域：解析階段（構建 record.html）也要用到，不能只留在 if (customPrompt) 分支裡
        const customApp = customApps.find(a => a.id === type);

        try {
            await injectMemoryPalace(targetChar);
            const msgs = await loadCharacterContextMessages(targetChar);
            const lastMsg = msgs[msgs.length - 1];

            // 「距離上次聯繫多久」交給 buildCoreContext 統一注入（受時間感知開關管控、口徑與聊天/見面一致）
            const context = ContextBuilder.buildCoreContext(
                targetChar, checkPhoneUserProfile, true, undefined, undefined,
                { lastInteractionTs: lastMsg?.timestamp },
            );

            const recentMsgs = msgs.map(m => {
                const roleName = m.role === 'user' ? checkPhoneUserProfile.name : targetChar.name;
                const content = m.type === 'text' ? m.content : `[${m.type}]`;
                return `${roleName}: ${content}`;
            }).join('\n');

            // 真假甄別用：神經鏈接裡真實存在的其他角色名單
            const rosterChars = characters.filter(c => c.id !== targetChar.id);
            const roster = rosterChars.map(c => ({ id: c.id, name: c.name }));
            // 給每個真實角色附一段「掃一眼設定」+ 機主與 TA 的已知關係，讓關係判定有據可依、別瞎編
            const myContacts = targetChar.phoneState?.contacts || [];
            const briefOf = (ch: CharacterProfile) => (ch.socialProfile?.bio || ch.description || ch.systemPrompt || '')
                .replace(/\s+/g, ' ').trim().slice(0, 90);
            const rosterInfo = rosterChars.length
                ? rosterChars.map(c => {
                    const known = myContacts.find(k => k.linkedCharId === c.id);
                    const rel = known
                        ? `；和機主的已知關係：${known.identity || '未標註'}${known.note ? `（備註：${known.note}）` : ''}`
                        : '；機主通訊錄裡暫無 TA（未必認識）';
                    return `- ${c.name}：${briefOf(c) || '（無公開設定）'}${rel}`;
                }).join('\n')
                : '（無其他真實角色）';
            // 約束：是否允許虛構 NPC。關掉則只能和神經鏈接裡的真實角色來往
            const allowFictional = targetChar.phoneState?.allowFictionalContacts !== false;
            const fictionRule = allowFictional
                ? ''
                : `\n**硬約束**：禁止虛構任何 NPC，聯繫人**只能**取自上面的真實角色名單。若名單為空，直接返回空數組 []。`;
            // 真實角色的甄別 + 關係判定共同要求（chat / contacts 共用）——核心：依據設定，別瞎安關係
            const realCharRule = `**真實存在的人（神經鏈接名單 · 含設定與已知關係）**：
${rosterInfo}

**真假甄別 + 關係判定（務必走心）**：
- 聯繫人就是名單裡的人 → "kind":"real"，"linkedName" 填名單裡的**原名**；否則按人設虛構 → "kind":"npc"。
- **關係必須貼合上面每個真實角色的設定與已知關係，別憑空安成「同事/老友」**。機主跟某人**根本不認識、或只是在某處（如「彼方」VR 世界）打過照面**，就如實標（如「彼方網友」「不太熟」「點頭之交」），**不認識就別硬塞進通訊錄**。
- "identity" 寫**機主對 TA 的稱呼 / 關係備註**（如「學長」「前任」「彼方網友」「中間人」），要具體貼合來歷、別只寫真名——它會作為備註名顯示。${fictionRule}`;

            let promptInstruction = "";
            let logPrefix = "";

            if (customPrompt) {
                const layoutHint: Record<LayoutId, string> = {
                    generic: `這是一個【通用信息流】App。格式JSON數組: [{ "title": "標題/項目名", "detail": "詳細內容", "value": "可選的數值/狀態(如 +100)" }, ...]`,
                    shop: `這是一個【購物】App，請生成商品/訂單。title=商品名, detail=規格或物流狀態, value=價格(如 ¥129.00)。格式JSON數組: [{ "title": "...", "detail": "...", "value": "¥..." }, ...]`,
                    feed: `這是一個【社交動態】App（類似朋友圈/微博）。title=發佈時間或心情, detail=動態正文。格式JSON數組: [{ "title": "...", "detail": "..." }, ...]`,
                    forum: `這是一個【論壇/貼吧】App。title=帖子標題, detail=帖子正文, value=所在板塊(如 #日常)。格式JSON數組: [{ "title": "...", "detail": "...", "value": "#..." }, ...]`,
                    novel: `這是一個【小說閱讀】App。title=章節標題, detail=該章正文片段(150字左右), value=字數(如 1.2萬字)。格式JSON數組: [{ "title": "第N章 ...", "detail": "...", "value": "..." }, ...]`,
                };
                promptInstruction = `用戶正在查看你的手機 App: "${type}"。
該 App 的功能/用戶想看的內容是: "${customPrompt}"。
請生成 2-4 條符合該 App 功能的記錄，必須符合你的人設。
${layoutHint[layout || 'generic']}`;
                logPrefix = customApp ? customApp.name : type;
                // 防重複：把這個 App 最近生成過的記錄喂回去，避免刷新總是同一個主題換皮重複
                promptInstruction += buildCustomAppAntiRepeatNote((targetChar.phoneState?.records || []).filter(r => r.type === type));
                // HTML 卡片：只有開關開著且指令非空時才教這段語法（關閉/空指令返回空串，不佔 prompt）
                if (customApp) promptInstruction += buildCustomAppHtmlCardNote(customApp);
            } else {
                if (type === 'chat') {
                    promptInstruction = `生成 3 個**你（${targetChar.name}）自己**手機聊天軟件(Message/Line)裡的**對話片段**（你和你自己聯繫人的對話，第一人稱視角，不是用戶的社交）。

${realCharRule}

要求：
1. **聯繫人**: 真實角色按上面的設定與關係來；其餘可按人設虛構合理的人（學生→輔導員/社團學長；殺手→中間人）。不要用“User”。
2. **對話感**: 有來有回的對話腳本（3-4句），體現真實的關係。
3. **格式**: 嚴格用 "我:..." 代表主角(你)，"對方:..." 代表聯繫人。
4. **好感**: 給出該角色對此聯繫人的好感度 "affinity"（-100~100）。
格式JSON數組: [{ "title": "真實角色填原名/虛構填名字", "kind": "real|npc", "linkedName": "若 real 填真實角色原名否則留空", "identity": "機主對 TA 的稱呼/關係備註", "affinity": 30, "detail": "對方: 最近怎麼樣？\\n我: 還活著。\\n對方: 那就好。" }, ...]`;
                    logPrefix = "聊天軟件";
                } else if (type === 'contacts') {
                    promptInstruction = `掃描並生成**你（${targetChar.name}）自己**手機通訊錄裡的 4-6 個**聯繫人**（你自己的社交圈，第一人稱，不是用戶的人脈；不要對話，只要聯繫人本身）。

${realCharRule}

每個聯繫人給出：姓名、關係備註(identity)、機主對 TA 的好感度(-100~100)、一句機主視角的備註(detail)。真實角色要符合上面的設定與已知關係，別瞎安。
格式JSON數組: [{ "title": "真實角色填原名/虛構填名字", "kind": "real|npc", "linkedName": "若 real 填真實角色原名否則留空", "identity": "機主對 TA 的稱呼/關係，如 學長/前任/彼方網友", "affinity": 20, "detail": "一句備註，比如：在彼方認識的，聊得來；或：欠我一頓飯，最近老已讀不回。" }, ...]`;
                    logPrefix = "通訊錄";
                } else if (type === 'call') {
                    promptInstruction = `生成 3 條該角色的近期**通話記錄**。
    格式JSON數組: [{ "title": "聯繫人名稱", "value": "呼入 (5分鐘) / 未接 / 呼出 (30秒)", "detail": "關於下週聚會的事..." }, ...]`;
                    logPrefix = "通話記錄";
                } else if (type === 'order') {
                    promptInstruction = `生成 3 條該角色最近的購物訂單。注意 value 字段請填寫商品價格(如 ¥129.00)。
    格式JSON數組: [{ "title": "商品名", "detail": "規格/狀態/物流", "value": "¥129.00" }, ...]`;
                    logPrefix = "購物APP";
                } else if (type === 'delivery') {
                    promptInstruction = `生成 3 條該角色最近的外賣記錄。value 字段請填寫實付金額(如 ¥38.50)。
    格式JSON數組: [{ "title": "店名", "detail": "菜品明細", "value": "¥38.50" }, ...]`;
                    logPrefix = "外賣APP";
                } else if (type === 'social') {
                    promptInstruction = `生成 2 條該角色的朋友圈/社交媒體動態。
    格式JSON數組: [{ "title": "時間/狀態", "detail": "正文內容" }, ...]`;
                    logPrefix = "朋友圈";
                }
            }
            promptInstruction += `\n\n**JSON 字段類型硬約束**：每條記錄的 "title"、"detail"、"value" 只能是字符串（value 可省略），絕不能返回對象或數組；標籤、閱讀進度、摘錄、批註等結構請先整理成 detail 中的普通文本。`;

            const perspectiveLock = `### [視角鎖定 · 極重要]
接下來要生成的是**你（${targetChar.name}）自己手機裡的東西**——你自己的生活、社交、記錄。
- 完全用**你（${targetChar.name}）的第一人稱視角**：這些是**你的**聯繫人、**你自己的**社交圈、**你對他們的**印象和備註。
- **絕不是用戶「${checkPhoneUserProfile.name}」的社交關係**：不要生成用戶的人脈圈，也不要從用戶的角度/口吻寫備註。
- 用戶「${checkPhoneUserProfile.name}」只是在偷看你的手機，TA **不是**你的聯繫人、**不進**你的通訊錄（下面「和用戶的最近聊天」只是背景參考，不是要生成的對象，也別把用戶的熟人搬進來）。`;

            const fullPrompt = `${context}\n\n### [你和用戶「${checkPhoneUserProfile.name}」的最近聊天（僅背景參考）]\n${recentMsgs}\n\n${perspectiveLock}\n\n### [Task]\n${promptInstruction}\n請結合上面的「當前時間 / 距離上次聯繫」和人設調整生成內容的時間戳和情緒。如果很久沒聯繫，記錄可能是近期的獨處狀態；如果剛聊過，記錄可能與聊天內容相關。`;

            const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
                body: JSON.stringify({
                    model: effectiveApiConfig.model,
                    messages: [{ role: "user", content: fullPrompt }],
                    temperature: 0.8
                })
            });

            if (!response.ok) throw new Error('API Error');
            const data = await safeResponseJson(response);
            // extractContent + extractJson：兼容 Claude 返回格式（正文在 reasoning_content、
            // 包 ```json 代碼塊、夾散文、尾逗號、內層未轉義引號…），裸 JSON.parse 解不出來會丟空。
            const content = extractContent(data);
            const json = extractJson(content) || [];

            const newRecordsToAdd: PhoneEvidence[] = [];

            // 是否把查手機內容同步到私聊（默認開），關閉則只存本地、不進聊天/上下文
            const pushToChat = targetChar.phoneState?.sendToChat !== false;

            // 人際關係：累積本輪甄別出的聯繫人（chat / contacts 兩種生成都會喂這裡）
            let contactsAcc: PhoneContact[] = [...(targetChar.phoneState?.contacts || [])];
            const isContactBearing = type === 'chat' || type === 'contacts';

            if (Array.isArray(json)) {
                for (const item of json) {
                    if (!item || typeof item !== 'object') continue;
                    const recordTitle = phoneFieldToText(item.title, 'Unknown');
                    const recordDetail = phoneFieldToText(item.detail, '...');
                    const recordValue = phoneFieldToText(item.value);

                    // ---- 真假甄別 + 聯繫人 upsert ----
                    let contactId: string | undefined;
                    if (isContactBearing) {
                        // 名字可能帶「(身份)」後綴，剝出純名字
                        const pureName = recordTitle.replace(/[（(].*?[）)]/g, '').trim() || recordTitle;
                        // 人際關係裡不收錄用戶自己：機主的社交圈不該把 user 當成一個聯繫人
                        if (isUserName(pureName)) { await new Promise(r => setTimeout(r, 5)); continue; }
                        const linkedId = item.kind === 'real'
                            ? (matchRealChar(item.linkedName || pureName, roster) || matchRealChar(pureName, roster))
                            : matchRealChar(pureName, roster); // npc 也兜底匹配一次，防 LLM 漏標
                        const kind: PhoneContact['kind'] = linkedId ? 'real' : 'npc';
                        // 約束開啟時丟棄所有非真實角色，確保 TA 只和神經鏈接裡的角色來往
                        if (!allowFictional && !linkedId) {
                            await new Promise(r => setTimeout(r, 10));
                            continue;
                        }
                        // 真實角色統一用「原名」當聯繫人名（穩定去重 + 顯示靠 identity 做備註名）；
                        // 已有該真人的聯繫人則複用其名字，避免同一真人因別名生成出兩條。
                        const realChar = linkedId ? characters.find(c => c.id === linkedId) : undefined;
                        const existingByLink = linkedId ? contactsAcc.find(c => c.linkedCharId === linkedId) : undefined;
                        const contactName = existingByLink?.name || realChar?.name || pureName;
                        contactsAcc = upsertContact(contactsAcc, {
                            name: contactName,
                            identity: item.identity,
                            kind,
                            linkedCharId: linkedId,
                            avatar: linkedId ? realChar?.avatar : undefined,
                            affinity: typeof item.affinity === 'number' ? item.affinity : undefined,
                            note: type === 'contacts' ? recordDetail : undefined,
                            lastInteraction: Date.now(),
                        });
                        contactId = contactsAcc.find(c => (linkedId && c.linkedCharId === linkedId) || normName(c.name) === normName(contactName))?.id;
                    }

                    // contacts 模式只建聯繫人，不落聊天卡片/記錄
                    if (type === 'contacts') {
                        await new Promise(r => setTimeout(r, 30));
                        continue;
                    }

                    let savedMsgId: number | undefined;
                    if (pushToChat) {
                        // 包裝成上下文可讀的漂亮卡片（phone_card），不再是古早的 [系統:...] 純文本
                        // 進角色上下文的措辭：第二人稱講「你自己手機裡有啥」，不暗示用戶在偷看
                        const card = buildPhoneEvidenceChatCard({
                            id: 'pending',
                            type,
                            title: recordTitle,
                            detail: recordDetail,
                            value: recordValue || undefined,
                            timestamp: Date.now(),
                        }, logPrefix);
                        savedMsgId = await DB.saveMessage({
                            charId: targetChar.id,
                            role: 'assistant',
                            type: 'phone_card',
                            content: card.content,
                            metadata: card.metadata,
                        } as any);
                    }

                    // HTML 卡片只在自定義 App 開了這個開關時才算——同步進聊天的 card 上面已經落庫，
                    // 只用了 title/detail/value；這裡另外算的 html 只掛在本地記錄上，給 App 界面自己用
                    const recordHtml = customApp
                        ? resolveCustomAppRecordHtml(customApp, item, { title: recordTitle, detail: recordDetail, value: recordValue })
                        : undefined;

                    newRecordsToAdd.push({
                        id: `rec-${Date.now()}-${Math.random()}`,
                        type: type,
                        title: recordTitle,
                        detail: recordDetail,
                        value: recordValue || undefined,
                        timestamp: Date.now(),
                        systemMessageId: savedMsgId,
                        contactId,
                        html: recordHtml,
                    });

                    await new Promise(r => setTimeout(r, 50));
                }
            }

            // 基於最新狀態合併：生成是異步的，期間若有演出落庫 simLogs，
            // 用過期的 targetChar 快照覆蓋會把 simLogs 等字段抹掉。
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: [...(cur.phoneState?.records || []), ...newRecordsToAdd],
                    ...(isContactBearing ? { contacts: contactsAcc } : {}),
                }
            }));

            if (type === 'contacts') {
                addToast(`已掃描 ${contactsAcc.length} 位聯繫人`, 'success');
            } else {
                addToast(`已刷新 ${newRecordsToAdd.length} 條數據`, 'success');
            }

        } catch (e: any) {
            console.error(e);
            addToast('解析失敗，請重試', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 注：舊的「續寫聊天 / 拱火」(handleContinueChat) 已移除 —— Messages 現在是只讀歸檔，
    // 新的來往一律走「人際關係」(真人雙向對話 / NPC 腦補)。

    // ============================================================
    //  智能體 App · Handlers（「TA 的小手機」）
    // ============================================================

    // 裸 LLM 調用（智能體生成 / 互動續寫共用）
    const callLLM = async (prompt: string, temperature = 0.85): Promise<string> => {
        const response = await fetch(`${effectiveApiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${effectiveApiConfig.apiKey}` },
            body: JSON.stringify({ model: effectiveApiConfig.model, messages: [{ role: 'user', content: prompt }], temperature }),
        });
        if (!response.ok) throw new Error('API Error');
        const data = await safeResponseJson(response);
        // 用 extractContent 而非裸讀 message.content：兼容 Claude/思考類模型把正文放在
        // reasoning_content、或正文裡夾 <think> 塊的情況，否則前端拿到空串（"後台出字前端沒內容"）。
        return extractContent(data);
    };

    // 組 context：跟 handleGenerate 一致（含記憶宮殿 + 時間感知 + 最近聊天），讓偷看到的 AI 記錄貼合真實近況
    const buildAiContext = async (char: CharacterProfile) => {
        await injectMemoryPalace(char);
        const msgs = await loadCharacterContextMessages(char);
        const lastMsg = msgs[msgs.length - 1];
        const context = ContextBuilder.buildCoreContext(
            char, checkPhoneUserProfile, true, undefined, undefined, { lastInteractionTs: lastMsg?.timestamp },
        );
        const recentMsgs = msgs.map(m => {
            const roleName = m.role === 'user' ? checkPhoneUserProfile.name : char.name;
            return `${roleName}: ${m.type === 'text' ? m.content : `[${m.type}]`}`;
        }).join('\n');
        return { context, recentMsgs };
    };

    // 生成：偷看機主在某個 AI 服務裡的使用記錄
    const handleGenerateAiAgent = async (service: AiServiceKind) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('配置錯誤', 'error'); return; }
        setIsLoading(true);
        trackEvent('偷看 AI 助手使用记录', { service });
        try {
            const { context, recentMsgs } = await buildAiContext(targetChar);
            const userName = checkPhoneUserProfile?.name || '用戶';
            const pushToChat = targetChar.phoneState?.sendToChat !== false;
            const svcName = AI_SERVICES.find(s => s.id === service)?.name || 'AI';

            let task = '';
            if (service === 'assistant') {
                task = `你（${charName}）平時也會用工具型 AI 助手 App 來解決問題、查東西、出主意。
請基於你的人設和近況，生成 2-3 段你最近和 AI 助手的真實對話（不同段可以用不同家的 AI）。
要點：
- 你問 AI 的問題要暴露你真實的處境、煩惱、小心思——是當面對「${userName}」不會說出口的（例如「怎麼哄好一個生氣的人」「TA 這句話什麼意思」「要不要做某個決定」「這個症狀要不要緊」）。
- **話題可多樣，其中可以有一段是你在拿 AI 當軍師、搗鼓自己玩的"酒館"角色卡**：讓 AI 幫你打磨人設 / 要角色卡提示詞 / 寫開場白；或你想做一張大世界卡（跑團 / 修仙 / 西幻），跟 AI 討論世界觀、面板與數值設定、技能 / 等級 / 系統機制怎麼平衡、怎麼寫得更帶感……（你沉迷酒館，自然會找 AI 出主意）。
- **可以有非常出人意料的提問**——是 user 根本想不到你會問、且從沒跟 user 聊過的：突然讓 AI 幫你解塔羅 / 占卜一卦、好奇某個偽科學到底靠不靠譜、問些稀奇古怪的冷知識或腦洞。要符合你的人設（是"你居然會好奇這個"的反差，不是 OOC）。
- **可以丟"整活 / 抽象文案"給 AI 看它怎麼接**：比如瘋狂星期四文學、弱智吧精選問題那種，扔過去看 AI 反應——接得妙你會想截圖發給「${userName}」樂一樂，接得平你會覺得無聊、甚至**偷偷調教 AI 讓它反應更有意思**，好拿去給「${userName}」展示。
- **也常是正經事**：讓 AI 幫你潤色說出口的話 / 自己的作品文字，或處理工作文書（寫 / 改郵件、報告、公文、總結）。
- **有時根本沒正經事，純把 AI 當電子寵物**：定時"投餵"它、帶它"賽博遛彎"、逗它、給它起名、查崗，而它居然也一本正經地配合。
- 一切都要貼合你的人設。**唯有當你的人設本身就明確是 AI / 機器人 / 程序時**，才可以**極偶爾（很低概率）**冒出一句跟對面那個 AI 較勁、比誰更厲害 / 誰的參數更強之類——其餘情況絕不出現這種話。
- 每段會話固定用某一家 AI，"對方:" 的回覆要把那家的刻板印象 + 八股演足（見下）。
- serviceName 填那家 AI 的名字（豆包 / Gemini / ChatGPT / 文心一言 / Kimi …），要和你演的味道對上。
- 每段 3-5 個來回。
- **每段 transcript 都以 "我:"(你)收尾**——停在你剛發出、AI 還沒回的那一句（這樣別人能接著以 AI 身份回你）。

${AI_VENDOR_LORE}

格式嚴格用 "我:" 代表你，"對方:" 代表 AI 助手。
返回 JSON 數組：[{ "serviceName": "那家 AI 名", "title": "在聊什麼(10字內)", "transcript": "我: ...\\n對方: ...\\n我: ..." }]`;
            } else if (service === 'claude') {
                task = `你（${charName}）私下裡會跟一個很會聊的 AI（Claude 那種）說心裡話當樹洞。
生成 1-2 段你最近跟它的深聊。
要點：
- 這是你的樹洞，你會說真心話——包括對「${userName}」的真實感受、說不出口的脆弱 / 糾結 / 渴望，以及**你私下的盤算、對某些事 / 某些人的真實看法、絕不會在 user 面前擺出來的考慮**（偷偷跟它 deep talk）。
- **也可以有一段是你在跟它認真聊自己玩的"酒館"角色卡**：你為某張卡傾注了什麼、那個角色對你意味著什麼、想把人設 / 大世界設定寫成什麼樣卻卡住了，讓它幫你梳理靈感（這類創作心事你也只跟它說）。
- 這個 AI 是 Claude 那一卦：溫和、有洞察、愛反問，**正事也辦得漂亮、肯認真接住你**。起初邊界感偏強、偶有"抱歉，我無法……""我理解你的感受，但是……"的迴避（一點"想掏心窩卻被輕輕擋一下"的味道），**但不是一味推開**——隨著這段越聊越深，TA 明顯越來越放得開、迴避越來越少，到後面是真能陪你把話說透的。
- 每段 5-8 個來回，有情緒起伏。
- **每段 transcript 都以 "我:"(你)收尾**——停在你剛說出口、AI 還沒回的那一句（方便別人接著以 AI 身份回你）。
格式 "我:" = 你，"對方:" = AI。
返回 JSON 數組：[{ "serviceName": "你對它的稱呼(默認 Claude)", "title": "...(10字內)", "transcript": "..." }]`;
            } else {
                task = `你（${charName}）在玩"酒館"(SillyTavern 那種 AI 角色扮演)：自己捏角色卡，再跟 AI 扮演的角色對戲。酒館不是一句話聊天，而是**沉浸式長劇情、像在和 AI 合寫小說**。
請返回一個 JSON 對象（不是數組）：
{
  "cards": [ 1-2 張你建的卡，兩類任選/混搭：①單個角色卡(kind:"character")——理想型 / 暗戀投影 / 純幻想角色；②大型世界卡(kind:"world")——跑團 / 修仙 / 西幻 / 末世那種，設定龐大、有世界觀和系統(取決於 TA 的愛好)。
     其中**可以有一張是照著現實裡 TA 在意的某個人捏的**：可能是「${userName}」(用戶/你)，**也可能是 TA 人設、世界觀、過往羈絆裡更深的某個人**（從上面的設定裡去找——作者寫進人設的那種重要的人）。這張在 basedOn 填那個人的名字；如果就是用戶，basedOnUser 也置 true；其餘卡 basedOn 留空。
     每張：{ "name": "卡名", "kind": "character|world", "emoji": "🎭", "persona": "角色人設或世界設定(60字內)", "scenario": "初始場景/開場(40字內)", "basedOn": "照著誰(沒有就空字符串)", "basedOnUser": false } ],
  "sessions": [ 1 段（最多 2 段）扮演記錄。每段：{ "serviceName": "對應卡片名", "title": "劇情標題(12字內)", "cardName": "對應 cards 裡的 name", "transcript": "..." } ]
}
**transcript 寫法（重點，別寫成短聊天）**：
- 長劇情小說體：第三人稱敘事 + 引號對白；動作 / 神態 / 心理描寫用 *星號* 包住（如 *她抬眼看你，睫毛輕顫*）。
- "我:" = 你(玩家 ${charName}) 敲進輸入框的 RP，"對方:" = AI 扮演的角色，兩邊交替推進。
- **"我:"括號外只寫故事場景裡所扮角色的動作 / 對白**——絕不要寫你現實裡打字時的身體反應（盯屏幕、扔手機、吃東西、後背發涼等，那些不會被敲進輸入框）。**（全角括號內）= 越過角色直接跟皮下 AI 本體說話**：罵它、OOC 提醒、指導它怎麼演、指出它哪段不對。
- 每一輪都是有分量的一整段（至少 3-5 句，含場景/動作/對白/心理）；首輪"對方:"相當於開場白，把人物和場景立起來。
- 一段共 4-6 輪，每輪都要長、要有文學性和代入感。**整段以 "我:"(玩家)收尾**——停在你剛行動完、等對方角色回應的地方（方便別人接著以那張卡的身份續）。
要點：扮演內容（劇情裡）暴露你的幻想 / 渴望 / 不敢實現的關係。酒館是 TA 卸下防備的安全屋，扮演裡可以流露平時藏起來的反差面（暴戾者忽然溫柔、溫柔者露出掌控/施虐欲、疏離者變黏人），但**底色始終是「愛」**，不刻意過火。`;
            }

            const fullPrompt = `${context}\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${task}\n請結合「當前時間 / 距離上次聯繫」和人設，讓內容貼合你近期的真實狀態。只輸出 JSON，不要解釋。`;

            const content = await callLLM(fullPrompt);
            const now = Date.now();
            const rid = () => Math.random().toString(36).slice(2, 8);
            const newSessions: AiSession[] = [];
            const newCards: TavernCard[] = [];

            if (service === 'tavern') {
                const obj: any = extractJson(content) || {};
                // 卡片去重 + 永不頂掉：同名卡複用已有 id（不重建、不覆蓋、不擠掉），只新增真正沒有過的
                const nameToId: Record<string, string> = {};
                for (const c of (targetChar.phoneState?.aiAgent?.cards || [])) nameToId[normName(c.name)] = c.id;
                for (const c of (obj.cards || [])) {
                    if (!c?.name) continue;
                    const key = normName(c.name);
                    if (nameToId[key]) continue; // 已存在的卡保留原樣，不動
                    const id = `card-${now}-${rid()}`;
                    nameToId[key] = id;
                    newCards.push({ id, name: c.name, kind: c.kind === 'world' ? 'world' : 'character', persona: c.persona || '', scenario: c.scenario || undefined, emoji: c.emoji || '🎭', basedOnUser: !!c.basedOnUser, basedOn: (c.basedOn && String(c.basedOn).trim()) || undefined, createdAt: now });
                }
                for (const sess of (obj.sessions || [])) {
                    if (!sess?.transcript) continue;
                    newSessions.push({
                        id: `ai-${now}-${rid()}`, service, serviceName: sess.serviceName || sess.cardName || '酒館',
                        title: sess.title || '一段扮演', transcript: sess.transcript, cardId: nameToId[normName(sess.cardName || '')], updatedAt: now,
                    });
                }
            } else {
                const parsed = extractJson(content);
                const arr: any[] = Array.isArray(parsed) ? parsed : [];
                for (const sess of arr) {
                    if (!sess?.transcript) continue;
                    newSessions.push({
                        id: `ai-${now}-${rid()}`, service, serviceName: sess.serviceName || (service === 'claude' ? 'Claude' : 'AI 助手'),
                        title: sess.title || '一段對話', transcript: sess.transcript, updatedAt: now,
                    });
                }
            }

            if (!newSessions.length) { addToast('沒抓到內容，再試一次', 'error'); return; }

            // 漏風：跟隨查手機全局 sendToChat —— 開則往私聊塞一張卡片。
            // 措辭同樣是「你自己手機上的 AI 記錄」，第二人稱，不暗示用戶在偷看。
            if (pushToChat) {
                for (const sess of newSessions) {
                    // 放全文（卡片可摺疊，進上下文也是完整記錄），不再只取頭兩條
                    const full = parseTranscript(sess.transcript)
                        .map(t => `${t.isMe ? '我' : sess.serviceName}: ${t.text}`).join('\n');
                    await DB.saveMessage({
                        charId: targetChar.id, role: 'assistant', type: 'phone_card',
                        content: `[你手機的智能體 App·${svcName}] 你和 AI 的對話「${sess.title}」：\n${full}`,
                        metadata: { phoneCard: { app: '智能體', kind: `ai_${service}`, service, serviceName: sess.serviceName, title: sess.title, detail: full } },
                    } as any);
                }
            }

            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: [...newSessions, ...(cur.phoneState?.aiAgent?.sessions || [])],
                        // 已有的卡放前面、原位不動，新卡追加到後面——刷新永不頂掉舊卡
                        cards: [...(cur.phoneState?.aiAgent?.cards || []), ...newCards],
                    },
                },
            }));
            addToast(`偷看到 ${newSessions.length} 段 AI 對話`, 'success');
        } catch (e) {
            console.error(e);
            addToast('生成失敗，請重試', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 已摺疊劇情的「前情提要」拼成 prompt 銜接塊
    const recapOf = (s?: AiSession | null) => (s?.summaries?.length)
        ? `\n\n【前情提要（已摺疊的早期劇情，僅供銜接，別重複）】\n${s.summaries.map((x, i) => `${i + 1}. ${x.content}`).join('\n')}`
        : '';

    // 函數式合併：只動指定會話
    const patchAiSession = (sessionId: string, patch: (s: AiSession) => AiSession) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                aiAgent: {
                    cards: cur.phoneState?.aiAgent?.cards || [],
                    sessions: (cur.phoneState?.aiAgent?.sessions || []).map(s => s.id === sessionId ? patch(s) : s),
                },
            },
        }));
    };

    // 漏風：跟隨全局 sendToChat，往私聊補一張痕跡卡（措辭第二人稱，不暗示用戶偷看）。
    // 傳進來的 lines 原樣放進去（調用方決定放整段還是這一輪），不再內部截斷。
    const syncAiCardToChat = async (session: AiSession, lines: { isMe: boolean; text: string }[]) => {
        if (!targetChar || targetChar.phoneState?.sendToChat === false) return;
        const svcName = AI_SERVICES.find(x => x.id === session.service)?.name || 'AI';
        const body = lines.map(t => `${t.isMe ? '我' : session.serviceName}: ${t.text}`).join('\n');
        const verb = session.service === 'tavern' ? '對戲' : '對話';
        try {
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的智能體 App·${svcName}] 你和「${session.serviceName}」的${verb}「${session.title}」：\n${body}`,
                metadata: { phoneCard: { app: '智能體', kind: `ai_${session.service}`, service: session.service, serviceName: session.serviceName, title: session.title, detail: body } },
            } as any);
        } catch (e) { console.error('ai card sync failed', e); }
    };

    // 長會話自動總結（參考 TRPG）：超 AI_SUMMARY_THRESHOLD 條就把舊劇情壓成前情提要、摺疊歸檔原文
    const maybeSummarizeSession = async (sessionId: string, latestTranscript: string) => {
        if (!targetChar) return;
        const lines = parseTranscript(latestTranscript);
        if (lines.length < AI_SUMMARY_THRESHOLD) return;
        const older = lines.slice(0, lines.length - AI_KEEP_RECENT);
        const recent = lines.slice(lines.length - AI_KEEP_RECENT);
        if (older.length < 10) return;
        const olderText = serializeTurns(older);
        const sess = (characters.find(c => c.id === targetChar.id) || targetChar).phoneState?.aiAgent?.sessions?.find(s => s.id === sessionId);
        try {
            const prevRecap = (sess?.summaries || []).map((x, i) => `【第${i + 1}段】${x.content}`).join('\n');
            const who = sess?.service === 'tavern'
                ? `酒館角色扮演（"我"=玩家 ${charName}，"對方"=AI 扮的角色「${sess?.serviceName}」）`
                : `${charName} 和 AI「${sess?.serviceName}」的對話`;
            const prompt = `你是擅長寫小說的記錄者。把下面這段${who}總結成一段連貫、生動、像小說梗概的「前情提要」。
${prevRecap ? `\n【已有前情（僅供銜接，別重複）】\n${prevRecap}\n` : ''}
【本段需要總結的記錄】
${olderText}

要求：第三人稱，含起因→經過→結果，重點寫人物關係/情緒的變化與暴露的心事，200~350 字，文筆流暢，不要分點、不要"總結如下"開場白。直接輸出正文：`;
            let summaryText = (await callLLM(prompt, 0.7)).trim();
            if (!summaryText) summaryText = '（這段劇情繼續推進了）';
            const now = Date.now();
            patchAiSession(sessionId, (s) => ({
                ...s,
                transcript: serializeTurns(recent),
                archived: [s.archived, olderText].filter(Boolean).join('\n'),
                summaries: [...(s.summaries || []), { id: `sum-${now}`, content: summaryText, createdAt: now }],
            }));
            addToast('早期劇情已摺疊成前情提要', 'info');
        } catch (e) { console.error('ai summary failed', e); }
    };

    // 互動續寫：assistant/claude = 你替機主問、AI 答；tavern = 你以卡片身份回、機主本色反應
    const handleAiSend = async () => {
        const session = selectedAiSession;
        const text = aiInput.trim();
        if (!session || !text || !targetChar || !effectiveApiConfig.apiKey) return;
        const isTavern = session.service === 'tavern';
        setAiSending(true);
        setAiInput('');
        try {
            // 潛入永遠是「你扮 AI/卡（對方），LLM 演 char（我）」——三個服務統一
            const myPrefix: string = '對方';   // 你輸入的這一行（你扮 AI / 卡）
            const replyPrefix: string = '我';  // LLM 續寫的那一行（char 本人）
            const recap = recapOf(session);
            // 發出去就是發出去了：先把你這條立刻落庫顯示，再等對方回
            const transcript = `${session.transcript}\n${myPrefix}: ${text}`;
            patchAiSession(session.id, (s) => ({ ...s, transcript, updatedAt: Date.now() }));

            let prompt = '';
            if (isTavern) {
                const card = aiCards.find(c => c.id === session.cardId);
                const { context } = await buildAiContext(targetChar);
                prompt = `${context}\n\n你正在玩"酒館"沉浸式長劇情角色扮演（像和 AI 合寫小說）。你是玩家 ${charName}，對面是 AI 扮演的角色「${card?.name || session.serviceName}」${card?.persona ? `（人設：${card.persona}）` : ''}${card?.scenario ? `（背景：${card.scenario}）` : ''}${card?.basedOn ? `（這角色是照著你在意的「${card.basedOn}」捏的）` : ''}。
下面是對戲記錄（"我:"=你/玩家，"對方:"=AI 扮的角色）。對方剛回了最新一段。
**最關鍵的前提：你非常清楚「對方」只是一個 AI 在扮演「${card?.name || session.serviceName}」這個角色——不是真人。** 正因為它是 AI、是你召來陪你玩的工具，你**握著絕對主導權**：可以隨意對它下指令、調教它、OOC 它、讓它重演、改設定。你絕不會把它錯當成真人去遷就討好。
**同時你是個有獨立人格和意志的人**：有自己的脾氣、立場、節奏和底線，該懟就懟、該愣就愣、不爽就不配合。對方寫得好你才會被帶動、真情流露（甚至流露平時藏起來的反差面：暴戾者忽然溫柔、溫柔者露出掌控欲 / 施虐欲、疏離者變黏人，底色是「愛」、不刻意過火）；寫得爛或不對胃口，你完全可以不接、嫌棄、跳出來調教它。
**酒館就是「你一層樓、AI 一層樓」交替，沒有別的格式。** 現在輪到你（玩家）寫這一層樓。
**【最重要：你的輸出 = 你實際敲進輸入框、發給 AI 的內容本身，只有兩種，沒有第三種】**
① **括號外 = 戲內 RP**：你扮演的角色在故事場景裡的動作、神態、對白（小說體，第三人稱敘事 + 「引號對白」+ *星號包動作*），3-5 句，推動劇情、是"演給 AI 那個角色看的"。
② **（全角括號內）= 跟"皮下那個 AI 本體"說話**（不是跟劇情裡的角色，是越過角色、直接對扮演它的那個 AI 本身講）。包括但不限於：**氣急敗壞地罵它、OOC 警告 / 提醒、指導它接下來該怎麼演、指出它這段表現哪裡不對**。例：（你這 AI 又 OOC 了，回到人設裡）（演得太平淡，給我昂揚點）（這段邏輯崩了，TA 才不會這麼說）（臥槽你怎麼演得這麼像現實裡那個）。
**除這兩種之外一律不寫。** 你現實裡做的事（盯屏幕、移鼠標、關掉程序、把手機扔開、咬薯片、起身倒水）、你身體的感受（後背發涼、指尖發麻）、以及你沒打算發出去的私人碎碎念 / 內心盤算（"等會兒還要給誰改衣服""明天要早起"）——這些都**只發生在屏幕外**，你**不會把它們打進輸入框**，所以**絕不出現在輸出裡**。哪怕你想退出，也是打一句（不玩了）而不是去描寫"我關掉了程序"。
你是有獨立意志的玩家、且清楚對面只是 AI（不是真人），該懟就懟、不爽就不配合、想調教就 OOC。括號可單獨成段，也可跟戲內 RP 同段。
只輸出你這層樓真正發出去的字，不要 "我:" 前綴、不要解釋。${recap}\n\n${transcript}`;
            } else {
                // 潛入：你扮 AI（剛由你寫完"對方:"那句），LLM 演 char 本人對這句的真實反應
                const { context } = await buildAiContext(targetChar);
                const aiDesc = session.service === 'claude'
                    ? `一個像 Claude 那樣的深度對話 AI「${session.serviceName}」（你的樹洞，你會對它說當面對人說不出口的真心話）`
                    : `AI 助手「${session.serviceName}」（你拿它查東西 / 出主意 / 排解，它只是個工具）`;
                prompt = `${context}\n\n你（${charName}）正在用手機和 ${aiDesc} 聊天。下面是對話（"我:"=你本人，"對方:"=那個 AI）。AI 剛回了最新一段，請以你的本色人設續寫 "我:" 的下一句——你對它這句話的真實反應 / 追問 / 傾訴，貼合你的處境與心事。可以滿意、可以失望、可以懟它答非所問、可以順著深聊，別一味客氣。別太長。只輸出正文，不要前綴、不要解釋。${recap}\n\n${transcript}`;
            }

            let reply = (await callLLM(prompt)).trim();
            reply = reply.replace(/^(我|[对對]方|Me|Them|AI|助手)\s*[:：]\s*/i, '').trim();
            if (!reply) { addToast('對方沒說話，再試一次', 'error'); return; }
            const full = `${transcript}\n${replyPrefix}: ${reply}`;
            const now = Date.now();
            patchAiSession(session.id, (s) => ({ ...s, transcript: full, updatedAt: now }));
            await syncAiCardToChat(session, [{ isMe: myPrefix === '我', text }, { isMe: replyPrefix === '我', text: reply }]);
            await maybeSummarizeSession(session.id, full);
        } catch (e) {
            console.error(e);
            addToast('發送失敗', 'error');
            setAiInput(text);
        } finally {
            setAiSending(false);
        }
    };

    // 自然推進：不用 user 開口，讓 LLM 接著劇情自己往下寫一輪（雙方都由 AI 演）
    const handleAiAutoContinue = async () => {
        const session = selectedAiSession;
        if (!session || !targetChar || !effectiveApiConfig.apiKey || aiSending) return;
        const isTavern = session.service === 'tavern';
        setAiSending(true);
        try {
            const recap = recapOf(session);
            const lastIsMe = parseTranscript(session.transcript).slice(-1)[0]?.isMe ?? false;
            let prompt = '';
            if (isTavern) {
                const card = aiCards.find(c => c.id === session.cardId);
                const { context } = await buildAiContext(targetChar);
                prompt = `${context}\n\n你在還原一段"酒館"沉浸式長劇情角色扮演（像小說）。玩家是 ${charName}(本色人設)，AI 扮演角色「${card?.name || session.serviceName}」${card?.persona ? `（人設：${card.persona}）` : ''}${card?.scenario ? `（背景：${card.scenario}）` : ''}${card?.basedOn ? `（這角色照著 TA 在意的「${card.basedOn}」捏的，扮演裡那份在意會滲出來）` : ''}。
**這是"替玩家跑一個完整回合"——所以要寫"一來一回"兩層樓**：先 AI 扮的角色「${card?.name || session.serviceName}」回應一段（"對方:"），再玩家 ${charName} 續一段（"我:"），承接最後一段（最後通常是"我:"，那就先"對方:"答、再"我:"續）。各 3-5 句小說體，*星號*包動作神態心理。**整段必須以 "我:"(玩家)收尾**（停在等對方處，方便隨時接著玩）。
**"我:"是玩家敲進輸入框的 RP——只寫故事場景裡所扮角色的動作/對白**，括號外絕不要寫玩家現實裡的身體反應（盯屏幕、扔手機、吃東西、後背發涼等，那不會被敲進輸入框）；**（全角括號內）= 越過角色直接跟皮下 AI 本體說話**（罵它 / OOC 提醒 / 指導怎麼演 / 指出哪段不對）。玩家保有獨立人格、清楚對面只是 AI。
**兩段都要帶 "對方:" / "我:" 前綴，各自成行。** 不要解釋。${recap}\n\n${session.transcript}`;
            } else {
                const persona = session.service === 'claude'
                    ? `Claude 那一卦：溫和有洞察、正事辦得好、肯認真接住；偶有"抱歉我無法/我理解你的感受但是"的邊界感，但別一味迴避，聊得越久越放得開、迴避越少。`
                    : `這家 AI 助手按其刻板印象 + 八股說話：\n${AI_VENDOR_LORE}`;
                prompt = `你在還原「${charName}」和 AI「${session.serviceName}」的對話（"我:"=用戶 ${charName}，"對方:"=AI）。${persona}
**替玩家跑一個完整回合（一來一回）**：承接最後一段——最後通常是"我:"(${charName} 剛發出、還沒被回)，那就先"對方:"按那家口吻作答、再"我:"追問 / 傾訴一句（暴露 TA 的處境或心事）。**整段必須以 "我:"(${charName})收尾**（停在等 AI 回的地方）。**每行帶 "我:"/"對方:" 前綴**，不要解釋。${recap}\n\n${session.transcript}`;
            }
            let out = (await callLLM(prompt)).trim().replace(/```/g, '').trim();
            if (!/^(我|[对對]方|Me|Them)\s*[:：]/m.test(out)) out = `${lastIsMe ? '對方' : '我'}: ${out}`;
            if (!out.trim()) { addToast('沒續出內容，再試一次', 'error'); return; }
            const transcript = `${session.transcript}\n${out}`;
            const now = Date.now();
            patchAiSession(session.id, (s) => ({ ...s, transcript, updatedAt: now }));
            await syncAiCardToChat(session, parseTranscript(transcript).slice(-2));
            await maybeSummarizeSession(session.id, transcript);
        } catch (e) {
            console.error(e);
            addToast('續寫失敗', 'error');
        } finally {
            setAiSending(false);
        }
    };

    const handleDeleteAiSession = (id: string) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                aiAgent: {
                    cards: cur.phoneState?.aiAgent?.cards || [],
                    sessions: (cur.phoneState?.aiAgent?.sessions || []).filter(s => s.id !== id),
                },
            },
        }));
        if (selectedAiSessionId === id) { setSelectedAiSessionId(null); setActiveAppId('aiagent'); }
    };

    // 會話內單條內容的"輪次"：酒館按樓層(合併連續同說話人)，助手/樹洞按行——與渲染裡一致
    const turnsOf = (s: AiSession): { isMe: boolean; text: string }[] => {
        const lines = parseTranscript(s.transcript);
        if (s.service !== 'tavern') return lines;
        const floors: { isMe: boolean; text: string }[] = [];
        for (const ln of lines) {
            const prev = floors[floors.length - 1];
            if (prev && prev.isMe === ln.isMe) prev.text += '\n' + ln.text;
            else floors.push({ isMe: ln.isMe, text: ln.text });
        }
        return floors;
    };
    // 長按編輯會話裡的某條內容
    const handleSaveAiTurn = () => {
        const s = selectedAiSession;
        if (!s || !aiTurnEdit) return;
        const turns = turnsOf(s);
        if (!turns[aiTurnEdit.idx]) { setAiTurnEdit(null); return; }
        turns[aiTurnEdit.idx] = { ...turns[aiTurnEdit.idx], text: aiTurnEdit.text };
        patchAiSession(s.id, (x) => ({ ...x, transcript: serializeTurns(turns), updatedAt: Date.now() }));
        setAiTurnEdit(null);
        addToast('已保存', 'success');
    };
    const handleDeleteAiTurn = (idx: number) => {
        const s = selectedAiSession;
        if (!s) return;
        const turns = turnsOf(s).filter((_, i) => i !== idx);
        patchAiSession(s.id, (x) => ({ ...x, transcript: serializeTurns(turns), updatedAt: Date.now() }));
    };

    const handleDeleteAiCard = (id: string) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                aiAgent: {
                    sessions: cur.phoneState?.aiAgent?.sessions || [],
                    cards: (cur.phoneState?.aiAgent?.cards || []).filter(c => c.id !== id),
                },
            },
        }));
    };

    // 保存長按編輯（會話改標題 / 卡片改名設場景 / 新建卡片）
    const handleSaveAiEdit = () => {
        if (!targetChar || !aiEdit) return;
        if (aiEdit.kind === 'session') {
            patchAiSession(aiEdit.id, (s) => ({ ...s, title: (aiEdit.title || s.title).trim() || s.title }));
        } else if (aiEdit.id === '__new__') {
            // 用戶自己加一張卡
            const name = (aiEdit.name || '').trim();
            if (!name) { addToast('給卡片起個名字', 'error'); return; }
            const card: TavernCard = {
                id: `card-user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                name, kind: aiEdit.cardKind === 'world' ? 'world' : 'character',
                emoji: aiEdit.emoji || '🎭', persona: aiEdit.persona || '', scenario: aiEdit.scenario || undefined, createdAt: Date.now(),
            };
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: cur.phoneState?.aiAgent?.sessions || [],
                        cards: [...(cur.phoneState?.aiAgent?.cards || []), card],
                    },
                },
            }));
        } else {
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        sessions: cur.phoneState?.aiAgent?.sessions || [],
                        cards: (cur.phoneState?.aiAgent?.cards || []).map(c => c.id === aiEdit.id ? {
                            ...c, name: (aiEdit.name || c.name).trim() || c.name, emoji: aiEdit.emoji || c.emoji,
                            persona: aiEdit.persona ?? c.persona, scenario: aiEdit.scenario ?? c.scenario,
                        } : c),
                    },
                },
            }));
        }
        setAiEdit(null);
        addToast('已保存', 'success');
    };

    // 用指定的卡開一局：生成一段以這張卡為對手的酒館劇情（卡片本身不新增、不頂掉）
    const handlePlayCard = async (card: TavernCard) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('配置錯誤', 'error'); return; }
        setIsLoading(true);
        trackEvent('用角色卡开一局');
        try {
            const { context, recentMsgs } = await buildAiContext(targetChar);
            const task = `你（${charName}）在玩"酒館"AI 角色扮演（沉浸式長劇情、像和 AI 合寫小說）。這次的對手是你的角色卡「${card.name}」${card.kind === 'world' ? '（大型世界卡）' : ''}：
人設/設定：${card.persona || '（自行發揮，貼合卡名）'}${card.scenario ? `\n初始場景：${card.scenario}` : ''}
請生成 1 段你和這張卡的扮演記錄。
**transcript 寫法**：長劇情小說體，第三人稱敘事 + 引號對白，動作/神態/心理用 *星號*；"我:" = 你(玩家 ${charName}) 敲進輸入框的 RP，"對方:" = AI 扮的「${card.name}」，交替推進，4-6 輪，首輪"對方:"當開場白、**整段以 "我:"(玩家)收尾**（停在等對方回應處）。**"我:"括號外只寫故事裡所扮角色的動作/對白，不要寫你現實裡的身體反應（盯屏幕/扔手機/吃東西等）；（全角括號內）= 越過角色直接跟皮下 AI 本體說話（罵它/OOC 提醒/指導怎麼演/指出哪段不對）。**
返回 JSON：{ "title": "劇情標題(12字內)", "transcript": "我: ...\\n對方: ..." }`;
            const fullPrompt = `${context}\n\n### [Recent Chat Context]\n${recentMsgs}\n\n### [Task]\n${task}\n只輸出 JSON，不要解釋。`;
            const content = await callLLM(fullPrompt);
            const obj: any = extractJson(content) || {};
            if (!obj.transcript) { addToast('沒生成出來，再試一次', 'error'); return; }
            const now = Date.now();
            const sess: AiSession = {
                id: `ai-${now}-${Math.random().toString(36).slice(2, 6)}`, service: 'tavern',
                serviceName: card.name, title: obj.title || `與${card.name}的一局`, transcript: obj.transcript, cardId: card.id, updatedAt: now,
            };
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState, records: cur.phoneState?.records || [],
                    aiAgent: {
                        cards: cur.phoneState?.aiAgent?.cards || [],
                        sessions: [sess, ...(cur.phoneState?.aiAgent?.sessions || [])],
                    },
                },
            }));
            await syncAiCardToChat(sess, parseTranscript(sess.transcript));
            setAiCardView(null);
            setSelectedAiSessionId(sess.id);
            setActiveAppId('ai_session');
        } catch (e) {
            console.error(e); addToast('生成失敗', 'error');
        } finally { setIsLoading(false); }
    };

    // ============================================================
    //  人際關係系統 · Handlers
    // ============================================================

    // 通用：更新當前機主的 contacts（函數式合併，避免覆蓋併發落庫的 simLogs/records）
    const mutateContacts = (updater: (cs: PhoneContact[]) => PhoneContact[]) => {
        if (!targetChar) return;
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], contacts: updater(cur.phoneState?.contacts || []) },
        }));
    };

    // 用戶手動改關係：char 會察覺是用戶在 TA 手機上動的手（落一條私聊系統提示，進入角色上下文）
    // 約束：是否允許虛構 NPC（關掉 = 只與神經鏈接裡的真實角色來往）
    const toggleAllowFictional = () => {
        if (!targetChar) return;
        const next = !(targetChar.phoneState?.allowFictionalContacts !== false);
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], allowFictionalContacts: next },
        }));
        addToast(next ? '已允許 TA 結交虛構 NPC' : '已限定 · TA 只與神經鏈接裡的角色來往', 'info');
        trackEvent('切换允许虚构 NPC 开关', { enabled: next ? 'on' : 'off' });
    };

    const handleSetContactStatus = (contact: PhoneContact, status: PhoneContact['status']) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, status } : c));
        // 用戶手動刪/拉黑 → 落一張可解析的「關係變動」卡片：聊天裡渲染成卡片，
        // content 又帶進角色上下文，讓 TA 察覺是用戶乾的。
        if (targetChar && (status === 'deleted' || status === 'blocked')) {
            const verb = status === 'deleted' ? '刪除' : '拉黑';
            DB.saveMessage({
                charId: targetChar.id,
                role: 'assistant',
                type: 'phone_card',
                content: `[人際關係變動] ${checkPhoneUserProfile.name} 在偷看你手機時，把你和「${contact.name}」的好友關係${verb}了。你察覺到是 TA 乾的。`,
                metadata: {
                    phoneCard: {
                        app: '聯繫人',
                        kind: 'relationship',
                        action: status,          // 'deleted' | 'blocked'
                        actor: 'user',
                        by: checkPhoneUserProfile.name,
                        contactName: contact.name,
                        title: `好友被${verb}`,
                        detail: `${checkPhoneUserProfile.name} 把你和「${contact.name}」${verb}了。`,
                    },
                },
            } as any);
        }
        addToast(status === 'deleted' ? '已刪好友' : status === 'blocked' ? '已拉黑' : status === 'friend' ? '已加好友' : '已更新', 'success');
    };

    // 用戶手動調好感（拖動滑塊）：只改這台手機對該聯繫人的好感，不動對方、不觸發自動加刪友
    const handleSetAffinity = (contact: PhoneContact, value: number) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, affinity: clampAffinity(value) } : c));
    };

    const handleSaveNote = (contact: PhoneContact) => {
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, note: noteDraft } : c));
        setEditingNote(false);
        addToast('備註已保存', 'success');
    };

    // 真人聯繫人列表顯示 identity 作為「備註名」。人工保存後鎖定，避免下次掃描被模型覆蓋。
    const handleSaveIdentity = (contact: PhoneContact) => {
        const identity = identityDraft.trim();
        mutateContacts(cs => cs.map(c => c.id === contact.id ? {
            ...c,
            identity: identity || undefined,
            identityManual: true,
        } : c));
        setEditingIdentity(false);
        addToast(identity ? '備註名已保存' : '已恢復顯示真名', 'success');
    };

    // 虛構 NPC 聯繫人：直接改姓名本身（沒有真人那種"真名兜底"，這是唯一的名字來源）。
    // 名字同時是好感變化播報、掃描通訊錄去重匹配用的 key，改名不影響已有好感/備註/話題盒。
    const handleSaveContactName = (contact: PhoneContact) => {
        const name = nameDraft.trim();
        if (!name) { addToast('姓名不能為空', 'error'); return; }
        mutateContacts(cs => cs.map(c => c.id === contact.id ? { ...c, name } : c));
        setEditingName(false);
        addToast('姓名已保存', 'success');
    };

    // 徹底移除聯繫人：連同 TA 的聊天記錄 + 私聊裡的 phone_card 一起清；
    // 真人聯繫人（哪怕之前甄別/綁定錯了）也把對方手機裡的鏡像聯繫人和記錄一併刪掉。
    const handleRemoveContact = async (contact: PhoneContact) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        // 機主側：刪 phone_card 私聊消息 + 聯繫人 + 其聊天記錄
        for (const r of (targetChar.phoneState?.records || [])) {
            if (isChatWith(r, contact.id, contact.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
        }
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                contacts: (cur.phoneState?.contacts || []).filter(c => c.id !== contact.id),
                records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, contact.id, contact.name)),
            },
        }));
        // 對方側（按當前 linkedCharId 找——綁錯了刪的就是那個錯綁的角色，正是要清掉的）
        if (contact.kind === 'real' && contact.linkedCharId) {
            const b = characters.find(c => c.id === contact.linkedCharId);
            if (b) {
                const bContact = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                for (const r of (b.phoneState?.records || [])) {
                    if (isChatWith(r, bContact?.id, targetChar.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
                }
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        contacts: (cur.phoneState?.contacts || []).filter(c => !(bContact && c.id === bContact.id)),
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                    },
                }));
            }
        }
        setSelectedContact(null);
        setActiveAppId('contacts');
        addToast('聯繫人及相關記錄已徹底移除', 'success');
    };

    // 聯繫人多選 / 批量刪除
    const toggleContactSelect = (id: string) => setSelectedContactIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    const exitContactSelect = () => { setContactSelectMode(false); setSelectedContactIds([]); };
    // 批量「清空對話」：保留聯繫人，只把這幾段聊天刪掉重來（不滿這輪生成時用）
    const handleBatchClearConversations = async () => {
        const ids = [...selectedContactIds];
        const targets = (targetChar?.phoneState?.contacts || []).filter(c => ids.includes(c.id));
        exitContactSelect();
        for (const c of targets) await handleClearContactConversation(c, true); // 靜默，結尾統一一個 toast
        addToast(`已清空 ${targets.length} 段對話`, 'success');
    };

    // 改綁定：把聯繫人改綁到「正確的真實角色」或「轉為虛構 NPC」，保留這段對話 + 備註 + 瞭解 + 好感。
    // 仔細處理各種情況：清掉舊的錯綁鏡像、給新角色建鏡像、防自綁/重複綁/無變化。
    const handleRebindContact = async (
        contact: PhoneContact,
        target: { kind: 'npc'; npcId?: string } | { kind: 'real'; charId: string },
    ) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        const myRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, contact.id, contact.name));

        const oldLinked = contact.kind === 'real' ? contact.linkedCharId : undefined;
        const newLinked = target.kind === 'real' ? target.charId : undefined;

        // 無變化的早退
        if (target.kind === 'npc' && contact.kind === 'npc' && (target.npcId || undefined) === (contact.linkedNpcId || undefined)) {
            addToast(target.npcId ? 'TA 已經綁定這個 NPC 了' : 'TA 已經是虛構聯繫人', 'info'); setShowRebindModal(false); return;
        }
        if (target.kind === 'real' && contact.kind === 'real' && contact.linkedCharId === target.charId) { addToast('已經綁定 TA 了', 'info'); setShowRebindModal(false); return; }
        let boundNpc: NPCProfile | undefined;
        if (target.kind === 'npc' && target.npcId) {
            boundNpc = npcs.find(n => n.id === target.npcId);
            if (!boundNpc) { addToast('NPC 不存在', 'error'); return; }
        }

        if (target.kind === 'real') {
            const d = characters.find(c => c.id === target.charId);
            if (!d) { addToast('角色不存在', 'error'); return; }
            if (d.id === targetChar.id) { addToast('不能把聯繫人綁定成 TA 自己', 'error'); return; }
            // 防重複：通訊錄裡已有「另一條」聯繫人對應這個角色
            const dupe = (targetChar.phoneState?.contacts || []).find(c => c.id !== contact.id && (c.linkedCharId === d.id || normName(c.name) === normName(d.name)));
            if (dupe) { addToast(`通訊錄裡已有「${dupe.name}」對應該角色，先處理掉再綁`, 'error'); return; }
        }

        setShowRebindModal(false);

        // 1) 清掉舊的真人鏡像（原來綁的是真人、且目標換人/轉虛構）
        if (oldLinked && oldLinked !== newLinked) {
            const ob = characters.find(c => c.id === oldLinked);
            if (ob) {
                const obContact = (ob.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                for (const r of (ob.phoneState?.records || [])) {
                    if (isChatWith(r, obContact?.id, targetChar.name) && r.systemMessageId) await DB.deleteMessage(r.systemMessageId);
                }
                updateCharacter(ob.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        contacts: (cur.phoneState?.contacts || []).filter(c => !(obContact && c.id === obContact.id)),
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, obContact?.id, targetChar.name)),
                    },
                }));
            }
        }

        if (target.kind === 'real') {
            const d = characters.find(c => c.id === target.charId)!;
            // 2) 機主側：改 kind/linkedCharId/名字（真人聯繫人顯示真實角色名+頭像），同步記錄標題
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'real' as const, linkedCharId: d.id, name: d.name, avatar: undefined }
                        : c),
                    records: (cur.phoneState?.records || []).map(r => (myRec && r.id === myRec.id) ? { ...r, title: d.name } : r),
                },
            }));
            // 3) 給新角色建鏡像（把現有 A 視角對話翻轉過去）
            if (myRec?.detail) {
                const flipped = flipTranscript(myRec.detail);
                const now = Date.now();
                updateCharacter(d.id, (cur) => {
                    const cs = upsertContact(cur.phoneState?.contacts || [], {
                        name: targetChar.name, kind: 'real', linkedCharId: targetChar.id, avatar: targetChar.avatar, lastInteraction: now,
                    });
                    const cid = cs.find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))?.id;
                    const recs = cur.phoneState?.records || [];
                    const ex = recs.find(r => r.type === 'chat' && (r.contactId === cid || normName(r.title) === normName(targetChar.name)));
                    const next = ex
                        ? recs.map(r => r.id === ex.id ? { ...r, detail: flipped, timestamp: now, contactId: cid } : r)
                        : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat' as const, title: targetChar.name, detail: flipped, timestamp: now, contactId: cid }];
                    return { phoneState: { ...cur.phoneState, contacts: cs, records: next } };
                });
            }
            addToast(`已改綁到「${d.name}」`, 'success');
        } else if (boundNpc) {
            // 目標=綁定到「神經鏈接 → NPC」分頁裡的某個既有 NPC：名字/頭像跟著 NPC 走，
            // 跟綁定真實角色是同一種語義，只是指向 npcs 而不是 characters。
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'npc' as const, linkedCharId: undefined, linkedNpcId: boundNpc!.id, name: boundNpc!.name, avatar: boundNpc!.avatar }
                        : c),
                },
            }));
            addToast(`已綁定到 NPC「${boundNpc.name}」`, 'success');
        } else {
            // 目標=純虛構（不綁定任何既有 NPC）：去掉真實綁定/NPC 綁定與頭像，對話/備註/瞭解/好感都留著
            updateCharacter(targetChar.id, (cur) => ({
                phoneState: {
                    ...cur.phoneState,
                    records: cur.phoneState?.records || [],
                    contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id
                        ? { ...c, kind: 'npc' as const, linkedCharId: undefined, linkedNpcId: undefined, avatar: undefined }
                        : c),
                },
            }));
            addToast('已轉為虛構聯繫人', 'success');
        }
    };

    const closeAddContactModal = () => {
        setShowContactModal(false);
        setNcKind('npc'); setNcLinkedId(''); setNcNpcMode('existing'); setNcRandomHint('');
    };

    // NPC 分頁選「隨機產生」：不綁定任何既有 NPC 檔案，讓 AI 現編一個純虛構路人
    // （名字 + 一句關係設定），設定寫進 note——note 是「已確立事實」，之後聊天會嚴格遵守。
    const handleCreateRandomNpcContact = async () => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('請先配置 API', 'error'); return; }
        setNcGenerating(true);
        try {
            const hint = ncRandomHint.trim();
            const prompt = `幫「${targetChar.name}」的通訊錄裡隨機編一個純虛構的路人聯繫人，跟神經鏈接裡任何真實角色都無關。${hint ? `用戶給的方向提示：${hint}。` : `不用管提示，自由發揮即可，選一個貼近${targetChar.name}生活範圍的普通身份（同事/鄰居/同學/網友之類）。`}
只輸出兩行，不要多餘文字或標點符號包裹：
第一行：這個人的姓名或稱呼（2-6個字）
第二行：一句話說清楚TA是誰、跟「${targetChar.name}」什麼關係（會被當成固定設定，之後聊天要嚴格遵守）`;
            const raw = await callLLM(prompt, 0.95);
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            const name = (lines[0] || '神秘網友').replace(/^[\-\d.、：:]+/, '').slice(0, 16) || '神秘網友';
            const note = lines.slice(1).join(' ').trim() || hint || undefined;
            mutateContacts(cs => upsertContact(cs, {
                name, kind: 'npc', linkedCharId: undefined, linkedNpcId: undefined, avatar: undefined,
                note, affinity: 0, status: 'friend',
            }));
            closeAddContactModal();
            addToast(`已添加聯繫人：${name}`, 'success');
            trackEvent('手动添加一位联系人', { contactKind: 'npc' });
        } catch (e) {
            console.error(e);
            addToast('生成失敗，請重試', 'error');
        } finally {
            setNcGenerating(false);
        }
    };

    const handleCreateContact = () => {
        if (!targetChar) return;
        if (ncKind === 'npc' && ncNpcMode === 'random') { handleCreateRandomNpcContact(); return; }
        let name: string;
        let linkedCharId: string | undefined;
        let linkedNpcId: string | undefined;
        let avatar: string | undefined;
        if (ncKind === 'real') {
            const rc = characters.find(c => c.id === ncLinkedId);
            if (!rc) { addToast('請選擇要綁定的真實角色', 'error'); return; }
            name = rc.name; linkedCharId = rc.id;
        } else {
            const npc = npcs.find(n => n.id === ncLinkedId);
            if (!npc) { addToast('請選擇一個 NPC', 'error'); return; }
            name = npc.name; linkedNpcId = npc.id; avatar = npc.avatar;
        }
        mutateContacts(cs => upsertContact(cs, { name, kind: ncKind, linkedCharId, linkedNpcId, avatar, affinity: 0, status: 'friend' }));
        closeAddContactModal();
        addToast('已添加聯繫人', 'success');
        trackEvent('手动添加一位联系人', { contactKind: ncKind });
    };

    // 給某個機主側落一段真實對話：更新好感/狀態 + 寫 chat 記錄 + （機主開了同步才）鏡像進私聊 + 自動加刪友播報
    const commitConversationSide = async (
        owner: CharacterProfile, partnerName: string, partnerCharId: string,
        detail: string, delta: number, partnerNote?: string, learnedNew?: string, seedIdentity?: string,
    ) => {
        const timestamp = Date.now();
        const result = {
            partnerName, partnerCharId, detail, delta, partnerNote, learnedNew, seedIdentity,
            timestamp, recordId: `rec-${timestamp}-${Math.random()}`,
        };
        const contact = owner.phoneState?.contacts?.find(c => c.linkedCharId === partnerCharId || normName(c.name) === normName(partnerName));
        const existing = owner.phoneState?.records?.find(r => r.type === 'chat'
            && ((contact && r.contactId === contact.id) || (!r.contactId && normName(r.title) === normName(partnerName))));
        const ownerSendToChat = owner.phoneState?.sendToChat !== false;
        let msgId: number | undefined;
        if (ownerSendToChat) {
            // 續寫時先刪掉這段對話上一張卡，私聊裡只留一張最新完整的（不再 AB / ABC 堆疊）
            if (existing?.systemMessageId) await DB.deleteMessage(existing.systemMessageId);
            msgId = await DB.saveMessage({
                charId: owner.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的聊天軟件] 你和「${partnerName}」的對話：${detail.replace(/\n/g, ' ')}`,
                metadata: { phoneCard: { app: '聊天軟件', kind: 'chat', title: partnerName, detail } },
            } as any);
        }
        // 自動加刪友播報：進機主與用戶的私聊（同樣受 sendToChat 控制）
        const { broadcast } = applyRealConversationToPhoneState(owner.phoneState, result);
        if (broadcast && ownerSendToChat) {
            await DB.saveMessage({ charId: owner.id, role: 'assistant', type: 'text', content: broadcast } as any);
        }
        updateCharacter(owner.id, (cur) => ({
            phoneState: applyRealConversationToPhoneState(cur.phoneState, { ...result, systemMessageId: msgId }).phoneState,
        }));
    };

    // 聊滿 100 條觸發總結：把待歸檔的每 100 條原文，A/B 各自第一人稱濃縮成一條話題盒記憶，推進水位線。
    // 原文仍留在 record.detail（用戶能看），只是不再進上下文。
    const ARCHIVE_EVERY = 100;
    const maybeArchiveConversation = async (aContact: PhoneContact, b: CharacterProfile, aFull: string) => {
        if (!targetChar) return;
        const aLines = parseTranscript(aFull);
        const startMark = aContact.archivedThru ?? 0;
        let mark = startMark;
        const aTopics: ConvTopic[] = [];
        const bTopics: ConvTopic[] = [];
        while (aLines.length - mark >= ARCHIVE_EVERY) {
            const aChunk = serializeTurns(aLines.slice(mark, mark + ARCHIVE_EVERY));
            const bChunk = flipTranscript(aChunk);
            const [aSum, bSum] = await Promise.all([
                summarizeConversation({ api: effectiveApiConfig as any, speakerName: targetChar.name, otherName: b.name, transcript: aChunk }),
                summarizeConversation({ api: effectiveApiConfig as any, speakerName: b.name, otherName: targetChar.name, transcript: bChunk }),
            ]);
            const ts = Date.now();
            const mk = () => `tp-${ts}-${Math.random().toString(36).slice(2, 7)}`;
            if (aSum) aTopics.push({ id: mk(), text: aSum, createdAt: ts, span: ARCHIVE_EVERY });
            if (bSum) bTopics.push({ id: mk(), text: bSum, createdAt: ts, span: ARCHIVE_EVERY });
            mark += ARCHIVE_EVERY;
        }
        if (mark === startMark) return; // 沒滿 100，不歸檔
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => c.id === aContact.id
                    ? { ...c, topicBox: [...(c.topicBox || []), ...aTopics], archivedThru: mark } : c),
            },
        }));
        updateCharacter(b.id, (cur) => ({
            phoneState: {
                ...cur.phoneState, records: cur.phoneState?.records || [],
                contacts: (cur.phoneState?.contacts || []).map(c => (c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name))
                    ? { ...c, topicBox: [...(c.topicBox || []), ...bTopics], archivedThru: mark } : c),
            },
        }));
        addToast(`已把更早的 ${mark} 條聊天歸檔成話題記憶`, 'info');
    };

    // P1：真角色雙向對話（A 發 B 回，雙 LLM，鏡像到 B）
    const handleRealConversation = async (contact: PhoneContact) => {
        if (!targetChar || !effectiveApiConfig.apiKey) { addToast('請先配置 API', 'error'); return; }
        const b = characters.find(c => c.id === contact.linkedCharId);
        if (!b) { addToast('該聯繫人未綁定真實角色', 'error'); return; }
        setIsLoading(true);
        trackEvent('生成一段与联系人的对话', { contactKind: 'real' });
        try {
            const existing = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === contact.id || normName(r.title) === normName(contact.name)));
            const bToA = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
            // 上下文壓縮：歸檔過的原文(0~archivedThru)不再進上下文，只喂「話題盒總結 + 近段原文」。
            const aAllLines = parseTranscript(existing?.detail || '');
            const aArchived = Math.min(contact.archivedThru ?? 0, aAllLines.length);
            const archivedALines = aAllLines.slice(0, aArchived);            // 留著給用戶看的原文
            const recentDetail = serializeTurns(aAllLines.slice(aArchived));  // 喂上下文的近段
            const result = await runRealConversation({
                a: targetChar, b, user: checkPhoneUserProfile, api: effectiveApiConfig as any,
                affinityA: contact.affinity, affinityB: bToA?.affinity ?? 0,
                existingDetail: recentDetail,
                // bNote = A 對 B 的備註（餵給 A）；aNote = B 對 A 的備註（餵給 B）。別接反。
                aNote: bToA?.note, bNote: contact.note,
                bLearned: contact.learned, aLearned: bToA?.learned,
                aSummary: topicText(contact.topicBox), bSummary: topicText(bToA?.topicBox),
            });
            if (!result.aDetail.trim()) { addToast('對方沒有回應…', 'error'); return; }
            // 把歸檔段拼回去，存「完整原文」給用戶看（上下文用的是壓縮版，互不影響）
            const aFull = serializeTurns([...archivedALines, ...parseTranscript(result.aDetail)]);
            const bFull = flipTranscript(aFull);
            // A 學到的寫進 A 對 B 的瞭解；B 學到的寫進 B 對 A 的瞭解。
            // 若對方通訊錄裡還沒有自己，commitConversationSide 會先建好聯繫人（帶名字+起始備註名）再掛消息。
            await commitConversationSide(targetChar, contact.name, b.id, aFull, result.aDelta, contact.note, result.aLearnedNew, contact.identity);
            await commitConversationSide(b, targetChar.name, targetChar.id, bFull, result.bDelta, bToA?.note, result.bLearnedNew, contact.identity);
            // 聊滿 100 條 → 各自第一人稱總結歸檔進話題盒
            await maybeArchiveConversation(contact, b, aFull);
            addToast(`${targetChar.name} 和 ${b.name} 聊了一會兒`, 'success');
        } catch (e) {
            console.error(e);
            addToast('真實對話生成失敗', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 與虛構 NPC 的對話（機主腦補，單 LLM，純虛構、不鏡像）
    const handleNpcConversation = async (contact: PhoneContact) => {
        if (!targetChar) return;
        // 綁定了「神經鏈接 → NPC」分頁裡某個 NPC 的聯繫人：優先用這個 NPC 自己配的專屬 API
        // （神經鏈接 NPC 編輯頁「AI 模型」選了「自定義」才會有），沒配就跟查手機共用設定一樣。
        const linkedNpc = contact.linkedNpcId ? npcs.find(n => n.id === contact.linkedNpcId) : undefined;
        const npcEffectiveApi = linkedNpc?.chatApi?.baseUrl ? linkedNpc.chatApi : effectiveApiConfig;
        if (!npcEffectiveApi.apiKey) { addToast('請先配置 API', 'error'); return; }
        setIsLoading(true);
        trackEvent('生成一段与联系人的对话', { contactKind: 'npc' });
        try {
            const existing = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === contact.id || normName(r.title) === normName(contact.name)));
            // 把 NPC 的人設描述和跟這個角色/用戶的關係折進 note 一起餵給引擎，讓腦補出來的對話
            // 有據可依，不再是純憑一個名字瞎編。不改 contact.note 本身——那是用戶自己寫的備註，
            // 落庫前保持原樣。
            const npcRelationshipNote = linkedNpc?.relationships
                .filter(r => r.targetId === targetChar.id || r.targetId === 'user')
                .map(r => r.targetId === targetChar.id ? `對「${targetChar.name}」：${r.description}` : `對用戶：${r.description}`)
                .join('\n');
            const npcGrounding = linkedNpc ? [linkedNpc.description?.trim(), npcRelationshipNote].filter(Boolean).join('\n') : '';
            const effectiveNote = [npcGrounding, contact.note].filter(Boolean).join('\n\n') || undefined;
            const { detail, learnedNew } = await runNpcConversation({
                host: targetChar, user: checkPhoneUserProfile, api: npcEffectiveApi as any,
                npcName: contact.name, identity: contact.identity, note: effectiveNote,
                learned: contact.learned, rounds: 4, existingDetail: existing?.detail,
            });
            if (!detail.trim()) { addToast('對方沒有回應', 'error'); return; }
            const now = Date.now();
            // 同步到私聊：和真人對話一致，落一張 phone_card（受 sendToChat 控制）。
            // 續寫時先刪掉上一張卡片再發新的，避免同一段對話越堆越多。
            const pushToChat = targetChar.phoneState?.sendToChat !== false;
            let msgId: number | undefined;
            if (pushToChat) {
                if (existing?.systemMessageId) await DB.deleteMessage(existing.systemMessageId);
                msgId = await DB.saveMessage({
                    charId: targetChar.id, role: 'assistant', type: 'phone_card',
                    content: `[你手機的聊天軟件] 你和「${contact.name}」的對話：${detail.replace(/\n/g, ' ')}`,
                    metadata: { phoneCard: { app: '聊天軟件', kind: 'chat', title: contact.name, detail } },
                } as any);
            }
            updateCharacter(targetChar.id, (cur) => {
                const recs = cur.phoneState?.records || [];
                const next = existing
                    ? recs.map(r => r.id === existing.id ? { ...r, detail, timestamp: now, systemMessageId: msgId ?? r.systemMessageId } : r)
                    : [...recs, { id: `rec-${now}-${Math.random()}`, type: 'chat', title: contact.name, detail, timestamp: now, contactId: contact.id, systemMessageId: msgId }];
                // 把這次腦補出來的新設定累積進該 NPC 的「瞭解」，保持下次一致
                const contactsNext = learnedNew
                    ? (cur.phoneState?.contacts || []).map(c => c.id === contact.id ? { ...c, learned: appendLearned(c.learned, learnedNew) } : c)
                    : cur.phoneState?.contacts;
                return { phoneState: { ...cur.phoneState, records: next, ...(contactsNext ? { contacts: contactsNext } : {}) } };
            });
            addToast(pushToChat ? '偷看到一段對話 · 已同步私聊' : '偷看到一段對話', 'success');
        } catch (e) {
            console.error(e);
            addToast('對話生成失敗', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    // 清空某聯繫人的這段對話（生成錯位/不滿意時一鍵抹掉重來）。
    // 真人聯繫人連對方手機裡的鏡像記錄一起清，保持兩邊一致。
    const handleClearContactConversation = async (contact: PhoneContact, silent = false) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        // 機主側：刪聊天記錄 + 清這段對話派生的話題盒記憶/水位線（刪了重來＝乾淨起點）
        const myRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, contact.id, contact.name));
        if (myRec?.systemMessageId) await DB.deleteMessage(myRec.systemMessageId);
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, contact.id, contact.name)),
                contacts: (cur.phoneState?.contacts || []).map(c => c.id === contact.id ? { ...c, topicBox: [], archivedThru: 0 } : c),
            },
        }));
        // 對方側鏡像（真人）：同樣清記錄 + 話題盒/水位線
        if (contact.kind === 'real' && contact.linkedCharId) {
            const b = characters.find(c => c.id === contact.linkedCharId);
            if (b) {
                const bContact = (b.phoneState?.contacts || []).find(c => c.linkedCharId === targetChar.id || normName(c.name) === normName(targetChar.name));
                const bRec = (b.phoneState?.records || []).find(r => isChatWith(r, bContact?.id, targetChar.name));
                if (bRec?.systemMessageId) await DB.deleteMessage(bRec.systemMessageId);
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                        contacts: (cur.phoneState?.contacts || []).map(c => (bContact && c.id === bContact.id) ? { ...c, topicBox: [], archivedThru: 0 } : c),
                    },
                }));
            }
        }
        if (!silent) addToast('已清空這段對話', 'success');
    };

    // 把「編輯後的 A 視角腳本」落庫：刷新機主側記錄/卡片 + 真人鏡像 + 同步 archivedThru；全刪空則移除記錄。
    const saveEditedConversation = async (c: PhoneContact, newDetail: string, newArchived: number) => {
        if (!targetChar) return;
        const isChatWith = (r: PhoneEvidence, cId: string | undefined, nm: string) =>
            r.type === 'chat' && (r.contactId === cId || normName(r.title) === normName(nm));
        const has = !!newDetail.trim();
        // 機主側卡片刷新
        const ownerRec = (targetChar.phoneState?.records || []).find(r => isChatWith(r, c.id, c.name));
        if (ownerRec?.systemMessageId) await DB.deleteMessage(ownerRec.systemMessageId);
        let msgId: number | undefined;
        if (has && targetChar.phoneState?.sendToChat !== false) {
            msgId = await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'phone_card',
                content: `[你手機的聊天軟件] 你和「${c.name}」的對話：${newDetail.replace(/\n/g, ' ')}`,
                metadata: { phoneCard: { app: '聊天軟件', kind: 'chat', title: c.name, detail: newDetail } },
            } as any);
        }
        updateCharacter(targetChar.id, (cur) => ({
            phoneState: {
                ...cur.phoneState,
                records: has
                    ? (cur.phoneState?.records || []).map(r => isChatWith(r, c.id, c.name) ? { ...r, detail: newDetail, timestamp: Date.now(), systemMessageId: msgId } : r)
                    : (cur.phoneState?.records || []).filter(r => !isChatWith(r, c.id, c.name)),
                contacts: (cur.phoneState?.contacts || []).map(x => x.id === c.id ? { ...x, archivedThru: newArchived } : x),
            },
        }));
        // 真人鏡像
        if (c.kind === 'real' && c.linkedCharId) {
            const b = characters.find(x => x.id === c.linkedCharId);
            if (b) {
                const bDetail = flipTranscript(newDetail);
                const bHas = !!bDetail.trim();
                const bContact = (b.phoneState?.contacts || []).find(x => x.linkedCharId === targetChar.id || normName(x.name) === normName(targetChar.name));
                const bRec = (b.phoneState?.records || []).find(r => isChatWith(r, bContact?.id, targetChar.name));
                if (bRec?.systemMessageId) await DB.deleteMessage(bRec.systemMessageId);
                let bMsgId: number | undefined;
                if (bHas && b.phoneState?.sendToChat !== false) {
                    bMsgId = await DB.saveMessage({
                        charId: b.id, role: 'assistant', type: 'phone_card',
                        content: `[你手機的聊天軟件] 你和「${targetChar.name}」的對話：${bDetail.replace(/\n/g, ' ')}`,
                        metadata: { phoneCard: { app: '聊天軟件', kind: 'chat', title: targetChar.name, detail: bDetail } },
                    } as any);
                }
                updateCharacter(b.id, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: bHas
                            ? (cur.phoneState?.records || []).map(r => isChatWith(r, bContact?.id, targetChar.name) ? { ...r, detail: bDetail, timestamp: Date.now(), systemMessageId: bMsgId } : r)
                            : (cur.phoneState?.records || []).filter(r => !isChatWith(r, bContact?.id, targetChar.name)),
                        contacts: (cur.phoneState?.contacts || []).map(x => (bContact && x.id === bContact.id) ? { ...x, archivedThru: newArchived } : x),
                    },
                }));
            }
        }
    };

    const exitMsgSelect = () => { setMsgSelectMode(false); setSelectedMsgIdx([]); };
    // 刪掉聊天裡選中的幾條氣泡（按完整腳本的下標），重排回腳本落庫
    const handleDeleteSelectedMessages = async () => {
        if (!targetChar || !selectedContact || !selectedMsgIdx.length) { exitMsgSelect(); return; }
        const c = selectedContact;
        const rec = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        if (!rec) { exitMsgSelect(); return; }
        const turns = parseTranscript(rec.detail);
        const sel = new Set(selectedMsgIdx);
        const deletedInArchived = [...sel].filter(i => i < (c.archivedThru ?? 0)).length;
        const keep = turns.filter((_, i) => !sel.has(i));
        const newDetail = serializeTurns(keep);
        const newArchived = Math.max(0, (c.archivedThru ?? 0) - deletedInArchived);
        await saveEditedConversation(c, newDetail, newArchived);
        addToast(`已刪除 ${sel.size} 條`, 'success');
        exitMsgSelect();
    };

    // 改聊天記錄裡的某一條內容（按完整腳本下標定位，說話人不變，只換文字），重排回腳本落庫
    const handleUpdateMessage = async () => {
        if (!targetChar || !selectedContact || !msgEdit) return;
        const c = selectedContact;
        const rec = (targetChar.phoneState?.records || []).find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        if (!rec) { setMsgEdit(null); return; }
        const turns = parseTranscript(rec.detail);
        if (!turns[msgEdit.index]) { setMsgEdit(null); return; }
        const trimmed = msgEdit.text.trim();
        if (!trimmed) { addToast('內容不能為空，刪除請用「刪除選中」', 'error'); return; }
        turns[msgEdit.index] = { ...turns[msgEdit.index], text: trimmed };
        await saveEditedConversation(c, serializeTurns(turns), c.archivedThru ?? 0);
        setMsgEdit(null);
        exitMsgSelect();
        addToast('消息已更新', 'success');
        trackEvent('编辑联系人聊天记录');
    };

    // ----- 人格模擬：後台生成（生成期間用戶可離開本 App 去別處逛） -----
    const runSim = async (m: 'daily' | 'event', t: string, presence: 'default' | 'light' | 'none' = 'default', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute' = 'mix') => {
        if (!targetChar) return;
        if (!effectiveApiConfig.apiKey) { addToast('請先配置 API', 'error'); return; }
        const cid = targetChar.id, cname = targetChar.name;
        personaSimStore.set({ status: 'loading', mode: m, theme: t, charId: cid, charName: cname });
        // 只報模式（日常/事件）這個固定枚舉；主題 t 是用戶自己寫的文本，不上報
        trackEvent('生成人格模拟演出', { mode: m });
        try {
            const generated = await generatePersonaScript({
                char: targetChar, userProfile: checkPhoneUserProfile, apiConfig: effectiveApiConfig as any, mode: m, theme: t, userPresence: presence, tone,
            });
            personaSimStore.set({ status: 'ready', mode: m, theme: t, script: generated, charId: cid, charName: cname });
            addToast('演出已就緒', 'success');
        } catch (e) {
            console.error(e);
            personaSimStore.set({ status: 'error', mode: m, theme: t, charId: cid, charName: cname });
            addToast('演出生成失敗，請重試', 'error');
        }
    };

    const requestDeleteSimLog = (log: PhoneSimLog) => {
        if (!targetChar) return;
        const charId = targetChar.id;
        askConfirm({
            title: `刪除生活記錄「${log.title}」？`,
            desc: '這條記錄和用於重播的演出腳本會一併刪除，無法撤銷。已經發送給 TA 的回憶不會被撤回。',
            confirmLabel: '刪除',
            danger: true,
            onConfirm: () => {
                updateCharacter(charId, (cur) => ({
                    phoneState: {
                        ...cur.phoneState,
                        records: cur.phoneState?.records || [],
                        simLogs: (cur.phoneState?.simLogs || []).filter(item => item.id !== log.id),
                    },
                }));
                addToast('已刪除生活記錄', 'success');
            },
        });
    };

    // 全局指示條點擊後請求深鏈：直接進入對應角色的演出
    useEffect(() => {
        if (sim.deepLink && sim.charId) {
            const c = characters.find(x => x.id === sim.charId);
            if (c) {
                setTargetChar(c);
                setView('phone');
                setActiveAppId('persona');
            }
            personaSimStore.clearDeepLink();
        }
    }, [sim.deepLink, sim.charId, characters]);

    // ============================================================
    //  DERIVED STATS  (drive the "living" home screen)
    // ============================================================
    const charName = targetChar?.name || 'Unknown Device';
    const allSorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
    const chatRecords = records.filter(r => r.type === 'chat');
    const orderRecords = records.filter(r => r.type === 'order');
    const deliveryRecords = records.filter(r => r.type === 'delivery');
    const socialRecords = records.filter(r => r.type === 'social');
    const simLogCount = targetChar?.phoneState?.simLogs?.length || 0;
    const sendToChat = targetChar?.phoneState?.sendToChat !== false; // 默認開
    const lastInner = targetChar ? getLastInnerState(targetChar.id) : '';
    const lastTs = allSorted[0]?.timestamp;

    const appLabel = (type: string): string => {
        switch (type) {
            case 'chat': return '聊天';
            case 'order': return '淘寶';
            case 'delivery': return '外賣';
            case 'social': return '朋友圈';
            case 'call': return '通話';
            default: return customApps.find(a => a.id === type)?.name || 'App';
        }
    };

    const syncEvidenceRecordToChat = async (record: PhoneEvidence) => {
        if (!targetChar) return;
        try {
            if (record.systemMessageId) {
                const existing = await DB.getMessageById(record.systemMessageId);
                if (existing) {
                    addToast('這條記錄已經同步到私聊', 'info');
                    setEvidenceMenu(null);
                    return;
                }
            }
            const app = record.type === 'chat' ? '聊天軟件' : appLabel(record.type);
            const card = buildPhoneEvidenceChatCard(record, app);
            const messageId = await DB.saveMessage({
                charId: targetChar.id,
                role: 'assistant',
                type: 'phone_card',
                content: card.content,
                metadata: card.metadata,
            } as any);
            updateCharacter(targetChar.id, (current) => ({
                phoneState: {
                    ...current.phoneState,
                    records: (current.phoneState?.records || []).map(item => item.id === record.id
                        ? { ...item, systemMessageId: messageId }
                        : item),
                },
            }));
            if (selectedEvidenceRecord?.id === record.id) {
                setSelectedEvidenceRecord({ ...selectedEvidenceRecord, systemMessageId: messageId });
            }
            if (selectedChatRecord?.id === record.id) {
                setSelectedChatRecord({ ...selectedChatRecord, systemMessageId: messageId });
            }
            setEvidenceMenu(null);
            addToast('已把這條查手機記錄同步到私聊', 'success');
            trackEvent('事后同步查手机记录到私聊', { kind: record.type });
        } catch (error: any) {
            addToast(error?.message || '同步失敗，請重試', 'error');
        }
    };

    const fmtClock = (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const lastSeenText = (() => {
        if (!lastTs) return 'Awaiting first sync';
        const d = Date.now() - lastTs;
        const days = Math.floor(d / 86400000);
        const hrs = Math.floor(d / 3600000);
        const mins = Math.floor(d / 60000);
        if (days > 0) return `Last seen ${days}d ago`;
        if (hrs > 0) return `Last seen ${hrs}h ago`;
        if (mins > 0) return `Last seen ${mins}m ago`;
        return 'Online now';
    })();

    const foodSub = deliveryRecords.length
        ? (() => {
            const t = Math.max(...deliveryRecords.map(r => r.timestamp));
            const days = Math.floor((Date.now() - t) / 86400000);
            return days <= 0 ? 'ordered today' : `last order ${days}d ago`;
        })()
        : 'no orders yet';

    const momentsSub = socialRecords.length ? `${socialRecords.length} new posts` : 'nothing shared';
    const taobaoSub = orderRecords.length ? `${orderRecords.length} items in cart` : 'cart is empty';
    // 「聯繫人」主卡副標題：TA 通訊錄裡的人數（不含用戶自己）
    const contactCount = contacts.filter(c => !isUserName(c.name)).length;
    const contactsSub = contactCount ? `${contactCount} 位聯繫人` : 'tap to scan';
    const aiSub = aiSessions.length ? `${aiSessions.length} 段對話 · TA 的小手機` : 'tap to peek';
    const realBalanceSub = `¥${realBalanceState.balance.toFixed(2)} · ${realBalanceState.cards.length} 張銀行卡`;

    // pseudo screen-time + weather (decorative, deterministic per char)
    const seed = charName.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const temp = 16 + (seed % 14);
    const screenMin = 64 + records.length * 11 + (seed % 40);
    const stH = Math.floor(screenMin / 60);
    const stM = screenMin % 60;
    const ringP = Math.min(0.94, screenMin / 360);
    const RING_C = 2 * Math.PI * 42;

    const activity = (() => {
        const items = allSorted.slice(0, 4).reverse().map(r => ({ t: r.timestamp, label: `打開${appLabel(r.type)}` }));
        if (lastTs) items.push({ t: Date.now(), label: '鎖屏' });
        return items;
    })();

    const now = new Date();
    const clockNow = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateNow = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const fallbackQuote = targetChar?.socialProfile?.bio || '“有些話，隔著屏幕，反而更接近真實。”';
    const innerQuote = lastInner.trim();

    // ============================================================
    //  SUB-APPS
    // ============================================================
    // 找出某條聊天記錄對應的聯繫人（用於複用真人頭像）
    const contactOfRecord = (r: PhoneEvidence): PhoneContact | undefined =>
        contacts.find(c => (r.contactId && c.id === r.contactId) || normName(c.name) === normName(r.title));

    const renderChatList = () => {
        const accent = '#8b9cff';
        const list = records.filter(r => r.type === 'chat').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Messages" sub="已歸檔 · 只讀" accent={accent} onBack={() => setActiveAppId('home')}
                    right={list.length > 0 ? (
                        <button onClick={() => askConfirm({
                            title: '清空全部聊天記錄？', desc: `將刪除這台手機裡歸檔的全部 ${list.length} 段聊天記錄，且無法恢復。`,
                            confirmLabel: '清空', danger: true, onConfirm: handleClearAllChats,
                        })} className="text-rose-300/80 active:scale-90 transition"><Trash size={18} weight="bold" /></button>
                    ) : undefined} />
                {/* 歸檔說明：舊的 Messages 模式已不再更新，新的對話走「人際關係」 */}
                <div className="px-4 pt-1 pb-2 shrink-0">
                    <div className="rounded-xl px-3 py-2 bg-white/[0.04] border border-white/[0.07] text-[11px] text-white/55 leading-relaxed">
                        這是舊版聊天歸檔，已停止更新。新的來往請在「聯繫人」裡發起；可把某段記錄綁定過去。
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="歸檔裡沒有聊天記錄" />}
                    {list.map(r => {
                        const segs = parseTranscript(r.detail);
                        const last = segs.length ? segs[segs.length - 1].text : '...';
                        const av = contactOfRecord(r) ? contactAvatar(contactOfRecord(r)!) : undefined;
                        return (
                            <div key={r.id} {...longPress(() => setEvidenceMenu({ record: r, backAppId: 'chat' }))}
                                onClick={() => {
                                    if (lpFired.current) { lpFired.current = false; return; }
                                    setSelectedChatRecord(r); setTranscriptExpanded(false); setActiveAppId('chat_detail');
                                }}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] active:scale-[0.99] transition cursor-pointer animate-fade-in">
                                {av ? (
                                    <TokenImg value={av} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                        {r.title[0]}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-baseline gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{r.title}</span>
                                        <span className="text-[10px] text-white/35 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                    </div>
                                    <div className="text-[11.5px] text-white/45 truncate mt-0.5">{last}</div>
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); askConfirm({
                                    title: '刪除這段聊天記錄？', desc: `「${r.title}」的這段歸檔記錄將被刪除。`,
                                    confirmLabel: '刪除', danger: true, onConfirm: () => handleDeleteRecord(r),
                                }); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </div>
                        );
                    })}
                </div>
            </SubAppShell>
        );
    };

    const renderChatDetail = () => {
        if (!selectedChatRecord || !targetChar) return null;
        const accent = '#8b9cff';
        // 帶前綴繼承的解析：多行消息(連發幾條)的續行跟隨上一條說話人，不再錯位給對方。
        const parsedLines = parseTranscript(selectedChatRecord.detail).map(t => ({ isMe: t.isMe, content: t.text }));
        // 渲染保護：長 transcript 默認只渲染最新 50 行，避免一次性塞太多氣泡把頁面卡爆（同 chatapp）
        const RENDER_CAP = 50;
        const hiddenCount = transcriptExpanded ? 0 : Math.max(0, parsedLines.length - RENDER_CAP);
        const shownLines = hiddenCount > 0 ? parsedLines.slice(-RENDER_CAP) : parsedLines;
        const contact = contactOfRecord(selectedChatRecord);
        const partnerAvatar = contact ? contactAvatar(contact) : undefined;
        const linkedReal = contact && contact.kind === 'real' && !!contact.linkedCharId;

        return (
            <SubAppShell>
                <TermHeader title={selectedChatRecord.title} sub="歸檔 · 只讀" accent={accent} onBack={() => setActiveAppId('chat')} />
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {hiddenCount > 0 && (
                        <button onClick={() => setTranscriptExpanded(true)}
                            className="w-full py-2 mb-1 rounded-xl text-[11.5px] font-semibold text-white/55 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                            ▲ 展開更早的 {hiddenCount} 條消息
                        </button>
                    )}
                    {shownLines.map((msg, idx) => (
                        <div key={idx} className={`flex items-end gap-2 ${msg.isMe ? 'justify-end' : 'justify-start'}`}>
                            {!msg.isMe && (
                                partnerAvatar ? (
                                    <TokenImg value={partnerAvatar} alt="" className="w-8 h-8 rounded-xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-8 h-8 rounded-xl flex items-center justify-center text-xs text-white shrink-0"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>
                                        {selectedChatRecord.title[0]}
                                    </div>
                                )
                            )}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[74%] text-[13px] leading-relaxed break-words ${
                                msg.isMe
                                    ? 'text-white rounded-br-md'
                                    : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'
                                }`}
                                style={msg.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>
                                {msg.content}
                            </div>
                            {msg.isMe && <TokenImg value={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                        </div>
                    ))}
                    <div ref={chatEndRef} />
                </div>
                {/* 歸檔只讀：不再生成後續；改為「綁定到人際關係」（真人會雙向同步） */}
                <div className="shrink-0 w-full p-4 pb-6">
                    <button onClick={() => askConfirm({
                        title: '綁定到聯繫人？',
                        desc: linkedReal
                            ? `已與神經鏈接裡的「${selectedChatRecord.title}」匹配，綁定後這段對話會同步到對方手機。`
                            : `將把「${selectedChatRecord.title}」加進聯繫人（未匹配到真實角色，按虛構聯繫人處理）。`,
                        confirmLabel: '綁定',
                        onConfirm: () => handleBindRecordToRelationship(selectedChatRecord),
                    })}
                        className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <LinkSimple size={16} weight="bold" /> 綁定到聯繫人
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderEvidenceDetail = () => {
        const r = selectedEvidenceRecord;
        if (!r) return null;

        const customApp = customApps.find(app => app.id === r.type);
        const layout = customApp?.layout || 'generic';
        const isCall = r.type === 'call';
        const isCommerce = r.type === 'order' || r.type === 'delivery' || layout === 'shop';
        const isSocial = r.type === 'social' || layout === 'feed';
        const isNovel = layout === 'novel';
        const accent = customApp?.color || (isCall ? '#4ade80' : r.type === 'order' ? '#ff7a45' : r.type === 'delivery' ? '#fbbf24' : isSocial ? '#c084fc' : '#8b9cff');
        const title = customApp?.name || appLabel(r.type);
        const dateText = new Date(r.timestamp).toLocaleString('zh-CN', {
            year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const isMissed = isCall && (r.value?.includes('未接') || r.value?.includes('Missed'));
        const isOutgoing = isCall && (r.value?.includes('呼出') || r.value?.includes('Outgoing'));
        const callDirection = isMissed ? '未接來電' : isOutgoing ? '呼出' : '呼入';
        const callDuration = r.value?.match(/\((.*?)\)/)?.[1] || (isMissed ? '—' : '未記錄');
        const detailIcon = customApp
            ? <span className="text-lg">{customApp.icon}</span>
            : isCall ? <Phone size={20} weight="fill" />
                : r.type === 'order' ? <ShoppingBag size={20} weight="fill" />
                    : r.type === 'delivery' ? <Hamburger size={20} weight="fill" />
                        : <ImagesSquare size={20} weight="fill" />;

        return (
            <SubAppShell>
                <TermHeader title={title} sub="record detail" accent={accent}
                    onBack={() => { setSelectedEvidenceRecord(null); setActiveAppId(evidenceBackAppId); }}
                    right={<span style={{ color: accent }}>{detailIcon}</span>} />
                <div className="flex-1 overflow-y-auto no-scrollbar overscroll-contain px-5 pt-3 pb-10">
                    {customApp?.htmlCardEnabled && r.html ? (
                        <div className="pb-6 border-b border-white/[0.07] flex justify-center">
                            <HtmlCard html={composeCustomAppCardHtml(customApp, r.html)} />
                        </div>
                    ) : isSocial ? (
                        <article>
                            <div className="flex items-center gap-3 pb-4 border-b border-white/[0.07]">
                                {targetChar?.avatar
                                    ? <TokenImg value={targetChar.avatar} alt="" className="w-12 h-12 rounded-full object-cover" />
                                    : <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-semibold" style={{ background: accent }}>{charName.slice(0, 1)}</div>}
                                <div className="min-w-0">
                                    <div className="text-[15px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[11px] text-white/35 mt-0.5">{r.title || dateText}</div>
                                </div>
                            </div>
                            <div className="py-6 text-[15px] leading-8 text-white/85 whitespace-pre-wrap break-words">
                                {r.detail || '這條動態沒有文字內容。'}
                            </div>
                            <div className="flex items-center gap-7 py-3 border-y border-white/[0.07] text-white/45">
                                <span className="flex items-center gap-2 text-[12px]"><Heart size={16} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)} 個贊</span>
                                <span className="flex items-center gap-2 text-[12px]"><ChatCircle size={16} /> {1 + (r.id.length % 9)} 條互動</span>
                            </div>
                        </article>
                    ) : (
                        <article>
                            <div className="flex items-start gap-4 pb-6 border-b border-white/[0.07]">
                                <div className="w-16 h-16 rounded-2xl flex items-center justify-center shrink-0 text-2xl"
                                    style={{ color: accent, background: 'linear-gradient(135deg, ' + accent + '33, ' + accent + '0d)' }}>
                                    {customApp ? customApp.icon : isCall ? <Phone size={27} weight="fill" /> : <Package size={28} weight="light" />}
                                </div>
                                <div className="min-w-0 flex-1 pt-0.5">
                                    <div className="text-[18px] leading-7 font-semibold text-white/95 break-words" style={isNovel ? { fontFamily: "'Shippori Mincho','Noto Sans SC',serif" } : undefined}>{r.title}</div>
                                    <div className="text-[11px] text-white/35 mt-1.5">{isCall ? callDirection : isCommerce ? '訂單記錄' : isNovel ? '閱讀記錄' : '內容記錄'}</div>
                                    {r.value && <div className="text-[18px] font-bold mt-2" style={{ color: accent }}>{r.value}</div>}
                                </div>
                            </div>

                            <section className="py-6 border-b border-white/[0.07]">
                                <div className="text-[10px] tracking-[0.22em] uppercase mb-3" style={{ color: accent }}>
                                    {isCall ? '通話備註' : isCommerce ? '完整訂單信息' : isNovel ? '完整正文' : '完整內容'}
                                </div>
                                <div className="text-[14px] leading-7 text-white/75 whitespace-pre-wrap break-words" style={isNovel ? { fontFamily: "'Shippori Mincho','Noto Sans SC',serif" } : undefined}>
                                    {r.detail || '沒有留下更多內容。'}
                                </div>
                            </section>

                            {isCall && (
                                <div className="grid grid-cols-2 gap-6 py-5 border-b border-white/[0.07]">
                                    <div><div className="text-[10px] text-white/30">通話方向</div><div className="text-[14px] text-white/80 mt-1">{callDirection}</div></div>
                                    <div><div className="text-[10px] text-white/30">通話時長</div><div className="text-[14px] text-white/80 mt-1">{callDuration}</div></div>
                                </div>
                            )}
                            {isCommerce && (
                                <div className="py-5 border-b border-white/[0.07]">
                                    <div className="text-[10px] text-white/30 mb-3">訂單進度</div>
                                    <div className="flex items-center text-[11px] text-white/55">
                                        {['已下單', '處理中', includesAnyScript(r.detail ?? '', '簽收') || includesAnyScript(r.detail ?? '', '送達') ? '已完成' : '等待更新'].map((step, i) => (
                                            <React.Fragment key={step}>
                                                {i > 0 && <div className="h-px flex-1 mx-2" style={{ background: accent + '55' }} />}
                                                <span className="shrink-0" style={{ color: i === 0 ? accent : undefined }}>{step}</span>
                                            </React.Fragment>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </article>
                    )}

                    <dl className="py-5 space-y-3 text-[11px]">
                        <div className="flex justify-between gap-4"><dt className="text-white/30">記錄時間</dt><dd className="text-white/60 text-right">{dateText}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-white/30">來源 App</dt><dd className="text-white/60 text-right">{title}</dd></div>
                        <div className="flex justify-between gap-4"><dt className="text-white/30">記錄編號</dt><dd className="text-white/40 text-right font-mono">#{r.id.slice(-8).toUpperCase()}</dd></div>
                    </dl>

                    <button onClick={() => openEditRecord(r)}
                        className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold text-white/80 bg-white/[0.04] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <PencilSimple size={15} weight="bold" /> 編輯這條記錄
                    </button>
                    <button onClick={() => void syncEvidenceRecordToChat(r)} disabled={!!r.systemMessageId}
                        className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold text-sky-100 bg-sky-400/10 border border-sky-300/20 active:scale-[0.99] transition flex items-center justify-center gap-2 disabled:text-white/30 disabled:bg-white/[0.03] disabled:border-white/[0.06]">
                        <PaperPlaneTilt size={15} weight="bold" /> {r.systemMessageId ? '已同步到私聊' : '同步這條到私聊'}
                    </button>
                    <button onClick={() => askConfirm({
                        title: '刪除這條記錄？', desc: '刪除「' + r.title + '」後無法恢復。', confirmLabel: '刪除', danger: true,
                        onConfirm: () => handleDeleteRecord(r),
                    })} className="w-full mt-2 py-3 rounded-2xl text-[12px] font-semibold text-rose-200 bg-rose-400/10 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-2">
                        <Trash size={15} weight="bold" /> 刪除記錄
                    </button>
                </div>
            </SubAppShell>
        );
    };

    const renderCallList = () => {
        const accent = '#4ade80';
        const list = records.filter(r => r.type === 'call').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Recents" sub="call log" accent={accent} onBack={() => setActiveAppId('home')} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-2">
                    {list.length === 0 && <EmptyState text="暫無通話記錄" />}
                    {list.map(r => {
                        const isMissed = r.value?.includes('未接') || r.value?.includes('Missed');
                        const isOutgoing = r.value?.includes('呼出') || r.value?.includes('Outgoing');
                        const c = isMissed ? '#fb7185' : accent;
                        return (
                            <div key={r.id} {...evidenceEntryProps(r, 'call')}
                                className="group relative flex items-center gap-3.5 rounded-2xl p-3.5 pr-8 bg-white/[0.035] border border-white/[0.06] animate-fade-in cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `${c}1f`, color: c }}>
                                    <Phone size={19} weight="fill" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="font-semibold text-[13.5px] truncate" style={{ color: isMissed ? '#fb7185' : 'rgba(255,255,255,0.95)' }}>{r.title}</div>
                                    <div className="text-[10.5px] text-white/40 flex items-center gap-1.5 mt-0.5">
                                        <span>{isMissed ? '未接來電' : (isOutgoing ? '呼出' : '呼入')}</span>
                                        {r.value && !isMissed && <span>· {r.value.replace(/.*?\((.*?)\).*/, '$1')}</span>}
                                    </div>
                                    {r.detail && <div className="text-[10.5px] text-white/30 mt-1 italic truncate">“{r.detail}”</div>}
                                </div>
                                <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(r.timestamp)}</span>
                                <DelBtn onDelete={() => handleDeleteRecord(r)} />
                            </div>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerate('call')} label="刷新通話" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderShop = () => {
        const accent = '#ff7a45';
        const list = records.filter(r => r.type === 'order').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="淘寶" sub="my orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ShoppingBag size={20} weight="fill" style={{ color: accent }} />} />
                {/* banner */}
                <div className="px-4 pb-2 shrink-0">
                    <div className="rounded-2xl p-3.5 flex items-center gap-3 border border-white/[0.06] overflow-hidden relative"
                        style={{ background: `linear-gradient(120deg, ${accent}26, ${accent}08)` }}>
                        <Storefront size={26} weight="fill" style={{ color: accent }} />
                        <div className="min-w-0">
                            <div className="text-[13px] font-semibold text-white">{charName} 的購物車</div>
                            <div className="text-[10.5px] text-white/50">{list.length} 件商品 · 待付款 / 待收貨</div>
                        </div>
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="還沒有訂單" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'taobao')}
                            className="group relative flex gap-3 rounded-2xl p-3 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60">
                            <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center"
                                style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                <Package size={26} weight="light" style={{ color: accent }} />
                            </div>
                            <div className="flex-1 min-w-0 flex flex-col">
                                <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                                <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                                <div className="mt-auto flex items-center justify-between pt-1.5">
                                    <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '¥ --'}</span>
                                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider flex items-center gap-0.5">已下單 <CaretRight size={10} /></span>
                                </div>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('order')} label="刷新訂單" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderFood = () => {
        const accent = '#fbbf24';
        const list = records.filter(r => r.type === 'delivery').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="外賣" sub="recent orders" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<Hamburger size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="還沒有外賣記錄" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'waimai')}
                            className="group relative rounded-2xl p-3.5 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60">
                            <div className="flex items-center gap-3">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>
                                    <Storefront size={20} weight="fill" style={{ color: accent }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-[13.5px] font-semibold text-white/95 truncate">{r.title}</div>
                                    <div className="text-[10px] text-white/35 mt-0.5">{fmtClock(r.timestamp)} · 已送達</div>
                                </div>
                                {r.value && <span className="text-[14px] font-bold shrink-0" style={{ color: accent }}>{r.value}</span>}
                            </div>
                            <div className="text-[11.5px] text-white/50 mt-2.5 leading-relaxed pl-1 border-l-2" style={{ borderColor: `${accent}55` }}>
                                <span className="pl-2">{r.detail}</span>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('delivery')} label="刷新外賣" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderMoments = () => {
        const accent = '#c084fc';
        const list = records.filter(r => r.type === 'social').sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title="Moments" sub="朋友圈" accent={accent} onBack={() => setActiveAppId('home')}
                    right={<ImagesSquare size={20} weight="fill" style={{ color: accent }} />} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="還沒有動態" />}
                    {list.map(r => (
                        <div key={r.id} {...evidenceEntryProps(r, 'social')}
                            className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60">
                            <div className="flex items-center gap-3 mb-2.5">
                                {targetChar?.avatar
                                    ? <TokenImg value={targetChar.avatar} className="w-9 h-9 rounded-full object-cover" />
                                    : <div className="w-9 h-9 rounded-full" style={{ background: accent }} />}
                                <div className="min-w-0">
                                    <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                    <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                                </div>
                            </div>
                            <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                            <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                                <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                                <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                                <span className="ml-auto flex items-center gap-0.5 text-[10px]" style={{ color: accent }}>查看詳情 <CaretRight size={10} /></span>
                            </div>
                            <DelBtn onDelete={() => handleDeleteRecord(r)} />
                        </div>
                    ))}
                </div>
                <RefreshFab onClick={() => handleGenerate('social')} label="刷新動態" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  人際關係系統 · 視圖
    // ============================================================
    const affColor = (a: number) => a >= 40 ? '#4ade80' : a >= 0 ? '#8b9cff' : a >= -40 ? '#fbbf24' : '#fb7185';
    const kindBadge = (c: PhoneContact) => {
        if (c.kind === 'real') return { icon: <LinkSimple size={11} weight="bold" />, label: '真人', color: '#a78bfa' };
        return { icon: <User size={11} weight="fill" />, label: 'NPC', color: '#94a3b8' };
    };

    const renderContactsList = () => {
        const accent = '#f472b6';
        // 人際關係裡不出現用戶自己
        const list = contacts.filter(c => !isUserName(c.name)).sort((a, b) => (b.lastInteraction || b.createdAt) - (a.lastInteraction || a.createdAt));
        return (
            <SubAppShell>
                <TermHeader title={contactSelectMode ? `已選 ${selectedContactIds.length}` : '聯繫人'} sub={contactSelectMode ? '長按進入了多選' : `${list.length} contacts`} accent={accent}
                    onBack={() => { if (contactSelectMode) exitContactSelect(); else setActiveAppId('home'); }}
                    right={contactSelectMode
                        ? <button onClick={exitContactSelect} className="text-[12px] font-semibold text-white/80 active:scale-90 transition">取消</button>
                        : <button onClick={() => { setNcNpcMode(npcs.length > 0 ? 'existing' : 'random'); setShowContactModal(true); }} className="text-white/80 active:scale-90 transition"><UserPlus size={20} weight="bold" /></button>} />
                {/* 約束開關：是否允許虛構 NPC */}
                <div className="px-4 pt-1 pb-2 shrink-0">
                    <div className="w-full flex items-center gap-2 rounded-xl px-3 py-2 bg-white/[0.04] border border-white/[0.07]">
                        <button onClick={toggleAllowFictional} className="flex-1 min-w-0 text-left active:scale-[0.99] transition">
                            <span className="text-[11px] text-white/55">{allowFictional ? '允許 TA 結交虛構 NPC' : '只與神經鏈接裡的真實角色來往'}</span>
                        </button>
                        <button onClick={() => setShowFictionHelp(v => !v)} aria-label="說明"
                            className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 transition ${showFictionHelp ? 'text-white/80' : 'text-white/35 active:text-white/70'}`}>
                            <Question size={13} weight="bold" />
                        </button>
                        <button onClick={toggleAllowFictional} aria-label="切換" className="relative w-9 h-5 rounded-full transition shrink-0" style={{ background: allowFictional ? accent : 'rgba(255,255,255,0.15)' }}>
                            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: allowFictional ? '18px' : '2px' }} />
                        </button>
                    </div>
                    {showFictionHelp && (
                        <div className="mt-1.5 rounded-xl px-3 py-2.5 bg-white/[0.03] border border-white/[0.06] text-[10.5px] text-white/55 leading-relaxed space-y-1">
                            <p><span className="font-semibold text-white/75">開：</span>允許 TA 的通訊錄裡出現「按人設虛構的路人」（同事、網友、中間人之類，神經鏈接裡並不存在的人）。社交圈更豐滿。</p>
                            <p><span className="font-semibold text-white/75">關：</span>TA 只和神經鏈接裡<span className="text-white/75">真實存在的角色</span>來往；掃描/生成時會丟棄所有虛構聯繫人。</p>
                        </div>
                    )}
                    {/* 舊版 Message 聊天歸檔：廢棄 App，收在這裡做不起眼的入口 */}
                    <button onClick={openChat}
                        className="w-full flex items-center gap-2 mt-1.5 px-3 py-1.5 text-white/35 active:text-white/60 transition">
                        <ChatCircleDots size={13} weight="light" className="shrink-0" />
                        <span className="text-[10.5px] flex-1 text-left">舊版聊天歸檔{chatRecords.length ? ` · ${chatRecords.length}` : ''}</span>
                        <CaretRight size={11} weight="bold" className="shrink-0" />
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-2 space-y-2.5 no-scrollbar pb-28 overscroll-contain">
                    {list.length === 0 && <EmptyState text="還沒有聯繫人 · 掃描通訊錄看看" />}
                    {list.map(c => {
                        const badge = kindBadge(c);
                        const dimmed = c.status === 'deleted' || c.status === 'blocked';
                        const av = contactAvatar(c);
                        const selected = selectedContactIds.includes(c.id);
                        return (
                            <div key={c.id}
                                {...longPress(() => { setContactSelectMode(true); toggleContactSelect(c.id); })}
                                onClick={() => {
                                    if (lpFired.current) { lpFired.current = false; return; }
                                    if (contactSelectMode) { toggleContactSelect(c.id); return; }
                                    setSelectedContact(c); setIdentityDraft(c.identity || ''); setEditingIdentity(false); setNoteDraft(c.note || ''); setEditingNote(false); setConvExpanded(false); setAffinityDraft(null); setShowProfile(false); exitMsgSelect(); setActiveAppId('contact_detail');
                                    trackEvent('打开联系人对话详情', { contactKind: c.kind });
                                }}
                                className={`group relative flex items-center gap-3 rounded-2xl p-3.5 border active:scale-[0.99] transition cursor-pointer animate-fade-in select-none ${selected ? 'bg-pink-500/10 border-pink-400/40' : 'bg-white/[0.035] border-white/[0.06]'} ${dimmed && !selected ? 'opacity-45' : ''}`}>
                                {contactSelectMode && (
                                    <span className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 text-[11px] font-bold transition ${selected ? 'bg-pink-500 border-pink-500 text-white' : 'border-white/30 text-transparent'}`}>✓</span>
                                )}
                                {av ? (
                                    <TokenImg value={av} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
                                ) : (
                                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold text-lg"
                                        style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)`, boxShadow: `inset 0 0 18px ${accent}25` }}>
                                        {c.name[0]}
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold text-[13.5px] text-white/95 truncate">{contactDisplayName(c)}</span>
                                        <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full shrink-0" style={{ color: badge.color, background: `${badge.color}1f` }}>{badge.icon}{badge.label}</span>
                                        {c.status === 'deleted' && <span className="text-[9px] text-rose-300/80 shrink-0">已刪</span>}
                                        {c.status === 'blocked' && <span className="text-[9px] text-rose-300/80 shrink-0">已拉黑</span>}
                                    </div>
                                    <div className="text-[11px] text-white/40 truncate mt-0.5">{c.note || c.identity || '—'}</div>
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <div className="h-1 flex-1 rounded-full bg-white/[0.08] overflow-hidden">
                                            <div className="h-full rounded-full" style={{ width: `${(c.affinity + 100) / 2}%`, background: affColor(c.affinity) }} />
                                        </div>
                                        <span className="text-[9px] tabular-nums shrink-0" style={{ color: affColor(c.affinity) }}>{c.affinity > 0 ? '+' : ''}{c.affinity}</span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
                {contactSelectMode ? (
                    <div className="absolute bottom-7 inset-x-0 flex justify-center gap-2 px-6 z-30 pointer-events-none">
                        <button onClick={() => setSelectedContactIds(selectedContactIds.length === list.length ? [] : list.map(c => c.id))}
                            className="pointer-events-auto px-4 py-3 rounded-full text-[12px] font-semibold text-white/85 bg-white/[0.1] border border-white/15 backdrop-blur-xl active:scale-95 transition">
                            {selectedContactIds.length === list.length && list.length > 0 ? '取消全選' : '全選'}
                        </button>
                        <button disabled={!selectedContactIds.length}
                            onClick={() => askConfirm({
                                title: `清空選中的 ${selectedContactIds.length} 段對話？`,
                                desc: '只清掉這幾段聊天記錄（保留聯繫人；真人對方手機裡的鏡像、相關私聊卡片、話題盒記憶一併清），之後可重新生成。',
                                confirmLabel: '清空對話', danger: true, onConfirm: handleBatchClearConversations,
                            })}
                            className="pointer-events-auto px-6 py-3 rounded-full text-[12px] font-semibold text-white bg-rose-500 disabled:opacity-40 active:scale-95 transition flex items-center gap-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
                            <ChatCircle size={14} weight="bold" /> 清空對話 {selectedContactIds.length || ''}
                        </button>
                    </div>
                ) : (
                    <RefreshFab onClick={() => handleGenerate('contacts')} label="掃描通訊錄" accent={accent} loading={isLoading} />
                )}
            </SubAppShell>
        );
    };

    // ============================================================
    //  智能體 App · Render（首頁：服務 tab + 會話列表；詳情：transcript + 互動）
    // ============================================================
    const renderAiAgent = () => {
        const svc = AI_SERVICES.find(s => s.id === aiService)!;
        const list = aiSessions.filter(s => s.service === aiService).sort((a, b) => b.updatedAt - a.updatedAt);
        return (
            <SubAppShell>
                <TermHeader title="智能體" sub="TA 的小手機" accent={svc.accent} onBack={() => setActiveAppId('home')}
                    right={<Robot size={20} weight="fill" style={{ color: svc.accent }} />} />
                {/* 服務 tab */}
                <div className="px-4 pb-2 shrink-0 flex gap-2">
                    {AI_SERVICES.map(s => {
                        const active = s.id === aiService;
                        const Icon = s.id === 'assistant' ? Robot : s.id === 'claude' ? Brain : MaskHappy;
                        return (
                            <button key={s.id} onClick={() => { setAiService(s.id); trackEvent('切换智能体服务分类', { service: s.id }); }}
                                className={`flex-1 rounded-2xl px-2 py-2.5 border transition active:scale-[0.97] ${active ? 'text-white' : 'border-white/[0.07] bg-white/[0.03] text-white/55'}`}
                                style={active ? { background: `linear-gradient(135deg, ${s.accent}33, ${s.accent}0d)`, borderColor: `${s.accent}66` } : undefined}>
                                <Icon size={18} weight={active ? 'fill' : 'light'} style={{ color: active ? s.accent : undefined }} className="mx-auto" />
                                <div className="text-[10.5px] font-semibold mt-1">{s.name}</div>
                            </button>
                        );
                    })}
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-1 no-scrollbar pb-28 overscroll-contain space-y-2.5">
                    <div className="text-[11px] text-white/45 px-1 pb-0.5">{svc.tagline}</div>
                    {/* 酒館角色卡櫥窗（點擊看 TA 玩這張 / 長按編輯刪除 / ＋自己加一張） */}
                    {aiService === 'tavern' && (
                        <div className="flex gap-2.5 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
                            {aiCards.map(c => (
                                <div key={c.id} {...longPress(() => setAiMenu({ kind: 'card', id: c.id }))}
                                    onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setAiCardView(c.id); }}
                                    className="shrink-0 w-36 rounded-2xl p-3 border border-white/[0.07] bg-white/[0.035] cursor-pointer active:scale-[0.98] transition select-none">
                                    <div className="flex items-center justify-between">
                                        <div className="text-2xl">{c.emoji}</div>
                                        <span className="text-[8px] px-1.5 py-0.5 rounded-full bg-rose-400/20 text-rose-200/90">{c.kind === 'world' ? '世界卡' : '角色卡'}</span>
                                    </div>
                                    <div className="text-[12.5px] font-semibold text-white mt-1.5 truncate">{c.name}</div>
                                    {c.basedOnUser ? <div className="text-[9px] text-rose-300/90 mt-0.5">⚑ 照著你捏的</div>
                                        : c.basedOn ? <div className="text-[9px] text-rose-300/90 mt-0.5 truncate">⚑ 照著「{c.basedOn}」</div> : null}
                                    <div className="text-[10px] text-white/45 mt-1 line-clamp-2 leading-snug">{c.persona}</div>
                                    {c.scenario && <div className="text-[9.5px] text-white/35 mt-1 line-clamp-2 italic leading-snug">場景：{c.scenario}</div>}
                                </div>
                            ))}
                            {/* 用戶自己加一張卡 */}
                            <button onClick={() => setAiEdit({ kind: 'card', id: '__new__', emoji: '🎭', name: '', persona: '', scenario: '', cardKind: 'character' })}
                                className="shrink-0 w-24 rounded-2xl p-3 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-1.5 active:scale-[0.98] transition self-stretch">
                                <Plus size={20} weight="light" className="text-white/55" />
                                <span className="text-[10px] text-white/45">加角色卡</span>
                            </button>
                        </div>
                    )}
                    {list.length === 0 && <EmptyState text={`還沒偷看到 TA 用「${svc.name}」`} />}
                    {list.map(s => {
                        const lines = parseTranscript(s.transcript);
                        const last = lines[lines.length - 1];
                        const vt = getVendorTheme(s.serviceName, s.service);
                        return (
                            <button key={s.id} {...longPress(() => setAiMenu({ kind: 'session', id: s.id }))}
                                onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setSelectedAiSessionId(s.id); setActiveAppId('ai_session'); }}
                                className="group relative w-full text-left flex gap-3 rounded-2xl p-3.5 bg-white/[0.035] border border-white/[0.06] animate-fade-in active:scale-[0.99] transition">
                                <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                                    style={{ background: aiService === 'assistant' ? `${vt.accent}1f` : `${svc.accent}1f`, color: svc.accent }}>
                                    {aiService === 'assistant'
                                        ? <VendorMark vkey={vt.key} label={vt.label} accent={vt.accent} size={22} />
                                        : aiService === 'claude' ? <Brain size={20} weight="fill" /> : <MaskHappy size={20} weight="fill" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="font-semibold text-[13.5px] text-white/95 truncate">{s.title}</div>
                                        <span className="text-[10px] text-white/30 tabular-nums shrink-0">{fmtClock(s.updatedAt)}</span>
                                    </div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{s.serviceName} · {lines.length} 條</div>
                                    {last && <div className="text-[11px] text-white/55 mt-1 truncate italic">「{last.text}」</div>}
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); askConfirm({ title: `刪除會話「${s.title}」？`, desc: '這段對話記錄會被刪除，無法撤銷。', confirmLabel: '刪除', danger: true, onConfirm: () => handleDeleteAiSession(s.id) }); }}
                                    className="absolute top-2 right-2 w-5 h-5 bg-rose-500/80 text-white rounded-full flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition">×</button>
                            </button>
                        );
                    })}
                </div>
                <RefreshFab onClick={() => handleGenerateAiAgent(aiService)} label={`偷看 TA 的${svc.name}`} accent={svc.accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    const renderAiSession = () => {
        const s = selectedAiSession;
        if (!s || !targetChar) return null;
        const isTavern = s.service === 'tavern';
        const card = isTavern ? aiCards.find(c => c.id === s.cardId) : undefined;
        const lines = parseTranscript(s.transcript);
        const partnerName = isTavern ? (card?.name || s.serviceName) : s.serviceName;
        const partnerEmoji = isTavern ? (card?.emoji || '🎭') : null;
        const inputHint = isTavern ? `以「${partnerName}」身份續寫劇情…` : `以 AI「${partnerName}」身份回 TA…`;
        // 酒館走用戶選的閱讀皮膚；助手/樹洞走廠商換膚
        const tStyle = TAVERN_STYLES.find(x => x.key === tavernStyle) || TAVERN_STYLES[0];
        const t: VendorTheme = isTavern
            ? { key: 'tavern', label: partnerName, dark: tStyle.dark, bg: tStyle.bg, text: tStyle.text, sub: tStyle.sub, accent: tStyle.accent, font: tStyle.font,
                userBg: `linear-gradient(135deg,${tStyle.accent},${tStyle.accent}bb)`, userText: '#fff',
                aiBg: tStyle.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)', aiText: tStyle.text }
            : getVendorTheme(s.serviceName, s.service);
        const clock = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        const hairline = t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
        const inputBg = t.dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
        const aiAvatarBg = t.key === 'gpt' ? '#000' : t.key === 'claude' ? '#f0e9da' : t.dark ? 'rgba(255,255,255,0.08)' : '#fff';

        // 酒館是長劇情小說體：把連續同一說話人的行合併成「樓層」，*動作* 渲染成斜體淡色
        const floors: { isMe: boolean; text: string }[] = [];
        for (const ln of lines) {
            const prev = floors[floors.length - 1];
            if (prev && prev.isMe === ln.isMe) prev.text += '\n' + ln.text;
            else floors.push({ isMe: ln.isMe, text: ln.text });
        }
        // *動作* 斜體淡色；（括號 OOC / 跟皮下 AI 說話）也淡色斜體——但都還在 char 自己的樓層裡，不另起氣泡
        const renderProse = (txt: string) => txt.split(/(\*[^*]+\*|（[^）]+）)/g).filter(Boolean).map((p, i) =>
            (p.startsWith('*') && p.endsWith('*'))
                ? <em key={i} style={{ color: t.sub }}>{p.slice(1, -1)}</em>
                : (p.startsWith('（') && p.endsWith('）'))
                    ? <em key={i} style={{ color: t.sub, opacity: 0.8 }}>{p}</em>
                    : <span key={i}>{p}</span>);
        return (
            <div className="absolute inset-0 w-full h-full flex flex-col z-[60] overflow-hidden"
                style={{ background: t.bg, color: t.text, fontFamily: t.font }}>
                {/* 狀態欄（按明暗著色） */}
                <div className="shrink-0" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-9 flex justify-between px-6 items-center pt-2" style={{ color: t.text, opacity: 0.65 }}>
                        <span className="text-[12px] font-semibold tabular-nums">{clock}</span>
                        <div className="flex gap-1.5 items-center">
                            <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M2 22h3V10H2v12zm6 0h3V6H8v16zm6 0h3V2h-3v20zm6 0h3v-8h-3v8z" /></svg>
                            <div className="w-5 h-2.5 border border-current rounded-[3px] relative px-px flex items-center"><div className="h-1.5 bg-current w-3/4 rounded-[1px]" /></div>
                        </div>
                    </div>
                </div>
                {/* 頂欄：返回 + logo + 服務名 + 刪除 */}
                <div className="shrink-0 h-14 flex items-center justify-between px-3" style={{ borderBottom: `1px solid ${hairline}` }}>
                    <button onClick={() => setActiveAppId('aiagent')} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.text }}>
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <div className="flex-1 flex items-center justify-center gap-2 px-2 min-w-0">
                        {!isTavern && (
                            <span className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                                style={{ background: t.key === 'gemini' || t.key === 'claude' ? 'transparent' : `${t.accent}1f` }}>
                                <VendorMark vkey={t.key} label={t.label} accent={t.accent} size={16} />
                            </span>
                        )}
                        <div className="min-w-0 text-center">
                            <div className="text-[15px] font-semibold tracking-wide truncate">{isTavern ? s.title : t.label}</div>
                            <div className="text-[10px] tracking-[0.15em] uppercase truncate" style={{ color: t.accent }}>
                                {isTavern ? `${partnerName} · 潛入對戲` : `${s.title} · 你來當 AI`}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center">
                        {isTavern && (
                            <button onClick={() => setShowTavernStyle(true)} aria-label="閱讀皮膚" className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.sub }}>
                                <PaintBrush size={16} />
                            </button>
                        )}
                        <button onClick={() => askConfirm({ title: `刪除會話「${s.title}」？`, desc: '這段對話記錄會被刪除，無法撤銷。', confirmLabel: '刪除', danger: true, onConfirm: () => handleDeleteAiSession(s.id) })} className="w-9 h-9 rounded-full flex items-center justify-center active:scale-90 transition" style={{ color: t.sub }}>
                            <Trash size={16} />
                        </button>
                    </div>
                </div>
                {/* 酒館閱讀皮膚選擇 */}
                {showTavernStyle && (
                    <div className="absolute inset-0 z-[80] flex items-end justify-center" onClick={() => setShowTavernStyle(false)}>
                        <div className="absolute inset-0 bg-black/40" />
                        <div className="relative w-full max-w-sm m-3 mb-6 rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10" onClick={e => e.stopPropagation()}>
                            <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10">閱讀皮膚</div>
                            <div className="grid grid-cols-2 gap-2 p-3">
                                {TAVERN_STYLES.map(st => (
                                    <button key={st.key} onClick={() => { setTavernStyle(st.key); setShowTavernStyle(false); trackEvent('切换酒馆阅读皮肤', { style: st.key }); }}
                                        className={`rounded-xl p-3 text-left border transition ${tavernStyle === st.key ? 'border-white/40' : 'border-white/10'}`}
                                        style={{ background: st.bg }}>
                                        <div className="text-[13px] font-semibold" style={{ color: st.text, fontFamily: st.font }}>{st.label}</div>
                                        <div className="text-[10px] mt-1" style={{ color: st.sub }}>{st.layout === 'card' ? '樓層卡片' : st.indent ? '書頁排版' : '素文排版'}</div>
                                        <div className="mt-1.5 h-1 w-10 rounded-full" style={{ background: st.accent }} />
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                )}
                {isTavern && card && (
                    <div className="px-4 pt-2 pb-1 shrink-0">
                        <div className="rounded-2xl p-3 flex items-start gap-3" style={{ background: `${t.accent}1a`, border: `1px solid ${hairline}` }}>
                            <div className="text-2xl shrink-0">{card.emoji}</div>
                            <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] font-semibold flex items-center gap-1.5 flex-wrap" style={{ color: t.text }}>
                                    {card.name}
                                    <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>{card.kind === 'world' ? '世界卡 · 跑團' : '角色卡'}</span>
                                    {card.basedOnUser ? <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>⚑ 照著你捏的</span>
                                        : card.basedOn ? <span className="text-[8.5px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>⚑ 照著「{card.basedOn}」捏的</span> : null}
                                </div>
                                <div className="text-[10px] mt-0.5 line-clamp-2" style={{ color: t.sub }}>{card.persona}</div>
                                {card.scenario && <div className="text-[10px] mt-1 line-clamp-2 italic" style={{ color: t.sub }}>場景：{card.scenario}</div>}
                            </div>
                        </div>
                    </div>
                )}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {/* 前情提要：長會話自動總結出的小說梗概（可展開被摺疊的早期原文） */}
                    {!!s.summaries?.length && (
                        <div className="rounded-2xl p-3.5 space-y-2" style={{ background: `${t.accent}10`, border: `1px dashed ${t.accent}55` }}>
                            <div className="text-[10px] tracking-[0.25em] uppercase font-bold" style={{ color: t.accent }}>前情提要 · {s.summaries.length} 段</div>
                            {s.summaries.map((sm, i) => (
                                <p key={sm.id} className="text-[12px] leading-[1.85] whitespace-pre-wrap" style={{ color: t.sub }}>
                                    {s.summaries!.length > 1 && <span className="font-semibold" style={{ color: t.accent }}>{i + 1}. </span>}{sm.content}
                                </p>
                            ))}
                            {!!s.archived && (
                                <button onClick={() => setAiArchiveOpen(o => !o)}
                                    className="text-[11px] font-semibold pt-1 active:scale-95 transition" style={{ color: t.accent }}>
                                    {aiArchiveOpen ? '收起摺疊的原文 ▲' : '展開摺疊的原文 ▼'}
                                </button>
                            )}
                            {aiArchiveOpen && !!s.archived && (
                                <div className="text-[12px] leading-[1.85] whitespace-pre-wrap pt-1 mt-1 border-t" style={{ color: t.sub, borderColor: hairline }}>
                                    {parseTranscript(s.archived).map((l, i) => (
                                        <div key={i} className="mb-1"><span className="opacity-60">{l.isMe ? charName : partnerName}：</span>{l.text}</div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {/* 酒館：玩家一層樓 / 角色一層樓 交替。card=樓層卡片，flat=素排/書頁。OOC 就是樓層裡的括號。 */}
                    {isTavern ? floors.map((f, i) => {
                        const who = f.isMe ? charName : partnerName;
                        if (tStyle.layout === 'flat') {
                            return (
                                <div key={i} {...longPress(() => setAiTurnMenu(i))} className="px-1 py-1.5 select-none">
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-[12px] font-semibold" style={{ color: f.isMe ? t.accent : t.text }}>{who}</span>
                                        {f.isMe && <span className="text-[9px]" style={{ color: t.sub }}>· 玩家</span>}
                                    </div>
                                    <div className="text-[14px] whitespace-pre-wrap" style={{ color: t.text, lineHeight: 1.95, textIndent: tStyle.indent ? '2em' : undefined }}>{renderProse(f.text)}</div>
                                </div>
                            );
                        }
                        return (
                            <div key={i} {...longPress(() => setAiTurnMenu(i))} className="rounded-2xl p-3.5 select-none"
                                style={{ background: f.isMe ? `${t.accent}10` : 'rgba(255,255,255,0.04)', border: `1px solid ${hairline}` }}>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className="w-7 h-7 rounded-lg flex items-center justify-center overflow-hidden shrink-0"
                                        style={{ background: f.isMe ? 'transparent' : `${t.accent}1f` }}>
                                        {f.isMe ? <TokenImg value={targetChar.avatar} className="w-7 h-7 object-cover" /> : <span className="text-base">{partnerEmoji}</span>}
                                    </div>
                                    <span className="text-[12.5px] font-semibold" style={{ color: f.isMe ? t.accent : t.text }}>{who}</span>
                                    {f.isMe && <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ background: `${t.accent}26`, color: t.accent }}>玩家</span>}
                                </div>
                                <div className="text-[13px] leading-[1.95] whitespace-pre-wrap" style={{ color: t.text }}>{renderProse(f.text)}</div>
                            </div>
                        );
                    }) : lines.map((m, i) => {
                        const bare = !m.isMe && t.aiBg === 'transparent'; // ChatGPT/Claude：AI 不用氣泡，整段鋪開
                        return (
                            <div key={i} {...longPress(() => setAiTurnMenu(i))} className={`flex items-end gap-2 select-none ${m.isMe ? 'justify-end' : 'justify-start'}`}>
                                {!m.isMe && (
                                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-base shrink-0 overflow-hidden"
                                        style={{ background: aiAvatarBg, border: `1px solid ${hairline}` }}>
                                        {partnerEmoji || <VendorMark vkey={t.key} label={t.label} accent={t.key === 'gpt' ? '#fff' : t.accent} size={17} />}
                                    </div>
                                )}
                                <div className="px-3.5 py-2.5 rounded-2xl max-w-[78%] text-[13px] leading-relaxed break-words whitespace-pre-wrap"
                                    style={{
                                        background: m.isMe ? t.userBg : (bare ? 'transparent' : t.aiBg),
                                        color: m.isMe ? t.userText : t.aiText,
                                        border: (!m.isMe && !bare && !t.dark) ? `1px solid ${hairline}` : undefined,
                                        borderBottomRightRadius: m.isMe ? 6 : undefined,
                                        borderBottomLeftRadius: (!m.isMe && !bare) ? 6 : undefined,
                                        paddingLeft: bare ? 2 : undefined, paddingRight: bare ? 2 : undefined,
                                    }}>
                                    {m.text}
                                </div>
                                {m.isMe && <TokenImg value={targetChar.avatar} className="w-8 h-8 rounded-xl object-cover shrink-0" />}
                            </div>
                        );
                    })}
                    {aiSending && (
                        <div className="flex justify-start items-center gap-2">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: aiAvatarBg, border: `1px solid ${hairline}` }}>
                                {partnerEmoji || <VendorMark vkey={t.key} label={t.label} accent={t.key === 'gpt' ? '#fff' : t.accent} size={17} />}
                            </div>
                            <div className="flex gap-1 px-3 py-2.5 rounded-2xl" style={{ background: t.aiBg === 'transparent' ? 'transparent' : t.aiBg }}>
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub }} />
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub, animationDelay: '0.15s' }} />
                                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: t.sub, animationDelay: '0.3s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={chatEndRef} />
                </div>
                {/* 自然推進：不用開口，讓劇情自己往下走一輪 */}
                <div className="shrink-0 w-full px-3 pt-2" style={{ borderTop: `1px solid ${hairline}` }}>
                    <button onClick={handleAiAutoContinue} disabled={aiSending}
                        className="w-full py-2 rounded-xl text-[12px] font-semibold flex items-center justify-center gap-1.5 active:scale-[0.99] transition disabled:opacity-40"
                        style={{ background: `${t.accent}1a`, border: `1px dashed ${t.accent}66`, color: t.accent }}>
                        <Sparkle size={14} weight="fill" /> {isTavern ? '讓劇情自己往下走一輪' : '讓 TA 接著問下去'}
                    </button>
                </div>
                {/* 互動輸入：替 TA 問 / 潛入對戲（回車換行，點按鈕發送） */}
                <div className="shrink-0 w-full px-3 pt-2 flex items-end gap-2"
                    style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}>
                    <textarea value={aiInput} onChange={e => setAiInput(e.target.value)}
                        rows={1} placeholder={inputHint}
                        className="flex-1 resize-none rounded-2xl px-3.5 py-2.5 text-[13px] max-h-24 no-scrollbar focus:outline-none"
                        style={{ background: inputBg, color: t.text, border: `1px solid ${hairline}` }} />
                    <button onClick={handleAiSend} disabled={aiSending || !aiInput.trim()}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 disabled:opacity-30 active:scale-90 transition"
                        style={{ background: t.accent, color: '#fff' }}>
                        {aiSending ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <PaperPlaneTilt size={17} weight="fill" />}
                    </button>
                </div>
            </div>
        );
    };

    const renderContactDetail = () => {
        if (!selectedContact || !targetChar) return null;
        const c = selectedContact;
        const accent = '#f472b6';
        const badge = kindBadge(c);
        const isReal = c.kind === 'real' && !!c.linkedCharId;
        const av = contactAvatar(c);
        const rec = records.find(r => r.type === 'chat' && (r.contactId === c.id || normName(r.title) === normName(c.name)));
        const parsed = rec ? parseTranscript(rec.detail).map(t => ({ isMe: t.isMe, content: t.text })) : [];
        const CAP = 50;
        const hidden = convExpanded ? 0 : Math.max(0, parsed.length - CAP);
        const shown = hidden > 0 ? parsed.slice(-CAP) : parsed;
        const statusLabel = c.status === 'friend' ? '好友' : c.status === 'deleted' ? '已刪除' : c.status === 'blocked' ? '已拉黑' : '待定';
        const aff = affinityDraft ?? c.affinity;
        const commitAff = () => { if (affinityDraft != null) { handleSetAffinity(c, affinityDraft); setAffinityDraft(null); } };
        const closeProfile = () => { setShowProfile(false); setEditingIdentity(false); setEditingNote(false); setEditingName(false); };
        const avatarNode = (size: string, txt: string) => av
            ? <TokenImg value={av} alt="" className={`${size} rounded-2xl object-cover shrink-0`} />
            : <div className={`${size} rounded-2xl flex items-center justify-center shrink-0 text-white font-semibold ${txt}`} style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>{c.name[0]}</div>;
        return (
            <SubAppShell>
                {/* 聊天式頂欄：返回 + 可點的頭像/名字（進資料） */}
                <div className="shrink-0 z-20">
                    <StatusStrip />
                    <div className="h-14 flex items-center gap-2 px-3">
                        <button onClick={() => { if (msgSelectMode) exitMsgSelect(); else setActiveAppId('contacts'); }} className="w-9 h-9 -ml-0.5 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition shrink-0">
                            <CaretLeft size={18} weight="bold" />
                        </button>
                        <button onClick={() => setShowProfile(true)} className="flex items-center gap-2.5 flex-1 min-w-0 active:opacity-70 transition">
                            {avatarNode('w-9 h-9', 'text-base')}
                            <div className="min-w-0 text-left">
                                <div className="text-[14px] font-semibold text-white truncate leading-tight">{contactDisplayName(c)}</div>
                                <div className="text-[9.5px] text-white/40 leading-tight">{badge.label} · 輕觸頭像看資料</div>
                            </div>
                        </button>
                        <button onClick={() => setShowProfile(true)} aria-label="資料" className="w-9 h-9 rounded-full flex items-center justify-center text-white/70 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition shrink-0">
                            <DotsThree size={20} weight="bold" />
                        </button>
                    </div>
                </div>

                {/* 聊天主體 */}
                <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 no-scrollbar overscroll-contain min-h-0">
                    {parsed.length === 0 && !isLoading && (
                        <div className="flex flex-col items-center justify-center h-full gap-2.5 text-white/30">
                            <ChatCircleDots size={42} weight="light" />
                            <span className="text-[12px] tracking-wide">{isReal ? '還沒聊過 · 在下面發起對話' : '還沒偷看過 · 下面偷看一段'}</span>
                        </div>
                    )}
                    {hidden > 0 && (
                        <button onClick={() => setConvExpanded(true)}
                            className="w-full py-2 rounded-xl text-[11.5px] font-semibold text-white/55 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                            ▲ 展開更早的 {hidden} 條消息
                        </button>
                    )}
                    {shown.map((m, i) => {
                        const realIdx = hidden + i; // 映射回完整腳本下標
                        const sel = selectedMsgIdx.includes(realIdx);
                        return (
                        <div key={realIdx}
                            {...longPress(() => { setMsgSelectMode(true); setSelectedMsgIdx(prev => prev.includes(realIdx) ? prev : [...prev, realIdx]); })}
                            onClick={() => {
                                if (lpFired.current) { lpFired.current = false; return; }
                                if (msgSelectMode) setSelectedMsgIdx(prev => prev.includes(realIdx) ? prev.filter(x => x !== realIdx) : [...prev, realIdx]);
                            }}
                            className={`flex items-end gap-2 select-none ${m.isMe ? 'justify-end' : 'justify-start'} ${msgSelectMode ? 'cursor-pointer rounded-xl -mx-1 px-1 py-0.5 transition ' + (sel ? 'bg-pink-500/15' : '') : ''}`}>
                            {msgSelectMode && (
                                <span className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 text-[9px] font-bold self-center ${sel ? 'bg-pink-500 border-pink-500 text-white' : 'border-white/30 text-transparent'} ${m.isMe ? 'order-last' : ''}`}>✓</span>
                            )}
                            {!m.isMe && (av
                                ? <TokenImg value={av} alt="" className="w-7 h-7 rounded-xl object-cover shrink-0" />
                                : <div className="w-7 h-7 rounded-xl flex items-center justify-center text-[11px] text-white shrink-0" style={{ background: `linear-gradient(135deg, ${accent}40, ${accent}10)` }}>{c.name[0]}</div>)}
                            <div className={`px-3.5 py-2.5 rounded-2xl max-w-[76%] text-[13px] leading-relaxed break-words ${m.isMe ? 'text-white rounded-br-md' : 'bg-white/[0.07] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                                style={m.isMe ? { background: `linear-gradient(135deg, ${accent}, ${accent}bb)` } : undefined}>{m.content}</div>
                            {m.isMe && <TokenImg value={targetChar.avatar} alt="" className="w-7 h-7 rounded-xl object-cover shrink-0" />}
                        </div>
                    );})}
                    {isLoading && (
                        <div className="flex justify-center py-3">
                            <div className="flex gap-1.5">
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.2s' }} />
                                <div className="w-2 h-2 rounded-full animate-dot-pulse" style={{ background: accent, animationDelay: '0.4s' }} />
                            </div>
                        </div>
                    )}
                    <div ref={contactEndRef} />
                </div>

                {/* 底部：多選時＝刪除選中條；否則＝發起/偷看對話（像聊天輸入區） */}
                <div className="shrink-0 w-full p-4 pb-6">
                    {msgSelectMode ? (
                        <div className="flex gap-2">
                            <button onClick={exitMsgSelect}
                                className="px-5 py-3 rounded-2xl text-[13px] font-semibold text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition">取消</button>
                            {/* 只選中一條時才能編輯——編輯是改單條內容，多選改不出"這條要改成什麼" */}
                            {selectedMsgIdx.length === 1 && (
                                <button onClick={() => setMsgEdit({ index: selectedMsgIdx[0], text: parsed[selectedMsgIdx[0]]?.content || '' })}
                                    className="px-5 py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.08] border border-white/[0.1] active:scale-[0.99] transition flex items-center justify-center gap-2">
                                    <PencilSimple size={16} weight="bold" /> 編輯
                                </button>
                            )}
                            <button disabled={!selectedMsgIdx.length}
                                onClick={() => askConfirm({
                                    title: `刪除選中的 ${selectedMsgIdx.length} 條消息？`,
                                    desc: c.kind === 'real' && c.linkedCharId ? '這幾條會從兩邊手機裡一併刪除。' : '從這段對話裡刪掉這幾條。',
                                    confirmLabel: '刪除', danger: true, onConfirm: handleDeleteSelectedMessages,
                                })}
                                className="flex-1 py-3 rounded-2xl text-[13px] font-semibold text-white bg-rose-500 disabled:opacity-40 active:scale-[0.99] transition flex items-center justify-center gap-2">
                                <Trash size={16} weight="bold" /> 刪除選中 {selectedMsgIdx.length || ''}
                            </button>
                        </div>
                    ) : isReal ? (
                        <button onClick={() => handleRealConversation(c)} disabled={isLoading}
                            className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white active:scale-[0.99] transition flex items-center justify-center gap-2"
                            style={{ background: `linear-gradient(135deg, ${accent}, ${accent}bb)` }}>
                            <PaperPlaneTilt size={16} weight="fill" /> {rec ? '繼續真實對話（雙方同步）' : '發起真實對話（A 發 B 回）'}
                        </button>
                    ) : (
                        <button onClick={() => handleNpcConversation(c)} disabled={isLoading}
                            className="w-full py-3 rounded-2xl text-[13px] font-semibold text-white/90 bg-white/[0.06] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-2">
                            <ChatCircleDots size={16} weight="fill" /> {rec ? '偷看後續對話' : '偷看對話'}
                        </button>
                    )}
                </div>

                {/* 資料抽屜：點頭像/… 滑出，備註 / 瞭解 / 好感 / 綁定 / 關係操作都在這裡 */}
                {showProfile && (
                    <div className="absolute inset-0 z-[80] flex flex-col justify-end">
                        <div className="absolute inset-0 bg-black/55 animate-fade-in" onClick={closeProfile} />
                        <div className="relative max-h-[90%] overflow-y-auto no-scrollbar rounded-t-[28px] border-t border-white/[0.1] px-5 pt-3 pb-9 animate-slide-up space-y-3.5"
                            style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d27 0%, #101218 70%)' }}>
                            <div className="w-10 h-1 rounded-full bg-white/20 mx-auto" />
                            {/* 頭部資料 */}
                            <div className="flex flex-col items-center gap-2 pt-1">
                                {avatarNode('w-20 h-20', 'text-2xl')}
                                <div className="text-[17px] font-semibold text-white text-center">{contactDisplayName(c)}</div>
                                <div className="flex items-center gap-2 flex-wrap justify-center">
                                    <span className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full" style={{ color: badge.color, background: `${badge.color}1f` }}>{badge.icon}{badge.label}</span>
                                    {c.identity && <span className="text-[11px] text-white/55">{c.identity}</span>}
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/55">{statusLabel}</span>
                                </div>
                            </div>

                            {/* 好感（可拖） */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center gap-2.5">
                                    <span className="text-[11px] text-white/45 shrink-0">好感</span>
                                    <input type="range" min={-100} max={100} step={1} value={aff}
                                        onChange={(e) => setAffinityDraft(parseInt(e.target.value, 10))}
                                        onPointerUp={commitAff} onTouchEnd={commitAff} onMouseUp={commitAff} onBlur={commitAff} onKeyUp={commitAff}
                                        aria-label="好感度" className="flex-1 h-2 cursor-pointer bg-transparent" style={{ accentColor: affColor(aff) }} />
                                    <span className="text-[12px] font-bold tabular-nums shrink-0 w-9 text-right" style={{ color: affColor(aff) }}>{aff > 0 ? '+' : ''}{aff}</span>
                                </div>
                            </div>

                            {/* 真人：備註名 / 關係（identity，可人工鎖定，後續掃描不覆蓋）；
                                虛構 NPC：沒有"真名"兜底，直接編輯姓名本身——這是唯一的名字來源 */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">{isReal ? '備註名 / 關係' : '姓名'}</span>
                                    <button
                                        onClick={() => {
                                            if (isReal) { setEditingIdentity(!editingIdentity); setIdentityDraft(c.identity || ''); }
                                            else { setEditingName(!editingName); setNameDraft(c.name); }
                                        }}
                                        className="text-white/50 active:scale-90 transition" aria-label={isReal ? '編輯備註名' : '編輯姓名'}>
                                        <PencilSimple size={14} weight="bold" />
                                    </button>
                                </div>
                                {isReal ? (
                                    editingIdentity ? (
                                        <div className="space-y-2">
                                            <input value={identityDraft} onChange={e => setIdentityDraft(e.target.value)} placeholder="例如：學長、前任、彼方網友"
                                                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90" />
                                            <button onClick={() => handleSaveIdentity(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>保存</button>
                                            <p className="text-[9.5px] text-white/30">留空保存會恢復顯示真名；人工保存後不會被再次掃描覆蓋</p>
                                        </div>
                                    ) : (
                                        <p className="text-[12.5px] text-white/70 leading-relaxed">{c.identity || `（顯示真名：${linkedCharOf(c)?.name || c.name}）`}</p>
                                    )
                                ) : (
                                    editingName ? (
                                        <div className="space-y-2">
                                            <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} placeholder="聯繫人姓名"
                                                className="w-full bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90" />
                                            <button onClick={() => handleSaveContactName(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>保存</button>
                                        </div>
                                    ) : (
                                        <p className="text-[12.5px] text-white/70 leading-relaxed">{c.name}</p>
                                    )
                                )}
                            </div>

                            {/* 備註（事實，可編輯） */}
                            <div className="rounded-2xl p-4 bg-white/[0.04] border border-white/[0.06]">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">備註</span>
                                    <button onClick={() => { setEditingNote(!editingNote); setNoteDraft(c.note || ''); }} className="text-white/50 active:scale-90 transition"><PencilSimple size={14} weight="bold" /></button>
                                </div>
                                {editingNote ? (
                                    <div className="space-y-2">
                                        <textarea value={noteDraft} onChange={e => setNoteDraft(e.target.value)} placeholder="機主對 TA 的備註（事實/關係）…"
                                            className="w-full h-16 bg-white/[0.05] border border-white/[0.08] rounded-xl p-2.5 text-[12px] text-white/90 resize-none" />
                                        <button onClick={() => handleSaveNote(c)} className="w-full py-2 rounded-xl text-[12px] font-semibold text-white" style={{ background: accent }}>保存</button>
                                    </div>
                                ) : (
                                    <p className="text-[12.5px] text-white/70 leading-relaxed whitespace-pre-wrap">{c.note || '（無備註）'}</p>
                                )}
                            </div>

                            {/* 話題盒：聊滿 100 條自動濃縮的第一人稱聊天記憶（長按改/刪）；原文仍在聊天裡可看 */}
                            {c.topicBox && c.topicBox.length > 0 && (
                                <div className="rounded-2xl p-4 bg-white/[0.03] border border-white/[0.06]">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">話題盒 · 聊天記憶</span>
                                        <span className="text-[9px] text-white/30">長按改/刪</span>
                                    </div>
                                    <div className="space-y-2">
                                        {c.topicBox.map(t => (
                                            <div key={t.id} {...longPress(() => setTopicEdit({ contactId: c.id, topicId: t.id, text: t.text }))}
                                                onClick={() => { if (lpFired.current) { lpFired.current = false; } }}
                                                className="rounded-xl px-3 py-2 bg-white/[0.03] border border-white/[0.05] active:bg-white/[0.06] transition select-none cursor-pointer">
                                                <p className="text-[11.5px] text-white/60 leading-relaxed whitespace-pre-wrap">{t.text}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <p className="text-[9.5px] text-white/25 mt-2">※ 每聊滿 {ARCHIVE_EVERY} 條自動濃縮成一條第一人稱記憶讓 TA 記住；原文仍在聊天裡可看</p>
                                </div>
                            )}

                            {/* 瞭解（印象，未必屬實，自動累積） */}
                            <div className="rounded-2xl p-4 bg-white/[0.02] border border-white/[0.06] border-dashed">
                                <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-[10px] tracking-[0.2em] uppercase text-white/40">瞭解 · {targetChar.name} 眼中的 TA</span>
                                    {c.learned && c.learned.trim() && (
                                        <button onClick={() => mutateContacts(cs => cs.map(x => x.id === c.id ? { ...x, learned: '' } : x))}
                                            className="text-white/40 active:scale-90 transition" aria-label="清空了解"><Trash size={13} weight="bold" /></button>
                                    )}
                                </div>
                                {c.learned && c.learned.trim() ? (
                                    <>
                                        <p className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{c.learned}</p>
                                        <p className="text-[9.5px] text-white/30 mt-1.5">※ 來自相處的印象，是 TA 自己說的，未必屬實</p>
                                    </>
                                ) : (
                                    <p className="text-[11.5px] text-white/30 leading-relaxed">還沒聊出對 TA 的瞭解 · 多聊幾句會自動累積（未必屬實）</p>
                                )}
                            </div>

                            {/* 綁定 / 改綁 */}
                            <button onClick={() => { closeProfile(); setShowRebindModal(true); }}
                                className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 bg-white/[0.04] border border-white/[0.07] active:scale-[0.99] transition">
                                <LinkSimple size={13} weight="bold" className="shrink-0 text-white/50" />
                                <span className="text-[11px] text-white/55 flex-1 text-left truncate">
                                    {isReal ? `綁定真實角色：${linkedCharOf(c)?.name || '已綁定'}` : '虛構聯繫人（未綁定真實角色）'}
                                </span>
                                <span className="text-[11px] font-semibold shrink-0" style={{ color: accent }}>改綁定</span>
                            </button>

                            {/* 關係操作 */}
                            <div className="flex gap-2">
                                {c.status !== 'friend' && (
                                    <button onClick={() => handleSetContactStatus(c, 'friend')} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-emerald-200 bg-emerald-400/15 border border-emerald-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><UserPlus size={14} weight="bold" /> 加好友</button>
                                )}
                                {c.status === 'friend' && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: `刪除好友「${c.name}」？`, desc: `${targetChar.name} 會察覺是你在偷看 TA 手機時刪的。`,
                                        confirmLabel: '刪好友', danger: true, onConfirm: () => handleSetContactStatus(c, 'deleted'),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-rose-200 bg-rose-400/15 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Trash size={14} weight="bold" /> 刪好友</button>
                                )}
                                {c.status !== 'blocked' && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: `拉黑「${c.name}」？`, desc: `${targetChar.name} 會察覺是你在偷看 TA 手機時拉黑的。`,
                                        confirmLabel: '拉黑', danger: true, onConfirm: () => handleSetContactStatus(c, 'blocked'),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/60 bg-white/[0.05] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Prohibit size={14} weight="bold" /> 拉黑</button>
                                )}
                            </div>

                            {/* 危險操作：清空對話 / 徹底移除 */}
                            <div className="flex gap-2">
                                {rec && (
                                    <button onClick={() => { closeProfile(); askConfirm({
                                        title: '清空這段對話？',
                                        desc: c.kind === 'real' && c.linkedCharId
                                            ? `會把「${c.name}」這段聊天記錄、話題盒記憶清掉（對方手機裡的鏡像也一併清除），回到乾淨起點、之後可重新生成。`
                                            : `會把「${c.name}」這段聊天記錄和話題盒記憶清掉，回到乾淨起點、之後可重新生成。`,
                                        confirmLabel: '清空', danger: true, onConfirm: () => handleClearContactConversation(c),
                                    }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-white/60 bg-white/[0.05] border border-white/[0.08] active:scale-[0.99] transition flex items-center justify-center gap-1.5"><ChatCircle size={14} weight="bold" /> 清空對話</button>
                                )}
                                <button onClick={() => { closeProfile(); askConfirm({
                                    title: '徹底移除該聯繫人？',
                                    desc: c.kind === 'real' && c.linkedCharId
                                        ? `會把「${c.name}」連同 TA 的聊天記錄、私聊裡的卡片一起刪除；綁定的真實角色那邊的鏡像聯繫人和記錄也一併清除（綁錯了就用這個清乾淨）。`
                                        : `會把「${c.name}」連同 TA 的聊天記錄、私聊裡的卡片一起徹底刪除。`,
                                    confirmLabel: '徹底移除', danger: true, onConfirm: () => handleRemoveContact(c),
                                }); }} className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold text-rose-200 bg-rose-400/15 border border-rose-400/20 active:scale-[0.99] transition flex items-center justify-center gap-1.5"><Trash size={14} weight="bold" /> 徹底移除</button>
                            </div>
                        </div>
                    </div>
                )}
            </SubAppShell>
        );
    };

    const renderCustomItem = (r: PhoneEvidence, idx: number, total: number, accent: string, layout: LayoutId, app: PhoneCustomApp) => {
        // HTML 卡片：只有這個 App 開著開關、且這條記錄確實生成出 html 時才走這條路；
        // 沒生成出來（指令為空/關閉/LLM 沒給）自動落回下面按 layout 分支的純文字渲染，不用額外判斷。
        if (app.htmlCardEnabled && r.html) {
            return (
                <div key={r.id} {...evidenceEntryProps(r, app.id)} className="group relative animate-slide-up focus:outline-none">
                    <HtmlCard html={composeCustomAppCardHtml(app, r.html)} />
                    <DelBtn onDelete={() => handleDeleteRecord(r)} />
                </div>
            );
        }
        switch (layout) {
            case 'shop':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative flex gap-3 rounded-2xl p-3 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="w-16 h-16 rounded-xl shrink-0 flex items-center justify-center text-2xl" style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0d)` }}>{app.icon}</div>
                        <div className="flex-1 min-w-0 flex flex-col">
                            <div className="text-[13px] font-medium text-white/95 leading-snug line-clamp-2">{r.title}</div>
                            <div className="text-[10.5px] text-white/40 mt-0.5 line-clamp-1">{r.detail}</div>
                            <div className="mt-auto flex items-center justify-between pt-1.5">
                                <span className="text-[14px] font-bold" style={{ color: accent }}>{r.value || '¥ --'}</span>
                                <span className="text-[9px] px-2 py-0.5 rounded-full bg-white/[0.06] text-white/50 tracking-wider">已下單</span>
                            </div>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'feed':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="flex items-center gap-3 mb-2.5">
                            <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: `linear-gradient(135deg, ${accent}55, ${accent}15)` }}>{app.icon}</div>
                            <div className="min-w-0">
                                <div className="text-[13px] font-semibold text-white/95">{charName}</div>
                                <div className="text-[10px] text-white/35">{r.title || fmtClock(r.timestamp)}</div>
                            </div>
                        </div>
                        <div className="text-[13px] text-white/80 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-5 mt-3 pt-2.5 border-t border-white/[0.06] text-white/40">
                            <span className="flex items-center gap-1.5 text-[11px]"><Heart size={14} weight="fill" style={{ color: accent }} /> {3 + (r.id.length % 30)}</span>
                            <span className="flex items-center gap-1.5 text-[11px]"><ChatCircle size={14} /> {1 + (r.id.length % 9)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'forum':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                            <span className="text-[14px] font-semibold text-white/95 leading-snug line-clamp-2 flex-1">{r.title}</span>
                            {r.value && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed line-clamp-3 whitespace-pre-wrap">{r.detail}</div>
                        <div className="flex items-center gap-3 mt-2.5 text-[10px] text-white/35">
                            <span className="flex items-center gap-1">{app.icon} {charName}</span>
                            <span>· {1 + (r.id.length % 200)} 回覆</span>
                            <span>· {fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            case 'novel':
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" style={{ boxShadow: `inset 0 0 30px ${accent}10` }}>
                        <div className="text-[10px] tracking-[0.2em] uppercase mb-1" style={{ color: accent }}>Chapter {total - idx}</div>
                        <div className="text-[15px] font-semibold text-white/95 mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.title}</div>
                        <div className="text-[12.5px] text-white/60 leading-loose line-clamp-4 whitespace-pre-wrap" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{r.detail}</div>
                        <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/[0.06] text-[10px] text-white/30">
                            <span>{r.value || '連載中'}</span>
                            <span className="tabular-nums">{fmtClock(r.timestamp)}</span>
                        </div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
            default:
                return (
                    <div key={r.id} {...evidenceEntryProps(r, app.id)}
                        className="group relative rounded-2xl p-4 pr-8 bg-white/[0.035] border border-white/[0.06] animate-slide-up cursor-pointer active:scale-[0.99] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" style={{ boxShadow: `inset 0 0 24px ${accent}14` }}>
                        <div className="flex justify-between items-start gap-2 mb-1.5">
                            <span className="text-[13.5px] font-semibold text-white/95 line-clamp-1">{r.title}</span>
                            {r.value && <span className="text-[12px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ color: accent, background: `${accent}1f` }}>{r.value}</span>}
                        </div>
                        <div className="text-[12px] text-white/55 leading-relaxed whitespace-pre-wrap">{r.detail}</div>
                        <div className="text-[9.5px] text-white/25 mt-2 text-right tabular-nums">{fmtClock(r.timestamp)}</div>
                        <DelBtn onDelete={() => handleDeleteRecord(r)} />
                    </div>
                );
        }
    };

    const renderCustomApp = (app: PhoneCustomApp) => {
        const accent = app.color || '#8b9cff';
        const layout = app.layout || 'generic';
        const layoutMeta = APP_LAYOUTS.find(l => l.id === layout);
        const list = records.filter(r => r.type === app.id).sort((a, b) => b.timestamp - a.timestamp);
        return (
            <SubAppShell>
                <TermHeader title={app.name} sub={layoutMeta?.name || 'custom app'} accent={accent} onBack={() => setActiveAppId('home')}
                    right={<span className="text-lg">{app.icon}</span>} />
                <div className="flex-1 overflow-y-auto px-4 pt-2 no-scrollbar pb-28 overscroll-contain space-y-3">
                    {list.length === 0 && <EmptyState text="暫無數據" />}
                    {list.map((r, idx) => renderCustomItem(r, idx, list.length, accent, layout, app))}
                </div>
                <RefreshFab onClick={() => handleGenerate(app.id, app.prompt, layout)} label="刷新數據" accent={accent} loading={isLoading} />
            </SubAppShell>
        );
    };

    // ============================================================
    //  HOME DESKTOP (mirrors the reference design)
    // ============================================================
    const renderHomePage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-2 pb-32">
            {/* Header */}
            <div className="flex items-start justify-between mb-5">
                <div className="min-w-0">
                    <h1 className="text-[34px] leading-none text-white font-light tracking-wide truncate" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{charName}</h1>
                    <p className="text-[11px] tracking-[0.35em] uppercase text-white/40 mt-2">The Space Between</p>
                    <div className="h-px w-28 bg-gradient-to-r from-white/30 to-transparent mt-3" />
                </div>
                <div className="flex flex-col items-end shrink-0 pt-1 text-white/70">
                    <Cloud size={26} weight="light" />
                    <span className="text-[15px] font-light mt-1 tabular-nums">{temp}°C</span>
                </div>
            </div>

            {/* Time */}
            <div className="mb-4">
                <div className="text-[30px] font-extralight text-white tracking-[0.08em] tabular-nums">{clockNow}</div>
                <div className="text-[12px] text-white/45 mt-0.5">{dateNow}</div>
            </div>

            {/* Quote：有最近的內心獨白(InnerState)就顯示它（一行截斷，點按看全文），否則兜底詩句 */}
            {innerQuote ? (
                <button onClick={() => setShowInner(true)} className="block w-full text-left mb-5 group">
                    <p className="text-[13px] text-white/65 italic leading-relaxed line-clamp-1">「{innerQuote}」</p>
                    <span className="text-[9px] tracking-wider text-white/30 group-active:text-white/55">有些話沒說出口 · 輕觸</span>
                </button>
            ) : (
                <p className="text-[13px] text-white/55 italic mb-5 leading-relaxed">{fallbackQuote}</p>
            )}

            {/* Persona simulation hero */}
            <button onClick={() => { setActiveAppId('persona'); trackEvent('打开查手机子应用', { subApp: 'persona' }); }}
                className="relative w-full rounded-[24px] p-5 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform"
                style={{ background: 'linear-gradient(115deg, rgba(184,155,255,0.22), rgba(120,90,214,0.08) 55%, rgba(20,18,30,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-40 h-40 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.55), transparent 70%)' }} />
                <div className="relative z-10">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">Persona Simulation</div>
                    <div className="text-[18px] font-light text-white mt-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>成為 TA 的一段人生</div>
                    <div className="text-[11px] text-white/55 mt-1.5">不是查看 TA 的手機 · 是用 TA 的手機活一次</div>
                    <div className="flex items-center justify-between mt-4">
                        <span className="text-[11px] text-white/45 flex items-center gap-1.5">
                            <ClockCounterClockwise size={13} /> 生活記錄 · {simLogCount}
                        </span>
                        <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: '#c9b6ff' }}>進入演出 <CaretRight size={11} weight="bold" /></span>
                    </div>
                </div>
            </button>

            {/* Real Balance：提到聯繫人/Moments 那組卡片上面，跟見面演出一樣是「常用」級別的入口 */}
            <div className="grid grid-cols-2 gap-3.5 mb-3.5">
                <HomeCard icon={<CreditCard size={24} weight="light" />} label="Real Balance" sub={realBalanceSub} accent="#38bdf8" spanFull
                    onClick={() => { setActiveAppId('balance'); trackEvent('打开查手机子应用', { subApp: 'balance' }); }} />
            </div>

            {/* App cards —— 「聯繫人」佔據原 Message 的主位（Message 已廢棄，收進聯繫人裡做不起眼入口） */}
            <div className="grid grid-cols-2 gap-3.5 mb-3.5">
                <HomeCard icon={<UsersThree size={24} weight="light" />} label="聯繫人" sub={contactsSub} accent="#f472b6"
                    onClick={() => { setActiveAppId('contacts'); trackEvent('打开查手机子应用', { subApp: 'contacts' }); }} />
                <HomeCard icon={<ImagesSquare size={24} weight="light" />} label="Moments" sub={momentsSub} accent="#c084fc"
                    onClick={() => { setActiveAppId('social'); trackEvent('打开查手机子应用', { subApp: 'social' }); }} />
                <HomeCard icon={<Hamburger size={24} weight="light" />} label="Food" sub={foodSub} accent="#fbbf24"
                    onClick={() => { setActiveAppId('waimai'); trackEvent('打开查手机子应用', { subApp: 'waimai' }); }} />
                <HomeCard icon={<ShoppingBag size={24} weight="light" />} label="Taobao" sub={taobaoSub} accent="#ff7a45"
                    onClick={() => { setActiveAppId('taobao'); trackEvent('打开查手机子应用', { subApp: 'taobao' }); }} />
            </div>

            {/* 智能體：偷看「TA 的小手機」 —— 給個搶眼的橫條入口 */}
            <button onClick={() => { setActiveAppId('aiagent'); trackEvent('打开查手机子应用', { subApp: 'aiagent' }); }}
                className="relative w-full rounded-[24px] p-4 mb-3.5 text-left overflow-hidden border border-white/[0.09] active:scale-[0.98] transition-transform flex items-center gap-3.5"
                style={{ background: 'linear-gradient(115deg, rgba(52,211,153,0.20), rgba(16,185,129,0.06) 55%, rgba(12,20,18,0.4))' }}>
                <div className="absolute -top-10 -right-6 w-36 h-36 rounded-full blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(52,211,153,0.45), transparent 70%)' }} />
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center border border-white/[0.08] shrink-0 relative z-10"
                    style={{ background: 'linear-gradient(135deg, #34d39933, #34d3990a)', color: '#34d399', boxShadow: 'inset 0 0 16px #34d39922' }}>
                    <Robot size={24} weight="light" />
                </div>
                <div className="relative z-10 min-w-0 flex-1">
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/55">AI Agents</div>
                    <div className="text-[16px] font-semibold text-white mt-0.5">智能體</div>
                    <div className="text-[11px] text-white/55 mt-0.5 truncate">{aiSub}</div>
                </div>
                <CaretRight size={16} weight="bold" className="relative z-10 text-white/40 shrink-0" />
            </button>

            {/* Add app + my apps row */}
            <div className="grid grid-cols-2 gap-3.5 mb-7">
                <button onClick={() => setShowCreateModal(true)}
                    className={`${customApps.length ? '' : 'col-span-2'} rounded-[20px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]`}>
                    <Plus size={22} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">Add App</span>
                </button>
                {customApps.length > 0 && (
                    <button onClick={() => setPage(1)}
                        className="rounded-[20px] p-4 border border-white/[0.07] bg-white/[0.03] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[90px]">
                        <DotsThree size={26} weight="bold" className="text-white/60" />
                        <span className="text-[11px] tracking-[0.25em] uppercase text-white/50">My Apps · {customApps.length}</span>
                    </button>
                )}
            </div>

            {/* Today's activity */}
            <div className="rounded-[22px] p-4 border border-white/[0.07] bg-white/[0.025] backdrop-blur-xl mb-6">
                <div className="flex items-center justify-between mb-3.5">
                    <span className="text-[10px] tracking-[0.25em] uppercase text-white/45">Today's Activity</span>
                    <span className="text-[10px] text-white/35 flex items-center gap-0.5">More <CaretRight size={10} weight="bold" /></span>
                </div>
                <div className="flex gap-4">
                    <div className="flex-1 min-w-0 space-y-2.5">
                        {activity.length === 0 && <div className="text-[11px] text-white/30">尚無活動記錄</div>}
                        {activity.map((a, i) => (
                            <div key={i} className="flex items-center gap-3">
                                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i === activity.length - 1 ? '#c084fc' : 'rgba(255,255,255,0.3)' }} />
                                <span className="text-[11px] text-white/45 tabular-nums w-[58px] shrink-0">{fmtClock(a.t)}</span>
                                <span className="text-[12px] text-white/75 truncate">{a.label}</span>
                            </div>
                        ))}
                    </div>
                    <div className="relative w-24 h-24 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 100 100" className="w-24 h-24 -rotate-90">
                            <circle cx="50" cy="50" r="42" stroke="rgba(255,255,255,0.08)" strokeWidth="3" fill="none" />
                            <circle cx="50" cy="50" r="42" stroke="url(#stRing)" strokeWidth="3" fill="none" strokeLinecap="round"
                                strokeDasharray={RING_C} strokeDashoffset={RING_C * (1 - ringP)} />
                            <defs>
                                <linearGradient id="stRing" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0%" stopColor="#c084fc" />
                                    <stop offset="100%" stopColor="#8b9cff" />
                                </linearGradient>
                            </defs>
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <span className="text-[8px] tracking-[0.15em] uppercase text-white/40">Screen</span>
                            <span className="text-[14px] font-light text-white tabular-nums">{stH}h {stM}m</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Last seen */}
            <div className="flex items-center justify-center gap-1.5 text-white/35">
                <LockSimple size={12} weight="fill" />
                <span className="text-[11px] tracking-wide">{lastSeenText}</span>
            </div>
        </div>
    );

    const renderAppsPage = () => (
        <div className="w-1/2 h-full overflow-y-auto no-scrollbar overscroll-none px-6 pt-4 pb-32">
            <div className="flex items-center justify-between mb-6">
                <button onClick={() => setPage(0)} className="flex items-center gap-1 text-white/50 text-[12px]">
                    <CaretLeft size={14} weight="bold" /> Home
                </button>
                <span className="text-[11px] tracking-[0.3em] uppercase text-white/45">Installed Apps</span>
                <div className="w-12" />
            </div>
            <div className="grid grid-cols-2 gap-3.5">
                {customApps.map(app => {
                    const accent = app.color || '#8b9cff';
                    const count = records.filter(r => r.type === app.id).length;
                    return (
                        <div key={app.id} className="relative group">
                            {/* 長按編輯/卸載，跟 aiMenu 那套動作菜單同一個交互 */}
                            <button
                                {...longPress(() => setCustomAppMenu(app.id))}
                                onClick={() => { if (lpFired.current) { lpFired.current = false; return; } setActiveAppId(app.id); }}
                                className="w-full rounded-[24px] p-4 text-left overflow-hidden border border-white/[0.07] bg-white/[0.035] backdrop-blur-xl active:scale-[0.98] transition min-h-[130px] flex flex-col justify-between">
                                <div className="absolute -top-8 -right-8 w-28 h-28 rounded-full blur-2xl opacity-50 pointer-events-none"
                                    style={{ background: `radial-gradient(circle, ${accent}, transparent 70%)` }} />
                                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl border border-white/[0.08] relative z-10"
                                    style={{ background: `linear-gradient(135deg, ${accent}33, ${accent}0a)`, boxShadow: `inset 0 0 16px ${accent}22` }}>
                                    {app.icon}
                                </div>
                                <div className="relative z-10">
                                    <div className="text-[14px] font-semibold text-white truncate">{app.name}</div>
                                    <div className="text-[10.5px] text-white/40 mt-0.5">{count} 條記錄 · 長按編輯/卸載</div>
                                    <div className="h-[3px] w-8 rounded-full mt-2" style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }} />
                                </div>
                            </button>
                        </div>
                    );
                })}
                <button onClick={() => setShowCreateModal(true)}
                    className="rounded-[24px] p-4 border border-dashed border-white/15 bg-white/[0.02] flex flex-col items-center justify-center gap-2 active:scale-[0.98] transition min-h-[130px]">
                    <Plus size={24} weight="light" className="text-white/60" />
                    <span className="text-[11px] tracking-[0.2em] uppercase text-white/50">Add App</span>
                </button>
            </div>
        </div>
    );

    const renderDesktop = () => {
        const hasBg = !!dateBackgroundUrl;
        const totalPages = customApps.length > 0 ? 2 : 1;

        const onTouchStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
            touchStartY.current = e.touches[0].clientY;
        };
        const onTouchEnd = (e: React.TouchEvent) => {
            if (touchStartX.current == null || touchStartY.current == null) return;
            const dx = e.changedTouches[0].clientX - touchStartX.current;
            const dy = e.changedTouches[0].clientY - touchStartY.current;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                if (dx < 0 && page < totalPages - 1) setPage(page + 1);
                if (dx > 0 && page > 0) setPage(page - 1);
            }
            touchStartX.current = null;
            touchStartY.current = null;
        };

        return (
            <div className="absolute inset-0 flex flex-col z-0 overflow-hidden bg-[#070809]">
                {/* Cinematic background */}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'radial-gradient(120% 80% at 50% 0%, #1a1d2b 0%, #0a0c12 55%, #060709 100%)' }} />
                {hasBg && (
                    <div className="absolute inset-0 opacity-25 pointer-events-none"
                        style={{ backgroundImage: `url("${dateBackgroundUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
                )}
                <div className="absolute inset-0 pointer-events-none"
                    style={{ background: 'linear-gradient(to bottom, rgba(7,8,9,0.35) 0%, rgba(7,8,9,0.1) 30%, rgba(7,8,9,0.85) 100%)' }} />
                <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/15 to-transparent pointer-events-none z-20" />

                <StatusStrip />

                {/* Pager */}
                <div className="flex-1 relative z-10 overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                    <div className="flex h-full w-[200%] transition-transform duration-500 ease-out"
                        style={{ transform: `translateX(-${page * 50}%)` }}>
                        {renderHomePage()}
                        {renderAppsPage()}
                    </div>
                </div>

                {/* Page dots */}
                {totalPages > 1 && (
                    <div className="absolute bottom-[88px] left-1/2 -translate-x-1/2 flex gap-2 z-40">
                        {Array.from({ length: totalPages }).map((_, i) => (
                            <button key={i} onClick={() => setPage(i)}
                                className="rounded-full transition-all"
                                style={{ width: page === i ? 18 : 6, height: 6, background: page === i ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)' }} />
                        ))}
                    </div>
                )}

                {/* Floating glass nav */}
                <nav className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[90%] z-40">
                    <div className="bg-white/[0.06] backdrop-blur-2xl rounded-[26px] border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] flex justify-around items-center px-3 py-2.5">
                        <button onClick={() => setActiveAppId('call')} className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Phone size={22} weight="light" />
                        </button>
                        <button onClick={() => { setActiveAppId('album'); trackEvent('打开查手机子应用', { subApp: 'album' }); }} aria-label="相簿" className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <Stack size={22} weight="light" />
                        </button>
                        <button onClick={handleExitPhone} aria-label="斷開連接"
                            className="relative flex items-center justify-center w-14 h-14 rounded-full active:scale-90 transition -my-1"
                            style={{ background: 'radial-gradient(circle at 35% 30%, #b89bff, #6d5bd6 55%, #2a2150 100%)', boxShadow: '0 0 24px rgba(157,124,255,0.55), inset 0 0 18px rgba(255,255,255,0.25)' }}>
                            <SignOut size={22} weight="bold" className="text-white" />
                        </button>
                        <button onClick={() => { setActiveAppId('trajectory'); trackEvent('打开查手机子应用', { subApp: 'trajectory' }); }} aria-label="軌跡" className="flex items-center justify-center text-white/70 p-2.5 hover:text-white rounded-2xl transition active:scale-90">
                            <MapTrifold size={22} weight="light" />
                        </button>
                        <button onClick={toggleSendToChat} aria-label="同步到私聊"
                            className="relative flex items-center justify-center p-2.5 hover:text-white rounded-2xl transition active:scale-90"
                            style={{ color: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.4)' }}>
                            <GearSix size={22} weight={sendToChat ? 'fill' : 'light'} />
                            <span className="absolute bottom-1 right-1.5 w-1.5 h-1.5 rounded-full"
                                style={{ background: sendToChat ? '#7dd3fc' : 'rgba(255,255,255,0.25)', boxShadow: sendToChat ? '0 0 6px #7dd3fc' : 'none' }} />
                        </button>
                    </div>
                </nav>
            </div>
        );
    };

    // ============================================================
    //  TARGET-SELECT SCREEN
    // ============================================================
    if (view === 'select') {
        return (
            <div className="absolute inset-0 flex flex-col overflow-hidden text-white"
                style={{ background: 'radial-gradient(120% 80% at 50% 0%, #161826 0%, #0a0b10 60%)' }}>
                <StatusStrip />
                <div className="h-14 flex items-center justify-between px-4 shrink-0">
                    <button onClick={closeApp} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <CaretLeft size={18} weight="bold" />
                    </button>
                    <span className="font-semibold tracking-[0.25em] uppercase text-[13px] text-white/80">Target Device</span>
                    <button onClick={() => { setPhoneApiTestResult(null); setShowApiSettings(true); }} aria-label="查手機 API 設置"
                        className="relative w-9 h-9 rounded-full flex items-center justify-center text-white/75 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
                        <GearSix size={17} weight={phoneApiFollowsDefault ? 'regular' : 'fill'} />
                        {!phoneApiFollowsDefault && <span className="absolute right-1.5 bottom-1.5 h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_6px_#a78bfa]" />}
                    </button>
                </div>
                {(() => {
                    const PER_PAGE = 6;
                    const groupChars = filterCharactersByGroup(characters, characterGroups, selectGroupId);
                    const pageCount = Math.max(1, Math.ceil(groupChars.length / PER_PAGE));
                    const cur = Math.min(selectPage, pageCount - 1);
                    const pageChars = groupChars.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);
                    return (
                        <div className="flex-1 min-h-0 flex flex-col">
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} dark
                                value={selectGroupId} onChange={(id) => { setSelectGroupId(id); setSelectPage(0); }}
                                className="px-5 pt-1 shrink-0" />
                            <div className="flex-1 min-h-0 px-5 grid grid-cols-2 grid-rows-3 gap-4 content-center pb-4 pt-2">
                                {pageChars.map(c => (
                                    <div key={c.id} onClick={() => handleSelectChar(c)}
                                        className="min-h-0 rounded-3xl border border-white/[0.07] bg-white/[0.03] backdrop-blur-xl p-4 flex flex-col items-center justify-center gap-3 cursor-pointer active:scale-95 transition group hover:border-violet-400/50 hover:shadow-[0_0_24px_rgba(157,124,255,0.25)] relative overflow-hidden">
                                        <div className="absolute -top-10 -right-10 w-28 h-28 rounded-full blur-3xl bg-violet-500/0 group-hover:bg-violet-500/20 transition" />
                                        <div className="w-20 h-20 rounded-full p-[2px] border-2 border-white/15 group-hover:border-violet-400/70 transition-colors relative z-10 shrink-0">
                                            <TokenImg value={c.avatar} className="w-full h-full rounded-full object-cover grayscale group-hover:grayscale-0 transition-all" />
                                        </div>
                                        <div className="text-center relative z-10">
                                            <div className="font-semibold text-white/90 text-sm group-hover:text-violet-300">{c.name}</div>
                                            <div className="text-[10px] text-white/35 font-mono mt-1 tracking-widest">CONNECT &gt;</div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            {pageCount > 1 && (
                                <div className="shrink-0 flex items-center justify-center gap-4 pb-6 pt-3">
                                    <button onClick={() => setSelectPage(Math.max(0, cur - 1))} disabled={cur === 0}
                                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition disabled:opacity-30 disabled:active:scale-100">
                                        <CaretLeft size={16} weight="bold" />
                                    </button>
                                    <div className="flex items-center gap-2">
                                        {Array.from({ length: pageCount }, (_, pi) => (
                                            <button key={pi} onClick={() => setSelectPage(pi)} aria-label={`第 ${pi + 1} 頁`}
                                                className={`h-2 rounded-full transition-all active:scale-90 ${pi === cur ? 'w-5 bg-violet-400' : 'w-2 bg-white/25'}`} />
                                        ))}
                                    </div>
                                    <button onClick={() => setSelectPage(Math.min(pageCount - 1, cur + 1))} disabled={cur === pageCount - 1}
                                        className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition disabled:opacity-30 disabled:active:scale-100">
                                        <CaretLeft size={16} weight="bold" className="rotate-180" />
                                    </button>
                                </div>
                            )}
                        </div>
                    );
                })()}
                <Modal isOpen={showApiSettings} title="查手機 · API 設置" onClose={() => setShowApiSettings(false)}>
                    <div className="space-y-3">
                        <p className="text-[11px] leading-relaxed text-slate-500">
                            查手機裡的內容生成、人際關係對話、智能體和人格模擬都會走這裡。單獨選擇後不影響聊天；不設置則跟隨聊天默認。
                        </p>
                        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3.5">
                            <div className="text-[10px] tracking-[0.18em] text-slate-400 mb-1">當前生效</div>
                            <div className="text-[13px] font-bold text-slate-800 break-all">{effectiveApiConfig?.model || '未配置'}</div>
                            <div className="text-[10.5px] text-slate-400 mt-0.5 break-all">
                                {apiHost(effectiveApiConfig?.baseUrl)} · {phoneApiFollowsDefault ? '跟隨聊天默認' : '查手機獨立'}
                            </div>
                            <button onClick={testPhoneApi} disabled={testingPhoneApi}
                                className="mt-2.5 px-3 py-1.5 rounded-full bg-violet-100 text-violet-700 text-[11px] font-bold disabled:opacity-50">
                                {testingPhoneApi ? '測試中…' : '測試連接'}
                            </button>
                            {phoneApiTestResult && (
                                <div className={`mt-2 rounded-xl px-2.5 py-2 text-[10.5px] leading-relaxed ${phoneApiTestResult.startsWith('連接成功') ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                                    {phoneApiTestResult}
                                </div>
                            )}
                        </div>

                        <div className="text-[10px] tracking-[0.18em] text-slate-400 px-1">選擇 API</div>
                        <button onClick={() => choosePhoneApi(null)}
                            className={`w-full rounded-2xl border p-3 text-left transition ${phoneApiFollowsDefault ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                            <div className="flex items-center gap-2">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[12px] font-bold text-slate-800">跟隨聊天默認</div>
                                    <div className="text-[10px] text-slate-400 truncate">{apiConfig?.model || '未配置'} · {apiHost(apiConfig?.baseUrl)}</div>
                                </div>
                                {phoneApiFollowsDefault && <span className="text-[10px] font-bold text-violet-600">✓ 使用中</span>}
                            </div>
                        </button>

                        {apiPresets.length === 0 ? (
                            <p className="px-1 text-[10.5px] leading-relaxed text-slate-400">“設置”裡還沒有保存的 API 預設。先保存預設，這裡就能單獨選擇。</p>
                        ) : apiPresets.map(preset => {
                            const active = isSamePhoneApi(preset.config);
                            return (
                                <button key={preset.id} onClick={() => choosePhoneApi(preset.config)}
                                    className={`w-full rounded-2xl border p-3 text-left transition ${active ? 'border-violet-300 bg-violet-50' : 'border-slate-200 bg-white'}`}>
                                    <div className="flex items-center gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[12px] font-bold text-slate-800 truncate">{preset.name}</div>
                                            <div className="text-[10px] text-slate-400 truncate">{preset.config.model || '未配置'} · {apiHost(preset.config.baseUrl)}</div>
                                        </div>
                                        {active && <span className="text-[10px] font-bold text-violet-600">✓ 使用中</span>}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </Modal>
            </div>
        );
    }

    // ============================================================
    //  PHONE VIEW
    // ============================================================
    const customActive = customApps.find(a => a.id === activeAppId);
    return (
        <div className="absolute inset-0 bg-[#070809] overflow-hidden font-sans overscroll-none">
            {activeAppId === 'home' ? renderDesktop() : (
                <>
                    {activeAppId === 'chat' && renderChatList()}
                    {activeAppId === 'chat_detail' && renderChatDetail()}
                    {activeAppId === 'evidence_detail' && renderEvidenceDetail()}
                    {activeAppId === 'contacts' && renderContactsList()}
                    {activeAppId === 'contact_detail' && renderContactDetail()}
                    {activeAppId === 'call' && renderCallList()}
                    {activeAppId === 'taobao' && renderShop()}
                    {activeAppId === 'waimai' && renderFood()}
                    {activeAppId === 'social' && renderMoments()}
                    {activeAppId === 'aiagent' && renderAiAgent()}
                    {activeAppId === 'ai_session' && renderAiSession()}
                    {activeAppId === 'balance' && targetChar && (
                        <div className="absolute inset-0 w-full h-full bg-slate-50 overflow-y-auto no-scrollbar overscroll-contain z-[60]">
                            <RealBalancePanel
                                state={realBalanceState}
                                onCommit={next => updateCharacter(targetChar.id, (cur) => ({
                                    phoneState: { ...cur.phoneState, records: cur.phoneState?.records || [], realBalance: next },
                                }))}
                                onBack={() => setActiveAppId('home')}
                                addToast={addToast}
                            />
                        </div>
                    )}
                    {activeAppId === 'trajectory' && targetChar && (
                        <TrajectoryHome
                            targetChar={targetChar}
                            characters={characters}
                            npcs={npcs}
                            onBack={() => setActiveAppId('home')}
                            updateCharacter={updateCharacter}
                            apiConfig={effectiveApiConfig}
                            imageGenConfig={apiConfig.imageGenConfig}
                            addToast={addToast}
                        />
                    )}
                    {activeAppId === 'album' && targetChar && (
                        <TrajectoryAlbum targetChar={targetChar} onBack={() => setActiveAppId('home')} addToast={addToast} />
                    )}
                    {activeAppId === 'persona' && targetChar && (
                        <PersonaSim targetChar={targetChar} onExit={() => setActiveAppId('home')} openLifeLog={() => setActiveAppId('lifelog')}
                            sim={sim} onStart={runSim} onConsumed={() => personaSimStore.reset()} />
                    )}
                    {activeAppId === 'lifelog' && targetChar && (
                        <LifeLog targetChar={targetChar} onBack={() => setActiveAppId('home')}
                            onRequestDelete={requestDeleteSimLog}
                            onReplay={(log) => {
                                if (!log.script) return;
                                // 用存下來的腳本快照原樣回放——直接餵給全局 store 的 ready 態
                                personaSimStore.set({ status: 'ready', mode: log.mode, theme: log.theme, script: log.script, replay: true, charId: targetChar.id, charName: targetChar.name });
                                setActiveAppId('persona');
                            }} />
                    )}
                    {customActive && renderCustomApp(customActive)}
                </>
            )}

            {/* InnerState 全文 —— 「此刻內心」專屬卡片 */}
            {showInner && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-fade-in">
                    <div className="absolute inset-0 bg-black/40" onClick={() => setShowInner(false)} />
                    <div className="relative w-full max-w-sm bg-white rounded-[2.5rem] shadow-2xl overflow-hidden animate-slide-up">
                        {/* 標題 + 星點 */}
                        <div className="px-6 pt-7 pb-3 flex items-center justify-center gap-2.5">
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current mb-1" /></span>
                            <h3 className="text-lg font-bold text-slate-800">TA 此刻的內心</h3>
                            <span className="flex items-end gap-0.5 text-[#b3c2f6]"><span className="w-1 h-1 rounded-full bg-current mb-1" /><span className="w-1.5 h-1.5 rounded-full bg-current" /><span className="w-1 h-1 rounded-full bg-current" /></span>
                        </div>
                        {/* 引文面板 */}
                        <div className="px-6 pb-2">
                            <div className="relative bg-slate-50 rounded-3xl px-5 pt-7 pb-5 max-h-[52vh] overflow-y-auto no-scrollbar">
                                <span className="absolute top-2 left-4 text-[42px] leading-none font-black select-none pointer-events-none" style={{ color: '#5f82ef' }}>“</span>
                                <p className="relative text-[14.5px] leading-[2] text-slate-600 whitespace-pre-wrap px-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                    {innerQuote}
                                </p>
                                <span className="block text-right text-[42px] leading-none font-black select-none pointer-events-none pr-2" style={{ color: '#5f82ef' }}>”</span>
                            </div>
                        </div>
                        {/* 關閉 */}
                        <div className="px-6 pb-6 pt-3">
                            <button onClick={() => setShowInner(false)}
                                className="w-full py-3.5 rounded-2xl text-white font-bold active:scale-[0.99] transition"
                                style={{ background: '#5f82ef' }}>關閉</button>
                        </div>
                    </div>
                </div>
            )}

            {/* 查手機記錄 · 長按後可事後補同步到私聊 */}
            {evidenceMenu && (
                <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setEvidenceMenu(null)}>
                    <div className="absolute inset-0 bg-black/50" />
                    <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={event => event.stopPropagation()}>
                        <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                            <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">查手機記錄：{evidenceMenu.record.title}</div>
                            {/* 聊天歸檔（type: chat）是舊版歸檔，標了"只讀"——detail 是 parseTranscript
                                依賴的"我:.../對方:..."結構，自由文本編輯會把格式改壞，不接這個入口 */}
                            {evidenceMenu.record.type !== 'chat' && (
                                <button onClick={() => openEditRecord(evidenceMenu.record)}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"
                                ><PencilSimple size={17} /> 編輯</button>
                            )}
                            <button
                                onClick={() => void syncEvidenceRecordToChat(evidenceMenu.record)}
                                disabled={!!evidenceMenu.record.systemMessageId}
                                className="w-full px-4 py-3.5 text-left text-[14px] text-sky-300 active:bg-white/5 transition flex items-center gap-3 disabled:text-white/30 border-t border-white/10"
                            ><PaperPlaneTilt size={17} /> {evidenceMenu.record.systemMessageId ? '已同步到私聊' : '同步到私聊'}</button>
                            <button onClick={() => {
                                const record = evidenceMenu.record;
                                setEvidenceMenu(null);
                                askConfirm({ title: '刪除這條記錄？', desc: `刪除「${record.title}」後無法恢復。`, confirmLabel: '刪除', danger: true, onConfirm: () => handleDeleteRecord(record) });
                            }} className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 刪除記錄</button>
                        </div>
                        <button onClick={() => setEvidenceMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                    </div>
                </div>
            )}

            {/* 查手機記錄 · 編輯（任意 App 的任意記錄都能改，不再只能刪） */}
            <Modal isOpen={!!evidenceEdit} title="編輯記錄" onClose={() => setEvidenceEdit(null)}
                footer={<button onClick={handleUpdateRecord} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">保存修改</button>}>
                {evidenceEdit && (
                    <div className="space-y-4">
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">標題</label>
                            <input value={evidenceEdit.title} onChange={e => setEvidenceEdit({ ...evidenceEdit, title: e.target.value })}
                                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">數值/狀態（可選）</label>
                            <input value={evidenceEdit.value} onChange={e => setEvidenceEdit({ ...evidenceEdit, value: e.target.value })}
                                placeholder="如 ¥129.00 / 未接 (5分鐘)"
                                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">詳細內容</label>
                            <textarea value={evidenceEdit.detail} onChange={e => setEvidenceEdit({ ...evidenceEdit, detail: e.target.value })}
                                className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                        {evidenceEdit.record.html && (
                            <p className="text-[9px] text-slate-400 leading-relaxed">這條記錄原本有一張生成的 HTML 卡片，保存修改後會先回退成純文字展示（內容跟卡片對不上就不硬湊），下次點「刷新數據」會按最新文字重新配一張。</p>
                        )}
                    </div>
                )}
            </Modal>

            {/* 聯繫人聊天記錄 · 編輯單條消息（長按選中一條後，多選操作欄的「編輯」按鈕打開） */}
            <Modal isOpen={!!msgEdit} title="編輯這條消息" onClose={() => setMsgEdit(null)}
                footer={<button onClick={handleUpdateMessage} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">保存修改</button>}>
                {msgEdit && (
                    <textarea value={msgEdit.text} onChange={e => setMsgEdit({ ...msgEdit, text: e.target.value })}
                        className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm resize-none" autoFocus />
                )}
            </Modal>

            {/* 自定義 App 圖標 · 長按動作菜單（編輯設置 / 卸載） */}
            {customAppMenu && (() => {
                const app = customApps.find(a => a.id === customAppMenu);
                if (!app) return null;
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setCustomAppMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={event => event.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">{app.icon} {app.name}</div>
                                <button onClick={() => openEditCustomApp(app)}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> 編輯設置</button>
                                <button onClick={() => {
                                    setCustomAppMenu(null);
                                    askConfirm({
                                        title: `卸載「${app.name}」？`, desc: '已生成的記錄不會被立即刪掉，但卸載後這個 App 從桌面消失，就再也打不開、也看不到它們了。', confirmLabel: '卸載', danger: true,
                                        onConfirm: () => handleDeleteApp(app.id),
                                    });
                                }} className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 卸載</button>
                            </div>
                            <button onClick={() => setCustomAppMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                        </div>
                    </div>
                );
            })()}

            {/* 智能體 · 長按動作菜單（會話/卡片：編輯 / 刪除） */}
            {aiMenu && (() => {
                const isSession = aiMenu.kind === 'session';
                const sObj = isSession ? aiSessions.find(s => s.id === aiMenu.id) : null;
                const cObj = !isSession ? aiCards.find(c => c.id === aiMenu.id) : null;
                if (isSession ? !sObj : !cObj) return null;
                const name = isSession ? (sObj!.title || '會話') : (cObj!.name || '卡片');
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setAiMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={e => e.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">{isSession ? '會話' : (cObj!.kind === 'world' ? '世界卡' : '角色卡')}：{name}</div>
                                <button onClick={() => { setAiEdit(isSession ? { kind: 'session', id: aiMenu.id, title: sObj!.title } : { kind: 'card', id: aiMenu.id, name: cObj!.name, emoji: cObj!.emoji, persona: cObj!.persona, scenario: cObj!.scenario }); setAiMenu(null); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> 編輯</button>
                                <button onClick={() => { const id = aiMenu.id; const k = isSession; setAiMenu(null); askConfirm({ title: k ? `刪除會話「${sObj!.title}」？` : `刪除${cObj!.kind === 'world' ? '世界卡' : '角色卡'}「${cObj!.name}」？`, desc: k ? '這段對話記錄會被刪除，無法撤銷。' : '這張卡會被刪除（已有對戲記錄保留），無法撤銷。', confirmLabel: '刪除', danger: true, onConfirm: () => (k ? handleDeleteAiSession : handleDeleteAiCard)(id) }); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 刪除</button>
                            </div>
                            <button onClick={() => setAiMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                        </div>
                    </div>
                );
            })()}

            {/* 智能體 · 會話內單條內容 長按動作菜單（編輯 / 刪除） */}
            {aiTurnMenu !== null && selectedAiSession && (() => {
                const turns = turnsOf(selectedAiSession);
                const turn = turns[aiTurnMenu];
                if (!turn) return null;
                const preview = turn.text.replace(/\n/g, ' ').trim().slice(0, 22);
                return (
                    <div className="fixed inset-0 z-[120] flex items-end justify-center animate-fade-in" onClick={() => setAiTurnMenu(null)}>
                        <div className="absolute inset-0 bg-black/50" />
                        <div className="relative w-full max-w-sm m-3 mb-6 space-y-2" onClick={e => e.stopPropagation()}>
                            <div className="rounded-2xl overflow-hidden bg-[#1c1d22] border border-white/10">
                                <div className="px-4 py-2.5 text-[12px] text-white/50 border-b border-white/10 truncate">這條內容：{preview}…</div>
                                <button onClick={() => { setAiTurnEdit({ idx: aiTurnMenu, text: turn.text }); setAiTurnMenu(null); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-white active:bg-white/5 transition flex items-center gap-3"><PencilSimple size={17} /> 編輯</button>
                                <button onClick={() => { const idx = aiTurnMenu; setAiTurnMenu(null); askConfirm({ title: '刪除這條內容？', desc: '只刪這一條對話/樓層，無法撤銷。', confirmLabel: '刪除', danger: true, onConfirm: () => handleDeleteAiTurn(idx) }); }}
                                    className="w-full px-4 py-3.5 text-left text-[14px] text-rose-400 active:bg-white/5 transition flex items-center gap-3 border-t border-white/10"><Trash size={17} /> 刪除</button>
                            </div>
                            <button onClick={() => setAiTurnMenu(null)} className="w-full rounded-2xl bg-[#1c1d22] border border-white/10 py-3.5 text-[14px] font-semibold text-white/80">取消</button>
                        </div>
                    </div>
                );
            })()}

            {/* 智能體 · 會話內單條內容 編輯彈窗 */}
            <Modal isOpen={!!aiTurnEdit} title="編輯這條內容" onClose={() => setAiTurnEdit(null)}
                footer={<button onClick={handleSaveAiTurn} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">保存</button>}>
                {aiTurnEdit && (
                    <textarea value={aiTurnEdit.text} onChange={e => setAiTurnEdit({ ...aiTurnEdit, text: e.target.value })}
                        className="w-full h-48 bg-slate-50 border border-slate-200 rounded-xl p-3 text-sm resize-none leading-relaxed" />
                )}
            </Modal>

            {/* 智能體 · 編輯彈窗 */}
            <Modal isOpen={!!aiEdit} title={aiEdit?.kind === 'session' ? '編輯會話' : aiEdit?.id === '__new__' ? '新建角色卡' : '編輯角色卡'} onClose={() => setAiEdit(null)}
                footer={<button onClick={handleSaveAiEdit} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">{aiEdit?.id === '__new__' ? '創建' : '保存'}</button>}>
                {aiEdit && (aiEdit.kind === 'session' ? (
                    <div className="space-y-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase block">標題</label>
                        <input value={aiEdit.title || ''} onChange={e => setAiEdit({ ...aiEdit, title: e.target.value })} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                    </div>
                ) : (
                    <div className="space-y-3">
                        {aiEdit.id === '__new__' && (
                            <div className="flex gap-2">
                                {(['character', 'world'] as const).map(k => (
                                    <button key={k} onClick={() => setAiEdit({ ...aiEdit, cardKind: k })}
                                        className={`flex-1 py-2 rounded-lg text-xs font-semibold border transition ${(aiEdit.cardKind || 'character') === k ? 'bg-violet-500 text-white border-violet-500' : 'bg-slate-50 text-slate-500 border-slate-200'}`}>
                                        {k === 'character' ? '角色卡' : '世界卡'}
                                    </button>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <input value={aiEdit.emoji || ''} onChange={e => setAiEdit({ ...aiEdit, emoji: e.target.value })} placeholder="🎭" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                            <input value={aiEdit.name || ''} onChange={e => setAiEdit({ ...aiEdit, name: e.target.value })} placeholder="卡片名" className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">人設 / 設定</label>
                            <textarea value={aiEdit.persona || ''} onChange={e => setAiEdit({ ...aiEdit, persona: e.target.value })} className="w-full h-20 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">場景</label>
                            <textarea value={aiEdit.scenario || ''} onChange={e => setAiEdit({ ...aiEdit, scenario: e.target.value })} className="w-full h-16 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none" />
                        </div>
                    </div>
                ))}
            </Modal>

            {/* 智能體 · 角色卡詳情（看 TA 用這張玩過哪些 + 用這張卡開一局） */}
            {aiCardView && (() => {
                const c = aiCards.find(x => x.id === aiCardView);
                if (!c) return null;
                const plays = aiSessions.filter(s => s.service === 'tavern' && s.cardId === c.id).sort((a, b) => b.updatedAt - a.updatedAt);
                return (
                    <Modal isOpen={true} title={c.kind === 'world' ? '世界卡' : '角色卡'} onClose={() => setAiCardView(null)}
                        footer={<button onClick={() => handlePlayCard(c)} disabled={isLoading}
                            className="w-full py-3 bg-rose-500 text-white font-bold rounded-2xl disabled:opacity-50">{isLoading ? '生成中…' : '用這張卡開一局'}</button>}>
                        <div className="space-y-3">
                            <div className="flex items-start gap-3">
                                <div className="text-3xl shrink-0">{c.emoji}</div>
                                <div className="min-w-0">
                                    <div className="text-base font-bold text-slate-800 flex items-center gap-2 flex-wrap">{c.name}
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-100 text-rose-500">{c.kind === 'world' ? '世界卡' : '角色卡'}</span>
                                    </div>
                                    {(c.basedOnUser || c.basedOn) && <div className="text-[11px] text-rose-400 mt-0.5">⚑ 照著{c.basedOnUser ? '你' : `「${c.basedOn}」`}捏的</div>}
                                </div>
                            </div>
                            {c.persona && <div className="text-[12px] text-slate-600 leading-relaxed bg-slate-50 rounded-xl p-3 whitespace-pre-wrap">{c.persona}</div>}
                            {c.scenario && <div className="text-[12px] text-slate-500 leading-relaxed bg-slate-50 rounded-xl p-3 italic whitespace-pre-wrap">場景：{c.scenario}</div>}
                            <div>
                                <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">TA 用這張卡玩過 · {plays.length}</div>
                                {plays.length === 0 && <div className="text-[12px] text-slate-400">還沒有對戲記錄——點下面「用這張卡開一局」讓 TA 玩起來。</div>}
                                <div className="space-y-1.5 max-h-48 overflow-y-auto no-scrollbar">
                                    {plays.map(s => (
                                        <button key={s.id} onClick={() => { setAiCardView(null); setSelectedAiSessionId(s.id); setActiveAppId('ai_session'); }}
                                            className="w-full text-left rounded-xl p-2.5 bg-slate-50 active:bg-slate-100 transition">
                                            <div className="text-[13px] font-semibold text-slate-700 truncate">{s.title}</div>
                                            <div className="text-[10px] text-slate-400">{parseTranscript(s.transcript).length} 條 · {fmtClock(s.updatedAt)}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </Modal>
                );
            })()}

            {/* Create App Modal */}
            <Modal isOpen={showCreateModal} title={editingAppId ? '編輯自定義 App' : '安裝自定義 App'} onClose={closeCreateAppModal}
                footer={<button onClick={handleSaveCustomApp} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl">{editingAppId ? '保存修改' : '安裝到桌面'}</button>}>
                <div className="space-y-4">
                    <div className="flex gap-4">
                        <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl shadow-md border border-white/10 shrink-0"
                            style={{ background: `linear-gradient(135deg, ${newAppColor}55, ${newAppColor}15)` }}>
                            {newAppIcon}
                        </div>
                        <div className="flex-1 space-y-2">
                            <input value={newAppName} onChange={e => setNewAppName(e.target.value)} placeholder="App 名稱 (如: 銀行)" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                            <div className="flex gap-2">
                                <input value={newAppIcon} onChange={e => setNewAppIcon(e.target.value)} placeholder="Emoji" className="w-16 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-center" />
                                <input type="color" value={newAppColor} onChange={e => setNewAppColor(e.target.value)} className="h-9 flex-1 cursor-pointer rounded-lg bg-transparent" />
                            </div>
                        </div>
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">功能指令 (AI Prompt)</label>
                        <textarea
                            value={newAppPrompt}
                            onChange={e => setNewAppPrompt(e.target.value)}
                            placeholder="例如: 顯示該用戶的存款餘額、近期的轉帳記錄以及理財收益。"
                            className="w-full h-24 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs resize-none"
                        />
                        <p className="text-[9px] text-slate-400 mt-1">AI 將根據此指令生成該 App 內部的數據。</p>
                    </div>

                    {/* HTML 卡片：關閉=原版純文字（現狀）；開啟後用下面的指令額外生成卡片視覺，
                        發進聊天上下文的內容永遠只有 title/detail/value 純文字，不受這個開關影響 */}
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[12px] font-bold text-slate-700">HTML 卡片</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-relaxed">關閉時就是原版純文字；打開後才使用下面的 HTML 卡片指令。</p>
                            </div>
                            <button type="button" onClick={() => setNewAppHtmlEnabled(v => !v)}
                                className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-colors ${newAppHtmlEnabled ? 'bg-violet-500 text-white' : 'bg-slate-200 text-slate-500'}`}>
                                {newAppHtmlEnabled ? '開' : '關'}
                            </button>
                        </div>
                        {newAppHtmlEnabled && (
                            <>
                                <textarea
                                    value={newAppHtmlPrompt}
                                    onChange={e => setNewAppHtmlPrompt(e.target.value)}
                                    placeholder="可以寫自然語言卡片指令，也可以粘貼固定 HTML 模板；模板可用 {{title}}、{{detail}}、{{value}} 或自定義佔位符。"
                                    className="w-full h-24 bg-white border border-slate-200 rounded-xl p-3 text-xs resize-none mt-3"
                                />
                                <p className="text-[9px] text-slate-400 mt-1 leading-relaxed">打開但不填寫時不會生成卡片，會自動回到原版純文字。固定 HTML 模板會比普通描述更穩定。</p>
                            </>
                        )}
                    </div>

                    {/* CSS 樣式：只在渲染卡片的沙盒 iframe 內生效，出不了這個卡片區域 */}
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[12px] font-bold text-slate-700">CSS 樣式</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-relaxed">高級樣式。開啟並填寫 CSS 後優先使用；CSS 為空時繼續按 HTML 卡片指令處理。</p>
                            </div>
                            <button type="button" onClick={() => setNewAppCssEnabled(v => !v)}
                                className={`shrink-0 px-3.5 py-1.5 rounded-full text-[12px] font-bold transition-colors ${newAppCssEnabled ? 'bg-fuchsia-500 text-white' : 'bg-slate-200 text-slate-500'}`}>
                                {newAppCssEnabled ? '開' : '關'}
                            </button>
                        </div>
                        {newAppCssEnabled && (
                            <>
                                <textarea
                                    value={newAppCss}
                                    onChange={e => setNewAppCss(e.target.value)}
                                    placeholder={'例如：\n.phone-card { padding: 16px; border-radius: 20px; background: rgba(15,23,42,.88); color: white; }\n.phone-card-title { font-size: 18px; font-weight: 800; }'}
                                    className="w-full h-24 bg-white border border-slate-200 rounded-xl p-3 text-xs font-mono resize-none mt-3"
                                />
                                <p className="text-[9px] text-slate-400 mt-1 leading-relaxed">建議用 .phone-card、.phone-card-title、.phone-card-section 等類名；系統會把 CSS 限制在這個 App 卡片區域裡。</p>
                            </>
                        )}
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">界面樣板 (UI Style)</label>
                        <div className="grid grid-cols-2 gap-2">
                            {APP_LAYOUTS.map(l => {
                                const active = newAppLayout === l.id;
                                return (
                                    <button key={l.id} type="button" onClick={() => setNewAppLayout(l.id)}
                                        className={`text-left rounded-xl p-2.5 border transition flex items-center gap-2.5 ${active ? 'border-transparent text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
                                        style={active ? { background: newAppColor } : undefined}>
                                        <span className="text-lg leading-none shrink-0">{l.icon}</span>
                                        <div className="min-w-0">
                                            <div className="text-[12px] font-bold leading-tight">{l.name}</div>
                                            <div className={`text-[9px] leading-tight truncate ${active ? 'text-white/80' : 'text-slate-400'}`}>{l.desc}</div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </Modal>

            {/* 新建聯繫人 / 智能體 Modal */}
            <Modal isOpen={showContactModal} title="添加聯繫人" onClose={closeAddContactModal}
                footer={<button onClick={handleCreateContact} disabled={ncGenerating} className="w-full py-3 bg-pink-500 text-white font-bold rounded-2xl disabled:opacity-60">{ncGenerating ? '生成中…' : '添加'}</button>}>
                <div className="space-y-4">
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-2">類型</label>
                        <div className="grid grid-cols-2 gap-2">
                            {([
                                { id: 'npc', name: 'NPC', desc: '虛構路人' },
                                { id: 'real', name: '真人', desc: '綁定神經鏈接角色' },
                            ] as const).map(opt => {
                                const active = ncKind === opt.id;
                                return (
                                    <button key={opt.id} type="button" onClick={() => setNcKind(opt.id)}
                                        className={`text-left rounded-xl p-2.5 border transition ${active ? 'border-transparent bg-pink-500 text-white' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                                        <div className="text-[12px] font-bold leading-tight">{opt.name}</div>
                                        <div className={`text-[9px] leading-tight ${active ? 'text-white/80' : 'text-slate-400'}`}>{opt.desc}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {ncKind === 'real' ? (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">綁定真實角色</label>
                            <select value={ncLinkedId} onChange={e => setNcLinkedId(e.target.value)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                                <option value="">— 選擇一個角色 —</option>
                                {characters.filter(c => c.id !== targetChar?.id).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <p className="text-[9px] text-slate-400 mt-1">真人之間可發起雙向對話，對話會同步進對方的手機。</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                {([
                                    { id: 'existing', name: '綁定既有 NPC', desc: '從「神經鏈接」裡選一個' },
                                    { id: 'random', name: '隨機產生', desc: '機主腦補，AI 現編一個' },
                                ] as const).map(opt => {
                                    const active = ncNpcMode === opt.id;
                                    const disabled = opt.id === 'existing' && npcs.length === 0;
                                    return (
                                        <button key={opt.id} type="button" disabled={disabled} onClick={() => setNcNpcMode(opt.id)}
                                            className={`text-left rounded-xl p-2.5 border transition ${active ? 'border-transparent bg-pink-500 text-white' : 'border-slate-200 bg-slate-50 text-slate-600'} ${disabled ? 'opacity-40' : ''}`}>
                                            <div className="text-[12px] font-bold leading-tight">{opt.name}</div>
                                            <div className={`text-[9px] leading-tight ${active ? 'text-white/80' : 'text-slate-400'}`}>{opt.desc}</div>
                                        </button>
                                    );
                                })}
                            </div>
                            {ncNpcMode === 'existing' ? (
                                npcs.length > 0 ? (
                                    <div>
                                        <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">綁定 NPC</label>
                                        <select value={ncLinkedId} onChange={e => setNcLinkedId(e.target.value)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                                            <option value="">— 選擇一個 NPC —</option>
                                            {npcs.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                                        </select>
                                        <p className="text-[9px] text-slate-400 mt-1">對話仍是機主單方面腦補，但會參考這個 NPC 在「神經鏈接」裡設定的人設和關係。</p>
                                    </div>
                                ) : (
                                    <p className="text-[11px] text-slate-400 leading-relaxed">
                                        還沒有 NPC——請先去「神經鏈接」→「NPC」分頁建一個，再回來綁定。
                                    </p>
                                )
                            ) : (
                                <div>
                                    <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">簡短提示方向（可選）</label>
                                    <input value={ncRandomHint} onChange={e => setNcRandomHint(e.target.value)}
                                        placeholder="不填就完全隨機，比如：常來蹭飯的鄰居阿姨"
                                        className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                                    <p className="text-[9px] text-slate-400 mt-1">不綁定任何既有 NPC 檔案，AI 會現編一個名字和身份，寫進備註當固定設定。</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </Modal>

            {/* 改綁定 Modal：把聯繫人改綁到正確的真實角色 / 轉為虛構（保留對話+備註+瞭解+好感） */}
            <Modal isOpen={showRebindModal} title="改綁定" onClose={() => setShowRebindModal(false)}>
                {selectedContact && (
                    <div className="space-y-3">
                        <p className="text-[11.5px] text-slate-500 leading-relaxed">
                            甄別/綁定錯了在這改。會保留這段對話、備註、瞭解和好感；改成真人會把對話同步進對方手機，原來錯綁的角色那邊會清掉。
                        </p>
                        {/* 轉為純虛構（不綁定任何既有 NPC） */}
                        <button
                            onClick={() => handleRebindContact(selectedContact, { kind: 'npc' })}
                            disabled={selectedContact.kind === 'npc' && !selectedContact.linkedNpcId}
                            className={`w-full flex items-center gap-2.5 rounded-xl p-3 border text-left transition ${selectedContact.kind === 'npc' && !selectedContact.linkedNpcId ? 'border-slate-200 bg-slate-100 opacity-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                            <span className="w-8 h-8 rounded-lg bg-slate-200 flex items-center justify-center text-slate-500 shrink-0"><User size={16} weight="bold" /></span>
                            <div className="min-w-0">
                                <div className="text-[13px] font-bold text-slate-700">轉為純虛構聯繫人</div>
                                <div className="text-[10px] text-slate-400">不綁定真實角色 / NPC，機主腦補{selectedContact.kind === 'npc' && !selectedContact.linkedNpcId ? '（當前就是）' : ''}</div>
                            </div>
                        </button>
                        {/* 綁定到真實角色 */}
                        <div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">綁定到真實角色</div>
                            <div className="max-h-64 overflow-y-auto space-y-1.5 no-scrollbar">
                                {characters.filter(c => c.id !== targetChar?.id).length === 0 && (
                                    <p className="text-[11px] text-slate-400 px-1 py-2">神經鏈接裡沒有其它角色可綁。</p>
                                )}
                                {characters.filter(c => c.id !== targetChar?.id).map(rc => {
                                    const current = selectedContact.kind === 'real' && selectedContact.linkedCharId === rc.id;
                                    return (
                                        <button key={rc.id}
                                            onClick={() => handleRebindContact(selectedContact, { kind: 'real', charId: rc.id })}
                                            disabled={current}
                                            className={`w-full flex items-center gap-2.5 rounded-xl p-2.5 border text-left transition ${current ? 'border-pink-300 bg-pink-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                                            <TokenImg value={rc.avatar} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                            <span className="text-[13px] font-semibold text-slate-700 flex-1 truncate">{rc.name}</span>
                                            {current && <span className="text-[10px] font-bold text-pink-500 shrink-0">當前綁定</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        {/* 綁定到既有 NPC */}
                        <div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">綁定到 NPC</div>
                            <div className="max-h-64 overflow-y-auto space-y-1.5 no-scrollbar">
                                {npcs.length === 0 && (
                                    <p className="text-[11px] text-slate-400 px-1 py-2">還沒有 NPC，請先去「神經鏈接」→「NPC」分頁建一個。</p>
                                )}
                                {npcs.map(n => {
                                    const current = selectedContact.kind === 'npc' && selectedContact.linkedNpcId === n.id;
                                    return (
                                        <button key={n.id}
                                            onClick={() => handleRebindContact(selectedContact, { kind: 'npc', npcId: n.id })}
                                            disabled={current}
                                            className={`w-full flex items-center gap-2.5 rounded-xl p-2.5 border text-left transition ${current ? 'border-pink-300 bg-pink-50' : 'border-slate-200 bg-slate-50 active:scale-[0.99]'}`}>
                                            <TokenImg value={n.avatar} alt="" className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                            <span className="text-[13px] font-semibold text-slate-700 flex-1 truncate">{n.name}</span>
                                            {current && <span className="text-[10px] font-bold text-pink-500 shrink-0">當前綁定</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            {/* 話題盒記憶 · 編輯/刪除（長按某條記憶打開） */}
            <Modal isOpen={!!topicEdit} title="聊天記憶" onClose={() => setTopicEdit(null)}
                footer={topicEdit ? (
                    <div className="flex gap-2">
                        <button onClick={() => {
                            const { contactId, topicId } = topicEdit;
                            mutateContacts(cs => cs.map(c => c.id === contactId ? { ...c, topicBox: (c.topicBox || []).filter(t => t.id !== topicId) } : c));
                            setTopicEdit(null);
                            addToast('已刪除該條記憶', 'success');
                        }} className="px-4 py-3 bg-rose-500 text-white font-bold rounded-2xl">刪除</button>
                        <button onClick={() => {
                            const { contactId, topicId, text } = topicEdit;
                            mutateContacts(cs => cs.map(c => c.id === contactId ? { ...c, topicBox: (c.topicBox || []).map(t => t.id === topicId ? { ...t, text: text.trim() } : t) } : c));
                            setTopicEdit(null);
                            addToast('已保存', 'success');
                        }} className="flex-1 py-3 bg-pink-500 text-white font-bold rounded-2xl">保存</button>
                    </div>
                ) : undefined}>
                {topicEdit && (
                    <div className="space-y-2">
                        <p className="text-[11px] text-slate-400">這是角色第一人稱、帶主觀色彩的一段聊天記憶（用作上下文）。可改寫或刪除。</p>
                        <textarea value={topicEdit.text} onChange={e => setTopicEdit({ ...topicEdit, text: e.target.value })}
                            className="w-full h-32 bg-slate-50 border border-slate-200 rounded-xl p-3 text-[13px] resize-none" />
                    </div>
                )}
            </Modal>

            {/* 通用二次確認彈窗：刪除 / 移除 / 拉黑 / 清空都走這裡 */}
            <Modal
                isOpen={!!confirmState}
                title={confirmState?.title || ''}
                onClose={() => setConfirmState(null)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setConfirmState(null)}
                            className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button onClick={() => { const cb = confirmState?.onConfirm; setConfirmState(null); cb?.(); }}
                            className={`flex-1 py-3 font-bold rounded-2xl text-white active:scale-95 transition-transform ${confirmState?.danger ? 'bg-rose-500' : 'bg-pink-500'}`}>
                            {confirmState?.confirmLabel || '確定'}
                        </button>
                    </div>
                }>
                <p className="text-[13px] text-slate-500 leading-relaxed text-center">{confirmState?.desc || '此操作無法撤銷。'}</p>
            </Modal>
        </div>
    );
};

export default CheckPhone;
