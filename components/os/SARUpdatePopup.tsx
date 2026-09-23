import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Lightning, PaperPlaneTilt, X } from '@phosphor-icons/react';
import roomArt from '../../assets/sar-club-room.png';
import { trackEvent } from '../../utils/analytics';
import { SAR_CHANGELOG, SAR_UPDATE_KEY } from '../../utils/sarUpdate';
import './sar-update.css';

const PAGES = ['在彼方相遇', '順手地聊天', '一張圖分享'] as const;

/** 獨立展示層，公告和自動化預覽共用。只在用戶明確離開時記為已讀。 */
export function SARUpdatePopup({ onDone, onVisit, onGuide }: {
    onDone: () => void; onVisit: () => void; onGuide: () => void;
}) {
    const [page, setPage] = useState(0);
    const root = useRef<HTMLElement>(null);
    const dismiss = useRef(() => {});
    const seen = () => { try { localStorage.setItem(SAR_UPDATE_KEY, '1'); } catch { /* 本次仍可關閉 */ } };
    dismiss.current = () => { seen(); trackEvent('跳过本次更新说明', { 版本: SAR_CHANGELOG }); onDone(); };
    useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: SAR_CHANGELOG });
        const previous = document.activeElement as HTMLElement | null;
        root.current?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current(); }
            if (event.key !== 'Tab') return;
            const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') || []);
            const first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current)) { event.preventDefault(); first?.focus(); }
        };
        document.addEventListener('keydown', keydown, true);
        return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
    }, []);
    const turn = (index: number) => { setPage(index); root.current?.querySelector('.sar-release-scroll')?.scrollTo(0, 0); };
    return <div className="sar-release-overlay">
        <section ref={root} className="sar-release" role="dialog" aria-modal="true" aria-labelledby="sar-release-title" tabIndex={-1}>
            <header className="sar-release-header"><span>Soren <i>✦</i> VOL. 3.10</span><span>彼方來信 / 2026.09</span>
                <button aria-label="關閉更新公告" onClick={() => dismiss.current()}><X size={19}/></button>
            </header>
            <div className="sar-release-scroll">
                <div key={page} className="sar-release-page">
                    {page === 0 ? <>
                        <div className="sar-release-art">
                            <img className="sar-release-room" src={roomArt} alt="SAR 活動室原畫" draggable={false}/>
                            <div className="sar-release-orbit" aria-hidden="true"/>
                            <span className="sar-release-room-mark" aria-hidden="true">SAR</span>
                            <img className="sar-release-caian" src={`${import.meta.env.BASE_URL}sar-portraits/Caian/normal.webp`} alt="凱恩" draggable={false}/>
                            <img className="sar-release-aiven" src={`${import.meta.env.BASE_URL}sar-portraits/Aiven/normal.webp`} alt="艾文" draggable={false}/>
                            <span className="sar-release-seal">ACTIVITY<br/>ROOM<br/><b>✦</b></span>
                        </div>
                        <div className="sar-release-copy">
                            <p className="sar-release-kicker">01 / 一扇新門，為你留著</p>
                            <h2 id="sar-release-title">去彼方，<br/>一起虛度時光。</h2>
                            <p>凱恩與艾文，正在 SAR 活動室等你。<br/>從一句日常問候開始，把陌生聊成熟悉。</p>
                            <div className="sar-release-features"><span>交談 · 星級故事</span><span>釣魚 · 恐龍花園</span><span>芯片 · 推演 · 模塊</span></div>
                            <p className="sar-release-note">慢慢收集，慢慢相熟。走過的故事和收下的紀念，都留在收藏冊裡。</p>
                        </div>
                    </> : page === 1 ? <>
                        <div className="sar-release-copy sar-release-copy-top">
                            <p className="sar-release-kicker">02 / 回覆，就在手邊</p>
                            <h2 id="sar-release-title">不用再夠<br/>右上角的閃電。</h2>
                            <p>任意私聊 → 輸入框旁「＋」→「設置」<br/>在頂部「輸入與發送」裡調整，點「保存設置」。<br/>一次設置，所有私聊一起生效。</p>
                        </div>
                        <div className="sar-release-chat-art" aria-hidden="true">
                            <div className="sar-release-demo-bubble">還有一張表情包，等我一下。</div>
                            <div className="sar-release-demo-input"><span>正在輸入…</span><PaperPlaneTilt size={22}/></div>
                            <span className="sar-release-demo-arrow">點一下聊天空白處 <ArrowRight size={16}/></span>
                            <div className="sar-release-demo-input"><span>準備好，叫 TA 回覆</span><Lightning size={22} weight="fill"/></div>
                        </div>
                        <div className="sar-release-options">
                            <p><span>○</span><strong>發送按鈕代替生成按鈕</strong><small>默認關閉 · 輸入時發文字，點聊天空白處後變成閃電</small></p>
                            <p><span>✓</span><strong>回車發送文字</strong><small>默認開啟 · 鍵盤上的回車鍵直接發文字；關閉後用來換行</small></p>
                            <p><span>○</span><strong>發完後自動生成回覆</strong><small>默認關閉 · 發完後點聊天空白處，草稿為空、加號面板收起，再等 2 秒讓 TA 回覆</small></p>
                        </div>
                    </> : <>
                        <div className="sar-release-copy sar-release-copy-top">
                            <p className="sar-release-kicker">03 / 喜歡的東西，帶走一份</p>
                            <h2 id="sar-release-title">一張圖，<br/>裝下你的分享。</h2>
                            <p>角色卡、世界書、氣泡主題與外觀預設……<br/>可以做成 PNG 分享卡，連內容一起裝進去。</p>
                        </div>
                        <div className="sar-release-share-art" aria-hidden="true">
                            <div className="sar-release-share-shadow"/>
                            <div className="sar-release-share-card"><span>Soren / SHARE COLLECTION</span><img src={roomArt} alt=""/><strong>把喜歡的世界<br/>送到你手裡。</strong><small>一張圖片 · 一份完整心意</small><b>PNG ↗</b></div>
                        </div>
                        <p className="sar-release-share-note">發送 <strong>PNG 原文件</strong>，對方在對應入口導入。<br/>截圖、壓縮或轉成其他格式，會丟掉裡面的內容。<br/><span>原格式導出也保留著，照舊可用。</span></p>
                    </>}
                </div>
            </div>
            <footer className="sar-release-footer">
                <nav aria-label="公告章節">{PAGES.map((name, index) => <button key={name} onClick={() => turn(index)} aria-label={name} aria-current={page === index ? 'step' : undefined}><span>0{index + 1}</span><i/></button>)}</nav>
                <div className="sar-release-actions">
                    {page > 0 ? <button className="sar-release-back" onClick={() => turn(page - 1)} aria-label="上一頁"><ArrowLeft size={18}/></button> : null}
                    <button className="sar-release-guide" onClick={() => { seen(); trackEvent('查看更新说明', { 版本: SAR_CHANGELOG }); onGuide(); }}>完整更新說明</button>
                    <button className="sar-release-next" onClick={() => {
                        if (page < 2) turn(page + 1);
                        else { seen(); trackEvent('点立刻体验', { 版本: SAR_CHANGELOG }); onVisit(); }
                    }}>{page < 2 ? '下一頁' : '去彼方看看'}<ArrowRight size={18}/></button>
                </div>
            </footer>
        </section>
    </div>;
}
