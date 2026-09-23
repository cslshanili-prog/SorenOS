/**
 * 單片絕對定位的小卡 — 溫馨日記版
 *
 * 設計原則: 像真實手寫日記 — 文字直接落在紙上,不是一堆貼紙蓋紙。
 *   - 默認 plain_para / bare_writing  (字寫在紙上, 作者名前綴 "小滿:")
 *   - 極少數 (≤ 15%) 才出現一張輕量小卡 (sticky / tape_card)
 *   - 其餘如 callout/polaroid/marker/ticket/sticker/handnote 全部移除 — 它們喧賓奪主
 *
 * 內容:
 *   - markdown-lite (粗/斜/高亮/code/[color:red]())
 *   - role 決定字號 / 留白
 */

import React from 'react';
import { HandbookFragment, HandbookPage, CharacterProfile, LayoutRole } from '../../types';
import {
    PAPER_TONES,
    HANDWRITTEN_STACK, BRUSH_STACK,
    seedFloat, seedCentered,
} from './paper';
import JournalRichText from './JournalRichText';
import CardAnnotations from './JournalAnnotations';

type SkinKind =
    // ─── 默認 — 字直接寫在紙上 ───────────────────────
    | 'plain_para'      // 襯線/常規字,前綴"小滿:" — 大多數都走這個
    | 'bare_writing'    // 中等手寫,彩色鋼筆(短句塗鴉)
    | 'bare_brush'      // 大一號粗手寫,帶下劃線/記號(角落小標題感)
    // ─── 極少數 — 輕量小卡 (≤ 15%, 只在長內容/有時間戳時出現) ───
    | 'sticky'          // 淺色 sticky note,邊框柔和
    | 'tape_card';      // 頂部 washi 膠帶的便籤

const STICKY_PALETTES = [
    { bg: '#f5eef7', border: '#d6c8e8', accent: '#a98ec4' },
    { bg: '#eef4f9', border: '#b9d3e0', accent: '#7ea7be' },
    { bg: '#fff0f5', border: '#fbb8c8', accent: '#f29db0' },
    { bg: '#f0faf5', border: '#bfe1cf', accent: '#88c5a8' },
    { bg: '#fef9e0', border: '#f5e295', accent: '#d6b85a' },
    { bg: '#fff8e8', border: '#f0d27a', accent: '#c9a14a' },
];

// 默認: 字直接寫在紙上 (plain_para). 只有少數情況走輕量小卡.
//
// - 極短句 (< 14 字): 多走 bare_writing / bare_brush (塗鴉感)
// - 短句 (14~28 字)  : 大概率 plain_para,小概率 bare_writing
// - 中長 (≥ 28 字)   : 幾乎都 plain_para; ~12% 概率走 sticky/tape_card 調味
function pickSkin(seed: string, role: LayoutRole, isUser: boolean, charCount: number): SkinKind {
    const r = seedFloat(seed, 8888);

    // 極短: 多走塗鴉字 (符合"角落隨手寫一句"的真實手帳感)
    if (charCount < 14) {
        if (r < 0.45) return 'bare_brush';
        if (r < 0.85) return 'bare_writing';
        return 'plain_para';
    }

    // 短: 多走 plain_para,偶爾塗鴉字
    if (charCount < 28) {
        if (r < 0.20) return 'bare_writing';
        return 'plain_para';
    }

    // 中長: 絕大多數 plain_para; 主區/側區少量小卡調味
    const allowCard = role === 'main' || role === 'side';
    if (allowCard && r < 0.12) {
        return seedFloat(seed, 8889) < 0.5 ? 'sticky' : 'tape_card';
    }
    return 'plain_para';
}

// 彩色筆批註大幅降權 — 只在主區偶爾加一筆
function shouldAnnotate(seed: string, role: LayoutRole): 'none' | 'light' | 'medium' {
    if (role !== 'main') return 'none';
    const r = seedFloat(seed, 7777);
    if (r > 0.78) return 'light';
    return 'none';
}

interface Props {
    fragment?: HandbookFragment;
    page: HandbookPage;
    char?: CharacterProfile;
    role: LayoutRole;
    /** 該頁 hero — 強制 plain_para + 大字號 + 襯線, 視覺權重最大 */
    isHero?: boolean;
    /** 強調預算超額時, JournalCanvas 標記某些片為 true → 渲染時剝離 ** == [color:](),
     *  保留文字。每頁累計 ≤ 2 個 emphasis 通過, 多餘的從短的、非 hero 開始降級。 */
    suppressEmphasis?: boolean;
    onTap?: () => void;
}

// 剝離 markdown-lite 強調標記 (** ** / == == / [color:x](text)), 保留純文字。
// hero 不走這條 (hero 的強調永遠保留)。
function stripEmphasis(text: string): string {
    return text
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/==([^=]+)==/g, '$1')
        .replace(/\[color:[a-zA-Z#0-9]+\]\(([^)]+)\)/g, '$1');
}

const JournalFragmentCard: React.FC<Props> = ({ fragment, page, char, role, isHero, suppressEmphasis, onTap }) => {
    const rawText = fragment?.text ?? page.content ?? '';
    const text = suppressEmphasis ? stripEmphasis(rawText) : rawText;
    const time = fragment?.time;
    const seedKey = fragment?.id ?? page.id;
    const isUser = page.type !== 'character_life';

    // ─── 字號三級體系 (硬編碼, 不讓 skin 改) ─────────────
    // hero: 22px serif + 大手寫, 一頁只能有一個
    // body (main/side): 13.5px serif
    // corner: 12.5px
    // margin: 11.5px (大多走 bare_writing/bare_brush)
    const fontSize = isHero ? 22
        : role === 'margin' ? 11.5
        : role === 'corner' ? 12.5
        : 13.5;
    const lineHeight = isHero ? '30px'
        : role === 'margin' ? '18px'
        : role === 'corner' ? '20px'
        : '23px';

    // hero 永遠走 plain_para, 不參與 skin 抽獎
    const skin = isHero ? 'plain_para' : pickSkin(seedKey, role, isUser, text.length);
    const annotateLevel = isHero ? 'none' : shouldAnnotate(seedKey, role);

    const palIdx = Math.floor(seedFloat(seedKey, 13) * STICKY_PALETTES.length);
    const stickyColor = STICKY_PALETTES[palIdx];

    const authorLabel = isUser ? '我' : (char?.name || '');

    const richProps = {
        text,
        fontSize,
        lineHeight,
        opts: {
            color: PAPER_TONES.ink,
            accent: stickyColor.accent,
            muted: PAPER_TONES.inkSoft,
            boldColor: PAPER_TONES.ink,
            headColor: PAPER_TONES.ink,
        },
    };

    // ─── 作者標籤 — "小滿:" / "鹿鹿:" 體例, 手寫體, 無圓頭像 ───
    // 時間戳跟在名字後, 極小, 整行像真實日記的署名
    const Author: React.FC<{ inkColor?: string }> = ({ inkColor }) => {
        const c = inkColor || PAPER_TONES.ink;
        return (
            <div className="flex items-baseline gap-1 mb-0.5">
                <span
                    style={{
                        ...HANDWRITTEN_STACK,
                        fontSize: fontSize + 1,
                        lineHeight: 1.1,
                        color: c,
                        fontWeight: 600,
                    }}
                >
                    {authorLabel}:
                </span>
                {time && (
                    <span
                        style={{
                            ...HANDWRITTEN_STACK,
                            fontSize: fontSize - 3,
                            color: PAPER_TONES.inkFaint,
                            opacity: 0.75,
                        }}
                    >
                        {time}
                    </span>
                )}
            </div>
        );
    };

    let body: React.ReactNode;

    switch (skin) {
        case 'sticky':
            body = (
                <div className="relative" style={{
                    background: stickyColor.bg,
                    border: `1px solid ${stickyColor.border}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    boxShadow: '0 1px 2px rgba(122,90,114,0.08), 0 4px 10px -8px rgba(122,90,114,0.18)',
                }}>
                    <Author />
                    <JournalRichText {...richProps} />
                    <CardAnnotations seed={seedKey} intensity={annotateLevel} />
                </div>
            );
            break;

        case 'tape_card': {
            const tapeColors = ['#fbb8c8', '#b9d3e0', '#bfe1cf', '#f5e295', '#d6c8e8'];
            const tapeColor = tapeColors[Math.floor(seedFloat(seedKey, 17) * tapeColors.length)];
            body = (
                <div className="relative" style={{
                    background: '#fff',
                    padding: '14px 10px 8px 10px',
                    borderRadius: 3,
                    boxShadow: '0 1px 3px rgba(122,90,114,0.1), 0 4px 10px -8px rgba(122,90,114,0.18)',
                }}>
                    <div style={{
                        position: 'absolute',
                        top: -3, left: 14, width: '40%', height: 14,
                        background: `repeating-linear-gradient(135deg, ${tapeColor} 0 6px, rgba(255,255,255,0.45) 6px 10px)`,
                        clipPath: 'polygon(2% 0, 100% 6%, 99% 100%, 0 95%)',
                        transform: 'rotate(-3deg)',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                    }} />
                    <Author />
                    <JournalRichText {...richProps} />
                    <CardAnnotations seed={seedKey} intensity={annotateLevel} />
                </div>
            );
            break;
        }

        // ─── plain_para — 默認形態: 字直接落在紙上, 僅署名前綴 + 一段文字 ───
        // 不畫 background/border, 用襯線體, 像真實日記裡的一段話
        // hero 模式下放大字號到 22px, 字色更深, 跟其它塊拉開
        case 'plain_para':
            body = (
                <div className="relative" style={{ padding: isHero ? '4px 6px' : '2px 4px' }}>
                    <Author />
                    <JournalRichText
                        {...richProps}
                        fontFamily={isHero
                            ? '"Ma Shan Zheng", "Noto Serif SC", "Songti SC", serif'
                            : '"Noto Serif SC", "Songti SC", serif'}
                    />
                    <CardAnnotations seed={seedKey} intensity={annotateLevel} />
                </div>
            );
            break;

        // ─── Bare 系列 — 不畫卡, 直接像手寫塗鴉在紙上 ──────────
        // 關鍵: 沒有 padding/border/background, 字體走手寫, 字色隨機彩色鋼筆感
        case 'bare_writing': {
            const PEN_COLORS = ['#3d2f3d', '#c94a4a', '#5a7a8e', '#a98ec4', '#88a370', '#d6b85a'];
            const inkColor = PEN_COLORS[Math.floor(seedFloat(seedKey, 4321) * PEN_COLORS.length)];
            body = (
                <div className="relative" style={{ padding: 0 }}>
                    <span
                        style={{
                            ...HANDWRITTEN_STACK,
                            fontSize: fontSize + 6,
                            lineHeight: 1.3,
                            color: inkColor,
                            display: 'block',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}
                    >
                        {text}
                    </span>
                    {/* 落款 — 極小, 跟在末尾 */}
                    <span
                        style={{
                            ...HANDWRITTEN_STACK,
                            fontSize: 11,
                            color: inkColor,
                            opacity: 0.6,
                            display: 'block',
                            marginTop: 1,
                            textAlign: 'right',
                            transform: `rotate(${seedCentered(seedKey, 555, 4)}deg)`,
                            transformOrigin: 'right center',
                        }}
                    >
                        — {authorLabel}
                    </span>
                </div>
            );
            break;
        }

        case 'bare_brush': {
            // 大字 + 下劃線: 像手帳裡的小標題塗鴉
            const inkColor = ['#3d2f3d', '#5a7a8e', '#7a3845', '#5a4035'][Math.floor(seedFloat(seedKey, 4322) * 4)];
            const underlineColor = stickyColor.accent;
            body = (
                <div className="relative" style={{ padding: 0 }}>
                    <span
                        style={{
                            ...BRUSH_STACK,
                            fontSize: fontSize + 12,
                            fontWeight: 700,
                            lineHeight: 1.15,
                            color: inkColor,
                            display: 'inline-block',
                            paddingBottom: 3,
                            borderBottom: `2.5px solid ${underlineColor}`,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                        }}
                    >
                        {text}
                    </span>
                    {authorLabel && authorLabel !== '我' && (
                        <span
                            style={{
                                ...HANDWRITTEN_STACK,
                                fontSize: 10,
                                color: PAPER_TONES.inkFaint,
                                display: 'block',
                                marginTop: 4,
                            }}
                        >
                            — {authorLabel}
                        </span>
                    )}
                </div>
            );
            break;
        }

        default:
            body = <div>{text}</div>;
    }

    return (
        <div
            onClick={onTap}
            style={{
                cursor: onTap ? 'pointer' : 'default',
                width: '100%',
                opacity: page.excluded ? 0.35 : 1,
            }}
        >
            {body}
        </div>
    );
};

export { pickSkin };
export default JournalFragmentCard;
