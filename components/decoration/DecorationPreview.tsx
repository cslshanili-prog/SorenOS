import React, { useEffect, useMemo, useRef } from 'react';
import { GearSix } from '@phosphor-icons/react';
import type { CharacterProfile, ChatTheme, Message, OSTheme } from '../../types';
import ChatHeader from '../chat/ChatHeaderShell';
import MessageItem from '../chat/MessageItem';
import ChatInputArea from '../chat/ChatInputArea';
import { PRESET_THEMES } from '../chat/ChatConstants';
import { resolveDecorationTheme } from '../../utils/chatDecoration';
import { buildChatFineTuneCss, mergeChatFineTune } from '../../utils/chatFineTuneCss';
import { resolveChatTheme } from '../../utils/groupChat/theme';
import { chatRootLook } from '../../utils/chatRootLook';
import { useBlobRefUrl } from '../../utils/blobRef';

/**
 * 裝扮 App 的預覽（plans/decoration-app.md 第 4 節）：用聊天真正的頂欄、訊息、輸入欄元件配假訊息，
 * 照聊天畫面同一套規則合併（resolveDecorationTheme → mergeChatFineTune → 白框 CSS → 氣泡 CSS）。
 * simTheme／simChar 是「套用之後會長怎樣」的那份（編輯器把草稿先寫到副本上再丟進來）。
 * 外層 transform 讓 CSS 裡的 position: fixed 關在預覽框裡。
 */
interface Props {
    simTheme: OSTheme;
    simChar: CharacterProfile;
    customThemes: ChatTheme[];
    userAvatar?: string;
    className?: string;
}

const noop = () => {};
const at = (minutesAgo: number) => Date.now() - minutesAgo * 60_000;

const DecorationPreview: React.FC<Props> = ({ simTheme, simChar, customThemes, userAvatar = '', className = '' }) => {
    const osTheme = useMemo(() => resolveDecorationTheme(simTheme, simChar), [simTheme, simChar]);
    const fineCss = useMemo(() => buildChatFineTuneCss(mergeChatFineTune(osTheme, simChar.chatFineTune)), [osTheme, simChar.chatFineTune]);
    const moduleAlign = mergeChatFineTune(osTheme, simChar.chatFineTune).chatModuleAlign || 'center';
    const bubble = useMemo(() => resolveChatTheme(simChar.bubbleStyle || osTheme.chatDefaultBubbleStyle || 'default', customThemes, PRESET_THEMES), [simChar.bubbleStyle, osTheme.chatDefaultBubbleStyle, customThemes]);
    const background = useBlobRefUrl(simChar.chatBackground ?? osTheme.chatBackground);
    const { className: rootClass, style: rootStyle } = chatRootLook(osTheme, background);
    // 預覽只看不點：整塊 inert，輸入框也聚焦不到（鍵盤不會因為誤觸彈出來）
    const boxRef = useRef<HTMLDivElement>(null);
    useEffect(() => { boxRef.current?.setAttribute('inert', ''); }, []);
    const messages: Message[] = useMemo(() => [
        { id: -1, charId: simChar.id, role: 'assistant', type: 'text', content: '今天也有好好吃飯嗎？', timestamp: at(9) },
        { id: -2, charId: simChar.id, role: 'user', type: 'text', content: '有啊～晚點一起看電影？', timestamp: at(5) },
        { id: -3, charId: simChar.id, role: 'assistant', type: 'text', content: '好，等你。', timestamp: at(1) },
    ], [simChar.id]);

    return (
        <div ref={boxRef} aria-hidden className={`relative overflow-hidden ${className}`} style={{ transform: 'translateZ(0)' }} data-decoration-preview>
            <div className={`sully-chat-root ${rootClass}`} style={{ ...rootStyle, height: '100%', ['--safe-top' as string]: '0px', ['--safe-bottom' as string]: '0px' }}>
                {fineCss && <style>{fineCss}</style>}
                {simChar.chatAppearance?.chatEmojiSize && simChar.chatFineTune?.enabled !== false && <style>{`.sully-chat-root { --sully-emoji-size: ${{ small: 96, medium: 128, large: 160 }[osTheme.chatEmojiSize || 'small']}px; }`}</style>}
                {osTheme.chatChromeCustomCss && <style>{osTheme.chatChromeCustomCss}</style>}
                {simChar.chromeCustomCss && <style>{simChar.chromeCustomCss}</style>}
                {bubble.customCss && <style>{bubble.customCss}</style>}
                <style>{'.sully-bubble-tail-hidden::before,.sully-bubble-tail-hidden::after{content:none !important;display:none !important;}'}</style>
                <ChatHeader
                    selectionMode={false} selectedCount={0} onCancelSelection={noop}
                    activeCharacter={{ ...simChar, activeBuffs: [] }}
                    isTyping={false} isSummarizing={false} lastTokenUsage={null}
                    onClose={noop} onTriggerAI={noop} onShowCharsPanel={noop}
                    headerStyle={osTheme.chatHeaderStyle} avatarShape={osTheme.chatAvatarShape}
                    headerAlign={osTheme.chatHeaderAlign} headerDensity={osTheme.chatHeaderDensity}
                    statusStyle={osTheme.chatStatusStyle} chromeStyle={osTheme.chatChromeStyle}
                    hideBuffs={osTheme.chatHideHeaderBuffs}
                    extraAction={{ label: '聊天設置', icon: <GearSix className="w-5 h-5" weight="bold" />, onClick: noop }}
                />
                <div className="flex-1 overflow-y-auto overflow-x-hidden pt-6 pb-6 no-scrollbar pointer-events-none">
                    {messages.map((m, i) => {
                        const prev = messages[i - 1];
                        const next = messages[i + 1];
                        return (
                            <MessageItem
                                key={m.id}
                                msg={m}
                                isFirstInGroup={!prev || prev.role !== m.role}
                                isLastInGroup={!next || next.role !== m.role}
                                activeTheme={bubble}
                                charAvatar={simChar.avatar}
                                charName={simChar.name}
                                userAvatar={userAvatar}
                                onLongPress={noop}
                                onReply={noop}
                                selectionMode={false}
                                isSelected={false}
                                onToggleSelect={noop}
                                moduleAlign={moduleAlign}
                                avatarShape={osTheme.chatAvatarShape}
                                avatarSize={osTheme.chatAvatarSize}
                                avatarMode={osTheme.chatAvatarMode}
                                bubbleVariant={osTheme.chatBubbleStyle}
                                messageSpacing={osTheme.chatMessageSpacing}
                                showTimestamp={osTheme.chatShowTimestamp}
                                suppressEntranceAnimation
                            />
                        );
                    })}
                </div>
                <div className="pointer-events-none">
                    <ChatInputArea
                        input="" setInput={noop} isTyping={false} selectionMode={false}
                        showPanel="none" setShowPanel={noop} onSend={noop}
                        onDeleteSelected={noop} selectedCount={0} emojis={[]}
                        onPanelAction={noop} onImageSelect={noop} isSummarizing={false}
                        onReroll={noop} canReroll={false}
                        inputStyle={osTheme.chatInputStyle}
                        sendButtonStyle={osTheme.chatSendButtonStyle}
                        chromeStyle={osTheme.chatChromeStyle}
                    />
                </div>
            </div>
        </div>
    );
};

export default DecorationPreview;
