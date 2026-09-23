import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatParser } from './chatParser';
import { DB } from './db';
import * as imageGeneration from './imageGeneration';

// [[ACTION:SEND_PHOTO|畫面描述]] —— 角色自主發圖接進聊天管線後的執行側（教沒教這個動作是
// chatPrompts.ts 的事，這裡只測「標籤出現時該不該真生成、生成完該落成什麼」）。

const noop = () => {};
const TEST_IMAGE_GEN_CONFIG = {
    charImageGenEnabled: true,
    charImageSendEnabled: true,
    baseUrl: 'https://fake-image-api.test/v1',
    model: 'fake-image-model',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('[[ACTION:SEND_PHOTO]]', () => {
    it('沒傳 imageGenConfig → 標籤原樣剝掉，不生成、不落圖片消息', async () => {
        const charId = `c-photo-noconfig-${Date.now()}`;
        const gen = vi.spyOn(imageGeneration, 'generateImage');

        const out = await ChatParser.parseAndExecuteActions(
            '給你看張照片\n[[ACTION:SEND_PHOTO|窗邊的貓]]',
            charId, '阿一', noop,
        );

        expect(out).toBe('給你看張照片');
        expect(gen).not.toHaveBeenCalled();
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs.some(m => m.type === 'image')).toBe(false);
    });

    it('配置齊全 → 調 generateImage，落一條 image 類型消息', async () => {
        const charId = `c-photo-ok-${Date.now()}`;
        const gen = vi.spyOn(imageGeneration, 'generateImage').mockResolvedValue({
            dataUrl: 'data:image/png;base64,AAAA',
        });

        const out = await ChatParser.parseAndExecuteActions(
            '給你看張照片\n[[ACTION:SEND_PHOTO|窗邊的貓]]',
            charId, '阿一', noop, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        expect(out).toBe('給你看張照片');
        expect(gen).toHaveBeenCalledTimes(1);
        expect(gen.mock.calls[0][0]).toMatchObject(TEST_IMAGE_GEN_CONFIG);
        expect(gen.mock.calls[0][1]).toContain('窗邊的貓');

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const imgMsg = msgs.find(m => m.type === 'image');
        expect(imgMsg).toBeDefined();
        expect(imgMsg?.role).toBe('assistant');
        expect(imgMsg?.metadata).toMatchObject({ aiGenerated: true, imagePrompt: '窗邊的貓' });
    });

    it('生成失敗 → toast 一次 + 標籤仍被剝掉，不拋出', async () => {
        const charId = `c-photo-fail-${Date.now()}`;
        vi.spyOn(imageGeneration, 'generateImage').mockRejectedValue(new Error('boom'));
        const addToast = vi.fn();

        const out = await ChatParser.parseAndExecuteActions(
            '給你看張照片\n[[ACTION:SEND_PHOTO|窗邊的貓]]',
            charId, '阿一', addToast, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        expect(out).toBe('給你看張照片');
        expect(addToast).toHaveBeenCalledTimes(1);
        expect(addToast.mock.calls[0][0]).toContain('阿一');
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs.some(m => m.type === 'image')).toBe(false);
    });

    it('配置齊全 → 圖片同時存進這個角色的相冊（sender=char，指向剛落的消息）', async () => {
        const charId = `c-photo-gallery-${Date.now()}`;
        vi.spyOn(imageGeneration, 'generateImage').mockResolvedValue({
            dataUrl: 'data:image/png;base64,AAAA',
        });

        await ChatParser.parseAndExecuteActions(
            '給你看張照片\n[[ACTION:SEND_PHOTO|窗邊的貓]]',
            charId, '阿一', noop, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const imgMsg = msgs.find(m => m.type === 'image');
        expect(imgMsg).toBeDefined();

        const galleryImages = await DB.getGalleryImages(charId);
        expect(galleryImages).toHaveLength(1);
        expect(galleryImages[0]).toMatchObject({
            charId, sender: 'char', sourceMessageId: imgMsg!.id, url: imgMsg!.content,
        });
    });

    it('一輪裡兩個標籤 → 順序生成兩張，都落庫', async () => {
        const charId = `c-photo-multi-${Date.now()}`;
        const gen = vi.spyOn(imageGeneration, 'generateImage').mockResolvedValue({
            dataUrl: 'data:image/png;base64,AAAA',
        });

        const out = await ChatParser.parseAndExecuteActions(
            '看這兩張\n[[ACTION:SEND_PHOTO|窗邊的貓]]\n[[ACTION:SEND_PHOTO|樓下的晚霞]]',
            charId, '阿一', noop, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        expect(out).toBe('看這兩張');
        expect(gen).toHaveBeenCalledTimes(2);
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs.filter(m => m.type === 'image').length).toBe(2);
    });
});
