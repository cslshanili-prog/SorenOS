import { avatarDecorationImageStyle, isAnniversaryFrame } from '../../utils/anniversaryGifts';



import React, { useEffect, useRef, useState } from 'react';
const AivenFishSaleReceipt = React.lazy(() => import('../../apps/vrWorld/AivenFishSaleReceipt').then(module => ({ default: module.AivenFishSaleReceipt })));
import { Message, ChatTheme } from '../../types';
import { phoneFieldToText } from '../../utils/phoneEvidence';
import { tryParseLifeSimResetCard } from '../../utils/lifeSimChatCard';
import { VALID_INTERJECTION_TAGS, cleanVoiceMarkupForDisplay } from '../../utils/minimaxTts';
import { stripFishCuesForDisplay } from '../../utils/fishAudioTts';
import { formatStatCount } from '../../utils/videoParser';
import { trackEvent } from '../../utils/analytics';
import { resolveBubbleCornerRadii, shouldHideBubbleTail } from '../../utils/bubbleAppearance';
import { isImageValue, useBlobRefUrl } from '../../utils/blobRef';
import { buildReplySnapshotContent } from '../../utils/applyAssistantPostProcessing';
import { stripLeakedSourceTags } from '../../utils/sanitize';
import TokenImg from '../os/TokenImg';
import { SARSpeechSwitch } from '../sar/SARSpeechSwitch';
import McdCard from './McdCard';
import MallOrderCard from './MallOrderCard';
import HtmlCard from './HtmlCard';
import LuckinCard from './LuckinCard';
import LuckinCheckoutCard from './LuckinCheckoutCard';
import QixiEventCardView from './QixiEventCard';
import { includesAnyScript } from '../../utils/scriptKey';

// 思考鏈卡片支持的 12 種風格預設 — 同時被 MessageItem 與 ThinkingChainSettingsModal 複用
export type ThinkingChainStyleId = 'echo' | 'whisper' | 'minimal' | 'ink' | 'neon' | 'terminal' | 'stellar' | 'tama' | 'pixel' | 'muji' | 'ins' | 'custom';
export interface ThinkingChainStyleSpec {
    bg: string;            // 卡片背景（可以是 CSS gradient）
    border: string;        // 邊框色
    accent: string;        // 標題/裝飾點綴
    text: string;          // 正文顏色
    subtext: string;       // 副標題/狀態文字
    glow?: string;         // 右上角微光 radial 顏色（可選）
    fadeColor?: string;    // 展開滾動區上下軟漸變顏色（可選）
    fontFamily: string;    // 正文字體
    showCorners: boolean;  // 四角裝飾括號
    showDivider: boolean;  // 標題下分隔線
    titleZh: string;       // 中文標題
    titleEn: string;       // 英文副標題
    listenLabel: string;   // 摺疊態右側文字
    silenceLabel: string;  // 展開態右側文字
    quoteLeft: string;     // 摺疊態首句左引號
    quoteRight: string;    // 摺疊態首句右引號
    italic: boolean;       // 是否斜體
    radius: string;        // 圓角
    /** 邊框寬度（默認 1px）——像素框/電子雞殼等擬態風格用粗框 */
    borderWidth?: string;
    /** 卡片投影完全覆蓋（不設則走 glow 默認邏輯）——硬像素影/ins 軟影/機殼圈 */
    cardShadow?: string;
    /** 卡片內部整面覆蓋層：掃描線（CRT）/ 點陣（液晶屏） */
    overlay?: 'scanlines' | 'dotMatrix';
    /** 破格裝飾：溢出卡片邊框的風格化元素（印章/霓虹括角/終端紅綠燈/星子/機殼按鈕…），由 PsycheDecor 渲染 */
    decoKind?: 'inkSeal' | 'neonGlitch' | 'termHud' | 'starScatter' | 'tamaShell' | 'pixelArrow' | 'insHeart';
}

const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STKaiti", "KaiTi", serif';
const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, "Courier New", monospace';
const PIXEL = '"Zpix", "Fusion Pixel 12px", "DotGothic16", "Silver", "Courier New", monospace';

export const THINKING_CHAIN_PRESETS: Record<Exclude<ThinkingChainStyleId, 'custom'>, ThinkingChainStyleSpec> = {
    echo: {
        bg: 'linear-gradient(135deg, #2a1f3d 0%, #1d1530 45%, #2a1834 100%)',
        border: 'rgba(201, 169, 106, 0.35)',
        accent: '#c9a96a',
        text: '#e9d9b8',
        subtext: 'rgba(233, 217, 184, 0.62)',
        glow: 'rgba(201, 169, 106, 0.28)',
        fadeColor: '#1d1530',
        fontFamily: SERIF,
        showCorners: true,
        showDivider: true,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移開視線',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '4px',
    },
    whisper: {
        bg: 'linear-gradient(135deg, rgba(251, 247, 242, 0.96) 0%, rgba(245, 238, 247, 0.86) 50%, rgba(248, 240, 240, 0.92) 100%)',
        border: 'rgba(216, 196, 200, 0.55)',
        accent: '#9a7d83',
        text: '#5b4b50',
        subtext: 'rgba(154, 125, 131, 0.7)',
        glow: 'rgba(212, 184, 192, 0.35)',
        fadeColor: '#fbf7f2',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移開視線',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '14px',
    },
    minimal: {
        bg: '#ffffff',
        border: 'rgba(15, 23, 42, 0.12)',
        accent: '#475569',
        text: '#1e293b',
        subtext: 'rgba(71, 85, 105, 0.6)',
        fadeColor: '#ffffff',
        fontFamily: SANS,
        showCorners: false,
        showDivider: false,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移開視線',
        quoteLeft: '"',
        quoteRight: '"',
        italic: false,
        radius: '10px',
    },
    ink: {
        bg: 'linear-gradient(160deg, #f9f6ee 0%, #f2ecdf 60%, #ece4d4 100%)',
        border: 'rgba(70, 60, 48, 0.28)',
        accent: '#4a4238',
        text: '#3d3830',
        subtext: 'rgba(74, 66, 56, 0.55)',
        fadeColor: '#f4efe3',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '墨跡',
        titleEn: 'INK',
        listenLabel: '展卷',
        silenceLabel: '收卷',
        quoteLeft: '「',
        quoteRight: '」',
        italic: false,
        radius: '2px',
        decoKind: 'inkSeal',
    },
    neon: {
        bg: 'linear-gradient(135deg, #0b1026 0%, #10173a 55%, #1a0f2e 100%)',
        border: 'rgba(94, 234, 212, 0.4)',
        accent: '#5eead4',
        text: '#c8f4ff',
        subtext: 'rgba(94, 234, 212, 0.6)',
        glow: 'rgba(94, 234, 212, 0.32)',
        fadeColor: '#10173a',
        fontFamily: SANS,
        showCorners: true,
        showDivider: false,
        titleZh: '腦域',
        titleEn: 'NEURO-LINK',
        listenLabel: '接入',
        silenceLabel: '斷開',
        quoteLeft: '⟨',
        quoteRight: '⟩',
        italic: false,
        radius: '8px',
        overlay: 'scanlines',
        decoKind: 'neonGlitch',
    },
    terminal: {
        bg: '#0b120d',
        border: 'rgba(74, 222, 128, 0.35)',
        accent: '#4ade80',
        text: '#a7e8b4',
        subtext: 'rgba(74, 222, 128, 0.55)',
        glow: 'rgba(74, 222, 128, 0.18)',
        fadeColor: '#0b120d',
        fontFamily: MONO,
        showCorners: false,
        showDivider: true,
        titleZh: '內核',
        titleEn: 'KERNEL.LOG',
        listenLabel: 'tail -f',
        silenceLabel: '^C',
        quoteLeft: '$ ',
        quoteRight: '',
        italic: false,
        radius: '6px',
        decoKind: 'termHud',
    },
    stellar: {
        bg: 'linear-gradient(180deg, #0d1b2a 0%, #16263c 60%, #22344e 100%)',
        border: 'rgba(168, 199, 250, 0.35)',
        accent: '#a8c7fa',
        text: '#dce8ff',
        subtext: 'rgba(168, 199, 250, 0.62)',
        glow: 'rgba(168, 199, 250, 0.3)',
        fadeColor: '#16263c',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '星語',
        titleEn: 'STELLAR',
        listenLabel: '仰望',
        silenceLabel: '垂眸',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '12px',
        decoKind: 'starScatter',
    },
    // 拓麻歌子：粉殼 + 液晶點陣屏，框本身擬態成電子寵物機
    tama: {
        bg: 'linear-gradient(180deg, #d6e2c2 0%, #c8d6b0 100%)',
        border: '#f2a5c4',
        accent: '#44562f',
        text: '#3f5230',
        subtext: 'rgba(68, 86, 47, 0.6)',
        fadeColor: '#cfdbb9',
        fontFamily: PIXEL,
        showCorners: false,
        showDivider: true,
        titleZh: '心寵',
        titleEn: 'TMGC-LOG',
        listenLabel: '餵食',
        silenceLabel: '哄睡',
        quoteLeft: '▶',
        quoteRight: '',
        italic: false,
        radius: '16px',
        borderWidth: '3px',
        cardShadow: '0 0 0 3px rgba(242, 165, 196, 0.35), 0 3px 8px rgba(120, 80, 100, 0.18)',
        overlay: 'dotMatrix',
        decoKind: 'tamaShell',
    },
    // 像素：JRPG 對話框，白粗框 + 硬像素投影
    pixel: {
        bg: '#23255e',
        border: '#ffffff',
        accent: '#ffd75e',
        text: '#f2f3ff',
        subtext: 'rgba(242, 243, 255, 0.65)',
        fadeColor: '#23255e',
        fontFamily: PIXEL,
        showCorners: false,
        showDivider: false,
        titleZh: '任務',
        titleEn: 'QUEST.LOG',
        listenLabel: '繼續',
        silenceLabel: '合上',
        quoteLeft: '『',
        quoteRight: '』',
        italic: false,
        radius: '2px',
        borderWidth: '3px',
        cardShadow: '4px 4px 0 rgba(0, 0, 0, 0.4)',
        decoKind: 'pixelArrow',
    },
    // 性冷淡：暖灰米白、細線、留白，什麼裝飾都不要
    muji: {
        bg: '#f7f6f3',
        border: 'rgba(60, 60, 54, 0.14)',
        accent: '#8a8a84',
        text: '#4d4d48',
        subtext: 'rgba(90, 90, 84, 0.5)',
        fadeColor: '#f7f6f3',
        fontFamily: SANS,
        showCorners: false,
        showDivider: true,
        titleZh: '獨白',
        titleEn: 'MONOLOGUE',
        listenLabel: '展開',
        silenceLabel: '收起',
        quoteLeft: '',
        quoteRight: '',
        italic: false,
        radius: '6px',
    },
    // ins：白卡軟影 feed 風，右上一顆小紅心
    ins: {
        bg: '#ffffff',
        border: 'rgba(0, 0, 0, 0.07)',
        accent: '#e1306c',
        text: '#262626',
        subtext: '#8e8e8e',
        fadeColor: '#ffffff',
        fontFamily: SANS,
        showCorners: false,
        showDivider: false,
        titleZh: '碎碎念',
        titleEn: 'STORIES',
        listenLabel: '查看',
        silenceLabel: '收起',
        quoteLeft: '“',
        quoteRight: '”',
        italic: false,
        radius: '16px',
        cardShadow: '0 4px 16px rgba(0, 0, 0, 0.07)',
        decoKind: 'insHeart',
    },
};

export function resolveThinkingChainStyle(
    styleId?: ThinkingChainStyleId,
    customColors?: { bg?: string; accent?: string; text?: string },
): ThinkingChainStyleSpec {
    if (styleId === 'custom') {
        const bg = customColors?.bg || '#1f2937';
        const accent = customColors?.accent || '#fbbf24';
        const text = customColors?.text || '#f1f5f9';
        return {
            ...THINKING_CHAIN_PRESETS.echo,
            bg,
            border: accent,
            accent,
            text,
            subtext: text,
            glow: accent,
            fadeColor: bg,
            titleZh: '心象',
            titleEn: 'PSYCHE',
            listenLabel: '凝望',
            silenceLabel: '移開視線',
        };
    }
    return THINKING_CHAIN_PRESETS[styleId || 'echo'] || THINKING_CHAIN_PRESETS.echo;
}

// 心象卡片的「破格」裝飾：溢出卡片邊框的風格化元素。
// 必須渲染在卡片（overflow-hidden）的兄弟層、且父容器 relative + 不裁剪，才能真的探出邊框。
// 被 ThinkingChainBlock 與設置彈窗的 StylePreview 共用；compact 用於迷你預覽縮小尺寸。
export const PsycheDecor: React.FC<{ spec: ThinkingChainStyleSpec; compact?: boolean }> = ({ spec, compact }) => {
    switch (spec.decoKind) {
        case 'inkSeal': // 右下角壓出邊框的朱文印
            return (
                <span
                    aria-hidden
                    className="absolute z-10 pointer-events-none flex items-center justify-center font-bold"
                    style={{
                        bottom: compact ? -4 : -7,
                        right: compact ? -2 : -4,
                        width: compact ? 15 : 23,
                        height: compact ? 15 : 23,
                        background: '#b3382c',
                        color: '#f7ede0',
                        fontSize: compact ? 8 : 12,
                        fontFamily: SERIF,
                        borderRadius: 3,
                        transform: 'rotate(9deg)',
                        boxShadow: '0 1px 3px rgba(80, 20, 10, 0.4)',
                        opacity: 0.92,
                    }}
                >心</span>
            );
        case 'neonGlitch': // 探出四角的霓虹括角（青 × 品紅錯位殘影）
            return (
                <>
                    <span aria-hidden className={`absolute z-10 pointer-events-none border-t-2 border-l-2 ${compact ? '-top-0.5 -left-0.5 w-2 h-2' : '-top-1 -left-1 w-3 h-3'}`} style={{ borderColor: spec.accent, filter: `drop-shadow(0 0 3px ${spec.accent})` }} />
                    <span aria-hidden className={`absolute z-10 pointer-events-none border-b-2 border-r-2 ${compact ? '-bottom-0.5 -right-0.5 w-2 h-2' : '-bottom-1 -right-1 w-3 h-3'}`} style={{ borderColor: '#f0abfc', filter: 'drop-shadow(0 0 3px #f0abfc)' }} />
                </>
            );
        case 'termHud': // 頂出上邊框的窗口紅綠燈
            return (
                <span aria-hidden className="absolute z-10 pointer-events-none flex gap-1" style={{ top: compact ? -2 : -3, right: compact ? 8 : 12 }}>
                    {['#ff5f56', '#ffbd2e', '#27c93f'].map(c => (
                        <span key={c} className="rounded-full" style={{ width: compact ? 4 : 6, height: compact ? 4 : 6, background: c, boxShadow: `0 0 4px ${c}88` }} />
                    ))}
                </span>
            );
        case 'starScatter': // 綴在邊框內外的星子
            return (
                <>
                    <span aria-hidden className="absolute z-10 pointer-events-none animate-pulse" style={{ top: compact ? -5 : -8, right: compact ? 10 : 16, color: spec.accent, fontSize: compact ? 8 : 12, textShadow: spec.glow ? `0 0 6px ${spec.glow}` : undefined }}>✦</span>
                    <span aria-hidden className="absolute z-10 pointer-events-none" style={{ top: compact ? 6 : 10, right: compact ? -4 : -6, color: spec.accent, fontSize: compact ? 6 : 8, opacity: 0.75 }}>✧</span>
                    <span aria-hidden className="absolute z-10 pointer-events-none animate-pulse" style={{ bottom: compact ? -3 : -5, left: compact ? 12 : 20, color: spec.accent, fontSize: compact ? 5 : 7, opacity: 0.6, animationDelay: '0.8s' }}>✦</span>
                </>
            );
        case 'tamaShell': // 底邊探出的機殼三按鈕（電子寵物機的 A/B/C 鍵）
            return (
                <span aria-hidden className="absolute z-10 pointer-events-none flex" style={{ bottom: compact ? -5 : -8, left: '50%', transform: 'translateX(-50%)', gap: compact ? 5 : 8 }}>
                    {[0, 1, 2].map(i => (
                        <span
                            key={i}
                            className="rounded-full"
                            style={{
                                width: compact ? 5 : 8,
                                height: compact ? 5 : 8,
                                background: 'radial-gradient(circle at 35% 30%, #fbc9dd, #ee8fb6)',
                                boxShadow: '0 1px 2px rgba(150, 80, 110, 0.45), inset 0 0.5px 1px rgba(255,255,255,0.7)',
                            }}
                        />
                    ))}
                </span>
            );
        case 'pixelArrow': // JRPG「還有下文」的閃爍小三角，壓在右下邊框上
            return (
                <span
                    aria-hidden
                    className="absolute z-10 pointer-events-none animate-pulse"
                    style={{
                        bottom: compact ? -4 : -7,
                        right: compact ? 8 : 14,
                        color: spec.accent,
                        fontSize: compact ? 8 : 12,
                        textShadow: '1px 1px 0 rgba(0,0,0,0.5)',
                    }}
                >▼</span>
            );
        case 'insHeart': // 右上角一顆小紅心，feed 點贊感
            return (
                <span
                    aria-hidden
                    className="absolute z-10 pointer-events-none"
                    style={{
                        top: compact ? -5 : -7,
                        right: compact ? 8 : 14,
                        color: spec.accent,
                        fontSize: compact ? 9 : 13,
                        transform: 'rotate(10deg)',
                        filter: 'drop-shadow(0 1px 2px rgba(225, 48, 108, 0.35))',
                    }}
                >♥</span>
            );
        default:
            return null;
    }
};

// 思考鏈卡片：可視化 metadata.thinkingChain。
// 內容來源：useChatAI 抽取的 LLM reasoning_content + <think>/<thinking>/<thought>。
// 多風格通過 resolveThinkingChainStyle() 統一渲染；齒輪觸發 onOpenSettings 進入設置彈窗。
export const ThinkingChainBlock: React.FC<{
    chain: string;
    styleId?: ThinkingChainStyleId;
    customColors?: { bg?: string; accent?: string; text?: string };
    onOpenSettings?: () => void;
}> = ({ chain, styleId, customColors, onOpenSettings }) => {
    const [expanded, setExpanded] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'ready' | 'ok' | 'error'>('idle');
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pointerIdRef = useRef<number | null>(null);
    const pointerTypeRef = useRef<React.PointerEvent<HTMLDivElement>['pointerType'] | ''>('');
    const pointerStartRef = useRef({ x: 0, y: 0 });
    const longPressReadyRef = useRef(false);
    const suppressNextClickRef = useRef(false);
    const trimmed = (chain || '').trim();
    const spec = resolveThinkingChainStyle(styleId, customColors);
    const firstLine = trimmed.replace(/\s+/g, ' ').slice(0, 38);
    const hasMore = trimmed.length > 38;

    const clearCopyTimer = () => {
        if (copyTimerRef.current) {
            clearTimeout(copyTimerRef.current);
            copyTimerRef.current = null;
        }
    };

    useEffect(() => () => {
        clearCopyTimer();
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    }, []);

    if (!trimmed) return null;

    const copyThinkingChain = async () => {
        let success = false;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            await navigator.clipboard.writeText(trimmed);
            success = true;
        } catch {
            // iOS PWA / 非安全上下文可能拒絕 Clipboard API，保留 textarea 兜底。
            let textarea: HTMLTextAreaElement | null = null;
            try {
                textarea = document.createElement('textarea');
                textarea.value = trimmed;
                textarea.setAttribute('readonly', '');
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                textarea.style.pointerEvents = 'none';
                document.body.appendChild(textarea);
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                success = document.execCommand('copy');
            } catch {
                success = false;
            } finally {
                textarea?.remove();
            }
        }

        setCopyState(success ? 'ok' : 'error');
        if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
        feedbackTimerRef.current = setTimeout(() => setCopyState('idle'), 1600);
        trackEvent('长按复制心象全文');
    };

    const resetLongPress = () => {
        clearCopyTimer();
        longPressReadyRef.current = false;
        if (copyState === 'ready') setCopyState('idle');
    };

    // 必須由 pointerup / touchend / contextmenu 這類真實用戶手勢直接調用。
    // Safari 會拒絕在長按 setTimeout 回調裡發起的剪貼板寫入。
    const finishLongPressCopy = () => {
        if (!longPressReadyRef.current) return false;
        clearCopyTimer();
        longPressReadyRef.current = false;
        suppressNextClickRef.current = true;
        void copyThinkingChain();
        return true;
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        pointerTypeRef.current = e.pointerType;
        if (e.button !== 0) return;
        pointerIdRef.current = e.pointerId;
        pointerStartRef.current = { x: e.clientX, y: e.clientY };
        longPressReadyRef.current = false;
        suppressNextClickRef.current = false;
        clearCopyTimer();
        copyTimerRef.current = setTimeout(() => {
            copyTimerRef.current = null;
            longPressReadyRef.current = true;
            setCopyState('ready');
            try { navigator.vibrate?.(20); } catch { /* vibration is optional */ }
        }, 450);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (pointerIdRef.current !== e.pointerId) return;
        const dx = e.clientX - pointerStartRef.current.x;
        const dy = e.clientY - pointerStartRef.current.y;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) resetLongPress();
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        if (!finishLongPressCopy()) resetLongPress();
    };

    const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (pointerIdRef.current !== e.pointerId) return;
        pointerIdRef.current = null;
        clearCopyTimer();
        // iOS 彈出原生選區時可能先派發 pointercancel，隨後仍會派發 touchend。
        // 此時保留 ready，讓 touchend 仍可在真實用戶手勢中執行復制。
        if (e.pointerType !== 'touch' || !longPressReadyRef.current) resetLongPress();
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        if (suppressNextClickRef.current) {
            suppressNextClickRef.current = false;
            e.preventDefault();
            return;
        }
        setExpanded(v => !v);
    };

    const copyStatusLabel = copyState === 'ok'
        ? '已複製'
        : copyState === 'ready'
            ? '鬆開複製'
            : copyState === 'error'
                ? '請用系統複製'
                : expanded ? spec.silenceLabel : spec.listenLabel;

    return (
        <div
            className="sully-psyche relative mb-2 w-full max-w-full select-text cursor-pointer group"
            role="button"
            tabIndex={0}
            aria-label="心象：點擊展開，長按複製全文"
            title="長按複製心象全文"
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onTouchEnd={(e) => {
                e.stopPropagation();
                finishLongPressCopy();
            }}
            onContextMenu={(e) => {
                e.stopPropagation();
                // 觸屏保留 Safari 原生藍色選區與複製菜單，作為剪貼板權限受限時的兜底。
                if (pointerTypeRef.current !== 'mouse') return;
                e.preventDefault();
                suppressNextClickRef.current = false;
                void copyThinkingChain();
            }}
            onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                setExpanded(v => !v);
            }}
            style={{
                touchAction: 'pan-y',
                userSelect: 'text',
                WebkitUserSelect: 'text',
                WebkitTouchCallout: 'default',
            }}
        >
            <div
                className="sully-psyche-card relative overflow-hidden px-4 py-2.5 transition-all duration-300"
                style={{
                    background: spec.bg,
                    border: `${spec.borderWidth || '1px'} solid ${spec.border}`,
                    borderRadius: spec.radius,
                    boxShadow: spec.cardShadow
                        ? spec.cardShadow
                        : spec.glow
                            ? `0 2px 8px rgba(20, 10, 30, 0.18), inset 0 0 24px ${spec.glow.replace(/[\d.]+\)$/, '0.06)')}`
                            : '0 1px 3px rgba(15, 23, 42, 0.08)',
                }}
            >
                {/* 四角裝飾括號 */}
                {spec.showCorners && (
                    <>
                        <span aria-hidden className="absolute top-1 left-1 w-2 h-2 border-t border-l pointer-events-none" style={{ borderColor: spec.accent }} />
                        <span aria-hidden className="absolute top-1 right-1 w-2 h-2 border-t border-r pointer-events-none" style={{ borderColor: spec.accent }} />
                        <span aria-hidden className="absolute bottom-1 left-1 w-2 h-2 border-b border-l pointer-events-none" style={{ borderColor: spec.accent }} />
                        <span aria-hidden className="absolute bottom-1 right-1 w-2 h-2 border-b border-r pointer-events-none" style={{ borderColor: spec.accent }} />
                    </>
                )}
                {/* 右上角微光 */}
                {spec.glow && (
                    <div
                        aria-hidden
                        className="absolute -top-8 -right-8 w-20 h-20 rounded-full opacity-40 pointer-events-none"
                        style={{ background: `radial-gradient(circle, ${spec.glow} 0%, transparent 70%)` }}
                    />
                )}
                {/* 內部整面覆蓋層：CRT 掃描線 / 液晶點陣 */}
                {spec.overlay === 'scanlines' && (
                    <div
                        aria-hidden
                        className="absolute inset-0 pointer-events-none opacity-[0.13]"
                        style={{ background: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(94, 234, 212, 0.6) 3px, transparent 4px)' }}
                    />
                )}
                {spec.overlay === 'dotMatrix' && (
                    <div
                        aria-hidden
                        className="absolute inset-0 pointer-events-none opacity-[0.18]"
                        style={{ background: 'radial-gradient(rgba(60, 80, 40, 0.55) 0.5px, transparent 0.6px)', backgroundSize: '3px 3px' }}
                    />
                )}

                {/* 標題行 */}
                <div className="relative flex items-center gap-2">
                    <span
                        className="sully-psyche-title text-[13px] font-semibold tracking-[0.4em]"
                        style={{
                            color: spec.accent,
                            fontFamily: spec.fontFamily,
                            textShadow: spec.glow ? `0 0 8px ${spec.glow}` : undefined,
                        }}
                    >
                        {spec.titleZh}
                    </span>
                    <span className="text-[8.5px] tracking-[0.32em] opacity-70" style={{ color: spec.text }}>
                        {spec.titleEn}
                    </span>
                    {spec.showCorners && (
                        <span aria-hidden className="text-[7px] mx-0.5" style={{ color: spec.border }}>◆</span>
                    )}
                    <span
                        className="ml-auto text-[10px] tracking-[0.18em] transition-opacity opacity-65 group-hover:opacity-100"
                        style={{ color: spec.subtext }}
                    >
                        {copyStatusLabel}
                    </span>
                </div>

                {/* 裝飾橫線 */}
                {spec.showDivider && (
                    <div className="relative mt-1.5 mb-0.5 flex items-center gap-1.5" aria-hidden>
                        <span className="h-px flex-1" style={{ background: `linear-gradient(to right, transparent, ${spec.border}, transparent)` }} />
                        <span className="text-[6px]" style={{ color: spec.accent }}>◇</span>
                        <span className="h-px flex-1" style={{ background: `linear-gradient(to right, transparent, ${spec.border}, transparent)` }} />
                    </div>
                )}

                {!expanded && (
                    <div
                        className={`sully-psyche-preview relative mt-1.5 text-[12px] leading-snug truncate ${spec.italic ? 'italic' : ''}`}
                        style={{ color: spec.text, fontFamily: spec.fontFamily }}
                    >
                        <span style={{ color: spec.accent, marginRight: 2 }}>{spec.quoteLeft}</span>
                        {firstLine}{hasMore ? '…' : ''}
                        <span style={{ color: spec.accent, marginLeft: 2 }}>{spec.quoteRight}</span>
                        {spec.decoKind === 'termHud' && <span className="animate-pulse" style={{ color: spec.accent, marginLeft: 3 }}>▊</span>}
                    </div>
                )}
                {expanded && (
                    <div className="relative mt-1.5">
                        {/* 上下軟漸變蓋掉系統滾動條; fadeColor 跟卡片背景一致 */}
                        {spec.fadeColor && (
                            <>
                                <div aria-hidden className="absolute top-0 left-0 right-0 h-3 pointer-events-none z-10" style={{ background: `linear-gradient(to bottom, ${spec.fadeColor} 0%, transparent 100%)` }} />
                                <div aria-hidden className="absolute bottom-0 left-0 right-0 h-3 pointer-events-none z-10" style={{ background: `linear-gradient(to top, ${spec.fadeColor} 0%, transparent 100%)` }} />
                            </>
                        )}
                        <div
                            className={`sully-psyche-body no-scrollbar relative pl-3 pr-1 py-2 text-[12.5px] leading-[1.85] whitespace-pre-wrap break-words max-h-72 overflow-auto ${spec.italic ? 'italic' : ''}`}
                            style={{
                                color: spec.text,
                                fontFamily: spec.fontFamily,
                                borderLeft: `1px solid ${spec.border}`,
                                textShadow: spec.glow ? '0 0 6px rgba(0, 0, 0, 0.4)' : undefined,
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {trimmed}
                        </div>
                    </div>
                )}
            </div>
            {/* 破格裝飾渲染在卡片外層（卡片自身 overflow-hidden 裁不掉它） */}
            <PsycheDecor spec={spec} />
        </div>
    );
};

// --- Forward Card with expand/collapse ---
const ForwardCard: React.FC<{
    forwardData: any;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    interactionProps: any;
    selectionMode: boolean;
}> = ({ forwardData, commonLayout, selectionMode }) => {
    const [expanded, setExpanded] = useState(false);

    const handleCardClick = (e: React.MouseEvent) => {
        if (selectionMode) return;
        e.stopPropagation();
        setExpanded(true);
    };

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    return (
        <>
            {commonLayout(
                <div className="w-64 bg-white rounded-2xl overflow-hidden shadow-sm border border-slate-100 active:scale-[0.98] transition-transform cursor-pointer" onClick={handleCardClick}>
                    <div className="px-4 pt-3 pb-2 border-b border-slate-50">
                        <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 text-primary"><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" /></svg>
                            {forwardData.fromUserName} 和 {forwardData.fromCharName} 的聊天記錄
                        </div>
                    </div>
                    <div className="px-4 py-2 space-y-1">
                        {(forwardData.preview || []).slice(0, 4).map((line: string, i: number) => (
                            <div key={i} className="text-[11px] text-slate-500 truncate leading-relaxed">{line}</div>
                        ))}
                    </div>
                    <div className="px-4 py-2 border-t border-slate-50 text-[10px] text-slate-400 flex items-center justify-between">
                        <span>共 {forwardData.count || 0} 條聊天記錄</span>
                        <span className="text-primary font-medium">點擊查看</span>
                    </div>
                </div>
            )}

            {/* Expanded Full-screen Overlay */}
            {expanded && (
                <div className="fixed inset-0 z-[100] bg-slate-50 flex flex-col animate-fade-in" style={{ paddingBottom: 'var(--safe-bottom)' }} onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="pt-[calc(var(--safe-top)+0.75rem)] pb-3 px-4 bg-white border-b border-slate-100 shrink-0 flex items-center gap-3">
                        <button onClick={() => setExpanded(false)} className="p-2 -ml-2 rounded-full hover:bg-slate-100 text-slate-600">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-slate-700 truncate">{forwardData.fromUserName} 和 {forwardData.fromCharName} 的聊天記錄</div>
                            <div className="text-[10px] text-slate-400">共 {forwardData.count || 0} 條消息</div>
                        </div>
                    </div>

                    {/* Messages List */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {(forwardData.messages || []).map((msg: any, i: number) => {
                            const isUser = msg.role === 'user';
                            const senderName = isUser ? forwardData.fromUserName : forwardData.fromCharName;
                            return (
                                <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
                                        <div className="text-[10px] text-slate-400 mb-1 px-1">{senderName} {msg.timestamp ? formatTime(msg.timestamp) : ''}</div>
                                        <div className={`px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-all ${isUser ? 'bg-primary text-white rounded-br-sm' : 'bg-white text-slate-700 rounded-bl-sm shadow-sm border border-slate-100'}`}>
                                            {msg.type === 'image' ? (msg.content ? <TokenImg value={msg.content} className="max-w-[200px] rounded-xl" /> : <span className="italic opacity-60">[圖片已丟失]</span>) :
                                             msg.type === 'emoji' ? (msg.content ? <TokenImg value={msg.content} className="max-w-[100px]" /> : <span className="italic opacity-60">[表情已丟失]</span>) :
                                             msg.content}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </>
    );
};

// ============================================================
// 轉帳卡片：點開看精美詳情，可接收 / 退回；回執則渲染成小卡
// ============================================================

type TransferStatus = 'pending' | 'accepted' | 'returned';

const SullyPayMark: React.FC<{ className?: string }> = ({ className }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
        <path d="M12 7.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5Z" />
        <path fillRule="evenodd" d="M1.5 4.875C1.5 3.839 2.34 3 3.375 3h17.25c1.035 0 1.875.84 1.875 1.875v9.75c0 1.036-.84 1.875-1.875 1.875H3.375A1.875 1.875 0 0 1 1.5 14.625v-9.75ZM8.25 9.75a3.75 3.75 0 1 1 7.5 0 3.75 3.75 0 0 1-7.5 0ZM18.75 9a.75.75 0 0 0-.75.75v.008c0 .414.336.75.75.75h.008a.75.75 0 0 0 .75-.75V9.75a.75.75 0 0 0-.75-.75h-.008ZM4.5 9.75A.75.75 0 0 1 5.25 9h.008a.75.75 0 0 1 .75.75v.008a.75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75V9.75Z" clipRule="evenodd" />
        <path d="M2.25 18a.75.75 0 0 0 0 1.5c5.4 0 10.63.722 15.6 2.075 1.19.324 2.4-.558 2.4-1.82V18.75a.75.75 0 0 0-.75-.75H2.25Z" />
    </svg>
);

// ─── 生活記錄代記卡（角色 [[LIFE:...]] 落庫後插入；用戶可確認 / 否決）───
const LIFE_CARD_STYLE: Record<string, { icon: string; ring: string; bg: string; label: string }> = {
    period: { icon: '🌙', ring: '#fda4af', bg: 'linear-gradient(135deg,#fff1f2 0%,#ffe4e6 100%)', label: '生理期' },
    med: { icon: '💊', ring: '#7dd3fc', bg: 'linear-gradient(135deg,#f0f9ff 0%,#e0f2fe 100%)', label: '藥盒' },
    expense: { icon: '🧾', ring: '#fcd34d', bg: 'linear-gradient(135deg,#fffbeb 0%,#fef3c7 100%)', label: '記帳' },
    exercise: { icon: '🏃', ring: '#6ee7b7', bg: 'linear-gradient(135deg,#ecfdf5 0%,#d1fae5 100%)', label: '鍛鍊' },
};

const LifeRecordCard: React.FC<{
    m: Message;
    charName: string;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    selectionMode: boolean;
    onResolveLifeRecord?: (m: Message, action: 'confirmed' | 'rejected') => void;
}> = ({ m, charName, commonLayout, selectionMode, onResolveLifeRecord }) => {
    const meta = m.metadata || {};
    const style = LIFE_CARD_STYLE[meta.module as string] || LIFE_CARD_STYLE.exercise;
    const summary: string = meta.summary || '生活記錄';
    const isDuplicate: boolean = !!meta.duplicate;
    const reviewStatus: 'active' | 'confirmed' | 'rejected' = meta.reviewStatus || 'active';
    const canResolve = !isDuplicate && reviewStatus === 'active' && !!onResolveLifeRecord && !selectionMode;
    const dateLabel = (() => {
        const d = (meta.dateStr || '').split('-');
        return d.length === 3 ? `${parseInt(d[1], 10)}月${parseInt(d[2], 10)}日` : '';
    })();

    return commonLayout(
        <div className="w-64 rounded-2xl overflow-hidden shadow-sm border border-white/70" style={{ background: style.bg }}>
            <div className="px-3.5 pt-3 pb-2.5">
                <div className="flex items-center gap-2.5">
                    <div className="shrink-0 w-9 h-9 rounded-full bg-white/80 flex items-center justify-center text-lg shadow-sm"
                        style={{ boxShadow: `0 0 0 2px ${style.ring}55` }}>
                        {style.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className={`text-xs font-bold text-slate-700 truncate ${reviewStatus === 'rejected' ? 'line-through opacity-50' : ''}`}>
                            {summary}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5">
                            {style.label}{dateLabel ? ` · ${dateLabel}` : ''} · {meta.recordedByName || charName} 代記
                        </div>
                    </div>
                </div>

                {isDuplicate ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-500 bg-white/60 rounded-xl px-2.5 py-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3 text-emerald-500 shrink-0"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                        <span>此前已由「{meta.duplicateBy || '其他角色'}」記錄，無需重複</span>
                    </div>
                ) : reviewStatus === 'confirmed' ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-emerald-600 font-semibold px-1">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={3} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                        已確認
                    </div>
                ) : reviewStatus === 'rejected' ? (
                    <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400 font-semibold px-1">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor" className="w-3 h-3"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                        已否決（記錄已撤銷，TA 下次會知道弄錯了）
                    </div>
                ) : canResolve ? (
                    <div className="mt-2.5 flex gap-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); onResolveLifeRecord?.(m, 'confirmed'); trackEvent('处理角色代记的生活记录', { result: 'confirmed' }); }}
                            className="flex-1 py-1.5 rounded-xl bg-white/85 text-emerald-600 text-[11px] font-bold shadow-sm active:scale-95 transition-transform"
                        >
                            ✓ 確認
                        </button>
                        <button
                            onClick={(e) => { e.stopPropagation(); onResolveLifeRecord?.(m, 'rejected'); trackEvent('处理角色代记的生活记录', { result: 'rejected' }); }}
                            className="flex-1 py-1.5 rounded-xl bg-white/60 text-slate-500 text-[11px] font-bold shadow-sm active:scale-95 transition-transform"
                        >
                            ✗ 否決
                        </button>
                    </div>
                ) : null}
            </div>
            <div className="px-3.5 py-1.5 bg-white/40 border-t border-white/60 text-[9px] text-slate-400">
                📋 生活記錄
            </div>
        </div>
    );
};

const TransferCard: React.FC<{
    m: Message;
    isUser: boolean;
    charName: string;
    commonLayout: (content: React.ReactNode) => JSX.Element;
    selectionMode: boolean;
    onResolveTransfer?: (m: Message, action: 'accepted' | 'returned') => void;
}> = ({ m, isUser, charName, commonLayout, selectionMode, onResolveTransfer }) => {
    const [open, setOpen] = useState(false);
    const meta = m.metadata || {};
    const amount = meta.amount;
    const note: string | undefined = meta.note;
    const receipt: 'accepted' | 'returned' | undefined = meta.receipt;
    const status: TransferStatus = (meta.status as TransferStatus) || 'pending';

    const actor = isUser ? '你' : charName;
    const counterparty = isUser ? charName : '你';

    // ---- 回執小卡：接收 / 退回的輕量結算條 ----
    if (receipt) {
        const accepted = receipt === 'accepted';
        return commonLayout(
            <div className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-2xl shadow-sm border w-fit max-w-[240px] ${
                accepted
                    ? 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-100'
                    : 'bg-gradient-to-br from-slate-50 to-slate-100 border-slate-200'
            }`}>
                <div className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${accepted ? 'bg-emerald-400/90 text-white' : 'bg-slate-300/90 text-white'}`}>
                    {accepted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={3} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                    ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
                    )}
                </div>
                <div className="min-w-0">
                    <div className={`text-xs font-semibold ${accepted ? 'text-emerald-700' : 'text-slate-600'}`}>
                        {actor}{accepted ? '已收款' : '退回了轉帳'}
                    </div>
                    {amount !== undefined && (
                        <div className="text-[10px] text-slate-400">₩ {amount}</div>
                    )}
                </div>
            </div>
        );
    }

    // ---- 主轉帳卡（可點開）----
    const resolved = status !== 'pending';
    // 用戶是「收到方」才出現接收/退回入口：即這條是角色發來的、且仍待處理。
    const canResolve = !isUser && !resolved && !!onResolveTransfer;

    const statusBadge = status === 'accepted' ? '已收款' : status === 'returned' ? '已退還' : '';

    const handleResolve = (action: 'accepted' | 'returned') => {
        onResolveTransfer?.(m, action);
        setOpen(false);
        trackEvent('处理收到的转账', { result: action });
    };

    return (
        <>
            {commonLayout(
                <div
                    onClick={(e) => { if (selectionMode) return; e.stopPropagation(); setOpen(true); }}
                    className={`w-64 rounded-2xl p-4 text-white shadow-lg relative overflow-hidden cursor-pointer active:scale-[0.98] transition-transform ${
                        resolved ? 'bg-gradient-to-br from-amber-300/80 to-orange-400/80' : 'bg-gradient-to-br from-amber-400 to-orange-500'
                    }`}
                >
                    <div className="absolute top-0 right-0 p-4 opacity-20"><SullyPayMark className="w-12 h-12" /></div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-white/20 rounded-full"><SullyPayMark className="w-5 h-5" /></div>
                        <span className="font-medium text-white/90">Sully Pay</span>
                    </div>
                    <div className="text-2xl font-bold tracking-tight mb-1">₩ {amount}</div>
                    {note ? (
                        <div className="text-[11px] text-white/80 truncate mb-0.5">{note}</div>
                    ) : null}
                    <div className="flex items-center justify-between">
                        <div className="text-[10px] text-white/70">轉帳給{counterparty}</div>
                        {statusBadge && (
                            <span className="text-[9px] bg-white/25 backdrop-blur-sm px-1.5 py-0.5 rounded-full">{statusBadge}</span>
                        )}
                    </div>
                </div>
            )}

            {open && (
                <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-6 animate-fade-in" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>
                    <div
                        className="w-full max-w-[320px] bg-white rounded-3xl overflow-hidden shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* 頂部金額區 */}
                        <div className="bg-gradient-to-br from-amber-400 to-orange-500 px-6 pt-7 pb-8 text-white relative overflow-hidden">
                            <div className="absolute -top-4 -right-4 opacity-15"><SullyPayMark className="w-28 h-28" /></div>
                            <div className="flex items-center gap-2 mb-5">
                                <div className="p-1.5 bg-white/20 rounded-full"><SullyPayMark className="w-4 h-4" /></div>
                                <span className="text-sm font-medium text-white/90">Sully Pay 轉帳</span>
                            </div>
                            <div className="text-[11px] text-white/70 mb-1">{isUser ? `你向${charName}轉帳` : `${charName}向你轉帳`}</div>
                            <div className="text-4xl font-bold tracking-tight">₩ {amount}</div>
                        </div>

                        {/* 詳情區 */}
                        <div className="px-6 py-5 space-y-3.5">
                            {note && (
                                <div className="bg-slate-50 rounded-xl px-3.5 py-2.5">
                                    <div className="text-[10px] text-slate-400 mb-0.5">轉帳留言</div>
                                    <div className="text-sm text-slate-700 break-words">{note}</div>
                                </div>
                            )}
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">付款方</span>
                                <span className="text-slate-700 font-medium">{isUser ? '你' : charName}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">收款方</span>
                                <span className="text-slate-700 font-medium">{isUser ? charName : '你'}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-slate-400">狀態</span>
                                <span className={`font-medium ${
                                    status === 'accepted' ? 'text-emerald-600' : status === 'returned' ? 'text-slate-500' : 'text-amber-600'
                                }`}>
                                    {status === 'accepted' ? '已收款' : status === 'returned' ? '已退還' : '等待對方處理'}
                                </span>
                            </div>

                            {canResolve ? (
                                <div className="flex gap-3 pt-2">
                                    <button
                                        onClick={() => handleResolve('returned')}
                                        className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-500 bg-slate-100 active:scale-95 transition-transform"
                                    >退回</button>
                                    <button
                                        onClick={() => handleResolve('accepted')}
                                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-amber-400 to-orange-500 shadow-md active:scale-95 transition-transform"
                                    >接收</button>
                                </div>
                            ) : (
                                <button
                                    onClick={() => setOpen(false)}
                                    className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-500 bg-slate-100 active:scale-95 transition-transform mt-1"
                                >關閉</button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

// ============================================================
// Like520 卡片：520 限定典藏，展開後看完整合照 + 信
// ============================================================

const Like520ChatCard: React.FC<{ data: any }> = ({ data }) => {
    const [open, setOpen] = useState(false);
    const stop = (e: React.MouseEvent | React.TouchEvent) => e.stopPropagation();
    const dateStr = (() => {
        try {
            const d = new Date(data.timestamp || Date.now());
            return `${d.getFullYear()} · ${String(d.getMonth() + 1).padStart(2, '0')} · ${String(d.getDate()).padStart(2, '0')}`;
        } catch { return '5 · 2 · 0'; }
    })();

    return (
        <>
            {/* 拍立得 / 復古剪貼本：照片 + 膠帶 + 手寫感落款 */}
            <div
                onClick={() => setOpen(true)}
                style={{
                    width: 256,
                    padding: '14px 14px 18px',
                    background: 'linear-gradient(180deg, #fdf6e3 0%, #f7eed4 100%)',
                    boxShadow:
                        '0 1px 2px rgba(74,36,24,0.18), ' +
                        '0 8px 22px rgba(74,36,24,0.22), ' +
                        '0 0 0 1px rgba(184,146,63,0.3)',
                    cursor: 'pointer',
                    position: 'relative',
                    transform: 'rotate(-1.4deg)',
                    transformOrigin: 'center',
                    marginTop: 8,
                }}
            >
                {/* 左上膠帶 */}
                <div style={{
                    position: 'absolute', top: -6, left: 18,
                    width: 36, height: 14,
                    background: 'linear-gradient(135deg, rgba(218,190,140,0.55), rgba(184,146,63,0.4))',
                    boxShadow: '0 1px 2px rgba(74,36,24,0.15)',
                    transform: 'rotate(-6deg)',
                    pointerEvents: 'none',
                }} />
                {/* 右上膠帶 */}
                <div style={{
                    position: 'absolute', top: -6, right: 18,
                    width: 36, height: 14,
                    background: 'linear-gradient(135deg, rgba(218,190,140,0.55), rgba(184,146,63,0.4))',
                    boxShadow: '0 1px 2px rgba(74,36,24,0.15)',
                    transform: 'rotate(6deg)',
                    pointerEvents: 'none',
                }} />

                {/* 照片本體 */}
                <div style={{
                    position: 'relative',
                    background: '#fff',
                    padding: 0,
                    boxShadow: '0 2px 6px rgba(74,36,24,0.18), inset 0 0 0 1px rgba(184,146,63,0.25)',
                }}>
                    {data.photoDataUrl
                        ? <TokenImg value={data.photoDataUrl} alt="合照" style={{ width: '100%', display: 'block' }} />
                        : <div style={{ width: '100%', aspectRatio: '1200 / 780', background: 'linear-gradient(180deg, #FFE0E8, #FFD3DC)' }} />}
                </div>

                {/* 手寫感標題 */}
                <div style={{
                    marginTop: 12,
                    textAlign: 'center',
                    fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
                    fontStyle: 'italic',
                    fontSize: 14,
                    color: '#7a2e3a',
                    letterSpacing: 1,
                    lineHeight: 1.35,
                }}>
                    「 {data.title || '我們的下午'} 」
                </div>

                {/* 日期 + 落款 */}
                <div style={{
                    marginTop: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    paddingTop: 6,
                    borderTop: '0.5px dashed rgba(184,146,63,0.4)',
                    fontFamily: 'Cinzel, serif',
                    fontSize: 9.5,
                    letterSpacing: 2,
                    color: '#8b6914',
                    fontWeight: 600,
                }}>
                    <span>{dateStr}</span>
                    <span style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontWeight: 400, letterSpacing: 1, fontSize: 10 }}>
                        — {data.charName}
                    </span>
                </div>

                {/* 暗示有信 */}
                <div style={{
                    marginTop: 6,
                    textAlign: 'center',
                    fontFamily: '"Cormorant Garamond", "Noto Serif SC", serif',
                    fontStyle: 'italic',
                    fontSize: 10.5,
                    color: '#b8923f',
                    letterSpacing: 2,
                }}>
                    ❦ 點 開 看 信 ❦
                </div>

                {/* 左下角復古火漆/印章："♥ 520" */}
                <div style={{
                    position: 'absolute',
                    bottom: -8, left: -8,
                    width: 44, height: 44,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 35%, #d4516a 0%, #a04050 50%, #7a2e3a 100%)',
                    color: '#fff8ec',
                    display: 'grid', placeItems: 'center',
                    fontFamily: '"Cormorant Garamond", serif',
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: 0,
                    lineHeight: 1.1,
                    transform: 'rotate(-12deg)',
                    boxShadow: '0 3px 8px rgba(74,36,24,0.4), inset 0 2px 2px rgba(255,255,255,0.18), inset 0 -2px 2px rgba(0,0,0,0.25)',
                    border: '1px solid rgba(212,177,106,0.5)',
                    textAlign: 'center',
                    pointerEvents: 'none',
                }}>
                    <div>
                        <div style={{ fontSize: 14, lineHeight: 1, fontFamily: 'serif' }}>♥</div>
                        <div style={{ fontSize: 7, letterSpacing: 1, marginTop: 1, fontFamily: 'Cinzel, serif' }}>5·20</div>
                    </div>
                </div>
            </div>

            {open && (
                <div
                    onClick={() => setOpen(false)}
                    style={{
                        position: 'fixed', inset: 0, zIndex: 9999,
                        background: 'rgba(74,36,24,0.55)',
                        backdropFilter: 'blur(8px)',
                        overflowY: 'auto', padding: 16,
                        animation: 'l520-card-mask-in .25s ease',
                    }}
                >
                    <style>{`
                        @keyframes l520-card-mask-in { from { opacity: 0; } to { opacity: 1; } }
                        @keyframes l520-card-pop-in { from { opacity: 0; transform: scale(0.94) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
                    `}</style>
                    <div
                        onClick={stop}
                        style={{
                            maxWidth: 420, margin: '24px auto',
                            background: 'linear-gradient(180deg, #fffcf3, #f9efd9)',
                            borderRadius: 4,
                            position: 'relative',
                            padding: '22px 18px 26px',
                            boxShadow: '0 0 0 1px #b8923f, 0 0 0 4px #faf3e7, 0 0 0 5px #d4b16a, 0 20px 60px rgba(74,36,24,0.5)',
                            animation: 'l520-card-pop-in .35s cubic-bezier(.4,1.4,.5,1)',
                        }}
                    >
                        <button
                            onClick={() => setOpen(false)}
                            title="關閉"
                            style={{
                                position: 'absolute', top: 10, right: 10, zIndex: 5,
                                width: 30, height: 30, borderRadius: '50%',
                                background: 'rgba(255,248,236,0.95)',
                                border: '1px solid #b8923f',
                                color: '#7a2e3a',
                                fontSize: 14,
                                fontFamily: '"Cormorant Garamond", serif',
                                cursor: 'pointer',
                                display: 'grid', placeItems: 'center',
                            }}
                        >✕</button>

                        <div style={{ textAlign: 'center', marginBottom: 12 }}>
                            <div style={{ fontSize: 9, letterSpacing: 6, color: '#8b6914', fontFamily: 'Cinzel, serif', fontWeight: 600 }}>5 · 2 · 0 · TRÉSOR</div>
                            <div style={{ fontSize: 13, color: '#7a2e3a', fontFamily: '"Noto Serif SC", serif', fontWeight: 500, letterSpacing: 4, marginTop: 4 }}>{data.title || '我們的下午'}</div>
                        </div>

                        {data.photoDataUrl ? (
                            <>
                                <TokenImg value={data.photoDataUrl} alt="合照" draggable={false} style={{ width: '100%', display: 'block', borderRadius: 8, boxShadow: '0 8px 20px rgba(122,46,58,0.2), 0 0 0 1px rgba(184,146,63,0.4)' }} />
                                <div style={{ fontSize: 10, fontStyle: 'italic', color: '#9D7585', textAlign: 'center', marginTop: 4, fontFamily: '"Cormorant Garamond", serif', letterSpacing: 2 }}>長按圖片保存到相冊</div>
                            </>
                        ) : null}

                        <div style={{
                            marginTop: 18,
                            padding: '22px 18px',
                            background: 'linear-gradient(180deg, #fffcf3, #f9efd9)',
                            border: '1px solid #d4b16a',
                            backgroundImage: 'repeating-linear-gradient(transparent, transparent 28px, rgba(184,146,63,0.05) 28px, rgba(184,146,63,0.05) 29px)',
                            borderRadius: 2,
                            position: 'relative',
                        }}>
                            <div style={{ textAlign: 'center', marginBottom: 14 }}>
                                <div style={{ fontFamily: '"Cormorant Garamond", serif', fontStyle: 'italic', fontSize: 11, color: '#8b6914', letterSpacing: 3 }}>致 · 我的</div>
                                <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 20, color: '#7a2e3a', letterSpacing: 6, marginTop: 4 }}>{data.userName}</div>
                                <div style={{ color: '#b8923f', fontSize: 11, letterSpacing: 8, marginTop: 6 }}>❦ ⸙ ❦</div>
                            </div>
                            <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 13.5, lineHeight: 2.05, color: '#3a2418', textIndent: '2em', whiteSpace: 'pre-wrap', letterSpacing: 0.5 }}>
                                {data.letter}
                            </div>
                            <div style={{ textAlign: 'right', marginTop: 16, paddingTop: 8, borderTop: '0.5px dashed rgba(184,146,63,0.3)' }}>
                                <div style={{ color: '#b8923f', fontSize: 11, letterSpacing: 6, marginBottom: 4 }}>~ ❦ ~</div>
                                <div style={{ fontFamily: '"Noto Serif SC", serif', fontSize: 13, color: '#7a2e3a', letterSpacing: 3 }}>— {data.charName}</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

const LifeSimResetCardView: React.FC<{ card: any }> = ({ card }) => {
    const parsed = tryParseLifeSimResetCard(card);
    if (!parsed) return null;

    return (
        <div
            className="w-72 overflow-hidden"
            style={{
                border: '2px solid #8f674a',
                borderRadius: 2,
                background: '#f4ede6',
                boxShadow: '4px 4px 0 rgba(105, 74, 52, 0.28), inset 0 0 0 1px rgba(255,255,255,0.35)',
            }}
        >
            <div
                className="px-3 py-2 flex items-center gap-2"
                style={{
                    borderBottom: '2px solid rgba(96,65,44,0.22)',
                    background: 'linear-gradient(180deg, #c99872, #9a6f52)',
                }}
            >
                {parsed.charAvatar ? (
                    <TokenImg value={parsed.charAvatar} className="w-8 h-8 object-cover shrink-0" style={{ borderRadius: 2, border: '2px solid rgba(255,255,255,0.25)' }} />
                ) : (
                    <div className="w-8 h-8 flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ borderRadius: 2, background: 'linear-gradient(135deg, #b86c3d, #d39b62)' }}>
                        {parsed.charName?.[0] || '?'}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="text-[8px] font-bold tracking-widest uppercase" style={{ color: 'rgba(255,255,255,0.78)', fontFamily: 'monospace' }}>
                        city-summary.exe
                    </div>
                    <div className="text-[11px] font-bold truncate" style={{ color: 'white' }}>
                        {parsed.headline || parsed.title}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: '#fbbf24', border: '1px solid rgba(0,0,0,0.12)' }} />
                    <span style={{ width: 10, height: 10, borderRadius: 2, background: '#86efac', border: '1px solid rgba(0,0,0,0.12)' }} />
                </div>
            </div>

            <div
                className="px-3 py-3"
                style={{
                    backgroundImage: 'linear-gradient(rgba(143,103,74,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(143,103,74,0.06) 1px, transparent 1px)',
                    backgroundSize: '8px 8px',
                }}
            >
                <div className="flex items-center justify-between text-[9px] font-bold mb-2" style={{ color: '#8f7968', fontFamily: 'monospace' }}>
                    <span>{parsed.charName}</span>
                    <span>主線 {parsed.mainPlotCount}</span>
                </div>
                <div
                    className="px-3 py-2.5"
                    style={{
                        borderRadius: 2,
                        background: 'rgba(255,255,255,0.82)',
                        border: '2px solid rgba(168,123,91,0.3)',
                        boxShadow: 'inset 1px 1px 0 rgba(255,255,255,0.6)',
                    }}
                >
                    <div className="text-[11px] leading-relaxed whitespace-pre-wrap" style={{ color: '#5b4c42' }}>
                        {parsed.summary}
                    </div>
                </div>

                <div className="mt-3 retro-inset px-2.5 py-2" style={{ borderRadius: 2 }}>
                    <div className="flex items-center justify-between text-[9px] font-bold" style={{ color: '#8f7968', fontFamily: 'monospace' }}>
                        <span>參與者 {parsed.participantNames.length}</span>
                        <span>回合 {parsed.turnCount}</span>
                    </div>
                    <div className="mt-1 text-[9px] leading-relaxed" style={{ color: '#9b8677' }}>
                        {parsed.participantNames.join('、') || '無參與角色'}
                    </div>
                </div>
            </div>

            <div
                className="px-3 py-1.5 flex items-center justify-between"
                style={{
                    borderTop: '2px solid rgba(143,103,74,0.18)',
                    background: 'linear-gradient(180deg, #eadfce, #dfd0bd)',
                    fontFamily: 'monospace',
                    fontSize: 9,
                    color: '#836b5b',
                }}
            >
                <span>memory://lifesim/session-card</span>
                <span>OK</span>
            </div>
        </div>
    );
};

interface MessageItemProps {
    msg: Message;
    isFirstInGroup: boolean;
    isLastInGroup: boolean;
    activeTheme: ChatTheme;
    charAvatar: string;
    charName: string;
    userAvatar: string;
    /** 當前窗口裡的最後一條消息；最新圖片需要立即解碼，避免移動端懶加載卡在滾動容器底部。 */
    isLatestMessage?: boolean;
    /** 圖片完成解碼並確定高度後，通知聊天列表重新校準貼底位置。 */
    onMediaLoad?: (messageId: number) => void;
    /** 點擊圖片消息本身（非長按菜單）→ 打開全屏放大預覽，支持下載/AI 生圖重新生成。 */
    onImageClick?: (m: Message) => void;
    onLongPress: (m: Message) => void;
    onReply: (m: Message) => void;
    selectionMode: boolean;
    isSelected: boolean;
    onToggleSelect: (id: number) => void;
    /** 思維鏈卡片在多選模式下有獨立勾選框，與 isSelected 分開。 */
    isThinkingSelected?: boolean;
    onToggleThinkingSelect?: (id: number) => void;
    // Translation (AI messages only, bilingual content parsed from %%BILINGUAL%%)
    translationEnabled?: boolean;
    translationExpanded?: boolean;
    isShowingTarget?: boolean;
    onTranslateToggle?: (msgId: number) => void;
    // Voice TTS
    voiceData?: { url: string; originalText: string; spokenText?: string; lang?: string };
    voiceLoading?: boolean;
    isVoicePlaying?: boolean;
    onPlayVoice?: (id: number) => void;
    // Chat layout customization
    avatarShape?: 'circle' | 'rounded' | 'square';
    avatarSize?: 'small' | 'medium' | 'large';
    avatarMode?: 'grouped' | 'every_message';
    bubbleVariant?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios';
    messageSpacing?: 'compact' | 'default' | 'spacious';
    showTimestamp?: 'always' | 'hover' | 'never';
    /** HTML / 心象 / 音樂卡片的出現位置（聊天細節微調 chatModuleAlign 合併後的生效值）。缺省 = 居中 */
    moduleAlign?: 'anchor' | 'center';
    /** 流式預覽無縫接棒時，正式消息首幀已經可見，不應再次從透明態淡入。 */
    suppressEntranceAnimation?: boolean;
    /** 麥當勞菜單卡里點了"發送給角色"時調用 */
    onMcdSendCart?: (items: import('./McdCard').McdCartItem[]) => void;
    onMcdCandidate?: (item: import('./McdCard').McdCartItem) => void;
    /** 瑞幸菜單卡 (與麥當勞同構) */
    onLuckinSendCart?: (items: import('./LuckinCard').LuckinCartItem[]) => void;
    onLuckinCandidate?: (item: import('./LuckinCard').LuckinCartItem) => void;
    /** 用戶點「收到的轉帳」卡 → 接收 / 退回 */
    onResolveTransfer?: (m: Message, action: 'accepted' | 'returned') => void;
    /** 用戶點「生活記錄」卡 → 確認 / 否決（角色代記的記錄） */
    onResolveLifeRecord?: (m: Message, action: 'confirmed' | 'rejected') => void;
    /** 打開協同文件櫃裡的原始 Blob；消息本身只保存 assetId 引用。 */
    onOpenCollaborationFile?: (m: Message) => void | Promise<void>;
    /** 思考鏈卡片視覺與交互 */
    thinkingChainOptions?: {
        styleId?: ThinkingChainStyleId;
        customColors?: { bg?: string; accent?: string; text?: string };
        onOpenSettings?: () => void;
    };
}

const MessageItem = React.memo(({
    msg: m,
    isFirstInGroup,
    isLastInGroup,
    activeTheme,
    charAvatar,
    charName,
    userAvatar,
    isLatestMessage = false,
    onMediaLoad,
    onImageClick,
    onLongPress,
    onReply,
    selectionMode,
    isSelected,
    onToggleSelect,
    isThinkingSelected,
    onToggleThinkingSelect,
    translationEnabled,
    translationExpanded,
    isShowingTarget,
    onTranslateToggle,
    voiceData,
    voiceLoading,
    isVoicePlaying,
    onPlayVoice,
    avatarShape = 'circle',
    avatarSize = 'medium',
    avatarMode = 'grouped',
    bubbleVariant = 'modern',
    messageSpacing = 'default',
    showTimestamp = 'always',
    moduleAlign = 'center',
    suppressEntranceAnimation = false,
    onMcdSendCart,
    onMcdCandidate,
    onLuckinSendCart,
    onLuckinCandidate,
    onResolveTransfer,
    onResolveLifeRecord,
    onOpenCollaborationFile,
    thinkingChainOptions,
}: MessageItemProps) => {
    const isUser = m.role === 'user';
    const isSystem = m.role === 'system';
    const spacingClass = messageSpacing === 'compact' ? (isLastInGroup ? 'mb-3' : 'mb-0.5') : messageSpacing === 'spacious' ? (isLastInGroup ? 'mb-8' : 'mb-2.5') : (isLastInGroup ? 'mb-6' : 'mb-1.5');
    const marginBottom = spacingClass;
    const avatarSizeClass = avatarSize === 'small' ? 'w-7 h-7' : avatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const avatarSizePx = avatarSize === 'small' ? 28 : avatarSize === 'large' ? 48 : 36;
    const shouldShowAvatar = avatarMode === 'every_message' || isLastInGroup;
    // 頭像絕對定位在氣泡底部尖角處，bottom 恆為 0。
    // 時間戳改用絕對定位浮層（見下方渲染處），不再佔據行內高度，
    // 於是氣泡列底恆等於氣泡尖角——頭像貼 bottom-0 就始終對齊：
    // 組末/組中、時間戳開或關都一樣，發新消息也不會因參考高度變化而位移。
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const activePointerId = useRef<number | null>(null);
    const activePointerType = useRef<string>('');
    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);

    const styleConfig = isUser ? activeTheme.user : activeTheme.ai;
    // 氣泡底紋畫在 CSS background-image 上，拿不到 <img> 那層的自動解析，只能在頂層
    // 無條件解析一次（hook 不能進條件分支）。掛件/頭像掛件走 TokenImg，各自組件內解析。
    const bubbleBgUrl = useBlobRefUrl(styleConfig.backgroundImage);
    const [showVoiceText, setShowVoiceText] = useState(false);
    const [showSarTruth, setShowSarTruth] = useState(false);
    const [openingCollaborationFile, setOpeningCollaborationFile] = useState(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);
    const [isReplyReady, setIsReplyReady] = useState(false);

    const clearLongPressTimer = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
        setIsReplyReady(false);
        setReplyOffset(0);
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (selectionMode || e.button !== 0) return;
        activePointerId.current = e.pointerId;
        activePointerType.current = e.pointerType;
        startPos.current = { x: e.clientX, y: e.clientY };
        document.getSelection()?.removeAllRanges();

        clearLongPressTimer();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            onLongPress(m);
        }, 600);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        const diffX = e.clientX - startPos.current.x;
        const diffY = e.clientY - startPos.current.y;
        const isTouchPointer = activePointerType.current !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
                && !isSystem
                && diffX < -8
                && Math.abs(diffX) > Math.abs(diffY);
            if (!startsReplySwipe) {
                if (Math.abs(diffX) > 10 || Math.abs(diffY) > 10) clearLongPressTimer();
                return;
            }
            clearLongPressTimer();
            replyGestureActiveRef.current = true;
            setIsReplyGestureActive(true);
        }

        if (Math.abs(diffY) > 24 && Math.abs(diffY) > Math.abs(diffX)) {
            resetReplyGesture();
            return;
        }

        e.preventDefault();
        document.getSelection()?.removeAllRanges();
        const nextOffset = Math.max(-72, Math.min(0, diffX));
        const nextReady = nextOffset <= -52;
        replyReadyRef.current = nextReady;
        setReplyOffset(nextOffset);
        setIsReplyReady(nextReady);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';

        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();

        if (shouldReply) onReply(m);
    };

    const handlePointerCancel = () => {
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';
        resetReplyGesture();
    };

    const handleClick = (e: React.MouseEvent) => {
        if (selectionMode) {
            e.stopPropagation();
            e.preventDefault();
            onToggleSelect(m.id);
        }
    };

    const interactionProps = {
        onPointerDown: handlePointerDown,
        onPointerUp: handlePointerEnd,
        onPointerMove: handlePointerMove,
        onPointerCancel: handlePointerCancel,
        onContextMenu: (e: React.MouseEvent) => {
            e.preventDefault();
            if (selectionMode || replyGestureActiveRef.current) return;
            clearLongPressTimer();
            activePointerId.current = null;
            activePointerType.current = '';
            resetReplyGesture();
            onLongPress(m);
        },
        onDragStart: (e: React.DragEvent) => e.preventDefault(),
        onClick: handleClick
    };

    const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    // Render Avatar with potential decoration/frame
    // Removed mb-5 from here, handled via absolute positioning in parent
    const renderAvatar = (
        src: string,
        options?: { visible?: boolean; className?: string },
    ) => {
        const visible = options?.visible ?? shouldShowAvatar;
        return (
            <div className={`relative ${avatarSizeClass} z-0 ${options?.className || ''}`}>
                {visible && (
                    <>
                        <TokenImg
                            value={src}
                            style={isAnniversaryFrame(styleConfig.avatarDecoration) ? { borderRadius: "50%" } : undefined}
                            className={`sully-chat-message-avatar-img w-full h-full ${avatarRadiusClass} object-cover shadow-sm ring-1 ring-black/5 relative z-0`}
                            alt="avatar"
                            loading="lazy"
                            decoding="async"
                        />
                        {styleConfig.avatarDecoration && (
                            <TokenImg
                                value={styleConfig.avatarDecoration}
                                className="absolute pointer-events-none z-10 max-w-none"
                                style={avatarDecorationImageStyle(styleConfig, avatarSizePx)}
                            />
                        )}
                    </>
                )}
            </div>
        );
    };

    // --- SYSTEM MESSAGE RENDERING ---
    if (isSystem) {
        const isCallSummary = m.metadata?.source === 'call-end-popup';

        // Guidebook end card — rendered as pretty card, not ugly system pill
        if (m.type === 'score_card') {
            let scoreData: any = null;
            try { scoreData = m.metadata?.scoreCard || JSON.parse(m.content); } catch {}
            if (scoreData?.type === 'lifesim_reset_card') {
                return (
                    <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                        {selectionMode && (
                            <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                    {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                            </div>
                        )}
                        <div className="w-full px-4 my-3" {...interactionProps}>
                            <div className="mx-auto w-72">
                                <LifeSimResetCardView card={scoreData} />
                            </div>
                        </div>
                    </div>
                );
            }
            if (scoreData?.type === 'diary_card') {
                const dateParts = (scoreData.date || '').split('-');
                const monthDay = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : (scoreData.date || '');
                const year = dateParts[0] || '';
                const userText = (scoreData.userText || '').trim();
                const charText = (scoreData.charText || '').trim();
                const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
                return (
                    <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                        {selectionMode && (
                            <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                    {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                            </div>
                        )}
                        <div className="w-full px-4 my-3" {...interactionProps}>
                            <div className="w-72 mx-auto rounded-2xl overflow-hidden shadow-md" style={{ border: '1.5px solid rgba(217,180,120,0.35)', background: 'linear-gradient(180deg, #fff9ec 0%, #fffdf6 35%, #fdf2dc 100%)' }}>
                                {/* Header — date stamp + char avatar */}
                                <div className="px-4 pt-3 pb-2.5 flex items-center gap-2.5" style={{ borderBottom: '1px dashed rgba(200,160,100,0.3)', background: 'linear-gradient(135deg, rgba(245,210,150,0.25), rgba(240,195,130,0.15))' }}>
                                    {scoreData.charAvatar ? (
                                        <TokenImg value={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(220,180,110,0.5)' }} />
                                    ) : (
                                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #d4a55a, #b8843a)' }}>{scoreData.charName?.[0] || '?'}</div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#a07840' }}>Exchange Diary · 交換日記</div>
                                        <div className="text-xs font-bold truncate" style={{ color: '#5c3e1a' }}>與 {scoreData.charName} · {scoreData.date}</div>
                                    </div>
                                    <div className="shrink-0 text-right leading-none">
                                        <div className="text-[8px] font-mono opacity-60" style={{ color: '#8a6230' }}>{year}</div>
                                        <div className="text-base font-black font-mono" style={{ color: '#7a4e1a' }}>{monthDay}</div>
                                    </div>
                                </div>

                                {/* User page */}
                                <div className="px-4 pt-3 pb-2">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#a07840' }}>● {scoreData.userName || '我'} 寫道</span>
                                        {scoreData.userPaperName && <span className="text-[8px] font-mono opacity-50" style={{ color: '#a07840' }}>{scoreData.userPaperName}</span>}
                                    </div>
                                    <div className="rounded-xl px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap" style={{ background: 'rgba(255,253,245,0.85)', border: '1px solid rgba(217,180,120,0.25)', color: '#4a3520', fontFamily: 'ui-serif, Georgia, serif' }}>
                                        {userText ? truncate(userText, 160) : <span className="opacity-40 italic">(空白頁)</span>}
                                    </div>
                                </div>

                                {/* Char page */}
                                <div className="px-4 pb-3 pt-1.5">
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#a07840' }}>● {scoreData.charName} 回道</span>
                                        {scoreData.charPaperName && <span className="text-[8px] font-mono opacity-50" style={{ color: '#a07840' }}>{scoreData.charPaperName}</span>}
                                    </div>
                                    <div className="rounded-xl px-3 py-2.5 text-[11px] leading-relaxed whitespace-pre-wrap" style={{ background: 'linear-gradient(135deg, rgba(255,245,220,0.85), rgba(255,238,200,0.7))', border: '1px solid rgba(217,180,120,0.3)', color: '#4a3520', fontFamily: 'ui-serif, Georgia, serif' }}>
                                        {charText ? truncate(charText, 200) : <span className="opacity-40 italic">(空白頁)</span>}
                                    </div>
                                </div>

                                {/* Footer */}
                                <div className="px-4 py-2 flex items-center justify-between" style={{ borderTop: '1px dashed rgba(200,160,100,0.25)', background: 'linear-gradient(135deg, rgba(245,210,150,0.12), rgba(240,195,130,0.06))' }}>
                                    <span className="text-[9px]" style={{ color: '#b89060' }}>
                                        {(scoreData.userStickerCount || 0) + (scoreData.charStickerCount || 0) > 0
                                            ? `貼了 ${(scoreData.userStickerCount || 0) + (scoreData.charStickerCount || 0)} 張貼紙`
                                            : '今天的紙面很乾淨'}
                                    </span>
                                    <span className="text-[9px] font-bold" style={{ color: '#a07840' }}>交換日記 ✿</span>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            }
            if (scoreData?.type === 'guidebook_card') {
                const diff = (scoreData.finalAffinity ?? 0) - (scoreData.initialAffinity ?? 0);
                const isPositive = diff > 0;
                return (
                    <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                        {selectionMode && (
                            <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                    {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                                </div>
                            </div>
                        )}
                        <div className="w-full px-4 my-3" {...interactionProps}>
                            <div className="w-72 mx-auto rounded-2xl overflow-hidden shadow-md" style={{ border: '1.5px solid rgba(200,185,190,0.4)', background: 'linear-gradient(180deg, #f0ebe8 0%, #fff 25%, #ece6e9 100%)' }}>
                                {/* Header */}
                                <div className="px-4 pt-3 pb-2 flex items-center gap-2.5" style={{ borderBottom: '1px solid rgba(200,185,190,0.2)', background: 'linear-gradient(135deg, rgba(200,185,190,0.2), rgba(190,175,195,0.15))' }}>
                                    {scoreData.charAvatar ? (
                                        <TokenImg value={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(180,165,170,0.4)' }} />
                                    ) : (
                                        <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>{scoreData.charName?.[0] || '?'}</div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#9b8a8e' }}>攻略本 · 結算報告</div>
                                        <div className="text-xs font-bold truncate" style={{ color: '#5a4a50' }}>「{scoreData.title}」</div>
                                    </div>
                                    <div className={`text-lg font-black shrink-0 ${isPositive ? 'text-emerald-500' : diff < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                                        {isPositive ? '+' : ''}{diff}
                                    </div>
                                </div>
                                {/* Body */}
                                <div className="px-4 py-3 space-y-2.5">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[9px] font-bold shrink-0" style={{ color: '#9b8a8e' }}>好感度</span>
                                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(230,220,225,0.6)' }}>
                                            <div className="h-full rounded-full" style={{ width: `${Math.min(Math.max((scoreData.finalAffinity + 100) / 200 * 100, 2), 100)}%`, background: isPositive ? 'linear-gradient(90deg, #c9b1bd, #b8909a)' : 'linear-gradient(90deg, #c8a0a8, #b87880)' }} />
                                        </div>
                                        <span className="text-[9px] font-mono font-bold shrink-0" style={{ color: '#8b7a7e' }}>{scoreData.finalAffinity}</span>
                                    </div>
                                    {scoreData.charVerdict && (
                                        <div className="text-xs leading-relaxed italic" style={{ color: '#5a4a50' }}>"{scoreData.charVerdict}"</div>
                                    )}
                                    {scoreData.charNewInsight && (
                                        <div className="rounded-xl px-3 py-2" style={{ background: 'linear-gradient(135deg, rgba(215,230,248,0.6), rgba(200,220,245,0.45))', border: '1px solid rgba(150,185,225,0.35)' }}>
                                            <div className="text-[9px] font-bold mb-1" style={{ color: '#4a6a92' }}>◆ 這局遊戲讓我發現的你</div>
                                            <div className="text-xs leading-relaxed italic" style={{ color: '#2a4a68' }}>{scoreData.charNewInsight}</div>
                                        </div>
                                    )}
                                    <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid rgba(200,185,190,0.15)' }}>
                                        <span className="text-[9px]" style={{ color: '#c0b0b5' }}>{scoreData.rounds} 回合</span>
                                        <span className="text-[9px] font-bold" style={{ color: '#9b8a8e' }}>攻略本 ♥</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            }
        }

        // Clean up text: remove [System:] or [系統:] prefix for display
        const displayText = m.content.replace(/^\[(System|系[统統]|System Log|系[统統][记記][录錄])\s*[:：]?\s*/i, '').replace(/\]$/, '').trim();

        if (isCallSummary) {
            const durationSec = Math.max(1, Number(m.metadata?.durationSec || 0));
            const turnCount = Math.max(1, Number(m.metadata?.turnCount || 1));
            const durationText = `${String(Math.floor(durationSec / 60)).padStart(2, '0')}:${String(durationSec % 60).padStart(2, '0')}`;
            const callMemo = String(m.metadata?.keepsakeLine || `“今天這通電話，我會記很久。” —— ${m.metadata?.characterName || charName}`);
            const memoTitle = m.metadata?.characterName || charName;
            const memoAvatar = m.metadata?.characterAvatar || charAvatar;
            const timeHint = durationSec <= 240 ? '差不多是一杯咖啡的時間' : '像聽完一首喜歡的歌再多一點';

            return (
                <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                    {selectionMode && (
                        <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                                {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                            </div>
                        </div>
                    )}
                    <div className="w-full px-5 my-3" {...interactionProps}>
                        <div className="rounded-3xl bg-gradient-to-br from-slate-50 to-slate-100/80 border border-slate-200/50 p-4 shadow-sm">
                            <div className="flex items-center gap-3">
                                <TokenImg value={memoAvatar} alt={memoTitle} className="h-9 w-9 rounded-full object-cover ring-1 ring-slate-200/80" loading="lazy" decoding="async" />
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-slate-600 truncate">和 {memoTitle} 通了電話</div>
                                    <div className="text-xs text-slate-400 mt-0.5">{durationText} · {turnCount}輪對話</div>
                                </div>
                            </div>
                            <div className="mt-3 rounded-2xl bg-white/70 border border-slate-100 px-3.5 py-2.5 text-[13px] italic leading-relaxed text-slate-500">
                                {callMemo}
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        return (
            <div className={`flex items-center w-full ${selectionMode ? 'pl-8' : ''} animate-fade-in relative transition-[padding] duration-300`}>
                {selectionMode && (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}
                <div className="flex justify-center my-6 px-10 w-full" {...interactionProps}>
                    <div className="flex items-center gap-1.5 bg-slate-200/40 backdrop-blur-md text-slate-500 px-3 py-1 rounded-full shadow-sm border border-white/20 select-none cursor-pointer active:scale-95 transition-transform">
                        {/* Optional Icon based on content */}
                        <img src={includesAnyScript(displayText, '任務') ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png' :
                        includesAnyScript(displayText, '紀念日') || displayText.includes('Event') ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c5.png' :
                        includesAnyScript(displayText, '轉帳') ? 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4b0.png' : 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f514.png'} alt="" className="w-4 h-4" />
                        <span className="text-[10px] font-medium tracking-wide">{displayText}</span>
                    </div>
                </div>
            </div>
        );
    }

    if (m.type === 'interaction') {
        return (
            <div className={`flex flex-col items-center ${marginBottom} w-full animate-fade-in relative transition-[padding] duration-300 ${selectionMode ? 'pl-8' : ''}`}>
                {selectionMode && (
                    <div className="absolute left-2 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}
                <div className="text-[10px] text-slate-400 mb-1 opacity-70">{formatTime(m.timestamp)}</div>
                <div className="group relative cursor-pointer active:scale-95 transition-transform" {...interactionProps}>
                        <div className="text-[11px] text-slate-500 bg-slate-200/50 backdrop-blur-sm px-4 py-1.5 rounded-full flex items-center gap-1.5 border border-white/40 shadow-sm select-none">
                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f449.png" alt="poke" className="w-4 h-4 group-hover:animate-bounce" />
                        <span className="font-medium opacity-80">{isUser ? '你' : charName}</span>
                        <span className="opacity-60">戳了戳</span>
                        <span className="font-medium opacity-80">{isUser ? charName : '你'}</span>
                    </div>
                </div>
            </div>
        );
    }

    // HTML 卡片（280px 定寬模塊）默認位置就是"視覺居中"的約定：包裝層打上 sully-html-wrap，
    // 讓「聊天細節微調」的貼邊/縮進規則 :not() 繞開它——美化怎麼開卡片都不挪窩。
    const isHtmlCard = m.type === 'html_card';
    // 音樂卡片（一起聽 / 收歌單）與 HTML 卡片同為定寬模塊，跟隨同一套 chatModuleAlign 約定。
    // 條件與下方渲染分支一致：沒有 song 元數據會落回普通氣泡，不按模塊排版。
    const isMusicCard = m.type === 'music_card' && !!m.metadata?.song;
    const isModuleCard = isHtmlCard || isMusicCard;
    // 聊天細節微調 chatModuleAlign：HTML 卡片 / 心象卡片 / 音樂卡片默認水平居中，'anchor' 才貼氣泡列。
    // 心象居中時抽出到氣泡行上方的獨立行（不帶 .group 類，注入的釘位 CSS 自然不命中）。
    const centerModules = moduleAlign !== 'anchor';
    // 心象卡片（思考鏈）：默認渲染在氣泡包裝層內、氣泡上方；居中模式挪到獨立行。
    const thinkingChainNode = !isUser && m.metadata?.thinkingChain ? (
        <div className={`relative w-full ${selectionMode ? 'pl-7' : ''}`}>
            {selectionMode && onToggleThinkingSelect && (
                <div
                    className="absolute left-0 top-3 cursor-pointer z-20 pointer-events-auto"
                    onClick={(e) => { e.stopPropagation(); onToggleThinkingSelect(m.id); }}
                >
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isThinkingSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                        {isThinkingSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                    </div>
                </div>
            )}
            <div className={selectionMode ? 'pointer-events-none' : ''}>
                <ThinkingChainBlock
                    chain={String(m.metadata!.thinkingChain)}
                    styleId={thinkingChainOptions?.styleId}
                    customColors={thinkingChainOptions?.customColors}
                    onOpenSettings={thinkingChainOptions?.onOpenSettings}
                />
            </div>
        </div>
    ) : null;
    const commonLayout = (content: React.ReactNode) => (
        <>
            {centerModules && thinkingChainNode && (
                <div className="px-3 flex justify-center">
                    <div className="w-[72%] max-w-[72%]">{thinkingChainNode}</div>
                </div>
            )}
            <div className={[
                'sully-chat-message',
                isUser
                    ? 'sully-chat-message-user justify-end'
                    : `sully-chat-message-ai ${isModuleCard && centerModules ? 'justify-center' : 'justify-start'}`,
                isFirstInGroup ? 'sully-chat-message-group-first' : '',
                isLastInGroup ? 'sully-chat-message-group-last' : '',
                isModuleCard ? 'sully-chat-message-module' : '',
                `flex items-end ${marginBottom} px-3 group select-none relative transition-[padding] duration-300`,
                selectionMode ? 'pl-12' : '',
            ].filter(Boolean).join(' ')}
            style={{ '--sully-chat-message-avatar-size': `${avatarSizePx}px` } as React.CSSProperties}>
                {selectionMode && (
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={() => onToggleSelect(m.id)}>
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-primary border-primary' : 'border-slate-300 bg-white/80'}`}>
                            {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                        </div>
                    </div>
                )}

                {/* 白框佈局鉤子：組首額外掛一份默認隱藏的頭像；顯示它即可做“每輪一次、頭像在氣泡上方”。 */}
                {isFirstInGroup && !isModuleCard && (
                    <div className={`sully-chat-turn-avatar-slot hidden absolute top-0 z-0 ${isUser ? 'right-3' : (selectionMode ? 'left-14' : 'left-3')}`}>
                        {renderAvatar(isUser ? userAvatar : charAvatar, {
                            visible: true,
                            className: 'sully-chat-turn-avatar',
                        })}
                    </div>
                )}

                {/* HTML / 音樂卡片是獨立模塊，不繼承普通消息外殼的角色頭像。卡片內部自己的頭像不受影響。 */}
                {!isUser && !isModuleCard && (
                    <div className={`sully-chat-message-avatar-slot absolute bottom-0 z-0 ${selectionMode ? 'left-14' : 'left-3'} transition-[left] duration-300`}>
                        {renderAvatar(charAvatar, { className: 'sully-chat-message-avatar' })}
                    </div>
                )}

                {/*
                    UPDATED: Limit bubble max-width to 72% for better spacing.
                    Added min-w-0 to prevent flexbox overflow issues.
                    Added explicit margins to clear absolute avatars.
                */}
                <div className={`sully-chat-message-content relative min-w-0 ${isModuleCard && centerModules ? 'w-fit max-w-full mx-auto' : `max-w-[72%] ${!isUser ? 'ml-12' : 'mr-12'}`} ${isModuleCard ? 'sully-html-wrap' : ''}`}>
                    <div
                        aria-hidden="true"
                        className={`absolute -right-10 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center pointer-events-none transition-all duration-150 ${isReplyReady ? 'bg-indigo-500 text-white shadow-md shadow-indigo-200' : 'bg-white/90 text-slate-400 shadow-sm'}`}
                        style={{
                            opacity: Math.min(1, Math.abs(replyOffset) / 36),
                            transform: `translateY(-50%) scale(${isReplyReady ? 1 : 0.86})`,
                        }}
                    >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                            <path d="M9 17 4 12l5-5" />
                            <path d="M4 12h10a6 6 0 0 1 6 6v1" />
                        </svg>
                    </div>
                    <div
                        className={`relative flex flex-col ${isModuleCard && centerModules ? 'items-center' : (isUser ? 'items-end' : 'items-start')} min-w-0`}
                        style={{
                            transform: `translateX(${replyOffset}px)`,
                            transition: isReplyGestureActive ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                            touchAction: 'pan-y',
                            userSelect: 'none',
                            WebkitUserSelect: 'none',
                            WebkitTouchCallout: 'none',
                        } as React.CSSProperties}
                        {...interactionProps}
                    >
                    {!centerModules && thinkingChainNode}
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        {content}
                    </div>
                    {isLastInGroup && showTimestamp !== 'never' && (
                        <div className={`absolute top-full ${isUser ? 'right-0' : 'left-0'} mt-0.5 px-1 text-[9px] text-slate-400/80 font-medium whitespace-nowrap pointer-events-none ${showTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{formatTime(m.timestamp)}</div>
                    )}
                    </div>
                </div>

                {/* 用戶側若存在導入/歷史模塊卡，也保持同一條“卡片不帶消息外側頭像”規則。 */}
                {isUser && !isModuleCard && (
                    <div className={`sully-chat-message-avatar-slot absolute right-3 bottom-0 z-0 transition-[left] duration-300`}>
                        {renderAvatar(userAvatar, { className: 'sully-chat-message-avatar' })}
                    </div>
                )}
            </div>
        </>
    );

    // [New] Social Card Rendering
    // --- Chat Forward Card ---
    if (m.type === 'chat_forward') {
        let forwardData: any = null;
        try { forwardData = JSON.parse(m.content); } catch {}
        if (forwardData) {
            return <ForwardCard forwardData={forwardData} commonLayout={commonLayout} interactionProps={interactionProps} selectionMode={selectionMode} />;
        }
    }

    // --- Music Card Rendering (一起聽 / 加入歌單) ---
    if (m.type === 'music_card' && m.metadata?.song) {
        const song = m.metadata.song as { songId: number; name: string; artists: string; albumPic: string };
        const intent = (m.metadata.intent || 'join') as 'join' | 'add' | 'join_and_add';
        const isTogether = intent === 'join' || intent === 'join_and_add';
        const addedTo = m.metadata.addedToPlaylistTitle as string | undefined;

        // 頭像渲染：有圖用圖，無圖顯姓名首字
        const renderAvatar = (src: string | undefined, name: string, ring: string) => (
            <div
                className="relative shrink-0 rounded-full overflow-hidden"
                style={{
                    width: 32, height: 32,
                    boxShadow: `0 0 0 2px #fff, 0 0 0 3.5px ${ring}, 0 2px 6px ${ring}66`,
                }}
            >
                {src ? (
                    <TokenImg value={src} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer"
                        onError={(e: any) => {
                            const img = e.target;
                            const p = img.parentElement;
                            if (!p || p.querySelector('.ava-fallback')) return;
                            img.style.display = 'none';
                            const fb = document.createElement('div');
                            fb.className = 'ava-fallback w-full h-full flex items-center justify-center text-white text-xs font-semibold';
                            fb.style.background = `linear-gradient(135deg, ${ring}, #c3b2ff)`;
                            fb.textContent = (name || '·').slice(0, 1);
                            p.appendChild(fb);
                        }}
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-white text-xs font-semibold"
                        style={{ background: `linear-gradient(135deg, ${ring}, #c3b2ff)` }}>
                        {(name || '·').slice(0, 1)}
                    </div>
                )}
            </div>
        );

        return commonLayout(
            <div className="w-64 rounded-2xl overflow-hidden shadow-sm border cursor-pointer active:opacity-90 transition-opacity"
                style={{
                    borderColor: '#f3d9e6',
                    background: 'linear-gradient(135deg, #fff2f7 0%, #f5edff 55%, #eaf1ff 100%)',
                }}>

                {/* 一起聽 · 居中雙頭像頭圖（僅 join / join_and_add 顯示）*/}
                {isTogether && (
                    <div className="relative px-3 pt-3 pb-2 overflow-hidden">
                        {/* 粉紫光暈背景 */}
                        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-70"
                            style={{
                                background: `radial-gradient(ellipse at 30% 50%, rgba(255,170,200,0.32) 0%, transparent 52%),
                                             radial-gradient(ellipse at 70% 50%, rgba(195,178,255,0.32) 0%, transparent 55%)`,
                            }} />
                        {/* 居中：用戶頭像 · ♥ · 角色頭像 */}
                        <div className="relative flex items-center justify-center gap-2">
                            {renderAvatar(userAvatar, '你', '#ffb5cf')}
                            <svg width="16" height="15" viewBox="0 0 24 22" fill="none"
                                className="animate-pulse"
                                style={{ color: '#ff7fae', filter: 'drop-shadow(0 0 5px rgba(255,127,174,0.55))' }}>
                                <path d="M12 21s-8-5.3-8-11.5C4 6 6.5 3.5 9.5 3.5c1.6 0 3 .8 2.5 2.2C11.5 4.3 12.9 3.5 14.5 3.5 17.5 3.5 20 6 20 9.5 20 15.7 12 21 12 21z"
                                    fill="currentColor" />
                            </svg>
                            {renderAvatar(charAvatar, charName, '#c3b2ff')}
                        </div>
                        {/* 標籤 */}
                        <div className="relative mt-1.5 text-center text-[9px] tracking-[0.3em] uppercase font-semibold"
                            style={{ color: '#9c6fc2', opacity: 0.8 }}>
                            Listening Together
                        </div>
                        <div className="relative mt-0.5 text-center text-[11px]"
                            style={{ color: '#5a49a8', fontFamily: `'Noto Serif','Georgia',serif` }}>
                            <span className="font-medium">你</span>
                            <span className="mx-1.5 opacity-50">×</span>
                            <span className="font-medium">{charName || 'Ta'}</span>
                            {intent === 'join_and_add' && (
                                <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full align-middle"
                                    style={{ background: 'rgba(195,178,255,0.3)', color: '#7a5db0', border: '1px solid rgba(195,178,255,0.5)' }}>
                                    + 歌單
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Cover */}
                <div className="relative w-full h-28 overflow-hidden">
                    {song.albumPic ? (
                        <TokenImg
                            value={song.albumPic}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e: any) => {
                                const img = e.target;
                                const container = img.parentElement;
                                if (!container) return;
                                img.style.display = 'none';
                                if (container.querySelector('.music-cover-fallback')) return;
                                const fallback = document.createElement('div');
                                fallback.className = 'music-cover-fallback w-full h-full flex items-center justify-center';
                                fallback.style.background = 'linear-gradient(135deg, #8b7ab8 0%, #6b95c7 100%)';
                                fallback.innerHTML = `<div style="color:rgba(255,255,255,0.9);font-size:24px;">♪</div>`;
                                container.appendChild(fallback);
                            }}
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center"
                            style={{ background: 'linear-gradient(135deg, #8b7ab8 0%, #6b95c7 100%)' }}>
                            <span style={{ color: 'rgba(255,255,255,0.9)', fontSize: '28px' }}>♪</span>
                        </div>
                    )}
                    {/* 純"收入歌單"保留角標；一起聽意圖已在頭部表達，不再重複 */}
                    {!isTogether && (
                        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded-full backdrop-blur-sm text-[9px] font-medium"
                            style={{ background: 'rgba(255,255,255,0.85)', color: '#5a49a8' }}>
                            📌 收入歌單
                        </div>
                    )}
                </div>
                <div className="p-3">
                    <div className="font-bold text-sm line-clamp-1 leading-snug"
                        style={{ color: '#2a1f4d', fontFamily: `'Noto Serif','Georgia',serif` }}>
                        {song.name || '未命名'}
                    </div>
                    <div className="text-[10px] mt-0.5 truncate" style={{ color: '#6b5b8f' }}>
                        {song.artists || '—'}
                    </div>
                    {addedTo && (
                        <div className="text-[9px] mt-1.5 italic" style={{ color: '#5a49a8' }}>
                            已加入《{addedTo}》
                        </div>
                    )}
                    <div className="mt-2 pt-1.5 flex items-center gap-1 text-[9px] border-t" style={{ color: '#a89bc5', borderColor: '#e0d9f0' }}>
                        <span style={{ color: '#5a49a8', fontWeight: 600 }}>Shizuku Music</span>
                        <span>·</span>
                        <span>{isUser ? '分享' : '互動'}</span>
                    </div>
                </div>
            </div>
        );
    }

    // --- XHS Card Rendering (小紅書筆記卡片) ---
    if (m.type === 'xhs_card' && m.metadata?.xhsNote) {
        const note = m.metadata.xhsNote;
        const openXhsNote = () => {
            const nid = note.noteId || note.note_id || note.id;
            if (!nid) return;
            const token = note.xsecToken || note.xsec_token;
            const url = `https://www.xiaohongshu.com/explore/${nid}${token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_feed` : ''}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        };
        return commonLayout(
            <div
                onClick={openXhsNote}
                className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity">
                {/* Cover image */}
                {note.coverUrl ? (
                    <div className="relative w-full h-36 bg-slate-100 overflow-hidden">
                        <img
                            src={note.coverUrl}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            crossOrigin="anonymous"
                            onError={(e: any) => {
                                // 圖片加載失敗時顯示佔位圖（保持卡片高度）
                                const img = e.target;
                                const container = img.parentElement;
                                if (!container) return;
                                img.style.display = 'none';
                                // 避免重複插入佔位
                                if (container.querySelector('.xhs-cover-fallback')) return;
                                const fallback = document.createElement('div');
                                fallback.className = 'xhs-cover-fallback w-full h-full bg-gradient-to-br from-red-50 to-pink-100 flex items-center justify-center';
                                fallback.innerHTML = `<div class="text-center"><div class="mb-1"><img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d5.png" alt="" class="w-6 h-6 mx-auto" /></div><div class="text-[10px] text-red-300 font-medium">${note.title ? '封面加載失敗' : '小紅書筆記'}</div></div>`;
                                container.appendChild(fallback);
                            }}
                        />
                        {note.type === 'video' && (
                            <div className="absolute top-2 right-2 bg-black/50 rounded-full px-1.5 py-0.5 flex items-center gap-0.5">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-white"><path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" /></svg>
                                <span className="text-[9px] text-white font-medium">視頻</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="h-14 bg-gradient-to-r from-red-400 to-pink-500 flex items-center justify-center">
                        <span className="text-white/80 text-xs font-medium tracking-wide">小紅書筆記</span>
                    </div>
                )}
                <div className="p-3">
                    {/* Title */}
                    <div className="font-bold text-sm text-slate-800 line-clamp-2 leading-snug mb-1.5">{note.title || '無標題筆記'}</div>
                    {/* Description */}
                    {note.desc && <p className="text-xs text-slate-500 line-clamp-3 leading-relaxed mb-2">{note.desc}</p>}
                    {/* Author + Likes */}
                    <div className="flex items-center justify-between pt-2 border-t border-slate-50">
                        <div className="flex items-center gap-1.5">
                            <div className="w-4 h-4 rounded-full bg-gradient-to-br from-red-400 to-pink-400 flex items-center justify-center text-[8px] text-white font-bold">{(note.author || '?')[0]}</div>
                            <span className="text-[10px] text-slate-500 truncate max-w-[100px]">{note.author || '小紅書用戶'}</span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-slate-400">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-red-300"><path d="m9.653 16.915-.005-.003-.019-.01a20.759 20.759 0 0 1-1.162-.682 22.045 22.045 0 0 1-2.582-1.9C4.045 12.733 2 10.352 2 7.5a4.5 4.5 0 0 1 8-2.828A4.5 4.5 0 0 1 18 7.5c0 2.852-2.044 5.233-3.885 6.82a22.049 22.049 0 0 1-3.744 2.582l-.019.01-.005.003h-.002a.723.723 0 0 1-.692 0l-.003-.002Z" /></svg>
                            <span>{note.likes || 0}</span>
                        </div>
                    </div>
                    {/* Footer label */}
                    <div className="mt-2 pt-1.5 flex items-center gap-1 text-[9px] text-slate-300">
                        <span className="text-red-400 font-bold">小紅書</span> <span>·</span> <span>{note.type === 'video' ? '視頻' : '筆記'}{isUser ? '分享' : '推薦'}</span>
                    </div>
                </div>
            </div>
        );
    }

    // --- Webpage Share Card (用戶分享的網頁 / 視頻平台鏈接) ---
    if (m.type === 'webpage_card' && m.metadata?.webpage) {
        const wp = m.metadata.webpage;
        const vd = wp.video; // videoParser 解析路徑才有：平台/作者/熱度
        let host = (wp.siteName || '').trim();
        try { host = new URL(wp.finalUrl || wp.url).hostname.replace(/^www\./, ''); } catch { /* 用 siteName 兜底 */ }
        const openPage = () => {
            const u = wp.finalUrl || wp.url;
            if (u) window.open(u, '_blank', 'noopener,noreferrer');
        };
        const excerpt = (wp.excerpt || '').trim();
        const vdStats = vd ? [
            vd.playCount ? `▶ ${formatStatCount(vd.playCount)}` : '',
            vd.likeCount ? `♥ ${formatStatCount(vd.likeCount)}` : '',
            vd.commentCount ? `💬 ${formatStatCount(vd.commentCount)}` : '',
        ].filter(Boolean) : [];
        return commonLayout(
            <div
                onClick={openPage}
                className="w-64 bg-white rounded-2xl overflow-hidden border border-slate-200/80 shadow-[0_2px_10px_rgba(0,0,0,0.05)] cursor-pointer active:opacity-90 transition-opacity">
                {/* 封面圖（og:image / 正文首圖 / 視頻封面），加載失敗自動隱藏 */}
                {wp.image && (
                    <div className="relative w-full h-32 bg-slate-100 overflow-hidden">
                        <img
                            src={wp.image}
                            alt=""
                            className="w-full h-full object-cover"
                            loading="lazy"
                            referrerPolicy="no-referrer"
                            onError={(e: any) => { const c = e.target?.parentElement; if (c) c.style.display = 'none'; }}
                        />
                        {/* 視頻分享：封面加播放角標；圖集顯示張數 */}
                        {vd && vd.contentType !== 'image' && (
                            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                <span className="w-10 h-10 rounded-full bg-black/40 backdrop-blur-[2px] flex items-center justify-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-white translate-x-[1px]"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.34-5.89a1.5 1.5 0 0 0 0-2.54L6.3 2.84Z" /></svg>
                                </span>
                            </span>
                        )}
                        {vd && vd.contentType === 'image' && !!vd.imageCount && (
                            <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/45 text-white text-[9px] font-medium pointer-events-none">
                                圖集 · {vd.imageCount}張
                            </span>
                        )}
                    </div>
                )}
                <div className="p-3.5">
                    {/* 域名 / 平台行 */}
                    <div className="flex items-center gap-1.5 mb-2">
                        <span className="w-4 h-4 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5 text-slate-400">
                                <path fillRule="evenodd" d="M12.232 4.232a2.5 2.5 0 0 1 3.536 3.536l-1.225 1.224a.75.75 0 0 0 1.061 1.06l1.224-1.224a4 4 0 0 0-5.656-5.656l-3 3a4 4 0 0 0 .225 5.865.75.75 0 0 0 .977-1.138 2.5 2.5 0 0 1-.142-3.667l3-3Z" clipRule="evenodd" />
                                <path fillRule="evenodd" d="M11.603 7.963a.75.75 0 0 0-.977 1.138 2.5 2.5 0 0 1 .142 3.667l-3 3a2.5 2.5 0 0 1-3.536-3.536l1.225-1.224a.75.75 0 0 0-1.061-1.06l-1.224 1.224a4 4 0 1 0 5.656 5.656l3-3a4 4 0 0 0-.225-5.865Z" clipRule="evenodd" />
                            </svg>
                        </span>
                        <span className="text-[11px] text-slate-400 font-medium truncate">{vd?.platformLabel || host || '網頁'}</span>
                    </div>
                    {/* 標題 */}
                    <div className="font-semibold text-[15px] text-slate-800 line-clamp-2 leading-snug">{wp.title || host || '網頁'}</div>
                    {/* 視頻分享：作者 + 熱度行 */}
                    {vd ? (
                        <div className="flex items-center justify-between mt-1.5 gap-2">
                            <span className="text-[10px] text-slate-500 truncate">{vd.authorName ? `@${vd.authorName}` : ''}</span>
                            {vdStats.length > 0 && (
                                <span className="text-[10px] text-slate-400 shrink-0">{vdStats.join(' · ')}</span>
                            )}
                        </div>
                    ) : excerpt ? (
                        <p className="text-xs text-slate-500 line-clamp-3 leading-relaxed mt-1.5">{excerpt}</p>
                    ) : (
                        <p className="text-[11px] text-slate-300 mt-1.5">未能提取到正文預覽，點開看原網頁</p>
                    )}
                </div>
            </div>
        );
    }

    if (m.type === 'mcd_card') {
        const meta = m.metadata || {};
        const kind = meta.mcdCardKind;
        // 來自小程序的卡片 (proposal / cart / candidate) → 主聊天裡只渲染一張漂亮的"刷卡"佔位
        // 真實可交互內容只在小程序界面裡展示, 主聊天裡點小程序按鈕回到那個界面看。
        if (kind === 'proposal' || kind === 'cart' || kind === 'candidate' || meta.fromMcdMiniApp) {
            const label = kind === 'proposal' ? '推薦了幾樣'
                : kind === 'cart' ? '想下單的購物車'
                : kind === 'candidate' ? '問問意見'
                : '麥當勞卡片';
            const summary = kind === 'proposal' && Array.isArray(meta.mcdProposal?.items)
                ? `${meta.mcdProposal.items.length} 件: ${meta.mcdProposal.items.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.mcdProposal.items.length > 3 ? '…' : ''}`
                : kind === 'cart' && Array.isArray(meta.mcdCartItems)
                ? `${meta.mcdCartItems.length} 件: ${meta.mcdCartItems.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.mcdCartItems.length > 3 ? '…' : ''}`
                : kind === 'candidate' && meta.mcdCandidate?.name
                ? `「${meta.mcdCandidate.name}」`
                : '';
            return commonLayout(
                <div className="w-60 rounded-2xl overflow-hidden border border-yellow-200 shadow-sm bg-gradient-to-br from-yellow-50 to-amber-50 select-none">
                    <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-yellow-300 to-amber-300">
                        <span className="text-lg">🍟</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[10px] text-yellow-900/70 leading-none">麥當勞卡片</div>
                            <div className="text-[11px] font-bold text-yellow-900 leading-tight">{label}</div>
                        </div>
                    </div>
                    <div className="px-3 py-2 text-[10px] text-slate-500 leading-snug min-h-[28px]">
                        {summary || '在麥當勞小程序裡查看完整內容'}
                    </div>
                    <div className="px-3 pb-2 text-[9px] text-yellow-700/60 italic">
                        💳 已記錄在麥記錄裡
                    </div>
                </div>
            );
        }
        // 老的 mcd_card (從舊 LLM 工具調用殘留 / 無 kind), 保持原有 McdCard 渲染兼容
        return commonLayout(
            <McdCard
                toolName={meta.mcdToolName || m.content || 'mcd_tool'}
                args={meta.mcdToolArgs}
                result={meta.mcdToolResult}
                error={meta.mcdToolError}
                rawText={meta.mcdToolRawText}
                kind={kind || 'generic'}
                onSendCart={onMcdSendCart}
                onCandidate={onMcdCandidate}
                cartItems={meta.mcdCartItems}
                candidateItem={meta.mcdCandidate}
            />
        );
    }

    if (m.type === 'luckin_card') {
        const meta = m.metadata || {};
        const kind = meta.luckinCardKind;
        // 來自小程序的卡片 (proposal / cart / candidate) → 主聊天裡只渲染一張"刷卡"佔位
        if (kind === 'proposal' || kind === 'cart' || kind === 'candidate' || meta.fromLuckinMiniApp) {
            const label = kind === 'proposal' ? '推薦了幾樣'
                : kind === 'cart' ? '想下單的購物車'
                : kind === 'candidate' ? '問問意見'
                : '瑞幸卡片';
            const summary = kind === 'proposal' && Array.isArray(meta.luckinProposal?.items)
                ? `${meta.luckinProposal.items.length} 件: ${meta.luckinProposal.items.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.luckinProposal.items.length > 3 ? '…' : ''}`
                : kind === 'cart' && Array.isArray(meta.luckinCartItems)
                ? `${meta.luckinCartItems.length} 件: ${meta.luckinCartItems.slice(0, 3).map((i: any) => i.name).join(' / ')}${meta.luckinCartItems.length > 3 ? '…' : ''}`
                : kind === 'candidate' && meta.luckinCandidate?.name
                ? `「${meta.luckinCandidate.name}」`
                : '';
            return commonLayout(
                <div className="w-60 rounded-2xl overflow-hidden border border-blue-200 shadow-sm bg-gradient-to-br from-blue-50 to-sky-50 select-none">
                    <div className="flex items-center gap-2 px-3 py-2 bg-gradient-to-r from-blue-600 to-sky-500">
                        <span className="text-lg">🦌</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[10px] text-white/70 leading-none">瑞幸卡片</div>
                            <div className="text-[11px] font-bold text-white leading-tight">{label}</div>
                        </div>
                    </div>
                    <div className="px-3 py-2 text-[10px] text-slate-500 leading-snug min-h-[28px]">
                        {summary || '在瑞幸小程序裡查看完整內容'}
                    </div>
                    <div className="px-3 pb-2 text-[9px] text-blue-700/60 italic">
                        💳 已記錄在瑞幸記錄裡
                    </div>
                </div>
            );
        }
        // 結帳卡 (聊天點單 previewOrder 的終點): 可改數量 + 直接掃碼支付
        if (kind === 'checkout' && meta.luckinToolResult) {
            return commonLayout(
                <LuckinCheckoutCard
                    deptId={meta.luckinToolArgs?.deptId}
                    args={meta.luckinToolArgs}
                    preview={meta.luckinToolResult}
                    loc={meta.luckinLoc}
                />
            );
        }
        // 工具結果卡 (門店/商品/訂單) 或老的 luckin_card → 走 LuckinCard 渲染
        return commonLayout(
            <LuckinCard
                toolName={meta.luckinToolName || m.content || 'luckin_tool'}
                args={meta.luckinToolArgs}
                result={meta.luckinToolResult}
                error={meta.luckinToolError}
                rawText={meta.luckinToolRawText}
                kind={kind || 'generic'}
                onSendCart={onLuckinSendCart}
                onCandidate={onLuckinCandidate}
                cartItems={meta.luckinCartItems}
                candidateItem={meta.luckinCandidate}
            />
        );
    }

    if (m.type === 'vr_card') {
        const md: any = m.metadata || {};
        const roomNameMap: Record<string, string> = {
            library: '圖書館', music: '聽歌房', guestbook: '留言簿', gym: '娛樂室', postoffice: '郵局', theater: '劇院', signal: '信號墜落處', sar: 'SAR 活動空間',
        };
        const roomInfo = { name: roomNameMap[md.room] || '彼方' };
        const activity: string = md.activity || '在彼方度過了一段時間。';
        const excerpts: string[] = Array.isArray(md.annotationExcerpts) ? md.annotationExcerpts : [];
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const sarNote: any = md.sarCabinetNote;
        if (sarNote?.id) {
            const card = (
                <div className="w-72 max-w-[82vw]">
                    <div className="relative overflow-hidden border border-stone-400/65 shadow-[4px_6px_0_rgba(86,78,66,.18)]" style={{ background: '#f4eddf', color: '#3f4744' }}>
                        <div className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-teal-700/80 via-slate-500/60 to-rose-700/70" />
                        <div className="px-4 pl-5 pt-3 pb-2.5 flex items-start gap-2 border-b border-stone-400/45">
                            <span className="mt-0.5 text-[15px] text-teal-700">✦</span>
                            <div className="min-w-0 flex-1">
                                <div className="text-[8px] tracking-[0.22em] font-bold text-teal-800/65">彼方 · 角色櫃中隨筆</div>
                                <div className="mt-1 text-[15px] leading-snug font-bold text-stone-800" style={{ fontFamily: "'Noto Serif SC',serif" }}>{sarNote.title || '一次芯片事故'}</div>
                                <div className="mt-1 text-[9px] text-stone-500">{sarNote.actorName || charName || 'Ta'} 給 {sarNote.targetName || '另一位玩家'} 用了兩枚芯片</div>
                            </div>
                            <span className="text-[8px] text-stone-400">{timeStr}</span>
                        </div>
                        <div className="px-4 pl-5 py-3">
                            <div className="flex items-center gap-1.5 text-[9px] text-teal-800/75">
                                <span className="px-1.5 py-1 border border-teal-800/20 bg-white/30">{sarNote.variantTitle}</span><i className="not-italic text-stone-400">×</i><span className="px-1.5 py-1 border border-teal-800/20 bg-white/30">{sarNote.storyTitle}</span>
                            </div>
                            <blockquote className="my-2.5 px-2.5 py-2 border-l-2 border-rose-700/45 bg-[#e8ddce] text-[11px] leading-relaxed text-stone-700" style={{ fontFamily: "'Noto Serif SC',serif" }}>“{sarNote.highlight}”</blockquote>
                            <p className="text-[11px] leading-[1.65] text-stone-600">{activity}</p>
                            <details className="group mt-2 border-t border-dashed border-stone-400/50 pt-2 [&_summary]:list-none [&::-webkit-details-marker]:hidden">
                                <summary className="cursor-pointer select-none text-[9px] font-bold text-teal-800/70">展開完整事故與 TA 的隨筆 <span className="inline-block transition-transform group-open:rotate-90">›</span></summary>
                                <div className="mt-2 space-y-2.5">
                                    <div><div className="text-[8px] tracking-[0.14em] text-stone-400">事情經過</div><p className="mt-1 whitespace-pre-wrap text-[11px] leading-[1.75] text-stone-600">{sarNote.story}</p></div>
                                    <div className="border-t border-stone-300/70 pt-2"><div className="text-[8px] tracking-[0.14em] text-rose-800/55">櫃中隨筆</div><p className="mt-1 whitespace-pre-wrap text-[11px] leading-[1.75] text-stone-700" style={{ fontFamily: "'Noto Serif SC',serif" }}>{sarNote.notes}</p></div>
                                </div>
                            </details>
                        </div>
                        <div className="px-4 pl-5 py-1.5 border-t border-stone-400/40 flex items-center justify-between text-[8px] text-stone-500">
                            <span>TA 自己玩過的一局</span><span className="font-bold text-rose-800/60">已收入角色櫃子</span>
                        </div>
                    </div>
                </div>
            );
            return commonLayout(card);
        }
        const card = (
            <div className="w-64">
                <div
                    className="rounded-xl overflow-hidden border border-indigo-300/40 shadow-[0_4px_16px_rgba(60,40,120,0.22)]"
                    style={{ background: 'linear-gradient(155deg,#2a2350 0%,#1b1838 100%)' }}
                >
                    {/* 頭部：彼方 · 房間 */}
                    <div className="px-3 pt-2.5 pb-2 flex items-center gap-2 border-b border-white/10">
                        <span className="text-base leading-none text-indigo-200/80" style={{ filter: 'drop-shadow(0 0 5px rgba(170,180,255,.6))' }}>✦</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-indigo-300/80 font-bold uppercase">彼方 · 動態</div>
                            <div className="text-[12px] text-indigo-100 font-semibold truncate">{roomInfo.name}{md.novelTitle ? ` · 《${md.novelTitle}》` : ''}</div>
                        </div>
                        <span className="text-[9px] text-indigo-300/60">{timeStr}</span>
                    </div>
                    {/* 活動播報 */}
                    <div className="px-3 py-2.5">
                        <p className="text-[12.5px] leading-[1.5] text-indigo-50/95">
                            {md.userBoardPost
                                ? activity
                                : <><span className="font-bold text-amber-200">{charName || 'Ta'}</span> {activity}</>}
                        </p>
                        {excerpts.length > 0 && (
                            <div className="mt-2 space-y-1">
                                {excerpts.map((ex, i) => (
                                    <div key={i} className="text-[11px] leading-snug text-indigo-200/80 pl-2 border-l-2 border-amber-300/50">
                                        {ex}
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* 留言簿：把角色在牆上留的原話也顯示出來 */}
                        {md.privateWords && <blockquote className="mt-2 border-l-2 border-teal-200/50 pl-2 text-[12px] leading-relaxed text-indigo-50 whitespace-pre-wrap">{md.privateWords}</blockquote>}
                        {md.fishing?.sale && <React.Suspense fallback={null}><AivenFishSaleReceipt sale={md.fishing.sale} sellerName={charName || 'Ta'} sellerWords={md.fishing.sale.sellerWords}/></React.Suspense>}
                        {(md.marketActivity || md.marketEventId) && <details className="mt-2 text-[11px] text-indigo-200/80">
                            <summary className="cursor-pointer">展開經過與原話</summary>
                            <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{m.content}</p>
                        </details>}
                        {Array.isArray(md.boardPosts) && md.boardPosts.length > 0 && (
                            <div className="mt-2 space-y-1">
                                {md.boardPosts.map((p: any, i: number) => (
                                    <div key={i} className="text-[11px] leading-snug text-indigo-100/90 pl-2 border-l-2 border-indigo-300/50">
                                        {p?.replyToName && <span className="text-indigo-300/70">回 {p.replyToName}：</span>}{p?.content}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* 頁腳 */}
                    <div className="px-3 py-1.5 border-t border-white/10 flex items-center justify-between">
                        <span className="text-[9px] text-indigo-300/60 italic">{md.userBoardPost ? '你發佈到留言牆' : 'Ta 獨自度過的時間'}</span>
                        <span className="text-[9px] text-amber-200/70 font-bold tracking-wide">{md.userBoardPost ? '彼方' : '＋記憶'}</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'sim_card') {
        const sc: any = m.metadata?.simCard || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const accent = '#b89bff';
        const card = (
            <div className="w-64">
                <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_28px_rgba(40,30,70,0.45)]"
                    style={{ borderColor: 'rgba(184,155,255,0.3)', background: 'linear-gradient(160deg,#221c33 0%,#171327 55%,#100d1c 100%)' }}>
                    <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(184,155,255,.4),transparent 70%)' }} />
                    <div className="absolute inset-0 pointer-events-none opacity-50" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 24%,#c9b8ec,transparent),radial-gradient(1px 1px at 62% 18%,#e7c9f0,transparent),radial-gradient(1px 1px at 42% 36%,#bcd0f0,transparent)' }} />
                    {/* 頭部 */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: 'rgba(184,155,255,0.18)' }}>
                        <span className="text-base leading-none" style={{ color: accent, filter: 'drop-shadow(0 1px 4px rgba(184,155,255,.5))' }}>✦</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] font-bold uppercase" style={{ color: accent }}>體驗卡 · {sc.mode === 'event' ? '事件' : '日常'}</div>
                            <div className="text-[12px] text-white/90 font-semibold truncate" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{sc.title || '一段回憶'}</div>
                        </div>
                        <span className="text-[9px] text-white/35">{timeStr}</span>
                    </div>
                    {/* 正文 */}
                    <div className="relative px-3 py-2.5">
                        {sc.theme && (
                            <span className="inline-block text-[9px] px-2 py-0.5 rounded-full mb-2" style={{ color: accent, background: 'rgba(184,155,255,0.14)' }}>{sc.theme}</span>
                        )}
                        {sc.summary && (
                            <p className="text-[12px] leading-[1.7] text-white/70 whitespace-pre-wrap max-h-44 overflow-y-auto no-scrollbar" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                {sc.summary}
                            </p>
                        )}
                        {sc.ending && <div className="mt-2 text-[10px] text-white/40">結局 · {sc.ending}</div>}
                    </div>
                    {/* 頁腳 */}
                    <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(184,155,255,0.18)' }}>
                        <span className="text-[9px] italic text-white/35">你真實經歷過的一天</span>
                        <span className="text-[9px] font-bold tracking-wide" style={{ color: accent }}>＋ 收藏為回憶</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'group_topic_card') {
        const box: any = m.metadata?.groupTopicBox || {};
        const card = (
            <div className="w-72 rounded-2xl overflow-hidden border border-violet-200/70 bg-gradient-to-br from-violet-50 via-white to-indigo-50 shadow-sm">
                <div className="px-4 pt-3 pb-2 border-b border-violet-100 flex items-center gap-2">
                    <span className="w-8 h-8 rounded-xl bg-violet-100 text-violet-600 flex items-center justify-center">💬</span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[9px] font-bold tracking-[0.18em] text-violet-400 uppercase">群聊公共話題盒</div>
                        <div className="text-[13px] font-bold text-slate-700 truncate">{box.title || '一段群聊回憶'}</div>
                    </div>
                </div>
                <div className="px-4 py-3">
                    <p className="text-[12px] leading-6 text-slate-600 whitespace-pre-wrap max-h-48 overflow-y-auto no-scrollbar">{box.summary || m.content}</p>
                </div>
                <div className="px-4 py-2 border-t border-violet-100 text-[9px] text-violet-400 flex justify-between">
                    <span>{box.groupName || '群聊'} · 共同經歷</span>
                    <span>{box.messageCount ? `${box.messageCount} 條原文` : ''}</span>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'phone_card') {
        const rawPhoneCard: any = m.metadata?.phoneCard || {};
        const pc: any = {
            ...rawPhoneCard,
            kind: phoneFieldToText(rawPhoneCard.kind),
            service: phoneFieldToText(rawPhoneCard.service),
            serviceName: phoneFieldToText(rawPhoneCard.serviceName),
            title: phoneFieldToText(rawPhoneCard.title),
            detail: phoneFieldToText(rawPhoneCard.detail),
            value: phoneFieldToText(rawPhoneCard.value),
            app: phoneFieldToText(rawPhoneCard.app),
            by: phoneFieldToText(rawPhoneCard.by),
            contactName: phoneFieldToText(rawPhoneCard.contactName),
            action: phoneFieldToText(rawPhoneCard.action),
            image: phoneFieldToText(rawPhoneCard.image),
        };
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

        // 智能體卡片（偷看到 TA 在玩 AI：助手 / 樹洞 / 酒館）
        if (typeof pc.kind === 'string' && pc.kind.startsWith('ai_')) {
            const svc = pc.service || pc.kind.replace('ai_', '');
            const meta: Record<string, { label: string; accent: string; bg: string; glyph: string }> = {
                assistant: { label: 'AI 助手', accent: '#34d399', bg: 'linear-gradient(150deg,#0e2a22 0%,#0b1f1a 55%,#0a1512 100%)', glyph: '🤖' },
                claude: { label: '深度對話', accent: '#a78bfa', bg: 'linear-gradient(150deg,#1e1830 0%,#171228 55%,#100c1c 100%)', glyph: '✻' },
                tavern: { label: '酒館', accent: '#fb7185', bg: 'linear-gradient(150deg,#2a1620 0%,#1d1018 55%,#130a0f 100%)', glyph: '🎭' },
            };
            const mm = meta[svc] || meta.assistant;
            const card = (
                <div className="w-64">
                    {/* 用原生 <details> 摺疊：默認收起，點頭部展開（無需 React state，避免在分支裡用 hook） */}
                    <details className="group relative rounded-2xl overflow-hidden border shadow-[0_8px_24px_rgba(10,12,20,0.5)] [&_summary]:list-none [&::-webkit-details-marker]:hidden"
                        style={{ borderColor: `${mm.accent}44`, background: mm.bg }}>
                        <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: `radial-gradient(circle, ${mm.accent}55, transparent 70%)` }} />
                        <summary className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b cursor-pointer select-none" style={{ borderColor: `${mm.accent}22` }}>
                            <span className="w-6 h-6 rounded-lg flex items-center justify-center text-[13px] shrink-0" style={{ background: `${mm.accent}22` }}>{mm.glyph}</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-[9px] tracking-[0.22em] font-bold uppercase" style={{ color: mm.accent }}>智能體 · {mm.label}</div>
                                <div className="text-[12px] text-white/90 font-semibold truncate">{pc.serviceName ? `${pc.serviceName} · ${pc.title || ''}` : (pc.title || '一段對話')}</div>
                            </div>
                            <span className="shrink-0 text-[12px] font-bold leading-none transition-transform group-open:rotate-90" style={{ color: mm.accent }}>›</span>
                        </summary>
                        <div className="relative px-3 py-2.5">
                            <p className="text-[12px] leading-[1.7] text-white/65 whitespace-pre-wrap max-h-40 overflow-y-auto no-scrollbar">{pc.detail || ''}</p>
                        </div>
                        <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: `${mm.accent}1e` }}>
                            <span className="text-[9px] italic text-white/35">TA 自己手機上的 AI · {timeStr}</span>
                            <span className="text-[9px] font-bold tracking-wide" style={{ color: mm.accent }}>來自查手機</span>
                        </div>
                    </details>
                </div>
            );
            return commonLayout(card);
        }

        // 人際關係變動卡片（用戶在查手機裡刪/拉黑了角色的好友）
        if (pc.kind === 'relationship') {
            const isBlock = pc.action === 'blocked';
            const rAccent = isBlock ? '#fca5a5' : '#fb7185';
            const card = (
                <div className="w-64">
                    <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_24px_rgba(45,20,30,0.45)]"
                        style={{ borderColor: 'rgba(251,113,133,0.3)', background: 'linear-gradient(160deg,#2a1620 0%,#1d1018 55%,#130a0f 100%)' }}>
                        <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(251,113,133,.3),transparent 70%)' }} />
                        <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: 'rgba(251,113,133,0.18)' }}>
                            <span className="text-sm leading-none">{isBlock ? '🚫' : '💔'}</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-[9px] tracking-[0.25em] font-bold uppercase" style={{ color: rAccent }}>人際關係 · 關係變動</div>
                                <div className="text-[12px] text-white/90 font-semibold truncate">{pc.title || '好友關係變動'}</div>
                            </div>
                            <span className="text-[9px] text-white/35">{timeStr}</span>
                        </div>
                        <div className="relative px-3 py-2.5">
                            <p className="text-[12px] leading-[1.6] text-white/70 whitespace-pre-wrap">
                                <span className="font-semibold" style={{ color: rAccent }}>{pc.by || '對方'}</span> 把你和
                                <span className="font-semibold text-white/90">「{pc.contactName || '某人'}」</span>
                                的好友關係{isBlock ? '拉黑' : '刪除'}了。
                            </p>
                        </div>
                        <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(251,113,133,0.16)' }}>
                            <span className="text-[9px] italic text-white/40">你察覺到是 TA 動的手</span>
                            <span className="text-[9px] font-bold tracking-wide" style={{ color: rAccent }}>來自查手機</span>
                        </div>
                    </div>
                </div>
            );
            return commonLayout(card);
        }

        const accent = '#7dd3fc';
        const isChat = pc.kind === 'chat';
        const card = (
            <div className="w-64">
                <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_24px_rgba(20,30,45,0.4)]"
                    style={{ borderColor: 'rgba(125,211,252,0.28)', background: 'linear-gradient(160deg,#10202b 0%,#0d1822 55%,#0a1019 100%)' }}>
                    <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(125,211,252,.3),transparent 70%)' }} />
                    {/* 頭部 */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: 'rgba(125,211,252,0.16)' }}>
                        <span className="text-sm leading-none" style={{ color: accent }}>🔍</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] font-bold uppercase" style={{ color: accent }}>查手機 · {pc.app || '手機'}</div>
                            <div className="text-[12px] text-white/90 font-semibold truncate">{pc.title || '一條痕跡'}</div>
                        </div>
                        <span className="text-[9px] text-white/35">{timeStr}</span>
                    </div>
                    {/* 配圖：目前只有「軌跡」OOTD/Moments 同步過來的卡片會帶 */}
                    {pc.image && (
                        <div className="relative aspect-[4/5] bg-black/20">
                            <TokenImg value={pc.image} alt="" className="w-full h-full object-cover" />
                        </div>
                    )}
                    {/* 正文 */}
                    <div className="relative px-3 py-2.5">
                        {pc.value && (
                            <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full mb-1.5" style={{ color: accent, background: 'rgba(125,211,252,0.14)' }}>{pc.value}</span>
                        )}
                        {pc.detail && (
                            <p className="text-[12px] leading-[1.6] text-white/65 whitespace-pre-wrap max-h-40 overflow-y-auto no-scrollbar">{pc.detail}</p>
                        )}
                    </div>
                    {/* 頁腳 */}
                    <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: 'rgba(125,211,252,0.16)' }}>
                        <span className="text-[9px] italic text-white/35">{isChat ? 'TA 手機裡的一段對話' : 'TA 手機裡的一條記錄'}</span>
                        <span className="text-[9px] font-bold tracking-wide" style={{ color: accent }}>來自查手機</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'theater_card') {
        const tMeta: any = m.metadata || {};
        const t: any = tMeta.theater || {};
        const lines: any[] = Array.isArray(t.lines) ? t.lines : [];
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const HUE = 262;
        const accent = `hsl(${HUE},75%,72%)`;
        const exposed = tMeta.exposed !== false; // 缺省按已暴露（兼容舊卡片）
        // 由該時段起始時間，給每一拍合成「行為軌跡」時間戳（HH:MM:SS），與窺視面板一致。
        const beatClock = (idx: number): string => {
            const [h, mm] = String(tMeta.slotTime || '00:00').split(':').map((n: string) => parseInt(n, 10));
            const base = (Number.isFinite(h) ? h : 0) * 3600 + (Number.isFinite(mm) ? mm : 0) * 60 + idx * 17;
            const pad = (n: number) => String(n).padStart(2, '0');
            return `${pad(Math.floor(base / 3600) % 24)}:${pad(Math.floor((base % 3600) / 60))}:${pad(base % 60)}`;
        };
        const card = (
            <div className="w-64">
                <div className="relative rounded-2xl overflow-hidden border shadow-[0_8px_28px_rgba(30,18,48,0.5)]"
                    style={{ borderColor: `hsla(${HUE},55%,55%,0.32)`, background: `linear-gradient(160deg,hsl(${HUE},38%,20%) 0%,hsl(${HUE},42%,13%) 58%,#0f0a18 100%)` }}>
                    <div className="absolute -top-7 -right-5 w-24 h-24 rounded-full pointer-events-none" style={{ background: `radial-gradient(circle,hsla(${HUE},70%,60%,.35),transparent 70%)` }} />
                    <div className="absolute inset-0 pointer-events-none opacity-50" style={{ backgroundImage: 'radial-gradient(1px 1px at 22% 30%,rgba(200,180,255,.4),transparent),radial-gradient(1px 1px at 78% 18%,rgba(220,200,255,.35),transparent)' }} />
                    {/* 頭部：窺視回放 · LIVE */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b" style={{ borderColor: `hsla(${HUE},55%,55%,0.2)` }}>
                        <span className="text-sm leading-none" style={{ color: accent, filter: `drop-shadow(0 1px 4px hsla(${HUE},70%,60%,.6))` }}>👁</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[8.5px] tracking-[0.22em] font-bold uppercase flex items-center gap-1.5" style={{ color: accent }}>
                                <span>窺視回放 · {tMeta.slotTime || ''}</span>
                                <span className="w-1 h-1 rounded-full bg-[#ff5a78] animate-pulse" />
                            </div>
                            <div className="text-[12px] text-white/90 font-semibold truncate">{tMeta.emoji ? `${tMeta.emoji} ` : ''}{tMeta.activity || '某個時段'}</div>
                        </div>
                        <span className="text-[9px] text-white/35">{timeStr}</span>
                    </div>
                    {/* 正文：逐拍回放（時間戳 + 氛圍圖標方塊 + 文本） */}
                    <div className="relative px-2.5 py-2.5 max-h-52 overflow-y-auto no-scrollbar space-y-1.5">
                        {lines.length > 0 ? lines.map((l: any, i: number) => (
                            <div key={i} className="flex items-stretch gap-1.5">
                                <span className="flex-shrink-0 w-[42px] pt-1 text-right text-[8px] font-mono leading-tight whitespace-nowrap text-white/28 select-none">{beatClock(i)}</span>
                                <span
                                    className="flex-shrink-0 self-start mt-0.5 w-5 h-5 rounded-md flex items-center justify-center text-[11px]"
                                    style={{ background: `hsl(${HUE},42%,30%)`, border: `1px solid hsla(${HUE},60%,58%,0.45)` }}
                                >
                                    {l?.emotion || '·'}
                                </span>
                                <p
                                    className={`flex-1 min-w-0 text-[12.5px] leading-[1.55] whitespace-pre-wrap break-words ${/[「」“”"]/.test(l?.text || '') ? 'text-white font-medium' : 'text-white/90'}`}
                                >{l?.text || ''}</p>
                            </div>
                        )) : (
                            <p className="text-[11px] text-white/40 italic">（這段窺視沒有內容）</p>
                        )}
                    </div>
                    {/* 頁腳 */}
                    <div className="relative px-3 py-1.5 border-t flex items-center justify-between" style={{ borderColor: `hsla(${HUE},55%,55%,0.2)` }}>
                        <span className="text-[9px] italic text-white/40">你偷看了 TA 的這一刻</span>
                        <span className="text-[9px] font-bold tracking-wide" style={{ color: exposed ? accent : 'rgba(255,255,255,0.4)' }}>
                            {exposed ? 'TA 已察覺' : 'TA 不知情'}
                        </span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'room_card') {
        // 小屋「生活動態」輕量卡片：情緒評估順風車偶爾捎帶的一句小變化（utils/roomAmbient.ts）。
        // content 進上下文，角色自然記得自己幹過啥——不額外建 feed，卡片即記錄。
        const md: any = m.metadata || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const card = (
            <div className="w-56">
                <div
                    className="relative rounded-2xl overflow-hidden border border-amber-200/70 shadow-[0_4px_14px_rgba(200,160,90,0.18)]"
                    style={{ background: 'linear-gradient(160deg,#fffcf5 0%,#fdf6e8 60%,#faf0dc 100%)' }}
                >
                    <div className="relative px-3 pt-2 pb-1.5 flex items-center gap-2 border-b border-amber-200/50">
                        <span className="text-sm leading-none">{md.emoji || '🏠'}</span>
                        <span className="flex-1 text-[9px] tracking-[0.25em] text-amber-500/90 font-bold uppercase">小屋 · 生活動態</span>
                        <span className="text-[9px] text-amber-400/70">{timeStr}</span>
                    </div>
                    <div className="relative px-3 py-2">
                        <p className="text-[12px] leading-[1.6] text-[#6b5636]">
                            <span className="font-bold text-amber-600">{charName || 'Ta'}</span>
                            {md.text || String(m.content || '').replace(/^\[小屋[动動][态態]\]\s*/, '')}
                        </p>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'world_card') {
        const md: any = m.metadata || {};
        const timeStr = new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const narrative: string = md.narrative || '';
        const panel: Record<string, any> = (md.statusPanel && typeof md.statusPanel === 'object') ? md.statusPanel : {};
        const posts: string[] = Array.isArray(md.phonePosts) ? md.phonePosts : [];
        const card = (
            <div className="w-64">
                <div
                    className="relative rounded-2xl overflow-hidden border border-violet-200/70 shadow-[0_6px_20px_rgba(150,130,200,0.22)]"
                    style={{ background: 'linear-gradient(160deg,#fbf7ff 0%,#f1ebfa 55%,#eae3f6 100%)' }}
                >
                    {/* 頂部淡紫光暈 + 月亮 + 星點（淺色系，和彼方的深色拉開差異） */}
                    <div className="absolute -top-6 -right-4 w-24 h-24 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,rgba(214,196,244,.55),transparent 70%)' }} />
                    <div className="absolute top-2.5 right-3.5 w-5 h-5 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle at 38% 35%,#ffffff,#d9cdf0 72%)', boxShadow: '0 0 10px 2px rgba(200,180,245,.5)' }} />
                    <div className="absolute inset-0 pointer-events-none opacity-60" style={{ backgroundImage: 'radial-gradient(1px 1px at 20% 22%,#c9b8ec,transparent),radial-gradient(1px 1px at 60% 16%,#e7c9f0,transparent),radial-gradient(1px 1px at 40% 34%,#bcd0f0,transparent)' }} />
                    {/* 頭部：家園 · 世界名 · 劇情時間 */}
                    <div className="relative px-3 pt-2.5 pb-2 flex items-center gap-2 border-b border-violet-200/50">
                        <span className="text-base leading-none text-violet-400" style={{ filter: 'drop-shadow(0 1px 3px rgba(180,150,230,.5))' }}>⌂</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-violet-400/90 font-bold uppercase">家園 · {md.storyTime || '生活記錄'}</div>
                            <div className="text-[12px] text-[#5b4b7a] font-semibold truncate font-serif">{md.worldName || '共同世界'}</div>
                        </div>
                        <span className="text-[9px] text-violet-400/60">{timeStr}</span>
                    </div>
                    {/* 行為描述 */}
                    <div className="relative px-3 py-2.5">
                        <p className="text-[11px] text-[#6a5790] mb-1">
                            <span className="font-bold text-rose-400">{charName || 'Ta'}</span>
                            {md.location ? ` 在${md.location}` : ''}{md.mood ? ` · ${md.mood}` : ''}
                        </p>
                        {narrative && (
                            <p className="text-[12px] leading-[1.6] text-[#4a3f63] whitespace-pre-wrap max-h-44 overflow-y-auto no-scrollbar">
                                {narrative}
                            </p>
                        )}
                        {/* 數值面板 */}
                        {Object.keys(panel).length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                                {Object.entries(panel).map(([k, v]) => (
                                    <span key={k} className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-100/80 text-violet-600 border border-violet-200/70">
                                        {k} {String(v)}
                                    </span>
                                ))}
                            </div>
                        )}
                        {/* 發的動態 */}
                        {posts.length > 0 && (
                            <div className="mt-2 space-y-1">
                                {posts.map((p, i) => (
                                    <div key={i} className="text-[11px] leading-snug text-violet-700/85 pl-2 border-l-2 border-rose-300/70">
                                        {p}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    {/* 頁腳 */}
                    <div className="relative px-3 py-1.5 border-t border-violet-200/50 flex items-center justify-between">
                        <span className="text-[9px] text-violet-400/70 italic">Ta 在那個世界的生活</span>
                        <span className="text-[9px] text-rose-400/80 font-bold tracking-wide">＋記憶</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'trpg_card') {
        const t: any = m.metadata?.trpg || {};
        const gameTitle: string = t.gameTitle || 'TRPG 跑團';
        const partyNames: string[] = Array.isArray(t.partyNames) ? t.partyNames.filter((n: string) => n && n !== charName) : [];
        const excerpt: Array<{ speaker?: string; text?: string; role?: string }> = Array.isArray(t.excerpt) ? t.excerpt : [];
        const card = (
            <div className="w-72">
                <div
                    className="rounded-2xl overflow-hidden border border-purple-300/30 shadow-[0_6px_20px_rgba(70,40,110,0.28)]"
                    style={{ background: 'linear-gradient(155deg,#2c1c44 0%,#1a1230 100%)' }}
                >
                    {/* 頭部 */}
                    <div className="px-3.5 pt-3 pb-2.5 flex items-center gap-2.5 border-b border-white/10">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg,#a855f7,#ec4899)' }}>
                            <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white"><path d="M12 2 4 6v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10V6l-8-4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-purple-300/80 font-bold uppercase">TRPG · 一起玩的遊戲</div>
                            <div className="text-[13px] text-purple-50 font-semibold truncate font-serif">{gameTitle}</div>
                        </div>
                    </div>
                    {/* 劇情節選 */}
                    <div className="px-3.5 py-3 space-y-2 max-h-60 overflow-hidden">
                        {excerpt.length === 0 && <p className="text-[12px] text-purple-200/70 italic">一段冒險劇情</p>}
                        {excerpt.slice(0, 6).map((e, i) => {
                            const isGM = e.role === 'gm';
                            const text = (e.text || '').replace(/^\*|\*$/g, '').trim();
                            return (
                                <div key={i} className={`text-[12px] leading-relaxed ${isGM ? 'text-purple-100/90 italic' : 'text-purple-50/95'}`}>
                                    {!isGM && e.speaker && <span className="text-pink-300/90 font-semibold mr-1">{e.speaker}:</span>}
                                    <span className={isGM ? 'border-l-2 border-purple-400/40 pl-2 block' : ''}>{text}</span>
                                </div>
                            );
                        })}
                        {excerpt.length > 6 && <div className="text-[10px] text-purple-300/60 text-center pt-0.5">…共 {excerpt.length} 條劇情</div>}
                    </div>
                    {/* 頁腳 */}
                    <div className="px-3.5 py-2 border-t border-white/10 flex items-center justify-between">
                        <span className="text-[9px] text-purple-300/70 italic truncate">{partyNames.length ? `與 ${partyNames.join('、')} 同行` : '我們的冒險'}</span>
                        <span className="text-[9px] text-pink-200/80 font-bold tracking-wide shrink-0 ml-2">＋共同回憶</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'novel_card') {
        const n: any = m.metadata?.novel || {};
        const bookTitle: string = n.bookTitle || '無題';
        const isCoauthor = Array.isArray(n.collaboratorNames) && n.collaboratorNames.includes(charName);
        const coauthors: string[] = Array.isArray(n.collaboratorNames) ? n.collaboratorNames.filter((name: string) => name && name !== charName) : [];
        const chapters: Array<{ index?: number; summary?: string }> = Array.isArray(n.chapters) ? n.chapters : [];
        const card = (
            <div className="w-72">
                <div
                    className="rounded-2xl overflow-hidden border border-amber-300/40 shadow-[0_6px_20px_rgba(120,80,20,0.22)]"
                    style={{ background: 'linear-gradient(155deg,#fdf6e3 0%,#f5e9cf 100%)' }}
                >
                    {/* 頭部 */}
                    <div className="px-3.5 pt-3 pb-2.5 flex items-center gap-2.5 border-b border-amber-900/10">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg,#d97706,#b45309)' }}>
                            <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-white"><path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] tracking-[0.25em] text-amber-700/70 font-bold uppercase">筆友會 · {isCoauthor ? '一起寫的書' : '分享的書'}</div>
                            <div className="text-[13px] text-amber-950 font-semibold truncate font-serif">《{bookTitle}》{n.subtitle ? <span className="text-amber-800/60 text-[11px] ml-1">{n.subtitle}</span> : null}</div>
                        </div>
                    </div>
                    {/* 章節歸檔節選 */}
                    <div className="px-3.5 py-3 space-y-2.5 max-h-60 overflow-hidden">
                        {chapters.length === 0 && <p className="text-[12px] text-amber-800/60 italic font-serif">一段手稿</p>}
                        {chapters.slice(0, 3).map((c, i) => (
                            <div key={i} className="text-[12px] leading-relaxed text-amber-950/85">
                                <span className="text-amber-700 font-semibold font-serif mr-1">第{c.index ?? '?'}章</span>
                                <span className="border-l-2 border-amber-600/25 pl-2 block mt-0.5 line-clamp-3 font-serif">{(c.summary || '').trim()}</span>
                            </div>
                        ))}
                        {chapters.length > 3 && <div className="text-[10px] text-amber-700/50 text-center pt-0.5">…共 {chapters.length} 章歸檔</div>}
                    </div>
                    {/* 頁腳 */}
                    <div className="px-3.5 py-2 border-t border-amber-900/10 flex items-center justify-between">
                        <span className="text-[9px] text-amber-700/60 italic truncate">{isCoauthor ? (coauthors.length ? `與 ${coauthors.join('、')} 合著` : '我們合寫的手稿') : '遞到你手裡的手稿'}</span>
                        <span className="text-[9px] text-amber-700/90 font-bold tracking-wide shrink-0 ml-2">＋共同回憶</span>
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'news_card') {
        const md: any = m.metadata || {};
        const title: string = md.title || '熱點';
        const source: string = md.source || '熱點';
        const url: string | undefined = md.url;
        const desc: string | undefined = (md.desc && md.desc !== title) ? md.desc : undefined;
        const dateStr = new Date(m.timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
        const card = (
            <div
                className="w-60 cursor-pointer active:scale-[0.98] transition-transform"
                onClick={() => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); }}
                style={{ fontFamily: `'Noto Serif','Songti SC','Georgia',serif` }}
            >
                <div
                    className="rounded-lg overflow-hidden border border-stone-400/70 shadow-[0_3px_12px_rgba(60,50,30,0.18)]"
                    style={{ background: 'linear-gradient(170deg,#faf6ec 0%,#f3ecdb 100%)' }}
                >
                    {/* 報頭 */}
                    <div className="px-3 pt-2 pb-1.5 border-b-2 border-double border-stone-500/60">
                        <div className="flex items-center justify-between text-stone-500">
                            <span className="text-[8.5px] tracking-[0.3em] uppercase font-bold">Soren Daily</span>
                            <span className="text-[8.5px] tracking-wide">{dateStr} · 號外</span>
                        </div>
                    </div>
                    {/* 欄目標籤 */}
                    <div className="px-3 pt-2.5">
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-white bg-red-700 px-1.5 py-[1px] tracking-wide shadow-sm">
                            <span className="text-[8px]">▌</span>{source}
                        </span>
                    </div>
                    {/* 標題 */}
                    <div className="px-3 pt-1.5 pb-2">
                        <p
                            className="text-[15px] leading-[1.35] font-black text-stone-900"
                            style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                        >
                            {title}
                        </p>
                        {desc && (
                            <p
                                className="text-[11px] leading-snug text-stone-600 mt-1"
                                style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                            >
                                {desc}
                            </p>
                        )}
                    </div>
                    {/* 頁腳 */}
                    <div className="px-3 py-1.5 flex items-center justify-between border-t border-stone-400/50">
                        <span className="text-[9px] text-stone-500 italic">{charName || 'Ta'} 轉給你看</span>
                        {url
                            ? <span className="text-[10px] text-red-700 font-bold tracking-wide">查看原文 ›</span>
                            : <span className="text-[9px] text-stone-400">熱點速讀</span>}
                    </div>
                </div>
            </div>
        );
        return commonLayout(card);
    }

    if (m.type === 'html_card') {
        const meta: any = m.metadata || {};
        const html: string = (typeof meta.htmlSource === 'string' && meta.htmlSource) ? meta.htmlSource : '';
        if (!html) {
            // 元數據丟了 (老消息或導入數據), 給個友好佔位
            return commonLayout(
                <div className="px-4 py-3 rounded-2xl bg-fuchsia-50 text-fuchsia-500 text-xs italic border border-fuchsia-100">
                    [HTML 卡片數據缺失]
                </div>
            );
        }
        // 渲染邏輯抽到共享組件 components/chat/HtmlCard.tsx（群聊共用），行為不變
        return commonLayout(<HtmlCard html={html} />);
    }

    if (m.type === 'social_card' && m.metadata?.post) {
        const post = m.metadata.post;
        // If the saved image is a raw twemoji codepoint (eg "2728"), convert it to the actual emoji character;
        // otherwise leave whatever the AI / user picked unchanged.
        const rawImage: string | undefined = post.images?.[0];
        let displayImage: string | undefined = rawImage;
        if (typeof rawImage === 'string' && /^[0-9a-fA-F-]+$/.test(rawImage)) {
            try {
                const points = rawImage.split('-').map(c => parseInt(c, 16)).filter(n => Number.isFinite(n));
                if (points.length > 0) displayImage = String.fromCodePoint(...points);
            } catch {}
        }
        return commonLayout(
            <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity">
                <div className="h-32 w-full flex items-center justify-center text-6xl relative overflow-hidden" style={{ background: post.bgStyle || '#fce7f3' }}>
                    {displayImage || <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4c4.png" alt="document" className="w-12 h-12" />}
                    <div className="absolute bottom-0 left-0 w-full p-2 bg-gradient-to-t from-black/30 to-transparent">
                        <div className="text-white text-xs font-bold line-clamp-1">{post.title}</div>
                    </div>
                </div>
                <div className="p-3">
                    <div className="flex items-center gap-2 mb-2">
                        <TokenImg value={post.authorAvatar} className="w-4 h-4 rounded-full" />
                        <span className="text-[10px] text-slate-500">{post.authorName}</span>
                    </div>
                    <p className="text-xs text-slate-600 line-clamp-2 leading-relaxed">{post.content}</p>
                    <div className="mt-2 pt-2 border-t border-slate-50 flex items-center gap-1 text-[10px] text-slate-400">
                        <span className="text-red-400">Spark</span> • 筆記分享
                    </div>
                </div>
            </div>
        );
    }

    // --- Score Card Rendering (Songwriting & Quiz) ---
    if (m.type === 'score_card') {
        let scoreData: any = null;
        try { scoreData = m.metadata?.scoreCard || JSON.parse(m.content); } catch {}

        if (scoreData?.type === 'lifesim_reset_card') {
            return commonLayout(<LifeSimResetCardView card={scoreData} />);
        }

        if (scoreData?.type === 'qixi_event_card') {
            return commonLayout(<QixiEventCardView card={scoreData} timestamp={m.timestamp} interactionProps={interactionProps} />);
        }

        // Guidebook End Card
        if (scoreData?.type === 'guidebook_card') {
            const diff = scoreData.finalAffinity - scoreData.initialAffinity;
            const isPositive = diff > 0;
            return commonLayout(
                <div className="w-72 rounded-2xl overflow-hidden shadow-md" style={{ border: '1.5px solid rgba(200,185,190,0.4)', background: 'linear-gradient(180deg, #f0ebe8 0%, #fff 25%, #ece6e9 100%)' }} {...interactionProps}>
                    {/* Header bar */}
                    <div className="px-4 pt-3 pb-2 flex items-center gap-2.5" style={{ borderBottom: '1px solid rgba(200,185,190,0.2)', background: 'linear-gradient(135deg, rgba(200,185,190,0.2), rgba(190,175,195,0.15))' }}>
                        {scoreData.charAvatar ? (
                            <TokenImg value={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(180,165,170,0.4)' }} />
                        ) : (
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #b8909a, #a07880)' }}>{scoreData.charName?.[0] || '?'}</div>
                        )}
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: '#9b8a8e' }}>攻略本 · 結算報告</div>
                            <div className="text-xs font-bold truncate" style={{ color: '#5a4a50' }}>「{scoreData.title}」</div>
                        </div>
                        <div className={`text-lg font-black shrink-0 ${isPositive ? 'text-emerald-500' : diff < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                            {isPositive ? '+' : ''}{diff}
                        </div>
                    </div>

                    {/* Body */}
                    <div className="px-4 py-3 space-y-2.5">
                        {/* Affinity bar */}
                        <div className="flex items-center gap-2">
                            <span className="text-[9px] font-bold shrink-0" style={{ color: '#9b8a8e' }}>好感度</span>
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(230,220,225,0.6)' }}>
                                <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(Math.max((scoreData.finalAffinity + 100) / 200 * 100, 2), 100)}%`, background: isPositive ? 'linear-gradient(90deg, #c9b1bd, #b8909a)' : 'linear-gradient(90deg, #c8a0a8, #b87880)' }} />
                            </div>
                            <span className="text-[9px] font-mono font-bold shrink-0" style={{ color: '#8b7a7e' }}>{scoreData.finalAffinity}</span>
                        </div>

                        {/* Verdict */}
                        {scoreData.charVerdict && (
                            <div className="text-xs leading-relaxed italic" style={{ color: '#5a4a50' }}>
                                "{scoreData.charVerdict}"
                            </div>
                        )}

                        {/* New Insight (the juicy part) */}
                        {scoreData.charNewInsight && (
                            <div className="rounded-xl px-3 py-2" style={{ background: 'linear-gradient(135deg, rgba(215,230,248,0.6), rgba(200,220,245,0.45))', border: '1px solid rgba(150,185,225,0.35)' }}>
                                <div className="text-[9px] font-bold mb-1 flex items-center gap-1" style={{ color: '#4a6a92' }}>
                                    <span>◆</span> 這局遊戲讓我發現的你
                                </div>
                                <div className="text-xs leading-relaxed italic" style={{ color: '#2a4a68' }}>
                                    {scoreData.charNewInsight}
                                </div>
                            </div>
                        )}

                        {/* Rounds info */}
                        <div className="flex items-center justify-between pt-1" style={{ borderTop: '1px solid rgba(200,185,190,0.15)' }}>
                            <span className="text-[9px]" style={{ color: '#c0b0b5' }}>{scoreData.rounds} 回合</span>
                            <span className="text-[9px] font-bold" style={{ color: '#9b8a8e' }}>攻略本 ♥</span>
                        </div>
                    </div>
                </div>
            );
        }

        // White Day Quiz Card
        if (scoreData?.type === 'whiteday_card') {
            const passed = scoreData.passed;
            return commonLayout(
                <div className="w-72 rounded-2xl overflow-hidden shadow-md" style={{ background: 'linear-gradient(180deg, #fff8f0 0%, #fff 30%, #fdf3e8 100%)', border: '1.5px solid rgba(251,191,110,0.4)' }} {...interactionProps}>
                    {/* Header */}
                    <div className="px-4 pt-3 pb-2.5 flex items-center gap-2.5" style={{ background: 'linear-gradient(135deg, rgba(251,191,110,0.25), rgba(249,168,96,0.15))', borderBottom: '1px solid rgba(251,191,110,0.2)' }}>
                        {scoreData.charAvatar ? (
                            <TokenImg value={scoreData.charAvatar} className="w-9 h-9 rounded-xl object-cover shadow-sm shrink-0" style={{ boxShadow: '0 0 0 2px rgba(251,191,110,0.4)' }} />
                        ) : (
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)' }}>{scoreData.charName?.[0] || '?'}</div>
                        )}
                        <div className="flex-1 min-w-0">
                            <div className="text-[9px] font-bold tracking-widest" style={{ color: '#b45309' }}>白色情人節 · 默契測驗</div>
                            <div className="text-xs font-bold truncate" style={{ color: '#78350f' }}>{scoreData.charName}</div>
                        </div>
                        <div className="shrink-0 text-right">
                            <div className={`text-lg font-black ${passed ? 'text-amber-500' : 'text-slate-400'}`}>
                                {scoreData.score}<span className="text-xs opacity-60">/{scoreData.total}</span>
                            </div>
                            <div className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${passed ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>
                                {passed ? '解鎖 🍫' : '未達標'}
                            </div>
                        </div>
                    </div>
                    {/* Questions list */}
                    <div className="px-3 py-2.5 flex flex-col gap-2">
                        {scoreData.questions?.map((q: any, i: number) => (
                            <div key={i} className="flex items-start gap-2">
                                <span className={`text-xs font-bold shrink-0 mt-0.5 ${q.isCorrect ? 'text-emerald-500' : 'text-red-400'}`}>
                                    {q.isCorrect ? '✓' : '✗'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[11px] font-medium leading-tight" style={{ color: '#4a3520' }}>{q.question}</p>
                                    <p className="text-[10px] mt-0.5" style={{ color: q.isCorrect ? '#6b7280' : '#dc2626' }}>
                                        你選：{q.userAnswer}
                                    </p>
                                    {!q.isCorrect && (
                                        <p className="text-[10px]" style={{ color: '#059669' }}>正確：{q.correctAnswer}</p>
                                    )}
                                    {q.review && (
                                        <p className="text-[10px] italic mt-0.5" style={{ color: '#92400e' }}>「{q.review}」</p>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                    {/* Final dialogue */}
                    {scoreData.finalDialogue && (
                        <div className="px-3 pb-3">
                            <div className="text-[11px] rounded-xl px-3 py-2 leading-relaxed" style={{ background: passed ? 'rgba(251,191,110,0.15)' : 'rgba(0,0,0,0.04)', color: '#78350f', border: '1px solid rgba(251,191,110,0.2)' }}>
                                {scoreData.finalDialogue}
                            </div>
                        </div>
                    )}
                    <div className="px-3 pb-2.5 flex justify-end">
                        <span className="text-[9px]" style={{ color: '#d97706' }}>2026.3.14 白色情人節 🍫</span>
                    </div>
                </div>
            );
        }

        // Quiz Card
        if (scoreData?.type === 'quiz_card') {
            const pct = scoreData.scorePercent || 0;
            const gradientClass = pct === 100 ? 'from-emerald-400 to-teal-500' : pct >= 60 ? 'from-amber-400 to-orange-500' : 'from-red-400 to-rose-500';
            return commonLayout(
                <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100" {...interactionProps}>
                    <div className={`h-24 w-full bg-gradient-to-br ${gradientClass} flex flex-col items-center justify-center text-white relative`}>
                        <div className="text-3xl font-bold">{scoreData.score}<span className="text-lg opacity-70">/{scoreData.total}</span></div>
                        <div className="text-[10px] opacity-80 mt-1">{pct}%</div>
                    </div>
                    <div className="p-3">
                        <div className="text-xs font-bold text-slate-800 truncate">{scoreData.courseTitle}</div>
                        <div className="text-[10px] text-slate-500 truncate mt-0.5">{scoreData.chapterTitle}</div>
                        <div className="mt-2 pt-2 border-t border-slate-50 flex items-center gap-1 text-[10px] text-emerald-500">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4dd.png" alt="" className="w-3 h-3 inline-block" /> 刷題報告
                        </div>
                    </div>
                </div>
            );
        }

        // === Like 520 Card === (必須放在 if (scoreData) 兜底前)
        if (scoreData?.type === 'like520_card') {
            return commonLayout(<Like520ChatCard data={scoreData} />);
        }

        if (scoreData) {
            const coverGradients: Record<string, string> = {
                sunset: 'from-orange-400 via-pink-500 to-purple-600',
                ocean: 'from-cyan-400 via-blue-500 to-indigo-600',
                forest: 'from-emerald-400 via-green-500 to-teal-600',
                midnight: 'from-slate-700 via-indigo-900 to-black',
                cherry: 'from-pink-300 via-rose-400 to-red-500',
                lavender: 'from-purple-300 via-violet-400 to-fuchsia-500',
                golden: 'from-yellow-300 via-amber-400 to-orange-500',
                monochrome: 'from-slate-200 via-slate-300 to-slate-400',
            };
            const gradient = coverGradients[scoreData.coverStyle] || coverGradients.sunset;
            return commonLayout(
                <div className="w-64 bg-white rounded-xl overflow-hidden shadow-sm border border-slate-100 cursor-pointer active:opacity-90 transition-opacity" {...interactionProps}>
                    <div className={`h-28 w-full bg-gradient-to-br ${gradient} flex flex-col items-center justify-center text-white relative`}>
                        <div className="text-3xl mb-1">{scoreData.genreIcon || <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3b5.png" alt="music" className="w-8 h-8" />}</div>
                        <div className="font-bold text-sm">{scoreData.title}</div>
                        {scoreData.subtitle && <div className="text-[10px] opacity-80">{scoreData.subtitle}</div>}
                        {scoreData.status === 'completed' && (
                            <div className="absolute top-2 right-2 bg-white/20 backdrop-blur-sm px-1.5 py-0.5 rounded text-[9px]">已完成</div>
                        )}
                    </div>
                    <div className="p-3">
                        <div className="flex items-center gap-2 mb-2 text-[10px] text-slate-500">
                            <span>{scoreData.genre}</span>
                            <span>·</span>
                            <span>{scoreData.moodIcon} {scoreData.mood}</span>
                            <span>·</span>
                            <span>{scoreData.lineCount} 行</span>
                        </div>
                        {scoreData.lyrics && (
                            <p className="text-xs text-slate-600 line-clamp-3 leading-relaxed whitespace-pre-wrap">{scoreData.lyrics.substring(0, 100)}</p>
                        )}
                        <div className="mt-2 pt-2 border-t border-slate-50 flex items-center gap-1 text-[10px] text-fuchsia-500">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3b5.png" alt="" className="w-3 h-3 inline-block" /> 樂譜分享
                        </div>
                    </div>
                </div>
            );
        }

    }

    if (m.type === 'transfer') {
        return <TransferCard m={m} isUser={isUser} charName={charName} commonLayout={commonLayout} selectionMode={selectionMode} onResolveTransfer={onResolveTransfer} />;
    }

    if (m.type === 'mall_order') {
        return <MallOrderCard m={m} isUser={isUser} charName={charName} commonLayout={commonLayout} />;
    }

    if (m.type === 'life_card') {
        return <LifeRecordCard m={m} charName={charName} commonLayout={commonLayout} selectionMode={selectionMode} onResolveLifeRecord={onResolveLifeRecord} />;
    }

    if (m.type === 'collaboration_file') {
        const fileName = String(m.metadata?.fileName || m.content || '未命名文件');
        const mimeType = String(m.metadata?.mimeType || 'application/octet-stream');
        const rawSize = Number(m.metadata?.fileSize || 0);
        const fileSize = rawSize >= 1024 * 1024
            ? `${(rawSize / (1024 * 1024)).toFixed(rawSize >= 10 * 1024 * 1024 ? 0 : 1)} MB`
            : rawSize >= 1024 ? `${Math.max(1, Math.round(rawSize / 1024))} KB` : `${rawSize || 0} B`;
        const extension = String(m.metadata?.format || fileName.split('.').pop() || 'FILE').toUpperCase().slice(0, 8);
        const isPdf = extension === 'PDF' || mimeType.includes('pdf');
        const isWord = ['DOC', 'DOCX'].includes(extension) || mimeType.includes('wordprocessingml');
        const isInstallable = m.metadata?.collaborationAttachmentKind === 'installable' || mimeType.includes('vnd.sullyos.installable');
        const displayExtension = isInstallable ? '作品' : extension;
        const accentClass = isInstallable
            ? 'bg-violet-50 text-violet-600 border-violet-100'
            : isPdf
            ? 'bg-rose-50 text-rose-600 border-rose-100'
            : isWord ? 'bg-blue-50 text-blue-600 border-blue-100' : 'bg-slate-100 text-slate-600 border-slate-200';
        const badgeClass = isInstallable ? 'bg-violet-600' : isPdf ? 'bg-rose-600' : isWord ? 'bg-blue-600' : 'bg-slate-600';
        const openFile = async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            if (selectionMode) {
                onToggleSelect(m.id);
                return;
            }
            if (!onOpenCollaborationFile || openingCollaborationFile) return;
            setOpeningCollaborationFile(true);
            try {
                await onOpenCollaborationFile(m);
            } finally {
                setOpeningCollaborationFile(false);
            }
        };
        return commonLayout(
            <button
                type="button"
                onClick={openFile}
                disabled={openingCollaborationFile && !selectionMode}
                className="sully-collaboration-file group w-[min(276px,72vw)] overflow-hidden rounded-[18px] border border-slate-200/90 bg-white text-left shadow-[0_8px_24px_rgba(15,23,42,0.08)] transition-[transform,box-shadow,opacity] duration-150 active:scale-[0.985] disabled:opacity-70"
                aria-label={`打開文件 ${fileName}`}
            >
                <span className="flex min-w-0 items-center gap-3.5 px-3.5 py-3.5">
                    <span className={`sully-collaboration-file-icon relative grid h-12 w-11 shrink-0 place-items-center rounded-[13px] border ${accentClass}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
                            <path d="M7 3.75h6.75L18.5 8.5v11.75H7z" />
                            <path d="M13.5 3.75V8.5h5" />
                        </svg>
                        <span className={`absolute -bottom-1 rounded-[5px] px-1.5 py-[1px] text-[7px] font-black tracking-[0.08em] text-white ${badgeClass}`}>{displayExtension}</span>
                    </span>
                    <span className="sully-collaboration-file-meta min-w-0 flex-1">
                        <span className="sully-collaboration-file-name block max-h-[2.7em] overflow-hidden break-words text-[13px] font-semibold leading-[1.35] text-slate-800">{fileName}</span>
                        <span className="sully-collaboration-file-detail mt-1.5 block text-[10px] font-medium tracking-wide text-slate-400">{displayExtension} · {fileSize}</span>
                    </span>
                    <span className="sully-collaboration-file-action grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition-colors group-hover:text-slate-700">
                        {openingCollaborationFile ? (
                            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px] animate-spin" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity=".22"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                        ) : isInstallable ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>
                        ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden="true"><path d="M12 3v12"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/></svg>
                        )}
                    </span>
                </span>
                <span className="block border-t border-slate-100 px-3.5 py-2 text-[9px] font-semibold tracking-[0.12em] text-slate-400">協同工作 · {isInstallable ? '可安裝作品' : '原始文件'}</span>
            </button>
        );
    }

    // 表情氣泡默認尺寸 160→96（吸收社區美化的共識尺寸）。sully-emoji-msg 是給自定義 CSS 用的
    // 穩定錨點——舊美化代碼錨在 .max-w-\[160px\] 類名上，類名一變就失配（恰好無縫退休：
    // 新默認就是它們想要的 96px）；以後想改尺寸請選擇器寫 .sully-emoji-msg，不再錨類名。
    if (m.type === 'emoji') {
        return commonLayout(
            m.content ? (
                <TokenImg value={m.content} className="sully-emoji-msg max-w-[var(--sully-emoji-size,96px)] max-h-[var(--sully-emoji-size,96px)] w-auto h-auto object-contain hover:scale-105 transition-transform drop-shadow-md active:scale-95" loading="lazy" decoding="async" />
            ) : (
                <div className="px-3 py-2 rounded-2xl bg-slate-100 text-slate-400 text-xs italic">[表情已丟失]</div>
            )
        );
    }

    if (m.type === 'image') {
        return commonLayout(
            <div className="relative group">
                {m.content ? (
                    <TokenImg
                        value={m.content}
                        className={`max-w-[200px] max-h-[300px] rounded-2xl${onImageClick ? ' cursor-pointer active:opacity-80 transition-opacity' : ''}`}
                        alt="Uploaded"
                        loading={isLatestMessage ? 'eager' : 'lazy'}
                        decoding="async"
                        onLoad={() => onMediaLoad?.(m.id)}
                        onClick={onImageClick ? () => onImageClick(m) : undefined}
                    />
                ) : (
                    <div className="px-4 py-6 rounded-2xl bg-slate-100 text-slate-400 text-xs italic text-center min-w-[120px]">[圖片已丟失]</div>
                )}
            </div>
        );
    }

    // --- Dynamic Style Generation for Bubble ---
    const cornerRadii = resolveBubbleCornerRadii(styleConfig);
    const borderObj: React.CSSProperties = {
        borderTopLeftRadius: `${cornerRadii.topLeft}px`,
        borderTopRightRadius: `${cornerRadii.topRight}px`,
        borderBottomRightRadius: `${cornerRadii.bottomRight}px`,
        borderBottomLeftRadius: `${cornerRadii.bottomLeft}px`,
    };
    const hideBubbleTail = shouldHideBubbleTail(styleConfig.tailMode, isLastInGroup);
    const bubbleGroupClasses = [
        isFirstInGroup ? 'sully-bubble-group-first' : '',
        isLastInGroup ? 'sully-bubble-group-last' : '',
        hideBubbleTail ? 'sully-bubble-tail-hidden' : 'sully-bubble-tail-visible',
    ].filter(Boolean).join(' ');

    // Container style (BackgroundColor + Opacity) with bubble variant
    const containerStyle: React.CSSProperties = {
        backgroundColor: bubbleVariant === 'outline' ? 'transparent' : styleConfig.backgroundColor,
        opacity: styleConfig.opacity,
        ...borderObj,
        ...(bubbleVariant === 'outline' ? { border: `2px solid ${styleConfig.backgroundColor}`, boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'shadow' ? { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } : {}),
        ...(bubbleVariant === 'flat' ? { boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'wechat' ? { boxShadow: 'none', border: '1px solid rgba(15,23,42,0.05)' } : {}),
        ...(bubbleVariant === 'ios' ? { boxShadow: '0 10px 24px rgba(148,163,184,0.16)', border: '1px solid rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)' } : {}),
    };

    // --- Inline formatting parser: code → bold → italic → plain ---
    const renderInline = (text: string): React.ReactNode[] => {
        // Pre-clean: markdown links [text](url) → just text
        let cleaned = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        // Pre-clean: stray backticks
        cleaned = cleaned.replace(/``+/g, '').replace(/(^|\s)`(\s|$)/g, '$1$2');

        const nodes: React.ReactNode[] = [];
        let nodeKey = 0;

        // Step 1: Split by inline code (`code`)
        const codeParts = cleaned.split(/(`[^`]+`)/g);
        for (const codePart of codeParts) {
            if (codePart.startsWith('`') && codePart.endsWith('`') && codePart.length > 2) {
                nodes.push(<code key={nodeKey++} className="bg-black/10 px-1 py-0.5 rounded text-[13px] font-mono">{codePart.slice(1, -1)}</code>);
                continue;
            }
            // Step 2: Split by bold (**text**)
            const boldParts = codePart.split(/(\*\*[^*]+\*\*)/g);
            for (const boldPart of boldParts) {
                if (boldPart.startsWith('**') && boldPart.endsWith('**') && boldPart.length > 4) {
                    nodes.push(<strong key={nodeKey++} className="font-bold">{boldPart.slice(2, -2)}</strong>);
                    continue;
                }
                // Strip orphaned ** that didn't form a valid bold pair
                const cleanedBold = boldPart.replace(/\*\*/g, '');
                // Step 3: Split by italic (*text*) — safe because ** already stripped
                const italicParts = cleanedBold.split(/(\*[^*]+\*)/g);
                for (const italicPart of italicParts) {
                    if (italicPart.startsWith('*') && italicPart.endsWith('*') && italicPart.length > 2) {
                        nodes.push(<em key={nodeKey++} className="italic opacity-80">{italicPart.slice(1, -1)}</em>);
                        continue;
                    }
                    // Strip orphaned * that didn't form a valid italic pair
                    const cleanedItalic = italicPart.replace(/\*/g, '');
                    if (cleanedItalic) nodes.push(cleanedItalic);
                }
            }
        }
        return nodes;
    };

    // --- Enhanced Text Rendering (Markdown Lite) ---
    const renderContent = (text: string) => {
        // 1. Split by Code Blocks (triple backtick)
        const parts = text.split(/(```[\s\S]*?```)/g);
        return parts.map((part, index) => {
            // Render Code Block
            if (part.startsWith('```') && part.endsWith('```')) {
                const codeContent = part.replace(/^```\w*\n?/, '').replace(/```$/, '');
                return (
                    <pre key={index} className="bg-black/80 text-gray-100 p-3 rounded-lg text-xs font-mono overflow-x-auto my-2 whitespace-pre shadow-inner border border-white/10">
                        {codeContent}
                    </pre>
                );
            }

            // Clean stray backtick artifacts from non-code text
            let cleanedPart = part
                .replace(/``+/g, '')
                .replace(/(^|\s)`(\s|$)/gm, '$1$2');

            // Render Regular Text (split by newlines for paragraph spacing)
            return cleanedPart.split('\n').map((line, lineIdx) => {
                const key = `${index}-${lineIdx}`;

                // Quote Format "> text"
                if (line.trim().startsWith('>')) {
                    const quoteText = line.trim().substring(1).trim();
                    if (!quoteText) return null;
                    return (
                        <div key={key} className="my-1 pl-2.5 border-l-[3px] border-current opacity-70 italic text-[13px]">
                            {renderInline(quoteText)}
                        </div>
                    );
                }

                // Markdown Header "# text" → render as bold text (strip the #)
                const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
                if (headerMatch) {
                    return <div key={key} className="min-h-[1.2em] font-bold">{renderInline(headerMatch[1])}</div>;
                }

                return <div key={key} className="min-h-[1.2em]">{renderInline(line)}</div>;
            });
        });
    };

    // Robust content cleanup: strip legacy markers, separators, bilingual tags, stray formatting
    const stripJunk = (s: string) => stripFishCuesForDisplay(stripLeakedSourceTags(s)
        .replace(/%%TRANS%%[\s\S]*/gi, '')           // legacy translation marker
        .replace(/%%BILINGUAL%%/gi, '\n')            // raw bilingual marker → newline
        // stray bilingual XML tags — 容錯版：全角括號/斜槓、標籤內空格、簡繁、少寫 `>` 的截斷形態
        // (如 `</譯文`) 都吃掉。掉格式消息已經按破標籤落過庫，顯示端不容錯就會原樣漏給用戶。
        .replace(/[<＜]\s*[/／]?\s*(?:翻[译譯譯]|原文|[译譯譯]文)\s*[>＞]?/g, '')
        .replace(/\[\[(?:QU[OA]TE|引用)[：:][\s\S]*?\]\]/g, '')  // residual double-bracket quotes (incl. typos & Chinese)
        .replace(/\[(?:QU[OA]TE|引用)[：:][^\]]*\]/g, '')     // residual single-bracket quotes (incl. typos & Chinese)
        .replace(/\[[^\[\]\n「」]{0,24}引用了[^\[\]\n「」]{0,24}「[^」\n]*?」[^\[\]\n]{0,24}\]\s*/g, '')  // imitated history render [xx引用了xx說的「…」，並回復了 ↓]
        .replace(/\[回[复覆]\s*[""\u201C][^""\u201D]*?[""\u201D](?:\.{0,3})\]\s*[：:]?\s*/g, '')  // [回覆 "content"]: format
        // Residual action/system tags that may have leaked through
        .replace(/\[\[(?:ACTION|RECALL|SEARCH|DIARY|READ_DIARY|FS_DIARY|FS_READ_DIARY|SEND_EMOJI|DIARY_START|DIARY_END|FS_DIARY_START|FS_DIARY_END)[:\s][\s\S]*?\]\]/g, '')
        .replace(/\[schedule_message[^\]]*\]/g, '')
        .replace(/<[语語語]音[^>]*>[\s\S]*?<\/\s*[语語語]音\s*>/g, '')  // strip <語音 ...>...</語音> voice tags (tolerate emotion attr / spaced close)
        .replace(/<[语語語]音[^>]*>[\s\S]*$/g, '')             // 未閉合開標籤 (歷史壞數據): 標籤到末尾都是語音內容, 不當正文顯示
        .replace(/<\/\s*[语語語]音\s*>/g, '')                  // 孤兒閉合標籤 (歷史壞數據): 剝標籤留正文
        .replace(/<字幕>([\s\S]*?)<\/字幕>/g, '$1')          // <字幕>: 剝標籤留中文 (字幕就是氣泡裡該顯示的文字)
        .replace(/<\/?字幕>/g, '')                           // 落單字幕標籤兜底
        .replace(/^\s*---\s*$/gm, '')                // standalone --- lines
        .replace(/``+/g, '')                          // empty/stray backtick pairs
        .replace(/(^|\s)`(\s|$)/gm, '$1$2')         // lone backticks at boundaries
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // markdown links → just text
        // TTS-only markup (<#秒#> 停頓、(sighs) 動作詞) must never show in the bubble
        .replace(/<#\s*[\d.]+\s*#>/g, '')
        .replace(/\(([^)]{1,40})\)/g, (m, inner: string) =>
            VALID_INTERJECTION_TAGS.has(inner.trim().toLowerCase()) ? '' : m)
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([，。！？、；：,.!?…])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')                  // collapse excess newlines
        .trim());   // ⚠️ 末尾再洗一遍魚聲情緒 cue（[excited]/[pause]/(laughs) 等），避免漏到氣泡/翻譯裡

    const sarSurfaceText = typeof m.metadata?.sarModuleSurface?.surface === 'string'
        ? m.metadata.sarModuleSurface.surface.trim()
        : '';
    const hasSarSurface = !!sarSurfaceText;
    const rawContent = hasSarSurface && !showSarTruth ? sarSurfaceText : m.content;

    // 語音文字（轉文字面板 / 語音條預覽）顯示前：先洗 MiniMax 標記，再洗魚聲情緒 cue，
    // 兩家服務商的演出標記都不會漏給用戶看。
    const cleanVoiceText = (t?: string | null) => stripFishCuesForDisplay(cleanVoiceMarkupForDisplay(t ?? ''));

    // 引用快照原樣存著 %%BILINGUAL%% 等原始標記（雙語消息），預覽前先清洗。
    // 歷史快照裡還可能原樣躺著圖片令牌 / data: / 圖床 URL（用戶側引用圖片消息時曾直接落庫），
    // 那種值洗不出正文、截 10 個字就是一串 `blobref:b_`，交給寫入端同一個快照函數換成佔位符。
    const replyPreview = m.replyTo
        ? (isImageValue(m.replyTo.content)
            ? buildReplySnapshotContent({ content: m.replyTo.content })
            : stripJunk(m.replyTo.content))
        : '';

    // Parse %%BILINGUAL%% for bilingual display (langA = "選" language, langB = "譯" language)
    const bilingualIdx = rawContent.toLowerCase().indexOf('%%bilingual%%');
    const hasBilingual = bilingualIdx !== -1;
    const langAContent = hasBilingual ? stripJunk(rawContent.substring(0, bilingualIdx)) : stripJunk(rawContent);
    const langBContent = hasBilingual ? stripJunk(rawContent.substring(bilingualIdx + '%%BILINGUAL%%'.length)) : '';

    // Display: 默認點擊切換；可選“直接展開”時，上方原文 + 下方譯文同時顯示。
    const showExpandedTranslation = Boolean(translationEnabled && translationExpanded && hasBilingual && langBContent);
    const displayContent = showExpandedTranslation
        ? langAContent
        : (isShowingTarget && langBContent) ? langBContent : langAContent;
    const showTranslateButton = translationEnabled && !showExpandedTranslation && hasBilingual && langBContent;

    // Check if raw content has a <語音> tag (voice-only message that hasn't been TTS'd yet).
    // 未閉合的開標籤也算 (歷史壞數據: 語音塊曾被 chunkText 切碎, 開標籤落單) —
    // 當語音條渲染 + 轉文字兜底, 而不是把原始標籤漏給用戶看。
    const voiceMarkupContent = hasSarSurface && !showSarTruth && /<[语語語]音[^>]*>/.test(sarSurfaceText)
        ? sarSurfaceText
        : m.content;
    const hasVoiceTag = !isUser && /<[语語語]音[^>]*>/.test(voiceMarkupContent);
    // Spoken text inside the <語音> tag — lets the placeholder bar offer a 轉文字 toggle
    // even when no audio was synthesized (e.g. character has no MiniMax voice configured),
    // so fake voice messages stay readable just like real ones.
    // 配對優先; 配不上 (未閉合) 就取開標籤之後的全部內容。
    const voiceTagText = hasVoiceTag ? cleanVoiceText((
        voiceMarkupContent.match(/<[语語語]音[^>]*>([\s\S]*?)<\/\s*[语語語]音\s*>/)?.[1]
        ?? voiceMarkupContent.match(/<[语語語]音[^>]*>([\s\S]*)$/)?.[1]
        ?? ''
    ).replace(/<字幕>[\s\S]*?<\/字幕>/g, '').trim()) : '';
    const voiceSubtitleText = cleanVoiceText(
        voiceMarkupContent.match(/<字幕>([\s\S]*?)<\/字幕>/)?.[1] || '',
    );
    const generatedVoiceText = showSarTruth && hasSarSurface && voiceTagText
        ? voiceTagText
        : cleanVoiceText(voiceData?.spokenText);
    const generatedVoiceSubtitle = showSarTruth && hasSarSurface
        ? voiceSubtitleText
        : cleanVoiceText(voiceData?.originalText);
    const hasVoiceContent = voiceData?.url || voiceLoading || hasVoiceTag;
    // Don't render empty bubbles (e.g. messages that were just "---"), unless voice data exists or pending
    if (!displayContent && !hasVoiceContent) return null;

    // Voice-only messages (no display text, only voice bar): skip bubble styling
    const isVoiceOnlyMsg = !displayContent && hasVoiceContent && !isUser && m.type === 'text';

    // 外語語音消息：語音條展開區（轉文字）本身就完整呈現「口播原文 + 中文翻譯」兩行，
    // 頂部氣泡再渲染一遍 displayContent 就成了重複——翻譯模式下頂部是中文、語音條翻譯行
    // 也是中文，用戶看到兩份一樣的翻譯。這類消息把雙語文字統一收進語音條，
    // 頂部不再重複渲染正文，也不再顯示（此時已無意義的）譯/原文切換按鈕。
    const isForeignVoiceMsg = !isUser && m.type === 'text' && !!voiceData?.url && !!voiceData?.lang && !!cleanVoiceText(voiceData?.spokenText);

    return commonLayout(
        <div className={isVoiceOnlyMsg
            ? `relative ${suppressEntranceAnimation ? '' : 'animate-fade-in'}`
            : `relative ${bubbleVariant === 'flat' || bubbleVariant === 'outline' || bubbleVariant === 'wechat' ? '' : 'shadow-sm '}px-5 py-3 ${suppressEntranceAnimation ? '' : 'animate-fade-in'} ${bubbleVariant === 'outline' ? '' : 'border border-black/5 '}active:scale-[0.98] transition-transform overflow-visible ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'} ${bubbleGroupClasses}`}
            style={isVoiceOnlyMsg ? undefined : containerStyle}>

            {/* Layer 1: Background Image with Independent Opacity */}
            {bubbleBgUrl && (
                <div
                    className="absolute inset-0 bg-cover bg-center pointer-events-none z-0"
                    style={{
                        backgroundImage: `url(${bubbleBgUrl})`,
                        opacity: styleConfig.backgroundImageOpacity ?? 0.5,
                        borderRadius: 'inherit'
                    }}
                />
            )}

            {/* Layer 2: Decoration Sticker (Custom Position) */}
            {styleConfig.decoration && (
                <TokenImg
                    value={styleConfig.decoration}
                    className="absolute z-10 w-8 h-8 object-contain drop-shadow-sm pointer-events-none"
                    style={{
                        left: `${styleConfig.decorationX ?? (isUser ? 90 : 10)}%`,
                        top: `${styleConfig.decorationY ?? -10}%`,
                        transform: `translate(-50%, -50%) scale(${styleConfig.decorationScale ?? 1}) rotate(${styleConfig.decorationRotate ?? 0}deg)`
                    }}
                    alt=""
                />
            )}

            {/* Layer 3: Reply/Quote Block */}
            {m.replyTo && (
                <div className="relative z-10 mb-1 text-[10px] bg-black/5 p-1.5 rounded-md border-l-2 border-current opacity-60 flex flex-col gap-0.5 max-w-full overflow-hidden">
                    <span className="font-bold opacity-90 truncate">{m.replyTo.name}</span>
                    <span className="truncate italic">"{replyPreview.length > 10 ? replyPreview.slice(0, 10) + '...' : replyPreview}"</span>
                </div>
            )}

            {/* Layer 4: Text Content — shown when there's visible text after stripping voice tags */}
            {/* 外語語音消息把雙語文字交給下方語音條渲染，頂部不再重複正文 */}
            {displayContent && !isForeignVoiceMsg && (
            <div className="relative z-10 text-[15px] leading-relaxed whitespace-pre-wrap break-all select-text" style={{ color: styleConfig.textColor }}>
                {renderContent(displayContent)}
                {showExpandedTranslation && (
                    <div className="mt-2.5 pt-2 border-t border-current/15">
                        <div className="mb-1 text-[9px] font-bold tracking-[0.16em] opacity-40 select-none">翻譯</div>
                        {renderContent(langBContent)}
                    </div>
                )}
            </div>
            )}

            {hasSarSurface && (displayContent || hasVoiceContent) && (
                <div className="sar-chat-speech-control" style={{ color: styleConfig.textColor }}>
                    <SARSpeechSwitch truth={showSarTruth} moduleTitle={m.metadata?.sarModuleSurface?.moduleTitle}
                        onToggle={() => setShowSarTruth(value => !value)} />
                </div>
            )}

            {/* Layer 5: 雙語「翻譯/原文」切換 —— 氣泡內右下角，細分隔線壓層級，小灰字克制易找 */}
            {showTranslateButton && displayContent && !isForeignVoiceMsg && (
                <div
                    className="relative z-10 mt-2 pt-1.5 flex justify-end"
                    style={{ borderTop: '1px solid rgba(127, 127, 127, 0.16)' }}
                >
                    <button
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onTranslateToggle?.(m.id); }}
                        className="flex items-center gap-1 text-[10px] font-medium transition-opacity active:opacity-80 select-none"
                        style={{ color: styleConfig.textColor, opacity: 0.45 }}
                    >
                        {isShowingTarget ? (
                            <>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clipRule="evenodd" /></svg>
                                <span>原文</span>
                            </>
                        ) : (
                            <>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M7.75 2.75a.75.75 0 0 0-1.5 0v1.258a32.987 32.987 0 0 0-3.599.278.75.75 0 1 0 .198 1.487A31.545 31.545 0 0 1 8.7 5.545 19.381 19.381 0 0 1 7.257 9.04a19.391 19.391 0 0 1-1.727-2.29.75.75 0 1 0-1.29.77 20.9 20.9 0 0 0 2.023 2.684 19.549 19.549 0 0 1-3.158 2.57.75.75 0 1 0 .86 1.229A21.056 21.056 0 0 0 7.5 11.03c1.1.95 2.3 1.79 3.593 2.49a.75.75 0 1 0 .69-1.331A19.545 19.545 0 0 1 8.46 9.89a20.893 20.893 0 0 0 1.91-4.644h2.38a.75.75 0 0 0 0-1.5h-3v-1a.75.75 0 0 0-.75-.75Z" /><path d="M12.75 10a.75.75 0 0 1 .692.462l2.5 6a.75.75 0 1 1-1.384.576l-.532-1.278h-3.052l-.532 1.278a.75.75 0 1 1-1.384-.576l2.5-6A.75.75 0 0 1 12.75 10Zm-1.018 4.26h2.036L12.75 11.6l-1.018 2.66Z" /></svg>
                                <span>翻譯</span>
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Layer 6: Voice Bar */}
            {(voiceData?.url || voiceLoading || hasVoiceTag) && !isUser && m.type === 'text' && (() => {
                const vbBg = styleConfig.voiceBarBg;
                const vbActiveBg = styleConfig.voiceBarActiveBg;
                const vbBtn = styleConfig.voiceBarBtnColor;
                const vbWave = styleConfig.voiceBarWaveColor;
                const vbText = styleConfig.voiceBarTextColor;
                // Voice-only mode: no visible text, voice bar is primary content.
                // 外語語音消息頂部正文已隱藏（交給語音條渲染），同樣按純語音處理，去掉多餘上間距。
                const isVoiceOnly = !!voiceData?.url && (!displayContent || isForeignVoiceMsg);
                return (
                <div className={`sully-voice-bar-shell relative z-10 ${isVoiceOnly ? '' : 'mt-2.5'}`}>
                    {voiceData?.url ? (
                        <div className="max-w-[260px]">
                            <button
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlayVoice?.(m.id); if (!isVoicePlaying) trackEvent('播放语音条'); }}
                                className="sully-voice-bar group flex items-center gap-2.5 w-full px-3 py-2 rounded-2xl transition-all duration-300 active:scale-[0.97] select-none"
                                style={{
                                    background: isVoicePlaying
                                        ? (vbActiveBg || 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(52,211,153,0.08) 100%)')
                                        : (vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0.06) 100%)'),
                                    border: isVoicePlaying
                                        ? `1px solid ${vbBtn ? vbBtn + '33' : 'rgba(16,185,129,0.2)'}`
                                        : '1px solid rgba(0,0,0,0.05)',
                                }}
                            >
                                {/* Play/Pause circle */}
                                <div className="sully-voice-bar-button shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all duration-300"
                                    style={{
                                        backgroundColor: isVoicePlaying ? (vbBtn || '#10b981') : (vbBg ? 'rgba(255,255,255,0.25)' : 'rgba(148,163,184,0.2)'),
                                        boxShadow: isVoicePlaying ? `0 2px 8px ${vbBtn ? vbBtn + '4D' : 'rgba(16,185,129,0.3)'}` : 'none',
                                    }}
                                >
                                    {isVoicePlaying ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-white"><path d="M5.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75A.75.75 0 0 0 7.25 3h-1.5ZM12.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75a.75.75 0 0 0-.75-.75h-1.5Z" /></svg>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill={vbBtn || '#64748b'} className="w-3 h-3 ml-0.5"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                    )}
                                </div>
                                {/* Waveform bars */}
                                <div className="sully-voice-bar-wave flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                    {[4, 10, 6, 14, 8, 12, 5, 11, 7, 13, 4, 9, 6, 11, 5, 8, 10, 7, 12, 6].map((h, i) => (
                                        <div
                                            key={i}
                                            className={`sully-voice-bar-wave-segment w-[2.5px] rounded-full transition-all duration-150 ${isVoicePlaying ? 'animate-pulse' : ''}`}
                                            style={{
                                                height: isVoicePlaying ? `${Math.max(3, h + Math.sin(i * 0.8) * 3)}px` : `${Math.max(2, h * 0.4)}px`,
                                                backgroundColor: isVoicePlaying
                                                    ? (vbWave || `rgba(16, 185, 129, ${0.4 + (h / 14) * 0.5})`)
                                                    : (vbWave ? vbWave + '60' : `rgba(148, 163, 184, ${0.25 + (h / 14) * 0.35})`),
                                                animationDelay: `${i * 60}ms`,
                                                animationDuration: `${600 + (i % 3) * 200}ms`,
                                            }}
                                        />
                                    ))}
                                </div>
                                {/* Text toggle button — always available so user can read the text */}
                                <div
                                    className={`sully-voice-bar-toggle shrink-0 ml-0.5 px-1.5 py-0.5 rounded-lg text-[9px] font-medium transition-all ${showVoiceText ? 'ring-1 ring-current/20' : ''}`}
                                    style={{
                                        color: vbText || 'rgba(100,116,139,0.7)',
                                        backgroundColor: showVoiceText ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.04)',
                                    }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        setShowVoiceText(v => !v);
                                        if (!showVoiceText) trackEvent('把语音条转成文字');
                                    }}
                                >
                                    {showVoiceText ? '收起' : '轉文字'}
                                </div>
                            </button>
                            {/* Expandable text area — shows spoken text + Chinese translation */}
                            {showVoiceText && (
                                <div>
                                    <div className="sully-voice-bar-transcript mt-1.5 px-3 py-2 rounded-xl text-[11px] leading-relaxed space-y-1"
                                        style={{
                                            backgroundColor: vbBg || 'rgba(0,0,0,0.02)',
                                            color: vbText || '#475569',
                                            border: '1px solid rgba(0,0,0,0.04)',
                                        }}
                                    >
                                        {/* When foreign lang voice: show spoken text first, then Chinese translation */}
                                        {voiceData.lang && voiceData.spokenText ? (
                                            <>
                                                <div className="whitespace-pre-wrap">{generatedVoiceText}</div>
                                                {(generatedVoiceSubtitle || displayContent) && (
                                                    <div
                                                        style={{ opacity: 0.65 }}
                                                        className="whitespace-pre-wrap text-[10px] mt-1 pt-1 border-t border-current/10"
                                                    >
                                                        {generatedVoiceSubtitle || displayContent}
                                                    </div>
                                                )}
                                            </>
                                        ) : (
                                            <>
                                                {/* Default: show original text */}
                                                {(generatedVoiceSubtitle || displayContent) && (
                                                    <div className="whitespace-pre-wrap">{generatedVoiceSubtitle || displayContent}</div>
                                                )}
                                                {generatedVoiceText && (
                                                    <div
                                                        style={{ opacity: (generatedVoiceSubtitle || displayContent) ? 0.55 : 1 }}
                                                        className={`whitespace-pre-wrap ${(generatedVoiceSubtitle || displayContent) ? 'text-[10px] mt-1 pt-1 border-t border-current/10' : ''}`}
                                                    >
                                                        {generatedVoiceText}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : voiceLoading ? (
                        <div className="sully-voice-bar sully-voice-bar-loading flex items-center gap-2 px-3 py-2 max-w-[200px] rounded-2xl" style={{ background: vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.04) 100%)', border: '1px solid rgba(0,0,0,0.04)' }}>
                            <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: vbBg ? 'rgba(255,255,255,0.2)' : '#f1f5f9' }}>
                                <svg className="animate-spin h-3.5 w-3.5" style={{ color: vbBtn || '#94a3b8' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3.5"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                            </div>
                            <div className="flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                {[...Array(14)].map((_, i) => (
                                    <div key={i} className="w-[2.5px] rounded-full animate-pulse" style={{ height: `${3 + (i % 3) * 2}px`, backgroundColor: vbWave ? vbWave + '40' : '#e2e8f0', animationDelay: `${i * 100}ms` }} />
                                ))}
                            </div>
                            <span className="text-[10px] shrink-0 animate-pulse" style={{ color: vbText || '#94a3b8' }}>合成中</span>
                        </div>
                    ) : hasVoiceTag ? (
                        /* Voice tag exists in content but no audio yet — either TTS is still
                           pending (app restart / auto-TTS) or the character has no MiniMax voice
                           configured. Offer a 轉文字 toggle here too so the text stays readable,
                           aligning fake voice messages with real ones. */
                        <div className="max-w-[260px]">
                            <div
                                className="sully-voice-bar sully-voice-bar-placeholder flex items-center gap-2 px-3 py-2 rounded-2xl"
                                style={{ background: vbBg || 'linear-gradient(135deg, rgba(0,0,0,0.03) 0%, rgba(0,0,0,0.06) 100%)', border: '1px solid rgba(0,0,0,0.05)' }}
                            >
                                <button
                                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); onPlayVoice?.(m.id); }}
                                    className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center active:scale-[0.92] transition-transform"
                                    style={{ backgroundColor: vbBg ? 'rgba(255,255,255,0.25)' : 'rgba(148,163,184,0.2)' }}
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill={vbBtn || '#64748b'} className="w-3 h-3 ml-0.5"><path d="M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" /></svg>
                                </button>
                                <div className="flex-1 flex items-center gap-[3px] h-5 overflow-hidden">
                                    {[4, 10, 6, 14, 8, 12, 5, 11, 7, 13, 4, 9, 6, 11, 5, 8, 10, 7, 12, 6].map((h, i) => (
                                        <div key={i} className="w-[2.5px] rounded-full" style={{ height: `${Math.max(2, h * 0.4)}px`, backgroundColor: vbWave ? vbWave + '60' : `rgba(148, 163, 184, ${0.25 + (h / 14) * 0.35})` }} />
                                    ))}
                                </div>
                                {(voiceTagText || displayContent) ? (
                                    <div
                                        className={`shrink-0 ml-0.5 px-1.5 py-0.5 rounded-lg text-[9px] font-medium transition-all ${showVoiceText ? 'ring-1 ring-current/20' : ''}`}
                                        style={{
                                            color: vbText || 'rgba(100,116,139,0.7)',
                                            backgroundColor: showVoiceText ? 'rgba(0,0,0,0.08)' : 'rgba(0,0,0,0.04)',
                                        }}
                                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowVoiceText(v => !v); if (!showVoiceText) trackEvent('把语音条转成文字'); }}
                                    >
                                        {showVoiceText ? '收起' : '轉文字'}
                                    </div>
                                ) : (
                                    <span className="text-[9px] shrink-0" style={{ color: vbText || 'rgba(100,116,139,0.7)' }}>語音</span>
                                )}
                            </div>
                            {showVoiceText && (voiceTagText || displayContent) && (
                                <div className="sully-voice-bar-transcript mt-1.5 px-3 py-2 rounded-xl text-[11px] leading-relaxed whitespace-pre-wrap"
                                    style={{
                                        backgroundColor: vbBg || 'rgba(0,0,0,0.02)',
                                        color: vbText || '#475569',
                                        border: '1px solid rgba(0,0,0,0.04)',
                                    }}
                                >
                                    {voiceTagText || displayContent}
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
                );
            })()}
        </div>
    );
}, (prev, next) => {
    return prev.msg.id === next.msg.id &&
           prev.msg.content === next.msg.content &&
           // 可交互卡片的狀態活在 metadata 裡（生活記錄卡確認/否決、轉帳卡收退款）。
           // 這裡不深比整個 metadata（可能含大對象），只盯這幾個會改變渲染的狀態位——
           // 否則用戶點了「確認」，DB 已更新、消息已重載，卡片卻因 memo 判等而紋絲不動。
           prev.msg.metadata?.reviewStatus === next.msg.metadata?.reviewStatus &&
           prev.msg.metadata?.status === next.msg.metadata?.status &&
           prev.msg.metadata?.receipt === next.msg.metadata?.receipt &&
           prev.msg.metadata?.sarModuleSurface?.surface === next.msg.metadata?.sarModuleSurface?.surface &&
           prev.isFirstInGroup === next.isFirstInGroup &&
           prev.isLastInGroup === next.isLastInGroup &&
           prev.activeTheme === next.activeTheme &&
           prev.charAvatar === next.charAvatar &&
           prev.charName === next.charName &&
           prev.userAvatar === next.userAvatar &&
           prev.isLatestMessage === next.isLatestMessage &&
           prev.onMediaLoad === next.onMediaLoad &&
           prev.selectionMode === next.selectionMode &&
           prev.isSelected === next.isSelected &&
           prev.translationEnabled === next.translationEnabled &&
           prev.translationExpanded === next.translationExpanded &&
           prev.isShowingTarget === next.isShowingTarget &&
           prev.avatarShape === next.avatarShape &&
           prev.avatarSize === next.avatarSize &&
           prev.avatarMode === next.avatarMode &&
           prev.bubbleVariant === next.bubbleVariant &&
           prev.messageSpacing === next.messageSpacing &&
           prev.showTimestamp === next.showTimestamp &&
           prev.moduleAlign === next.moduleAlign &&
           prev.suppressEntranceAnimation === next.suppressEntranceAnimation &&
           prev.voiceData?.url === next.voiceData?.url &&
           prev.voiceLoading === next.voiceLoading &&
           prev.isVoicePlaying === next.isVoicePlaying;
});

export default MessageItem;
