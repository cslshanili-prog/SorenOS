/**
 * 當日視圖 — 一張固定比例的"紙"
 *
 * - 整頁 = 一張紙,瘦長比例,儘量鋪滿移動端可視區
 * - 所有 fragment(user diary + 各 char lifestream + user_note) 散落在同一張紙上
 * - 位置由 composePageLayout (確定性版式引擎) 同步算出, 存進 entry.layouts
 * - 一張裝不下 → entry.layouts 有多張,頂部懸浮 bar 翻頁
 */

import React, { useState, useEffect } from 'react';
import { HandbookEntry, HandbookPage, CharacterProfile } from '../../types';
import JournalCanvas from './JournalCanvas';
import JournalPageEditor from './JournalPageEditor';
import { PAPER_TONES, CUTE_STACK } from './paper';
import { Notebook } from '@phosphor-icons/react';

interface DayViewProps {
    date: string;
    entry: HandbookEntry | null;
    characters: CharacterProfile[];
    userName: string;
    editingPageId: string | null;
    regenPageId: string | null;
    onStartEdit: (pageId: string) => void;
    onSavePage: (pageId: string, content: string, paperStyle?: string) => void;
    onCancelEdit: () => void;
    onToggleExclude: (pageId: string) => void;
    onDeletePage: (pageId: string) => void;
    onRegenerateLifestream: (page: HandbookPage) => void;
    /** 翻頁索引由父級控制(頂部懸浮 bar 也要切),非受控時內部維護 */
    paperIdx?: number;
    onPaperIdxChange?: (idx: number) => void;
}

const HandbookDayView: React.FC<DayViewProps> = ({
    date, entry, characters, userName, editingPageId, regenPageId,
    onStartEdit, onSavePage, onCancelEdit, onToggleExclude, onDeletePage, onRegenerateLifestream,
    paperIdx: paperIdxProp, onPaperIdxChange,
}) => {
    const allPages = entry?.pages || [];
    const layouts = entry?.layouts || [];

    const [internalPaperIdx, setInternalPaperIdx] = useState(0);
    const paperIdx = paperIdxProp ?? internalPaperIdx;
    const setPaperIdx = (idx: number) => {
        setInternalPaperIdx(idx);
        onPaperIdxChange?.(idx);
    };

    // entry / layouts 切換 → 回到第一張紙
    useEffect(() => { setPaperIdx(0); /* eslint-disable-next-line */ }, [entry?.id, layouts.length]);

    const activeLayout = layouts[paperIdx] || null;

    // 編輯某頁時:取出 page
    const editingPage = editingPageId ? allPages.find(p => p.id === editingPageId) : null;
    const editingChar = editingPage?.charId ? characters.find(c => c.id === editingPage.charId) : undefined;

    return (
        <div
            className="flex-1 flex flex-col overflow-hidden relative"
            style={{
                background: `${PAPER_TONES.paperWarm} radial-gradient(circle at 15% 8%, rgba(251,184,200,0.16) 0%, transparent 35%), radial-gradient(circle at 85% 70%, rgba(185,211,224,0.16) 0%, transparent 35%)`,
            }}
        >
            {/* 主畫布區 — 自適應填滿, 頂部留出懸浮 bar 的位置 */}
            <div
                className="flex-1 px-3 pb-3 min-h-0"
                style={{ paddingTop: 'calc(max(env(safe-area-inset-top, 12px), 12px) + 40px)' }}
            >
                {allPages.length === 0 || !activeLayout ? (
                    <EmptyDay />
                ) : (
                    <JournalCanvas
                        date={date}
                        layout={activeLayout}
                        pages={allPages}
                        characters={characters}
                        userName={userName}
                        showHeader={paperIdx === 0}
                        pageNumberLabel={layouts.length > 1 ? `${paperIdx + 1} / ${layouts.length}` : undefined}
                        onPickPlacement={(pageId) => onStartEdit(pageId)}
                    />
                )}
            </div>

            {/* 單頁編輯覆蓋層 */}
            {editingPage && (
                <JournalPageEditor
                    page={editingPage}
                    char={editingChar}
                    isRegenerating={regenPageId === editingPage.id}
                    onClose={onCancelEdit}
                    onSave={(content, paperStyle) => onSavePage(editingPage.id, content, paperStyle)}
                    onToggleExclude={() => onToggleExclude(editingPage.id)}
                    onDelete={() => { onDeletePage(editingPage.id); onCancelEdit(); }}
                    onRegenerate={editingPage.type === 'character_life'
                        ? () => onRegenerateLifestream(editingPage)
                        : undefined}
                />
            )}
        </div>
    );
};

// ─── 空狀態 ──────────────────────────────────────
const EmptyDay: React.FC = () => (
    <div
        className="h-full w-full flex flex-col items-center justify-center text-center"
        style={{ color: PAPER_TONES.inkSoft }}
    >
        <Notebook className="w-12 h-12 mb-3 opacity-40" weight="thin" />
        <div className="text-[14px]" style={CUTE_STACK}>這一頁 · 還是空白 ♡</div>
        <div className="text-[11px] mt-2 opacity-70 leading-relaxed px-8" style={CUTE_STACK}>
            點下方書籤讓 AI 替你寫一份草稿<br />
            或者按 + 自己寫一頁
        </div>
    </div>
);

export default HandbookDayView;
