/**
 * 羈絆（plans/bond.md、plans/bond-batch1.md）：一段關係的專屬空間。
 * 第 1 批：空間清單（我和 TA／他們之間）、「我們」首頁、路線設定、天數、此刻的我們、建立空間。
 * 第 2 批：拾光分頁（時間線、片刻、記憶的編輯刪除，plans/bond-batch2.md）。心意、約定、珍藏之後陸續出現（還沒做的不顯示）。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MagnifyingGlass, Plus } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID, type BondRecord, type CalendarEvent, type CharacterProfile } from '../types';
import { AvatarPair, BondAvatar, BondHeader, BondStyle, BondTabs, SectionLabel, type BondTab } from '../components/bond/bondUi';
import { BondMomentsPage } from '../components/bond/BondMomentsPage';
import { BondItemPage } from '../components/bond/BondItemPage';
import { BondMemoryEditor, BondMomentEditor } from '../components/bond/BondMomentEditor';
import { useSpaceTimeline } from '../components/bond/useSpaceTimeline';
import { BondSpacePage } from '../components/bond/BondSpacePage';
import { BondRoutePage } from '../components/bond/BondRoutePage';
import { BondDaysPage } from '../components/bond/BondDaysPage';
import { resolveSpace, type ResolvedSpace } from '../components/bond/space';
import { allRegisteredBonds, onBondRegistryChange } from '../utils/bond/registry';
import { listPairSpaces, listPersonaSpaces, primaryCounter } from '../utils/bond/spaces';
import { routeLabel, stageLabel } from '../utils/bond/routes';
import { pairBondId, personaBondId } from '../utils/bond/model';
import { bondOrBlank, saveBondRecord, updateBond } from '../utils/bond/store';
import { withLineFields, lineFor, lineView, lineMsgFields } from '../utils/chatLine';
import { personaAvatarForKey, personaNameForKey } from '../utils/userPersona';
import { personaOptions } from '../utils/calendarView';
import { isOnStage } from '../utils/castRole';
import { loadCalendarEvents } from '../utils/calendarEvents';
import { appReturn, bondLaunch } from '../utils/appLaunch';
import { DB } from '../utils/db';
import { trackEvent } from '../utils/analytics';

type Page =
    | { page: 'list' }
    | { page: 'space'; id: string; tab?: BondTab }
    | { page: 'item'; id: string; key: string }
    | { page: 'moment-edit'; id: string; entryId?: string; key?: string }
    | { page: 'memory-edit'; id: string; memoryId: string; key: string }
    | { page: 'route'; id: string; from: 'space' | 'list' }
    | { page: 'days'; id: string }
    | { page: 'mine'; id: string }
    | { page: 'create' };

const BondApp: React.FC = () => {
    const { closeApp, openApp, characters, userProfileBase, apiConfig, addToast, updateLine, updateCharacter, memoryPalaceConfig, remoteVectorConfig } = useOS();
    const [page, setPage] = useState<Page>(() => {
        // 先 peek、掛上後才 consume（跟行事曆同一招：開發模式重掛或 Suspense 重來時字條不會先被吃掉）
        const launch = bondLaunch.peek();
        if (!launch) return { page: 'list' };
        return launch.page === 'route' ? { page: 'route', id: launch.bondId, from: 'list' } : { page: 'space', id: launch.bondId };
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

    if (page.page === 'space' || page.page === 'route' || page.page === 'days' || page.page === 'mine'
        || page.page === 'item' || page.page === 'moment-edit' || page.page === 'memory-edit') {
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
        const tabBar = (current: BondTab) => <BondTabs value={current} onChange={t => setPage({ page: 'space', id: page.id, tab: t })} />;
        return (
            <div className="h-full w-full relative bond-root overflow-hidden">
                <BondStyle />
                {page.page === 'space' && page.tab === 'moments' && (
                    <BondMomentsPage space={s} characters={chars} tabBar={tabBar('moments')} onBack={back}
                        onOpenItem={openItem} onNewMoment={() => setPage({ page: 'moment-edit', id: s.id })} />
                )}
                {page.page === 'item' && (
                    <BondItemPage space={s} itemKey={page.key} characters={chars} onBack={toMoments}
                        onEditMoment={entryId => setPage({ page: 'moment-edit', id: s.id, entryId, key: page.key })}
                        onEditMemory={memoryId => setPage({ page: 'memory-edit', id: s.id, memoryId, key: page.key })}
                        updateCharacter={updateCharacter} addToast={addToast} />
                )}
                {page.page === 'moment-edit' && (
                    <BondMomentEditor space={s} entryId={page.entryId}
                        onBack={page.key ? () => openItem(page.key!) : toMoments}
                        onSaved={entry => openItem(`e:${entry.id}`)} addToast={addToast} />
                )}
                {page.page === 'memory-edit' && (
                    <MemoryEditRoute space={s} chars={chars} memoryId={page.memoryId} itemKey={page.key}
                        embedding={memoryPalaceConfig.embedding} remote={remoteVectorConfig}
                        updateCharacter={updateCharacter} onBack={() => openItem(page.key)} addToast={addToast} />
                )}
                {page.page === 'space' && page.tab !== 'moments' && (
                    <BondSpacePage key={`${s.id}-${version}`} space={s} characters={chars} events={events} apiConfig={apiConfig}
                        tabBar={tabBar('us')} onOpenItem={openItem}
                        onBack={back}
                        onOpenRoute={() => setPage({ page: 'route', id: s.id, from: 'space' })}
                        onOpenDays={() => setPage({ page: 'days', id: s.id })}
                        onEditMine={() => setPage({ page: 'mine', id: s.id })}
                        onAddAnniversary={() => { appReturn.set(AppID.Calendar, () => openApp(AppID.Bond)); bondLaunch.request({ bondId: s.id }); openApp(AppID.Calendar); }}
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

export default BondApp;
