import { beforeEach, describe, expect, it } from 'vitest';
import {
    canGenerateCharPhoto, nextPendingPhotoMeta, PENDING_PHOTO_MAX_AUTO_ATTEMPTS,
    readPendingPhotoIndex, trackPendingPhoto, untrackPendingPhoto,
} from './pendingPhoto';

describe('待補清單', () => {
    beforeEach(() => localStorage.clear());

    it('記下、移除', () => {
        trackPendingPhoto(12, 'a');
        trackPendingPhoto(13, 'b');
        expect(readPendingPhotoIndex()).toEqual({ '12': 'a', '13': 'b' });
        untrackPendingPhoto(12);
        untrackPendingPhoto(99);
        expect(readPendingPhotoIndex()).toEqual({ '13': 'b' });
        untrackPendingPhoto(13);
        expect(localStorage.getItem('soren_pending_photos')).toBeNull();
    });

    it('壞掉的存檔當作空的', () => {
        localStorage.setItem('soren_pending_photos', '[1,2]');
        expect(readPendingPhotoIndex()).toEqual({});
    });
});

describe('失敗之後', () => {
    it('累計次數，到上限停止自動重試', () => {
        let meta = { description: '自拍', attempts: 0 };
        for (let i = 1; i < PENDING_PHOTO_MAX_AUTO_ATTEMPTS; i++) {
            meta = nextPendingPhotoMeta(meta, 'network');
            expect(meta.attempts).toBe(i);
            expect((meta as { gaveUp?: boolean }).gaveUp).toBeUndefined();
        }
        const last = nextPendingPhotoMeta(meta, 'x'.repeat(500));
        expect(last.gaveUp).toBe(true);
        expect(last.lastError?.length).toBe(200);
    });

    it('生圖要開著、配齊才生', () => {
        expect(canGenerateCharPhoto(undefined)).toBe(false);
        expect(canGenerateCharPhoto({ charImageGenEnabled: true, charImageSendEnabled: true, baseUrl: 'u', model: 'm' } as never)).toBe(true);
        expect(canGenerateCharPhoto({ charImageGenEnabled: true, charImageSendEnabled: false, baseUrl: 'u', model: 'm' } as never)).toBe(false);
    });
});
