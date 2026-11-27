/**
 * 從聊天收存片刻（plans/bond-batch2.md 3.1）：私聊、見面、角色私聊按「收存到羈絆」帶過來的那幾則。
 * 可以往前往後多帶幾則、寫標題、讓 AI 濃縮一兩句「發生了什麼」、補一句想留著的原因、改日期（預設是那則的故事日期）。
 * 存的時候記來源（訊息 id＋原文快照），之後點得回去；原訊息刪了也讀得到快照。
 */
import { ensureSpaceOpen } from '../../utils/bond/store';
import React, { useEffect, useMemo, useState } from 'react';
import { CaretDown, CaretUp, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondEventDate, BondPromiseRepeat, BondSource, CharacterProfile, Message } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import { BondDateField } from './BondDateField';
import type { ResolvedSpace } from './space';
import { DB } from '../../utils/db';
import {
    buildCollectSnippet, buildGiftFillPrompt, buildMomentSummaryPrompt, buildPactFillPrompt, cleanSummary, defaultEventDate, extendSelection, lineArgFromKey, messagePlainText, parseGiftFill, parsePactFill, sortById,
    type BondCollectRequest, type CollectKind,
} from '../../utils/bond/collect';
import { collectedPactEntry, parseRepeat } from '../../utils/bond/pactTags';
import { repeatLabel } from '../../utils/bond/pact';
import { newBondEntryId, saveBondEntry } from '../../utils/bond/entries';
import { newGift } from '../../utils/bond/gift';
import { GIFT_OCCASIONS } from './BondGiftPages';
import { refreshAchievements } from './pactRun';
import { parsePairLineId, pairSpeakerOf } from '../../utils/pairLine';
import { makeChatClock, makeDateClock } from '../../utils/dateStoryTime';
import { getLocalDateKey } from '../../utils/localDate';
import { nowInTimeZone, resolveCharTimeZone } from '../../utils/timezone';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { trackEvent } from '../../utils/analytics';
import { parseDateBody } from '../../utils/dateVoiceTags';
import { extractObservation } from '../../utils/dateObserve';

/** 見面的訊息：角色那段拿掉觀測卡、語音標籤，只留正文；你那段拿掉 [動作] 這類標記。其他照一般聊天 */
export function collectTextOf(kind: BondCollectRequest['kind']): (m: Pick<Message, 'type' | 'content' | 'metadata' | 'role'>) => string {
    if (kind !== 'date') return messagePlainText;
    return m => {
        if (m.type !== 'text') return messagePlainText(m);
        const raw = String(m.content || '');
        if (m.role === 'user') return raw.replace(/\[.*?\]/g, '').trim();
        const rest = extractObservation(raw, { lenient: true }).rest;
        return parseDateBody(rest).map(l => l.text).join(' ').replace(/\s+/g, ' ').trim() || messagePlainText(m);
    };
}

const SOURCE_EVENT = { chat: '私聊', date: '见面', pair: '角色私聊' } as const;

const KIND_LABEL: Record<CollectKind, string> = { moment: '片刻', wish: '願望', promise: '約定', habit: '默契', gift: '禮物' };
const SIMPLE_REPEATS: BondPromiseRepeat[] = [{ kind: 'once' }, { kind: 'daily' }, { kind: 'weekly' }, { kind: 'monthly' }];
const sameRepeat = (a: BondPromiseRepeat, b: BondPromiseRepeat) => JSON.stringify(a) === JSON.stringify(b);

/** 讀這次收存要用的整條線（已照 id 排好；見面只留這場故事） */
export async function loadCollectLine(req: Pick<BondCollectRequest, 'kind' | 'lineId' | 'storyId'>): Promise<Message[]> {
    if (req.kind === 'pair') {
        const pair = parsePairLineId(req.lineId);
        if (!pair) return [];
        const all = await DB.getMessagesByCharId(req.lineId, true);
        return sortById(all);
    }
    const all = await DB.getMessagesByCharId(lineArgFromKey(req.lineId), true);
    const list = req.kind === 'date' ? all.filter(m => m.metadata?.dateStoryId === req.storyId) : all;
    return sortById(list.filter(m => m.type !== 'system' || !!m.content));
}

/** 時間戳 → 這段關係的故事日期 key（私聊照私聊時鐘、見面照那場的時鐘、角色私聊照真實） */
export function storyDateKeyMaker(space: ResolvedSpace, kind: BondCollectRequest['kind'], story?: Parameters<typeof makeDateClock>[1]): (ts: number) => string {
    if (kind === 'pair' || !space.view) return ts => getLocalDateKey(new Date(ts));
    const view = space.view;
    const clock = kind === 'date' ? makeDateClock(view, story) : makeChatClock(view);
    const tz = resolveCharTimeZone(view);
    return ts => getLocalDateKey(nowInTimeZone(tz, new Date(clock && !clock.off ? clock.map(ts) : ts)));
}

export const BondCollectPage: React.FC<{
    space: ResolvedSpace;
    request: BondCollectRequest;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    onDone: (entry: BondEntry | null) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, request, characters, apiConfig, onDone, addToast }) => {
    const [line, setLine] = useState<Message[] | null>(null);
    const [before, setBefore] = useState(0);
    const [after, setAfter] = useState(0);
    const [title, setTitle] = useState('');
    const [text, setText] = useState('');
    const [note, setNote] = useState('');
    const [date, setDate] = useState<BondEventDate | null>(null);
    const [busy, setBusy] = useState<'summary' | 'save' | null>(null);
    // 收成什麼（第 4 批）：願望、約定、默契只在身份卡 × 角色
    const canPact = space.kind === 'persona';
    const [kind, setKind] = useState<CollectKind>('moment');
    const [owner, setOwner] = useState<'user' | 'char' | 'both' | null>(null);
    const [repeat, setRepeat] = useState<BondPromiseRepeat>({ kind: 'once' });
    // 收成禮物（第 5 批）：誰送誰、是什麼、場合
    const [giftDir, setGiftDir] = useState<'out' | 'in' | null>(null);
    const [occasion, setOccasion] = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            const msgs = await loadCollectLine(request).catch(() => [] as Message[]);
            const story = request.kind === 'date' && request.storyId ? await DB.getDateStory(request.storyId).catch(() => undefined) : undefined;
            if (!alive) return;
            setLine(msgs);
            const toKey = storyDateKeyMaker(space, request.kind, story);
            const first = msgs.find(m => request.messageIds.includes(m.id));
            setDate(defaultEventDate(first ? [toKey(first.timestamp)] : []));
        })();
        return () => { alive = false; };
    }, [request, space]);

    const ids = useMemo(() => (line ? extendSelection(line, request.messageIds, before, after) : request.messageIds), [line, request.messageIds, before, after]);
    const picked = useMemo(() => (line || []).filter(m => ids.includes(m.id)), [line, ids]);

    const nameOf = (m: Pick<Message, 'role' | 'charId' | 'metadata'>): string => {
        if (request.kind === 'pair') {
            const speaker = pairSpeakerOf(m);
            return characters.find(c => c.id === speaker)?.name || '某人';
        }
        if (m.role === 'user') return space.leftName;
        if (m.role === 'assistant') return space.rightName;
        return '旁白';
    };
    const textOf = useMemo(() => collectTextOf(request.kind), [request.kind]);
    const snippet = useMemo(() => buildCollectSnippet(picked, nameOf, 900, textOf),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [picked]);

    // 願望預設是說出口的那方：選到的第一則是誰說的
    const defaultOwner: 'user' | 'char' = picked.find(m => request.messageIds.includes(m.id))?.role === 'user' ? 'user' : 'char';
    const wishOwner = owner || defaultOwner;
    // 禮物預設照說出口的那方：你說「我織了圍巾給你」是你送的
    const dirOfGift: 'out' | 'in' = giftDir || (defaultOwner === 'user' ? 'out' : 'in');

    const summarize = async () => {
        const api = globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);
        if (!api) { addToast('還沒設定 API', 'error'); return; }
        if (kind === 'gift') { await fillGift(api); return; }
        if (kind !== 'moment') { await fillPact(api); return; }
        setBusy('summary');
        try {
            const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
                body: JSON.stringify({
                    model: api.model,
                    messages: [{ role: 'user', content: buildMomentSummaryPrompt({ snippet, leftName: space.leftName, rightName: space.rightName }) }],
                    temperature: 0.4,
                    max_tokens: 300,
                }),
            }, 1, 60_000, { appName: '羈絆', charId: space.char.id, charName: space.char.name, purpose: '片刻摘要' });
            const out = cleanSummary(extractContent(data));
            if (!out) throw new Error('這次沒寫出東西，再試一次');
            setText(out);
        } catch (e: any) {
            addToast(e?.message || '沒寫出來', 'error');
        } finally {
            setBusy(null);
        }
    };

    /** AI 幫忙填禮物：誰送誰、什麼、場合、一兩句；看不出來的留空 */
    const fillGift = async (api: { baseUrl: string; apiKey: string; model: string }) => {
        setBusy('summary');
        try {
            const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
                body: JSON.stringify({
                    model: api.model,
                    messages: [{ role: 'user', content: buildGiftFillPrompt({ snippet, leftName: space.leftName, rightName: space.rightName }) }],
                    temperature: 0.3,
                    max_tokens: 300,
                }),
            }, 1, 60_000, { appName: '羈絆', charId: space.char.id, charName: space.char.name, purpose: '收存禮物' });
            const out = parseGiftFill(extractContent(data));
            if (!out) throw new Error('這段看不太出來，自己寫寫看');
            if (out.title) setTitle(out.title);
            if (out.text) setText(out.text);
            if (out.dir) setGiftDir(out.dir);
            if (out.occasion) setOccasion(out.occasion);
            if (!out.title) addToast('看不出是什麼東西，留給你補', 'info');
        } catch (e: any) {
            addToast(e?.message || '沒寫出來', 'error');
        } finally {
            setBusy(null);
        }
    };

    /** AI 幫忙填願望、約定、默契的欄位：只照那幾則寫，看不出來的留空讓你補 */
    const fillPact = async (api: { baseUrl: string; apiKey: string; model: string }) => {
        if (kind === 'moment' || kind === 'gift') return;
        setBusy('summary');
        try {
            const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
                body: JSON.stringify({
                    model: api.model,
                    messages: [{ role: 'user', content: buildPactFillPrompt({ kind, snippet, leftName: space.leftName, rightName: space.rightName }) }],
                    temperature: 0.3,
                    max_tokens: 300,
                }),
            }, 1, 60_000, { appName: '羈絆', charId: space.char.id, charName: space.char.name, purpose: `收存${KIND_LABEL[kind]}` });
            const out = parsePactFill(extractContent(data));
            if (!out) throw new Error('這段看不太出來，自己寫寫看');
            if (out.text) setText(out.text);
            if (kind === 'wish' && out.owner) setOwner(out.owner);
            if (kind === 'promise' && out.freq) setRepeat(parseRepeat(out.freq));
            if (!out.text) addToast('內容看不出來，留給你補', 'info');
        } catch (e: any) {
            addToast(e?.message || '沒寫出來', 'error');
        } finally {
            setBusy(null);
        }
    };

    const save = async () => {
        if (!date || !picked.length) return;
        setBusy('save');
        try {
            // 從聊天收存＝你想留著：空間還沒開就幫你開（plans/bond-open-spaces.md）
            const { opened } = await ensureSpaceOpen(request.bondId, 'collect');
            if (opened) {
                trackEvent('羁绊空间开关', { 动作: '开启', 类型: space.kind === 'pair' ? '角色之间' : '我和角色', 方式: '收存' });
                addToast(`開了${space.kind === 'pair' ? `${space.leftName}和${space.rightName}` : `你和${space.rightName}`}的羈絆空間`, 'info');
            }
            const now = Date.now();
            const at = picked[0].timestamp;
            const source: BondSource = request.kind === 'date'
                ? { type: 'date', storyId: request.storyId || '', charId: request.charId, messageIds: ids, snippet, at }
                : { type: 'message', lineId: request.lineId, messageIds: ids, snippet, at };
            if (kind === 'gift') {
                const base = newGift({
                    bondId: request.bondId, dir: dirOfGift, state: 'given', title: title.trim(),
                    text: text.trim() || title.trim(), occasion, givenAt: at, now,
                    items: title.trim() ? [{ name: title.trim(), price: 0, qty: 1 }] : undefined,
                });
                const entry = await saveBondEntry({ ...base, eventDate: date, sources: [source] });
                trackEvent('羁绊礼物', { 动作: '记下', 方向: dirOfGift === 'out' ? '我送' : 'TA送', 来源: '收存' });
                void refreshAchievements(space).catch(() => undefined);
                addToast('收存好了，在羈絆的珍藏裡', 'success');
                onDone(entry);
                return;
            }
            if (kind !== 'moment') {
                const entry = await saveBondEntry(collectedPactEntry({
                    kind, bondId: request.bondId, charId: space.char.id, text: text.trim(), owner: wishOwner, repeat, source, now,
                }));
                if (kind === 'wish') trackEvent('写羁绊愿望', { 谁: '我', 类型: wishOwner === 'both' ? '我们的' : wishOwner === 'user' ? '我的' : 'TA的', 方式: '收存' });
                else if (kind === 'promise') trackEvent('羁绊约定', { 动作: '新增', 来源: '收存', 计分: entry.promise?.points ? '是' : '否' });
                else trackEvent('羁绊默契', { 动作: '提议', 谁: '我' });
                addToast(kind === 'wish' ? '收存好了，在羈絆的約定裡' : `收存好了，等${space.rightName}說好`, 'success');
                onDone(entry);
                return;
            }
            const fallbackText = picked.map(m => textOf(m)).join(' ').slice(0, 200);
            const entry = await saveBondEntry({
                id: newBondEntryId(), bondId: request.bondId, kind: 'moment', author: 'user',
                title: title.trim() || undefined,
                text: text.trim() || fallbackText,
                note: note.trim() || undefined,
                eventDate: date, writtenAt: now, sources: [source], links: [], status: 'published', createdBy: 'user', updatedAt: now,
            });
            trackEvent('收存拾光片刻', { 来源: SOURCE_EVENT[request.kind] });
            addToast('收存好了，在羈絆的拾光裡', 'success');
            onDone(entry);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(null);
        }
    };

    const periodMissingLabel = date?.precision === 'period' && !date.label.trim();

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={kind === 'moment' ? '收存一個片刻' : `收存成${KIND_LABEL[kind]}`} onBack={() => onDone(null)} backLabel="取消" />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                {canPact && (
                    <section>
                        <SectionLabel>收 成</SectionLabel>
                        <div className="flex flex-wrap gap-2">
                            {(Object.keys(KIND_LABEL) as CollectKind[]).map(k => (
                                <button key={k} type="button" className="bond-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
                            ))}
                        </div>
                    </section>
                )}
                <section>
                    <SectionLabel right={<span className="text-[11px] text-[var(--bond-muted)]">{picked.length} 則</span>}>選 到 的</SectionLabel>
                    <button type="button" className="bond-chip mb-2" onClick={() => setBefore(b => b + 1)}><CaretUp size={11} className="mr-1" />往前多帶一則</button>
                    {before > 0 && <button type="button" className="bond-chip mb-2 ml-2" onClick={() => setBefore(b => Math.max(0, b - 1))}>少帶一則</button>}
                    <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3 space-y-2">
                        {line === null ? (
                            <div className="text-[12.5px] text-[var(--bond-muted)]">讀取中…</div>
                        ) : picked.length === 0 ? (
                            <div className="text-[12.5px] text-[var(--bond-muted)]">找不到這幾則訊息（可能已經刪掉了）。</div>
                        ) : picked.map(m => (
                            <div key={m.id} className={`text-[13px] leading-relaxed ${request.messageIds.includes(m.id) ? '' : 'opacity-60'}`}>
                                <span className="text-[var(--bond-muted)]">{nameOf(m)}：</span>
                                <span className="bond-serif whitespace-pre-wrap">{textOf(m)}</span>
                            </div>
                        ))}
                    </div>
                    <button type="button" className="bond-chip mt-2" onClick={() => setAfter(a => a + 1)}><CaretDown size={11} className="mr-1" />往後多帶一則</button>
                    {after > 0 && <button type="button" className="bond-chip mt-2 ml-2" onClick={() => setAfter(a => Math.max(0, a - 1))}>少帶一則</button>}
                </section>

                {kind === 'gift' && (
                    <>
                        <section>
                            <SectionLabel right={
                                <button type="button" onClick={summarize} disabled={!!busy || !picked.length} className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1 disabled:opacity-40">
                                    <Sparkle size={12} />{busy === 'summary' ? '寫著…' : '讓 AI 幫我填'}
                                </button>
                            }>誰 送 誰</SectionLabel>
                            <div className="flex flex-wrap gap-2">
                                {([['out', `我送${space.rightName}`], ['in', `${space.rightName}送我`]] as const).map(([v, label]) => (
                                    <button key={v} type="button" className="bond-chip" aria-pressed={dirOfGift === v} onClick={() => setGiftDir(v)}>{label}</button>
                                ))}
                            </div>
                            <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">購物中心買的會自己出現在圖鑑，這裡收的是其他的禮物。</div>
                        </section>
                        <section>
                            <SectionLabel>是 什 麼</SectionLabel>
                            <input className="bond-input bond-serif" value={title} maxLength={40} placeholder="像「手織的圍巾」" onChange={e => setTitle(e.target.value)} />
                        </section>
                        <section>
                            <SectionLabel>場 合</SectionLabel>
                            <div className="flex flex-wrap gap-2">
                                {GIFT_OCCASIONS.map(o => (
                                    <button key={o} type="button" className="bond-chip" aria-pressed={occasion === o} onClick={() => setOccasion(occasion === o ? '' : o)}>{o}</button>
                                ))}
                                {occasion && !GIFT_OCCASIONS.includes(occasion) && <button type="button" className="bond-chip" aria-pressed onClick={() => setOccasion('')}>{occasion}</button>}
                            </div>
                        </section>
                        <section>
                            <SectionLabel>那 時 候</SectionLabel>
                            <textarea className="bond-input bond-serif min-h-[84px] leading-relaxed" value={text} maxLength={300}
                                placeholder="可以不填；只寫發生了什麼" onChange={e => setText(e.target.value)} />
                        </section>
                        {date && (
                            <section>
                                <SectionLabel>什 麼 時 候</SectionLabel>
                                <BondDateField value={date} onChange={setDate} todayKey={space.todayKey} />
                            </section>
                        )}
                    </>
                )}
                {kind !== 'moment' && kind !== 'gift' && (
                    <>
                        {kind === 'wish' && (
                            <section>
                                <SectionLabel>誰 的 願 望</SectionLabel>
                                <div className="flex flex-wrap gap-2">
                                    {([['user', '我的'], ['char', `${space.rightName}的`], ['both', '我們的']] as const).map(([v, label]) => (
                                        <button key={v} type="button" className="bond-chip" aria-pressed={wishOwner === v} onClick={() => setOwner(v)}>{label}</button>
                                    ))}
                                </div>
                                <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">預設是說出口的那方。收存不等於說好一起做，要一起做再「談成約定」。</div>
                            </section>
                        )}
                        <section>
                            <SectionLabel right={
                                <button type="button" onClick={summarize} disabled={!!busy || !picked.length} className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1 disabled:opacity-40">
                                    <Sparkle size={12} />{busy === 'summary' ? '寫著…' : '讓 AI 幫我填'}
                                </button>
                            }>{kind === 'wish' ? '想 做 什 麼' : kind === 'promise' ? '說 好 了 什 麼' : '我 們 的 默 契'}</SectionLabel>
                            <textarea className="bond-input bond-serif min-h-[84px] leading-relaxed" value={text} maxLength={160}
                                placeholder={kind === 'wish' ? '像「想一起去看極光」' : kind === 'promise' ? '像「每天睡前互道晚安」' : '像「吵架後總是他先傳貼圖」'}
                                onChange={e => setText(e.target.value)} />
                        </section>
                        {kind === 'promise' && (
                            <section>
                                <SectionLabel>多 久 一 次</SectionLabel>
                                <div className="flex flex-wrap gap-2">
                                    {SIMPLE_REPEATS.map(r => (
                                        <button key={r.kind} type="button" className="bond-chip" aria-pressed={sameRepeat(r, repeat)} onClick={() => setRepeat(r)}>{repeatLabel(r)}</button>
                                    ))}
                                    {!SIMPLE_REPEATS.some(r => sameRepeat(r, repeat)) && <button type="button" className="bond-chip" aria-pressed>{repeatLabel(repeat)}</button>}
                                </div>
                                <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">存了是「還在商量」，{space.rightName}說好才成立；完成依據、計分之後在約定裡改。</div>
                            </section>
                        )}
                        {kind === 'habit' && <p className="text-[11px] text-[var(--bond-muted)]">存了等{space.rightName}確認，兩邊都認了才算你們的默契。</p>}
                    </>
                )}
                {kind === 'moment' && <>
                <section>
                    <SectionLabel>標 題</SectionLabel>
                    <input className="bond-input bond-serif" value={title} maxLength={40} placeholder="可以不填" onChange={e => setTitle(e.target.value)} />
                </section>
                <section>
                    <SectionLabel right={
                        <button type="button" onClick={summarize} disabled={!!busy || !picked.length} className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1 disabled:opacity-40">
                            <Sparkle size={12} />{busy === 'summary' ? '寫著…' : '讓 AI 幫我寫一句'}
                        </button>
                    }>發 生 了 什 麼</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[96px] leading-relaxed" value={text} placeholder="可以不填，就用上面那幾則原文；只寫發生了什麼"
                        onChange={e => setText(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>想 留 著 它 ， 因 為</SectionLabel>
                    <input className="bond-input" value={note} maxLength={120} placeholder="可以不填" onChange={e => setNote(e.target.value)} />
                    {space.kind === 'persona' && <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">{space.rightName} 也看得到這句。</div>}
                </section>
                {date && (
                    <section>
                        <SectionLabel>什 麼 時 候</SectionLabel>
                        <BondDateField value={date} onChange={setDate} todayKey={space.todayKey} />
                    </section>
                )}
                </>}
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={() => onDone(null)}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!date || !picked.length || !!busy || (kind === 'moment' ? periodMissingLabel : kind === 'gift' ? !title.trim() : !text.trim())} onClick={save}>
                    {busy === 'save' ? '存檔中…' : '收存'}
                </button>
            </div>
        </div>
    );
};
