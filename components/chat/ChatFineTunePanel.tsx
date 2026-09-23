import React from 'react';
import { ChatFineTuneFields } from '../../types';

/**
 * 聊天細節微調控件組（頭像顯隱/位置/貼邊/對齊/垂直微調、字號、行距、氣泡縮進等）。
 * 兩處複用，交互保持一致（擋位按鈕 + 滑桿）：
 *  - 外觀 App「聊天細節微調」區塊（全局，value = osTheme）
 *  - 聊天內「聊天裝扮」彈窗（角色覆蓋，value = 合併後的生效值，onChange 寫進 char.chatFineTune）
 * 只渲染控件本身，區塊外殼 / 開關 / 說明文案由調用方決定。
 */
type Props = {
    value: ChatFineTuneFields;
    onChange: (patch: Partial<ChatFineTuneFields>) => void;
};

const OptionButton: React.FC<{ active: boolean; label: string; desc?: string; onClick: () => void }> = ({ active, label, desc, onClick }) => (
    <button onClick={onClick}
        className={`px-3 py-2 text-[11px] font-bold rounded-xl border transition-all active:scale-95 ${active ? 'bg-primary/10 text-primary border-primary/30 ring-1 ring-primary/20' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'}`}>
        <div>{label}</div>
        {desc && <div className="text-[9px] font-normal mt-0.5 opacity-70">{desc}</div>}
    </button>
);

export const ChatFineTunePanel: React.FC<Props> = ({ value, onChange }) => {
    return (
        <div className="space-y-4">
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">頭像顯示</h3>
                <div className="flex gap-2 flex-wrap">
                    {([['both', '全部顯示'], ['hide_ai', '隱藏角色側'], ['hide_user', '隱藏我的'], ['hide_both', '全部隱藏']] as const).map(([v, label]) => (
                        <OptionButton key={v} active={(value.chatAvatarVisibility || 'both') === v} label={label} onClick={() => onChange({ chatAvatarVisibility: v })} />
                    ))}
                </div>
                {(value.chatAvatarVisibility || 'both') !== 'both' && (
                    <label className="flex items-center gap-2 mt-2 text-[11px] text-slate-500">
                        <input type="checkbox" checked={!!value.chatSnapToEdge} onChange={(e) => onChange({ chatSnapToEdge: e.target.checked })} className="accent-current" />
                        隱藏的一側氣泡貼邊（收回頭像空位）
                    </label>
                )}
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">頭像位置</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={(value.chatAvatarPlacement || 'beside') === 'beside'} label="氣泡旁（默認）" desc="跟隨頭像出現頻率" onClick={() => onChange({ chatAvatarPlacement: 'beside' })} />
                    <OptionButton active={value.chatAvatarPlacement === 'above_group'} label="每輪氣泡上方" desc="連續氣泡共用一次頭像" onClick={() => onChange({ chatAvatarPlacement: 'above_group' })} />
                </div>
            </div>
            {(value.chatAvatarPlacement || 'beside') === 'beside' && (
                <div>
                    <h3 className="text-[11px] font-bold text-slate-500 mb-2">頭像對齊氣泡</h3>
                    <div className="flex gap-2 flex-wrap">
                        {([['bottom', '底部（默認）'], ['top', '頂部'], ['center', '垂直居中']] as const).map(([v, label]) => (
                            <OptionButton key={v} active={(value.chatAvatarAlign || 'bottom') === v} label={label} onClick={() => onChange({ chatAvatarAlign: v })} />
                        ))}
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                        <span className="text-[11px] text-slate-500 shrink-0">垂直微調</span>
                        <input type="range" min={-16} max={16} step={2} value={value.chatAvatarOffsetY || 0}
                            onChange={(e) => onChange({ chatAvatarOffsetY: Number(e.target.value) })} className="flex-1 accent-current" />
                        <span className="text-[11px] font-mono text-slate-500 w-10 text-right">{value.chatAvatarOffsetY || 0}px</span>
                    </div>
                </div>
            )}
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">氣泡正文字號</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={!value.chatBubbleFontSize} label="默認" onClick={() => onChange({ chatBubbleFontSize: 0 })} />
                    {[12, 13, 14, 15, 16].map(v => (
                        <OptionButton key={v} active={value.chatBubbleFontSize === v} label={`${v}px`} onClick={() => onChange({ chatBubbleFontSize: v })} />
                    ))}
                </div>
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">氣泡正文行距</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={!value.chatBubbleLineHeight} label="默認" onClick={() => onChange({ chatBubbleLineHeight: 0 })} />
                    {[1.2, 1.35, 1.5, 1.7].map(v => (
                        <OptionButton key={v} active={value.chatBubbleLineHeight === v} label={String(v)} onClick={() => onChange({ chatBubbleLineHeight: v })} />
                    ))}
                </div>
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">氣泡與頭像間距</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={!value.chatBubbleIndent} label="默認 (48px)" onClick={() => onChange({ chatBubbleIndent: 0 })} />
                    {[28, 60, 72].map(v => (
                        <OptionButton key={v} active={value.chatBubbleIndent === v} label={`${v}px`} onClick={() => onChange({ chatBubbleIndent: v })} />
                    ))}
                </div>
            </div>
            <div>
                <h3 className="text-[11px] font-bold text-slate-500 mb-2">HTML / 心象 / 音樂卡片位置</h3>
                <div className="flex gap-2 flex-wrap">
                    <OptionButton active={(value.chatModuleAlign || 'center') === 'center'} label="水平居中（默認）" desc="卡片類內容居中顯示" onClick={() => onChange({ chatModuleAlign: 'center' })} />
                    <OptionButton active={value.chatModuleAlign === 'anchor'} label="貼氣泡列" desc="跟氣泡同側，舊版觀感" onClick={() => onChange({ chatModuleAlign: 'anchor' })} />
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">角色發的 HTML 卡片、心象（思考鏈）卡片和音樂（一起聽）卡片的橫向位置。預覽裡看不到卡片，進聊天看效果。</p>
            </div>
        </div>
    );
};

export default ChatFineTunePanel;
