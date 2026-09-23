import { trackSARFeature } from '../../utils/sarAnalytics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CaretDown, CaretLeft, CaretRight, Check, Cpu, Fish, MagnifyingGlass, PawPrint, Stack, Users } from '@phosphor-icons/react';
import type { FishingMarketState, MarketActor } from '../../utils/vrWorld/fishingMarket';
import { sarCollectionEntries, sarCollectionProgress, type SARCollectionCategory, type SARCollectionEntry } from '../../utils/vrWorld/sarCollection';
import { FishArt } from './FishArt';
import { SARFamiliarityRoster } from './SARFamiliarityRoster';
import { SARExclusiveKeepsakes } from './SARExclusiveKeepsakes';
import type { FamiliarityNpc } from '../../utils/vrWorld/sarFamiliarity/types';

const Icons = { fish: Fish, dinosaur: PawPrint, chip: Stack, module: Cpu };
const PAGE_SIZE = 12;
function CollectionArt({ entry, size = 56 }: { entry: SARCollectionEntry; size?: number }) {
    const Icon = Icons[entry.category];
    return entry.speciesId ? <FishArt speciesId={entry.speciesId} size={size + 28} silhouette={!entry.collected}/> : <Icon size={size} weight={entry.collected ? 'duotone' : 'thin'}/>;
}
export function SARCollectionView({ market, owner, actors, onOwnerChange, onClose, backRef, onOpenFamiliarity, npcEnabled = true }: {
    npcEnabled?: boolean;
    market: FishingMarketState; owner: MarketActor; actors: MarketActor[]; onOwnerChange: (id: string) => void; onClose: () => void;
    backRef: React.MutableRefObject<(() => boolean) | null>;
    onOpenFamiliarity?: (npc: FamiliarityNpc, sceneId?: string) => void;
}) {
    const [requestedSection, setSection] = useState<'collection' | 'roster' | 'keepsakes'>('collection');
    const section = npcEnabled ? requestedSection : 'collection';
    useEffect(() => { if (!npcEnabled) { setSection('collection'); setKeepsakeTitle(null); } }, [npcEnabled]);
    useEffect(() => { if (section !== 'keepsakes') trackSARFeature(section); }, [section]);
    const keepsakeBack = useRef<(() => boolean) | null>(null);
    const [keepsakeTitle,setKeepsakeTitle]=useState<string|null>(null);
    const [category, setCategory] = useState<SARCollectionCategory | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<'all' | 'collected' | 'missing'>('all');
    const [page, setPage] = useState(0);
    const scroll = useRef<HTMLElement>(null);
    const headerBack=useRef<HTMLButtonElement>(null);
    const entries = useMemo(() => sarCollectionEntries(market, owner.id, npcEnabled), [market, owner.id, npcEnabled]);
    const progress = sarCollectionProgress(entries);
    const current = progress.find(item => item.id === category);
    const selected = entries.find(item => item.id === selectedId);
    const matches = entries.filter(item => item.category === category && (filter === 'all' || item.collected === (filter === 'collected')) && `${item.title} ${item.tag}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1);
    const shown = matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    const collected = entries.filter(item => item.collected).length;
    const goBack = () => {
        if (section === 'keepsakes' && keepsakeBack.current?.()) return true;
        if (section !== 'collection') return false;
        if (selectedId) { setSelectedId(null); return true; }
        if (category) { setCategory(null); return true; }
        return false;
    };
    useEffect(() => { backRef.current = goBack; return () => { backRef.current = null; }; }, [selectedId, category, section]);
    useEffect(() => { setSelectedId(null); setQuery(''); setFilter('all'); setPage(0); }, [owner.id, category]);
    useEffect(() => { setPage(0); }, [query, filter]);
    useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [category, selectedId, currentPage, owner.id]);
    // Replacing a grid removes its focused button; keep Escape/Tab inside the dialog.
    useEffect(() => { headerBack.current?.focus({ preventScroll: true }); }, [category, selectedId, keepsakeTitle]);
    useEffect(() => {
        if (section !== 'collection') return;
        const target = window as Window & { render_game_to_text?: () => string };
        const render = () => JSON.stringify({ mode: 'sar-collection', ownerId: owner.id, category, selectedId, progress, page: currentPage + 1, pages, filter, entries: shown.map(({ id, title, collected, owned }) => ({ id, title, collected, owned })) });
        target.render_game_to_text = render;
        return () => { if (target.render_game_to_text === render) delete target.render_game_to_text; };
    }, [owner.id, category, selectedId, market, query, filter, currentPage, section]);
    const chipProgress = (tag: string) => { const chips = entries.filter(entry => entry.category === 'chip' && entry.tag === tag); return `${chips.filter(entry => entry.collected).length} / ${chips.length}`; };

    return <>
        <header className="sar-hub-header"><button ref={headerBack} type="button" onClick={() => { if (!goBack()) onClose(); }} aria-label={section==='keepsakes'&&keepsakeTitle?'返回專屬紀念':section==='collection'&&selected?'返回分類圖鑑':section==='collection'&&category?'返回圖鑑總覽':'返回隨身倉庫'}><ArrowLeft size={21}/></button><div><small>SAR · COLLECTION</small><h2>{section==='keepsakes'&&keepsakeTitle?keepsakeTitle:section==='collection'&&selected?selected.title:section==='collection'&&current?`${current.title}圖鑑`:'收集圖鑑'}</h2></div></header>
        <nav className="sar-collection-sections" aria-label="圖鑑頁面">
            <button type="button" aria-current={section==='collection'?'page':undefined} onClick={()=>setSection('collection')}><BookOpen size={16} weight={section==='collection'?'fill':'regular'}/>收藏</button>
            {npcEnabled && <><button type="button" aria-current={section==='keepsakes'?'page':undefined} onClick={()=>setSection('keepsakes')}><BookOpen size={16} weight={section==='keepsakes'?'fill':'regular'}/>專屬紀念</button>
            <button type="button" aria-current={section==='roster'?'page':undefined} onClick={()=>setSection('roster')}><Users size={16} weight={section==='roster'?'fill':'regular'}/>名冊</button></>}
        </nav>
        {section==='roster'?<SARFamiliarityRoster onOpenScene={(npc,sceneId)=>onOpenFamiliarity?.(npc,sceneId)}/>:section==='keepsakes'?<SARExclusiveKeepsakes market={market} backRef={keepsakeBack} onDetailChange={setKeepsakeTitle}/>:<>
        <main ref={scroll} className="sar-hub-warehouse sar-collection">
            <div className="sar-hub-owner"><span>正在查看</span><label><select aria-label="圖鑑主人" value={owner.id} onChange={event => onOwnerChange(event.target.value)}>{actors.map(actor => <option key={actor.id} value={actor.id}>{actor.name}</option>)}</select><CaretDown size={16}/></label></div>
            {selected ? <article className="sar-collection-entry">
                <div className={`sar-collection-large-art ${selected.collected ? 'is-collected' : ''}`}><CollectionArt entry={selected} size={100}/></div>
                <div className="sar-collection-entry-status">{selected.collected ? <Check size={15}/> : <BookOpen size={15}/>}<span>{selected.collected ? '已收錄' : '尚未收錄'} · {selected.tag}</span></div>
                <p>{selected.description}</p><div className="sar-collection-source"><strong>獲得方式</strong><p>{selected.source}</p></div>
                {selected.collected && <p className="sar-collection-owned">當前持有 {selected.owned} 件{selected.owned === 0 ? ' · 已用掉或轉出，收集記錄保留' : ''}</p>}
            </article> : !category ? <>
                <div className="sar-collection-total"><BookOpen size={29} weight="light"/><div><p><strong>{collected}</strong><span>/ {entries.length} 種</span></p><small>已經收錄的相遇</small></div></div>
                <div className="sar-collection-categories">{progress.map(item => { const Icon = Icons[item.id]; return <button type="button" key={item.id} aria-label={`${item.title}圖鑑 · 已收錄 ${item.collected} / ${item.total} 種`} onClick={() => setCategory(item.id)}>
                    <span className={`sar-collection-category-icon is-${item.id}`}><Icon size={29} weight="duotone"/></span><div><span><strong>{item.title}</strong><small>{item.collected} / {item.total}</small></span><p>{item.description}</p><i role="progressbar" aria-label={`${item.title}收集進度`} aria-valuemin={0} aria-valuemax={item.total} aria-valuenow={item.collected}><b style={{ width: `${item.total ? item.collected / item.total * 100 : 0}%` }}/></i></div><CaretRight size={16}/>
                </button>; })}</div>
                <p className="sar-hub-muted sar-collection-footnote">同一種物品只點亮一次。用掉或轉讓後，收錄記錄仍會留下。</p>
            </> : <>
                <div className="sar-collection-category-progress"><strong>{current?.collected}<small> / {current?.total} 種已收錄</small></strong>{category === 'chip' && <span>變體 {chipProgress('變體芯片')} · 故事 {chipProgress('故事芯片')}</span>}</div>
                {category === 'chip' && owner.id !== 'user' && <p className="sar-hub-muted">角色短篇演繹使用的臨時芯片不計入永久收集。</p>}
                <div className="sar-collection-controls"><label><MagnifyingGlass size={16}/><input aria-label="搜索圖鑑" placeholder="找一找…" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="圖鑑收錄狀態" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">全部</option><option value="collected">已收錄</option><option value="missing">未收錄</option></select></div>
                {shown.length ? <div className="sar-hub-items">{shown.map(entry => <button type="button" key={entry.id} className={`sar-hub-item sar-collection-item ${entry.collected ? 'is-collected' : 'is-missing'}`} onClick={() => setSelectedId(entry.id)} aria-label={`${entry.title} · ${entry.collected ? '已收錄' : '尚未收錄'}`}>
                    <span className={`sar-hub-item-art is-${entry.category}`}><CollectionArt entry={entry} size={35}/>{entry.collected && <Check className="sar-collection-tick" size={14}/>}</span><strong>{entry.title}</strong><small>{entry.collected ? '已收錄' : '尚未收錄'}</small>
                </button>)}</div> : <p className="sar-collection-no-results">{query ? '沒有找到匹配的條目。' : filter === 'missing' ? '這一類已經集齊了。' : '還沒有收錄這類物品。'}</p>}
                {pages > 1 && <nav className="sar-collection-pages" aria-label="圖鑑翻頁"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="上一頁圖鑑"><CaretLeft size={16}/></button><span>{currentPage + 1} / {pages}</span><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)} aria-label="下一頁圖鑑"><CaretRight size={16}/></button></nav>}
            </>}
        </main></> }
    </>;
}
