import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookmarkSimple } from '@phosphor-icons/react';
import type { FishingMarketState } from '../../utils/vrWorld/fishingMarket';
import { sarExclusiveKeepsakes } from '../../utils/vrWorld/sarKeepsakes';
import { SAR_NPC_NAMES } from '../../utils/vrWorld/sarArt';
import { SARFamiliarityKeepsake } from './SARFamiliarityKeepsake';
import { SARPageNav } from './SARCharacterPicker';
import { FishArt } from './FishArt';
import { SARArtifactPreview } from './SARArtifactArt';
import './sar-exclusive-keepsakes.css';

export function SARExclusiveKeepsakes({ market, backRef, onDetailChange }: { market: FishingMarketState; onDetailChange: (title:string|null)=>void; backRef: React.MutableRefObject<(() => boolean) | null> }) {
    const entries = useMemo(() => sarExclusiveKeepsakes(market), [market]);
    const scroll = useRef<HTMLElement>(null);
    const [filter, setFilter] = useState<'all' | 'caian' | 'aiven'>('all');
    const [selectedId, setSelectedId] = useState<string | null>(null), [page, setPage] = useState(0);
    const selected = entries.find(item => item.id === selectedId);
    const matches = entries.filter(item => filter === 'all' || item.npc === filter);
    const pages = Math.max(1, Math.ceil(matches.length / 12)), currentPage = Math.min(page, pages - 1);
    useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [filter, currentPage, selectedId]);
    useEffect(() => { onDetailChange(selected?.title||null); return ()=>onDetailChange(null); }, [selected?.title,onDetailChange]);
    useEffect(() => { backRef.current = () => { if (!selectedId) return false; setSelectedId(null); return true; }; return () => { backRef.current = null; }; }, [selectedId]);
    useEffect(() => {
        const host = window as Window & { render_game_to_text?: () => string };
        const render = () => JSON.stringify({ mode: 'sar-exclusive-keepsakes', filter, selectedId, page: currentPage + 1, pages, entries: matches.map(item => ({ id: item.id, title: item.title, npc: item.npc })) });
        host.render_game_to_text = render;
        return () => { if (host.render_game_to_text === render) delete host.render_game_to_text; };
    }, [entries, filter, selectedId, currentPage]);
    if (selected?.souvenir) return <SARFamiliarityKeepsake embedded item={selected.souvenir} onClose={() => setSelectedId(null)}/>;
    return <>
        <main ref={scroll} className="sar-hub-warehouse sar-exclusive-shelf">
            {selected ? <article className="sar-collection-entry">
                {selected.speciesId && <div className="sar-collection-large-art is-collected"><FishArt speciesId={selected.speciesId} size={165}/></div>}
                <div className="sar-exclusive-source">{SAR_NPC_NAMES[selected.npc]} · {selected.source}</div><p>{selected.description}</p>
                <p className="sar-hub-muted">{selected.owned ? '已經放在你的恐龍收藏裡，可以去箱庭單獨起名、換色和擺放。' : '這份專屬贈禮的收錄仍然留在這裡。'}</p>
            </article> : <>
                <div className="sar-exclusive-intro"><BookmarkSimple size={29} weight="light"/><div><h3>為你留的那一份</h3><p>紀念卡、合影與特別的贈禮。打開它，就能回看當時留下的細節。</p></div></div>
                <nav className="sar-exclusive-filters" aria-label="紀念物來自誰">{(['all', 'caian', 'aiven'] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(0); }}>{value === 'all' ? '全部' : SAR_NPC_NAMES[value]}</button>)}</nav>
                <div className="sar-exclusive-count">已收好 {matches.length} 份紀念</div>
                <div className="sar-exclusive-items">{matches.slice(currentPage * 12, (currentPage + 1) * 12).map(item => <button type="button" className="sar-exclusive-item" key={item.id} onClick={() => setSelectedId(item.id)}>
                    <span className="sar-exclusive-art">{item.speciesId ? <FishArt speciesId={item.speciesId} size={72}/> : <SARArtifactPreview kind={item.artifactKind || 'memory-card'}/>}</span>
                    <span><small>{SAR_NPC_NAMES[item.npc]} · 專屬贈禮</small><strong>{item.title}</strong><span>{item.source}</span></span>
                </button>)}</div>
                {!matches.length && <div className="sar-hub-empty"><BookmarkSimple size={40} weight="light"/><h3>這一頁，先為你留著</h3><p>一起經歷故事後收到的專屬紀念物，會收在這裡。</p></div>}
                <SARPageNav page={currentPage} pages={pages} onChange={setPage} label="專屬紀念"/>
            </>}
        </main>
    </>;
}
