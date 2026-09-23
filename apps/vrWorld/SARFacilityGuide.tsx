import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Question, X } from '@phosphor-icons/react';
import { SAR_FACILITY_GUIDES, sarFacilityGuideKey, registerSARGuideCloser, type SARFacilityId } from '../../utils/vrWorld/sarFacilityGuides';
import { readSARClubState } from '../../utils/vrWorld/sarClub';
import { SARNpcChibi } from './SARNpcArt';
import './sar-facility-guide.css';

export function SARFacilityGuide({ facility, auto = true, onOpenChange }: { facility: SARFacilityId; auto?: boolean; onOpenChange?: (open: boolean) => void }) {
    const npcVisible = readSARClubState().npcPreference !== 'hide';
    const original = SAR_FACILITY_GUIDES[facility];
    const guide = npcVisible ? original : { ...original, title: original.title.replace('艾文的', ''), steps: original.steps.map(step =>
        facility === 'warehouse' && step.title === '圖鑑與名冊' ? { title: '收集圖鑑', text: '右上角「圖鑑」可查看魚類、恐龍、芯片和模塊的收集進度。餘額、物品和進度都隨設置裡的導出 / 導入保存。' } : { ...step, text: step.text.replaceAll('賣給艾文', '交給回收站') }) };
    const [open, setOpen] = useState(() => { try { return auto && localStorage.getItem(sarFacilityGuideKey(facility)) !== 'done'; } catch { return auto; } });
    useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
    const trigger = useRef<HTMLButtonElement>(null), sheet = useRef<HTMLElement>(null);
    const close = useCallback(() => {
        try { localStorage.setItem(sarFacilityGuideKey(facility), 'done'); } catch { /* Help remains available if persistence is unavailable. */ }
        setOpen(false); trigger.current?.focus({ preventScroll: true });
    }, [facility]);
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => sheet.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
        const unregister = registerSARGuideCloser(close);
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
        };
        window.addEventListener('keydown', key, true);
        return () => { cancelAnimationFrame(frame); unregister(); window.removeEventListener('keydown', key, true); };
    }, [open, close]);
    return <>
        <button ref={trigger} type="button" className="sar-facility-help" aria-label={`${guide.title} · 玩法說明`} aria-expanded={open} onClick={() => setOpen(true)}><Question size={21}/></button>
        {open && createPortal(<div className="sar-facility-guide-backdrop" onClick={event => { if (event.target === event.currentTarget) close(); }}>
            <section ref={sheet} className="sar-facility-guide" role="dialog" aria-modal="true" aria-label={`${guide.title}玩法引導`} data-sar-guide={facility}
                onKeyDown={event => {
                    if (event.key !== 'Tab') return;
                    const buttons = sheet.current?.querySelectorAll<HTMLButtonElement>('button');
                    const first = buttons?.[0], last = buttons?.[buttons.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }}>
                <header><span>SAR · 玩法指南</span><button type="button" aria-label="關閉玩法引導" onClick={close}><X size={21}/></button></header>
                <div className="sar-facility-guide-intro">
                    {npcVisible && <SARNpcChibi who={guide.npc}/>}
                    <div><small>{npcVisible ? guide.npc === 'aiven' ? '艾文' : '凱恩' : '使用說明'}</small><h2>{guide.title}</h2><p>{guide.intro}</p></div>
                </div>
                <ol>{guide.steps.map((step, index) => <li key={step.title}><b>0{index + 1}</b><div><h3>{step.title}</h3><p>{step.text}</p></div></li>)}</ol>
                <footer><span>以後隨時點「?」再看</span><button type="button" onClick={close}>知道了，開始玩</button></footer>
            </section>
        </div>, document.body)}
    </>;
}
