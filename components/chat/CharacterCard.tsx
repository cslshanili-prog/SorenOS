/**
 * 角色名片（plans/character-card.md）：私聊、群聊點角色頭像跳出來的置中小卡（不是半窗）。
 * 兩頁：「現在」看心聲、此刻在做什麼、還沒褪掉的情緒；「今天」看今天的日程。
 * 底下幾顆按鈕跳去我們現有的全螢幕頁（角色設定、聊天設定／去私聊、行事曆、記憶宮殿），
 * 那些 App 按返回會回到原本的聊天（utils/appLaunch.ts）。
 *
 * 掛到 body：聊天的白框 CSS 不會蓋到它（跟 #207 同一個理由）。樣式鉤子都是 sully-char-card-* 開頭。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Brain, CalendarBlank, ChatCircleDots, GearSix, Infinity as InfinityIcon, UserCircle, X } from '@phosphor-icons/react';
import { AppID, type CharacterProfile, type DailySchedule } from '../../types';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import { charSubtitle } from '../../utils/charIdentity';
import { getLastInnerState, INNER_STATE_CACHED_EVENT } from '../../utils/emotionApply';
import { buffRemaining, liveBuffs } from '../../utils/emotionDecay';
import { isScheduleFeatureOn } from '../../utils/scheduleGenerator';
import { getDailyScheduleForChar } from '../../utils/dailySchedule';
import { getCurrentScheduleSlotIndex } from '../../utils/scheduleTime';
import { resolveCharTimeZone, tzShortLabel } from '../../utils/timezone';
import { sectionOf } from '../../utils/worldSections';
import { characterLaunch } from '../../utils/characterLaunch';
import { appReturn, bondLaunch, calendarLaunch, memoryPalaceLaunch } from '../../utils/appLaunch';
import { bondIdForChar } from '../../utils/bond/model';
import { trackEvent } from '../../utils/analytics';

type Tab = 'now' | 'today';

export interface CharacterCardProps {
    char: CharacterProfile;
    /** 從哪裡打開的：私聊有「聊天設定」，群聊換成「去私聊」 */
    from: 'private' | 'group';
    onClose: () => void;
    /** 私聊：打開這個聊天的聊天設定 */
    onChatSettings?: () => void;
    /** 群聊：跳去跟他的私聊 */
    onPrivateChat?: () => void;
    /** 跳去別的 App 之後按返回要回來這裡（私聊／群聊各自知道怎麼回來） */
    returnHere: () => void;
}

const fmtClock = (timeZone?: string) => {
    try {
        return new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) });
    } catch {
        return new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
};

const CharacterCard: React.FC<CharacterCardProps> = ({ char, from, onClose, onChatSettings, onPrivateChat, returnHere }) => {
    const { characterGroups, openApp, setActiveCharacterId } = useOS();
    const [tab, setTab] = useState<Tab>('now');
    const [now, setNow] = useState(() => Date.now());
    const [thought, setThought] = useState(() => getLastInnerState(char.id));
    const [schedule, setSchedule] = useState<DailySchedule | null>(null);
    const [openBuff, setOpenBuff] = useState<string | null>(null);

    useEffect(() => { trackEvent('打开角色名片', { from }); }, [from]);
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // 心聲：開著卡的時候有新的就換（本機評估、雲端回程兩條路都聽）
    useEffect(() => {
        setThought(getLastInnerState(char.id));
        const receive = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.charId === char.id && typeof detail.innerState === 'string' && detail.innerState.trim()) setThought(detail.innerState.trim());
        };
        window.addEventListener(INNER_STATE_CACHED_EVENT, receive);
        window.addEventListener('emotion-innerstate-updated', receive);
        return () => {
            window.removeEventListener(INNER_STATE_CACHED_EVENT, receive);
            window.removeEventListener('emotion-innerstate-updated', receive);
        };
    }, [char.id]);

    const scheduleOn = isScheduleFeatureOn(char);
    useEffect(() => {
        let alive = true;
        if (!scheduleOn) { setSchedule(null); return; }
        getDailyScheduleForChar(char).then(s => { if (alive) setSchedule(s); }).catch(() => {});
        return () => { alive = false; };
    }, [char.id, scheduleOn, char.customTimezoneEnabled, char.customTimezone]);

    const slots = scheduleOn && schedule?.charId === char.id ? schedule.slots || [] : [];
    const current = slots.length ? getCurrentScheduleSlotIndex(slots, char, new Date(now)) : -1;
    const currentSlot = current >= 0 ? slots[current] : undefined;
    const timeZone = resolveCharTimeZone(char);
    const buffs = liveBuffs(char.activeBuffs, now);
    const emotionOn = !!char.emotionConfig?.enabled;
    const shownThought = thought || currentSlot?.innerThought || '';

    const world = characterGroups.find(w => w.id === char.groupId);
    const section = sectionOf(char, characterGroups);
    const subtitle = charSubtitle(char);

    // ── 跳去別的 App：登記返回，再開 ──
    const goApp = (app: AppID, prepare: () => void) => {
        setActiveCharacterId(char.id);
        prepare();
        appReturn.set(app, returnHere);
        onClose();
        openApp(app);
    };
    const openCharacter = () => goApp(AppID.Character, () => characterLaunch.request({ charId: char.id, backToCaller: true }));
    const openCalendar = () => goApp(AppID.Calendar, () => calendarLaunch.request({ tab: 'theirs' }));
    const openPalace = () => goApp(AppID.MemoryPalace, () => memoryPalaceLaunch.request({ charId: char.id }));
    // 羈絆：私聊點開的是這條線的空間（char 是線的視圖），群聊是主線那張卡（plans/bond-batch1.md 3.1）
    const openBond = () => goApp(AppID.Bond, () => bondLaunch.request({ bondId: bondIdForChar(char) }));

    const actions = useMemo(() => {
        const list: Array<{ key: string; label: string; icon: React.ReactNode; onClick: () => void }> = [
            { key: 'character', label: '角色設定', icon: <UserCircle size={18} />, onClick: openCharacter },
        ];
        if (from === 'private' && onChatSettings) list.push({ key: 'chat-settings', label: '聊天設定', icon: <GearSix size={18} />, onClick: () => { onClose(); onChatSettings(); } });
        if (from === 'group' && onPrivateChat) list.push({ key: 'private', label: '去私聊', icon: <ChatCircleDots size={18} />, onClick: () => { onClose(); onPrivateChat(); } });
        list.push({ key: 'calendar', label: '行事曆', icon: <CalendarBlank size={18} />, onClick: openCalendar });
        list.push({ key: 'palace', label: '記憶宮殿', icon: <Brain size={18} />, onClick: openPalace });
        if (!char.altOf) list.push({ key: 'bond', label: '羈絆', icon: <InfinityIcon size={18} />, onClick: openBond });
        return list;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, onChatSettings, onPrivateChat, char.id]);

    const card = (
        <div className="sully-char-card-backdrop fixed inset-0 z-[130] flex items-center justify-center bg-slate-900/45 backdrop-blur-[2px] p-4 animate-fade-in"
            onClick={onClose} data-char-card={char.name}>
            <div role="dialog" aria-modal="true" aria-label={`${char.name}的角色名片`} onClick={e => e.stopPropagation()}
                className="sully-char-card relative flex w-full max-w-[360px] flex-col overflow-hidden rounded-[28px] bg-white shadow-2xl"
                style={{ maxHeight: 'min(80dvh, 640px)' }}>
                {/* 頭：頭像、名字、身份、世界與分組 */}
                <div className="sully-char-card-head relative shrink-0 bg-gradient-to-b from-violet-50 via-rose-50/60 to-white px-5 pt-6 pb-3 text-center">
                    <button type="button" onClick={onClose} aria-label="關閉角色名片"
                        className="absolute right-3 top-3 rounded-full p-1.5 text-slate-400 hover:bg-black/5"><X size={18} /></button>
                    <TokenImg value={char.avatar} alt="" className="sully-char-card-avatar mx-auto h-20 w-20 rounded-full object-cover ring-4 ring-white shadow-md bg-slate-100" />
                    <h2 className="mt-2.5 text-[17px] font-bold text-slate-800">{char.name}</h2>
                    {subtitle && <p className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-slate-500">{subtitle}</p>}
                    {(world || char.castRole === 'supporting') && (
                        <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                            {world && <span className="rounded-full bg-white/80 border border-slate-200/70 px-2 py-0.5 text-[10px] font-bold text-slate-500">{world.name}{section ? ` · ${section.name}` : ''}</span>}
                            {char.castRole === 'supporting' && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">配角</span>}
                        </div>
                    )}
                    <div className="mt-3 inline-flex rounded-full bg-slate-100 p-0.5" role="tablist">
                        {([['now', '現在'], ['today', '今天']] as const).map(([id, label]) => (
                            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                                className={`rounded-full px-4 py-1 text-[12px] font-bold transition-colors ${tab === id ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'}`}>{label}</button>
                        ))}
                    </div>
                </div>

                <div className="sully-char-card-body min-h-0 flex-1 overflow-y-auto no-scrollbar px-5 pb-4 pt-2 space-y-3">
                    {tab === 'now' ? <>
                        {/* 心聲 */}
                        <section className="sully-char-card-thought rounded-2xl bg-violet-50/70 border border-violet-100 px-4 py-3" aria-label="心聲">
                            <div className="text-[10px] font-bold tracking-widest text-violet-400">心聲</div>
                            {shownThought
                                ? <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-slate-700">「{shownThought}」</p>
                                : <p className="mt-1 text-[12px] leading-relaxed text-slate-400">{emotionOn
                                    ? `還沒有心聲。聊幾句之後，${char.name}每回一次話都會留下一句。`
                                    : '情緒評估沒開，所以沒有心聲。到聊天設定的「日程／情緒」打開就會有。'}</p>}
                        </section>

                        {/* 此刻 */}
                        <section className="sully-char-card-now flex items-start gap-3 rounded-2xl bg-slate-50 px-4 py-3" aria-label="此刻">
                            <div className="shrink-0 text-center">
                                <div className="text-[15px] font-bold tabular-nums text-slate-700">{fmtClock(timeZone)}</div>
                                {timeZone && <div className="text-[9px] text-slate-400">{tzShortLabel(timeZone)}</div>}
                            </div>
                            <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-slate-600">
                                {currentSlot
                                    ? <>
                                        <div className="font-bold text-slate-700">{currentSlot.emoji ? `${currentSlot.emoji} ` : ''}{currentSlot.activity}</div>
                                        {currentSlot.location && <div className="text-[11px] text-slate-400">{currentSlot.location}</div>}
                                    </>
                                    : <span className="text-slate-400">{scheduleOn ? `今天的日程還沒排，不知道${char.name}在忙什麼。` : `日程沒開，不知道${char.name}在忙什麼。`}</span>}
                            </div>
                        </section>

                        {/* 情緒（只列還沒褪掉的，條是此刻還剩多少） */}
                        {buffs.length > 0 && (
                            <section className="sully-char-card-emotions space-y-1.5" aria-label="現在的情緒">
                                <div className="px-1 text-[10px] font-bold tracking-widest text-slate-400">情緒</div>
                                {buffs.map(b => {
                                    const left = buffRemaining(b, now);
                                    const open = openBuff === b.id;
                                    return (
                                        <button key={b.id} type="button" onClick={() => setOpenBuff(open ? null : b.id)} aria-expanded={open}
                                            className="w-full rounded-2xl border border-slate-100 bg-white px-3 py-2 text-left">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[15px]" aria-hidden="true">{b.emoji || '✦'}</span>
                                                <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold text-slate-700">{b.label || b.name}</span>
                                                <span className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-slate-100" aria-label={`還剩 ${Math.round(left * 100)}%`}>
                                                    <span className="block h-full rounded-full" style={{ width: `${Math.max(6, left * 100)}%`, background: b.color || '#a78bfa' }} />
                                                </span>
                                            </div>
                                            {open && b.description && <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{b.description}</p>}
                                        </button>
                                    );
                                })}
                            </section>
                        )}
                        {char.buffInjection?.trim() && (
                            <p className="sully-char-card-mood px-1 text-[11.5px] leading-relaxed text-slate-500"><span className="font-bold text-slate-400">整體心情　</span>{char.buffInjection.trim()}</p>
                        )}
                    </> : (
                        <section className="sully-char-card-schedule" aria-label="今天的日程">
                            {timeZone && <div className="mb-2 px-1 text-[10px] text-slate-400">{tzShortLabel(timeZone)}時間</div>}
                            {slots.length > 0 ? (
                                <ol className="space-y-1.5">
                                    {slots.map((slot, i) => (
                                        <li key={`${slot.startTime}-${i}`} aria-current={i === current ? 'time' : undefined}
                                            className={`flex gap-3 rounded-2xl px-3 py-2 ${i === current ? 'bg-violet-50 ring-1 ring-violet-200' : i < current ? 'opacity-60' : ''}`}>
                                            <time className="w-11 shrink-0 pt-0.5 text-[11px] font-bold tabular-nums text-slate-400">{slot.startTime}</time>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-[12.5px] font-bold text-slate-700">{slot.emoji ? `${slot.emoji} ` : ''}{slot.activity}{i === current && <span className="ml-1.5 text-[10px] text-violet-500">現在</span>}</div>
                                                {slot.location && <div className="text-[11px] text-slate-400">{slot.location}</div>}
                                                {slot.description && <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{slot.description}</div>}
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                            ) : (
                                <p className="py-6 text-center text-[12px] text-slate-400">{scheduleOn ? '今天的日程還沒排，到行事曆可以排。' : '這個角色沒開日程。'}</p>
                            )}
                        </section>
                    )}
                </div>

                {/* 跳去全螢幕頁 */}
                <div className="sully-char-card-actions grid shrink-0 gap-1 border-t border-slate-100 bg-slate-50/60 px-3 py-2.5" style={{ gridTemplateColumns: `repeat(${actions.length}, minmax(0, 1fr))` }}>
                    {actions.map(a => (
                        <button key={a.key} type="button" onClick={a.onClick} data-char-card-action={a.key}
                            className="flex flex-col items-center gap-1 rounded-xl py-1.5 text-slate-500 active:bg-slate-100">
                            {a.icon}<span className="text-[10.5px] font-bold">{a.label}</span>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
    return typeof document === 'undefined' ? card : createPortal(card, document.body);
};

export default CharacterCard;
