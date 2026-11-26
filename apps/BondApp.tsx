/**
 * 羈絆（plans/bond.md、plans/bond-batch1.md）：一段關係的專屬空間。
 * 第 1 批：空間清單（我和 TA／他們之間）、「我們」首頁、路線設定、天數、此刻的我們、建立空間。
 * 第 2 批：拾光分頁（時間線、片刻、記憶的編輯刪除，plans/bond-batch2.md）。心意、約定、珍藏之後陸續出現（還沒做的不顯示）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID, type BondRecord, type BondSource, type CalendarEvent, type CharacterProfile } from '../types';
import { AvatarPair, BondAvatar, BondHeader, BondStyle, BondTabs, bondTabsFor, SectionLabel, type BondTab } from '../components/bond/bondUi';
import { BondHeartPage, mainBondIdOf, useHeartNotice, type HeartNotice, type HeartTab } from '../components/bond/BondHeartPage';
import { BondQuestionComposePage, BondQuestionPage } from '../components/bond/BondQuestionPages';
import { BondSlipComposePage, BondSlipPage } from '../components/bond/BondSlipPages';
import { BondPactPage, pactNeedsYou, type PactTab } from '../components/bond/BondPactPage';
import { BondHabitComposePage, BondHabitPage, BondMilestoneEditPage, BondPromiseComposePage, BondPromisePage, BondWishComposePage, BondWishPage } from '../components/bond/BondPactPages';
import { useBondEntries } from '../components/bond/useSpaceTimeline';
import { BondAchievementsPage, BondLedgerPage, BondReviewPage } from '../components/bond/BondLedgerPages';
import { BondOutputSettingsPage } from '../components/bond/BondOutputSettingsPage';
import { resolveOutputChars, resolveOutputSetting } from '../utils/bond/output';
import { bondIdForChar } from '../utils/bond/model';
import { BondMomentsPage } from '../components/bond/BondMomentsPage';
import { BondItemPage } from '../components/bond/BondItemPage';
import { BondMemoryEditor, BondMomentEditor } from '../components/bond/BondMomentEditor';
import { useSpaceTimeline } from '../components/bond/useSpaceTimeline';
import { BondCollectPage } from '../components/bond/BondCollectPage';
import { BondPickPage } from '../components/bond/BondPickPage';
import { BondEssayComposePage } from '../components/bond/BondEssayComposePage';
import { BondEssayPage } from '../components/bond/BondEssayPage';
import { BondEssayEditor } from '../components/bond/BondEssayEditor';
import type { EssayMode } from '../utils/bond/essay';
import { bondEntryById } from '../utils/bond/entryRegistry';
import { lineArgFromKey, type BondCollectRequest } from '../utils/bond/collect';
import { BondSpacePage } from '../components/bond/BondSpacePage';
import { BondRoutePage } from '../components/bond/BondRoutePage';
import { BondDaysPage } from '../components/bond/BondDaysPage';
import { resolveSpace, type ResolvedSpace } from '../components/bond/space';
import { allRegisteredBonds, onBondRegistryChange } from '../utils/bond/registry';
import { listPairSpaces, listPersonaSpaces, primaryCounter } from '../utils/bond/spaces';
import { routeLabel, stageLabel } from '../utils/bond/routes';
import { pairBondId, parseBondId, personaBondId } from '../utils/bond/model';
import { bondOrBlank, saveBondRecord, updateBond } from '../utils/bond/store';
import { withLineFields, lineFor, lineView, lineMsgFields } from '../utils/chatLine';
import { globalPersonaKey, personaAvatarForKey, personaNameForKey, REAL_IDENTITY_PERSONA_ID } from '../utils/userPersona';
import { personaOptions } from '../utils/calendarView';
import { isOnStage } from '../utils/castRole';
import { loadCalendarEvents } from '../utils/calendarEvents';
import { appReturn, bondLaunch, chatBondRefLaunch, chatJumpLaunch, dateJumpLaunch, memoryPalaceLaunch, pairChatLaunch } from '../utils/appLaunch';
import { bondRefFromDiary, bondRefFromEssay, bondRefFromItem, bondRefFromQuestion, bondRefFromSlip, type BondRefMeta } from '../utils/bond/bondRef';
import { characterLaunch } from '../utils/characterLaunch';
import { DB } from '../utils/db';
import { trackEvent } from '../utils/analytics';

type Page =
    | { page: 'list' }
    | { page: 'space'; id: string; tab?: BondTab; heart?: HeartTab; pact?: PactTab }
    | { page: 'wish'; id: string; entryId: string }
    | { page: 'wish-edit'; id: string; entryId?: string }
    | { page: 'promise'; id: string; entryId: string }
    | { page: 'promise-edit'; id: string; entryId?: string; fromWishId?: string }
    | { page: 'habit'; id: string; entryId: string }
    | { page: 'habit-edit'; id: string; entryId?: string }
    | { page: 'milestone-edit'; id: string; entryId?: string }
    | { page: 'ledger'; id: string }
    | { page: 'achievements'; id: string }
    | { page: 'review'; id: string }
    | { page: 'diary'; id: string; date?: string; from?: 'home'; exitOnBack?: boolean }
    | { page: 'question'; id: string; entryId: string; from?: 'home'; autoAsk?: boolean; exitOnBack?: boolean }
    | { page: 'question-new'; id: string }
    | { page: 'output'; id: string }
    | { page: 'slip'; id: string; entryId: string; from?: 'home'; exitOnBack?: boolean }
    | { page: 'slip-edit'; id: string; entryId?: string; replyTo?: string }
    | { page: 'item'; id: string; key: string; exitOnBack?: boolean }
    | { page: 'moment-edit'; id: string; entryId?: string; key?: string }
    | { page: 'memory-edit'; id: string; memoryId: string; key: string }
    | { page: 'collect'; id: string; request: BondCollectRequest }
    | { page: 'pick'; id: string }
    | { page: 'essay'; id: string; essayId: string; chosen?: boolean; key?: string; exitOnBack?: boolean }
    | { page: 'essay-write'; id: string; mode: EssayMode; key?: string; baseId?: string }
    | { page: 'essay-edit'; id: string; essayId: string; chosen?: boolean; key?: string }
    | { page: 'route'; id: string; from: 'space' | 'list' }
    | { page: 'days'; id: string }
    | { page: 'mine'; id: string }
    | { page: 'create' };

// 交換日記搬進羈絆（plans/bond-batch3.md 第 4 節）：日記頁還是原本那一份，嵌進來用
const JournalApp = React.lazy(() => import('./JournalApp'));

/** entry 'journal'：從桌面的「交換日記」圖示進來，直接開現在這個角色、這張身份卡的心意日記 */
const BondApp: React.FC<{ entry?: 'journal' }> = ({ entry }) => {
    const { closeApp, openApp, characters, userProfileBase, apiConfig, addToast, updateLine, updateCharacter, memoryPalaceConfig, remoteVectorConfig, setActivePersonaId, setActiveCharacterId, activeCharacterId, activeLineFor } = useOS();
    const [page, setPage] = useState<Page>(() => {
        // 先 peek、掛上後才 consume（跟行事曆同一招：開發模式重掛或 Suspense 重來時字條不會先被吃掉）
        const launch = bondLaunch.peek();
        if (!launch && entry === 'journal') {
            const raw = characters.find(c => c.id === activeCharacterId && !c.altOf);
            if (!raw) return { page: 'list' };
            const view = lineView(withLineFields(userProfileBase, raw), activeLineFor(raw));
            return { page: 'space', id: bondIdForChar(view), tab: 'heart', heart: 'diary' };
        }
        if (!launch) return { page: 'list' };
        if (launch.heart) {
            // 從聊天氣泡上的小卡開過來：返回就回聊天
            const exitOnBack = appReturn.pending(AppID.Bond);
            if (launch.questionId) return { page: 'question', id: launch.bondId, entryId: launch.questionId, exitOnBack };
            if (launch.slipId) return { page: 'slip', id: launch.bondId, entryId: launch.slipId, exitOnBack };
            if (launch.diaryDate) return { page: 'diary', id: launch.bondId, date: launch.diaryDate, exitOnBack };
            return { page: 'space', id: launch.bondId, tab: 'heart', heart: launch.heart };
        }
        if (launch.page === 'route') return { page: 'route', id: launch.bondId, from: 'list' };
        if (launch.page === 'collect' && launch.collect) return { page: 'collect', id: launch.bondId, request: launch.collect };
        // 從聊天氣泡上的小卡直接開到這一件：返回就回聊天（appReturn 由聊天登記）
        const exitOnBack = appReturn.pending(AppID.Bond);
        if (launch.essayId) return { page: 'essay', id: launch.bondId, essayId: launch.essayId, exitOnBack };
        if (launch.itemKey) return { page: 'item', id: launch.bondId, key: launch.itemKey, exitOnBack };
        if (launch.page === 'moments') return { page: 'space', id: launch.bondId, tab: 'moments' };
        return { page: 'space', id: launch.bondId };
    });
    useEffect(() => { bondLaunch.consume(); }, []);
    const [tab, setTab] = useState<'persona' | 'pair'>(() => (page.page !== 'list' && page.page !== 'create' && page.id.startsWith('pair~') ? 'pair' : 'persona'));
    const [bonds, setBonds] = useState<BondRecord[]>(() => allRegisteredBonds());
    const [pairLineIds, setPairLineIds] = useState<string[]>([]);
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    // 子頁存了東西回來時重新算一次空間（BondRecord 存在登記表裡）
    const [version, setVersion] = useState(0);

    useEffect(() => onBondRegistryChange(() => { setBonds(allRegisteredBonds()); setVersion(v => v + 1); }), []);
    useEffect(() => {
        DB.getPairLineIds().then(setPairLineIds).catch(() => setPairLineIds([]));
        loadCalendarEvents().then(setEvents).catch(() => setEvents([]));
    }, []);

    const chars = useMemo(() => characters.filter(c => !c.altOf).map(c => withLineFields(userProfileBase, c)), [characters, userProfileBase]);
    const savedIds = useMemo(() => new Set(bonds.map(b => b.id)), [bonds]);
    const space = useCallback((id: string): ResolvedSpace | null => resolveSpace(id, chars, userProfileBase, x => savedIds.has(x)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [chars, userProfileBase, savedIds, version]);

    const back = () => setPage({ page: 'list' });

    /**
     * 點來源跳回當時那則（plans/bond-batch2.md 6.1）。私聊、見面要先切到那條線的身份卡（線跟著「現在的我」走），
     * 角色私聊直接開那頁；按返回回到羈絆的這件事。原訊息已刪就不跳。
     */
    const openSource = async (spaceId: string, itemKey: string, source: BondSource) => {
        if (source.type !== 'message' && source.type !== 'date') return;
        const firstId = source.messageIds[0];
        if (!firstId || !(await DB.getMessageById(firstId).catch(() => null))) { addToast('原訊息已經刪掉了，這裡留著收存時的原文', 'info'); return; }
        const backHere = () => { bondLaunch.request({ bondId: spaceId, itemKey }); openApp(AppID.Bond); };
        if (source.type === 'message' && source.lineId.startsWith('pair~')) {
            trackEvent('从拾光跳回原文', { 来源: '角色私聊' });
            pairChatLaunch.request({ pairId: source.lineId, messageId: firstId });
            appReturn.set(AppID.ChatHub, backHere);
            openApp(AppID.ChatHub);
            return;
        }
        const line = source.type === 'message' ? lineArgFromKey(source.lineId) : null;
        const charId = source.type === 'message' ? (typeof line === 'string' ? line : line!.charId) : source.charId;
        const raw = characters.find(c => c.id === charId);
        if (!raw) { addToast('這個角色已經不在了', 'info'); return; }
        // 這條線的身份卡：非主線看 lineId；主線（或見面）用空間的卡
        const parsed = parseBondId(spaceId);
        const linePersona = (line && typeof line !== 'string' ? line.personaKey : undefined)
            || (parsed?.kind === 'persona' ? parsed.personaKey : undefined)
            || raw.primaryPersonaKey;
        if (linePersona && linePersona !== globalPersonaKey(userProfileBase)) {
            await setActivePersonaId(linePersona === REAL_IDENTITY_PERSONA_ID ? undefined : linePersona);
            addToast(`切到「${personaNameForKey(userProfileBase, linePersona)}」這張身份卡`, 'info');
        }
        setActiveCharacterId(charId);
        if (source.type === 'date') {
            trackEvent('从拾光跳回原文', { 来源: '见面' });
            dateJumpLaunch.request({ charId, storyId: source.storyId, messageId: firstId });
            appReturn.set(AppID.Date, backHere);
            openApp(AppID.Date);
            return;
        }
        trackEvent('从拾光跳回原文', { 来源: '私聊' });
        chatJumpLaunch.request({ charId, messageId: firstId });
        appReturn.set(AppID.Chat, backHere);
        openApp(AppID.Chat);
    };

    /**
     * 帶去聊聊（6.2）：開這條線的私聊（不是現在的身份卡就先切過去），輸入框上方掛著這張卡；
     * 按返回回到羈絆的這件事。
     */
    const bringToChat = async (spaceId: string, ref: BondRefMeta, back: () => void) => {
        const parsed = parseBondId(spaceId);
        if (parsed?.kind !== 'persona') return;
        const raw = characters.find(c => c.id === parsed.charId);
        if (!raw) { addToast('這個角色已經不在了', 'info'); return; }
        const linePersona = parsed.personaKey || raw.primaryPersonaKey;
        if (linePersona && linePersona !== globalPersonaKey(userProfileBase)) {
            await setActivePersonaId(linePersona === REAL_IDENTITY_PERSONA_ID ? undefined : linePersona);
            addToast(`切到「${personaNameForKey(userProfileBase, linePersona)}」這張身份卡`, 'info');
        }
        setActiveCharacterId(raw.id);
        chatBondRefLaunch.request({ charId: raw.id, ref });
        appReturn.set(AppID.Chat, back);
        openApp(AppID.Chat);
    };

    /** 記憶：開神經鏈接那個角色的記憶分頁，或直接進他的記憶宮殿（6.1）；按返回回到這件事 */
    const openMemory = (spaceId: string, itemKey: string, charId: string, where: 'link' | 'palace') => {
        if (!characters.some(c => c.id === charId)) { addToast('這個角色已經不在了', 'info'); return; }
        const backHere = () => { bondLaunch.request({ bondId: spaceId, itemKey }); openApp(AppID.Bond); };
        trackEvent('从拾光跳回原文', { 来源: '记忆' });
        setActiveCharacterId(charId);
        if (where === 'palace') {
            memoryPalaceLaunch.request({ charId });
            appReturn.set(AppID.MemoryPalace, backHere);
            openApp(AppID.MemoryPalace);
            return;
        }
        characterLaunch.request({ charId, detailTab: 'memory', backToCaller: true });
        appReturn.set(AppID.Character, backHere);
        openApp(AppID.Character);
    };

    if (page.page === 'space' || page.page === 'route' || page.page === 'days' || page.page === 'mine'
        || page.page === 'item' || page.page === 'moment-edit' || page.page === 'memory-edit' || page.page === 'collect' || page.page === 'pick'
        || page.page === 'essay' || page.page === 'essay-write' || page.page === 'essay-edit'
        || page.page === 'diary' || page.page === 'question' || page.page === 'question-new' || page.page === 'slip' || page.page === 'slip-edit' || page.page === 'output'
        || page.page === 'wish' || page.page === 'wish-edit' || page.page === 'promise' || page.page === 'promise-edit'
        || page.page === 'habit' || page.page === 'habit-edit' || page.page === 'milestone-edit'
        || page.page === 'ledger' || page.page === 'achievements' || page.page === 'review') {
        const s = space(page.id);
        if (!s) {
            return (
                <div className="h-full w-full flex flex-col bond-root">
                    <BondStyle />
                    <BondHeader title="羈絆" onBack={back} />
                    <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這段關係裡的人不在了。</div>
                </div>
            );
        }
        const toSpace = () => setPage({ page: 'space', id: page.id });
        const toMoments = () => setPage({ page: 'space', id: page.id, tab: 'moments' });
        const openItem = (key: string) => setPage({ page: 'item', id: page.id, key });
        const openEssay = (essayId: string, extra?: { chosen?: boolean; key?: string }) => setPage({ page: 'essay', id: page.id, essayId, ...extra });
        const tabBar = (current: BondTab) => <HeartTabs space={s} value={current} onChange={t => setPage({ page: 'space', id: page.id, tab: t })} />;
        const toHeart = (heart: HeartTab) => setPage({ page: 'space', id: page.id, tab: 'heart', heart });
        const toHome = () => setPage({ page: 'space', id: page.id });
        const toPact = (pact: PactTab) => setPage({ page: 'space', id: page.id, tab: 'pact', pact });
        const openNotice = (n: HeartNotice) => {
            if (n.kind === 'slip') setPage({ page: 'slip', id: s.id, entryId: n.id, from: 'home' });
            else if (n.kind === 'question') setPage({ page: 'question', id: s.id, entryId: n.id, from: 'home' });
            else setPage({ page: 'diary', id: s.id, date: n.date, from: 'home' });
        };
        const diarySetting = resolveOutputSetting(s.bond, 'diary');
        return (
            <div className="h-full w-full relative bond-root overflow-hidden">
                <BondStyle />
                {page.page === 'space' && page.tab === 'moments' && (
                    <BondMomentsPage space={s} characters={chars} tabBar={tabBar('moments')} onBack={back}
                        onOpenItem={openItem} onNewMoment={() => setPage({ page: 'moment-edit', id: s.id })}
                        onPick={() => setPage({ page: 'pick', id: s.id })}
                        onOpenEssay={essayId => openEssay(essayId)}
                        onChooseEssay={() => setPage({ page: 'essay-write', id: s.id, mode: 'choose' })} />
                )}
                {page.page === 'pick' && (
                    <BondPickPage space={s} characters={chars} apiConfig={apiConfig} onBack={toMoments}
                        onSaved={() => toMoments()} addToast={addToast} />
                )}
                {page.page === 'item' && (
                    <BondItemPage space={s} itemKey={page.key} characters={chars} onBack={page.exitOnBack ? closeApp : toMoments}
                        onOpenSource={src => void openSource(s.id, page.key, src)}
                        onOpenMemory={(charId, where) => openMemory(s.id, page.key, charId, where)}
                        onEditMoment={entryId => setPage({ page: 'moment-edit', id: s.id, entryId, key: page.key })}
                        onEditMemory={memoryId => setPage({ page: 'memory-edit', id: s.id, memoryId, key: page.key })}
                        onOpenEssay={essayId => openEssay(essayId, { key: page.key })}
                        onWriteEssay={() => setPage({ page: 'essay-write', id: s.id, mode: 'event', key: page.key })}
                        onBringToChat={s.kind === 'persona' ? item => void bringToChat(s.id, bondRefFromItem(s.id, item), () => { bondLaunch.request({ bondId: s.id, itemKey: item.key }); openApp(AppID.Bond); }) : undefined}
                        updateCharacter={updateCharacter} addToast={addToast} />
                )}
                {page.page === 'essay-write' && (
                    <BondEssayComposePage space={s} characters={chars} apiConfig={apiConfig} mode={page.mode} itemKey={page.key} baseId={page.baseId}
                        onBack={page.baseId ? () => openEssay(page.baseId!) : page.key ? () => openItem(page.key!) : toMoments}
                        onDone={essayId => openEssay(essayId, { chosen: page.mode === 'choose', key: page.key })} addToast={addToast} />
                )}
                {page.page === 'essay' && (
                    <BondEssayPage space={s} characters={chars} apiConfig={apiConfig} essayId={page.essayId} chosen={page.chosen}
                        onBack={page.exitOnBack ? closeApp : page.key ? () => openItem(page.key!) : toMoments}
                        onOpenItem={openItem}
                        onEdit={essayId => setPage({ page: 'essay-edit', id: s.id, essayId, chosen: page.chosen, key: page.key })}
                        onAfterword={baseId => setPage({ page: 'essay-write', id: s.id, mode: 'afterword', baseId, key: page.key })}
                        onBringToChat={s.kind === 'persona' ? essayId => {
                            const essay = bondEntryById(essayId);
                            if (!essay) return;
                            void bringToChat(s.id, bondRefFromEssay(s.id, essay, chars.find(c => c.id === essay.author)?.name),
                                () => { bondLaunch.request({ bondId: s.id, essayId }); openApp(AppID.Bond); });
                        } : undefined}
                        addToast={addToast} />
                )}
                {page.page === 'essay-edit' && (
                    <BondEssayEditor essayId={page.essayId}
                        authorName={chars.find(c => c.id === bondEntryById(page.essayId)?.author)?.name || s.rightName}
                        onBack={() => setPage({ page: 'essay', id: s.id, essayId: page.essayId, chosen: page.chosen, key: page.key })} addToast={addToast} />
                )}
                {page.page === 'moment-edit' && (
                    <BondMomentEditor space={s} entryId={page.entryId}
                        onBack={page.key ? () => openItem(page.key!) : toMoments}
                        onSaved={entry => openItem(`e:${entry.id}`)} addToast={addToast} />
                )}
                {page.page === 'collect' && (
                    // 從聊天帶過來的：存好或取消都回原本的聊天（appReturn 由聊天那頭登記，closeApp 會帶回去）
                    <BondCollectPage space={s} request={page.request} characters={chars} apiConfig={apiConfig}
                        onDone={() => closeApp()} addToast={addToast} />
                )}
                {page.page === 'memory-edit' && (
                    <MemoryEditRoute space={s} chars={chars} memoryId={page.memoryId} itemKey={page.key}
                        embedding={memoryPalaceConfig.embedding} remote={remoteVectorConfig}
                        updateCharacter={updateCharacter} onBack={() => openItem(page.key)} addToast={addToast} />
                )}
                {page.page === 'space' && page.tab === 'heart' && s.kind === 'persona' && (
                    <BondHeartPage space={s} characters={chars} apiConfig={apiConfig} tabBar={tabBar('heart')}
                        heart={page.heart || 'diary'} onHeart={toHeart} onBack={back}
                        onOpenDiary={date => setPage({ page: 'diary', id: s.id, date: date || s.todayKey })}
                        onOpenQuestion={entryId => setPage({ page: 'question', id: s.id, entryId })}
                        onNewQuestion={() => setPage({ page: 'question-new', id: s.id })}
                        onOpenSlip={entryId => setPage({ page: 'slip', id: s.id, entryId })}
                        onNewSlip={() => setPage({ page: 'slip-edit', id: s.id })}
                        onOpenSettings={() => setPage({ page: 'output', id: s.id })}
                        addToast={addToast} />
                )}
                {page.page === 'diary' && s.kind === 'persona' && s.view && s.user && (
                    <div className="absolute inset-0 z-10">
                        <React.Suspense fallback={<div className="h-full grid place-items-center text-[13px] text-[var(--bond-muted)]">翻開日記本…</div>}>
                            <JournalApp embed={{
                                char: s.view, user: s.user, bondId: s.id, mainBondId: mainBondIdOf(s), today: s.todayKey,
                                initialDate: page.date, syncToChat: diarySetting.syncToChat, chars: resolveOutputChars(s.bond, 'diary'), style: diarySetting.style,
                                onBack: () => (page.exitOnBack ? closeApp() : page.from === 'home' ? toHome() : toHeart('diary')),
                                onBringToChat: (d, side) => {
                                    const ref = bondRefFromDiary(s.id, d, side, side === 'user' ? s.leftName : s.rightName);
                                    if (ref) void bringToChat(s.id, ref, () => { bondLaunch.request({ bondId: s.id, heart: 'diary', diaryDate: d.date }); openApp(AppID.Bond); });
                                },
                            }} />
                        </React.Suspense>
                    </div>
                )}
                {page.page === 'question' && (
                    <BondQuestionPage key={page.entryId} space={s} apiConfig={apiConfig} entryId={page.entryId} autoAsk={page.autoAsk}
                        onBringToChat={e => {
                            const ref = bondRefFromQuestion(s.id, e, { user: s.leftName, char: s.rightName });
                            if (ref) void bringToChat(s.id, ref, () => { bondLaunch.request({ bondId: s.id, heart: 'question', questionId: e.id }); openApp(AppID.Bond); });
                        }}
                        onBack={() => (page.exitOnBack ? closeApp() : page.from === 'home' ? toHome() : toHeart('question'))} addToast={addToast} />
                )}
                {page.page === 'output' && s.kind === 'persona' && (
                    <BondOutputSettingsPage key={`${s.id}-${version}`} space={s} apiConfig={apiConfig} onBack={() => toHeart('diary')} addToast={addToast} />
                )}
                {page.page === 'question-new' && (
                    <BondQuestionComposePage space={s} apiConfig={apiConfig} onBack={() => toHeart('question')}
                        onDone={(entryId, sealed) => setPage({ page: 'question', id: s.id, entryId, autoAsk: sealed })} addToast={addToast} />
                )}
                {page.page === 'slip' && (
                    <BondSlipPage space={s} apiConfig={apiConfig} entryId={page.entryId}
                        onBack={() => (page.exitOnBack ? closeApp() : page.from === 'home' ? toHome() : toHeart('note'))}
                        onReply={replyTo => setPage({ page: 'slip-edit', id: s.id, replyTo })}
                        onEditDraft={entryId => setPage({ page: 'slip-edit', id: s.id, entryId })}
                        onBringToChat={root => {
                            const ref = bondRefFromSlip(s.id, root, root.id, root.author === 'user' ? s.leftName : s.rightName);
                            if (ref) void bringToChat(s.id, ref, () => { bondLaunch.request({ bondId: s.id, heart: 'note', slipId: root.id }); openApp(AppID.Bond); });
                        }}
                        addToast={addToast} />
                )}
                {page.page === 'slip-edit' && (
                    <BondSlipComposePage space={s} entryId={page.entryId} replyTo={page.replyTo}
                        onBack={() => (page.replyTo ? setPage({ page: 'slip', id: s.id, entryId: page.replyTo }) : toHeart('note'))}
                        onDone={rootId => setPage({ page: 'slip', id: s.id, entryId: rootId })} addToast={addToast} />
                )}
                {page.page === 'space' && page.tab === 'pact' && s.kind === 'persona' && (
                    <BondPactPage space={s} tabBar={tabBar('pact')} header={<BondHeader title={s.rightName} onBack={back} />}
                        pact={page.pact || 'wish'} onPact={toPact}
                        onOpenWish={entryId => setPage({ page: 'wish', id: s.id, entryId })} onNewWish={() => setPage({ page: 'wish-edit', id: s.id })}
                        onOpenPromise={entryId => setPage({ page: 'promise', id: s.id, entryId })} onNewPromise={() => setPage({ page: 'promise-edit', id: s.id })}
                        onOpenHabit={entryId => setPage({ page: 'habit', id: s.id, entryId })} onNewHabit={() => setPage({ page: 'habit-edit', id: s.id })}
                        onOpenMilestone={entryId => setPage({ page: 'milestone-edit', id: s.id, entryId })} onNewMilestone={() => setPage({ page: 'milestone-edit', id: s.id })}
                        onOpenLedger={() => setPage({ page: 'ledger', id: s.id })} onOpenAchievements={() => setPage({ page: 'achievements', id: s.id })}
                        onOpenReview={() => setPage({ page: 'review', id: s.id })} />
                )}
                {page.page === 'ledger' && <BondLedgerPage space={s} onBack={() => toPact('milestone')} />}
                {page.page === 'achievements' && <BondAchievementsPage space={s} onBack={() => toPact('milestone')} />}
                {page.page === 'review' && (
                    <BondReviewPage key={`${s.id}-${version}`} space={s} apiConfig={apiConfig} onBack={() => toPact('milestone')}
                        onOpenRoute={() => setPage({ page: 'route', id: s.id, from: 'space' })} addToast={addToast} />
                )}
                {page.page === 'wish' && (
                    <BondWishPage key={page.entryId} space={s} characters={chars} apiConfig={apiConfig} entryId={page.entryId} onBack={() => toPact('wish')}
                        onEdit={() => setPage({ page: 'wish-edit', id: s.id, entryId: page.entryId })}
                        onMakePromise={() => setPage({ page: 'promise-edit', id: s.id, fromWishId: page.entryId })}
                        onOpenPromise={entryId => setPage({ page: 'promise', id: s.id, entryId })} addToast={addToast} />
                )}
                {page.page === 'wish-edit' && (
                    <BondWishComposePage space={s} entryId={page.entryId} addToast={addToast}
                        onBack={() => (page.entryId ? setPage({ page: 'wish', id: s.id, entryId: page.entryId }) : toPact('wish'))}
                        onDone={entryId => setPage({ page: 'wish', id: s.id, entryId })} />
                )}
                {page.page === 'promise' && (
                    <BondPromisePage key={page.entryId} space={s} apiConfig={apiConfig} entryId={page.entryId} onBack={() => toPact('promise')}
                        onEdit={() => setPage({ page: 'promise-edit', id: s.id, entryId: page.entryId })}
                        onOpenWish={entryId => setPage({ page: 'wish', id: s.id, entryId })} addToast={addToast} />
                )}
                {page.page === 'promise-edit' && (
                    <BondPromiseComposePage space={s} entryId={page.entryId} fromWishId={page.fromWishId} addToast={addToast}
                        onBack={() => (page.entryId ? setPage({ page: 'promise', id: s.id, entryId: page.entryId }) : page.fromWishId ? setPage({ page: 'wish', id: s.id, entryId: page.fromWishId }) : toPact('promise'))}
                        onDone={entryId => setPage({ page: 'promise', id: s.id, entryId })} />
                )}
                {page.page === 'habit' && (
                    <BondHabitPage key={page.entryId} space={s} apiConfig={apiConfig} entryId={page.entryId} onBack={() => toPact('habit')}
                        onEdit={() => setPage({ page: 'habit-edit', id: s.id, entryId: page.entryId })} addToast={addToast} />
                )}
                {page.page === 'habit-edit' && (
                    <BondHabitComposePage space={s} entryId={page.entryId} addToast={addToast}
                        onBack={() => (page.entryId ? setPage({ page: 'habit', id: s.id, entryId: page.entryId }) : toPact('habit'))}
                        onDone={entryId => setPage({ page: 'habit', id: s.id, entryId })} />
                )}
                {page.page === 'milestone-edit' && (
                    <BondMilestoneEditPage key={page.entryId || 'new'} space={s} entryId={page.entryId} onBack={() => toPact('milestone')} addToast={addToast} />
                )}
                {page.page === 'space' && page.tab !== 'moments' && !((page.tab === 'heart' || page.tab === 'pact') && s.kind === 'persona') && (
                    <BondSpacePage key={`${s.id}-${version}`} space={s} characters={chars} events={events} apiConfig={apiConfig}
                        tabBar={tabBar('us')} onOpenItem={openItem} onOpenNotice={openNotice}
                        onBack={back}
                        onOpenRoute={() => setPage({ page: 'route', id: s.id, from: 'space' })}
                        onOpenDays={() => setPage({ page: 'days', id: s.id })}
                        onEditMine={() => setPage({ page: 'mine', id: s.id })}
                        onAddAnniversary={() => { appReturn.set(AppID.Calendar, () => openApp(AppID.Bond)); bondLaunch.request({ bondId: s.id }); openApp(AppID.Calendar); }}
                        onOpenPact={s.kind === 'persona' ? to => (to.promiseId ? setPage({ page: 'promise', id: s.id, entryId: to.promiseId }) : toPact(to.tab)) : undefined}
                        addToast={addToast} />
                )}
                {page.page === 'route' && <BondRoutePage key={`${s.id}-${version}`} space={s} onBack={page.from === 'space' ? toSpace : () => setPage({ page: 'space', id: s.id })} addToast={addToast} />}
                {page.page === 'days' && <BondDaysPage space={s} onBack={toSpace} updateLine={updateLine} addToast={addToast} />}
                {page.page === 'mine' && <MineEditor space={s} onBack={toSpace} addToast={addToast} />}
            </div>
        );
    }

    if (page.page === 'create') {
        return (
            <div className="h-full w-full relative bond-root overflow-hidden">
                <BondStyle />
                <CreateSpacePage chars={chars} profileBase={userProfileBase} initialKind={tab} onBack={back} addToast={addToast}
                    onCreated={id => setPage({ page: 'route', id, from: 'list' })} />
            </div>
        );
    }

    // ── 空間清單 ──
    const personaSpaces = listPersonaSpaces(chars, bonds);
    const pairSpaces = listPairSpaces(pairLineIds, bonds, chars);
    const personas = personaOptions(userProfileBase);
    const byPersona = personas
        .map(p => ({ persona: p, items: personaSpaces.filter(s => s.personaKey === p.key) }))
        .filter(g => g.items.length);
    const charOf = (id: string) => chars.find(c => c.id === id);
    const stageOrder = (c?: CharacterProfile) => (c && isOnStage(c) ? 0 : 1);

    return (
        <div className="h-full w-full flex flex-col bond-root">
            <BondStyle />
            <div className="shrink-0 px-5 pb-3" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 12px)' }}>
                <div className="flex items-center justify-between">
                    <button type="button" onClick={closeApp} className="bond-note py-1">關閉</button>
                    <button type="button" onClick={() => setPage({ page: 'create' })} aria-label="建一個空間" className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]"><Plus size={18} /></button>
                </div>
                <h1 className="bond-serif text-[30px] tracking-[0.2em] mt-2">羈絆</h1>
                <div className="mt-1 text-[12px] text-[var(--bond-muted)]">留下你們經歷過的事，讓它們繼續參與往後的日子。</div>
                <div role="tablist" className="mt-5 flex gap-6 border-b bond-hair">
                    {([['persona', '我和 TA'], ['pair', '他們之間']] as const).map(([k, label]) => (
                        <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                            className={`relative pb-2 text-[13.5px] ${tab === k ? 'bond-serif text-[var(--bond-ink)]' : 'text-[var(--bond-muted)]'}`}>
                            {label}
                            {tab === k && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-[var(--bond-accent)]" />}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
                {tab === 'persona' ? (
                    byPersona.length ? byPersona.map(g => (
                        <section key={g.persona.key} className="mt-4">
                            {byPersona.length > 1 && <SectionLabel>{g.persona.name}</SectionLabel>}
                            <div className="divide-y bond-hair border-y">
                                {[...g.items].sort((a, b) => stageOrder(charOf(a.charId)) - stageOrder(charOf(b.charId))).map(item => {
                                    const c = charOf(item.charId);
                                    if (!c) return null;
                                    const bond = bondOrBlank(item.id);
                                    const view = lineView(c, lineFor(c, item.personaKey));
                                    const s = space(item.id);
                                    const counter = s ? primaryCounter(bond, view.acquaintanceStartDate, s.todayKey) : null;
                                    return (
                                        <SpaceRow key={item.id} dim={!isOnStage(c)} onClick={() => setPage({ page: 'space', id: item.id })}
                                            a={personaAvatarForKey(userProfileBase, item.personaKey)} b={c.avatar}
                                            aName={personaNameForKey(userProfileBase, item.personaKey)} bName={c.name}
                                            title={c.name} sub={`${routeLabel(bond.route)} · ${stageLabel(bond)}`}
                                            note={counter?.days != null ? `第 ${counter.days} 天` : ''} />
                                    );
                                })}
                            </div>
                        </section>
                    )) : <Empty text="認識的角色會自動出現在這裡。" />
                ) : (
                    pairSpaces.length ? (
                        <div className="mt-4 divide-y bond-hair border-y">
                            {pairSpaces.map(item => {
                                const a = charOf(item.aId); const b = charOf(item.bId);
                                if (!a || !b) return null;
                                const bond = bondOrBlank(item.id);
                                return (
                                    <SpaceRow key={item.id} dim={!isOnStage(a) || !isOnStage(b)} onClick={() => setPage({ page: 'space', id: item.id })}
                                        a={a.avatar} b={b.avatar} aName={a.name} bName={b.name} title={`${a.name} & ${b.name}`} sub={`${routeLabel(bond.route)} · ${stageLabel(bond)}`} note="" />
                                );
                            })}
                        </div>
                    ) : <Empty text="角色之間私下聊過，或你用右上角的＋建一個，就會出現在這裡。" />
                )}
            </div>
        </div>
    );
};

const SpaceRow: React.FC<{ a?: string; b?: string; aName?: string; bName?: string; title: string; sub: string; note: string; dim?: boolean; onClick: () => void }> = ({ a, b, aName, bName, title, sub, note, dim, onClick }) => (
    <button type="button" onClick={onClick} className={`w-full flex items-center gap-3 py-3.5 text-left ${dim ? 'opacity-55' : ''}`}>
        <AvatarPair a={a} b={b} aName={aName} bName={bName} size={38} />
        <div className="min-w-0 flex-1">
            <div className="bond-serif text-[15px] truncate">{title}</div>
            <div className="mt-0.5 text-[12px] text-[var(--bond-ink-2)] truncate">{sub}</div>
        </div>
        {note && <div className="shrink-0 text-[11px] text-[var(--bond-muted)] tabular-nums">{note}</div>}
    </button>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
    <div className="mt-16 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)] px-6">{text}</div>
);

/** 「我眼中的我們」（你寫，角色看得到） */
const MineEditor: React.FC<{ space: ResolvedSpace; onBack: () => void; addToast: (m: string, t?: 'success' | 'error' | 'info') => void }> = ({ space, onBack, addToast }) => {
    const [text, setText] = useState(space.bond.ourNow?.user?.text || '');
    const save = async () => {
        try {
            await updateBond(space.id, b => ({ ...b, ourNow: { ...(b.ourNow || {}), user: text.trim() ? { text: text.trim(), at: Date.now() } : undefined } }));
            onBack();
        } catch (e: any) { addToast(`沒存成功：${e?.message || e}`, 'error'); }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="我眼中的我們" onBack={onBack} right={<button type="button" className="bond-btn bond-btn-primary !py-1.5" onClick={save}>存</button>} />
            <div className="flex-1 flex flex-col px-5 py-4">
                <div className="text-[12px] text-[var(--bond-muted)] mb-3">寫最近你們相處的樣子。這段 {space.rightName} 看得到，不必跟 TA 寫的一樣。</div>
                <textarea value={text} onChange={e => setText(e.target.value)} placeholder="最近我們……"
                    className="bond-serif flex-1 w-full resize-none bg-transparent outline-none text-[15px] leading-[1.9] text-[var(--bond-ink)]" />
            </div>
        </div>
    );
};

/** 建一個空間：我和角色（選身份卡、選角色），或角色之間（選兩位） */
const CreateSpacePage: React.FC<{
    chars: CharacterProfile[];
    profileBase: Parameters<typeof personaOptions>[0];
    initialKind: 'persona' | 'pair';
    onBack: () => void;
    onCreated: (id: string) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ chars, profileBase, initialKind, onBack, onCreated, addToast }) => {
    const [kind, setKind] = useState<'persona' | 'pair'>(initialKind);
    const personas = personaOptions(profileBase);
    const [personaKey, setPersonaKey] = useState(personas.find(p => p.isMain)?.key || personas[0].key);
    const [first, setFirst] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const list = chars
        .filter(c => (kind === 'persona' ? (c.knownPersonaKeys || []).includes(personaKey) : c.id !== first))
        .filter(c => !q || c.name.toLowerCase().includes(q) || (c.aliases || []).some(a => a.toLowerCase().includes(q)));

    const create = async (charId: string) => {
        try {
            if (kind === 'persona') {
                const id = personaBondId(charId, personaKey);
                const cur = bondOrBlank(id);
                const isNew = cur.openedBy === 'auto' && !allRegisteredBonds().some(b => b.id === id);
                await saveBondRecord({ ...cur, openedBy: isNew ? 'user' : cur.openedBy, openedAt: isNew ? Date.now() : cur.openedAt });
                if (isNew) {
                    // 你建的：私聊補一則小字，角色下一輪看得到（不強迫他回）
                    const c = chars.find(x => x.id === charId);
                    if (c) {
                        const view = lineView(c, lineFor(c, personaKey));
                        await DB.saveMessage({ ...lineMsgFields(view), role: 'system', type: 'text', content: '[系統: 你建了你們的羈絆空間]', timestamp: Date.now() } as any).catch(() => {});
                    }
                }
                trackEvent('建立羁绊空间', { 类型: '我和角色' });
                onCreated(id);
                return;
            }
            if (!first) { setFirst(charId); setQuery(''); return; }
            const id = pairBondId(first, charId);
            const cur = bondOrBlank(id);
            await saveBondRecord({ ...cur, openedBy: cur.openedBy === 'auto' ? 'user' : cur.openedBy });
            trackEvent('建立羁绊空间', { 类型: '角色之间' });
            onCreated(id);
        } catch (e: any) {
            addToast(`沒建成：${e?.message || e}`, 'error');
        }
    };

    const firstChar = first ? chars.find(c => c.id === first) : null;
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="建一個空間" onBack={first ? () => setFirst(null) : onBack} />
            <div className="shrink-0 px-5 pt-4">
                <div className="flex gap-2">
                    {([['persona', '我和角色'], ['pair', '角色之間']] as const).map(([k, label]) => (
                        <button key={k} type="button" className="bond-chip" aria-pressed={kind === k} onClick={() => { setKind(k); setFirst(null); }}>{label}</button>
                    ))}
                </div>
                {kind === 'persona' && personas.length > 1 && (
                    <div className="mt-4">
                        <SectionLabel>用 哪 張 身 份 卡</SectionLabel>
                        <div className="flex flex-wrap gap-2">
                            {personas.map(p => (
                                <button key={p.key} type="button" className="bond-chip" aria-pressed={personaKey === p.key} onClick={() => setPersonaKey(p.key)}>{p.name}</button>
                            ))}
                        </div>
                    </div>
                )}
                <div className="mt-4 text-[12px] text-[var(--bond-ink-2)]">
                    {kind === 'persona' ? `選一位認識「${personaNameForKey(profileBase, personaKey)}」的角色` : firstChar ? `再選一位：${firstChar.name} 和誰（什麼關係都行）` : '先選第一位'}
                </div>
                <label className="mt-2 flex items-center gap-2 bond-input !py-2">
                    <MagnifyingGlass size={15} className="text-[var(--bond-muted)]" />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder="找名字或別名" className="flex-1 bg-transparent outline-none text-[14px]" />
                </label>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-3">
                <div className="divide-y bond-hair border-y">
                    {list.map(c => (
                        <button key={c.id} type="button" onClick={() => create(c.id)} className="w-full flex items-center gap-3 py-3 text-left">
                            <BondAvatar value={c.avatar} name={c.name} size={40} />
                            <div className="bond-serif text-[15px] flex-1 truncate">{c.name}</div>
                        </button>
                    ))}
                    {!list.length && <div className="py-10 text-center text-[12.5px] text-[var(--bond-muted)]">沒有找到。</div>}
                </div>
            </div>
        </div>
    );
};

/** 編輯記憶：正文用時間線上那一列（有宮殿關聯時是宮殿最新正文），存走神經鏈接同一條路 */
const MemoryEditRoute: React.FC<{
    space: ResolvedSpace;
    chars: CharacterProfile[];
    memoryId: string;
    itemKey: string;
    embedding: React.ComponentProps<typeof BondMemoryEditor>['embedding'];
    remote: React.ComponentProps<typeof BondMemoryEditor>['remote'];
    updateCharacter: React.ComponentProps<typeof BondMemoryEditor>['updateCharacter'];
    onBack: () => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, chars, memoryId, itemKey, embedding, remote, updateCharacter, onBack, addToast }) => {
    const { items, char } = useSpaceTimeline(space, chars);
    const item = items.find(i => i.key === itemKey);
    if (!char || !item) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="編輯記憶" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這筆記憶已經不在了。</div>
            </div>
        );
    }
    return <BondMemoryEditor key={memoryId} char={char} memoryId={memoryId} currentText={item.text} embedding={embedding} remote={remote}
        updateCharacter={updateCharacter} onBack={onBack} addToast={addToast} />;
};

/** 分頁列：角色之間沒有心意；心意有新東西時點一個小點 */
const HeartTabs: React.FC<{ space: ResolvedSpace; value: BondTab; onChange: (t: BondTab) => void }> = ({ space, value, onChange }) => {
    const notice = useHeartNotice(space);
    const entries = useBondEntries(space.id);
    const pactDot = space.kind === 'persona' && value !== 'pact' && pactNeedsYou(entries);
    return <BondTabs value={value} onChange={onChange} tabs={bondTabsFor(space.kind)} dots={{ heart: !!notice && value !== 'heart', pact: pactDot }} />;
};

export default BondApp;
