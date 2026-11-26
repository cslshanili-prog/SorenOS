/**
 * 從聊天收存片刻（plans/bond-batch2.md 3.1）：私聊、見面、角色私聊按「收存到羈絆」帶過來的那幾則。
 * 可以往前往後多帶幾則、寫標題、讓 AI 濃縮一兩句「發生了什麼」、補一句想留著的原因、改日期（預設是那則的故事日期）。
 * 存的時候記來源（訊息 id＋原文快照），之後點得回去；原訊息刪了也讀得到快照。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CaretDown, CaretUp, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondEventDate, BondSource, CharacterProfile, Message } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import { BondDateField } from './BondDateField';
import type { ResolvedSpace } from './space';
import { DB } from '../../utils/db';
import {
    buildCollectSnippet, buildMomentSummaryPrompt, cleanSummary, defaultEventDate, extendSelection, lineArgFromKey, messagePlainText, sortById,
    type BondCollectRequest,
} from '../../utils/bond/collect';
import { newBondEntryId, saveBondEntry } from '../../utils/bond/entries';
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

    const summarize = async () => {
        const api = globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);
        if (!api) { addToast('還沒設定 API', 'error'); return; }
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

    const save = async () => {
        if (!date || !picked.length) return;
        setBusy('save');
        try {
            const now = Date.now();
            const at = picked[0].timestamp;
            const source: BondSource = request.kind === 'date'
                ? { type: 'date', storyId: request.storyId || '', charId: request.charId, messageIds: ids, snippet, at }
                : { type: 'message', lineId: request.lineId, messageIds: ids, snippet, at };
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
            <BondHeader title="收存一個片刻" onBack={() => onDone(null)} backLabel="取消" />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
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
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" onClick={() => onDone(null)}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!date || !picked.length || !!busy || periodMissingLabel} onClick={save}>
                    {busy === 'save' ? '存檔中…' : '收存'}
                </button>
            </div>
        </div>
    );
};
