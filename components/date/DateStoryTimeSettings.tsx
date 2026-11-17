import React, { useEffect, useState } from 'react';
import type { CharacterProfile, DateStory, DateStoryTime } from '../../types';
import { patchDateStory } from '../../utils/dateStory';
import { formatStoryClock, makeDateClock, storyTimeIsOwn } from '../../utils/dateStoryTime';
import { resolveCharTimeZone } from '../../utils/timezone';
import TimeModeFields, { DEFAULT_TIME_MODE } from '../common/TimeModeFields';

// 見面設定的「時間」：真實／自定義／關閉 × 流動／靜止（utils/dateStoryTime.ts；欄位本身在 components/common/TimeModeFields.tsx）。
// 進行中的故事改這場的，從改的那一刻起算；沒有就是下一場的，開新故事時從故事開始那一刻起算。
// 「關閉」取代了角色卡上舊的「線下時間感知」開關：舊資料還是 false 的，這裡顯示成關閉；改過一次來源就清掉舊開關。
// 見面沒另外設就跟著私聊的時鐘（plans/time-system.md 第 6 節）；在這裡改過就不跟了，「改回跟著私聊」能清掉。

interface Props {
    char: CharacterProfile;
    story: DateStory | null;
    updateCharacter: (id: string, patch: Partial<CharacterProfile>) => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }>;
}

const DateStoryTimeSettings: React.FC<Props> = ({ char, story, updateCharacter, addToast, Section }) => {
    const tz = resolveCharTimeZone(char);
    const legacyOff = char.dateTimeAwarenessEnabled === false;
    const own = storyTimeIsOwn(char, story);
    const followingChat = !own && !legacyOff && !!char.chatTime && char.chatTime.source !== 'off';
    const saved: DateStoryTime = (story ? story.time : char.dateNextStoryTime)
        || (legacyOff ? { source: 'off', flow: 'flowing' } : followingChat ? { ...char.chatTime!, anchorAt: undefined } : DEFAULT_TIME_MODE);
    const off = saved.source === 'off';
    // 預覽每 30 秒走一次
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(t); }, []);

    const save = (next: DateStoryTime) => {
        const value: DateStoryTime | undefined = next.source === 'real' && next.flow === 'flowing' ? undefined : next;
        if (story) void patchDateStory(story.id, { time: value ? { ...value, anchorAt: Date.now() } : undefined });
        else updateCharacter(char.id, { dateNextStoryTime: value });
        // 舊的線下時間感知開關：改過一次來源就不再看它
        if (legacyOff) updateCharacter(char.id, { dateTimeAwarenessEnabled: undefined });
    };
    const onChange = (next: DateStoryTime) => {
        // 跟著私聊時按了跟現在一樣的值也算「自己設了」：寫一份進去，之後不再跟
        if (next.source === saved.source && next.flow === saved.flow && next.customStart === saved.customStart && !followingChat && !legacyOff) return;
        save(next);
    };
    const backToChat = () => {
        if (story) void patchDateStory(story.id, { time: undefined });
        else updateCharacter(char.id, { dateNextStoryTime: undefined });
    };

    const previewChar = { ...char, dateTimeAwarenessEnabled: undefined, chatTime: undefined };
    const preview = (off ? null : makeDateClock(previewChar, story ? { ...story, time: saved.source === 'real' && saved.flow === 'flowing' ? undefined : saved } : { id: 'preview', charId: char.id, status: 'ongoing', createdAt: 0, updatedAt: 0, time: saved.source === 'real' && saved.flow === 'flowing' ? undefined : saved }))
        ?? { now: Date.now() };

    return (
        <Section title="時間 (Time)">
            <p className="text-[11px] text-slate-400 mt-1 mb-3 leading-relaxed">{story ? '這場故事' : '下一場故事'}裡是幾點。自定義的時間是{char.name}那邊的時間。{story ? '完結後開新的故事也沿用這個設定，改了才變。' : ''}</p>
            <div className="space-y-3">
                {followingChat && (
                    <p className="text-[10px] text-slate-400 leading-relaxed">沒另外設，跟著私聊的時間走；在這裡改了就不跟。</p>
                )}
                <TimeModeFields value={saved} onChange={onChange} tz={tz} allowOff onCustomCommitted={() => addToast('故事時間已更新', 'success')} />
                {!off && (
                    <p className="text-[10px] text-slate-400 leading-relaxed" data-story-clock>
                        {saved.source === 'real' && saved.flow === 'flowing' && '跟著現實時間走（原本的樣子）。'}
                        {saved.source === 'real' && saved.flow === 'frozen' && (story ? '停在切換的那一刻：' : '停在故事開始那一刻。')}
                        {saved.source === 'custom' && saved.flow === 'flowing' && (story ? '從填的時間起，跟著現實往前走：' : '故事開始時從填的時間起，跟著現實往前走。')}
                        {saved.source === 'custom' && saved.flow === 'frozen' && '停在填的時間：'}
                        {(story || saved.source === 'custom') && !(saved.source === 'real' && saved.flow === 'flowing') && (
                            <span className="font-bold text-slate-500"> 故事裡現在是 {formatStoryClock(preview, tz)}</span>
                        )}
                    </p>
                )}
                {own && !!char.chatTime && (
                    <button type="button" onClick={backToChat} className="text-[11px] font-bold text-slate-500 underline underline-offset-2">改回跟著私聊的時間</button>
                )}
            </div>
        </Section>
    );
};

export default DateStoryTimeSettings;
