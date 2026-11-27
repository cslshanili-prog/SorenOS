/**
 * 羈絆空間開了才有（plans/bond-open-spaces.md）的幾頁，全部全螢幕：
 * - 切換頁：點空間頂端的名字開；「我的故事」（身份卡 × 角色）／「他們的故事」（角色 × 角色）兩個分頁，
 *   列開著的空間；每一列的「⋯」能收起或刪除；底下「收起的」能再開；右上＋開一個新的。
 * - 歡迎頁：一個空間都還沒開時。
 * - 還沒開／收起了：從角色名片、聊天設定這些入口點進一個沒開的空間時。
 */
import React, { useState } from 'react';
import { CaretDown, CaretRight, DotsThree, Plus, X } from '@phosphor-icons/react';
import type { BondRecord, CharacterProfile, UserProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { AvatarPair, BondHeader, SectionLabel } from './bondUi';
import { isBondClosed, isBondOpen } from '../../utils/bond/openState';
import { primaryCounter } from '../../utils/bond/spaces';
import { routeLabel, stageLabel } from '../../utils/bond/routes';
import { isOnStage } from '../../utils/castRole';
import { personaNameForKey } from '../../utils/userPersona';

export type SpaceKind = 'persona' | 'pair';
type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

export const KIND_LABEL: Record<SpaceKind, string> = { persona: '我的故事', pair: '他們的故事' };

const titleOf = (s: ResolvedSpace) => (s.kind === 'pair' ? `${s.leftName} & ${s.rightName}` : s.rightName);

const Row: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    profileBase: UserProfile;
    showPersona: boolean;
    current?: boolean;
    closed?: boolean;
    onPick: () => void;
    onClose?: () => Promise<void>;
    onReopen?: () => Promise<void>;
    onDelete: () => Promise<void>;
}> = ({ space, characters, profileBase, showPersona, current, closed, onPick, onClose, onReopen, onDelete }) => {
    const [menu, setMenu] = useState<null | 'menu' | 'delete'>(null);
    const [busy, setBusy] = useState(false);
    const bond = space.bond;
    const counter = space.kind === 'persona' ? primaryCounter(bond, space.view?.acquaintanceStartDate, space.todayKey) : null;
    const offStage = [space.char, space.other].some(c => c && !isOnStage(characters.find(x => x.id === c.id) || c));
    const sub = [
        showPersona && space.personaKey ? personaNameForKey(profileBase, space.personaKey) : '',
        `${routeLabel(bond.route)}・${stageLabel(bond)}`,
        counter?.days != null ? `第 ${counter.days} 天` : '',
    ].filter(Boolean).join(' · ');
    const run = async (fn?: () => Promise<void>) => {
        if (!fn) return;
        setBusy(true);
        try { await fn(); setMenu(null); } finally { setBusy(false); }
    };
    return (
        <div className={`py-3 ${offStage || closed ? 'opacity-70' : ''}`}>
            <div className="flex items-center gap-3">
                <button type="button" onClick={onPick} className="min-w-0 flex-1 flex items-center gap-3 text-left">
                    <AvatarPair a={space.leftAvatar} b={space.rightAvatar} aName={space.leftName} bName={space.rightName} size={38} />
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                            <span className="bond-serif text-[15px] truncate">{titleOf(space)}</span>
                            {current && <span className="shrink-0 px-1.5 py-px rounded border border-[var(--bond-line)] text-[10px] text-[var(--bond-accent)]">現在</span>}
                        </span>
                        <span className="block mt-0.5 text-[12px] text-[var(--bond-ink-2)] truncate">{sub}</span>
                    </span>
                </button>
                <button type="button" aria-label={menu ? '收回' : '更多'} onClick={() => setMenu(menu ? null : 'menu')}
                    className="h-9 w-9 shrink-0 grid place-items-center rounded-full text-[var(--bond-muted)] active:bg-[var(--bond-paper-2)]">
                    {menu ? <X size={16} /> : <DotsThree size={20} weight="bold" />}
                </button>
            </div>
            {menu === 'menu' && (
                <div className="mt-2.5 ml-[50px] flex flex-wrap gap-2" ref={n => n?.scrollIntoView({ block: 'nearest' })}>
                    {closed
                        ? <button type="button" className="bond-btn text-[12.5px]" disabled={busy} onClick={() => void run(onReopen)}>再開</button>
                        : <button type="button" className="bond-btn text-[12.5px]" disabled={busy} onClick={() => void run(onClose)}>收起</button>}
                    <button type="button" className="bond-btn text-[12.5px]" disabled={busy} onClick={() => setMenu('delete')}>刪除</button>
                    {!closed && <p className="w-full text-[11px] leading-relaxed text-[var(--bond-muted)]">收起：東西都留著，背景功能（主動寫日記、約定判定…）停下來，之後能再開。</p>}
                </div>
            )}
            {menu === 'delete' && (
                <div className="mt-2.5 ml-[50px] rounded-xl border bond-hair bg-[var(--bond-card)] px-3.5 py-3" ref={n => n?.scrollIntoView({ block: 'nearest' })}>
                    <p className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                        刪掉這個空間？裡面的片刻、日記、約定、禮物、信{space.kind === 'pair' ? '、故事' : ''}都會刪掉，刪了找不回來。
                        聊天紀錄、{space.kind === 'persona' ? '交換日記、' : ''}行事曆的紀念日、每日總結的記憶不動。
                    </p>
                    <div className="mt-2.5 flex gap-2">
                        <button type="button" className="bond-btn flex-1" disabled={busy} onClick={() => setMenu(null)}>先不要</button>
                        <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy} onClick={() => void run(onDelete)}>{busy ? '刪除中…' : '刪掉'}</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export const BondSwitcherPage: React.FC<{
    bonds: BondRecord[];
    resolve: (id: string) => ResolvedSpace | null;
    characters: CharacterProfile[];
    profileBase: UserProfile;
    currentId?: string;
    initialKind: SpaceKind;
    onBack: () => void;
    onPick: (id: string) => void;
    onCreate: (kind: SpaceKind) => void;
    onClose: (s: ResolvedSpace) => Promise<void>;
    onReopen: (s: ResolvedSpace) => Promise<void>;
    onDelete: (s: ResolvedSpace) => Promise<void>;
    addToast: Toast;
}> = ({ bonds, resolve, characters, profileBase, currentId, initialKind, onBack, onPick, onCreate, onClose, onReopen, onDelete, addToast }) => {
    const [kind, setKind] = useState<SpaceKind>(initialKind);
    const [showClosed, setShowClosed] = useState(false);
    const of = (pred: (b: BondRecord) => boolean) => bonds.filter(b => b.kind === kind && pred(b))
        .map(b => resolve(b.id)).filter((s): s is ResolvedSpace => !!s)
        .sort((a, b) => (a.id === currentId ? -1 : b.id === currentId ? 1 : Math.max(b.bond.updatedAt, b.bond.openState?.at || 0) - Math.max(a.bond.updatedAt, a.bond.openState?.at || 0)));
    const open = of(isBondOpen);
    const closed = of(isBondClosed);
    const showPersona = new Set(open.concat(closed).map(s => s.personaKey).filter(Boolean)).size > 1;
    const wrap = (fn: (s: ResolvedSpace) => Promise<void>, s: ResolvedSpace, ok: string) => async () => {
        try { await fn(s); addToast(ok, 'success'); } catch (e: any) { addToast(`沒成功：${e?.message || e}`, 'error'); }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="羈絆" onBack={onBack}
                right={<button type="button" onClick={() => onCreate(kind)} aria-label="開一個新的" className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]"><Plus size={18} /></button>} />
            <div className="shrink-0 px-5">
                <div role="tablist" className="mt-3 flex gap-6 border-b bond-hair">
                    {(['persona', 'pair'] as const).map(k => (
                        <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                            className={`relative pb-2 text-[13.5px] ${kind === k ? 'bond-serif text-[var(--bond-ink)]' : 'text-[var(--bond-muted)]'}`}>
                            {KIND_LABEL[k]}
                            {kind === k && <span className="absolute left-0 right-0 -bottom-px h-[2px] bg-[var(--bond-accent)]" />}
                        </button>
                    ))}
                </div>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-8">
                {open.length ? (
                    <div className="mt-2 divide-y bond-hair border-b">
                        {open.map(s => (
                            <Row key={s.id} space={s} characters={characters} profileBase={profileBase} showPersona={showPersona} current={s.id === currentId}
                                onPick={() => onPick(s.id)} onClose={wrap(onClose, s, '收起了')} onDelete={wrap(onDelete, s, '刪掉了')} />
                        ))}
                    </div>
                ) : (
                    <div className="mt-14 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)] px-6">
                        {kind === 'persona' ? '還沒有你和角色的空間。' : '還沒有角色之間的空間。'}
                    </div>
                )}
                <button type="button" onClick={() => onCreate(kind)} className="mt-4 w-full bond-btn justify-center">
                    <Plus size={14} />{kind === 'persona' ? '開一個我的故事' : '開一個他們的故事'}
                </button>
                {closed.length > 0 && (
                    <section className="mt-8">
                        <button type="button" onClick={() => setShowClosed(v => !v)} className="w-full flex items-center justify-between">
                            <SectionLabel>收 起 的（{closed.length}）</SectionLabel>
                            {showClosed ? <CaretDown size={14} className="text-[var(--bond-muted)]" /> : <CaretRight size={14} className="text-[var(--bond-muted)]" />}
                        </button>
                        {showClosed && (
                            <div className="divide-y bond-hair border-y">
                                {closed.map(s => (
                                    <Row key={s.id} space={s} characters={characters} profileBase={profileBase} showPersona={showPersona} closed
                                        onPick={() => onPick(s.id)} onReopen={wrap(onReopen, s, '再開了')} onDelete={wrap(onDelete, s, '刪掉了')} />
                                ))}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </div>
    );
};

/** 一個空間都還沒開 */
export const BondWelcomePage: React.FC<{ onClose: () => void; onCreate: (kind: SpaceKind) => void }> = ({ onClose, onCreate }) => (
    <div className="absolute inset-0 flex flex-col bond-root">
        <div className="shrink-0 px-5" style={{ paddingTop: 'calc(var(--safe-top, 0px) + 12px)' }}>
            <button type="button" onClick={onClose} className="bond-note py-1">關閉</button>
        </div>
        <div className="flex-1 flex flex-col justify-center px-8 pb-16">
            <h1 className="bond-serif text-[30px] tracking-[0.2em]">羈絆</h1>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--bond-ink-2)]">
                留下你們經歷過的事，讓它們繼續參與往後的日子。<br />
                想留著的關係才需要一個空間：你自己開，或角色邀請你時答應；從聊天收存一件事也會幫你開。
            </p>
            <div className="mt-8 space-y-3">
                <button type="button" className="bond-btn bond-btn-primary w-full justify-center" onClick={() => onCreate('persona')}><Plus size={14} />開一個我的故事</button>
                <button type="button" className="bond-btn w-full justify-center" onClick={() => onCreate('pair')}><Plus size={14} />開一個他們的故事</button>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--bond-muted)]">我的故事：你的身份卡和一位角色。他們的故事：兩位角色之間，你是讀者。</p>
        </div>
    </div>
);

/** 從角色名片、聊天設定點進一個還沒開（或收起了）的空間 */
export const BondOpenAskPage: React.FC<{
    space: ResolvedSpace;
    onBack: () => void;
    onOpen: () => Promise<void>;
}> = ({ space, onBack, onOpen }) => {
    const [busy, setBusy] = useState(false);
    const closed = isBondClosed(space.bond);
    const who = space.kind === 'pair' ? `${space.leftName}和${space.rightName}` : `你和${space.rightName}`;
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="羈絆" onBack={onBack} />
            <div className="flex-1 flex flex-col items-center justify-center px-8 pb-16 text-center">
                <AvatarPair a={space.leftAvatar} b={space.rightAvatar} aName={space.leftName} bName={space.rightName} size={64} />
                <h2 className="mt-5 bond-serif text-[18px]">{closed ? `${who}的空間收起了` : `${who}還沒有羈絆空間`}</h2>
                <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                    {closed ? '東西都還在。再開之後，主動寫日記、約定判定這些背景功能也會跟著回來。'
                        : '開了之後會留下回憶、日記、約定和收藏；先選這段關係的路線。'}
                </p>
                <button type="button" className="mt-7 bond-btn bond-btn-primary" disabled={busy}
                    onClick={async () => { setBusy(true); try { await onOpen(); } finally { setBusy(false); } }}>
                    <Plus size={14} />{closed ? '再開' : '開一個'}
                </button>
            </div>
        </div>
    );
};
