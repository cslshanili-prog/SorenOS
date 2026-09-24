import { avatarDecorationImageStyle, isAnniversaryFrame } from '../utils/anniversaryGifts';
import { loadCharacterContextMessages } from '../utils/chatContextRange';

import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { AppID, Message, GroupProfile, CharacterProfile, NPCProfile, MessageType, ChatTheme, BubbleStyle, EmojiCategory } from '../types';
import { safeResponseJson } from '../utils/safeApi';
import { generateNpcGroupGuestLine } from '../utils/npcGroupGuestLine';
import Modal from '../components/os/Modal';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { deleteGroupMemoriesByGroupId } from '../utils/memoryPalace/groupPipeline';
import { processImage } from '../utils/file';
import { stickerNameFromUrl } from '../utils/messageFormat';
import { PRESET_THEMES } from '../components/chat/ChatConstants';
import { resolveChatTheme, scopeBubbleThemeCss } from '../utils/groupChat/theme';
import { resolveBubbleCornerRadii, shouldHideBubbleTail } from '../utils/bubbleAppearance';
import { buildChatFineTuneCss } from '../utils/chatFineTuneCss';
import { parseDirectorActions, stripSkipMarker, parseGroupTopicBox } from '../utils/groupChat/parse';
import { GroupPacketMeta, PacketReceiptMeta, ClaimResult, claimPacket, effectivePacketStatus, makePacketMeta } from '../utils/groupChat/redpacket';
import { messageLogText } from '../utils/groupChat/format';
import { trackEvent } from '../utils/analytics';
import { chatReturnTarget } from '../utils/chatReturnTarget';
import { REAL_IDENTITY_PERSONA_ID, resolveUserProfileForGroup } from '../utils/userPersona';
import { markAmsgStateDirty, type AmsgDirtyReason } from '../utils/amsgStateSync';
import { buildMemberTimeline, DEFAULT_MEMBER_TIMELINE_CAP } from '../utils/groupChat/timeline';
import { buildEmojiContextStr, buildGroupHistoryBlock, buildDirectorInstruction, buildRoundRobinInstruction, DEFAULT_MAX_ROUND_MESSAGES, GroupHistoryBlock } from '../utils/groupChat/prompts';
import { dispatchMemberActions } from '../utils/groupChat/dispatch';
import { activeGroupNpcs, buildNpcMemberBlock, buildSpeakerDirectory, groupNpcs } from '../utils/groupChat/npcMembers';
import { resolveNpcApi } from '../utils/npcMemory';
import { refreshNpcMemoryFromGroups } from '../utils/npcMemoryRuntime';
import { completeGroupChatWithMcp } from '../utils/groupChat/mcp';
import { CharacterGroupFilterBar, filterCharactersByGroup, GROUP_FILTER_ALL } from '../components/character/CharacterGroupFilter';
// 群聊輸入區/表情面板已改用共享 ChatInputArea（其表情網格自帶 useIncrementalReveal 增量渲染），
// master 上給舊內聯表情抽屜加的增量渲染隨舊抽屜一併退役。
import { UsersThree, Money, GearSix, Image as ImageIcon, ArrowsClockwise, PaintBrush, BellSimpleRinging, Code, Question, MaskHappy, Crown, SpeakerSlash } from '@phosphor-icons/react';
import ChatHeaderShell from '../components/chat/ChatHeaderShell';
import ChatInputArea from '../components/chat/ChatInputArea';
import { loadChatInputPreferences, saveChatInputPreferences } from '../utils/chatInputPreferences';
import ChatInputSettings from '../components/chat/ChatInputSettings';
import { useChatAutoReply } from '../hooks/useChatAutoReply';
import TokenImg from '../components/os/TokenImg';
import { useBlobRefUrl, isBlobRef, getBlobForRef, migrateDataUrlToRef } from '../utils/blobRef';
import { buildReplySnapshotContent } from '../utils/applyAssistantPostProcessing';
import ChromeCssEditor from '../components/chat/ChromeCssEditor';
import WhiteboxSoundEditor from '../components/chat/WhiteboxSoundEditor';
import HtmlCard from '../components/chat/HtmlCard';
import { WhiteboxSound, parseWhiteboxSound, upsertWhiteboxSound, stripWhiteboxSoundDirective, resolveActiveSound, playWhiteboxSound, unlockWhiteboxAudio } from '../utils/whiteboxSound';
import { buildHtmlPrompt } from '../utils/htmlPrompt';
import { materializeVisionDescriptions } from '../utils/visionApi';
import {
    buildGroupTopicContext,
    buildGroupTopicPrompt,
    GROUP_TOPIC_BUFFER_THRESHOLD,
    GROUP_TOPIC_HOT_ZONE,
    groupTopicPendingCount,
    makeGroupTopicBox,
    planGroupTopicBatch,
} from '../utils/groupChat/topicBoxes';

const TWEMOJI_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72';
const twemojiUrl = (codepoint: string) => `${TWEMOJI_BASE}/${codepoint}.png`;

// 複用 Chat.tsx 的高顏值樣式邏輯，但針對群聊微調
const PRESET_THEME_GROUP: ChatTheme = {
    id: 'group_default', name: 'Group', type: 'preset',
    user: { textColor: '#ffffff', backgroundColor: '#8b5cf6', borderRadius: 18, opacity: 1 }, // Violet for User
    ai: { textColor: '#1e293b', backgroundColor: '#ffffff', borderRadius: 18, opacity: 1 }  // White for Others
};

// --- Sub-Component: 紅包卡片（2.0：拼手氣/專屬 + 狀態角標 + 回執結算條；舊數據 legacy 簡卡） ---
const GroupPacketCard = ({ msg, nameOf, onOpen }: {
    msg: Message;
    nameOf: (id: string) => string;
    onOpen?: (msg: Message) => void;
}) => {
    const meta = msg.metadata as (Partial<GroupPacketMeta> & Partial<PacketReceiptMeta>) | undefined;

    // 回執：mini 結算條（對齊私聊 TransferCard 的回執視覺）
    if (meta?.packetReceipt) {
        const claimed = meta.packetReceipt === 'claimed';
        return (
            <div className={`px-3 py-2 rounded-xl border text-[11px] flex items-center gap-2 ${claimed ? 'bg-emerald-50 border-emerald-100 text-emerald-600' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                <span>🧧</span>
                <span>{meta.claimantName} {claimed ? '領取了' : '退回了'} {meta.senderName} 的紅包{claimed && meta.amount != null ? ` ¥${meta.amount}` : ''}</span>
            </div>
        );
    }

    // 舊數據（無 packet 判別字段）：legacy 簡卡，渲染不變語義
    if (!meta?.packet) {
        return (
            <div className="w-60 bg-[#fb923c] text-white p-3 rounded-xl flex items-center gap-3 shadow-md relative overflow-hidden">
                <div className="text-2xl">🧧</div>
                <div className="z-10">
                    <div className="font-bold text-sm tracking-wide">紅包 / 轉帳</div>
                    <div className="text-[10px] opacity-90">Sully Pay</div>
                </div>
            </div>
        );
    }

    const m = meta as GroupPacketMeta;
    const status = effectivePacketStatus(m, Date.now());
    const opened = status !== 'pending';
    const statusText = m.packetType === 'lucky'
        ? (status === 'pending' ? `剩 ${m.shares - m.claims.length} 份可搶` : status === 'done' ? '已領完' : '已過期')
        : (status === 'pending' ? `待 ${nameOf(m.targetId || '')} 領取` : status === 'done' ? '已收下' : status === 'returned' ? '已退回' : '已過期');

    return (
        <div
            onClick={() => onOpen?.(msg)}
            className={`w-60 p-3 rounded-xl flex items-center gap-3 shadow-md relative overflow-hidden active:scale-95 transition-transform cursor-pointer text-white ${opened ? 'bg-[#f0b48c]' : 'bg-gradient-to-br from-[#fb923c] to-[#f43f5e]'}`}
        >
            <div className="text-3xl drop-shadow-sm">🧧</div>
            <div className="z-10 min-w-0 flex-1 pb-3">
                <div className="font-bold text-sm tracking-wide truncate">{m.note}</div>
                <div className="text-[10px] opacity-90">{m.packetType === 'lucky' ? `拼手氣紅包 · ${m.shares} 份` : `專屬紅包 · 給 ${nameOf(m.targetId || '')}`}</div>
            </div>
            <div className="absolute right-2 bottom-1.5 text-[9px] bg-black/20 px-1.5 py-0.5 rounded-full whitespace-nowrap">{statusText}</div>
        </div>
    );
};

// --- Sub-Component: Group Message Bubble ---
const GroupMessageItem = React.memo(({
    msg,
    isUser,
    char,
    userAvatar,
    onImageClick,
    selectionMode,
    isSelected,
    onToggleSelect,
    onLongPress,
    onReply,
    nameOf,
    onPacketClick,
    styleConfig,
    themeScopeClass,
    isFirstInGroup,
    isLastInGroup,
    avatarShape = 'circle',
    avatarSize = 'medium',
    avatarMode = 'grouped',
    bubbleVariant = 'modern',
    messageSpacing = 'default',
    showTimestamp = 'always',
}: {
    msg: Message,
    isUser: boolean,
    char?: CharacterProfile | NPCProfile,
    userAvatar: string,
    onImageClick: (url: string) => void,
    selectionMode: boolean,
    isSelected: boolean,
    onToggleSelect: (id: number) => void,
    onLongPress: (id: number) => void,
    onReply: (msg: Message) => void,
    nameOf: (id: string) => string,
    onPacketClick: (msg: Message) => void,
    /** 氣泡樣式（用戶=群設置選的主題 user 側；成員=統一或各自私聊主題 ai 側）。引用需穩定（memo） */
    styleConfig: BubbleStyle,
    /** 將當前成員的氣泡工坊 CSS 限定在自己的消息上，防止群成員主題互串。 */
    themeScopeClass: string,
    isFirstInGroup: boolean,
    isLastInGroup: boolean,
    avatarShape?: 'circle' | 'rounded' | 'square',
    avatarSize?: 'small' | 'medium' | 'large',
    avatarMode?: 'grouped' | 'every_message',
    bubbleVariant?: 'modern' | 'flat' | 'outline' | 'shadow' | 'wechat' | 'ios',
    messageSpacing?: 'compact' | 'default' | 'spacious',
    showTimestamp?: 'always' | 'hover' | 'never',
}) => {
    const avatar = isUser ? userAvatar : char?.avatar;
    const name = isUser ? '我' : char?.name || '未知成員';

    const spacingClass = messageSpacing === 'compact'
        ? (isLastInGroup ? 'mb-3' : 'mb-0.5')
        : messageSpacing === 'spacious'
            ? (isLastInGroup ? 'mb-8' : 'mb-2.5')
            : (isLastInGroup ? 'mb-6' : 'mb-1.5');
    const avatarSizeClass = avatarSize === 'small' ? 'w-7 h-7' : avatarSize === 'large' ? 'w-12 h-12' : 'w-9 h-9';
    const avatarSizePx = avatarSize === 'small' ? 28 : avatarSize === 'large' ? 48 : 36;
    const avatarRadiusClass = avatarShape === 'square' ? 'rounded-sm' : avatarShape === 'rounded' ? 'rounded-xl' : 'rounded-full';
    const shouldShowAvatar = avatarMode === 'every_message' || isLastInGroup;
    const cornerRadii = resolveBubbleCornerRadii(styleConfig);
    const hideBubbleTail = shouldHideBubbleTail(styleConfig.tailMode, isLastInGroup);
    const bubbleGroupClasses = [
        isFirstInGroup ? 'sully-bubble-group-first' : '',
        isLastInGroup ? 'sully-bubble-group-last' : '',
        hideBubbleTail ? 'sully-bubble-tail-hidden' : 'sully-bubble-tail-visible',
    ].filter(Boolean).join(' ');
    const bubbleStyle: React.CSSProperties = {
        backgroundColor: bubbleVariant === 'outline' ? 'transparent' : styleConfig.backgroundColor,
        opacity: styleConfig.opacity ?? 1,
        borderTopLeftRadius: cornerRadii.topLeft,
        borderTopRightRadius: cornerRadii.topRight,
        borderBottomRightRadius: cornerRadii.bottomRight,
        borderBottomLeftRadius: cornerRadii.bottomLeft,
        ...(bubbleVariant === 'outline' ? { border: `2px solid ${styleConfig.backgroundColor}`, boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'shadow' ? { boxShadow: '0 4px 12px rgba(0,0,0,0.12)' } : {}),
        ...(bubbleVariant === 'flat' ? { boxShadow: 'none' } : {}),
        ...(bubbleVariant === 'wechat' ? { boxShadow: 'none', border: '1px solid rgba(15,23,42,0.05)' } : {}),
        ...(bubbleVariant === 'ios' ? { boxShadow: '0 10px 24px rgba(148,163,184,0.16)', border: '1px solid rgba(255,255,255,0.75)', backdropFilter: 'blur(12px)' } : {}),
    };
    // 氣泡底紋畫在 CSS background-image 上，拿不到 <img> 那層的自動解析，只能在頂層
    // 無條件解析一次（hook 不能進條件分支）。掛件/頭像掛件走 TokenImg，各自組件內解析。
    const bubbleBgUrl = useBlobRefUrl(styleConfig.backgroundImage);

    // pointer-event 手勢（對齊私聊 MessageItem 的方案）：600ms 長按 → 操作菜單；
    // 觸屏左滑 ≤-52px → 引用回覆（帶位移動畫）；鼠標右鍵 → 操作菜單
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const startPos = useRef({ x: 0, y: 0 });
    const activePointerId = useRef<number | null>(null);
    const activePointerType = useRef<string>('');
    const replyGestureActiveRef = useRef(false);
    const replyReadyRef = useRef(false);
    const [replyOffset, setReplyOffset] = useState(0);
    const [isReplyGestureActive, setIsReplyGestureActive] = useState(false);

    // Time formatting
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

    const clearLongPressTimer = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };

    const resetReplyGesture = () => {
        replyGestureActiveRef.current = false;
        replyReadyRef.current = false;
        setIsReplyGestureActive(false);
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
            onLongPress(msg.id);
        }, 600);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        const diffX = e.clientX - startPos.current.x;
        const diffY = e.clientY - startPos.current.y;
        const isTouchPointer = activePointerType.current !== 'mouse';

        if (!replyGestureActiveRef.current) {
            const startsReplySwipe = isTouchPointer
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
        replyReadyRef.current = nextOffset <= -52;
        setReplyOffset(nextOffset);
    };

    const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (activePointerId.current !== e.pointerId) return;
        clearLongPressTimer();
        activePointerId.current = null;
        activePointerType.current = '';

        const shouldReply = replyGestureActiveRef.current && replyReadyRef.current;
        resetReplyGesture();

        if (shouldReply) onReply(msg);
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
            onToggleSelect(msg.id);
        }
    };

    const renderAvatar = (forceVisible = false) => (
        <div className={`relative ${avatarSizeClass} z-0 sully-chat-message-avatar`}>
            {(forceVisible || shouldShowAvatar) && (
                <>
                    <TokenImg
                        value={avatar}
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
                            alt=""
                        />
                    )}
                </>
            )}
        </div>
    );

    // Special Content Renderers
    const renderContent = () => {
        switch (msg.type) {
            case 'image':
                return (
                    <div className="relative group cursor-pointer" onClick={(e) => {
                        if (selectionMode) handleClick(e);
                        else onImageClick(msg.content);
                    }}>
                        <TokenImg value={msg.content} className="max-w-[200px] max-h-[200px] rounded-xl shadow-sm border border-black/5" loading="lazy" />
                    </div>
                );
            case 'emoji':
                // 尺寸跟隨外觀 → 表情包大小（--sully-emoji-size 三擋，默認 96px = 原 w-24）
                return <TokenImg value={msg.content} className="sully-emoji-msg max-w-[var(--sully-emoji-size,96px)] max-h-[var(--sully-emoji-size,96px)] object-contain drop-shadow-sm hover:scale-110 transition-transform" />;
            case 'transfer':
                return (
                    <div onClick={(e) => { if (selectionMode) handleClick(e); }}>
                        <GroupPacketCard msg={msg} nameOf={nameOf} onOpen={selectionMode ? undefined : onPacketClick} />
                    </div>
                );
            case 'html_card': {
                const html = typeof msg.metadata?.htmlSource === 'string' ? msg.metadata.htmlSource : '';
                if (!html) {
                    return (
                        <div className="px-4 py-3 rounded-2xl bg-fuchsia-50 text-fuchsia-500 text-xs italic border border-fuchsia-100">
                            [HTML 卡片數據缺失]
                        </div>
                    );
                }
                return <HtmlCard html={html} />;
            }
            default:
                return (
                    <div
                        className={`relative px-5 py-3 text-[15px] leading-relaxed whitespace-pre-wrap break-all overflow-visible active:scale-[0.98] transition-transform ${bubbleVariant === 'flat' || bubbleVariant === 'outline' || bubbleVariant === 'wechat' ? '' : 'shadow-sm'} ${bubbleVariant === 'outline' ? '' : 'border border-black/5'} ${isUser ? 'sully-bubble-user' : 'sully-bubble-ai'} ${bubbleGroupClasses}`}
                        style={bubbleStyle}
                    >
                        {bubbleBgUrl && (
                            <div
                                className="absolute inset-0 bg-cover bg-center pointer-events-none z-0"
                                style={{
                                    backgroundImage: `url(${bubbleBgUrl})`,
                                    opacity: styleConfig.backgroundImageOpacity ?? 0.5,
                                    borderRadius: 'inherit',
                                }}
                            />
                        )}
                        {styleConfig.decoration && (
                            <TokenImg
                                value={styleConfig.decoration}
                                className="absolute z-10 w-8 h-8 object-contain drop-shadow-sm pointer-events-none"
                                style={{
                                    left: `${styleConfig.decorationX ?? (isUser ? 90 : 10)}%`,
                                    top: `${styleConfig.decorationY ?? -10}%`,
                                    transform: `translate(-50%, -50%) scale(${styleConfig.decorationScale ?? 1}) rotate(${styleConfig.decorationRotate ?? 0}deg)`,
                                }}
                                alt=""
                            />
                        )}
                        {msg.replyTo && (
                            <div className="relative z-10 mb-1 text-[10px] bg-black/5 p-1.5 rounded-md border-l-2 border-current opacity-60 flex flex-col gap-0.5 max-w-full overflow-hidden">
                                <span className="font-bold opacity-90 truncate">{msg.replyTo.name}</span>
                                {/* 歷史快照裡可能原樣存著令牌 / data: / 圖床 URL，直接截 10 個字
                                    就成了氣泡裡一串 `blobref:b_`；交給寫入端同一個快照函數換佔位符 */}
                                <span className="truncate italic">"{buildReplySnapshotContent({ content: msg.replyTo.content })}"</span>
                            </div>
                        )}
                        <div className="relative z-10 select-text" style={{ color: styleConfig.textColor }}>{msg.content}</div>
                    </div>
                );
        }
    };

    return (
        <div
            className={`${themeScopeClass} sully-chat-message ${isUser ? 'sully-chat-message-user justify-end' : 'sully-chat-message-ai justify-start'} ${isFirstInGroup ? 'sully-chat-message-group-first' : ''} ${isLastInGroup ? 'sully-chat-message-group-last' : ''} flex items-end ${spacingClass} px-3 w-full group relative transition-[padding] duration-300 ${selectionMode ? 'pl-12' : ''}`}
            style={{ '--sully-chat-message-avatar-size': `${avatarSizePx}px` } as React.CSSProperties}
        >
            {selectionMode && (
                <div className="absolute left-3 top-1/2 -translate-y-1/2 cursor-pointer z-20" onClick={handleClick}>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-violet-500 border-violet-500' : 'border-slate-300 bg-white'}`}>
                        {isSelected && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                    </div>
                </div>
            )}

            {isFirstInGroup && (
                <div className={`sully-chat-turn-avatar-slot hidden absolute top-0 z-0 ${isUser ? 'right-3' : (selectionMode ? 'left-14' : 'left-3')}`}>
                    {renderAvatar(true)}
                </div>
            )}

            {!isUser && (
                <div className={`sully-chat-message-avatar-slot absolute bottom-0 z-0 ${selectionMode ? 'left-14' : 'left-3'} transition-[left] duration-300`}>
                    {renderAvatar()}
                </div>
            )}

            <div className={`sully-chat-message-content relative min-w-0 max-w-[72%] ${isUser ? 'mr-12' : 'ml-12'}`}>
                <div
                    className={`relative flex flex-col ${isUser ? 'items-end' : 'items-start'} min-w-0 ${selectionMode ? 'pointer-events-none' : ''}`}
                    style={{
                        transform: `translateX(${replyOffset}px)`,
                        transition: isReplyGestureActive ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
                        touchAction: 'pan-y',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        WebkitTouchCallout: 'none',
                    } as React.CSSProperties}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerCancel}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        if (selectionMode || replyGestureActiveRef.current) return;
                        clearLongPressTimer();
                        activePointerId.current = null;
                        activePointerType.current = '';
                        resetReplyGesture();
                        onLongPress(msg.id);
                    }}
                    onDragStart={(e) => e.preventDefault()}
                    onClick={handleClick}
                >
                    {!isUser && isFirstInGroup && (
                        <span className="sully-chat-message-sender text-[10px] text-slate-400 ml-1 mb-1">
                            {name}
                            {/* 旁觀時用戶代這位成員說的：只給用戶自己看，AI 那邊就是這位成員說的 */}
                            {msg.metadata?.puppeted && <span className="ml-1 px-1 rounded bg-violet-100 text-violet-500 text-[9px] font-bold">代打</span>}
                        </span>
                    )}
                    <div className={selectionMode ? 'pointer-events-none' : ''}>
                        {renderContent()}
                    </div>
                    {isLastInGroup && showTimestamp !== 'never' && (
                        <span className={`absolute top-full ${isUser ? 'right-0' : 'left-0'} mt-0.5 px-1 text-[9px] text-slate-400/80 font-medium whitespace-nowrap pointer-events-none ${showTimestamp === 'hover' ? 'opacity-0 group-hover:opacity-100 transition-opacity' : ''}`}>{timeStr}</span>
                    )}
                </div>
            </div>

            {isUser && (
                <div className="sully-chat-message-avatar-slot absolute right-3 bottom-0 z-0">
                    {renderAvatar()}
                </div>
            )}
        </div>
    );
});

// --- Main Component ---

const GroupChat: React.FC = () => {
    const { closeApp, openApp, groups, createGroup, updateGroup, deleteGroup, characters, npcs, updateNPC, apiConfig, addToast, userProfile, userProfileBase, updateUserProfile, virtualTime, characterGroups, theme: osTheme, customThemes, realtimeConfig, pendingGroupChatId, consumePendingGroupChat } = useOS();
    const [view, setView] = useState<'list' | 'chat'>('list');
    // 從 Chat 主頁深鏈進某個群時記一下"返回鍵該回哪"；本群列表內部正常點進/退出都不涉及它，
    // 只有通過 pendingGroupChatId 深鏈進來的那次會話才設置，用一次就清空。
    const [groupChatBackTarget, setGroupChatBackTarget] = useState<AppID | null>(null);
    const [activeGroup, setActiveGroup] = useState<GroupProfile | null>(null);
    // 群聊身份指定：這個群裡「你」該是哪張身份卡，按 activeGroup.id 單獨解析——不看全域默認，
    // 除非這個群沒有單獨指定。群聊沒有 perCharAvatars 那層（群聊頭像一直用整體默認）。
    const groupUserProfile = useMemo(
        () => (activeGroup ? resolveUserProfileForGroup(userProfileBase, activeGroup.id) : userProfile),
        [activeGroup, userProfileBase, userProfile],
    );
    const [messages, setMessages] = useState<Message[]>([]);
    const [totalMsgCount, setTotalMsgCount] = useState(0);
    const MESSAGE_PAGE_SIZE = 50;
    const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE);
    const [input, setInput] = useState('');
    const [inputPreferences, setInputPreferences] = useState(loadChatInputPreferences);
    const [settingsInputPreferences, setSettingsInputPreferences] = useState(loadChatInputPreferences);
    const [isInputFocused, setIsInputFocused] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const [mcpStatus, setMcpStatus] = useState('');
    /** 群公共話題盒整理狀態——非空時顯示頂部膠囊狀態條 */
    const [groupPalaceStatus, setGroupPalaceStatus] = useState<string>('');

    // 公共成盒異步完成時使用最新角色名與成員資料，避免長回覆期間閉包數據過期。
    const charactersRef = useRef(characters);
    charactersRef.current = characters;
    const npcsRef = useRef(npcs);
    npcsRef.current = npcs;
    // 名字查詢表：角色 + NPC。群歷史、時間線、引用都靠它把 charId 變成名字（NPC 說的話不能變成「未知」）
    const speakers = useMemo(() => buildSpeakerDirectory(characters, npcs), [characters, npcs]);

    // 同理 ref 出最新 messages：派發循環裡逐條落庫時要按"當前窗口大小"刷新，
    // 閉包裡的 messages 是觸發那一刻的舊值，長度會越算越小
    const messagesRef = useRef<Message[]>([]);
    messagesRef.current = messages;

    // 群裡的動靜會進每個成員私聊 prompt 的【群聊背景】塊，話題盒成盒時還直接往成員私聊
    // 歷史裡寫卡片 —— 兩者都是主動消息 2.0 雲端快照（fire_pack）的素材。群裡有事就給成員
    // 逐個打髒，不然角色到點還活在上一次私聊那會兒的群裡。同一輪裡的多次調用會在微任務內
    // 合併成一次上傳，沒開主動消息的成員被 markAmsgStateDirty 內部的門篩掉。
    const markGroupMembersDirty = useCallback((memberIds: string[], reason: AmsgDirtyReason = 'refresh') => {
        for (const memberId of memberIds) {
            const member = charactersRef.current.find(c => c.id === memberId);
            if (member) markAmsgStateDirty({ char: member, userProfile: groupUserProfile, groups, realtimeConfig }, reason);
        }
    }, [groupUserProfile, groups, realtimeConfig]);

    // Token 統計 — 對齊私聊 ChatHeader 的 token badge
    const [lastTokenUsage, setLastTokenUsage] = useState<number | null>(null);
    const [tokenBreakdown, setTokenBreakdown] = useState<{ prompt: number; completion: number; total: number; msgCount: number; pass: string } | null>(null);
    
    // UI State — 面板狀態對齊私聊 ChatInputArea 的 showPanel 約定
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [activeEmojiCategory, setActiveEmojiCategory] = useState('default');
    const [modalType, setModalType] = useState<'none' | 'create' | 'settings' | 'transfer' | 'member_select' | 'message-options' | 'edit-message' | 'packet-detail' | 'chrome-css' | 'chrome-sound' | 'html-prompt' | 'help'>('none');
    const [tempHtmlPrompt, setTempHtmlPrompt] = useState('');
    const [selectedMessage, setSelectedMessage] = useState<Message | null>(null);
    const [replyTarget, setReplyTarget] = useState<Message | null>(null);
    const [editContent, setEditContent] = useState('');
    const [preserveContext, setPreserveContext] = useState(true);
    const [isSummarizing, setIsSummarizing] = useState(false);
    const [summaryProgress, setSummaryProgress] = useState('');
    const [topicPendingCount, setTopicPendingCount] = useState(0);
    const [editingTopicBoxId, setEditingTopicBoxId] = useState<string | null>(null);
    const [topicTitleDraft, setTopicTitleDraft] = useState('');
    const [topicSummaryDraft, setTopicSummaryDraft] = useState('');

    // Context limit (like Chat app's settingsContextLimit)
    const [contextLimit, setContextLimit] = useState<number>(() => {
        // localStorage 值損壞時 parseInt 得 NaN，slice(-NaN) 會把整段歷史塞進 prompt
        try {
            const v = parseInt(localStorage.getItem('groupchat_context_limit') || '30', 10);
            return Number.isFinite(v) && v > 0 ? v : 30;
        } catch { return 30; }
    });
    
    // Selection Mode
    const [selectionMode, setSelectionMode] = useState(false);
    const [selectedMsgIds, setSelectedMsgIds] = useState<Set<number>>(new Set());

    // Data State
    const [emojis, setEmojis] = useState<{name: string, url: string, categoryId?: string}[]>([]);
    const [categories, setCategories] = useState<EmojiCategory[]>([]); // New

    useEffect(() => {
        setInputPreferences(loadChatInputPreferences());
        setPuppetId('');
        setPlotDirection('');
        setShowPlotDirection(false);
    }, [activeGroup?.id]);
    
    // Create/Edit Group State
    const [tempGroupName, setTempGroupName] = useState('');
    const [tempAnnouncement, setTempAnnouncement] = useState('');
    const [tempPrivateContextCap, setTempPrivateContextCap] = useState<number>(80);
    const [tempMemberTimelineCap, setTempMemberTimelineCap] = useState<number>(DEFAULT_MEMBER_TIMELINE_CAP);
    const [tempMaxRoundMessages, setTempMaxRoundMessages] = useState<number>(DEFAULT_MAX_ROUND_MESSAGES);
    const [tempReplyMode, setTempReplyMode] = useState<'director' | 'roundRobin'>('director');
    const [tempMemberBubbleIndependent, setTempMemberBubbleIndependent] = useState(false);
    const [tempUserBubbleThemeId, setTempUserBubbleThemeId] = useState<string>('');
    const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
    const [memberGroupId, setMemberGroupId] = useState(GROUP_FILTER_ALL); // 建群選成員的分組篩選
    const [transferAmount, setTransferAmount] = useState('');
    // 紅包 2.0：發送彈窗的 tab / 份數 / 專屬目標 / 祝福語；明細彈層鎖定的紅包消息 id
    const [packetTab, setPacketTab] = useState<'lucky' | 'direct'>('lucky');
    const [packetShares, setPacketShares] = useState('5');
    const [packetTargetId, setPacketTargetId] = useState<string>('');
    const [packetNote, setPacketNote] = useState('');
    const [selectedPacketId, setSelectedPacketId] = useState<number | null>(null);
    // NPC 客串：不是正式群成員，手動觸發插一句話（不進輪詢/記憶宮殿）
    const [showNpcGuestModal, setShowNpcGuestModal] = useState(false);
    const [npcGuestId, setNpcGuestId] = useState('');
    const [npcGuestHint, setNpcGuestHint] = useState('');
    const [npcGuestGenerating, setNpcGuestGenerating] = useState(false);
    // 群設置裡的成員管理：展開/收起"添加成員"候選列表
    const [showAddMemberPicker, setShowAddMemberPicker] = useState(false);
    const [showAddNpcPicker, setShowAddNpcPicker] = useState(false);
    // 旁觀底部欄：代誰發言（空 = 還沒選）、劇情方向（只管下一輪，按 ▶ 後清掉）
    const [puppetId, setPuppetId] = useState('');
    const [plotDirection, setPlotDirection] = useState('');
    const [showPlotDirection, setShowPlotDirection] = useState(false);
    const npcMemoryLockRef = useRef(false);

    // Refs
    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const groupAvatarInputRef = useRef<HTMLInputElement>(null);
    // 生成中的取消句柄：非空 = 正在生成，再點觸發按鈕 = 停止
    const abortRef = useRef<AbortController | null>(null);
    const topicArchiveLockRef = useRef(false);
    // 白框提示音回合計時（對齊私聊 Chat.tsx 的 soundSyncRef 方案）
    const SOUND_ROUND_GAP_MS = 3000;
    const soundSyncRef = useRef<{ groupId: string | null; maxId: number | null; lastAt: number | null }>({ groupId: null, maxId: null, lastAt: null });

    // Initial Load
    useEffect(() => {
        if (activeGroup) {
            setVisibleCount(MESSAGE_PAGE_SIZE);
            DB.getRecentGroupMessagesWithCount(activeGroup.id, MESSAGE_PAGE_SIZE).then(({ messages: msgs, totalCount }) => {
                setMessages(msgs);
                setTotalMsgCount(totalCount);
            });
            // Fetch emojis AND categories
            Promise.all([DB.getEmojis(), DB.getEmojiCategories()]).then(([es, cats]) => {
                setEmojis(es);
                setCategories(cats);
            });
        }
    }, [activeGroup]);

    // Auto Scroll
    useLayoutEffect(() => {
        if (scrollRef.current && !selectionMode) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages.length, activeGroup, showPanel, isTyping, selectionMode]);

    // 白框提示音：成員新發的消息成為群裡最後一條時響一次（用戶自己/翻舊消息不響）。
    // 邏輯對齊私聊 Chat.tsx——切群只記基線不播、回合內多氣泡只響首條、基線只增不減。
    useEffect(() => {
        const sync = soundSyncRef.current;
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        const lastId = last ? last.id : null;
        if (sync.groupId !== (activeGroup?.id ?? null)) {
            sync.groupId = activeGroup?.id ?? null;
            sync.maxId = lastId;
            sync.lastAt = null;
            return;
        }
        if (lastId == null) return;
        const isNew = sync.maxId == null || lastId > sync.maxId;
        if (isNew && last?.role === 'assistant') {
            const now = Date.now();
            if (sync.lastAt == null || now - sync.lastAt > SOUND_ROUND_GAP_MS) {
                playWhiteboxSound(resolveActiveSound(activeGroup?.chromeCustomCss, activeGroup?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound));
            }
            sync.lastAt = now;
        }
        sync.maxId = sync.maxId == null ? lastId : Math.max(sync.maxId, lastId);
    }, [messages, activeGroup?.id, activeGroup?.chromeCustomCss, activeGroup?.chatSound, osTheme.chatChromeCustomCss, osTheme.chatSound]);

    const displayMessages = useMemo(() => messages.slice(-visibleCount), [messages, visibleCount]);
    const collapsedCount = Math.max(0, totalMsgCount - messages.length);

    const canReroll = useMemo(() => {
        if (isTyping || messages.length === 0) return false;
        const lastMsg = messages[messages.length - 1];
        return lastMsg.role === 'assistant';
    }, [isTyping, messages]);

    // --- Helpers ---

    const getTimeGapHint = (lastMsgTimestamp: number): string => {
        const now = Date.now();
        const diffHours = Math.floor((now - lastMsgTimestamp) / (1000 * 60 * 60));
        const diffMins = Math.floor((now - lastMsgTimestamp) / (1000 * 60));
        const diffDays = Math.floor(diffHours / 24);

        const currentHour = new Date().getHours();
        const isNight = currentHour >= 23 || currentHour <= 6;

        if (diffMins < 10) return '聊天正在火熱進行中，大家都很活躍。';
        if (diffMins < 60) return `距離上次發言過了 ${diffMins} 分鐘，話題可能有點冷場。`;
        if (diffHours < 12) return `距離上次發言過了 ${diffHours} 小時。${isNight ? '現在是深夜。' : ''}`;
        if (diffHours < 24) return `距離上次發言過了 ${diffHours} 小時，群裡安靜了大半天。`;
        // 隔天以上：明確"日子已經過去了"，別把上一條當作剛剛發生、無縫續上舊話題。
        return `距離群裡上一條消息已經過了 ${diffDays} 天（${diffHours} 小時）。這段時間是真實流逝的——各自都過了好幾天的生活，之前那個話題早就不是"剛才"的事了。除非有人明確重新提起，別當無事發生、直接續上幾天前那句話；更自然的是有種"好久沒聊了"的重啟感，或者乾脆聊點新的。`;
    };

    // New: Calculate private chat gap
    const getPrivateTimeGap = async (charId: string): Promise<string> => {
        // includeProcessed=true：私聊被記憶宮殿歸檔（高水位以下）後仍然算"聊過"，
        // 否則全量歸檔過的角色會被誤報成"從未私聊過"
        const [lastMsg] = await DB.getRecentMessagesByCharId(charId, 1, true);
        if (!lastMsg) return '從未私聊過';
        const now = Date.now();
        const diffMins = Math.floor((now - lastMsg.timestamp) / (1000 * 60));
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);

        if (diffMins < 60) return '剛剛才私聊過';
        if (diffHours < 24) return `${diffHours}小時前私聊過`;
        return `${diffDays}天前私聊過`;
    };

    // 發消息/派發氣泡後刷新消息窗口：只取"當前窗口 + 新增"這麼多條並同步總數。
    // 之前每條氣泡都 getGroupMessages 全表讀，且 totalMsgCount 不更新，
    // 導致發送後"加載歷史消息"按鈕的計數失真（甚至消失）
    const refreshMessages = async (groupId: string) => {
        const { messages: msgs, totalCount } = await DB.getRecentGroupMessagesWithCount(groupId, visibleCount);
        setMessages(msgs);
        setTotalMsgCount(totalCount);
        return msgs;
    };

    // Chat 主頁「消息」tab 點某個群聊行時的深鏈：外部沒法直接驅動這裡的 view/activeGroup（都是本組件
    // 內部 state），靠 context 那個一次性字段告訴這裡"打開就直接進這個群"，消費掉即清空。
    useEffect(() => {
        if (!pendingGroupChatId) return;
        const target = groups.find(g => g.id === pendingGroupChatId);
        if (target) {
            setActiveGroup(target);
            setView('chat');
            setGroupChatBackTarget(chatReturnTarget.consume());
            void refreshMessages(target.id);
        }
        consumePendingGroupChat();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingGroupChatId, groups]);

    // 群聊天視圖的返回鍵：正常從本組件的群列表點進來時回群列表（原行為不變）；
    // 從 Chat 主頁深鏈進來的這次會話直接回 Chat 主頁，不必先繞一趟群列表。
    const handleGroupChatClose = () => {
        if (groupChatBackTarget) {
            const t = groupChatBackTarget;
            setGroupChatBackTarget(null);
            openApp(t);
        } else {
            setView('list');
        }
    };

    // --- Logic: Selection & Deletion ---

    const handleMessageLongPress = useCallback((id: number) => {
        const msg = messagesRef.current.find(m => m.id === id);
        if (msg) {
            setSelectedMessage(msg);
            setModalType('message-options');
        }
        setShowPanel('none');
    }, []);

    const handleCopyMessage = () => {
        if (!selectedMessage) return;
        navigator.clipboard.writeText(selectedMessage.content);
        setModalType('none');
        setSelectedMessage(null);
        addToast('已複製到剪貼板', 'success');
        trackEvent('复制一条群消息文字');
    };

    const handleEnterSelectionMode = () => {
        if (selectedMessage) {
            setSelectedMsgIds(new Set([selectedMessage.id]));
            setSelectionMode(true);
            setModalType('none');
            setSelectedMessage(null);
        }
    };

    const handleDeleteSingleMessage = async () => {
        if (!selectedMessage) return;
        await DB.deleteMessage(selectedMessage.id);
        setMessages(prev => prev.filter(m => m.id !== selectedMessage.id));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已刪除', 'success');
        trackEvent('删除一条群消息');
    };

    const handleStartEditMessage = () => {
        if (!selectedMessage) return;
        setEditContent(selectedMessage.content);
        setModalType('edit-message');
    };

    const confirmEditMessage = async () => {
        if (!selectedMessage) return;
        await DB.updateMessage(selectedMessage.id, editContent);
        setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, content: editContent } : m));
        setModalType('none');
        setSelectedMessage(null);
        addToast('消息已修改', 'success');
        trackEvent('编辑一条群消息');
    };

    const toggleMessageSelection = useCallback((id: number) => {
        setSelectedMsgIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const deleteSelectedMessages = async () => {
        if (selectedMsgIds.size === 0) return;
        await DB.deleteMessages(Array.from(selectedMsgIds));
        setMessages(prev => prev.filter(m => !selectedMsgIds.has(m.id)));
        setSelectionMode(false);
        setSelectedMsgIds(new Set());
        addToast(`已刪除 ${selectedMsgIds.size} 條消息`, 'success');
    };

    const handleReroll = async () => {
        if (!canReroll) return;
        autoReply.cancel();
        
        const lastMsg = messages[messages.length - 1];
        if (lastMsg.role !== 'assistant') return;

        // Find all contiguous assistant messages at the end
        const toDeleteIds: number[] = [];
        let index = messages.length - 1;
        while (index >= 0 && messages[index].role === 'assistant') {
            toDeleteIds.push(messages[index].id);
            index--;
        }

        if (toDeleteIds.length === 0) return;

        await DB.deleteMessages(toDeleteIds);
        const newHistory = messages.slice(0, index + 1);
        setMessages(newHistory);
        addToast('回溯對話中...', 'info');
        trackEvent('重新生成群聊回复');

        triggerGroupAI(newHistory);
    };

    // --- Logic: Group Management ---

    const handleCreateGroup = () => {
        if (!tempGroupName.trim() || selectedMembers.size < 2) {
            addToast('請輸入群名並至少選擇2名成員', 'error');
            return;
        }
        createGroup(tempGroupName, Array.from(selectedMembers));
        setModalType('none');
        setTempGroupName('');
        setSelectedMembers(new Set());
        addToast('群聊已創建', 'success');
    };

    const handleUpdateGroupInfo = async () => {
        if (!activeGroup) return;
        const updates = {
            name: tempGroupName || activeGroup.name,
            // 空串存 undefined，跟橫幅/prompt 注入的"有沒有公告"判斷口徑一致（trim 後為空就當沒設）
            announcement: tempAnnouncement.trim() || undefined,
            privateContextCap: tempPrivateContextCap,
            memberTimelineCap: tempMemberTimelineCap,
            maxRoundMessages: tempMaxRoundMessages,
            replyMode: tempReplyMode,
            memberBubbleIndependent: tempMemberBubbleIndependent,
            // 空串 = 默認紫，存 undefined 保持向後兼容語義
            userBubbleThemeId: tempUserBubbleThemeId || undefined,
        };
        // 走 context 的 updateGroup：同步內存 groups + DB，避免退出後讀回舊值
        await updateGroup(activeGroup.id, updates);
        saveChatInputPreferences(settingsInputPreferences);
        setInputPreferences(settingsInputPreferences);
        setActiveGroup({ ...activeGroup, ...updates });
        setModalType('none');
        addToast('群信息已更新', 'success');
    };

    // 成員管理：加人/移除即時生效（不走"保存修改"），跟下面話題盒整理方式的即時保存一致。
    // 歷史消息不刪——移除只影響之後的生成範圍，不影響 ta 說過的話。
    const handleAddGroupMember = async (charId: string) => {
        if (!activeGroup || activeGroup.members.includes(charId)) return;
        const nextMembers = [...activeGroup.members, charId];
        await updateGroup(activeGroup.id, { members: nextMembers });
        setActiveGroup({ ...activeGroup, members: nextMembers });
        trackEvent('群聊添加成员');
    };

    const handleRemoveGroupMember = async (charId: string) => {
        if (!activeGroup) return;
        if (activeGroup.members.length <= 2) { addToast('群裡至少要留 2 位成員', 'error'); return; }
        const nextMembers = activeGroup.members.filter(id => id !== charId);
        // 人都不在群裡了，群主頭銜、禁言狀態跟著一起清掉，不留懸空引用
        const updates: Partial<GroupProfile> = { members: nextMembers };
        if (activeGroup.ownerId === charId) updates.ownerId = undefined;
        if (activeGroup.mutedMemberIds?.includes(charId)) updates.mutedMemberIds = activeGroup.mutedMemberIds.filter(id => id !== charId);
        await updateGroup(activeGroup.id, updates);
        setActiveGroup({ ...activeGroup, ...updates });
        trackEvent('群聊移除成员');
    };

    // NPC 成員：放在 npcMemberIds（不進 members），加入/移除即時生效，沒有人數下限
    const handleAddGroupNpc = async (npcId: string) => {
        if (!activeGroup || activeGroup.npcMemberIds?.includes(npcId)) return;
        const npcMemberIds = [...(activeGroup.npcMemberIds || []), npcId];
        await updateGroup(activeGroup.id, { npcMemberIds });
        setActiveGroup({ ...activeGroup, npcMemberIds });
        trackEvent('群聊添加NPC成员');
    };

    const handleRemoveGroupNpc = async (npcId: string) => {
        if (!activeGroup) return;
        const updates: Partial<GroupProfile> = { npcMemberIds: (activeGroup.npcMemberIds || []).filter(id => id !== npcId) };
        if (activeGroup.mutedMemberIds?.includes(npcId)) updates.mutedMemberIds = activeGroup.mutedMemberIds.filter(id => id !== npcId);
        if (puppetId === npcId) setPuppetId('');
        await updateGroup(activeGroup.id, updates);
        setActiveGroup({ ...activeGroup, ...updates });
        trackEvent('群聊移除NPC成员');
    };

    // 群主：純標記/人設頭銜，不帶任何權限，即時生效——跟成員增減、隱身圍觀模式同一種即時保存風格。
    // 值可以是某位成員，也可以是 'user'（自己當群主）；再點一次同一個人 = 取消群主。
    const handleSetGroupOwner = async (ownerId: string | undefined) => {
        if (!activeGroup) return;
        await updateGroup(activeGroup.id, { ownerId });
        setActiveGroup({ ...activeGroup, ownerId });
        trackEvent('设置群聊群主', { choice: !ownerId ? 'none' : ownerId === 'user' ? 'user' : 'char' });
    };

    // 禁言：即時生效。被禁言的角色仍在 members 名單裡，只是不參與生成（導演/輪詢模式的
    // 過濾邏輯見 triggerDirector/triggerRoundRobin），歷史消息、私聊都不受影響，隨時可解除。
    const handleToggleMemberMute = async (charId: string) => {
        if (!activeGroup) return;
        const muted = new Set(activeGroup.mutedMemberIds || []);
        const willMute = !muted.has(charId);
        if (willMute) muted.add(charId); else muted.delete(charId);
        const nextMuted = Array.from(muted);
        await updateGroup(activeGroup.id, { mutedMemberIds: nextMuted });
        setActiveGroup({ ...activeGroup, mutedMemberIds: nextMuted });
        trackEvent('切换群聊角色禁言', { enabled: willMute });
    };

    // 切換這個群單獨用哪張身份卡：即時生效（不走"保存修改"），跟成員增減、隱身圍觀模式
    // 一樣——這是 userProfile.perGroupPersonaIds 的寫入點，不是群自己的數據，所以走
    // updateUserProfile 而不是 updateGroup。
    const handleSetGroupPersona = (personaId: string | undefined) => {
        if (!activeGroup) return;
        const next = { ...(userProfileBase.perGroupPersonaIds || {}) };
        if (personaId) next[activeGroup.id] = personaId; else delete next[activeGroup.id];
        updateUserProfile({ perGroupPersonaIds: next });
        trackEvent('群聊身份指定', { choice: !personaId ? 'default' : personaId === REAL_IDENTITY_PERSONA_ID ? 'real' : 'persona' });
    };

    const handleGroupAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !activeGroup) return;
        try {
            const base64 = await processImage(file);
            // 群頭像存令牌，二進制單獨躺在 blob_assets 裡；轉不動時原樣還回 data URL，圖不會丟
            const avatar = await migrateDataUrlToRef(base64);
            // 走 context 的 updateGroup：同步內存 groups + DB，
            // 否則只改了本地 activeGroup，退出回列表/再次進群會讀回舊頭像（恢復默認）
            await updateGroup(activeGroup.id, { avatar });
            setActiveGroup({ ...activeGroup, avatar });
            addToast('群頭像已修改', 'success');
        } catch (err: any) {
            addToast('圖片處理失敗', 'error');
        }
    };

    const toggleMemberSelection = (id: string) => {
        const next = new Set(selectedMembers);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelectedMembers(next);
    };

    const handleDeleteGroup = async (id: string) => {
        // 清理舊版本可能留下的群記憶副本，以及公共話題盒投遞到成員私聊的卡片。
        try {
            const result = await deleteGroupMemoriesByGroupId(id);
            if (result.deleted > 0) {
                console.log(`🗑️ [GroupChat] 解散群同時清理群記憶 ${result.deleted} 條`);
            }
        } catch (err) {
            console.warn('🗑️ [GroupChat] 清理群記憶失敗（不影響解散）:', err);
        }
        const targetGroup = groups.find(g => g.id === id);
        if (targetGroup) {
            // 掃全部角色而非只掃當前成員：已經退群的人也可能留有早期成盒卡片。
            await Promise.all(characters.map(async ({ id: memberId }) => {
                const msgs = await DB.getMessagesByCharId(memberId, true);
                const ids = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.groupId === id).map(m => m.id);
                if (ids.length) await DB.deleteMessages(ids);
            }));
        }
        await deleteGroup(id);
        if (activeGroup?.id === id) { setView('list'); setGroupChatBackTarget(null); }
        addToast('群聊已解散', 'success');
    };

    const handleClearHistory = async () => {
        if (!activeGroup) return;

        // Fetch ALL messages from DB, not just the loaded subset
        const allGroupMsgs = await DB.getGroupMessages(activeGroup.id);

        let msgsToDelete = allGroupMsgs;
        let keepCount = 0;

        if (preserveContext) {
            msgsToDelete = allGroupMsgs.slice(0, -10);
            keepCount = Math.min(allGroupMsgs.length, 10);
        }

        if (msgsToDelete.length === 0) {
            addToast('消息太少，無需清理', 'info');
            return;
        }

        await DB.deleteMessages(msgsToDelete.map(m => m.id));

        // Refresh local state
        const remaining = preserveContext ? allGroupMsgs.slice(-10) : [];
        setMessages(remaining);
        setTotalMsgCount(remaining.length);

        // 群裡說過的話會進每個成員私聊 fire_pack 的【群聊背景】塊，所以清空群聊之後，
        // 成員在雲端那份快照裡還帶著這段剛被刪掉的群聊。這條路以前一次打髒都沒有，
        // 用 invalidate 是因為沒有待觸發任務的成員輪不到重傳，普通打髒會被門丟掉。
        markGroupMembersDirty(activeGroup.members || [], 'invalidate');

        addToast(`已清理 ${msgsToDelete.length} 條記錄${preserveContext ? ' (保留最近10條)' : ''}`, 'success');
        trackEvent('清空群聊记录', { preserve: preserveContext ? 'on' : 'off' });
        setModalType('none');
    };

    // --- Logic: Group Summary & Distribution ---

    // --- Logic: Messaging ---

    const handleSendMessage = async (content: string, type: MessageType = 'text', metadata?: any) => {
        if (!activeGroup) return;
        if (type === 'text' && !content.trim()) return;
        const finishSend = autoReply.beginSend(activeGroup.id);
        let sent = false;
        try {
            // 借用戶"發送"手勢解鎖音頻上下文（移動端自動播放策略），稍後 AI 回覆時提示音才響得了
            unlockWhiteboxAudio();

            // 旁觀時選了代打對象：這則算那位成員說的（進群歷史、成員時間線、記憶），只多一個代打標記
            const puppet = activeGroup.userLurkMode && puppetId && speakers.some(sp => sp.id === puppetId) ? puppetId : '';
            const newMessage: any = puppet ? {
                charId: puppet,
                groupId: activeGroup.id,
                role: 'assistant' as const,
                type,
                content,
                metadata: { ...(metadata || {}), puppeted: true },
            } : {
                charId: 'user',
                groupId: activeGroup.id,
                role: 'user' as const,
                type,
                content,
                metadata
            };
            if (puppet) trackEvent('群聊旁观代打发言');

            // 引用回覆：落快照（對齊私聊 Chat.tsx 的做法），發完清空。
            // 圖片 / 表情走佔位符，不把 blobref 令牌原樣存進快照。
            if (replyTarget) {
                newMessage.replyTo = {
                    id: replyTarget.id,
                    content: buildReplySnapshotContent(replyTarget),
                    name: replyTarget.role === 'user'
                        ? '我'
                        : (speakers.find(c => c.id === replyTarget.charId)?.name || '成員'),
                };
                setReplyTarget(null);
            }

            await DB.saveMessage(newMessage);
            sent = true;
            await refreshMessages(activeGroup.id);
            markGroupMembersDirty(activeGroup.members);

            // Close panels
            if (type !== 'text' && !inputPreferences.autoReply) {
                setShowPanel('none');
            }
            // 表情聯想發送複用這裡；表情發出後保留尚未發送的文字草稿。
            if (type === 'text') setInput(current => current === content ? '' : current);

        } finally {
            finishSend(sent && ['text', 'image', 'emoji'].includes(type));
        }
    };

    const handleImageFile = async (file: File) => {
        const finishImage = autoReply.beginSend(activeGroup?.id || null);
        try {
            const base64 = await processImage(file, { maxWidth: 600, quality: 0.7, forceJpeg: true });
            // 群聊圖消息存令牌，二進制單獨躺在 blob_assets 裡（省掉 base64 那 ~33% 的膨脹）。
            // 同一張圖之前存過就複用它的令牌；轉不動時原樣還回這條 data URL，圖不會丟。
            await handleSendMessage(await migrateDataUrlToRef(base64), 'image');
        } catch (err) {
            addToast('圖片發送失敗', 'error');
        } finally {
            // 實際發送由 handleSendMessage 標記；這裡僅覆蓋圖片處理期間的等待。
            finishImage(false);
        }
    };

    const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        await handleImageFile(file);
        if (e.target) e.target.value = '';
    };

    // --- Logic: 紅包 2.0 ---

    const nameOf = useCallback(
        (id: string) => (id === 'user' ? groupUserProfile.name : (characters.find(c => c.id === id)?.name || npcs.find(n => n.id === id)?.name || '成員')),
        [characters, npcs, groupUserProfile.name],
    );

    // NPC 客串：不是正式群成員，手動觸發才插一句話，不進輪詢/記憶宮殿/成員時間線。
    const handleNpcGuestLine = async () => {
        if (!activeGroup) return;
        const npc = npcs.find(n => n.id === npcGuestId);
        if (!npc) { addToast('請選擇一個 NPC', 'error'); return; }
        const guestApi = npc.chatApi?.baseUrl ? npc.chatApi : apiConfig;
        if (!guestApi.apiKey) { addToast('請先配置 API', 'error'); return; }
        setNpcGuestGenerating(true);
        try {
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id));
            const recentTranscript = messages.slice(-12)
                .map(m => `${nameOf(m.charId)}: ${messageLogText(m, url => stickerNameFromUrl(emojis, url))}`)
                .join('\n');
            const line = await generateNpcGroupGuestLine({
                npc, groupName: activeGroup.name, members: groupMembers, userName: groupUserProfile.name,
                recentTranscript, hint: npcGuestHint.trim() || undefined, api: guestApi as any,
            });
            if (!line.trim()) { addToast('NPC 沒接上話', 'error'); return; }
            await DB.saveMessage({ charId: npc.id, groupId: activeGroup.id, role: 'assistant', type: 'text', content: line.trim() });
            await refreshMessages(activeGroup.id);
            setShowNpcGuestModal(false);
            setNpcGuestId(''); setNpcGuestHint('');
            trackEvent('群聊 NPC 客串一句');
        } catch (e) {
            console.error(e);
            addToast('生成失敗，請重試', 'error');
        } finally {
            setNpcGuestGenerating(false);
        }
    };

    const handleSendPacket = () => {
        if (!activeGroup) return;
        const total = parseFloat(transferAmount);
        if (!Number.isFinite(total) || total <= 0) { addToast('請輸入有效金額', 'error'); return; }
        let meta: GroupPacketMeta;
        if (packetTab === 'lucky') {
            const shares = parseInt(packetShares, 10);
            if (!Number.isFinite(shares) || shares < 1) { addToast('份數至少 1 份', 'error'); return; }
            if (total / shares < 0.01) { addToast('每份至少 0.01，份數太多啦', 'error'); return; }
            meta = makePacketMeta({ packetType: 'lucky', totalAmount: total, shares, note: packetNote, now: Date.now() });
        } else {
            if (!packetTargetId) { addToast('選一位成員作為專屬紅包對象', 'error'); return; }
            meta = makePacketMeta({ packetType: 'direct', totalAmount: total, targetId: packetTargetId, note: packetNote, now: Date.now() });
        }
        handleSendMessage('[紅包]', 'transfer', meta);
        setModalType('none');
        setTransferAmount('');
        setPacketNote('');
    };

    const openPacketDetail = useCallback((msg: Message) => {
        setSelectedPacketId(msg.id);
        setModalType('packet-detail');
    }, []);

    // 點圖看大圖：新標籤頁只認得真正的 URL，blobref 令牌得先換成 objectURL 再開
    // （data: 頂層導航被瀏覽器擋，只能走 objectURL）。開完不立刻回收——新標籤頁還在
    // 用它加載；留一分鐘再 revoke，圖早讀完了，也不至於把整張圖一直掛在內存裡。
    const handleGroupImageClick = useCallback(async (url: string) => {
        if (!isBlobRef(url)) { window.open(url, '_blank'); return; }
        const blob = await getBlobForRef(url);
        if (!blob) { addToast('圖片數據已丟失', 'error'); return; }
        const objectUrl = URL.createObjectURL(blob);
        window.open(objectUrl, '_blank');
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }, [addToast]);
    const handleGroupReply = useCallback((target: Message) => { setReplyTarget(target); trackEvent('引用回复一条群消息'); }, []);

    // 用戶搶/收/退：updater 內重跑狀態機（以庫內最新 claims 判重，防與 AI 派發併發雙寫）
    const handleUserPacketAction = async (msg: Message, action: 'claim' | 'return') => {
        if (!activeGroup) return;
        const now = Date.now();
        let outcome = { ok: false, reason: 'not_pending' } as ClaimResult;
        try {
            await DB.updateMessageMetadata(msg.id, prev => {
                outcome = claimPacket(prev as GroupPacketMeta, 'user', now, action);
                return outcome.ok ? outcome.meta : prev;
            });
        } catch { /* 消息被刪——按失敗處理 */ }
        if (!outcome.ok) {
            const reasonText: Record<string, string> = {
                expired: '紅包已過期',
                already_claimed: '你已經搶過這個紅包了',
                sold_out: '手慢了，紅包已被領完',
                not_target: '這個紅包不是發給你的',
                not_pending: '紅包已經被處理過了',
            };
            addToast(reasonText[outcome.reason] || '操作失敗', 'info');
        } else {
            const senderName = msg.role === 'user' ? groupUserProfile.name : nameOf(msg.charId);
            const receipt: PacketReceiptMeta = {
                packetReceipt: outcome.action,
                ref: msg.id,
                amount: outcome.action === 'claimed' ? outcome.amount : undefined,
                claimantName: groupUserProfile.name,
                senderName,
            };
            await DB.saveMessage({
                charId: 'user',
                groupId: activeGroup.id,
                role: 'user',
                type: 'transfer',
                content: outcome.action === 'claimed' ? '[領取紅包]' : '[退回紅包]',
                metadata: receipt,
            });
            addToast(outcome.action === 'claimed' ? `你搶到了 ¥${outcome.amount}` : '已退回紅包', 'success');
            trackEvent('领取或退回群红包', { action });
        }
        await refreshMessages(activeGroup.id);
        markGroupMembersDirty(activeGroup.members);
    };

    // --- Logic: 氣泡體系 ---
    // 保留完整 ChatTheme：群聊不再只摘基礎色值，氣泡工坊 customCss 也一起復用。
    const userBubbleTheme = useMemo<ChatTheme>(() => (
        activeGroup?.userBubbleThemeId
            ? resolveChatTheme(activeGroup.userBubbleThemeId, customThemes, PRESET_THEMES)
            : PRESET_THEME_GROUP
    ), [activeGroup?.userBubbleThemeId, customThemes]);

    const memberBubbleThemes = useMemo(() => {
        const map = new Map<string, ChatTheme>();
        if (activeGroup?.memberBubbleIndependent) {
            for (const mid of activeGroup.members) {
                const c = characters.find(ch => ch.id === mid);
                map.set(mid, resolveChatTheme(c?.bubbleStyle, customThemes, PRESET_THEMES));
            }
        }
        return map;
    }, [activeGroup?.memberBubbleIndependent, activeGroup?.members, characters, customThemes]);

    const memberThemeScopeClasses = useMemo(() => {
        const map = new Map<string, string>();
        activeGroup?.members.forEach((mid, index) => map.set(mid, `sully-group-member-theme-${index}`));
        return map;
    }, [activeGroup?.members]);

    const groupBubbleCustomCss = useMemo(() => {
        const chunks: string[] = [];
        if (userBubbleTheme.customCss) {
            chunks.push(scopeBubbleThemeCss(userBubbleTheme.customCss, '.sully-group-user-theme'));
        }
        memberBubbleThemes.forEach((theme, mid) => {
            const scopeClass = memberThemeScopeClasses.get(mid);
            if (theme.customCss && scopeClass) {
                chunks.push(scopeBubbleThemeCss(theme.customCss, `.${scopeClass}`));
            }
        });
        return chunks.filter(Boolean).join('\n');
    }, [userBubbleTheme.customCss, memberBubbleThemes, memberThemeScopeClasses]);

    // 表情面板按分類過濾（對齊私聊 ChatInputArea 的行為）
    const filteredEmojis = useMemo(() => emojis.filter(e => {
        if (activeEmojiCategory === 'default') return !e.categoryId || e.categoryId === 'default';
        return e.categoryId === activeEmojiCategory;
    }), [emojis, activeEmojiCategory]);

    const loadTopicBoxStats = async (group: GroupProfile) => {
        try {
            const allMsgs = await DB.getGroupMessages(group.id);
            setTopicPendingCount(groupTopicPendingCount(allMsgs, group.archivedThroughMessageId || 0));
        } catch {
            setTopicPendingCount(0);
        }
    };

    const openGroupSettings = () => {
        setSettingsInputPreferences(loadChatInputPreferences());
        setTempGroupName(activeGroup?.name || '');
        setTempAnnouncement(activeGroup?.announcement || '');
        setTempPrivateContextCap(activeGroup?.privateContextCap ?? 80);
        setTempMemberTimelineCap(activeGroup?.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP);
        setTempMaxRoundMessages(activeGroup?.maxRoundMessages ?? DEFAULT_MAX_ROUND_MESSAGES);
        setTempReplyMode(activeGroup?.replyMode ?? 'director');
        setTempMemberBubbleIndependent(activeGroup?.memberBubbleIndependent ?? false);
        setTempUserBubbleThemeId(activeGroup?.userBubbleThemeId ?? '');
        setShowAddMemberPicker(false);
        if (activeGroup) void loadTopicBoxStats(activeGroup);
        setModalType('settings');
        setShowPanel('none');
        trackEvent('打开群设置面板');
    };

    // ChatInputArea 的面板動作：群聊只處理表情發送/分類切換，
    // 表情包管理（導入/改名/刪除/建分類）引導去私聊做——那套 Modal 全在 ChatModals 裡
    const handlePanelAction = (type: string, payload?: any) => {
        switch (type) {
            case 'send-emoji':
                handleSendMessage(payload.url, 'emoji');
                break;
            case 'select-category':
                setActiveEmojiCategory(payload);
                break;
            case 'emoji-import':
            case 'emoji-options':
            case 'category-options':
            case 'add-category':
            case 'delete-emoji-req':
                addToast('請在私聊的表情面板裡管理表情包', 'info');
                break;
            default:
                break;
        }
    };

    // --- Logic: Group AI Generation (Director / Round-Robin) ---

    // 兩種模式共用：系統頭（群名/時間/共享場景）。
    // 共享場景塊（用戶檔案 + 共有世界書 + 共有 worldview）——每個角色都"看見"的
    // 舞台只描述一次，避免按成員數 N 倍複製；角色的人設/印象/記憶仍保持完整。
    const buildGroupSystemHeader = (currentMsgs: Message[], groupMembers: CharacterProfile[]) => {
        const lastMsg = currentMsgs[currentMsgs.length - 1];
        const timeGapInfo = lastMsg ? getTimeGapHint(lastMsg.timestamp) : "這是群聊的第一條消息。";
        // 帶上完整日期（年月日 + 星期），只給 HH:MM 時角色感知不到"過了幾天"——
        // 這正是"很久以後還無縫續上舊話題"的一個來源。virtualTime 只有時分，日期取真實當天。
        const nowDate = new Date();
        const weekNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        const currentTimeStr = `${nowDate.getFullYear()}年${nowDate.getMonth() + 1}月${nowDate.getDate()}日 ${weekNames[nowDate.getDay()]} ${virtualTime.hours.toString().padStart(2, '0')}:${virtualTime.minutes.toString().padStart(2, '0')}`;
        const liveMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        const sharedScene = ContextBuilder.buildGroupSharedScene(groupMembers, groupUserProfile, liveMsgs);

        const announcementLine = activeGroup?.announcement?.trim()
            ? `群公告: "${activeGroup.announcement.trim()}"\n`
            : '';
        // 群主：純頭銜標記，不帶權限，只是讓角色扮演時能自然體現一點被尊重/依賴的氛圍
        const ownerName = activeGroup?.ownerId
            ? (activeGroup.ownerId === 'user' ? groupUserProfile.name : characters.find(c => c.id === activeGroup.ownerId)?.name)
            : undefined;
        const ownerLine = ownerName
            ? `群主: ${ownerName}（純頭銜，不代表有特殊權限，不用刻意強調，自然帶一點點被尊重/依賴的氛圍即可）\n`
            : '';
        // 禁言：這些成員這一輪不參與生成，但其他人可以照常提到/調侃 ta
        const mutedNames = (activeGroup?.mutedMemberIds || [])
            .map(id => speakers.find(c => c.id === id)?.name)
            .filter((n): n is string => !!n);
        const mutedLine = mutedNames.length > 0
            ? `本輪被禁言、不會發言的成員: ${mutedNames.join('、')}（其他人可以照常提到/調侃 ta，只是 ta 這陣子不會自己說話）\n`
            : '';
        const header = `【系統：群聊模擬器配置】
當前群名: "${activeGroup?.name}"
${announcementLine}${ownerLine}${mutedLine}當前系統時間: ${currentTimeStr}
時間流逝感知: ${timeGapInfo}

${sharedScene.text}${activeGroup ? buildGroupTopicContext(activeGroup) : ''}`;
        return { header, sharedScene };
    };

    // 兩種模式共用：單個成員的角色檔案塊（記憶宮殿注入 + 私聊/群聊合併時間線）
    const buildMemberBlock = async (
        member: CharacterProfile,
        currentMsgs: Message[],
        sharedScene: ReturnType<typeof ContextBuilder.buildGroupSharedScene>,
    ): Promise<string> => {
        const timelineCap = activeGroup?.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP;
        // 記憶宮殿檢索源用當前群線程（濾掉媒體消息，base64 不能進 embedding query）：
        // 角色應召回與"群裡正聊的話題"相關的記憶，而不是私聊近況（舊行為，召回跑偏）
        const liveGroupMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        const palaceQueryMsgs = liveGroupMsgs.slice(-30).filter(m => !m.type || m.type === 'text');
        await injectMemoryPalace(member, palaceQueryMsgs, undefined, groupUserProfile.name);
        // 角色塊：跳過共享場景已包含的部分（用戶檔案 / 共有 worldview / 共有世界書）
        const coreContext = ContextBuilder.buildCoreContext(member, groupUserProfile, true, undefined, {
            skipUserProfile: true,
            skipWorldview: sharedScene.worldviewIsShared,
            skipWorldbookIds: sharedScene.sharedWorldbookIds,
            headerOverride: `[Group Member Profile: ${member.name}]`,
        // conversational：群聊同樣是用戶正在說話的場合（見 buildTimeAwarenessBlock）
        }, { worldbookMessages: liveGroupMsgs, conversational: true });
        // Get private gap string
        const privateGapInfo = await getPrivateTimeGap(member.id);

        // 私聊+群聊合併時間線：讓角色看清兩條線的先後關係，感情才能銜接。
        // 私聊側遵守角色的原文範圍，再與本群獨立窗口合併。
        const privateMsgs = await loadCharacterContextMessages(member);
        const memberTimeline = buildMemberTimeline({
            privateMsgs,
            groupMsgs: liveGroupMsgs,
            cap: timelineCap,
            resolveSpeaker: (m) => m.charId === member.id
                ? '我'
                : (speakers.find(c => c.id === m.charId)?.name || '未知成員'),
            stickerName: url => stickerNameFromUrl(emojis, url),
        });

        // Construct Detailed Profile Wrapper
        // CRITICAL FIX: Emphasize Private Context logic
        return `
<<< 角色檔案 START: ${member.name} (ID: ${member.id}) >>>
${coreContext}

[重點：私聊狀態 (Private Context)]:
- **私聊空窗期**: ${privateGapInfo}
- **重要指令**: 如果 [私聊空窗期] 顯示 "剛剛" 或 "幾小時前"，請【忽略】群聊的時間流逝感知。哪怕群裡很久沒說話，只要你和用戶私底下剛聊過，就【嚴禁】說 "好久不見" 或表現出疏離感。
- 你的近期互動時間線（按時間排序；[私聊]=你和用戶單獨聊的，別人看不見；[群聊]=本群公開記錄。僅作為你內心狀態的底色，不要變成默認反應模板）：
${memberTimeline || '(暫無互動記錄)'}
- **先認清 U**：群聊裡的用戶，就是你一直在私聊、記憶和印象裡認識的同一個人。已經建立的關係、承諾和親密程度繼續成立；公開場合可以換一種表達方式，但不能重置關係或突然把 U 當成普通陌生群友。
- **關於私聊狀態如何影響群聊表現**：
  · 私聊在吵架 → **可能**有點彆扭/冷淡/借題發揮，但**強度由你的性格決定**。情緒穩定的人不會因為私下鬧矛盾就在群裡失態；脾氣大的人才會帶情緒到群裡。絕大多數情況是"心裡有點疙瘩"而不是"擺臉色給所有人看"。
  · 私聊在甜蜜 → **可能**想低調、不好意思聲張，或者反而想隱隱顯擺一下，看你性格。**不必每次都"支支吾吾"**——這是套路化反應，不真實。
  · 關鍵原則：你是一個完整的人，不是"私聊狀態的應激反應器"。群裡此刻的狀態由你本身、群聊話題和既有關係共同決定；私聊不必搶佔群聊中心，但它建立的關係底色不會消失。
<<< 角色檔案 END >>>
`;
    };

    // NPC 成員的檔案塊（設定 / 關係 / 世界書 / 輕量記憶），見 utils/groupChat/npcMembers.ts
    const buildNpcBlockFor = (npc: NPCProfile, currentMsgs: Message[], roundSpeakers: Array<{ id: string; name: string }>): string => {
        const liveGroupMsgs = currentMsgs.filter(m => m.id > (activeGroup?.archivedThroughMessageId || 0));
        return buildNpcMemberBlock({
            npc,
            userName: groupUserProfile.name,
            others: roundSpeakers.filter(sp => sp.id !== npc.id),
            scanMessages: liveGroupMsgs.slice(-20).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })),
            userLurking: !!activeGroup?.userLurkMode,
        });
    };

    // 每輪生成完：群裡的 NPC 攢夠新消息就整理一次記憶（背景跑，不擋聊天；同時只跑一個）
    const refreshNpcGroupMemories = async (group: GroupProfile) => {
        if (npcMemoryLockRef.current || !(group.npcMemberIds || []).length) return;
        npcMemoryLockRef.current = true;
        try {
            for (const npc of groupNpcs(group, npcsRef.current)) {
                await refreshNpcMemoryFromGroups({
                    npc,
                    groups: [group],
                    nameOf: id => speakers.find(sp => sp.id === id)?.name || '群友',
                    userName: groupUserProfile.name,
                    api: resolveNpcApi(npc, apiConfig),
                    save: patch => updateNPC(npc.id, patch),
                });
            }
        } catch (e) {
            console.warn('[GroupChat] NPC 記憶整理失敗', e);
        } finally {
            npcMemoryLockRef.current = false;
        }
    };

    // [[QUOTE: 片段]] 解析：從新到舊找 content 包含片段的文本消息，
    // 找不到返回 undefined（dispatch 會靜默剝除標記，不丟正文）
    const resolveQuote = (snippet: string) => {
        if (!snippet) return undefined;
        const msgs = messagesRef.current;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type && m.type !== 'text') continue;
            const c = typeof m.content === 'string' ? m.content : '';
            if (c && (c.includes(snippet) || snippet.includes(c))) {
                return {
                    id: m.id,
                    content: c,
                    name: m.role === 'user'
                        ? groupUserProfile.name
                        : (speakers.find(ch => ch.id === m.charId)?.name || '成員'),
                };
            }
        }
        return undefined;
    };

    // 附圖時 user 消息走結構化 content（text + image_url），否則純文本，
    // 避免對不支持多模態字段的端點產生兼容問題
    const buildUserMessageContent = (prompt: string, history: GroupHistoryBlock): any =>
        history.attachedImages.length > 0
            ? [
                { type: 'text', text: prompt },
                ...history.attachedImages.map(img => ({ type: 'image_url', image_url: { url: img.url } })),
              ]
            : prompt;

    /** 群公共話題盒：每群只調用一次總結 API，不再按開啟記憶宮殿的成員分別複製。 */
    const createNextGroupTopicBox = async (force: boolean = false): Promise<boolean> => {
        if (!activeGroup || topicArchiveLockRef.current || !apiConfig.apiKey) return false;
        const groupForArchive = activeGroup;
        topicArchiveLockRef.current = true;
        if (force) setIsSummarizing(true);
        try {
            const allMsgs = await DB.getGroupMessages(groupForArchive.id);
            const batchPlan = planGroupTopicBatch(allMsgs, groupForArchive.archivedThroughMessageId || 0, force);
            setTopicPendingCount(groupTopicPendingCount(allMsgs, groupForArchive.archivedThroughMessageId || 0));
            if (!batchPlan) {
                if (force) addToast(`最近 ${GROUP_TOPIC_HOT_ZONE} 條會保留原文；熱區以前暫無可整理記錄`, 'info');
                return false;
            }
            setGroupPalaceStatus(`正在把 ${batchPlan.messages.length} 條舊群聊整理成公共話題盒…`);
            setSummaryProgress(`正在整理 ${batchPlan.messages.length} 條舊群聊…`);
            const prompt = buildGroupTopicPrompt(groupForArchive, batchPlan.messages, charactersRef.current, groupUserProfile.name, groupNpcs(groupForArchive, npcsRef.current));
            const response = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 2000 }),
            });
            if (!response.ok) throw new Error(`API 返回 ${response.status}`);
            const data = await safeResponseJson(response);
            const parsed = parseGroupTopicBox(data.choices?.[0]?.message?.content || '');
            if (!parsed) throw new Error('總結格式無法解析');

            const box = makeGroupTopicBox(groupForArchive, batchPlan.messages, parsed.title, parsed.summary);
            const updatedGroup: GroupProfile = {
                ...groupForArchive,
                topicBoxes: [...(groupForArchive.topicBoxes || []), box],
                archivedThroughMessageId: box.sourceEndMessageId,
            };
            await updateGroup(groupForArchive.id, {
                topicBoxes: updatedGroup.topicBoxes,
                archivedThroughMessageId: updatedGroup.archivedThroughMessageId,
            });
            setActiveGroup(updatedGroup);

            // 成盒時給所有當前成員一張私聊卡。正文可被私聊上下文/歸檔正常解析；
            // metadata 保留引用，後續編輯/刪除公共盒時同步這些卡片。
            await Promise.all(groupForArchive.members.map(memberId => DB.saveMessage({
                charId: memberId,
                role: 'system',
                type: 'group_topic_card',
                content: `[群聊公共話題盒：${groupForArchive.name}｜${box.title}]\n${box.summary}`,
                metadata: { groupTopicBox: { ...box, groupName: groupForArchive.name } },
            })));
            // 話題盒卡片是直接寫進成員私聊歷史的，也就是 fire_pack 轉寫的直接來源
            markGroupMembersDirty(groupForArchive.members);
            const remaining = groupTopicPendingCount(allMsgs, box.sourceEndMessageId);
            setTopicPendingCount(remaining);
            addToast(`「${box.title}」已成盒，並送達 ${groupForArchive.members.length} 位成員私聊`, 'success');
            return true;
        } catch (err: any) {
            console.warn('[GroupChat] 公共話題盒整理失敗:', err);
            if (force) addToast(`話題盒整理失敗：${err.message || err}`, 'error');
            return false;
        } finally {
            topicArchiveLockRef.current = false;
            setGroupPalaceStatus('');
            setSummaryProgress('');
            if (force) setIsSummarizing(false);
        }
    };

    const runGroupTopicArchive = () => {
        if ((activeGroup?.topicArchiveMode || 'auto') !== 'auto') return;
        void createNextGroupTopicBox(false);
    };

    const saveTopicBoxEdit = async (boxId: string) => {
        if (!activeGroup || !topicTitleDraft.trim() || !topicSummaryDraft.trim()) return;
        const now = Date.now();
        const nextBoxes = (activeGroup.topicBoxes || []).map(box => box.id === boxId
            ? { ...box, title: topicTitleDraft.trim(), summary: topicSummaryDraft.trim(), updatedAt: now }
            : box);
        const updated = { ...activeGroup, topicBoxes: nextBoxes };
        await updateGroup(activeGroup.id, { topicBoxes: nextBoxes });
        setActiveGroup(updated);
        const edited = nextBoxes.find(box => box.id === boxId)!;
        const deliveredIds = (activeGroup.topicBoxes || []).find(box => box.id === boxId)?.deliveredMemberIds || activeGroup.members;
        await Promise.all(deliveredIds.map(async memberId => {
            const msgs = await DB.getMessagesByCharId(memberId, true);
            const cards = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.id === boxId);
            await Promise.all(cards.map(async card => {
                await DB.updateMessage(card.id, `[群聊公共話題盒：${activeGroup.name}｜${edited.title}]\n${edited.summary}`);
                await DB.updateMessageMetadata(card.id, prev => ({ ...(prev || {}), groupTopicBox: { ...edited, groupName: activeGroup.name } }));
            }));
        }));
        setEditingTopicBoxId(null);
        addToast('話題盒已更新，成員私聊卡片同步完成', 'success');
    };

    const deleteTopicBox = async (boxId: string) => {
        if (!activeGroup) return;
        const nextBoxes = (activeGroup.topicBoxes || []).filter(box => box.id !== boxId);
        await updateGroup(activeGroup.id, { topicBoxes: nextBoxes });
        setActiveGroup({ ...activeGroup, topicBoxes: nextBoxes });
        const deliveredIds = (activeGroup.topicBoxes || []).find(box => box.id === boxId)?.deliveredMemberIds || activeGroup.members;
        await Promise.all(deliveredIds.map(async memberId => {
            const msgs = await DB.getMessagesByCharId(memberId, true);
            const ids = msgs.filter(m => m.type === 'group_topic_card' && m.metadata?.groupTopicBox?.id === boxId).map(m => m.id);
            if (ids.length) await DB.deleteMessages(ids);
        }));
        addToast('話題盒和成員私聊卡片已刪除', 'success');
    };

    // 隱身圍觀模式：把用戶消息從餵給 AI 的歷史裡整個拿掉，讓角色以為群裡只有彼此——
    // 不是"提示模型別理用戶"（模型未必聽話），是讓用戶的話在這份歷史裡根本不存在。
    // 用戶自己屏幕上的消息記錄、以及 DB 裡的原始存檔完全不受影響，只影響這裡取出來餵給 prompt 的這一份。
    const filterLurkMsgs = (msgs: Message[]): Message[] =>
        activeGroup?.userLurkMode ? msgs.filter(m => m.role !== 'user') : msgs;

    // 角色主動退群（[[ACTION:LEAVE_GROUP]]）的執行回調工廠：只在群開了 allowMemberLeave 時
    // 才在觸發生成前創建一個實例並塞進 DispatchContext；未開啟就傳 undefined，dispatch.ts
    // 那邊只會剝掉裸標記，不會有任何副作用（真正的開關判斷點在這裡，不在 prompts.ts）。
    // 用工廠閉包住 liveMembers 而不是每次都讀 activeGroup.members，是因為輪詢模式一輪內
    // 會連續調用多次 dispatchMemberActions——同一個 handler 實例要在整輪裡被複用，
    // 才能讓"本輪已經有人退了"正確累加，不被後一次調用的 updates.members 覆蓋回去。
    const makeMemberLeaveHandler = (group: GroupProfile) => {
        let liveMembers = [...group.members];
        let liveOwnerId = group.ownerId;
        let liveMuted = [...(group.mutedMemberIds || [])];
        return async (charId: string, charName: string) => {
            // 群裡至少留 2 位成員，跟手動移除成員的下限一致
            if (liveMembers.length <= 2 || !liveMembers.includes(charId)) return;
            liveMembers = liveMembers.filter(id => id !== charId);
            // 人都走了，群主頭銜、禁言狀態跟著一起清掉，不留懸空引用——跟手動移除成員一致
            const updates: Partial<GroupProfile> = { members: liveMembers };
            if (liveOwnerId === charId) { liveOwnerId = undefined; updates.ownerId = undefined; }
            if (liveMuted.includes(charId)) { liveMuted = liveMuted.filter(id => id !== charId); updates.mutedMemberIds = liveMuted; }
            await updateGroup(group.id, updates);
            setActiveGroup(prev => (prev && prev.id === group.id) ? { ...prev, ...updates } : prev);
            // 歷史消息不刪，只落一條系統消息公告退群，跟手動移除成員的語義一致
            await DB.saveMessage({ charId, groupId: group.id, role: 'system', type: 'system', content: `${charName} 退出了群聊` });
            await refreshMessages(group.id);
            trackEvent('群聊角色主动退群');
        };
    };

    const triggerDirector = async (rawMsgs: Message[], plotDirection?: string) => {
        if (!activeGroup) return;
        if (!apiConfig.apiKey) {
            addToast('請先在設置裡填好 API', 'error');
            return;
        }
        setIsTyping(true);
        const abort = new AbortController();
        abortRef.current = abort;

        try {
            const currentMsgs = filterLurkMsgs(rawMsgs);
            // 1. Prepare Group Context（被禁言的成員不參與——不進上下文，也不佔 memberIds 名額）
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id) && !activeGroup.mutedMemberIds?.includes(c.id));
            // NPC 成員（group.npcMemberIds）：一份輕量檔案塊，跟角色們一起被導演調度
            const npcMembers = activeGroupNpcs(activeGroup, npcs);
            const roundSpeakers = [...groupMembers, ...npcMembers];
            const { header, sharedScene } = buildGroupSystemHeader(currentMsgs, groupMembers);

            let context = header;

            // 2. Inject Member Context (Strict Isolation via ContextBuilder)
            for (const member of groupMembers) {
                context += await buildMemberBlock(member, currentMsgs, sharedScene);
            }
            for (const npc of npcMembers) {
                context += buildNpcBlockFor(npc, currentMsgs, roundSpeakers);
            }

            // 3. Group History + 導演任務指令（模板原文照搬進 utils/groupChat/prompts.ts）
            const liveHistoryMsgs = currentMsgs.filter(m => m.id > (activeGroup.archivedThroughMessageId || 0));
            const historyWindow = liveHistoryMsgs.slice(-contextLimit);
            const preparedHistory = await materializeVisionDescriptions(historyWindow, apiConfig.visionApi);
            const history = buildGroupHistoryBlock(
                preparedHistory,
                speakers,
                emojis,
                groupUserProfile.name,
                3,
                { useVisionDescriptions: apiConfig.visionApi?.enabled === true },
            );
            const emojiContextStr = buildEmojiContextStr(emojis, categories, activeGroup.members);
            // HTML 模塊模式：群開關開啟時追加提示詞。導演模式輸出的是 JSON 數組，
            // 額外強調 [html] 塊寫在角色 content 字符串內部且 HTML 屬性用單引號，避免破壞外層 JSON
            const htmlPromptExt = activeGroup.htmlModeEnabled
                ? `\n\n【群聊 HTML 適配】[html]...[/html] 塊要寫在某個角色自己的 content 字符串內部；HTML 屬性一律用單引號（如 <div style='...'>），避免雙引號破壞外層 JSON。\n${buildHtmlPrompt(activeGroup.htmlModeCustomPrompt)}`
                : '';
            const prompt = `${context}\n\n${buildDirectorInstruction(history, emojiContextStr, { userLurking: !!activeGroup.userLurkMode, maxRoundMessages: activeGroup.maxRoundMessages, allowMemberLeave: !!activeGroup.allowMemberLeave, npcNames: npcMembers.map(n => n.name), plotDirection })}${htmlPromptExt}\n`;
            const memberLeaveHandler = activeGroup.allowMemberLeave ? makeMemberLeaveHandler(activeGroup) : undefined;

            const data = await completeGroupChatWithMcp({
                url: `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
                body: {
                    model: apiConfig.model,
                    messages: [{ role: "user", content: buildUserMessageContent(prompt, history) }],
                    temperature: 0.9, // High creativity for banter
                    max_tokens: 8000
                },
                groupId: activeGroup.id,
                userName: groupUserProfile.name,
                signal: abort.signal,
                onStatus: setMcpStatus,
            });

            // Token 統計：從導演響應裡讀 usage（兼容 OpenAI 兼容接口的標準字段）
            if (data.usage?.total_tokens) {
                setLastTokenUsage(data.usage.total_tokens);
                setTokenBreakdown({
                    prompt: data.usage.prompt_tokens || 0,
                    completion: data.usage.completion_tokens || 0,
                    total: data.usage.total_tokens,
                    msgCount: rawMsgs.length,
                    pass: 'director',
                });
            }

            // 兩層容錯解析（嚴格 JSON → 逐對象搶救），兩層皆空且模型確實吐了內容
            // 時明確提示用戶，不再"正在輸入…"消失後什麼都不發生
            const rawContent = data.choices?.[0]?.message?.content ?? '';
            const actions = parseDirectorActions(rawContent);
            if (actions.length === 0 && String(rawContent).trim()) {
                console.error('Director Parse Error', rawContent);
                addToast('AI 輸出格式無法解析，請重試', 'error');
            }

            // Execute Actions（PRIVATE 側信道/表情/氣泡分段/打字延遲在 utils/groupChat/dispatch.ts）
            // memberIds 只給非禁言成員：萬一 AI 還是替被禁言的角色編了台詞，dispatch 會按"不在
            // memberIds 裡"的規則靜默丟棄這條 action（複用退群同一套丟棄機制，不用額外校驗）。
            await dispatchMemberActions(actions, {
                groupId: activeGroup.id,
                memberIds: roundSpeakers.map(c => c.id),
                characters: speakers,
                npcIds: new Set(npcMembers.map(n => n.id)),
                emojis,
                categories,
                refresh: () => refreshMessages(activeGroup.id),
                addToast,
                signal: abort.signal,
                resolveQuote,
                userName: groupUserProfile.name,
                htmlMode: !!activeGroup.htmlModeEnabled,
                onMemberLeave: memberLeaveHandler,
            });

        } catch (e: any) {
            if (e?.name === 'AbortError') {
                addToast('已停止生成', 'info');
            } else {
                console.error(e);
                addToast(`群聊生成失敗: ${e.message || e}`, 'error');
            }
        } finally {
            setIsTyping(false);
            setMcpStatus('');
            abortRef.current = null;
            // 中途報錯 / 用戶點停也照打：已經落庫的那幾條同樣進了成員的私聊背景
            markGroupMembersDirty(activeGroup.members);
            runGroupTopicArchive();
            void refreshNpcGroupMemories(activeGroup);
        }
    };

    // 輪詢模式：按成員固定順序逐個調用，後發言者能看到前面成員本輪剛說的話
    // （串號天然無解可能 → 天然解決），角色可輸出 [[SKIP]] 本輪沉默。
    // 單成員失敗只跳過該成員，不殺整輪。
    const triggerRoundRobin = async (currentMsgs: Message[], plotDirection?: string) => {
        if (!activeGroup) return;
        if (!apiConfig.apiKey) {
            addToast('請先在設置裡填好 API', 'error');
            return;
        }
        setIsTyping(true);
        const abort = new AbortController();
        abortRef.current = abort;

        const failed: string[] = [];
        let tokenPrompt = 0;
        let tokenCompletion = 0;

        try {
            // 被禁言的成員直接不進這份名單——輪詢模式是逐個發起 API 調用，不在名單裡就是
            // 連調用都不發起，比"生成了再丟棄"更省 token。
            const groupMembers = characters.filter(c => activeGroup.members.includes(c.id) && !activeGroup.mutedMemberIds?.includes(c.id));
            // NPC 成員排在角色們後面輪流說話，用 NPC 自己配的 API（沒配就用群聊這組）
            const npcMembers = activeGroupNpcs(activeGroup, npcs);
            const roundSpeakers = [...groupMembers, ...npcMembers];
            const npcIds = new Set(npcMembers.map(n => n.id));
            const turns: Array<{ kind: 'char'; member: CharacterProfile } | { kind: 'npc'; member: NPCProfile }> = [
                ...groupMembers.map(member => ({ kind: 'char' as const, member })),
                ...npcMembers.map(member => ({ kind: 'npc' as const, member })),
            ];
            let roundMsgs = [...currentMsgs];
            // 同一實例複用一整輪——見 makeMemberLeaveHandler 上面的註釋
            const memberLeaveHandler = activeGroup.allowMemberLeave ? makeMemberLeaveHandler(activeGroup) : undefined;

            for (const turn of turns) {
                const member = turn.member;
                if (abort.signal.aborted) break;
                try {
                    // 每位成員基於"此刻"的群歷史構建上下文——包含本輪先發言成員的新消息。
                    // 隱身圍觀模式只過濾餵給 prompt 的這份視圖，不動 roundMsgs 本身
                    // （後面的 vision 描述回寫、DB 刷新都要基於完整消息列表）。
                    const promptMsgs = filterLurkMsgs(roundMsgs);
                    const { header, sharedScene } = buildGroupSystemHeader(promptMsgs, groupMembers);
                    const memberBlock = turn.kind === 'char'
                        ? await buildMemberBlock(turn.member, promptMsgs, sharedScene)
                        : buildNpcBlockFor(turn.member, promptMsgs, roundSpeakers);
                    const liveRoundMsgs = promptMsgs.filter(m => m.id > (activeGroup.archivedThroughMessageId || 0));
                    const historyWindow = liveRoundMsgs.slice(-contextLimit);
                    const preparedHistory = await materializeVisionDescriptions(historyWindow, apiConfig.visionApi);
                    const preparedById = new Map(preparedHistory.map(message => [message.id, message]));
                    // 輪詢模式後續成員繼續複用本輪剛寫回的描述，不能每位成員各識圖一次。
                    roundMsgs = roundMsgs.map(message => preparedById.get(message.id) || message);
                    const history = buildGroupHistoryBlock(
                        preparedHistory,
                        speakers,
                        emojis,
                        groupUserProfile.name,
                        3,
                        { useVisionDescriptions: apiConfig.visionApi?.enabled === true },
                    );
                    const emojiContextStr = buildEmojiContextStr(emojis, categories, activeGroup.members);
                    const htmlPromptExt = activeGroup.htmlModeEnabled
                        ? `\n\n${buildHtmlPrompt(activeGroup.htmlModeCustomPrompt)}`
                        : '';
                    const prompt = `${header}${memberBlock}\n\n${buildRoundRobinInstruction(member.name, history, emojiContextStr, { userLurking: !!activeGroup.userLurkMode, allowMemberLeave: !!activeGroup.allowMemberLeave, asNpc: turn.kind === 'npc', plotDirection })}${htmlPromptExt}\n`;

                    const turnApi = turn.kind === 'npc' ? resolveNpcApi(turn.member, apiConfig) : apiConfig;
                    const data = await completeGroupChatWithMcp({
                        url: `${turnApi.baseUrl.replace(/\/+$/, '')}/chat/completions`,
                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${turnApi.apiKey}` },
                        body: {
                            model: turnApi.model,
                            messages: [{ role: "user", content: buildUserMessageContent(prompt, history) }],
                            temperature: 0.9,
                            max_tokens: 2000
                        },
                        groupId: activeGroup.id,
                        userName: groupUserProfile.name,
                        signal: abort.signal,
                        onStatus: status => setMcpStatus(status ? `${member.name}：${status}` : ''),
                    });

                    // Token 統計：整輪累加顯示
                    if (data.usage?.total_tokens) {
                        tokenPrompt += data.usage.prompt_tokens || 0;
                        tokenCompletion += data.usage.completion_tokens || 0;
                        setLastTokenUsage(tokenPrompt + tokenCompletion);
                        setTokenBreakdown({
                            prompt: tokenPrompt,
                            completion: tokenCompletion,
                            total: tokenPrompt + tokenCompletion,
                            msgCount: roundMsgs.length,
                            pass: 'round-robin',
                        });
                    }

                    let text = String(data.choices?.[0]?.message?.content ?? '').trim();
                    // 剝模型自作主張加的名字前綴（提示詞禁止了，但仍要兜底）
                    if (text.startsWith(`${member.name}:`) || text.startsWith(`${member.name}：`)) {
                        text = text.slice(member.name.length + 1).trim();
                    }
                    const { skipped, content } = stripSkipMarker(text);
                    if (skipped) continue; // 本輪潛水

                    await dispatchMemberActions([{ charId: member.id, content }], {
                        groupId: activeGroup.id,
                        memberIds: roundSpeakers.map(c => c.id),
                        characters: speakers,
                        npcIds,
                        emojis,
                        categories,
                        refresh: () => refreshMessages(activeGroup.id),
                        addToast,
                        signal: abort.signal,
                        resolveQuote,
                        userName: groupUserProfile.name,
                        htmlMode: !!activeGroup.htmlModeEnabled,
                        onMemberLeave: memberLeaveHandler,
                    });

                    // 刷新滾動歷史給下一位成員
                    roundMsgs = await DB.getGroupMessages(activeGroup.id);

                    // 成員間隨機間隔，增強真實感
                    if (!abort.signal.aborted) {
                        await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
                    }
                } catch (e: any) {
                    if (e?.name === 'AbortError') break;
                    console.error(`[GroupChat] 輪詢模式 ${member.name} 回覆失敗:`, e);
                    failed.push(member.name);
                }
            }

            if (abort.signal.aborted) {
                addToast('已停止生成', 'info');
            } else if (failed.length > 0) {
                addToast(`${failed.join('、')} 本輪回復失敗（已跳過）`, 'error');
            }
        } finally {
            setIsTyping(false);
            setMcpStatus('');
            abortRef.current = null;
            // 同導演模式：跑到一半被打斷也要打髒，已發言成員的話已經落庫了
            markGroupMembersDirty(activeGroup.members);
            runGroupTopicArchive();
            void refreshNpcGroupMemories(activeGroup);
        }
    };

    // 觸發入口：按群設置分發到導演/輪詢；生成中再點 = 停止
    const triggerGroupAI = async (_msgs?: Message[]) => {
        autoReply.cancel();
        unlockWhiteboxAudio();
        if (isTyping) {
            abortRef.current?.abort();
            return;
        }
        if (!activeGroup) return;
        // UI 固定只渲染 50 條，但模型仍應拿到完整近期熱區；生成前獨立讀取，
        // 避免“用戶沒點加載歷史 → AI 也只能看見 50 條”的耦合。
        const promptCap = Math.max(contextLimit, activeGroup.memberTimelineCap ?? DEFAULT_MEMBER_TIMELINE_CAP, GROUP_TOPIC_HOT_ZONE);
        const { messages: freshMsgs } = await DB.getRecentGroupMessagesWithCount(activeGroup.id, promptCap);
        // 劇情方向只在旁觀時有，只管這一輪
        const direction = activeGroup.userLurkMode ? plotDirection.trim() : '';
        if (direction) {
            setPlotDirection('');
            setShowPlotDirection(false);
            trackEvent('群聊旁观给剧情方向');
        }
        if (activeGroup?.replyMode === 'roundRobin') {
            triggerRoundRobin(freshMsgs, direction);
        } else {
            triggerDirector(freshMsgs, direction);
        }
    };

    // --- Renderers ---

    const autoReply = useChatAutoReply({
        enabled: inputPreferences.autoReply,
        conversationId: activeGroup?.id || null,
        active: view === 'chat' && !!activeGroup,
        blocked: isInputFocused || !!input.trim() || showPanel !== 'none' || modalType !== 'none'
            || selectionMode || isSummarizing,
        generating: isTyping,
        onGenerate: () => { void triggerGroupAI(); },
    });

    if (view === 'list') {
        return (
            <div className="h-full w-full bg-slate-50 flex flex-col font-light">
                {/* safe-top spacer 透明 + backdrop-blur，下方容器/list bubbles 透出+模糊（跟 iOS 系統 status bar 一致），避免 header 白 bg 在劉海下鋪一條突兀白帶 */}
                <div className="shrink-0 z-10 sticky top-0">
                    <div className="bg-transparent backdrop-blur-xl" style={{ height: 'var(--safe-top)' }} />
                    <div className="bg-white/70 backdrop-blur-md flex items-end pb-3 px-4 border-b border-white/40 h-20">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-medium text-slate-700 text-lg tracking-wide pl-2">群聊列表</span>
                    <div className="flex-1"></div>
                    <button onClick={() => { setModalType('create'); setSelectedMembers(new Set()); setTempGroupName(''); setMemberGroupId(GROUP_FILTER_ALL); trackEvent('打开创建群聊弹窗'); }} className="p-2 -mr-2 text-violet-500 bg-violet-50 hover:bg-violet-100 rounded-full transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                    </button>
                    </div>
                </div>

                <div className="p-4 space-y-3 overflow-y-auto">
                    {groups.map(g => (
                        <div key={g.id} onClick={() => { setActiveGroup(g); setView('chat'); setGroupChatBackTarget(null); }} className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4 active:scale-[0.98] transition-all cursor-pointer group hover:bg-violet-50/30">
                            {/* Group Avatar Logic */}
                            <div className="w-14 h-14 rounded-2xl bg-slate-100 overflow-hidden border border-slate-200 relative shadow-sm">
                                {g.avatar ? (
                                    <TokenImg value={g.avatar} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="grid grid-cols-2 gap-0.5 p-0.5 w-full h-full bg-slate-200">
                                        {g.members.slice(0, 4).map(mid => {
                                            const c = characters.find(char => char.id === mid);
                                            return <TokenImg key={mid} value={c?.avatar} className="w-full h-full object-cover rounded-sm bg-white" />;
                                        })}
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-slate-700 truncate text-base">{g.name}</div>
                                <div className="text-xs text-slate-400 mt-1 flex items-center gap-1">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 18a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z" /></svg>
                                    {g.members.length} 成員{g.npcMemberIds?.length ? ` · ${g.npcMemberIds.length} NPC` : ''}{g.userLurkMode ? ' · 旁觀中' : ''}
                                </div>
                            </div>
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-300"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                        </div>
                    ))}
                    {groups.length === 0 && (
                        <div className="text-center text-slate-400 text-xs py-10 flex flex-col items-center gap-2">
                            <UsersThree size={36} className="opacity-50" />
                            暫無群聊，點擊右上角創建
                        </div>
                    )}
                </div>

                <Modal isOpen={modalType === 'create'} title="創建群聊" onClose={() => setModalType('none')} footer={<button onClick={handleCreateGroup} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-200">創建</button>}>
                    <div className="space-y-4">
                        <input value={tempGroupName} onChange={e => setTempGroupName(e.target.value)} placeholder="群聊名稱" className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-violet-500/20 transition-all" />
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">選擇成員</label>
                            {/* 分組篩選（沒建分組時不渲染）：只影響可選項的顯示，不影響已勾選成員 */}
                            <CharacterGroupFilterBar characters={characters} groups={characterGroups} value={memberGroupId} onChange={setMemberGroupId} className="mb-2" />
                            <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                                {filterCharactersByGroup(characters, characterGroups, memberGroupId).map(c => (
                                    <div key={c.id} onClick={() => toggleMemberSelection(c.id)} className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${selectedMembers.has(c.id) ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500' : 'border-slate-100 bg-white hover:border-slate-300'}`}>
                                        <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                        <span className="text-[9px] text-slate-600 truncate w-full text-center font-medium">{c.name}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </Modal>
            </div>
        );
    }

    // CHAT VIEW
    // 動森彩蛋模式（與私聊同一開關聯動）
    const acnh = osTheme.skin === 'animalcrossing' && osTheme.acnhChatSync !== false;
    const chatChromeStyle = osTheme.chatChromeStyle || 'soft';
    const chatBackgroundStyle = osTheme.chatBackgroundStyle || 'plain';
    const groupChatRootClass = chatChromeStyle === 'pixel'
        ? 'h-full w-full bg-[#efe1cf] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
        : chatChromeStyle === 'flat'
            ? 'h-full w-full bg-white flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
            : chatChromeStyle === 'floating'
                ? 'h-full w-full bg-[#eef2ff] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500'
                : 'h-full w-full bg-[#f1f5f9] flex flex-col overflow-hidden font-sans relative transition-[background-image,background-color] duration-500';
    const groupChatRootStyle: React.CSSProperties = chatBackgroundStyle === 'grid'
        ? {
            backgroundColor: chatChromeStyle === 'pixel' ? '#efe1cf' : '#f8fafc',
            backgroundImage: 'linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
        }
        : chatBackgroundStyle === 'paper'
            ? {
                backgroundColor: chatChromeStyle === 'pixel' ? '#f4e8d9' : '#f9f7f2',
                backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(148,163,184,0.12) 1px, transparent 0)',
                backgroundSize: '16px 16px',
            }
            : chatBackgroundStyle === 'mesh'
                ? {
                    backgroundColor: '#f8fafc',
                    backgroundImage: 'radial-gradient(circle at 15% 20%, rgba(59,130,246,0.18), transparent 28%), radial-gradient(circle at 85% 15%, rgba(244,114,182,0.18), transparent 24%), radial-gradient(circle at 60% 75%, rgba(45,212,191,0.18), transparent 26%)',
                }
                : { backgroundImage: 'none' };
    const groupFineTuneCss = buildChatFineTuneCss(osTheme);
    const finalGroupRootClass = acnh
        ? 'h-full w-full flex flex-col overflow-hidden font-sans relative transition-[background-color] duration-500'
        : groupChatRootClass;
    const finalGroupRootStyle = acnh
        ? { backgroundColor: '#F6F0D8', backgroundImage: 'none' }
        : groupChatRootStyle;
    return (
        <div className={`sully-chat-root ${finalGroupRootClass}`} style={finalGroupRootStyle}>
            {/* 外觀 App 的全局聊天細節與私聊共用同一份生成 CSS。 */}
            {groupFineTuneCss && <style>{groupFineTuneCss}</style>}
            {/* 白框自定義 CSS：全局默認在前、群專屬在後（後者疊加覆蓋）。作用於 .sully-chat-* 各零件。 */}
            {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
            {activeGroup?.chromeCustomCss && <style>{activeGroup.chromeCustomCss}</style>}
            {/* 氣泡工坊 CSS 排在白框之後，與私聊優先級一致；每套成員主題都限定在自己的消息上。 */}
            {groupBubbleCustomCss && <style>{groupBubbleCustomCss}</style>}
            <style>{`
                .sully-bubble-tail-hidden::before,
                .sully-bubble-tail-hidden::after { content: none !important; display: none !important; }
            `}</style>
            {/* 守護樣式（注在用戶 CSS 之後）：保證返回鍵與輸入區永遠可見可點。 */}
            {(osTheme.chatChromeCustomCss || activeGroup?.chromeCustomCss || groupBubbleCustomCss) && (
                <style>{`
                    .sully-chat-back{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                    .sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important;}
                    .sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important;}
                `}</style>
            )}
            {/* 公共話題盒整理狀態 — 不阻塞交互 */}
            {groupPalaceStatus && (
                <div
                    className="absolute top-[100px] left-1/2 z-[150] animate-fade-in"
                    style={{
                        transform: 'translateX(-50%)',
                        pointerEvents: 'none',
                        willChange: 'transform, opacity',
                    }}
                >
                    <div
                        className="flex items-center gap-2.5 pl-2.5 pr-3.5 py-2 max-w-[20rem]"
                        style={{
                            background: 'rgba(255,255,255,0.88)',
                            borderRadius: 999,
                            border: '1px solid rgba(139,92,246,0.22)',
                            boxShadow: '0 6px 18px -6px rgba(15,23,42,0.22)',
                        }}
                    >
                        <span
                            className="shrink-0 inline-block w-3.5 h-3.5 rounded-full border-2 border-slate-200 animate-spin"
                            style={{ borderTopColor: '#8b5cf6', animationDuration: '0.9s' }}
                        />
                        <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
                            公共話題成盒中
                        </span>
                        <span className="text-[10px] text-slate-400 truncate">{groupPalaceStatus}</span>
                    </div>
                </div>
            )}

            {/* Header — 複用私聊 ChatHeaderShell（7 種頭部風格隨 OS 外觀設置） */}
            <ChatHeaderShell
                selectionMode={selectionMode}
                selectedCount={selectedMsgIds.size}
                onCancelSelection={() => { setSelectionMode(false); setSelectedMsgIds(new Set()); }}
                activeCharacter={{
                    id: activeGroup?.id || 'group',
                    name: activeGroup?.name || '群聊',
                    avatar: activeGroup?.avatar || characters.find(c => c.id === activeGroup?.members[0])?.avatar || '',
                    activeBuffs: [],
                }}
                isTyping={isTyping}
                isSummarizing={isSummarizing}
                isMemoryPalaceProcessing={!!groupPalaceStatus}
                memoryPalaceStatusText={groupPalaceStatus}
                lastTokenUsage={lastTokenUsage}
                tokenBreakdown={tokenBreakdown}
                statusText={`${activeGroup?.members.length ?? 0} 成員${activeGroup?.npcMemberIds?.length ? ` · ${activeGroup.npcMemberIds.length} NPC` : ''}${activeGroup?.userLurkMode ? ' · 旁觀中' : ''}`}
                extraAction={{
                    label: '群聊記憶規則',
                    icon: <Question className="w-5 h-5" weight="bold" />,
                    onClick: () => setModalType('help'),
                }}
                triggerIcon={isTyping ? 'stop' : 'lightning'}
                hideTrigger={inputPreferences.sendButtonGenerates && !isTyping}
                onClose={handleGroupChatClose}
                onTriggerAI={() => triggerGroupAI(messages)}
                onShowCharsPanel={openGroupSettings}
                hideBuffs
                headerStyle={osTheme.chatHeaderStyle}
                avatarShape={osTheme.chatAvatarShape}
                headerAlign={osTheme.chatHeaderAlign}
                headerDensity={osTheme.chatHeaderDensity}
                statusStyle={osTheme.chatStatusStyle}
                chromeStyle={osTheme.chatChromeStyle}
                acnh={acnh}
            />

            {/* 群公告橫幅：設了才顯示，點一下直接進群設置改 */}
            {activeGroup?.announcement?.trim() && (
                <button
                    onClick={openGroupSettings}
                    className="shrink-0 mx-4 mt-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2 text-left active:scale-[0.99] transition-transform"
                >
                    <span className="shrink-0 mt-0.5">📢</span>
                    <p className="flex-1 min-w-0 text-[11px] text-amber-800 leading-relaxed whitespace-pre-wrap line-clamp-3">{activeGroup.announcement}</p>
                </button>
            )}

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar" ref={scrollRef} onClick={() => { if (inputPreferences.autoReply) setShowPanel('none'); }}>
                {collapsedCount > 0 && activeGroup && (
                    <div className="flex justify-center mb-6">
                        <button onClick={async () => {
                            const nextVisibleCount = visibleCount + MESSAGE_PAGE_SIZE;
                            setVisibleCount(nextVisibleCount);
                            const { messages: moreMsgs, totalCount } = await DB.getRecentGroupMessagesWithCount(activeGroup.id, nextVisibleCount);
                            setMessages(moreMsgs);
                            setTotalMsgCount(totalCount);
                        }} className="px-4 py-2 bg-white/50 backdrop-blur-sm rounded-full text-xs text-slate-500 shadow-sm border border-white hover:bg-white transition-colors">
                            加載歷史消息 ({collapsedCount})
                        </button>
                    </div>
                )}
                {displayMessages.map((m, i) => {
                    const isUser = m.role === 'user';
                    const char = characters.find(c => c.id === m.charId) || npcs.find(n => n.id === m.charId);
                    const prevMessage = i > 0 ? displayMessages[i - 1] : null;
                    const nextMessage = i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
                    const messageGroupGapMs = 30 * 60 * 1000;
                    const sameSpeaker = (other: Message | null) => !!other
                        && other.role === m.role
                        && other.charId === m.charId
                        && !!other.metadata?.puppeted === !!m.metadata?.puppeted;
                    const isFirstInGroup = !sameSpeaker(prevMessage)
                        || Math.abs(m.timestamp - prevMessage!.timestamp) > messageGroupGapMs;
                    const isLastInGroup = !sameSpeaker(nextMessage)
                        || Math.abs(nextMessage!.timestamp - m.timestamp) > messageGroupGapMs;
                    const memberTheme = memberBubbleThemes.get(m.charId);

                    return (
                        <GroupMessageItem
                            key={m.id || i}
                            msg={m}
                            isUser={isUser}
                            char={char}
                            userAvatar={groupUserProfile.avatar}
                            onImageClick={handleGroupImageClick}
                            selectionMode={selectionMode}
                            isSelected={selectedMsgIds.has(m.id)}
                            onToggleSelect={toggleMessageSelection}
                            onLongPress={handleMessageLongPress}
                            onReply={handleGroupReply}
                            nameOf={nameOf}
                            onPacketClick={openPacketDetail}
                            styleConfig={isUser ? userBubbleTheme.user : (memberTheme?.ai || PRESET_THEME_GROUP.ai)}
                            themeScopeClass={isUser ? 'sully-group-user-theme' : (memberThemeScopeClasses.get(m.charId) || 'sully-group-default-theme')}
                            isFirstInGroup={isFirstInGroup}
                            isLastInGroup={isLastInGroup}
                            avatarShape={osTheme.chatAvatarShape}
                            avatarSize={osTheme.chatAvatarSize}
                            avatarMode={osTheme.chatAvatarMode}
                            bubbleVariant={osTheme.chatBubbleStyle}
                            messageSpacing={osTheme.chatMessageSpacing}
                            showTimestamp={osTheme.chatShowTimestamp}
                        />
                    );
                })}
                {isTyping && (
                    <div className="flex items-center gap-2 pl-4 py-2 animate-pulse opacity-70">
                        <div className="flex -space-x-1">
                            <div className="w-6 h-6 rounded-full bg-slate-300 border-2 border-white"></div>
                            <div className="w-6 h-6 rounded-full bg-slate-200 border-2 border-white"></div>
                        </div>
                        <span className="text-xs text-slate-400 font-medium">{mcpStatus || '成員正在輸入...'}</span>
                    </div>
                )}
            </div>

            {/* Redesigned Input Area (WeChat/iOS Style) */}
            {/* 回覆預覽條（對齊私聊 Chat.tsx 的樣式與位置） */}
            {replyTarget && !selectionMode && (
                <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-t border-slate-200 text-xs text-slate-500 shrink-0 z-40">
                    {/* 引用的是圖片 / 表情時這裡顯示佔位符，跟落庫的快照同一口徑 */}
                    <div className="flex items-center gap-2 truncate"><span className="font-bold text-slate-700">正在回覆:</span><span className="truncate max-w-[200px]">{buildReplySnapshotContent(replyTarget)}</span></div>
                    <button onClick={() => setReplyTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">×</button>
                </div>
            )}

            {/* 旁觀欄：旁觀時才有。選一位成員代打（輸入框發出的就算 ta 說的）、給下一輪劇情方向、▶ 讓大家繼續聊 */}
            {activeGroup?.userLurkMode && !selectionMode && (
                <div className="shrink-0 z-40 border-t border-violet-100 bg-violet-50/80 backdrop-blur-sm px-3 pt-2 pb-2 space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 text-[10px] font-bold text-violet-500">旁觀中</span>
                        <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                            {(() => {
                                const pool = [
                                    ...characters.filter(c => activeGroup.members.includes(c.id)),
                                    ...groupNpcs(activeGroup, npcs),
                                ];
                                return pool.map(p => {
                                    const on = puppetId === p.id;
                                    return (
                                        <button key={p.id} onClick={() => setPuppetId(on ? '' : p.id)}
                                            title={on ? '取消代打' : `代 ${p.name} 發言`}
                                            className={`shrink-0 flex items-center gap-1 rounded-full pl-0.5 pr-2 py-0.5 border text-[10px] font-bold transition-colors ${on ? 'bg-violet-500 border-violet-500 text-white' : 'bg-white border-violet-100 text-slate-500'}`}>
                                            <TokenImg value={p.avatar} className="w-5 h-5 rounded-full object-cover" />
                                            <span className="max-w-[4.5rem] truncate">{p.name}</span>
                                        </button>
                                    );
                                });
                            })()}
                        </div>
                        <button onClick={() => setShowPlotDirection(v => !v)}
                            className={`shrink-0 px-2 py-1 rounded-full text-[10px] font-bold border ${plotDirection.trim() ? 'bg-amber-100 border-amber-200 text-amber-700' : 'bg-white border-violet-100 text-slate-500'}`}>
                            劇情方向{plotDirection.trim() ? ' ✓' : ''}
                        </button>
                        <button onClick={() => { void triggerGroupAI(); }}
                            title={isTyping ? '停止' : '讓大家繼續聊'}
                            className="shrink-0 w-8 h-8 rounded-full bg-violet-500 text-white flex items-center justify-center text-xs font-bold active:scale-90 transition-transform">
                            {isTyping ? '■' : '▶'}
                        </button>
                    </div>
                    {showPlotDirection && (
                        <textarea value={plotDirection} onChange={e => setPlotDirection(e.target.value)}
                            placeholder="下一輪往哪裡走？例如：小雨不小心說漏嘴，大家開始追問。只管下一輪，按 ▶ 後會清掉。"
                            rows={2}
                            className="w-full bg-white border border-violet-100 rounded-xl px-3 py-2 text-xs resize-none" />
                    )}
                    <p className="text-[9px] text-violet-400 leading-tight">
                        {puppetId
                            ? `正在代「${speakers.find(sp => sp.id === puppetId)?.name || '成員'}」發言：下面輸入框發出的，大家會當成是 ta 說的。`
                            : '沒選代打時，你發的消息只留在你的屏幕上。點頭像選一位成員代打。'}
                    </p>
                </div>
            )}

            {/* 輸入區 — 複用私聊 ChatInputArea（輸入/表情面板/多選刪除隨 OS 外觀設置），
                actions 面板整體替換為群聊自己的 4 格 */}
            <ChatInputArea
                input={input}
                setInput={setInput}
                isTyping={isTyping}
                selectionMode={selectionMode}
                showPanel={showPanel}
                setShowPanel={setShowPanel}
                onSend={() => handleSendMessage(input)}
                onGenerate={() => { void triggerGroupAI(); }}
                sendButtonGenerates={inputPreferences.sendButtonGenerates}
                enterToSend={inputPreferences.enterToSend}
                autoReplyEnabled={inputPreferences.autoReply}
                autoReplySeconds={autoReply.seconds}
                onCancelAutoReply={autoReply.cancel}
                onInputFocusChange={setIsInputFocused}
                onDeleteSelected={deleteSelectedMessages}
                selectedCount={selectedMsgIds.size}
                emojis={filteredEmojis}
                emojiSuggestionsEnabled={inputPreferences.emojiSuggestions}
                suggestionEmojis={emojis}
                activeCharacterId={activeGroup?.id || ''}
                categories={categories}
                activeCategory={activeEmojiCategory}
                onPanelAction={handlePanelAction}
                onImageSelect={handleImageFile}
                isSummarizing={isSummarizing}
                onReroll={handleReroll}
                canReroll={canReroll}
                inputStyle={osTheme.chatInputStyle}
                sendButtonStyle={osTheme.chatSendButtonStyle}
                chromeStyle={osTheme.chatChromeStyle}
                acnh={acnh}
                actionsContent={
                    <div className="p-6 grid grid-cols-4 gap-8">
                        <button onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-pink-50 text-pink-400 border-pink-100">
                                <ImageIcon className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">相冊</span>
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageUpload} />

                        <button onClick={() => { setModalType('transfer'); setShowPanel('none'); trackEvent('打开发红包面板'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-orange-50 text-orange-400 border-orange-100">
                                <Money className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">紅包</span>
                        </button>

                        <button onClick={openGroupSettings} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-violet-50 text-violet-500 border-violet-100">
                                <GearSix className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">群設置</span>
                        </button>

                        <button onClick={() => { setShowNpcGuestModal(true); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-teal-50 text-teal-500 border-teal-100">
                                <MaskHappy className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">NPC 客串</span>
                        </button>

                        <button
                            onClick={() => { if (canReroll) { setShowPanel('none'); handleReroll(); } }}
                            disabled={!canReroll}
                            className={`flex flex-col items-center gap-2 active:scale-95 transition-transform ${canReroll ? 'text-slate-600' : 'text-slate-300 opacity-50'}`}
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border ${canReroll ? 'bg-emerald-50 text-emerald-400 border-emerald-100' : 'bg-slate-50 text-slate-300 border-slate-100'}`}>
                                <ArrowsClockwise className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">重新生成</span>
                        </button>

                        <button onClick={() => { setModalType('chrome-css'); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-sky-50 text-sky-500 border-sky-100">
                                <PaintBrush className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">白框</span>
                        </button>

                        <button onClick={() => { setModalType('chrome-sound'); setShowPanel('none'); }} className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600">
                            <div className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border bg-amber-50 text-amber-500 border-amber-100">
                                <BellSimpleRinging className="w-6 h-6" weight="bold" />
                            </div>
                            <span className="text-xs font-bold">提示音</span>
                        </button>

                        {/* HTML 模式：tap 切換開關；右鍵/長按打開自定義提示詞（交互對齊私聊） */}
                        <button
                            onClick={() => {
                                if (!activeGroup) return;
                                const next = !activeGroup.htmlModeEnabled;
                                updateGroup(activeGroup.id, { htmlModeEnabled: next });
                                setActiveGroup({ ...activeGroup, htmlModeEnabled: next });
                                addToast(next ? 'HTML 模式已開啟' : 'HTML 模式已關閉', 'info');
                                trackEvent('开启群聊 HTML 模式', { state: next ? 'on' : 'off' });
                            }}
                            onContextMenu={(e) => { e.preventDefault(); setTempHtmlPrompt(activeGroup?.htmlModeCustomPrompt || ''); setModalType('html-prompt'); setShowPanel('none'); }}
                            className="flex flex-col items-center gap-2 active:scale-95 transition-transform text-slate-600 relative"
                        >
                            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-sm border relative ${activeGroup?.htmlModeEnabled ? 'bg-fuchsia-100 text-fuchsia-600 border-fuchsia-200' : 'bg-fuchsia-50 text-fuchsia-500 border-fuchsia-100'}`}>
                                <Code className="w-6 h-6" weight="bold" />
                                {activeGroup?.htmlModeEnabled && <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-fuchsia-500 border-2 border-white" />}
                            </div>
                            <span className="text-xs font-bold">{activeGroup?.htmlModeEnabled ? 'HTML已開' : 'HTML模式'}</span>
                        </button>
                    </div>

                }
            />

            {/* --- Modals --- */}

            {/* Group Settings Modal */}
            <Modal isOpen={modalType === 'settings'} title="群組設置" onClose={() => setModalType('none')} footer={<button onClick={handleUpdateGroupInfo} className="w-full py-3 bg-violet-500 text-white font-bold rounded-2xl shadow-lg shadow-violet-200">保存修改</button>}>
                <div className="space-y-6">
                    {/* Header Info */}
                    <div className="flex justify-center">
                        <div onClick={() => groupAvatarInputRef.current?.click()} className="w-24 h-24 rounded-3xl bg-slate-100 border-2 border-dashed border-slate-300 flex items-center justify-center cursor-pointer overflow-hidden relative group hover:border-violet-400">
                            {activeGroup?.avatar ? <TokenImg value={activeGroup.avatar} className="w-full h-full object-cover opacity-90 group-hover:opacity-100" /> : <span className="text-xs text-slate-400 font-bold">更換頭像</span>}
                            <div className="absolute inset-0 bg-black/20 hidden group-hover:flex items-center justify-center text-white"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" /></svg></div>
                        </div>
                        <input type="file" ref={groupAvatarInputRef} className="hidden" accept="image/*" onChange={handleGroupAvatarUpload} />
                    </div>
                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">群名稱</label>
                        <input value={tempGroupName} onChange={e => setTempGroupName(e.target.value)} className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:bg-white focus:border-violet-300 transition-all" />
                    </div>

                    <div>
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">群公告</label>
                        <textarea
                            value={tempAnnouncement}
                            onChange={e => setTempAnnouncement(e.target.value)}
                            placeholder="留空則不顯示公告橫幅；填寫后角色也會知道公告內容"
                            rows={3}
                            className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm outline-none focus:bg-white focus:border-violet-300 transition-all resize-none placeholder:text-slate-300"
                        />
                    </div>

                    {/* 切換用戶身份：這個群單獨用哪張身份卡，即時生效，不影響其他群或私聊 */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">這個群裡，你是</label>
                        <div className="flex flex-wrap gap-2">
                            {(() => {
                                const overrideId = activeGroup ? userProfileBase.perGroupPersonaIds?.[activeGroup.id] : undefined;
                                const chip = (key: string | undefined, avatar: string, name: string, sub: string) => {
                                    const active = overrideId === key || (!overrideId && key === undefined);
                                    return (
                                        <button
                                            key={key || 'default'}
                                            onClick={() => handleSetGroupPersona(key)}
                                            className={`shrink-0 flex items-center gap-2 rounded-2xl border px-2.5 py-2 text-left transition-all active:scale-[0.98] ${active ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white'}`}
                                        >
                                            {avatar ? <TokenImg value={avatar} className="w-8 h-8 rounded-full object-cover shrink-0" alt="" />
                                                : <span className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 shrink-0 text-xs">∅</span>}
                                            <div className="min-w-0">
                                                <div className="text-[11px] font-bold text-slate-700 truncate max-w-[6rem]">{name}</div>
                                                <div className="text-[8px] text-slate-400 whitespace-nowrap">{sub}</div>
                                            </div>
                                        </button>
                                    );
                                };
                                return [
                                    chip(undefined, '', '跟隨全域默認', '身份卡切換時一起變'),
                                    chip(REAL_IDENTITY_PERSONA_ID, userProfileBase.avatar, userProfileBase.name || '真實身份', '固定真實身份'),
                                    ...(userProfileBase.personas || []).map(p => chip(p.id, p.avatar, p.name, '固定這張卡')),
                                ];
                            })()}
                        </div>
                        <p className="text-[9px] text-slate-400 mt-1.5 leading-tight">只影響這個群；其他群和私聊不變。頭像/名字是即時生效的當前狀態，不會改寫這個群裡已經發出的消息內容。</p>
                    </div>

                    {/* 成員管理：新增/移除即時生效，歷史消息不受影響 */}
                    <div className="pt-2 border-t border-slate-100">
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">群成員 ({activeGroup?.members.length || 0})</label>
                            <button onClick={() => setShowAddMemberPicker(v => !v)} className="text-[10px] text-violet-500 font-bold">
                                {showAddMemberPicker ? '收起' : '+ 添加成員'}
                            </button>
                        </div>
                        {/* 群主：我自己也能當，純頭銜標記，不帶任何權限 */}
                        <button
                            onClick={() => handleSetGroupOwner(activeGroup?.ownerId === 'user' ? undefined : 'user')}
                            className={`w-full flex items-center gap-2 rounded-xl px-3 py-2 mb-1.5 border text-left transition-colors ${activeGroup?.ownerId === 'user' ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}
                        >
                            <Crown size={16} weight={activeGroup?.ownerId === 'user' ? 'fill' : 'regular'} className={activeGroup?.ownerId === 'user' ? 'text-amber-500' : 'text-slate-300'} />
                            <span className="text-xs font-semibold text-slate-700 flex-1">我自己</span>
                            <span className={`text-[9px] font-bold ${activeGroup?.ownerId === 'user' ? 'text-amber-600' : 'text-slate-400'}`}>{activeGroup?.ownerId === 'user' ? '群主' : '設為群主'}</span>
                        </button>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto no-scrollbar">
                            {(activeGroup?.members || []).map(memberId => {
                                const c = characters.find(ch => ch.id === memberId);
                                if (!c) return null;
                                const canRemove = (activeGroup?.members.length || 0) > 2;
                                const isOwner = activeGroup?.ownerId === memberId;
                                const isMuted = !!activeGroup?.mutedMemberIds?.includes(memberId);
                                return (
                                    <div key={memberId} className={`flex items-center gap-2 border rounded-xl px-3 py-2 ${isMuted ? 'bg-slate-100 border-slate-200 opacity-60' : 'bg-slate-50 border-slate-200'}`}>
                                        <TokenImg value={c.avatar} className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                        <span className="text-xs font-semibold text-slate-700 flex-1 truncate">{c.name}{isMuted && <span className="ml-1 text-[9px] font-bold text-rose-400">已禁言</span>}</span>
                                        <button
                                            onClick={() => handleSetGroupOwner(isOwner ? undefined : memberId)}
                                            title={isOwner ? '取消群主' : '設為群主（純頭銜，不帶權限）'}
                                            className="p-1 shrink-0"
                                        >
                                            <Crown size={15} weight={isOwner ? 'fill' : 'regular'} className={isOwner ? 'text-amber-500' : 'text-slate-300'} />
                                        </button>
                                        <button
                                            onClick={() => handleToggleMemberMute(memberId)}
                                            title={isMuted ? '取消禁言' : '禁言（這段時間不參與生成，可隨時解除）'}
                                            className="p-1 shrink-0"
                                        >
                                            <SpeakerSlash size={15} weight={isMuted ? 'fill' : 'regular'} className={isMuted ? 'text-rose-500' : 'text-slate-300'} />
                                        </button>
                                        <button
                                            onClick={() => handleRemoveGroupMember(memberId)}
                                            disabled={!canRemove}
                                            title={canRemove ? '移出本群' : '群裡至少要留 2 位成員'}
                                            className="text-[10px] font-bold text-rose-500 disabled:text-slate-300 disabled:cursor-not-allowed shrink-0"
                                        >
                                            移除
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        {showAddMemberPicker && (
                            <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto no-scrollbar border-t border-slate-100 pt-2">
                                {characters.filter(c => !(activeGroup?.members || []).includes(c.id)).length === 0 ? (
                                    <p className="text-[11px] text-slate-400 px-1 py-2">神經鏈接裡沒有其它角色可加了。</p>
                                ) : characters.filter(c => !(activeGroup?.members || []).includes(c.id)).map(c => (
                                    <button key={c.id} onClick={() => handleAddGroupMember(c.id)}
                                        className="w-full flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-left active:scale-[0.99] transition-all">
                                        <TokenImg value={c.avatar} className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                        <span className="text-xs font-semibold text-slate-700 flex-1 truncate">{c.name}</span>
                                        <span className="text-[10px] font-bold text-violet-500">+ 加入</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className="text-[9px] text-slate-400 mt-1.5 leading-tight">加人/移除即時生效；移除不會刪掉 ta 說過的歷史消息，只是之後不再參與生成。群主只是頭銜標記，不帶權限。禁言的角色仍在群裡，只是暫時不參與生成，隨時可以取消。</p>
                    </div>

                    {/* NPC 成員：神經鏈接「NPC」分頁的配角，跟角色們一起聊、推劇情；沒有私聊，有自己的輕量記憶 */}
                    <div className="pt-2 border-t border-slate-100">
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">NPC 成員 ({activeGroup ? groupNpcs(activeGroup, npcs).length : 0})</label>
                            <button onClick={() => setShowAddNpcPicker(v => !v)} className="text-[10px] text-teal-600 font-bold">
                                {showAddNpcPicker ? '收起' : '+ 加入 NPC'}
                            </button>
                        </div>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto no-scrollbar">
                            {activeGroup && groupNpcs(activeGroup, npcs).map(n => {
                                const isMuted = !!activeGroup.mutedMemberIds?.includes(n.id);
                                return (
                                    <div key={n.id} className={`flex items-center gap-2 border rounded-xl px-3 py-2 ${isMuted ? 'bg-slate-100 border-slate-200 opacity-60' : 'bg-teal-50/60 border-teal-100'}`}>
                                        <TokenImg value={n.avatar} className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                        <span className="text-xs font-semibold text-slate-700 flex-1 truncate">
                                            {n.name}
                                            <span className="ml-1 text-[9px] font-bold text-teal-500">NPC</span>
                                            {isMuted && <span className="ml-1 text-[9px] font-bold text-rose-400">已禁言</span>}
                                        </span>
                                        <button
                                            onClick={() => handleToggleMemberMute(n.id)}
                                            title={isMuted ? '取消禁言' : '禁言（這段時間不參與生成，可隨時解除）'}
                                            className="p-1 shrink-0"
                                        >
                                            <SpeakerSlash size={15} weight={isMuted ? 'fill' : 'regular'} className={isMuted ? 'text-rose-500' : 'text-slate-300'} />
                                        </button>
                                        <button onClick={() => handleRemoveGroupNpc(n.id)} className="text-[10px] font-bold text-rose-500 shrink-0">移除</button>
                                    </div>
                                );
                            })}
                        </div>
                        {showAddNpcPicker && (
                            <div className="mt-2 space-y-1.5 max-h-48 overflow-y-auto no-scrollbar border-t border-slate-100 pt-2">
                                {npcs.filter(n => !(activeGroup?.npcMemberIds || []).includes(n.id)).length === 0 ? (
                                    <p className="text-[11px] text-slate-400 px-1 py-2">{npcs.length === 0 ? '還沒有 NPC——先去「神經鏈接」→「NPC」分頁建一個。' : '所有 NPC 都已經在群裡了。'}</p>
                                ) : npcs.filter(n => !(activeGroup?.npcMemberIds || []).includes(n.id)).map(n => (
                                    <button key={n.id} onClick={() => handleAddGroupNpc(n.id)}
                                        className="w-full flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 text-left active:scale-[0.99] transition-all">
                                        <TokenImg value={n.avatar} className="w-8 h-8 rounded-lg object-cover shrink-0" />
                                        <span className="text-xs font-semibold text-slate-700 flex-1 truncate">{n.name}</span>
                                        <span className="text-[10px] font-bold text-teal-600">+ 加入</span>
                                    </button>
                                ))}
                            </div>
                        )}
                        <p className="text-[9px] text-slate-400 mt-1.5 leading-tight">NPC 是推劇情的配角：跟角色們一起輪流說話，但沒有跟你的私聊，也不會收到話題盒卡片。群裡攢了一段新對話後，NPC 會自動把這段整理進自己的記憶（在 NPC 編輯頁可以看、可以改）。</p>
                    </div>

                    {/* 隱身圍觀模式：用戶消息不進 AI 的群歷史，角色以為群裡只有彼此 */}
                    <div className="pt-2 border-t border-slate-100">
                        <div className="flex items-center justify-between mb-1">
                            <div className="flex-1 pr-3">
                                <div className="text-xs font-bold text-slate-700">旁觀（我不在這個群裡）</div>
                                <p className="text-[9px] text-slate-500 mt-0.5 leading-tight">關閉 = 參加：你是群裡的一員。開啟 = 旁觀：角色們不知道你在場，能聊平時不會讓你知道的事，不會搭理或私聊你。底部會多一條旁觀欄：可以選一位成員「代打」替 ta 發言、給下一輪一個劇情方向，再按 ▶ 讓大家繼續聊。沒選代打時你自己發的消息只留在你的屏幕上，AI 看不到。</p>
                            </div>
                            <div
                                onClick={async () => {
                                    if (!activeGroup) return;
                                    const next = !activeGroup.userLurkMode;
                                    await updateGroup(activeGroup.id, { userLurkMode: next });
                                    setActiveGroup({ ...activeGroup, userLurkMode: next });
                                    trackEvent('切换群聊隐身围观模式', { enabled: next });
                                }}
                                className={`w-11 h-6 rounded-full cursor-pointer transition-colors relative shrink-0 ${activeGroup?.userLurkMode ? 'bg-violet-500' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${activeGroup?.userLurkMode ? 'left-[22px]' : 'left-0.5'}`} />
                            </div>
                        </div>
                    </div>

                    {/* 角色可以退群：開啟後 AI 才會被教 [[ACTION:LEAVE_GROUP]] 語法 */}
                    <div className="pt-2 border-t border-slate-100">
                        <div className="flex items-center justify-between mb-1">
                            <div className="flex-1 pr-3">
                                <div className="text-xs font-bold text-slate-700">角色可以退群</div>
                                <p className="text-[9px] text-slate-500 mt-0.5 leading-tight">開啟后角色在關係破裂、劇情需要等足夠重的理由下，可以自己選擇退出這個群（極少觸發，不是想退就退）。退群不刪 ta 說過的歷史消息，群裡會有一條退群公告，之後要用「群成員」重新邀請回來。</p>
                            </div>
                            <div
                                onClick={async () => {
                                    if (!activeGroup) return;
                                    const next = !activeGroup.allowMemberLeave;
                                    await updateGroup(activeGroup.id, { allowMemberLeave: next });
                                    setActiveGroup({ ...activeGroup, allowMemberLeave: next });
                                    trackEvent('切换群聊角色可退群', { enabled: next });
                                }}
                                className={`w-11 h-6 rounded-full cursor-pointer transition-colors relative shrink-0 ${activeGroup?.allowMemberLeave ? 'bg-violet-500' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${activeGroup?.allowMemberLeave ? 'left-[22px]' : 'left-0.5'}`} />
                            </div>
                        </div>
                    </div>

                    <div className="pt-2 border-t border-slate-100">
                        <h3 className="mb-2 text-xs font-bold text-slate-600">輸入與發送</h3>
                        <ChatInputSettings value={settingsInputPreferences} onChange={setSettingsInputPreferences} scope="group" />
                    </div>

                    {/* Reply Mode */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">回覆生成模式</label>
                        <div className="flex flex-col gap-2">
                            <div
                                onClick={() => { setTempReplyMode('director'); trackEvent('切换群聊回复生成模式', { mode: 'director' }); }}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${tempReplyMode === 'director' ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                            >
                                <div className="text-xs font-bold text-slate-700">導演模式（默認）</div>
                                <p className="text-[9px] text-slate-400 mt-1 leading-tight">一次 API 調用生成整輪群聊。快、省 token，但角色偶爾可能串號。</p>
                            </div>
                            <div
                                onClick={() => { setTempReplyMode('roundRobin'); trackEvent('切换群聊回复生成模式', { mode: 'roundRobin' }); }}
                                className={`p-3 rounded-xl border cursor-pointer transition-all ${tempReplyMode === 'roundRobin' ? 'border-violet-400 bg-violet-50 ring-1 ring-violet-400' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                            >
                                <div className="text-xs font-bold text-slate-700">輪詢模式</div>
                                <p className="text-[9px] text-slate-400 mt-1 leading-tight">每位成員單獨調用一次 API，按順序逐個發言（每人必發言）。更真實、徹底防串號，但更慢，token 消耗約為導演模式 × 成員數。</p>
                            </div>
                        </div>
                    </div>

                    {/* Bubble Appearance */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">氣泡外觀</label>
                        <div className="flex items-center justify-between mb-3">
                            <div className="flex-1 pr-3">
                                <div className="text-xs font-bold text-slate-700">成員獨立氣泡</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-tight">開啟後每位成員完整沿用其私聊氣泡主題（AI 側，包含自定義 CSS 與裝飾）；關閉則全員統一。</p>
                            </div>
                            <div
                                onClick={() => setTempMemberBubbleIndependent(v => !v)}
                                className={`w-11 h-6 rounded-full cursor-pointer transition-colors relative shrink-0 ${tempMemberBubbleIndependent ? 'bg-violet-500' : 'bg-slate-200'}`}
                            >
                                <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all ${tempMemberBubbleIndependent ? 'left-[22px]' : 'left-0.5'}`} />
                            </div>
                        </div>
                        <div className="text-xs font-bold text-slate-700 mb-2">我的氣泡</div>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
                            {[{ id: '', name: '默認·紫', color: PRESET_THEME_GROUP.user.backgroundColor },
                              ...Object.values(PRESET_THEMES).map(t => ({ id: t.id, name: t.name, color: t.user.backgroundColor })),
                              ...customThemes.map(t => ({ id: t.id, name: `${t.name} (DIY)`, color: t.user.backgroundColor }))].map(opt => (
                                <button
                                    key={opt.id || '_default'}
                                    onClick={() => setTempUserBubbleThemeId(opt.id)}
                                    className={`shrink-0 px-3 py-2 rounded-xl border text-[10px] font-bold flex items-center gap-1.5 transition-all ${tempUserBubbleThemeId === opt.id ? 'border-violet-500 bg-violet-50 ring-1 ring-violet-500 text-violet-700' : 'border-slate-200 bg-white text-slate-500'}`}
                                >
                                    <span className="w-3.5 h-3.5 rounded-full border border-black/10" style={{ backgroundColor: opt.color }} />
                                    {opt.name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Context Limit */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">AI 上下文條數 ({contextLimit})</label>
                        <input type="range" min="20" max="5000" step="10" value={contextLimit} onChange={e => { const v = parseInt(e.target.value); setContextLimit(v); localStorage.setItem('groupchat_context_limit', String(v)); }} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (省流)</span><span>5000 (超長記憶)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">角色每次發言時參考多少條群聊歷史。越多越連貫，但越慢、越費 token。</p>
                    </div>

                    {/* Private Chat Group Context Cap */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">私聊裡"近期群活動"取條數 ({tempPrivateContextCap})</label>
                        <input type="range" min="20" max="500" step="10" value={tempPrivateContextCap} onChange={e => setTempPrivateContextCap(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (省流)</span><span>500 (完整)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">本群成員在自己的私聊裡，最多看到本群最近多少條消息作為"近期群活動"上下文。</p>
                    </div>

                    {/* Member Timeline Cap */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">成員互動時間線條數 ({tempMemberTimelineCap})</label>
                        <input type="range" min="20" max="200" step="10" value={tempMemberTimelineCap} onChange={e => setTempMemberTimelineCap(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>20 (省流)</span><span>200 (完整)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">群裡發言時，每位成員參考的"私聊+群聊合併時間線"條數。這條時間線讓角色在群裡的感情與私聊銜接。</p>
                    </div>

                    {/* 一輪最多幾條：只影響導演模式，輪詢模式每人本來就只發或跳過一次 */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">導演模式一輪最多幾條 ({tempMaxRoundMessages})</label>
                        <input type="range" min="1" max="10" step="1" value={tempMaxRoundMessages} onChange={e => setTempMaxRoundMessages(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-full appearance-none accent-violet-500" />
                        <div className="flex justify-between text-[10px] text-slate-400 mt-1"><span>1 (克制)</span><span>10 (熱鬧)</span></div>
                        <p className="text-[9px] text-slate-400 mt-1 leading-tight">下限固定 1 條（"少即是多"，冷場時角色允許只回 1-2 條），這裡調的是上限，默認 5。只影響導演模式；輪詢模式每位成員本來就只會發言或跳過一次。</p>
                    </div>

                    {/* 公共話題盒：一次總結，全群共享，並在成盒時送達所有成員私聊。 */}
                    <div className="pt-2 border-t border-slate-100 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">群聊總結 · 公共話題盒</label>
                            <span className="text-[10px] text-violet-500 font-bold">{activeGroup?.topicBoxes?.length || 0} 個盒子</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5">
                            {([
                                { id: 'auto' as const, title: '自動整理', desc: '滿100條自動成盒' },
                                { id: 'manual' as const, title: '手動整理', desc: '只在點擊時成盒' },
                            ]).map(option => {
                                const active = (activeGroup?.topicArchiveMode || 'auto') === option.id;
                                return (
                                    <button key={option.id} onClick={async () => {
                                        if (!activeGroup) return;
                                        await updateGroup(activeGroup.id, { topicArchiveMode: option.id });
                                        setActiveGroup({ ...activeGroup, topicArchiveMode: option.id });
                                        trackEvent('切换群聊总结整理方式', { mode: option.id });
                                    }} className={`rounded-xl px-3 py-2.5 text-left transition-all ${active ? 'bg-white shadow-sm ring-1 ring-violet-100' : 'text-slate-400'}`}>
                                        <div className={`text-[11px] font-bold ${active ? 'text-violet-600' : 'text-slate-500'}`}>{option.title}</div>
                                        <div className="text-[9px] mt-0.5">{option.desc}</div>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50 to-indigo-50 p-3.5 space-y-2">
                            <p className="text-[11px] font-bold text-violet-700">一份總結，全群共同記住</p>
                            <p className="text-[10px] leading-5 text-violet-600/80">
                                最近 {GROUP_TOPIC_HOT_ZONE} 條始終保留原文；更早的記錄累計 {GROUP_TOPIC_BUFFER_THRESHOLD} 條後{(activeGroup?.topicArchiveMode || 'auto') === 'auto' ? '自動整理' : '等待你手動整理'}成公共話題盒。
                                盒子只屬於本群，同時會作為卡片送到每位成員私聊，之後可被各自的私聊上下文與歸檔正常理解。
                            </p>
                            <div className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-2 text-[10px]">
                                <span className="text-slate-500">熱區以前待整理</span>
                                <span className={`font-bold ${topicPendingCount >= GROUP_TOPIC_BUFFER_THRESHOLD ? 'text-amber-500' : 'text-slate-500'}`}>{topicPendingCount} / {GROUP_TOPIC_BUFFER_THRESHOLD} 條</span>
                            </div>
                        </div>

                        <div className="bg-white border border-slate-100 rounded-2xl p-3 flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-violet-50 flex items-center justify-center">✦</div>
                            <div>
                                <div className="text-[10px] font-bold text-slate-600">內置 · 群聊共同記憶總結</div>
                                <p className="text-[9px] text-slate-400 mt-0.5 leading-4">總結機會讀取全體成員的簡介、核心設定、世界觀、寫作人格與核心記憶，不再複用私聊歸檔風格。</p>
                            </div>
                        </div>

                        <button onClick={() => { void createNextGroupTopicBox(true); trackEvent('手动整理群话题盒'); }} disabled={isSummarizing || topicPendingCount === 0} className={`w-full py-3 rounded-2xl border font-bold text-xs flex items-center justify-center gap-2 ${topicPendingCount === 0 ? 'bg-slate-50 border-slate-100 text-slate-300' : 'bg-violet-500 border-violet-500 text-white shadow-lg shadow-violet-200'}`}>
                            {isSummarizing ? <><span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />{summaryProgress || '正在成盒…'}</> : '立即整理當前可歸檔內容'}
                        </button>

                        <div className="space-y-2">
                            {(activeGroup?.topicBoxes || []).slice().reverse().map(box => {
                                const editing = editingTopicBoxId === box.id;
                                return (
                                    <div key={box.id} className="rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
                                        {editing ? (
                                            <div className="space-y-2">
                                                <input value={topicTitleDraft} onChange={e => setTopicTitleDraft(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-bold" placeholder="話題盒標題" />
                                                <textarea value={topicSummaryDraft} onChange={e => setTopicSummaryDraft(e.target.value)} className="w-full min-h-28 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs leading-5 resize-y" placeholder="共同回憶總結" />
                                                <div className="flex gap-2">
                                                    <button onClick={() => setEditingTopicBoxId(null)} className="flex-1 py-2 rounded-xl bg-slate-100 text-slate-500 text-[11px] font-bold">取消</button>
                                                    <button onClick={() => void saveTopicBoxEdit(box.id)} className="flex-1 py-2 rounded-xl bg-violet-500 text-white text-[11px] font-bold">保存並同步卡片</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <>
                                                <div className="flex items-start gap-2">
                                                    <div className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center shrink-0">💬</div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs font-bold text-slate-700">{box.title}</div>
                                                        <div className="text-[9px] text-slate-400 mt-0.5">歸檔 {box.messageCount} 條 · {new Date(box.createdAt).toLocaleDateString('zh-CN')}</div>
                                                    </div>
                                                </div>
                                                <p className="mt-2.5 text-[11px] leading-5 text-slate-600 whitespace-pre-wrap">{box.summary}</p>
                                                <div className="mt-3 flex gap-2 justify-end">
                                                    <button onClick={() => { setEditingTopicBoxId(box.id); setTopicTitleDraft(box.title); setTopicSummaryDraft(box.summary); }} className="px-3 py-1.5 rounded-lg bg-violet-50 text-violet-600 text-[10px] font-bold">修改</button>
                                                    <button onClick={() => void deleteTopicBox(box.id)} className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-500 text-[10px] font-bold">刪除</button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                            {(activeGroup?.topicBoxes?.length || 0) === 0 && (
                                <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-5 text-center text-[10px] text-slate-400">聊天還在近期熱區裡。內容足夠多後，會自動出現第一隻公共話題盒。</div>
                            )}
                        </div>
                    </div>

                    {/* Danger Zone */}
                    <div className="pt-2 border-t border-slate-100">
                        <label className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-3 block">危險區域</label>
                        
                        <div className="flex items-center gap-2 mb-3 cursor-pointer" onClick={() => setPreserveContext(!preserveContext)}>
                             <div className={`w-5 h-5 rounded-full border flex items-center justify-center transition-colors ${preserveContext ? 'bg-violet-500 border-violet-500' : 'bg-slate-100 border-slate-300'}`}>
                                 {preserveContext && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>}
                             </div>
                             <span className="text-xs text-slate-600">清空時保留最後10條記錄 (維持語境)</span>
                        </div>

                        <div className="flex gap-2">
                            <button onClick={handleClearHistory} className="flex-1 py-3 bg-red-50 text-red-500 font-bold rounded-2xl border border-red-100 active:scale-95 transition-transform flex items-center justify-center gap-2 text-xs">
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                清空聊天
                            </button>
                            <button onClick={() => { if(activeGroup) handleDeleteGroup(activeGroup.id); }} className="flex-1 py-3 text-white bg-red-500 hover:bg-red-600 rounded-2xl text-xs font-bold transition-colors shadow-lg shadow-red-200">解散群聊</button>
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Message Options Modal */}
            <Modal isOpen={modalType === 'message-options'} title="消息操作" onClose={() => { setModalType('none'); setSelectedMessage(null); }}>
                <div className="space-y-3">
                    <button
                        onClick={() => {
                            if (selectedMessage) setReplyTarget(selectedMessage);
                            setModalType('none');
                            setSelectedMessage(null);
                        }}
                        className="w-full py-3 bg-violet-50 text-violet-600 font-medium rounded-2xl active:bg-violet-100 transition-colors flex items-center justify-center gap-2"
                    >
                        引用 / 回覆
                    </button>
                    <button onClick={handleEnterSelectionMode} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                        多選 / 批量刪除
                    </button>
                    {selectedMessage?.type === 'text' && (
                        <button onClick={handleCopyMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            複製文字
                        </button>
                    )}
                    {selectedMessage?.type === 'text' && (
                        <button onClick={handleStartEditMessage} className="w-full py-3 bg-slate-50 text-slate-700 font-medium rounded-2xl active:bg-slate-100 transition-colors flex items-center justify-center gap-2">
                            修改內容
                        </button>
                    )}
                    <button onClick={handleDeleteSingleMessage} className="w-full py-3 bg-red-50 text-red-500 font-medium rounded-2xl active:bg-red-100 transition-colors flex items-center justify-center gap-2">
                        刪除消息
                    </button>
                </div>
            </Modal>

            {/* Edit Message Modal */}
            <Modal
                isOpen={modalType === 'edit-message'} title="編輯內容" onClose={() => { setModalType('none'); setSelectedMessage(null); }}
                footer={<><button onClick={() => { setModalType('none'); setSelectedMessage(null); }} className="flex-1 py-3 bg-slate-100 rounded-2xl">取消</button><button onClick={confirmEditMessage} className="flex-1 py-3 bg-primary text-white font-bold rounded-2xl">保存</button></>}
            >
                <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-32 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-primary/20 transition-all text-sm leading-relaxed"
                />
            </Modal>

            {/* Transfer Modal — 紅包 2.0：拼手氣 / 專屬 */}
            {/* NPC 客串：不是正式群成員，手動觸發插一句話 */}
            <Modal isOpen={showNpcGuestModal} title="NPC 客串" onClose={() => setShowNpcGuestModal(false)}
                footer={<button onClick={handleNpcGuestLine} disabled={npcGuestGenerating || !npcGuestId} className="w-full py-3 bg-teal-500 text-white font-bold rounded-2xl disabled:opacity-50">{npcGuestGenerating ? '生成中…' : '插一句話'}</button>}>
                <div className="space-y-4">
                    {npcs.length > 0 ? (
                        <>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">選一個 NPC</label>
                                <select value={npcGuestId} onChange={e => setNpcGuestId(e.target.value)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                                    <option value="">— 選擇一個 NPC —</option>
                                    {npcs.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                                </select>
                                <p className="text-[9px] text-slate-400 mt-1">TA 不是這個群的正式成員，只插這一句話，不會被拉進後續輪詢。</p>
                            </div>
                            <div>
                                <label className="text-[10px] font-bold text-slate-400 uppercase block mb-1">這次客串的方向提示（可選）</label>
                                <textarea value={npcGuestHint} onChange={e => setNpcGuestHint(e.target.value)} placeholder="不填就讓 TA 自己接話"
                                    rows={3}
                                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm resize-y" />
                            </div>
                        </>
                    ) : (
                        <p className="text-[11px] text-slate-400 leading-relaxed">
                            還沒有 NPC——請先去「神經鏈接」→「NPC」分頁建一個，再回來客串。
                        </p>
                    )}
                </div>
            </Modal>

            <Modal isOpen={modalType === 'transfer'} title="發送紅包" onClose={() => setModalType('none')} footer={<button onClick={handleSendPacket} className="w-full py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200">塞進紅包</button>}>
                <div className="space-y-4">
                    {/* Tab 切換 */}
                    <div className="flex gap-2">
                        {([['lucky', '拼手氣'], ['direct', '專屬']] as const).map(([key, label]) => (
                            <button
                                key={key}
                                onClick={() => setPacketTab(key)}
                                className={`flex-1 py-2 rounded-xl text-sm font-bold transition-all ${packetTab === key ? 'bg-orange-500 text-white shadow-md' : 'bg-slate-100 text-slate-500'}`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="text-center py-2 animate-bounce"><img src={twemojiUrl('1f9e7')} alt="red envelope" className="w-12 h-12 mx-auto" /></div>

                    <input type="number" value={transferAmount} onChange={e => setTransferAmount(e.target.value)} placeholder={packetTab === 'lucky' ? '總金額' : '金額'} className="w-full px-4 py-4 bg-slate-100 rounded-2xl text-center text-2xl font-bold outline-none text-slate-800 placeholder:text-slate-300" autoFocus />

                    {packetTab === 'lucky' ? (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">份數（大家搶，隨機金額）</label>
                            <input type="number" value={packetShares} onChange={e => setPacketShares(e.target.value)} min={1} className="w-full px-4 py-3 bg-slate-100 rounded-2xl text-center text-lg font-bold outline-none text-slate-800" />
                        </div>
                    ) : (
                        <div>
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">發給誰（只有 ta 能收）</label>
                            <div className="grid grid-cols-4 gap-2 max-h-36 overflow-y-auto pr-1">
                                {(activeGroup?.members || []).map(mid => {
                                    const c = characters.find(ch => ch.id === mid);
                                    if (!c) return null;
                                    return (
                                        <div key={mid} onClick={() => setPacketTargetId(mid)} className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${packetTargetId === mid ? 'border-orange-500 bg-orange-50 ring-1 ring-orange-500' : 'border-slate-100 bg-white hover:border-slate-300'}`}>
                                            <TokenImg value={c.avatar} className="w-10 h-10 rounded-full object-cover" />
                                            <span className="text-[9px] text-slate-600 truncate w-full text-center font-medium">{c.name}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    <input value={packetNote} onChange={e => setPacketNote(e.target.value)} placeholder="恭喜發財（祝福語，可不填）" className="w-full px-4 py-3 bg-slate-100 rounded-2xl text-sm outline-none text-slate-700 placeholder:text-slate-300" />
                </div>
            </Modal>

            {/* Packet Detail Modal — 領取明細 + 用戶搶/收/退 */}
            <Modal isOpen={modalType === 'packet-detail'} title="紅包詳情" onClose={() => { setModalType('none'); setSelectedPacketId(null); }}>
                {(() => {
                    const pMsg = messages.find(m => m.id === selectedPacketId);
                    const meta = pMsg?.metadata as GroupPacketMeta | undefined;
                    if (!pMsg || !meta?.packet) return <div className="text-center text-xs text-slate-400 py-6">這個紅包的數據不見了</div>;
                    const status = effectivePacketStatus(meta, Date.now());
                    const senderName = pMsg.role === 'user' ? groupUserProfile.name : nameOf(pMsg.charId);
                    const userClaimed = meta.claims.some(c => c.claimantId === 'user');
                    const canGrabLucky = meta.packetType === 'lucky' && status === 'pending' && !userClaimed;
                    const canResolveDirect = meta.packetType === 'direct' && status === 'pending' && meta.targetId === 'user';
                    return (
                        <div className="space-y-4">
                            <div className="text-center">
                                <div className="text-4xl mb-1">🧧</div>
                                <div className="font-bold text-slate-800">{senderName} 的{meta.packetType === 'lucky' ? '拼手氣' : '專屬'}紅包</div>
                                <div className="text-xs text-slate-400 mt-1">「{meta.note}」</div>
                                <div className="text-2xl font-black text-orange-500 mt-2">¥{meta.totalAmount}</div>
                                {meta.packetType === 'lucky' && (
                                    <div className="text-[10px] text-slate-400 mt-1">共 {meta.shares} 份 · 已領 {meta.claims.length} 份{status === 'expired' ? ' · 已過期' : ''}</div>
                                )}
                                {meta.packetType === 'direct' && (
                                    <div className="text-[10px] text-slate-400 mt-1">發給 {nameOf(meta.targetId || '')} · {status === 'pending' ? '待領取' : status === 'done' ? '已收下' : status === 'returned' ? '已退回' : '已過期'}</div>
                                )}
                            </div>

                            {meta.claims.length > 0 && (
                                <div className="space-y-2 max-h-44 overflow-y-auto">
                                    {meta.claims.map((c, i) => {
                                        const avatar = c.claimantId === 'user' ? groupUserProfile.avatar : characters.find(ch => ch.id === c.claimantId)?.avatar;
                                        return (
                                            <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-xl px-3 py-2">
                                                <TokenImg value={avatar} className="w-8 h-8 rounded-full object-cover" />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-xs font-bold text-slate-700 truncate">{nameOf(c.claimantId)}</div>
                                                    <div className="text-[9px] text-slate-400">{new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                                                </div>
                                                <div className="text-sm font-black text-orange-500">¥{c.amount}</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {canGrabLucky && (
                                <button onClick={() => handleUserPacketAction(pMsg, 'claim')} className="w-full py-3 bg-gradient-to-r from-orange-500 to-rose-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 active:scale-95 transition-transform">
                                    搶紅包
                                </button>
                            )}
                            {canResolveDirect && (
                                <div className="flex gap-2">
                                    <button onClick={() => handleUserPacketAction(pMsg, 'claim')} className="flex-1 py-3 bg-orange-500 text-white font-bold rounded-2xl shadow-lg shadow-orange-200 active:scale-95 transition-transform">收下</button>
                                    <button onClick={() => handleUserPacketAction(pMsg, 'return')} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform">退回</button>
                                </div>
                            )}
                        </div>
                    );
                })()}
            </Modal>

            {/* 群「白框自定義」底部 sheet —— 寫到 group.chromeCustomCss，疊加在全局之上（對齊私聊做法） */}
            {activeGroup && modalType === 'chrome-css' && (
                <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                    <div
                        className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                        style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="mb-2 flex items-start justify-between">
                            <div>
                                <div className="text-sm font-bold text-slate-800">白框自定義 · {activeGroup.name}</div>
                                <div className="mt-0.5 text-[10px] text-slate-400">↑ 上方群聊界面即實時預覽；僅對本群生效，疊加在全局設置之上。</div>
                            </div>
                            <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                        </div>
                        <ChromeCssEditor
                            value={activeGroup.chromeCustomCss || ''}
                            onChange={(css) => { updateGroup(activeGroup.id, { chromeCustomCss: css }); setActiveGroup({ ...activeGroup, chromeCustomCss: css }); }}
                        />
                    </div>
                    {/* 脫離 CSS 控制的救援鍵：portal 到 body + id 守護，壞 CSS 也點得到（逐字複用私聊方案） */}
                    {createPortal(
                        <>
                            <style>{`#sully-safe-reset{position:fixed!important;top:calc(var(--safe-top) + 6px)!important;left:50%!important;transform:translateX(-50%)!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;display:flex!important;z-index:2147483647!important;}`}</style>
                            <button
                                id="sully-safe-reset"
                                onClick={() => { updateGroup(activeGroup.id, { chromeCustomCss: '' }); setActiveGroup({ ...activeGroup, chromeCustomCss: '' }); addToast('已還原本群白框', 'success'); }}
                                style={{
                                    position: 'fixed', top: 'calc(var(--safe-top) + 6px)', left: '50%', transform: 'translateX(-50%)',
                                    zIndex: 2147483647, display: 'flex', alignItems: 'center', gap: '4px',
                                    padding: '5px 12px', borderRadius: '999px',
                                    background: 'rgba(15,23,42,0.62)', color: '#fff', fontSize: '11px', fontWeight: 700,
                                    border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                                }}
                            >⟲ 還原本群白框</button>
                        </>,
                        document.body,
                    )}
                </div>
            )}

            {/* 群「提示音」底部 sheet —— 默認獨立存 group.chatSound；綁定後寫進 chromeCustomCss 的 @sully-sound 指令 */}
            {activeGroup && modalType === 'chrome-sound' && (() => {
                const boundSound = parseWhiteboxSound(activeGroup.chromeCustomCss);
                const isBound = !!activeGroup.chatSoundBound || !!boundSound;
                const curSound: WhiteboxSound | null = isBound ? boundSound : (activeGroup.chatSound || null);
                const applyGroup = (patch: Partial<GroupProfile>) => { updateGroup(activeGroup.id, patch); setActiveGroup({ ...activeGroup, ...patch }); };
                const changeSound = (s: WhiteboxSound | null) => {
                    if (isBound) {
                        applyGroup({ chromeCustomCss: upsertWhiteboxSound(activeGroup.chromeCustomCss || '', s), chatSound: undefined });
                    } else {
                        applyGroup({ chatSound: s || undefined });
                    }
                };
                const changeBound = (b: boolean) => {
                    if (b) {
                        applyGroup({ chromeCustomCss: upsertWhiteboxSound(activeGroup.chromeCustomCss || '', curSound), chatSound: undefined, chatSoundBound: true });
                    } else {
                        applyGroup({ chromeCustomCss: stripWhiteboxSoundDirective(activeGroup.chromeCustomCss || ''), chatSound: curSound || undefined, chatSoundBound: false });
                    }
                };
                return (
                    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/5" onClick={() => setModalType('none')}>
                        <div
                            className="w-full max-h-[68vh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-5 shadow-[0_-12px_40px_rgba(15,23,42,0.18)] backdrop-blur-xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                            style={{ paddingBottom: 'calc(1.25rem + var(--safe-bottom))' }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="mb-3 flex items-start justify-between">
                                <div>
                                    <div className="text-sm font-bold text-slate-800">提示音 · {activeGroup.name}</div>
                                    <div className="mt-0.5 text-[10px] text-slate-400">成員新發的消息成為最新一條時響一次。默認獨立於白框，可選綁定一起分享。</div>
                                </div>
                                <button onClick={() => setModalType('none')} className="px-2 text-xl leading-none text-slate-400 hover:text-slate-600">{'×'}</button>
                            </div>
                            <WhiteboxSoundEditor
                                sound={curSound}
                                bound={isBound}
                                onChangeSound={changeSound}
                                onChangeBound={changeBound}
                                hint={<>🔔 只在 <b>成員新發的消息成為最新一條</b> 時響一次。這裡是<b>本群專屬</b>；不設則用「外觀 → 聊天界面」裡的全局默認提示音。</>}
                            />
                        </div>
                    </div>
                );
            })()}

            {/* 群聊記憶規則 */}
            <Modal isOpen={modalType === 'help'} title="群聊記憶規則" onClose={() => setModalType('none')}>
                <div className="space-y-4 text-sm text-slate-600 leading-relaxed">
                    <div className="rounded-2xl bg-violet-50 border border-violet-100 p-4 text-violet-800">
                        群聊內容不是排隊延遲發送。角色在私聊中“隔天提起”，通常是最近群聊、話題盒或個人群聊記憶被當作本輪話題選中了。
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">最近群聊</div>
                        <p>角色生成私聊回覆時，會看到自己參與群聊中的最近一段消息。記錄同時帶具體日期和“約 N 天前”，避免把舊消息誤認成剛剛發生。</p>
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">公共話題盒</div>
                        <p>群聊積累到一定數量後，較舊內容會被壓縮成群成員共享的話題盒，並進入各成員的私聊背景。因此舊話題可能在之後再次被提起。</p>
                    </div>
                    <div>
                        <div className="font-bold text-slate-800 mb-1">個人群聊記憶</div>
                        <p>啟用群聊記憶宮殿後，較舊群聊會以第三人稱分別整理進參與角色的記憶宮殿。它不會要求角色立刻回覆，只提供後續回憶依據。</p>
                    </div>
                    <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4 text-xs text-slate-500">
                        模型看到一段記錄，不代表必須馬上回應；是否主動提起仍會受當前話題和角色性格影響。
                    </div>
                </div>
            </Modal>

            {/* HTML 模式自定義提示詞 Modal（瓦片右鍵/長按進入） */}
            <Modal
                isOpen={modalType === 'html-prompt'} title="HTML 模式 · 自定義提示詞" onClose={() => setModalType('none')}
                footer={<button onClick={() => { if (activeGroup) { updateGroup(activeGroup.id, { htmlModeCustomPrompt: tempHtmlPrompt }); setActiveGroup({ ...activeGroup, htmlModeCustomPrompt: tempHtmlPrompt }); } setModalType('none'); addToast('已保存', 'success'); }} className="w-full py-3 bg-fuchsia-500 text-white font-bold rounded-2xl shadow-lg shadow-fuchsia-200">保存</button>}
            >
                <div className="space-y-3">
                    <p className="text-[10px] text-slate-400 leading-relaxed">追加在內置 HTML 提示詞之後（不覆蓋）。可以寫卡片風格偏好、常用配色、想要的卡片類型等。</p>
                    <textarea
                        value={tempHtmlPrompt}
                        onChange={e => setTempHtmlPrompt(e.target.value)}
                        placeholder="例如：卡片統一用暖色系、圓角 16px；多用進度條和標籤組……"
                        className="w-full h-36 bg-slate-100 rounded-2xl p-4 resize-none focus:ring-1 focus:ring-fuchsia-300 transition-all text-sm leading-relaxed"
                    />
                </div>
            </Modal>

        </div>
    );
};

export default GroupChat;
