import React from 'react';
import type {OSTheme,ChatFineTuneFields} from '../../types';
import ChatFineTunePanel from './ChatFineTunePanel';
const FINE_TUNE_DEFAULTS: Required<ChatFineTuneFields> = {
    chatAvatarVisibility: 'both',
    chatAvatarPlacement: 'beside',
    chatAvatarAlign: 'bottom',
    chatAvatarOffsetY: 0,
    chatBubbleFontSize: 0,
    chatBubbleLineHeight: 0,
    chatBubbleIndent: 0,
    chatSnapToEdge: false,
    chatModuleAlign: 'center',
};

const presets: Array<{ name: string; desc: string; config: Partial<OSTheme> }> = [
    {
        name: '默認聊天',
        desc: '柔和通用的聊天殼',
        config: {
            chatChromeStyle: 'soft',
            chatBackgroundStyle: 'plain',
            chatHeaderStyle: 'default',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'default',
            chatStatusStyle: 'subtle',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'modern',
            chatMessageSpacing: 'default',
            chatInputStyle: 'rounded',
            chatSendButtonStyle: 'circle',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'WeChat',
        desc: '平整克制的熟悉感',
        config: {
            chatChromeStyle: 'flat',
            chatBackgroundStyle: 'paper',
            chatHeaderStyle: 'wechat',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'dot',
            chatAvatarShape: 'square',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'wechat',
            chatMessageSpacing: 'default',
            chatInputStyle: 'wechat',
            chatSendButtonStyle: 'pill',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'Telegram',
        desc: '輕盈通透的玻璃感',
        config: {
            chatChromeStyle: 'floating',
            chatBackgroundStyle: 'mesh',
            chatHeaderStyle: 'telegram',
            chatHeaderAlign: 'center',
            chatHeaderDensity: 'default',
            chatStatusStyle: 'pill',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'flat',
            chatMessageSpacing: 'spacious',
            chatInputStyle: 'telegram',
            chatSendButtonStyle: 'circle',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'Discord',
        desc: '頻道感更強的界面',
        config: {
            chatChromeStyle: 'floating',
            chatBackgroundStyle: 'grid',
            chatHeaderStyle: 'discord',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'default',
            chatStatusStyle: 'pill',
            chatAvatarShape: 'rounded',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'shadow',
            chatMessageSpacing: 'compact',
            chatInputStyle: 'discord',
            chatSendButtonStyle: 'minimal',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: 'iMessage',
        desc: '更圓潤、更輕的氣質',
        config: {
            chatChromeStyle: 'soft',
            chatBackgroundStyle: 'mesh',
            chatHeaderStyle: 'minimal',
            chatHeaderAlign: 'center',
            chatHeaderDensity: 'airy',
            chatStatusStyle: 'subtle',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'large',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'ios',
            chatMessageSpacing: 'spacious',
            chatInputStyle: 'ios',
            chatSendButtonStyle: 'circle',
            chatShowTimestamp: 'always',
        },
    },
    {
        name: '沉浸劇場',
        desc: '無頭像+貼邊+松行距',
        config: {
            chatChromeStyle: 'flat',
            chatBackgroundStyle: 'plain',
            chatHeaderStyle: 'minimal',
            chatHeaderAlign: 'center',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'subtle',
            chatAvatarShape: 'circle',
            chatAvatarSize: 'medium',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'flat',
            chatMessageSpacing: 'spacious',
            chatInputStyle: 'flat',
            chatSendButtonStyle: 'minimal',
            chatShowTimestamp: 'never',
            chatAvatarVisibility: 'hide_both',
            chatSnapToEdge: true,
            chatBubbleLineHeight: 1.5,
        },
    },
    {
        name: '緊湊密聊',
        desc: '小字緊排+頂對齊頭像',
        config: {
            chatChromeStyle: 'flat',
            chatBackgroundStyle: 'plain',
            chatHeaderStyle: 'default',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'dot',
            chatAvatarShape: 'rounded',
            chatAvatarSize: 'small',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'flat',
            chatMessageSpacing: 'compact',
            chatInputStyle: 'flat',
            chatSendButtonStyle: 'minimal',
            chatShowTimestamp: 'never',
            chatAvatarVisibility: 'both',
            chatAvatarAlign: 'top',
            chatBubbleFontSize: 13,
            chatBubbleLineHeight: 1.35,
        },
    },
    {
        name: '像素終端',
        desc: '偽窗口風格的聊天殼',
        config: {
            chatChromeStyle: 'pixel',
            chatBackgroundStyle: 'grid',
            chatHeaderStyle: 'pixel',
            chatHeaderAlign: 'left',
            chatHeaderDensity: 'compact',
            chatStatusStyle: 'pill',
            chatAvatarShape: 'square',
            chatAvatarSize: 'small',
            chatAvatarMode: 'grouped',
            chatBubbleStyle: 'outline',
            chatMessageSpacing: 'compact',
            chatInputStyle: 'pixel',
            chatSendButtonStyle: 'pill',
            chatShowTimestamp: 'always',
        },
    },
];

const defaults = {
    chatAvatarShape: 'circle',
    chatAvatarSize: 'medium',
    chatAvatarMode: 'grouped',
    chatAvatarPlacement: 'beside',
    chatBubbleStyle: 'modern',
    chatMessageSpacing: 'default',
    chatShowTimestamp: 'always',
    chatHeaderStyle: 'default',
    chatInputStyle: 'default',
    chatChromeStyle: 'soft',
    chatBackgroundStyle: 'plain',
    chatHeaderAlign: 'left',
    chatHeaderDensity: 'default',
    chatStatusStyle: 'subtle',
    chatSendButtonStyle: 'circle',
} as const;

const choices = {
    chrome: [
        { value: 'soft', label: '柔霧', desc: '輕薄玻璃感' },
        { value: 'flat', label: '平面', desc: '更乾淨利落' },
        { value: 'floating', label: '懸浮', desc: '層次更明顯' },
        { value: 'pixel', label: '像素', desc: '硬邊偽窗口' },
    ],
    background: [
        { value: 'plain', label: '純淨' },
        { value: 'grid', label: '網格' },
        { value: 'paper', label: '紙面' },
        { value: 'mesh', label: '氛圍' },
    ],
    header: [
        { value: 'default', label: '默認' },
        { value: 'minimal', label: '極簡' },
        { value: 'gradient', label: '漸變' },
        { value: 'wechat', label: '微信感' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'discord', label: 'Discord' },
        { value: 'pixel', label: '像素窗' },
    ],
    bubble: [
        { value: 'modern', label: '現代' },
        { value: 'flat', label: '扁平' },
        { value: 'outline', label: '描邊' },
        { value: 'shadow', label: '立體' },
        { value: 'wechat', label: '微信感' },
        { value: 'ios', label: 'iOS' },
    ],
    input: [
        { value: 'default', label: '默認' },
        { value: 'rounded', label: '圓潤' },
        { value: 'flat', label: '扁平' },
        { value: 'wechat', label: '微信感' },
        { value: 'ios', label: 'iOS' },
        { value: 'telegram', label: 'Telegram' },
        { value: 'discord', label: 'Discord' },
        { value: 'pixel', label: '像素窗' },
    ],
    align: [
        { value: 'left', label: '左對齊' },
        { value: 'center', label: '居中' },
    ],
    density: [
        { value: 'compact', label: '緊湊' },
        { value: 'default', label: '默認' },
        { value: 'airy', label: '舒展' },
    ],
    status: [
        { value: 'subtle', label: '弱提示' },
        { value: 'pill', label: '狀態膠囊' },
        { value: 'dot', label: '圓點在線' },
    ],
    send: [
        { value: 'circle', label: '圓按鈕' },
        { value: 'pill', label: '膠囊按鈕' },
        { value: 'minimal', label: '極簡圖標' },
    ],
    avatarShape: [
        { value: 'circle', label: '圓形' },
        { value: 'rounded', label: '圓角' },
        { value: 'square', label: '方形' },
    ],
    avatarSize: [
        { value: 'small', label: '小' },
        { value: 'medium', label: '中' },
        { value: 'large', label: '大' },
    ],
    avatarMode: [
        { value: 'grouped', label: '連續共用', desc: '一串消息只露一次頭像' },
        { value: 'every_message', label: '每條都顯示', desc: '每條消息都帶頭像' },
    ],
    spacing: [
        { value: 'compact', label: '緊湊' },
        { value: 'default', label: '默認' },
        { value: 'spacious', label: '寬鬆' },
    ],
    timestamp: [
        { value: 'always', label: '始終顯示' },
        { value: 'hover', label: '懸停（電腦）' },
        { value: 'never', label: '不顯示' },
    ],
    emojiSize: [
        { value: 'small', label: '小', desc: '96px' },
        { value: 'medium', label: '中', desc: '128px' },
        { value: 'large', label: '大', desc: '160px · 舊版' },
    ],
} as const;

const cardButton = (active: boolean) =>
    `rounded-2xl border px-3 py-2 text-left transition-all active:scale-[0.98] ${
        active ? 'border-primary/40 bg-primary/10 text-primary shadow-sm' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
    }`;

const ChoiceGroup: React.FC<{
    title: string;
    items: ReadonlyArray<{ value: string; label: string; desc?: string }>;
    value: string;
    onPick: (value: string) => void;
}> = ({ title, items, value, onPick }) => (
    <div>
        <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</div>
        <div className="flex flex-wrap gap-2">
            {items.map((item) => (
                <button key={item.value} onClick={() => onPick(item.value)} className={cardButton(value === item.value)}>
                    <div className="text-[11px] font-bold">{item.label}</div>
                    {item.desc && <div className="mt-0.5 text-[9px] opacity-70">{item.desc}</div>}
                </button>
            ))}
        </div>
    </div>
);


export default function ChatLayoutSettings({theme,updateTheme}:{theme:OSTheme;updateTheme:(patch:Partial<OSTheme>)=>void}){
    const avatarShape = theme.chatAvatarShape || defaults.chatAvatarShape;
    const avatarSize = theme.chatAvatarSize || defaults.chatAvatarSize;
    const avatarMode = theme.chatAvatarMode || defaults.chatAvatarMode;
    const avatarPlacement = theme.chatAvatarPlacement || defaults.chatAvatarPlacement;
    const bubbleStyle = theme.chatBubbleStyle || defaults.chatBubbleStyle;
    const messageSpacing = theme.chatMessageSpacing || defaults.chatMessageSpacing;
    const showTimestamp = theme.chatShowTimestamp || defaults.chatShowTimestamp;
    const headerStyle = theme.chatHeaderStyle || defaults.chatHeaderStyle;
    const inputStyle = theme.chatInputStyle || defaults.chatInputStyle;
    const chromeStyle = theme.chatChromeStyle || defaults.chatChromeStyle;
    const backgroundStyle = theme.chatBackgroundStyle || defaults.chatBackgroundStyle;
    const headerAlign = theme.chatHeaderAlign || defaults.chatHeaderAlign;
    const headerDensity = theme.chatHeaderDensity || defaults.chatHeaderDensity;
    const statusStyle = theme.chatStatusStyle || defaults.chatStatusStyle;
    const sendButtonStyle = theme.chatSendButtonStyle || defaults.chatSendButtonStyle;
    const showHeaderBuffs = theme.chatHideHeaderBuffs !== true;

return <div><details className="chat-decoration-layout-group"><summary>內置佈局</summary><div>
                    <p className="mb-3 text-[10px] text-slate-400">一鍵換整套聊天殼（含頭像、氣泡、間距與細節微調），切預設會先清掉微調殘留。</p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {presets.map((preset) => (
                            <button
                                key={preset.name}
                                onClick={() => updateTheme({ ...FINE_TUNE_DEFAULTS, ...preset.config })}
                                className="rounded-2xl border border-slate-200 bg-slate-50 p-3 text-left transition-all hover:border-primary/30 hover:bg-white active:scale-[0.98]"
                            >
                                <div className="text-xs font-bold text-slate-700">{preset.name}</div>
                                <div className="mt-1 text-[10px] text-slate-400">{preset.desc}</div>
                            </button>
                        ))}
                    </div>
                </div></details>
<details className="chat-decoration-layout-group"><summary>界面風格</summary><div>
                    <ChoiceGroup title="聊天殼" items={choices.chrome} value={chromeStyle} onPick={(value) => updateTheme({ chatChromeStyle: value as OSTheme['chatChromeStyle'] })} />
                    <div className="mt-4">
                        <ChoiceGroup title="消息區背景" items={choices.background} value={backgroundStyle} onPick={(value) => updateTheme({ chatBackgroundStyle: value as OSTheme['chatBackgroundStyle'] })} />
                    </div>
                </div></details>
<details className="chat-decoration-layout-group"><summary>頭部與在線狀態</summary><div>
                <ChoiceGroup title="頭部風格" items={choices.header} value={headerStyle} onPick={(value) => updateTheme({ chatHeaderStyle: value as OSTheme['chatHeaderStyle'] })} />
                <div className="mt-4">
                    <ChoiceGroup title="頭部對齊" items={choices.align} value={headerAlign} onPick={(value) => updateTheme({ chatHeaderAlign: value as OSTheme['chatHeaderAlign'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="頭部密度" items={choices.density} value={headerDensity} onPick={(value) => updateTheme({ chatHeaderDensity: value as OSTheme['chatHeaderDensity'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="在線狀態樣式" items={choices.status} value={statusStyle} onPick={(value) => updateTheme({ chatStatusStyle: value as OSTheme['chatStatusStyle'] })} />
                </div>
                <div className="mt-4 flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2.5">
                    <div className="min-w-0 pr-3">
                        <div className="text-[11px] font-bold text-slate-700">顯示情緒欄</div>
                        <div className="mt-0.5 text-[10px] text-slate-400">角色名下方的情緒 buff 膠囊；關掉後頂欄更乾淨（位置/樣式也可在「進階」裡用 .sully-chat-buffs 調）。</div>
                    </div>
                    <button
                        onClick={() => updateTheme({ chatHideHeaderBuffs: showHeaderBuffs })}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${showHeaderBuffs ? 'bg-primary' : 'bg-slate-300'}`}
                        aria-pressed={showHeaderBuffs}
                    >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${showHeaderBuffs ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                </div>
                </div></details>
<details className="chat-decoration-layout-group"><summary>氣泡與頭像</summary><div>
                <ChoiceGroup title="消息氣泡" items={choices.bubble} value={bubbleStyle} onPick={(value) => updateTheme({ chatBubbleStyle: value as OSTheme['chatBubbleStyle'] })} />
                <div className="mt-4">
                    <ChoiceGroup title="頭像形狀" items={choices.avatarShape} value={avatarShape} onPick={(value) => updateTheme({ chatAvatarShape: value as OSTheme['chatAvatarShape'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="頭像尺寸" items={choices.avatarSize} value={avatarSize} onPick={(value) => updateTheme({ chatAvatarSize: value as OSTheme['chatAvatarSize'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="頭像出現頻率" items={choices.avatarMode} value={avatarMode} onPick={(value) => updateTheme({ chatAvatarMode: value as OSTheme['chatAvatarMode'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="消息密度" items={choices.spacing} value={messageSpacing} onPick={(value) => updateTheme({ chatMessageSpacing: value as OSTheme['chatMessageSpacing'] })} />
                </div>
                <div className="mt-4">
                    <ChoiceGroup title="時間戳" items={choices.timestamp} value={showTimestamp} onPick={(value) => updateTheme({ chatShowTimestamp: value as OSTheme['chatShowTimestamp'] })} />
                </div>
                </div></details>
<details className="chat-decoration-layout-group" open><summary>細節微調</summary><div><ChatFineTunePanel value={theme} onChange={updateTheme}/><button className="chat-decoration-link" onClick={()=>updateTheme({...FINE_TUNE_DEFAULTS})}>微調恢復默認</button></div></details>
<details className="chat-decoration-layout-group"><summary>表情包與輸入欄</summary><div>
                    <ChoiceGroup title="表情包大小" items={choices.emojiSize} value={theme.chatEmojiSize || 'small'} onPick={(value) => updateTheme({ chatEmojiSize: value as OSTheme['chatEmojiSize'] })} />
                    <p className="mt-2 text-[10px] text-slate-400">調整當前範圍內的表情包圖片尺寸；全局默認也會用於群聊。用自定義 CSS 調過尺寸的美化會繼續覆蓋這裡的設置。</p>
                    <div className="mt-4">
                        <ChoiceGroup title="輸入欄風格" items={choices.input} value={inputStyle} onPick={(value) => updateTheme({ chatInputStyle: value as OSTheme['chatInputStyle'] })} />
                    </div>
                    <div className="mt-4">
                        <ChoiceGroup title="發送按鈕" items={choices.send} value={sendButtonStyle} onPick={(value) => updateTheme({ chatSendButtonStyle: value as OSTheme['chatSendButtonStyle'] })} />
                    </div>
                </div></details></div>;
}
