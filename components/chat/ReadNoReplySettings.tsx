import React from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import { Row, Toggle } from './ChatSettingsControls';
import { DEFAULT_AUTO_REPLY } from '../../utils/readNoReply';
import type { QuietHoursSlot, ReadNoReplySettings } from '../../types';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

const newSlot = (): QuietHoursSlot => ({
    id: `quiet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    days: [1, 2, 3, 4, 5],
    start: '09:00',
    end: '12:00',
});

const inputClass = 'w-full rounded-xl bg-slate-50 border border-slate-100 px-3.5 py-2.5 text-sm text-slate-700 placeholder:text-slate-300 outline-none focus:border-primary/30 focus:bg-white';

/**
 * 聊天設定頁 Scenario 裡的「已讀不回」：總開關打開後展開細項（參考 CsyPhone 的設定樣子，不求一致）。
 * 只改草稿，存檔跟著聊天設定頁的「完成」。判斷邏輯見 utils/readNoReply.ts。
 */
const ReadNoReplySettingsPanel: React.FC<{
    value: ReadNoReplySettings;
    onChange: (next: ReadNoReplySettings) => void;
}> = ({ value, onChange }) => {
    const set = (patch: Partial<ReadNoReplySettings>) => onChange({ ...value, ...patch });
    const slots = value.quietSlots || [];
    const setSlot = (id: string, patch: Partial<QuietHoursSlot>) =>
        set({ quietSlots: slots.map(s => (s.id === id ? { ...s, ...patch } : s)) });
    const toggleDay = (slot: QuietHoursSlot, day: number) =>
        setSlot(slot.id, { days: slot.days.includes(day) ? slot.days.filter(d => d !== day) : [...slot.days, day].sort() });

    return (
        <>
            <Row label="已讀不回" hint="開啟後，角色日程在忙（開會、上課…）或在睡覺，或當前時間落在下方設定的不回訊時段，角色會強制已讀不回（自動回覆＋旁白）">
                <Toggle on={value.enabled} onToggle={() => set({ enabled: !value.enabled })} label="已讀不回" />
            </Row>

            {value.enabled && <>
                <Row label="由角色決定是否已讀不回" hint="開啟後日程忙碌／睡覺時不再強制，由角色依劇情決定：例如正在吵架就會繼續回，平常閒聊才可能已讀不回。自己設定的不回訊時段仍會強制">
                    <Toggle on={!!value.charDecides} onToggle={() => set({ charDecides: !value.charDecides })} label="由角色決定是否已讀不回" />
                </Row>

                <Row label="AI 生成自動回覆" hint="開啟後角色依劇情、地點、情境自己寫簡短的自動回覆（如「[會議中] 稍後回」），不再用下方的固定文字；生成失敗時才退回固定文字">
                    <Toggle on={!!value.aiGenerated} onToggle={() => set({ aiGenerated: !value.aiGenerated })} label="AI 生成自動回覆" />
                </Row>

                <div className={`px-5 py-4 space-y-3 transition-opacity ${value.aiGenerated ? 'opacity-60' : ''}`}>
                    <div className="text-[11px] font-bold text-slate-400">角色忙碌時的自動回覆文字</div>
                    {([
                        ['busyText', '忙碌狀態回覆', DEFAULT_AUTO_REPLY.busy],
                        ['sleepText', '休眠狀態回覆', DEFAULT_AUTO_REPLY.sleep],
                        ['normalText', '普通狀態回覆', DEFAULT_AUTO_REPLY.normal],
                    ] as const).map(([key, label, placeholder]) => (
                        <label key={key} className="block">
                            <span className="block text-[13px] font-bold text-slate-700 mb-1.5">{label}</span>
                            <input
                                value={value[key] || ''}
                                onChange={e => set({ [key]: e.target.value })}
                                placeholder={placeholder}
                                maxLength={40}
                                className={inputClass}
                            />
                        </label>
                    ))}
                    <p className="text-[10px] leading-relaxed text-slate-400">
                        忙碌、休眠依角色當天的日程判定；普通狀態用於你自己設的不回訊時段。某格留空時會退回「普通狀態」文字，普通也留空則用內建預設。
                    </p>
                </div>

                <div className="px-5 py-4 space-y-3">
                    <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="text-[15px] font-bold text-slate-800">不回訊時段</div>
                            <div className="mt-0.5 text-[11px] leading-relaxed text-slate-400">在這些時段內，角色強制已讀不回（會疊加日程一起判定）。結束早於開始表示跨夜。</div>
                        </div>
                        <button
                            type="button"
                            onClick={() => set({ quietSlots: [...slots, newSlot()] })}
                            className="shrink-0 flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 active:scale-95"
                        >
                            <Plus size={13} weight="bold" /> 新增時段
                        </button>
                    </div>
                    {slots.map(slot => (
                        <div key={slot.id} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3 space-y-3">
                            <div className="flex justify-between gap-1">
                                {WEEKDAYS.map((label, day) => {
                                    const on = slot.days.includes(day);
                                    return (
                                        <button
                                            key={day}
                                            type="button"
                                            aria-pressed={on}
                                            onClick={() => toggleDay(slot, day)}
                                            className={`w-9 h-9 rounded-xl text-sm font-bold transition-colors ${on ? 'bg-primary text-white' : 'bg-white border border-slate-200 text-slate-500'}`}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="flex items-center gap-2">
                                <input type="time" value={slot.start} onChange={e => setSlot(slot.id, { start: e.target.value })} aria-label="開始時間" className={`${inputClass} text-center`} />
                                <span className="text-slate-400">～</span>
                                <input type="time" value={slot.end} onChange={e => setSlot(slot.id, { end: e.target.value })} aria-label="結束時間" className={`${inputClass} text-center`} />
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    value={slot.title || ''}
                                    onChange={e => setSlot(slot.id, { title: e.target.value })}
                                    placeholder="標題（選填，例如：午休、會議時）"
                                    maxLength={20}
                                    className={inputClass}
                                />
                                <button
                                    type="button"
                                    onClick={() => set({ quietSlots: slots.filter(s => s.id !== slot.id) })}
                                    className="shrink-0 flex items-center gap-1 rounded-xl border border-rose-200 bg-white px-3 py-2.5 text-xs font-bold text-rose-500 active:scale-95"
                                    aria-label="刪除這個時段"
                                >
                                    <Trash size={13} /> 刪除
                                </button>
                            </div>
                            {slot.days.length === 0 && <p className="text-[10px] text-amber-600">還沒勾星期幾，這個時段不會生效。</p>}
                        </div>
                    ))}
                </div>
            </>}
        </>
    );
};

export default ReadNoReplySettingsPanel;
