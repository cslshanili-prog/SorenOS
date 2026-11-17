import React, { useEffect, useState } from 'react';
import type { CharacterProfile, DateStoryTime } from '../../types';
import { clockFromTime, formatStoryClock } from '../../utils/dateStoryTime';
import { resolveCharTimeZone } from '../../utils/timezone';
import { resolveCharCalendar } from '../../utils/worldCalendar';
import TimeModeFields, { DEFAULT_TIME_MODE } from '../common/TimeModeFields';

/**
 * 聊天設定的「時間」（plans/time-system.md 第 2b 節）：這條私聊線現在幾點。
 * 真實＝跟著現實（之後第 3 批接世界的曆法和時區）；自定義＝從填的時間起，流動或靜止。
 * 草稿由 ChatSettingsPage 管、按「完成」才存（起算點那時才定）；沒設就是真實＋流動。
 */
const ChatTimeSettings: React.FC<{
    char: CharacterProfile;
    value: DateStoryTime | undefined;
    onChange: (next: DateStoryTime | undefined) => void;
}> = ({ char, value, onChange }) => {
    const tz = resolveCharTimeZone(char);
    const timeline = resolveCharCalendar(char);
    const current = value || DEFAULT_TIME_MODE;
    const isDefault = current.source === 'real' && current.flow === 'flowing';
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(t); }, []);
    // 預覽：還沒存的草稿沒有起算點，就當現在起算；存過的照存的
    const preview = isDefault ? null : clockFromTime(current, tz, Date.now(), undefined, timeline);

    return (
        <section>
            <h2 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">時間 (TIME)</h2>
            <div className="bg-white rounded-[1.75rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] px-4 py-4 space-y-3">
                <p className="text-[11px] text-slate-400 leading-relaxed">這條聊天裡現在幾點。自定義的時間是{char.name}那邊的時間；見面沒另外設就跟著這裡。角色要完全沒時間概念，去神經鏈接把「時間感知」調成「不知道」。</p>
                <TimeModeFields value={current} onChange={next => onChange(next.source === 'real' && next.flow === 'flowing' ? undefined : next)} tz={tz} timeline={timeline} />
                <p className="text-[10px] text-slate-400 leading-relaxed" data-chat-clock>
                    {isDefault && '跟著現實時間走（原本的樣子）。'}
                    {current.source === 'real' && current.flow === 'frozen' && '停在按「完成」的那一刻；記錄不再標時間。'}
                    {current.source === 'custom' && current.flow === 'flowing' && '從填的時間起，跟著現實往前走，記錄上的時間也換算過去：'}
                    {current.source === 'custom' && current.flow === 'frozen' && '停在填的時間；記錄不再標時間：'}
                    {preview && current.source === 'custom' && <span className="font-bold text-slate-500"> 現在是 {formatStoryClock(preview, tz, timeline)}</span>}
                </p>
                <p className="text-[10px] text-slate-400 leading-relaxed">雲端那兩條路（主動消息、即時對話）照現實報時，不看這裡。</p>
            </div>
        </section>
    );
};

export default ChatTimeSettings;
