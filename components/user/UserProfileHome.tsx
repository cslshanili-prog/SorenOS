import React, { useEffect, useMemo, useState } from 'react';
import { Broadcast, CaretLeft, CaretRight, IdentificationCard, Notebook, PencilSimple, UserCircle } from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import TokenImg from '../os/TokenImg';
import RealBalancePanel from '../bank/RealBalancePanel';
import LifeRecordPanel from '../lifeRecord/LifeRecordPanel';
import PerCharAvatarPicker from './PerCharAvatarPicker';
import PerCharPersonaPicker from './PerCharPersonaPicker';
import PerGroupPersonaPicker from './PerGroupPersonaPicker';
import UserPersonaEditor from './UserPersonaEditor';
import MomentsInteractionSettingsPanel from './MomentsInteractionSettingsPanel';
import { ensureRealBalanceState } from '../../utils/realBalance';
import { normalizeMomentsSettings } from '../../utils/momentsSettings';
import { trackEvent } from '../../utils/analytics';

type ProfileView = 'home' | 'balance' | 'moments' | 'perChat';

const cardClass = 'bg-white rounded-[1.75rem] shadow-[0_10px_30px_-12px_rgba(80,70,120,0.18)] border border-slate-100';

/**
 * 個人檔案的內容本體：Chat 的「主頁」分頁和桌面上的「檔案」App（UserApp）共用這一份。
 * 身份切換在外層 header（IdentitySwitcher），這裡不再放身份卡面板。
 *
 * - 底部 Tab：我的檔案／生活記錄。
 * - 我的檔案：目前身份的名片、Real Balance、朋友圈互動、分角色與群聊身份（三塊收進二級頁，點了才開）。
 * - 二級頁（餘額管理／朋友圈互動／分角色與群聊身份）打開時底部 Tab 收起，返回鍵回到這裡。
 */
const UserProfileHome: React.FC = () => {
    const { userProfile, userProfileBase, updateUserProfile, addToast } = useOS();
    const [tab, setTab] = useState<'profile' | 'life'>('profile');
    const [view, setView] = useState<ProfileView>('home');
    const [editingCurrent, setEditingCurrent] = useState(false);

    // undefined = 還沒打開過；真的進了個人檔案才生成種子狀態並落庫，不趁用戶沒點開就偷偷建號
    const realBalanceState = useMemo(() => ensureRealBalanceState(userProfile.realBalance), [userProfile.realBalance]);
    useEffect(() => {
        if (!userProfile.realBalance) updateUserProfile({ realBalance: realBalanceState });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userProfile.realBalance]);

    const moments = normalizeMomentsSettings(userProfileBase.momentsSettings);
    const pinnedChats = Object.keys(userProfileBase.perCharPersonaIds || {}).length;
    const pinnedGroups = Object.keys(userProfileBase.perGroupPersonaIds || {}).length;
    const pinnedAvatars = Object.keys(userProfileBase.perCharAvatars || {}).length;
    const activePersonaId = userProfileBase.activePersonaId;

    const open = (next: ProfileView) => {
        setView(next);
        if (next === 'balance') trackEvent('打开 Real Balance 页');
    };

    if (view === 'balance') {
        return (
            <div className="h-full min-h-0 overflow-y-auto">
                <RealBalancePanel
                    state={realBalanceState}
                    onCommit={next => updateUserProfile({ realBalance: next })}
                    onBack={() => setView('home')}
                    addToast={addToast}
                />
            </div>
        );
    }

    if (view === 'moments') {
        return <MomentsInteractionSettingsPanel onBack={() => setView('home')} />;
    }

    if (view === 'perChat') {
        return (
            <div className="flex flex-col h-full min-h-0">
                <div className="flex items-center gap-2 px-4 py-3 shrink-0">
                    <button onClick={() => setView('home')} className="p-1.5 -ml-1.5 rounded-full hover:bg-black/5 active:scale-90 transition-transform" aria-label="返回">
                        <CaretLeft size={20} className="text-slate-600" />
                    </button>
                    <h1 className="text-lg font-bold text-slate-800">分角色與群聊身份</h1>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-10 space-y-5">
                    <p className="text-[11px] leading-relaxed text-slate-400 px-1">
                        在這裡指定過的私聊／群聊，會固定用那張身份卡或頭像，不跟著頁首切換的預設身份走。
                    </p>
                    {/* 分角色身份指定：給某個角色單獨綁一張身份卡，不跟著全域切換走 */}
                    <PerCharPersonaPicker />
                    {/* 群聊身份指定：跟分角色身份指定同一個概念，鍵換成 groupId */}
                    <PerGroupPersonaPicker />
                    {/* 分角色聊天頭像：給每個角色的私聊單獨換「你」的頭像 */}
                    <PerCharAvatarPicker />
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pt-5 pb-8 space-y-4">
                {tab === 'life' && <>
                    <p className="text-[11px] leading-relaxed text-slate-400 px-1">生理期、藥盒、記帳與鍛鍊，也可以讓角色幫你記。</p>
                    <LifeRecordPanel />
                </>}

                {tab === 'profile' && <>
                    {/* 名片：只讀顯示目前生效的身份，✎ 直接編輯這一張；切換身份在頁首 */}
                    <div className={`${cardClass} overflow-hidden`}>
                        <div className="relative h-20" style={{ background: 'linear-gradient(135deg, hsl(var(--primary-hue),var(--primary-sat),72%) 0%, hsl(var(--primary-hue),var(--primary-sat),60%) 100%)' }}>
                            <div className="absolute -top-6 -right-4 w-28 h-28 rounded-full" style={{ background: 'rgba(255,255,255,0.18)' }} />
                            <div className="absolute top-5 left-6 w-14 h-14 rounded-full" style={{ background: 'rgba(255,255,255,0.12)' }} />
                            <button
                                onClick={() => setEditingCurrent(true)}
                                className="absolute top-3 right-3 w-8 h-8 rounded-full bg-white/80 text-slate-500 flex items-center justify-center active:scale-90 transition-transform"
                                aria-label="編輯目前身份"
                            >
                                <PencilSimple size={15} />
                            </button>
                        </div>
                        <div className="px-6 pb-5 -mt-10 flex flex-col items-center">
                            <div className="relative w-20 h-20 rounded-full ring-4 ring-white bg-slate-100 overflow-hidden shadow-md">
                                <TokenImg value={userProfile.avatar} className="w-full h-full object-cover" />
                            </div>
                            <p className="mt-2.5 text-lg font-bold text-slate-800">{userProfile.name || '未設置身份'}</p>
                            <p className="mt-0.5 text-[10px] text-slate-400">{activePersonaId ? '身份卡' : '真實身份'} · 在頁首可以切換</p>
                        </div>
                    </div>

                    <button
                        onClick={() => open('balance')}
                        className="w-full bg-gradient-to-br from-sky-50 to-blue-50 rounded-[1.75rem] border border-sky-100 p-5 text-left active:scale-[0.99] transition-transform"
                    >
                        <div className="flex items-center justify-between">
                            <div className="text-[10px] font-bold text-sky-400 tracking-widest uppercase">Real Balance</div>
                            <div className="text-[11px] text-sky-500">{realBalanceState.cards.length} 張銀行卡</div>
                        </div>
                        <div className="text-2xl font-black text-slate-800 mt-1">¥{realBalanceState.balance.toFixed(2)}</div>
                        <div className="text-[11px] text-sky-500 mt-2 flex items-center justify-between">
                            <span>餘額管理 · 銀行卡與流水</span>
                            <span className="font-bold">查看 ›</span>
                        </div>
                    </button>

                    <div className={`${cardClass} divide-y divide-slate-50`}>
                        <button onClick={() => open('moments')} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-slate-50 rounded-t-[1.75rem]">
                            <span className="w-10 h-10 rounded-2xl bg-orange-50 text-orange-500 flex items-center justify-center shrink-0"><Broadcast size={20} /></span>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-slate-700">朋友圈互動</div>
                                <div className="text-[11px] text-slate-400">
                                    {moments.autoPostEnabled ? `自動發帖已開 · 每 ${moments.minPostIntervalHours}–${moments.maxPostIntervalHours} 小時` : '自動發帖未開'}
                                </div>
                            </div>
                            <CaretRight size={16} className="text-slate-300 shrink-0" />
                        </button>
                        <button onClick={() => open('perChat')} className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-slate-50 rounded-b-[1.75rem]">
                            <span className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center shrink-0"><IdentificationCard size={20} /></span>
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-bold text-slate-700">分角色與群聊身份</div>
                                <div className="text-[11px] text-slate-400">
                                    {pinnedChats + pinnedGroups + pinnedAvatars === 0
                                        ? '指定某個私聊／群聊固定用哪張身份卡、哪個頭像'
                                        : [pinnedChats && `${pinnedChats} 個私聊指定了身份`, pinnedGroups && `${pinnedGroups} 個群聊指定了身份`, pinnedAvatars && `${pinnedAvatars} 個私聊換了頭像`].filter(Boolean).join('、')}
                                </div>
                            </div>
                            <CaretRight size={16} className="text-slate-300 shrink-0" />
                        </button>
                    </div>
                </>}
            </div>

            {/* 底部 Tab：我的檔案／生活記錄 */}
            <div className="shrink-0 bg-white/90 backdrop-blur-md border-t border-slate-100 flex">
                {([
                    ['profile', '我的檔案', UserCircle],
                    ['life', '生活記錄', Notebook],
                ] as const).map(([key, label, Icon]) => (
                    <button
                        key={key}
                        onClick={() => { setTab(key); trackEvent('切换个人档案标签页', { tab: key }); }}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-bold transition-colors ${tab === key ? 'text-primary' : 'text-slate-400'}`}
                    >
                        <Icon size={17} weight={tab === key ? 'fill' : 'regular'} />
                        {label}
                    </button>
                ))}
            </div>

            {editingCurrent && <UserPersonaEditor target={activePersonaId || 'real'} onClose={() => setEditingCurrent(false)} />}
        </div>
    );
};

export default UserProfileHome;
