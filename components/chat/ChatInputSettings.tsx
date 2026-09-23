import React, { useState } from 'react';
import { Question } from '@phosphor-icons/react';
import type { ChatInputPreferences } from '../../utils/chatInputPreferences';

interface ChatInputSettingsProps {
    value: ChatInputPreferences;
    onChange: (value: ChatInputPreferences) => void;
    scope?: 'private' | 'group';
}

const ChatInputSettings: React.FC<ChatInputSettingsProps> = ({ value, onChange, scope = 'private' }) => {
    const [openHelp, setOpenHelp] = useState<keyof ChatInputPreferences | null>(null);
    return (
        <div className="space-y-1">
            <p className="mb-2 text-[10px] text-slate-400">以下輸入習慣對當前設備的私聊和群聊生效</p>
            {([
                {
                    key: 'sendButtonGenerates',
                    label: '發送按鈕代替生成按鈕',
                    help: '開啟後，不用夠右上角的閃電了。輸入框裡有光標時，右下角發文字；點一下聊天空白處，右下角就變成閃電，讓對方回覆已發送的消息。只收起鍵盤可能還留著光標，點一下空白處就好。沒發出的草稿會保留。',
                },
                {
                    key: 'enterToSend',
                    label: '回車發送文字',
                    help: '勾選時，按回車發送文字，Shift + 回車換行；不勾選時，回車只換行，點發送按鈕發出文字。輸入法選字時按回車不會誤發。',
                },
                {
                    key: 'autoReply',
                    label: '發完後自動生成回覆',
                    help: '發過文字、圖片或表情後，等輸入框沒有草稿和光標、加號等底部面板全部收起，再等 2 秒讓對方回覆。繼續輸入、打開面板或發送新消息，就重新等待。倒計時可以取消。' + (scope === 'group' ? '群聊沿用本群的導演或輪詢模式；退出群聊會取消等待。' : ''),
                },
                {
                    key: 'emojiSuggestions',
                    label: '表情包智能匹配',
                    help: '輸入“抱”就會聯想名稱裡有“抱”的表情包，點擊候選即可發送。私聊匹配當前角色可見的所有分類，群聊匹配群聊表情庫的所有分類，文字草稿會保留。兩者共用開關，默認關閉。',
                },
            ] as const).map(({ key, label, help }) => (
                <div key={key}>
                    <div className="flex items-center gap-1">
                        <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 text-xs font-bold text-slate-600">
                            <span>{label}</span>
                            <input
                                type="checkbox"
                                checked={value[key]}
                                onChange={event => onChange({ ...value, [key]: event.target.checked })}
                                className="h-5 w-5 shrink-0 cursor-pointer accent-primary"
                            />
                        </label>
                        <button
                            type="button"
                            aria-label={`${label}說明`}
                            aria-expanded={openHelp === key}
                            aria-controls={`chat-input-help-${key}`}
                            onClick={() => setOpenHelp(openHelp === key ? null : key)}
                            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-slate-100 ${openHelp === key ? 'text-primary' : 'text-slate-400'}`}
                        >
                            <Question size={18} weight="bold" />
                        </button>
                    </div>
                    <p id={`chat-input-help-${key}`} hidden={openHelp !== key} className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">{help}</p>
                </div>
            ))}
        </div>
    );
};

export default ChatInputSettings;
