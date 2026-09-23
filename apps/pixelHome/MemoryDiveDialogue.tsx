/**
 * Memory Dive — 對話框（純粹的像素框 + 分頁 + 打字機）
 *
 * 本組件只負責一個像素邊框的小對話框。外層容器（位置、寬高、
 * 背景、加載態浮層）由父組件負責——現在對話框懸浮在上屏房間
 * 的下沿，而下屏是獨立的氛圍面板。
 *
 * 選項出現 / 加載中 / 無內容時，父組件不渲染本組件。
 */

import React, { useEffect, useState, useRef, useMemo } from 'react';
import type { DiveDialogue } from './memoryDiveTypes';
import { isImageValue } from '../../utils/blobRef';
import TokenImg from '../../components/os/TokenImg';

interface Props {
  current: DiveDialogue | null;
  /** 本句後還有多少條在排隊（僅影響 ▼/◆ 提示） */
  queueRemaining: number;
  /** 這條說完後是否會立刻出選項（影響 ▼/◆ 提示） */
  choicesPending: boolean;
  charName: string;
  charAvatar?: string;
  disabled: boolean;
  onAdvance: () => void;
}

const TYPE_SPEED_MS = 22;
// 每頁允許的最多視覺行數（超過就硬切）——保守估計 3 行
const PAGE_MAX_LINES = 3;
// 窄屏中文每行大約能容的字數（頭像右側 ~260px / 13px ≈ 20 字）
const CHARS_PER_LINE = 20;
// 每頁字符硬上限。作為 line-based 限制之外的保險絲，防止單頁過長；
// 取 CHARS_PER_LINE * PAGE_MAX_LINES，也就是 3 行能裝滿的理論極限。
const PAGE_CHAR_LIMIT = CHARS_PER_LINE * PAGE_MAX_LINES;

/** 估計一段文本渲染成幾行（考慮顯式 \n） */
function estimateLines(s: string): number {
  if (!s) return 0;
  const segs = s.split('\n');
  let n = 0;
  for (const seg of segs) {
    n += Math.max(1, Math.ceil(seg.length / CHARS_PER_LINE));
  }
  return n;
}

/**
 * 按"段落 → 限定字數 & 限定行數"兩步切頁：
 *   1. 先按 \n\n 切成段落（絕對頁邊界）
 *   2. 段落內按字數上限 + 估算行數兩路限制切
 */
function paginate(text: string, charLimit: number): string[] {
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const pages: string[] = [];
  for (const para of paragraphs) {
    pages.push(...paginateParagraph(para, charLimit));
  }
  return pages;
}

function paginateParagraph(text: string, limit: number): string[] {
  if (!text) return [];
  // 只要能在 PAGE_MAX_LINES 行內塞下，就保持單頁——字符數不再是獨立門檻，
  // 避免 40 字左右的句子被多餘地劈成兩頁
  if (estimateLines(text) <= PAGE_MAX_LINES && text.length <= limit) return [text];

  // 單字符斷句點（中英文標點 + 換行 + 單個 em dash）；'——' 連字會在循環裡特殊處理
  const breakChars = new Set(['。', '！', '？', '；', '\n', '，', '、', ',', '.', '!', '?', '—', '-']);
  const pages: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + limit, text.length);
    // 在合理窗口裡找最近的標點/換行斷開
    if (end < text.length) {
      let found = -1;
      const minEnd = i + Math.floor(limit * 0.55);
      for (let j = end; j >= minEnd; j--) {
        if (breakChars.has(text[j]) || text[j] === '\n') { found = j + 1; break; }
      }
      if (found > 0) end = found;
    }
    let piece = text.slice(i, end).replace(/^\s+/, '');
    // 若估算行數超限，繼續縮短
    while (estimateLines(piece) > PAGE_MAX_LINES && piece.length > 1) {
      piece = piece.slice(0, piece.length - 1);
      end = i + piece.length + (text.slice(i, end).length - piece.length);
    }
    // 重新定位 end（以保留字符數為準）
    end = i + piece.length;
    if (piece) pages.push(piece);
    i = end;
    // 吃掉緊跟的空白，防止下一頁開頭是空格/換行
    while (i < text.length && /\s/.test(text[i])) i++;
  }
  return pages;
}

const MemoryDiveDialogue: React.FC<Props> = ({
  current, queueRemaining, choicesPending, charName, charAvatar,
  disabled, onAdvance,
}) => {
  const pages = useMemo(
    () => (current ? paginate(current.text, PAGE_CHAR_LIMIT) : []),
    [current?.id, current?.text],
  );
  const [pageIdx, setPageIdx] = useState(0);
  useEffect(() => { setPageIdx(0); }, [current?.id]);
  const currentPage = pages[pageIdx] || '';
  const isLastPage = pageIdx >= pages.length - 1;

  const [typed, setTyped] = useState(0);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    setTyped(0);
    if (!currentPage) return;
    let i = 0;
    timerRef.current = window.setInterval(() => {
      i++;
      setTyped(i);
      if (i >= currentPage.length && timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, TYPE_SPEED_MS);
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [currentPage]);
  const isPageComplete = typed >= currentPage.length;

  const handleTap = () => {
    if (disabled) return;
    if (!current) return;
    if (!isPageComplete) { setTyped(currentPage.length); return; }
    if (!isLastPage) { setPageIdx(i => i + 1); return; }
    onAdvance();
  };

  const isEmojiAvatar = !!charAvatar && !isImageValue(charAvatar);
  const isImageAvatar = !!charAvatar && !isEmojiAvatar;

  const advanceGlyph =
    !isLastPage ? '▼' :
    queueRemaining > 0 ? '▼' :
    choicesPending ? '◆' : '◆';

  return (
    <div
      className="relative bg-slate-900/95 rounded-sm"
      style={{
        height: 108,
        boxShadow:
          'inset 0 0 0 2px #1e293b, inset 0 0 0 4px #475569, 0 0 0 1px #0f172a, 0 4px 18px rgba(0,0,0,0.55)',
      }}
    >
      {/* 只保留右上/左上兩個裝飾像素，底部讓位給右下的推進指示器
          （之前 bl/br 兩顆會和 ▼/◆ 混淆） */}
      <CornerPx pos="tl" /><CornerPx pos="tr" />

      {/* 頭像 + 說話人名字（作為整體豎直居中） */}
      <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 w-16">
        <div className="w-16 h-16">
          {current?.speaker === 'character' && (
            <AvatarFace src={charAvatar} isEmoji={isEmojiAvatar} isImage={isImageAvatar}
              glyph="·" toneClass="border-violet-500/60 bg-violet-900/30" />
          )}
          {current?.speaker === 'narrator' && (
            <AvatarFace src={undefined} isEmoji={false} isImage={false}
              glyph="📖" toneClass="border-slate-600/60 bg-slate-800/60" />
          )}
        </div>
        {current?.speaker === 'character' && (
          <div className="max-w-full px-1.5 py-0.5 rounded-sm bg-slate-800/90 border border-violet-500/50 text-[10px] leading-none font-bold text-violet-200 truncate">
            {charName}
          </div>
        )}
        {current?.speaker === 'narrator' && (
          <div className="max-w-full px-1.5 py-0.5 rounded-sm bg-slate-800/90 border border-slate-600/60 text-[9px] leading-none uppercase tracking-[0.2em] text-slate-400 truncate">
            旁白
          </div>
        )}
      </div>

      {/* 文本區 —— 名字已上移到頭像下方的小框裡，這裡只放台詞 */}
      <button
        type="button"
        onClick={handleTap}
        disabled={disabled || !current}
        className="absolute left-[76px] right-2 top-3 bottom-6 text-left flex flex-col min-w-0"
      >
        <div className="flex-1 min-h-0 overflow-hidden text-[12.5px] leading-[1.5] text-slate-100 whitespace-pre-wrap">
          {current && (
            <>
              {currentPage.slice(0, typed)}
              {!isPageComplete && (
                <span className="ml-0.5 inline-block w-1.5 h-3 align-middle bg-slate-400 animate-pulse" />
              )}
            </>
          )}
        </div>
      </button>

      {/* 右下角：頁碼 + 推進箭頭（絕對定位，保證永遠貼在框右下） */}
      <div className="absolute right-2 bottom-1 flex items-center gap-1.5 pointer-events-none">
        {current && pages.length > 1 && (
          <span className="text-[9px] text-slate-600">{pageIdx + 1}/{pages.length}</span>
        )}
        {current && isPageComplete && (
          <span className="text-[11px] text-amber-300/90 animate-bounce"
            style={{ animationDuration: '1.2s' }}>
            {advanceGlyph}
          </span>
        )}
      </div>
    </div>
  );
};

const AvatarFace: React.FC<{
  src?: string;
  isEmoji: boolean;
  isImage: boolean;
  glyph: string;
  toneClass: string;
}> = ({ src, isEmoji, isImage, glyph, toneClass }) => (
  <div
    className={`w-full h-full rounded-sm border-2 overflow-hidden flex items-center justify-center ${toneClass}`}
    style={{ imageRendering: 'pixelated' as any }}
  >
    {isImage && (
      <TokenImg value={src} className="w-full h-full object-cover"
        style={{ imageRendering: 'pixelated' as any }} draggable={false} alt="" />
    )}
    {isEmoji && <span className="text-3xl">{src}</span>}
    {!isImage && !isEmoji && (
      <span className="text-2xl opacity-70">{glyph}</span>
    )}
  </div>
);

const CornerPx: React.FC<{ pos: 'tl' | 'tr' | 'bl' | 'br' }> = ({ pos }) => {
  const p: Record<string, string> = {
    tl: 'top-0 left-0', tr: 'top-0 right-0',
    bl: 'bottom-0 left-0', br: 'bottom-0 right-0',
  };
  return <div className={`absolute ${p[pos]} w-1.5 h-1.5 bg-amber-400/70 pointer-events-none`} />;
};

export default MemoryDiveDialogue;
