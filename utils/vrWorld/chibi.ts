/**
 * 彼方 chibi 立繪解析（單一來源）：vrState.chibi → date 皮膚/sprites → 頭像兜底。
 * VRWorldApp 的房間站位、劇院的演出回放共用這套邏輯。
 *
 * 返回的 img 是「圖片字段值」而不是「能直接加載的地址」：捏出來的 chibi 與頭像都可能是
 * blobref 令牌（見 utils/blobRef.ts）。消費方一律用 TokenImg 渲染，或用 useBlobRefUrl
 * 解析後再拼 CSS url()，別直接塞進 <img src>。
 */
import type { CharacterProfile } from '../../types';

export interface ChibiDisplay {
    img: string;
    scale: number;
    offsetY: number;
    flip: boolean;
    /** 是否走了兜底（沒專屬 chibi） */
    isFallback: boolean;
}

export const getChibi = (char: CharacterProfile): ChibiDisplay => {
    const c = char.vrState?.chibi;
    if (c?.img) return { img: c.img, scale: c.scale ?? 1, offsetY: c.offsetY ?? 0, flip: !!c.flip, isFallback: false };
    const sprites = (char.activeSkinSetId && char.dateSkinSets?.find(s => s.id === char.activeSkinSetId)?.sprites)
        || char.sprites || {};
    const fb = sprites['happy'] || sprites['normal'] || sprites['smile'] || char.avatar || '';
    return { img: fb, scale: 1, offsetY: 0, flip: false, isFallback: true };
};
