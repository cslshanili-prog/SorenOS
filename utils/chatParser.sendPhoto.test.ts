import { describe, expect, it, vi, afterEach } from 'vitest';
import { ChatParser } from './chatParser';
import { DB } from './db';
import * as imageGeneration from './imageGeneration';

// [[ACTION:SEND_PHOTO|画面描述]] —— 角色自主发图接进聊天管线后的执行侧（教没教这个动作是
// chatPrompts.ts 的事，这里只测「标签出现时该不该真生成、生成完该落成什么」）。

const noop = () => {};
const TEST_IMAGE_GEN_CONFIG = {
    charImageGenEnabled: true,
    charImageSendEnabled: true,
    baseUrl: 'https://fake-image-api.test/v1',
    model: 'fake-image-model',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('[[ACTION:SEND_PHOTO]]', () => {
    it('没传 imageGenConfig → 标签原样剥掉，不生成、不落图片消息', async () => {
        const charId = `c-photo-noconfig-${Date.now()}`;
        const gen = vi.spyOn(imageGeneration, 'generateImage');

        const out = await ChatParser.parseAndExecuteActions(
            '给你看张照片\n[[ACTION:SEND_PHOTO|窗边的猫]]',
            charId, '阿一', noop,
        );

        expect(out).toBe('给你看张照片');
        expect(gen).not.toHaveBeenCalled();
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs.some(m => m.type === 'image')).toBe(false);
    });

    it('配置齐全 → 调 generateImage，落一条 image 类型消息', async () => {
        const charId = `c-photo-ok-${Date.now()}`;
        const gen = vi.spyOn(imageGeneration, 'generateImage').mockResolvedValue({
            dataUrl: 'data:image/png;base64,AAAA',
        });

        const out = await ChatParser.parseAndExecuteActions(
            '给你看张照片\n[[ACTION:SEND_PHOTO|窗边的猫]]',
            charId, '阿一', noop, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        expect(out).toBe('给你看张照片');
        expect(gen).toHaveBeenCalledTimes(1);
        expect(gen.mock.calls[0][0]).toMatchObject(TEST_IMAGE_GEN_CONFIG);
        expect(gen.mock.calls[0][1]).toContain('窗边的猫');

        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        const imgMsg = msgs.find(m => m.type === 'image');
        expect(imgMsg).toBeDefined();
        expect(imgMsg?.role).toBe('assistant');
        expect(imgMsg?.metadata).toMatchObject({ aiGenerated: true, imagePrompt: '窗边的猫' });
    });

    it('生成失败 → toast 一次 + 标签仍被剥掉，不抛出', async () => {
        const charId = `c-photo-fail-${Date.now()}`;
        vi.spyOn(imageGeneration, 'generateImage').mockRejectedValue(new Error('boom'));
        const addToast = vi.fn();

        const out = await ChatParser.parseAndExecuteActions(
            '给你看张照片\n[[ACTION:SEND_PHOTO|窗边的猫]]',
            charId, '阿一', addToast, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        expect(out).toBe('给你看张照片');
        expect(addToast).toHaveBeenCalledTimes(1);
        expect(addToast.mock.calls[0][0]).toContain('阿一');
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs.some(m => m.type === 'image')).toBe(false);
    });

    it('配置齐全 → 图片同时存进这个角色的相册（sender=char，指向刚落的消息）', async () => {
        const charId = `c-photo-gallery-${Date.now()}`;
        vi.spyOn(imageGeneration, 'generateImage').mockResolvedValue({
            dataUrl: 'data:image/png;base64,AAAA',
        });

        await ChatParser.parseAndExecuteActions(
            '给你看张照片\n[[ACTION:SEND_PHOTO|窗边的猫]]',
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

    it('一轮里两个标签 → 顺序生成两张，都落库', async () => {
        const charId = `c-photo-multi-${Date.now()}`;
        const gen = vi.spyOn(imageGeneration, 'generateImage').mockResolvedValue({
            dataUrl: 'data:image/png;base64,AAAA',
        });

        const out = await ChatParser.parseAndExecuteActions(
            '看这两张\n[[ACTION:SEND_PHOTO|窗边的猫]]\n[[ACTION:SEND_PHOTO|楼下的晚霞]]',
            charId, '阿一', noop, undefined, undefined, undefined, undefined, undefined,
            TEST_IMAGE_GEN_CONFIG,
        );

        expect(out).toBe('看这两张');
        expect(gen).toHaveBeenCalledTimes(2);
        const msgs = await DB.getRecentMessagesByCharId(charId, 50);
        expect(msgs.filter(m => m.type === 'image').length).toBe(2);
    });
});
