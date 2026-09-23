import React, { useEffect, useState } from 'react';
import { CaretLeft, CalendarBlank } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import { Row, Toggle } from './ChatSettingsControls';
import ReadNoReplySettingsPanel from './ReadNoReplySettings';
import { DB } from '../../utils/db';
import { getLocalDateKey } from '../../utils/localDate';
import { nowInTimeZone, resolveCharTimeZone } from '../../utils/timezone';
import { acquaintanceDays, RELATIONSHIP_MAX_LENGTH } from '../../utils/chatRelationship';
import type { CharacterProfile, ReadNoReplySettings } from '../../types';

/** 「完成」時一起存的欄位：Relationship 一排與 Scenario。 */
export type ChatSettingsPatch = Pick<CharacterProfile,
    'chatNickname' | 'userNickname' | 'userViewRelationship' | 'charViewRelationship'
    | 'allowCharChangeRelationship' | 'acquaintanceStartDate' | 'readNoReply'>;

interface Props {
    isOpen: boolean;
    char: CharacterProfile;
    /** 這個私聊裡生效的「你」（分角色身份／頭像已經套好）。 */
    chatUser: { name: string; avatar: string };
    onClose: () => void;
    /** 「完成」：把 Relationship、Scenario 的改動連同下方其它設定一起存。 */
    onSave: (patch: ChatSettingsPatch) => void;
    /** 下方原有的設定分組（AI 模型、輸入與發送、上下文與記憶……）。 */
    children: React.ReactNode;
}

const TextValue: React.FC<{ value: string; placeholder: string; onChange: (v: string) => void; label: string }> = ({ value, placeholder, onChange, label }) => (
    <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={RELATIONSHIP_MAX_LENGTH}
        aria-label={label}
        className="w-[45%] min-w-0 bg-transparent text-right text-[15px] text-slate-700 placeholder:text-slate-300 outline-none focus:text-slate-900"
    />
);

const clean = (v: string) => v.trim() || undefined;

/** 存檔前整理：空字串拿掉；從沒打開過的角色不寫這個欄位。 */
const cleanReadNoReply = (v: ReadNoReplySettings): ReadNoReplySettings | undefined => {
    const quietSlots = (v.quietSlots || []).map(s => ({ ...s, title: clean(s.title || '') }));
    const next: ReadNoReplySettings = {
        enabled: v.enabled,
        charDecides: v.charDecides || undefined,
        aiGenerated: v.aiGenerated || undefined,
        busyText: clean(v.busyText || ''),
        sleepText: clean(v.sleepText || ''),
        normalText: clean(v.normalText || ''),
        quietSlots: quietSlots.length ? quietSlots : undefined,
    };
    const touched = next.enabled || next.charDecides || next.aiGenerated || next.busyText || next.sleepText || next.normalText || next.quietSlots;
    return touched ? next : undefined;
};

/**
 * 全螢幕聊天設定（取代原本的「聊天設置」彈窗）。
 *
 * 上半部是這一版新加的：兩人頭像、「我們已相識 N 天」、Relationship 一排（暱稱、稱呼、雙方認為的
 * 關係、允許角色自主改關係）。這些先記在本頁草稿裡，按「完成」才連同下方原有設定一起存；
 * 按返回則全部放棄，跟原本彈窗的「關掉不存」一致。
 * Scenario（已讀不回、延遲自動回覆、主動通話……）照路線圖分批加在這一排下面。
 */
const ChatSettingsPage: React.FC<Props> = ({ isOpen, char, chatUser, onClose, onSave, children }) => {
    const [nickname, setNickname] = useState('');
    const [userNickname, setUserNickname] = useState('');
    const [userView, setUserView] = useState('');
    const [charView, setCharView] = useState('');
    const [allowChange, setAllowChange] = useState(false);
    const [startDate, setStartDate] = useState('');
    const [firstMessageKey, setFirstMessageKey] = useState<string | null>(null);
    const [editingDate, setEditingDate] = useState(false);
    const [readNoReply, setReadNoReply] = useState<ReadNoReplySettings>({ enabled: false });

    // 每次打開都從角色目前的值重新載入草稿（角色可能剛自己改過關係）
    useEffect(() => {
        if (!isOpen) return;
        setNickname(char.chatNickname || '');
        setUserNickname(char.userNickname || '');
        setUserView(char.userViewRelationship || '');
        setCharView(char.charViewRelationship || '');
        setAllowChange(!!char.allowCharChangeRelationship);
        setStartDate(char.acquaintanceStartDate || '');
        setEditingDate(false);
        setReadNoReply(char.readNoReply ? { ...char.readNoReply } : { enabled: false });
        let cancelled = false;
        DB.getFirstMessageTimestamp(char.id)
            .then(ts => { if (!cancelled) setFirstMessageKey(ts ? getLocalDateKey(new Date(ts)) : null); })
            .catch(() => { if (!cancelled) setFirstMessageKey(null); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, char.id]);

    if (!isOpen) return null;

    const todayKey = getLocalDateKey(nowInTimeZone(resolveCharTimeZone(char)));
    const effectiveStart = startDate || firstMessageKey || undefined;
    const days = acquaintanceDays(effectiveStart, todayKey);

    const handleDone = () => {
        onSave({
            chatNickname: clean(nickname),
            userNickname: clean(userNickname),
            userViewRelationship: clean(userView),
            charViewRelationship: clean(charView),
            allowCharChangeRelationship: allowChange || undefined,
            acquaintanceStartDate: startDate || undefined,
            readNoReply: cleanReadNoReply(readNoReply),
        });
    };

    return (
        <div className="fixed inset-0 z-[100] flex flex-col bg-slate-50 animate-fade-in" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="shrink-0 bg-white/85 backdrop-blur-md border-b border-slate-100" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="relative flex items-center justify-between px-3 py-3">
                    <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="返回，不儲存">
                        <CaretLeft size={22} className="text-slate-700" />
                    </button>
                    <h1 className="absolute left-1/2 -translate-x-1/2 text-base font-bold text-slate-800">聊天設定</h1>
                    <button onClick={handleDone} className="px-3 py-1.5 text-[15px] font-bold text-primary active:opacity-60">完成</button>
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto" style={{ paddingBottom: 'calc(2rem + var(--safe-bottom))' }}>
                {/* 兩人頭像 + 相識天數 */}
                <div className="flex flex-col items-center pt-8 pb-6">
                    <div className="relative flex items-center justify-center h-32 w-72">
                        <div
                            aria-hidden="true"
                            className="absolute left-2 right-2 top-1/2 h-12 -translate-y-1/4 rounded-[50%] border-2 border-amber-300/70"
                            style={{ borderTopColor: 'transparent', boxShadow: '0 6px 14px -8px rgba(245,158,11,0.55)' }}
                        />
                        <TokenImg value={char.avatar} className="relative w-28 h-28 rounded-full object-cover bg-slate-100 ring-4 ring-white shadow-lg -mr-5" alt="" />
                        <TokenImg value={chatUser.avatar} className="relative w-28 h-28 rounded-full object-cover bg-slate-100 ring-4 ring-white shadow-lg -ml-5" alt="" />
                    </div>
                    <div className="mt-3 grid grid-cols-2 w-72 text-center">
                        <span className="text-lg font-bold text-slate-800 truncate px-2">{nickname.trim() || char.name}</span>
                        <span className="text-lg font-bold text-slate-800 truncate px-2">{chatUser.name}</span>
                    </div>
                    <button
                        onClick={() => setEditingDate(v => !v)}
                        className="mt-3 flex items-center gap-1.5 rounded-full bg-white border border-amber-100 px-4 py-1.5 text-xs font-bold text-amber-700 shadow-sm active:scale-95 transition-transform"
                    >
                        <CalendarBlank size={14} />
                        {days !== null ? `我們已相識 ${days} 天` : '設定你們認識的那一天'}
                    </button>
                    {editingDate && (
                        <div className="mt-3 w-72 rounded-2xl bg-white border border-slate-100 p-3 shadow-sm space-y-2">
                            <label className="block text-[11px] font-bold text-slate-400">自定義起始日期</label>
                            <input
                                type="date"
                                value={startDate || firstMessageKey || ''}
                                max={todayKey}
                                onChange={e => setStartDate(e.target.value)}
                                className="w-full rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 text-sm text-slate-700 outline-none"
                            />
                            <p className="text-[10px] leading-relaxed text-slate-400">
                                {startDate
                                    ? '設了之後角色也會知道你們認識多久了。'
                                    : firstMessageKey
                                        ? `目前從第一則訊息那天（${firstMessageKey}）算起；自己設一個日期，角色也會知道你們認識多久了。`
                                        : '還沒有聊天記錄；設一個日期，角色也會知道你們認識多久了。'}
                            </p>
                            {startDate && (
                                <button onClick={() => setStartDate('')} className="text-[11px] font-bold text-slate-500 underline underline-offset-2">
                                    改回從第一則訊息算
                                </button>
                            )}
                        </div>
                    )}
                </div>

                <div className="px-4 space-y-4">
                    {/* Relationship */}
                    <section>
                        <h2 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">關係 (RELATIONSHIP)</h2>
                        <div className="bg-white rounded-[1.75rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] divide-y divide-slate-100">
                            <Row label="暱稱" hint="你給 TA 取的名字，聊天頂部會顯示這個">
                                <TextValue value={nickname} placeholder={char.name} onChange={setNickname} label="暱稱" />
                            </Row>
                            <Row label="你的暱稱" hint="角色會這樣稱呼你">
                                <TextValue value={userNickname} placeholder={chatUser.name} onChange={setUserNickname} label="你的暱稱" />
                            </Row>
                            <Row label="你認為的關係" hint="角色看得到">
                                <TextValue value={userView} placeholder="未設定" onChange={setUserView} label="你認為的關係" />
                            </Row>
                            <Row label="角色認為的關係">
                                <TextValue value={charView} placeholder="未設定" onChange={setCharView} label="角色認為的關係" />
                            </Row>
                            <Row label="允許角色自主更改關係" hint="開啟後，角色可在聊天過程中根據劇情自行更改「角色認為的關係」">
                                <Toggle on={allowChange} onToggle={() => setAllowChange(v => !v)} label="允許角色自主更改關係" />
                            </Row>
                        </div>
                    </section>

                    {/* Scenario：這一批先上「已讀不回」，其餘開關分批加 */}
                    <section>
                        <h2 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">場景與玩法 (SCENARIO)</h2>
                        <div className="bg-white rounded-[1.75rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] divide-y divide-slate-100">
                            <ReadNoReplySettingsPanel value={readNoReply} onChange={setReadNoReply} />
                        </div>
                    </section>

                    {/* 原有的設定分組 */}
                    <section>
                        <h2 className="px-2 pb-2 text-[11px] font-bold tracking-widest text-slate-400">更多設定</h2>
                        <div className="space-y-3">{children}</div>
                    </section>
                </div>
            </div>
        </div>
    );
};

export default ChatSettingsPage;
