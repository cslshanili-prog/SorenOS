import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowCounterClockwise, Bell, Broadcast, CaretLeft, CaretRight, ChatCircle, ChatCircleDots, Clock,
    Info, ThumbsUp, Timer, UsersThree,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import type { MomentsInteractionSettings } from '../../types';
import {
    DEFAULT_MOMENTS_SETTINGS, MOMENTS_SETTING_RANGES, normalizeMomentsSettings, setMomentsNumber,
    type MomentsNumericKey,
} from '../../utils/momentsSettings';

const PRIMARY = 'hsl(var(--primary-hue),var(--primary-sat),60%)';

const formatSeconds = (sec: number) => (sec >= 60 && sec % 60 === 0 ? `${sec / 60} 分鐘` : `${sec} 秒`);

interface SliderRowSpec {
    key: MomentsNumericKey;
    title: string;
    hint: string;
    icon: React.ReactNode;
    tint: string;
    format: (v: number) => string;
}

const SECTIONS: SliderRowSpec[][] = [
    [
        { key: 'minPostIntervalHours', title: '最短發帖間隔', hint: '兩次自動發帖之間至少等多久', icon: <Broadcast size={18} />, tint: 'bg-sky-50 text-sky-500', format: v => `${v} 小時` },
        { key: 'maxPostIntervalHours', title: '最長發帖間隔', hint: '自動發帖等待時間上限，實際在兩者之間隨機', icon: <Clock size={18} />, tint: 'bg-violet-50 text-violet-500', format: v => `${v} 小時` },
    ],
    [
        { key: 'firstCommentDelaySec', title: '首則留言延遲', hint: '發布後第一則留言的等待時間', icon: <ChatCircle size={18} />, tint: 'bg-emerald-50 text-emerald-500', format: formatSeconds },
        { key: 'commentIntervalSec', title: '後續留言間隔', hint: '連續留言之間的等待時間', icon: <ChatCircleDots size={18} />, tint: 'bg-emerald-50 text-emerald-500', format: formatSeconds },
    ],
    [
        { key: 'commentProbability', title: '角色留言機率', hint: '角色看到新動態後留言的機率；會花 API，調成 0% 就不自動留言', icon: <ChatCircle size={18} />, tint: 'bg-blue-50 text-blue-500', format: v => `${v}%` },
        { key: 'likeProbability', title: '角色按讚機率', hint: '角色看到新動態後按讚的機率；不花 API', icon: <ThumbsUp size={18} />, tint: 'bg-amber-50 text-amber-500', format: v => `${v}%` },
    ],
    [
        { key: 'npcCommentProbability', title: 'NPC 留言機率', hint: 'NPC 看到新動態後留言的機率；會花 API。NPC 通常比角色多，預設低一點免得洗版', icon: <ChatCircle size={18} />, tint: 'bg-rose-50 text-rose-500', format: v => `${v}%` },
        { key: 'npcLikeProbability', title: 'NPC 按讚機率', hint: 'NPC 看到新動態後按讚的機率；不花 API', icon: <ThumbsUp size={18} />, tint: 'bg-rose-50 text-rose-500', format: v => `${v}%` },
        { key: 'npcInteractionDelayMin', title: 'NPC 互動延遲', hint: 'NPC 對動態產生互動前的延遲', icon: <Timer size={18} />, tint: 'bg-rose-50 text-rose-500', format: v => `${v} 分鐘` },
        { key: 'replyToNpcDelaySec', title: '角色回覆 NPC 留言延遲', hint: '角色回覆 NPC 留言前的等待時間', icon: <Bell size={18} />, tint: 'bg-emerald-50 text-emerald-500', format: formatSeconds },
    ],
];

const Card: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="bg-white rounded-[1.5rem] border border-slate-100 shadow-[0_10px_30px_-18px_rgba(80,70,120,0.25)] divide-y divide-slate-50">
        {children}
    </div>
);

const Switch: React.FC<{ on: boolean; onToggle: () => void; label: string }> = ({ on, onToggle, label }) => (
    <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onToggle}
        className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${on ? '' : 'bg-slate-200'}`}
        style={on ? { background: PRIMARY } : undefined}
    >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
);

/**
 * 個人檔案 →「朋友圈互動」：用戶自己的朋友圈裡，誰會自動發帖、多久發一次、留言／按讚多頻繁。
 * 角色和 NPC 在同一份清單。設定存在 userProfile.momentsSettings（見 utils/momentsSettings.ts），
 * 由單一貼文池（路線圖第 6 項）的背景發文／互動讀取。
 *
 * 滑桿拖動只改本地草稿，離開頁面時才寫回——每次寫 userProfile 都會把所有開了主動消息 2.0 的角色打髒，
 * 拖一下寫一次太浪費。
 */
const MomentsInteractionSettingsPanel: React.FC<{ onBack: () => void }> = ({ onBack }) => {
    const { userProfileBase, updateUserProfile, characters, npcs, addToast } = useOS();
    const [draft, setDraft] = useState<MomentsInteractionSettings>(() => normalizeMomentsSettings(userProfileBase.momentsSettings));
    const [view, setView] = useState<'main' | 'posters'>('main');

    const saved = useMemo(() => normalizeMomentsSettings(userProfileBase.momentsSettings), [userProfileBase.momentsSettings]);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const savedRef = useRef(saved);
    savedRef.current = saved;

    const commit = () => {
        if (JSON.stringify(draftRef.current) !== JSON.stringify(savedRef.current)) {
            updateUserProfile({ momentsSettings: draftRef.current });
        }
    };

    // 不是按返回離開的（例如直接切到別的分頁／關掉 App），卸載時也要存
    useEffect(() => () => commit(), []); // eslint-disable-line react-hooks/exhaustive-deps

    const handleBack = () => {
        if (view === 'posters') { setView('main'); return; }
        commit();
        onBack();
    };

    const posters = useMemo(() => [
        ...characters.map(c => ({ id: c.id, name: c.name, avatar: c.avatar, isNpc: false })),
        ...npcs.map(n => ({ id: n.id, name: n.name, avatar: n.avatar, isNpc: true })),
    ], [characters, npcs]);
    const disabledCount = posters.filter(p => draft.disabledPosterIds.includes(p.id)).length;

    const togglePoster = (id: string) => setDraft(d => ({
        ...d,
        disabledPosterIds: d.disabledPosterIds.includes(id) ? d.disabledPosterIds.filter(x => x !== id) : [...d.disabledPosterIds, id],
    }));
    const setAllPosters = (enabled: boolean) => setDraft(d => ({ ...d, disabledPosterIds: enabled ? [] : posters.map(p => p.id) }));

    const restoreDefaults = () => {
        setDraft(d => ({ ...DEFAULT_MOMENTS_SETTINGS, autoPostEnabled: d.autoPostEnabled, disabledPosterIds: d.disabledPosterIds }));
        addToast('頻率已恢復預設（發帖角色清單不動）', 'success');
    };

    return (
        <div className="flex flex-col h-full min-h-0 bg-slate-50">
            <div className="flex items-center gap-2 px-4 py-3 shrink-0">
                <button onClick={handleBack} className="p-1.5 -ml-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="返回">
                    <CaretLeft size={20} className="text-slate-600" />
                </button>
                <h1 className="text-lg font-bold text-slate-800">{view === 'posters' ? '自動發帖角色' : '朋友圈互動'}</h1>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-8 space-y-4">
                {view === 'main' && <>
                    <div className="flex gap-2 rounded-2xl bg-sky-50 border border-sky-100 px-3.5 py-3 text-[11px] leading-relaxed text-sky-700">
                        <Info size={16} className="shrink-0 mt-px" />
                        <span>這是朋友圈（Dock 的朋友圈、Chat「動態」）的規則，App 開著的時候才會跑。「自動發帖」總開關只管角色和 NPC 會不會自己發文，預設是關的；有人發了新動態，看得到的角色和 NPC 會照下面的機率按讚、留言。按讚不花 API，留言會花（同一篇的一批留言只打一次），不想花就把角色和 NPC 的留言機率都調成 0%。</span>
                    </div>

                    <Card>
                        <div className="flex items-center gap-3 px-4 py-3.5">
                            <span className="w-10 h-10 rounded-full bg-sky-50 text-sky-500 flex items-center justify-center shrink-0"><Broadcast size={18} /></span>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-slate-700">自動發帖</div>
                                <div className="text-[11px] text-slate-400">角色和 NPC 在背景自己發朋友圈</div>
                            </div>
                            <Switch on={draft.autoPostEnabled} onToggle={() => setDraft(d => ({ ...d, autoPostEnabled: !d.autoPostEnabled }))} label="自動發帖" />
                        </div>
                        <button onClick={() => setView('posters')} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-slate-50">
                            <span className="w-10 h-10 rounded-full bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0"><UsersThree size={18} /></span>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-slate-700">誰可以發帖</div>
                                <div className="text-[11px] text-slate-400">
                                    {posters.length === 0 ? '還沒有角色或 NPC' : disabledCount === 0 ? `全部 ${posters.length} 位都可以發` : `已關閉 ${disabledCount} 位的自動發帖`}
                                </div>
                            </div>
                            <CaretRight size={16} className="text-slate-300 shrink-0" />
                        </button>
                    </Card>

                    {SECTIONS.map((rows, i) => (
                        <Card key={i}>
                            {rows.map(row => {
                                const range = MOMENTS_SETTING_RANGES[row.key];
                                const value = draft[row.key];
                                const dimmed = !draft.autoPostEnabled && (row.key === 'minPostIntervalHours' || row.key === 'maxPostIntervalHours');
                                return (
                                    <div key={row.key} className={`px-4 py-3.5 transition-opacity ${dimmed ? 'opacity-50' : ''}`}>
                                        <div className="flex items-center gap-3">
                                            <span className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${row.tint}`}>{row.icon}</span>
                                            <div className="min-w-0 flex-1">
                                                <div className="text-sm font-bold text-slate-700">{row.title}</div>
                                                <div className="text-[11px] text-slate-400">{row.hint}</div>
                                            </div>
                                            <span className="text-xs font-semibold text-slate-400 shrink-0">{row.format(value)}</span>
                                        </div>
                                        <input
                                            type="range"
                                            min={range.min}
                                            max={range.max}
                                            step={range.step}
                                            value={value}
                                            onChange={e => setDraft(d => setMomentsNumber(d, row.key, Number(e.target.value)))}
                                            aria-label={row.title}
                                            className="w-full mt-2.5"
                                            style={{ accentColor: PRIMARY }}
                                        />
                                    </div>
                                );
                            })}
                        </Card>
                    ))}

                    <Card>
                        <button onClick={restoreDefaults} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-slate-50">
                            <span className="w-10 h-10 rounded-full bg-orange-50 text-orange-500 flex items-center justify-center shrink-0"><ArrowCounterClockwise size={18} /></span>
                            <span className="text-sm font-bold text-orange-500">恢復預設頻率</span>
                        </button>
                    </Card>
                </>}

                {view === 'posters' && <>
                    <p className="text-[11px] leading-relaxed text-slate-400 px-1">
                        角色和 NPC 在同一份清單。關掉的不會自動發帖，但還是會看到、回應別人的動態。
                        {!draft.autoPostEnabled && '目前「自動發帖」總開關是關的，這份清單要打開總開關才生效。'}
                    </p>
                    {posters.length > 0 && (
                        <div className="flex gap-2">
                            <button onClick={() => setAllPosters(true)} className="px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-[11px] font-bold text-slate-500 active:scale-95">全部開啟</button>
                            <button onClick={() => setAllPosters(false)} className="px-3.5 py-1.5 rounded-full bg-white border border-slate-200 text-[11px] font-bold text-slate-500 active:scale-95">全部關閉</button>
                        </div>
                    )}
                    <Card>
                        {posters.length === 0 && <div className="px-4 py-8 text-center text-xs text-slate-300">還沒有角色或 NPC</div>}
                        {posters.map(p => {
                            const on = !draft.disabledPosterIds.includes(p.id);
                            return (
                                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                                    <TokenImg value={p.avatar} className="w-10 h-10 rounded-full object-cover bg-slate-100 shrink-0" alt="" />
                                    <div className="min-w-0 flex-1 flex items-center gap-1.5">
                                        <span className="text-sm font-bold text-slate-700 truncate">{p.name}</span>
                                        {p.isNpc && <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-500 text-[9px] font-bold">NPC</span>}
                                    </div>
                                    <Switch on={on} onToggle={() => togglePoster(p.id)} label={`${p.name} 自動發帖`} />
                                </div>
                            );
                        })}
                    </Card>
                </>}
            </div>
        </div>
    );
};

export default MomentsInteractionSettingsPanel;
