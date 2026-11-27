/**
 * 從最近的聊天挑幾件（plans/bond-batch2.md 3.2）：讀這段關係還沒被挑過的訊息，讓 AI 挑 3～5 件值得留下的小事，
 * 每件附原訊息；你勾哪幾件就收存哪幾件，沒勾的不留。不會自己默默收存。
 * 身份卡 × 角色讀私聊那條線（見面的訊息不算，見面從見面裡收）；角色 × 角色讀他們的私聊。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Check, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile, Message } from '../../types';
import { BondHeader } from './bondUi';
import type { ResolvedSpace } from './space';
import { loadCollectLine, storyDateKeyMaker } from './BondCollectPage';
import {
    buildCollectSnippet, buildMomentPickPrompt, defaultEventDate, numberedTranscript, parseMomentPick, unscannedMessages,
    type BondCollectRequest, type MomentCandidate, type PickGiftRef,
} from '../../utils/bond/collect';
import { addFollowup, buildGiftViews, newGift, overlayForOrder, type GiftView } from '../../utils/bond/gift';
import { bondEntriesOf } from '../../utils/bond/entryRegistry';
import { giftOrdersOfLine } from '../../utils/bond/giftOrderRegistry';
import { refreshAchievements } from './pactRun';
import { newBondEntryId, saveBondEntries } from '../../utils/bond/entries';
import { bondOrBlank, updateBond } from '../../utils/bond/store';
import { lineFor, lineKey } from '../../utils/chatLine';
import { pairSpeakerOf } from '../../utils/pairLine';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { formatEventDate } from '../../utils/bond/eventDate';
import { collectedPactEntry, parseRepeat } from '../../utils/bond/pactTags';
import { repeatLabel } from '../../utils/bond/pact';
import { trackEvent } from '../../utils/analytics';

const SCAN_LIMIT = 120;

export const BondPickPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    onBack: () => void;
    onSaved: (entries: BondEntry[]) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, characters, apiConfig, onBack, onSaved, addToast }) => {
    const isPair = space.kind === 'pair';
    const lineId = isPair ? space.id : lineKey(lineFor(space.char, space.personaKey));
    const [batch, setBatch] = useState<Message[] | null>(null);
    const [candidates, setCandidates] = useState<MomentCandidate[] | null>(null);
    const [chosen, setChosen] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState<'pick' | 'save' | null>(null);
    const [error, setError] = useState('');
    // 挑的時候給 AI 對的圖鑑（禮物後續照 key 找回那件）
    const [giftViews, setGiftViews] = useState<GiftView[]>([]);

    const nameOf = (m: Pick<Message, 'role' | 'charId' | 'metadata'>): string => {
        if (isPair) return characters.find(c => c.id === pairSpeakerOf(m))?.name || '某人';
        if (m.role === 'user') return space.leftName;
        if (m.role === 'assistant') return space.rightName;
        return '旁白';
    };
    const toKey = useMemo(() => storyDateKeyMaker(space, isPair ? 'pair' : 'chat'), [space, isPair]);

    const pick = async () => {
        const api = globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);
        if (!api) { setError('還沒設定 API'); return; }
        setBusy('pick');
        setError('');
        try {
            const req: Pick<BondCollectRequest, 'kind' | 'lineId'> = { kind: isPair ? 'pair' : 'chat', lineId };
            const line = (await loadCollectLine(req)).filter(m => (m as any).source !== 'date' && !m.metadata?.dateStoryId && m.type !== 'system');
            const fresh = unscannedMessages(line, bondOrBlank(space.id).lastMomentScanId, SCAN_LIMIT);
            setBatch(fresh);
            if (!fresh.length) { setCandidates([]); return; }
            // 身份卡 × 角色：已經送出的禮物給 AI 對，說到它們後來怎麼了就挑成「禮物後續」
            const views = isPair ? [] : buildGiftViews({ orders: giftOrdersOfLine(space.char.id, lineId), entries: bondEntriesOf(space.id), forViewer: 'user' })
                .filter(v => v.state === 'given' && !v.secret);
            setGiftViews(views);
            const giftRefs: PickGiftRef[] = views.map(v => ({ key: v.key, title: v.title, dir: v.dir }));
            const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
                body: JSON.stringify({
                    model: api.model,
                    messages: [{ role: 'user', content: buildMomentPickPrompt({ transcript: numberedTranscript(fresh, nameOf), leftName: space.leftName, rightName: space.rightName, withPact: !isPair, gifts: giftRefs }) }],
                    temperature: 0.5,
                    max_tokens: 1500,
                }),
            }, 1, 90_000, { appName: '羈絆', charId: space.char.id, charName: space.char.name, purpose: '挑選片刻' });
            const found = parseMomentPick(extractContent(data), fresh, giftRefs).filter(c => c.messageIds.length);
            setCandidates(found);
            setChosen(new Set(found.map((_, i) => i)));
        } catch (e: any) {
            setError(e?.message || '這次沒挑出來，再試一次');
        } finally {
            setBusy(null);
        }
    };

    useEffect(() => { void pick(); },
        // 進來就挑一次
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []);

    const markScanned = async () => {
        const last = batch?.[batch.length - 1]?.id;
        if (last) await updateBond(space.id, b => ({ ...b, lastMomentScanId: Math.max(b.lastMomentScanId || 0, last) }));
    };

    const save = async () => {
        if (!candidates || !batch) return;
        setBusy('save');
        try {
            const now = Date.now();
            const byId = new Map(batch.map(m => [m.id, m]));
            // 禮物後續疊在那件的卡上（同一件挑到好幾筆就疊在同一張）；購物中心的單第一次補東西要先開一張疊上去的卡
            const touched = new Map<string, BondEntry>();
            const picked = candidates.filter((_, i) => chosen.has(i));
            for (const c of picked) {
                if (c.kind !== 'giftFollowup' || isPair) continue;
                const v = giftViews.find(g => g.key === c.giftKey);
                if (!v) continue;
                const base = touched.get(v.key) || v.entry || (v.order ? overlayForOrder(space.id, v.order, now) : undefined);
                if (!base) continue;
                const msgs = c.messageIds.map(id => byId.get(id)).filter(Boolean) as Message[];
                const at = msgs[0]?.timestamp || now;
                touched.set(v.key, addFollowup(base, {
                    by: 'user', text: c.text,
                    source: { type: 'message', lineId, messageIds: c.messageIds, snippet: buildCollectSnippet(msgs, nameOf, 600), at },
                }, now));
            }
            const entries: BondEntry[] = picked.filter(c => c.kind !== 'giftFollowup').map(c => {
                const msgs = c.messageIds.map(id => byId.get(id)).filter(Boolean) as Message[];
                const at = msgs[0]?.timestamp || now;
                const source = { type: 'message' as const, lineId, messageIds: c.messageIds, snippet: buildCollectSnippet(msgs, nameOf, 600), at };
                // 禮物（第 5 批）：購物中心以外的；方向沒寫就照說出口的那方
                if (c.kind === 'gift' && !isPair) {
                    const dir = c.dir || (msgs[0]?.role === 'user' ? 'out' : 'in');
                    const title = c.title || c.text.slice(0, 20);
                    const g = newGift({
                        bondId: space.id, dir, state: 'given', title, text: c.text, occasion: c.occasion, givenAt: at, now,
                        items: [{ name: title, price: 0, qty: 1 }],
                    });
                    return { ...g, eventDate: defaultEventDate(msgs[0] ? [toKey(msgs[0].timestamp)] : []), sources: [source], createdBy: 'ai' as const };
                }
                // 願望、約定、默契（第 4 批）：願望照誰的記、約定與默契是提議中
                if (c.kind && c.kind !== 'moment' && c.kind !== 'gift' && c.kind !== 'giftFollowup' && !isPair) {
                    return collectedPactEntry({
                        kind: c.kind, bondId: space.id, charId: space.char.id, text: c.text,
                        owner: c.owner || (msgs[0]?.role === 'user' ? 'user' : 'char'), repeat: parseRepeat(c.freq), now,
                        source: { type: 'message', lineId, messageIds: c.messageIds, snippet: buildCollectSnippet(msgs, nameOf, 600), at },
                    });
                }
                return {
                    id: newBondEntryId(), bondId: space.id, kind: 'moment', author: 'user',
                    title: c.title || undefined, text: c.text,
                    eventDate: defaultEventDate(msgs[0] ? [toKey(msgs[0].timestamp)] : []),
                    writtenAt: now,
                    sources: [{ type: 'message', lineId, messageIds: c.messageIds, snippet: buildCollectSnippet(msgs, nameOf, 600), at }],
                    links: [], status: 'published', createdBy: 'ai', updatedAt: now,
                };
            });
            const followed = [...touched.values()];
            const saved = await saveBondEntries([...entries, ...followed]);
            await markScanned();
            const followedIds = new Set(followed.map(e => e.id));
            const added = saved.filter(e => !followedIds.has(e.id));
            for (const e of followed) trackEvent('羁绊礼物', { 动作: '后续', 方向: e.gift?.dir === 'out' ? '我送' : 'TA送', 来源: 'AI挑选' });
            if (followed.length || added.some(e => e.kind === 'gift')) void refreshAchievements(space).catch(() => undefined);
            for (const e of added) {
                if (e.kind === 'gift') trackEvent('羁绊礼物', { 动作: '记下', 方向: e.gift?.dir === 'out' ? '我送' : 'TA送', 来源: 'AI挑选' });
                else if (e.kind === 'moment') trackEvent('收存拾光片刻', { 来源: 'AI挑选' });
                else if (e.kind === 'wish') trackEvent('写羁绊愿望', { 谁: '我', 类型: e.wish?.owner === 'both' ? '我们的' : e.wish?.owner === 'user' ? '我的' : 'TA的', 方式: '收存' });
                else if (e.kind === 'promise') trackEvent('羁绊约定', { 动作: '新增', 来源: '收存', 计分: e.promise?.points ? '是' : '否' });
                else if (e.kind === 'habit') trackEvent('羁绊默契', { 动作: '提议', 谁: '我' });
            }
            const n = added.length + picked.filter(c => c.kind === 'giftFollowup' && touched.has(c.giftKey || '')).length;
            addToast(n ? `收存了 ${n} 件` : '這次都沒留，下次從更新的聊天挑', 'success');
            onSaved(saved);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(null);
        }
    };

    const snippetOf = (c: MomentCandidate) => {
        const byId = new Map((batch || []).map(m => [m.id, m]));
        return buildCollectSnippet(c.messageIds.map(id => byId.get(id)).filter(Boolean) as Message[], nameOf, 300);
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="從最近的聊天挑幾件" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    {isPair ? `從 ${space.leftName} 和 ${space.rightName} 最近私下聊的` : `從你和 ${space.rightName} 最近的私聊`}裡挑，上次挑過的不會再挑。勾起來的才會收存{isPair ? '' : '；約定和默契存了是提議中，要對方說好；禮物後續會記在圖鑑那件上'}。
                </p>
                {busy === 'pick' && <div className="mt-10 text-center text-[13px] text-[var(--bond-muted)]">翻著最近的聊天…</div>}
                {error && (
                    <div className="mt-8 text-center">
                        <div className="text-[13px] text-[var(--bond-ink-2)]">{error}</div>
                        <button type="button" className="bond-btn mt-3" onClick={() => void pick()}><Sparkle size={14} />再挑一次</button>
                    </div>
                )}
                {candidates && !busy && !error && (
                    candidates.length === 0 ? (
                        <div className="mt-10 text-center text-[13px] leading-relaxed text-[var(--bond-muted)]">
                            {batch?.length ? '這段聊天裡沒挑到想留的。' : '上次挑過之後還沒有新的聊天。'}
                        </div>
                    ) : (
                        <div className="mt-5 divide-y bond-hair border-y">
                            {candidates.map((c, i) => {
                                const on = chosen.has(i);
                                const msgs = c.messageIds;
                                const first = (batch || []).find(m => m.id === msgs[0]);
                                return (
                                    <button key={i} type="button" aria-pressed={on}
                                        onClick={() => setChosen(prev => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next; })}
                                        className="w-full text-left py-4 flex gap-3">
                                        <span className={`mt-1 h-4 w-4 shrink-0 rounded-[4px] border grid place-items-center ${on ? 'bg-[var(--bond-accent)] border-[var(--bond-accent)] text-[#fbf7f0]' : 'border-[var(--bond-rose)]'}`}>
                                            {on && <Check size={11} weight="bold" />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            {c.kind && c.kind !== 'moment' && (
                                                <span className="inline-block mb-1 px-1.5 py-px rounded border border-[var(--bond-line)] text-[10.5px] text-[var(--bond-accent)]">
                                                    {c.kind === 'wish' ? `${c.owner === 'both' ? '我們' : c.owner === 'user' ? '我' : space.rightName}的願望`
                                                        : c.kind === 'promise' ? `約定・${repeatLabel(parseRepeat(c.freq))}`
                                                        : c.kind === 'gift' ? `禮物・${c.dir === 'in' ? `${space.rightName}送的` : c.dir === 'out' ? '我送的' : '誰送的看不出來'}${c.occasion ? `・${c.occasion}` : ''}`
                                                        : c.kind === 'giftFollowup' ? `禮物後續・${giftViews.find(g => g.key === c.giftKey)?.title || c.title}`
                                                        : '默契'}
                                                </span>
                                            )}
                                            {c.title && <span className="bond-serif block text-[15px]">{c.title}</span>}
                                            <span className="block mt-0.5 text-[13.5px] leading-relaxed">{c.text}</span>
                                            {first && <span className="block mt-1 text-[11px] text-[var(--bond-muted)]">{formatEventDate(defaultEventDate([toKey(first.timestamp)]))}</span>}
                                            <span className="block mt-2 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--bond-ink-2)] border-l-2 border-[var(--bond-line)] pl-2.5">{snippetOf(c)}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )
                )}
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>先不要</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!candidates || !!busy || !!error || !batch?.length}
                    onClick={save}>{busy === 'save' ? '存檔中…' : chosen.size ? `收存 ${chosen.size} 件` : '都不留'}</button>
            </div>
        </div>
    );
};
