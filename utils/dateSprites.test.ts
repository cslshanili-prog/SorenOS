import { describe, it, expect } from 'vitest';
import { pickDateFallbackSprite } from './dateSprites';

const KEYS = ['normal', 'happy', 'angry', 'sad', 'shy'];
const AVATAR = 'blobref:b_avatar';

describe('pickDateFallbackSprite', () => {
    it('優先 normal / default', () => {
        expect(pickDateFallbackSprite({ normal: 'data:n', happy: 'data:h' }, KEYS, AVATAR)).toBe('data:n');
        expect(pickDateFallbackSprite({ default: 'data:d' }, KEYS, AVATAR)).toBe('data:d');
    });

    it('無 normal 時按見面情緒鍵兜底', () => {
        expect(pickDateFallbackSprite({ shy: 'data:s' }, KEYS, AVATAR)).toBe('data:s');
        expect(pickDateFallbackSprite({ excited: 'data:e' }, [...KEYS, 'excited'], AVATAR)).toBe('data:e');
    });

    // ↓ 三條釘住：立繪存的是 blobref 令牌時照選不誤，不會被跳過、也不會退回頭像。
    //   渲染方（TokenImg / useBlobRefUrl）認令牌，這裡只管挑值。
    it('normal 是令牌 → 直接選它', () => {
        expect(pickDateFallbackSprite({ normal: 'blobref:b_normal' }, KEYS, AVATAR)).toBe('blobref:b_normal');
    });

    it('見面情緒鍵是令牌 → 直接選它', () => {
        expect(pickDateFallbackSprite({ shy: 'blobref:b_shy' }, KEYS, AVATAR)).toBe('blobref:b_shy');
    });

    it('雜項鍵是令牌 → 直接選它，不回落頭像', () => {
        expect(pickDateFallbackSprite({ legacy_pose: 'blobref:b_xyz' }, KEYS, AVATAR)).toBe('blobref:b_xyz');
    });

    // ↓ 兜底順序本身不變：chibi 永遠不當見面立繪用，值是什麼格式都一樣。
    it('只有 chibi（令牌）時回落到頭像', () => {
        expect(pickDateFallbackSprite({ chibi: 'blobref:b_chibi' }, KEYS, AVATAR)).toBe(AVATAR);
    });

    it('chibi 即使是 dataURL 也不當見面立繪用', () => {
        expect(pickDateFallbackSprite({ chibi: 'data:image/png;base64,CHIBI' }, KEYS, AVATAR)).toBe(AVATAR);
    });

    it('chibi 與雜項鍵並存時選雜項鍵，跳過 chibi', () => {
        expect(pickDateFallbackSprite({ chibi: 'blobref:b_chibi', legacy_pose: 'data:p' }, KEYS, AVATAR)).toBe('data:p');
    });

    it('情緒鍵優先於雜項鍵', () => {
        expect(pickDateFallbackSprite({ legacy_pose: 'data:p', happy: 'data:h' }, KEYS, AVATAR)).toBe('data:h');
    });

    it('非 chibi 的雜項鍵、可直接渲染的值仍可兜底', () => {
        expect(pickDateFallbackSprite({ legacy_pose: 'https://img.example/a.png' }, KEYS, AVATAR)).toBe('https://img.example/a.png');
    });

    it('空 sprites / undefined → 頭像；連頭像都沒有 → undefined', () => {
        expect(pickDateFallbackSprite({}, KEYS, AVATAR)).toBe(AVATAR);
        expect(pickDateFallbackSprite(undefined, KEYS, AVATAR)).toBe(AVATAR);
        expect(pickDateFallbackSprite(undefined, KEYS, undefined)).toBeUndefined();
    });
});
