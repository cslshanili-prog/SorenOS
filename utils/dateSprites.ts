// 見面模式（DateApp）立繪兜底選擇：角色沒給當前情緒配圖時，挑一張還能看的頂上。
//
// char.sprites 是個混裝袋——除了見面情緒立繪（normal/happy/…/角色自定義的），還裝著
// 小小窩的房間立繪 sprites['chibi']。chibi 是 Q 版小人，和見面模式的半身立繪不是一回事，
// 拿它頂見面立繪會很出戲，所以兜底時整個跳過這個鍵。
//
// 兜底順序：normal/default → 見面情緒鍵 → 其它雜項鍵（跳過 chibi）→ 頭像。
//
// 返回值是「圖片字段值」而不是「能直接加載的地址」：它可能是 blobref 令牌
// （見 utils/blobRef.ts），也可能是 data: / http(s)。消費方一律用 TokenImg 渲染，
// 或用 useBlobRefUrl 解析後再拼 CSS url()，別直接塞進 <img src>。

export function pickDateFallbackSprite(
    sprites: Record<string, string> | undefined | null,
    dateEmotionKeys: string[],
    avatar?: string,
): string | undefined {
    const s = sprites || {};
    const direct = s['normal'] || s['default'];
    if (direct) return direct;
    const emoKey = dateEmotionKeys.find(k => s[k]);
    if (emoKey) return s[emoKey];
    const stray = Object.entries(s).find(([k, v]) => v && k !== 'chibi');
    if (stray) return stray[1];
    return avatar;
}
