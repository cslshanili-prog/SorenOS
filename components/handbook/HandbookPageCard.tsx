/**
 * 手帳單頁卡片（糖果 + 拍立得 + 貼紙版）
 *
 * - user_diary：橫線紙 + 蕾絲頂邊 + lemon washi（heart pattern）+ 散落小貼紙
 * - character_life：拍立得相框（白邊相片 + 底部留白手寫）+ 角色頭像作主圖
 *                   外加 paper clip / bow / heart 貼紙
 * - user_note：dot 紙 + mint washi（dot pattern）+ 散落貼紙
 */

import React, { useState, useEffect } from 'react';
import { HandbookPage, CharacterProfile } from '../../types';
import {
    PAPERS, PAPER_SHADOW, POLAROID_SHADOW, WashiTape,
    SERIF_STACK, CUTE_STACK, PAPER_TONES,
} from './paper';
import {
    ScatteredStickers, LaceEdge, PaperClip, HeartSticker, BowSticker,
} from './stickers';
import FragmentCollage from './FragmentCollage';
import { PencilSimple, Trash, Eye, EyeSlash, ArrowsClockwise, FloppyDisk, X } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';

interface PageCardProps {
    page: HandbookPage;
    char?: CharacterProfile;
    isEditing: boolean;
    onStartEdit: () => void;
    onSave: (newContent: string, newPaperStyle?: string) => void;
    onCancel: () => void;
    onToggleExclude: () => void;
    onDelete: () => void;
    onRegenerate?: () => void;
    isRegenerating?: boolean;
}

const HandbookPageCard: React.FC<PageCardProps> = ({
    page, char, isEditing, onStartEdit, onSave, onCancel,
    onToggleExclude, onDelete, onRegenerate, isRegenerating,
}) => {
    const [draft, setDraft] = useState(page.content);
    useEffect(() => { setDraft(page.content); }, [page.content, isEditing]);

    // 默認紙張：按類型挑
    const defaultPaper = page.type === 'character_life' ? 'cream'
        : page.type === 'user_note' ? 'dot'
        : page.type === 'user_diary' ? 'lined'
        : 'plain';
    // 編輯期間允許 user 切紙張
    const [draftPaper, setDraftPaper] = useState<string>(page.paperStyle || defaultPaper);
    useEffect(() => { setDraftPaper(page.paperStyle || defaultPaper); }, [page.paperStyle, isEditing]);

    const paperKind = (
        (isEditing ? draftPaper : page.paperStyle) as keyof typeof PAPERS
    ) || (defaultPaper as keyof typeof PAPERS);
    const paper = PAPERS[paperKind] || PAPERS.plain;

    // 類型 → 膠帶 + 文案
    const tape = (() => {
        switch (page.type) {
            case 'user_diary':     return { color: 'lemon' as const,  pattern: 'heart' as const, label: '我 的 一 天 ♡' };
            case 'character_life': return { color: 'rose' as const,   pattern: 'star' as const,  label: char ? `${char.name} ★` : '小生活' };
            case 'user_note':      return { color: 'mint' as const,   pattern: 'dot' as const,   label: '我 寫 的' };
            case 'free':           return { color: 'lavender' as const, pattern: 'plain' as const, label: '便 籤' };
        }
    })();

    // 旋轉/spacing 全部交給父級（DayView）控制,這裡只畫"一片紙"
    // ─── character_life 走拍立得相框 ───────────────────────
    if (page.type === 'character_life') {
        return (
            <div
                className={`relative transition-opacity ${page.excluded ? 'opacity-35' : ''}`}
            >
                {/* 頂部回形針 */}
                <div className="absolute -top-3 left-8 z-20 pointer-events-none">
                    <PaperClip color={PAPER_TONES.accentSilver} rotate={-15} size={26} />
                </div>
                {/* 散落貼紙 */}
                <ScatteredStickers seed={page.id} count={3} zone="corners" />

                {/* 拍立得相框 */}
                <div
                    className="relative mx-2"
                    style={POLAROID_SHADOW}
                >
                    {/* 主圖區：角色頭像 + 膠帶標籤 */}
                    <div
                        className="relative overflow-hidden"
                        style={{
                            background: paper.bg,
                            ...paper.style,
                            minHeight: 90,
                            borderRadius: 2,
                        }}
                    >
                        {/* 膠帶在主圖區上 */}
                        <div className="absolute -top-2 left-3 z-10 pointer-events-none">
                            <WashiTape color={tape.color} pattern={tape.pattern} rotate={-3}>
                                {tape.label}
                            </WashiTape>
                        </div>
                        {/* 角色頭像作主圖（大頭貼風）*/}
                        {char && (
                            <div className="flex items-center justify-center py-5 px-4">
                                <TokenImg
                                    value={char.avatar}
                                    alt={char.name}
                                    className="rounded-full object-cover"
                                    style={{
                                        width: 76, height: 76,
                                        boxShadow: '0 2px 8px rgba(0,0,0,0.15), 0 0 0 4px #fff',
                                    }}
                                />
                                <div className="ml-3 flex-1 min-w-0">
                                    <div
                                        className="text-[12px] font-bold"
                                        style={{ ...CUTE_STACK, color: PAPER_TONES.ink }}
                                    >
                                        {char.name}
                                    </div>
                                    <div
                                        className="text-[10px] mt-0.5"
                                        style={{ ...SERIF_STACK, color: PAPER_TONES.inkSoft }}
                                    >
                                        ta 的今天
                                    </div>
                                </div>
                                <BowSticker size={22} color={PAPER_TONES.accentRose} />
                            </div>
                        )}
                    </div>

                    {/* 拍立得底部留白 = 內容區 */}
                    <div className="pt-4 px-1">
                        {isEditing ? (
                            <>
                                <PaperPicker value={draftPaper} onChange={setDraftPaper} />
                                <textarea
                                    value={draft}
                                    onChange={e => setDraft(e.target.value)}
                                    className="w-full bg-transparent outline-none resize-none text-[14px] leading-[24px] min-h-[100px]"
                                    style={{ ...SERIF_STACK, color: PAPER_TONES.ink }}
                                    autoFocus
                                />
                            </>
                        ) : page.fragments && page.fragments.length > 0 ? (
                            <FragmentCollage fragments={page.fragments} />
                        ) : (
                            <p
                                className="whitespace-pre-wrap text-[14px] leading-[24px] break-words"
                                style={{ ...SERIF_STACK, color: PAPER_TONES.ink }}
                            >
                                {page.content || (
                                    <span style={{ color: PAPER_TONES.inkSoft, fontStyle: 'italic', opacity: 0.6 }}>
                                        ta 今天還沒有故事…
                                    </span>
                                )}
                            </p>
                        )}

                        <ActionRow
                            isEditing={isEditing}
                            onCancel={onCancel}
                            onSave={() => onSave(draft, draftPaper)}
                            onStartEdit={onStartEdit}
                            onToggleExclude={onToggleExclude}
                            onDelete={onDelete}
                            onRegenerate={onRegenerate}
                            isRegenerating={isRegenerating}
                            excluded={!!page.excluded}
                        />
                    </div>
                </div>
            </div>
        );
    }

    // ─── 其他類型：普通紙張卡片 ─────────────────────────────
    return (
        <div
            className={`relative transition-opacity ${page.excluded ? 'opacity-35' : ''}`}
        >
            {/* 膠帶 */}
            <div className="absolute -top-3 left-4 z-10 pointer-events-none">
                <WashiTape color={tape.color} pattern={tape.pattern} rotate={-2}>
                    {tape.label}
                </WashiTape>
            </div>

            {/* 散落貼紙 */}
            <ScatteredStickers seed={page.id} count={page.type === 'user_diary' ? 4 : 2} zone="corners" />

            {/* user_diary 頂部蕾絲邊 */}
            {page.type === 'user_diary' && (
                <div className="absolute top-0 left-0 right-0 z-[5] pointer-events-none px-2 pt-1">
                    <LaceEdge color={PAPER_TONES.accentRose} flip />
                </div>
            )}

            <div
                className="relative px-5 pt-6 pb-3"
                style={{
                    background: paper.bg,
                    color: PAPER_TONES.ink,
                    borderRadius: 6,
                    ...paper.style,
                    ...PAPER_SHADOW,
                }}
            >
                {/* 正文:有 fragments → 拼貼;否則 → 段落 */}
                {isEditing ? (
                    <>
                        <PaperPicker value={draftPaper} onChange={setDraftPaper} />
                        <textarea
                            value={draft}
                            onChange={e => setDraft(e.target.value)}
                            className="w-full bg-transparent outline-none resize-none text-[14.5px] leading-[26px] min-h-[140px] tracking-wide"
                            style={{ ...SERIF_STACK, color: PAPER_TONES.ink }}
                            autoFocus
                        />
                    </>
                ) : page.fragments && page.fragments.length > 0 ? (
                    <FragmentCollage fragments={page.fragments} />
                ) : (
                    <p
                        className="whitespace-pre-wrap text-[14.5px] leading-[26px] break-words tracking-wide"
                        style={{ ...SERIF_STACK, color: PAPER_TONES.ink, minHeight: '60px' }}
                    >
                        {page.content || (
                            <span style={{ color: PAPER_TONES.inkSoft, fontStyle: 'italic', opacity: 0.6 }}>
                                這一頁還是空白的…
                            </span>
                        )}
                    </p>
                )}

                <ActionRow
                    isEditing={isEditing}
                    onCancel={onCancel}
                    onSave={() => onSave(draft)}
                    onStartEdit={onStartEdit}
                    onToggleExclude={onToggleExclude}
                    onDelete={onDelete}
                    onRegenerate={onRegenerate}
                    isRegenerating={isRegenerating}
                    excluded={!!page.excluded}
                />
            </div>
        </div>
    );
};

// ─── 操作行（小鐵夾按鈕）────────────────────────────
const ActionRow: React.FC<{
    isEditing: boolean;
    onCancel: () => void;
    onSave: () => void;
    onStartEdit: () => void;
    onToggleExclude: () => void;
    onDelete: () => void;
    onRegenerate?: () => void;
    isRegenerating?: boolean;
    excluded: boolean;
}> = ({ isEditing, onCancel, onSave, onStartEdit, onToggleExclude, onDelete, onRegenerate, isRegenerating, excluded }) => (
    <div
        className="mt-3 pt-2 flex justify-end items-center gap-1"
        style={{ borderTop: `1px dashed ${PAPER_TONES.spine}` }}
    >
        {isEditing ? (
            <>
                <button
                    onClick={onCancel}
                    className="text-[11px] px-2 py-1 rounded active:scale-95 transition flex items-center gap-1"
                    style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}
                >
                    <X className="w-3 h-3" /> 取消
                </button>
                <button
                    onClick={onSave}
                    className="text-[11px] px-3 py-1 rounded-full active:scale-95 transition flex items-center gap-1"
                    style={{
                        ...CUTE_STACK,
                        background: PAPER_TONES.accentBlush,
                        color: '#fff',
                        boxShadow: '0 1px 3px rgba(122,90,114,0.18)',
                    }}
                >
                    <FloppyDisk className="w-3 h-3" /> 收下 ♡
                </button>
            </>
        ) : (
            <>
                {onRegenerate && (
                    <IconBtn onClick={onRegenerate} disabled={isRegenerating} title="再寫一次"
                             Icon={ArrowsClockwise} spin={isRegenerating} />
                )}
                <IconBtn onClick={onStartEdit} title="改寫" Icon={PencilSimple} />
                <IconBtn onClick={onToggleExclude} title={excluded ? '讓它入冊' : '不入冊'}
                         Icon={excluded ? EyeSlash : Eye} />
                <IconBtn onClick={onDelete} title="撕掉這頁" Icon={Trash} danger />
            </>
        )}
    </div>
);

const IconBtn: React.FC<{
    onClick: () => void;
    title: string;
    Icon: React.ComponentType<{ className?: string; weight?: any }>;
    disabled?: boolean;
    spin?: boolean;
    danger?: boolean;
}> = ({ onClick, title, Icon, disabled, spin, danger }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        title={title}
        className="p-1.5 rounded-full active:scale-90 transition disabled:opacity-30"
        style={{
            color: danger ? '#c4708a' : PAPER_TONES.inkSoft,
            background: 'transparent',
        }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(242,157,176,0.15)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
        <Icon className={`w-3.5 h-3.5 ${spin ? 'animate-spin' : ''}`} weight="bold" />
    </button>
);

// ─── PaperPicker:編輯模式下的紙張 swatch 橫條 ──────
const PAPER_SWATCH_OPTIONS: { kind: keyof typeof PAPERS; label: string }[] = [
    { kind: 'plain', label: '素' },
    { kind: 'lined', label: '橫線' },
    { kind: 'grid', label: '方格' },
    { kind: 'dot', label: '點陣' },
    { kind: 'cream', label: '奶油' },
    { kind: 'mint', label: '薄荷' },
    { kind: 'rose', label: '櫻粉' },
    { kind: 'sky', label: '霧藍' },
];

const PaperPicker: React.FC<{
    value: string;
    onChange: (v: string) => void;
}> = ({ value, onChange }) => (
    <div className="flex items-center gap-1.5 mb-2 overflow-x-auto no-scrollbar">
        <span
            className="text-[10px] tracking-widest shrink-0 mr-1"
            style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}
        >
            ◆ 紙
        </span>
        {PAPER_SWATCH_OPTIONS.map(opt => {
            const p = PAPERS[opt.kind];
            const active = value === opt.kind;
            return (
                <button
                    key={opt.kind}
                    onClick={() => onChange(opt.kind)}
                    className="shrink-0 flex flex-col items-center active:scale-95 transition"
                    title={opt.label}
                >
                    <div
                        className="rounded"
                        style={{
                            width: 22, height: 22,
                            background: p.bg,
                            ...p.style,
                            border: active ? `2px solid ${PAPER_TONES.accentLavender}` : `1px solid ${PAPER_TONES.spine}`,
                            boxShadow: active ? `0 0 0 1.5px #fff inset` : 'none',
                        }}
                    />
                    <span
                        className="text-[8px] mt-0.5"
                        style={{
                            ...CUTE_STACK,
                            color: active ? PAPER_TONES.accentLavender : PAPER_TONES.inkFaint,
                        }}
                    >
                        {opt.label}
                    </span>
                </button>
            );
        })}
    </div>
);

export default HandbookPageCard;
