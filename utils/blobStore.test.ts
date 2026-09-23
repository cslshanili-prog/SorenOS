import { describe, it, expect } from 'vitest';
import { DB } from './db';

// fake-indexeddb 已由 test-setup.ts 注入。blob_assets 是混用表（blobRef 圖片之外還有
// VRM 模型、Live2D 運行時緩存、遺留陪伴語音），listBlobAssetIds 是 GC 的世界觀邊界：
// 只許看見 blobRef 自己的 img_（存量）/ b_（SDK 新生成）前綴。別族 id 一旦漏進來，
// GC 就會把用戶的模型/語音當孤兒刪掉——這組用例把過濾行為釘住，當迴歸守衛。

const tinyBlob = () => new Blob(['x'], { type: 'application/octet-stream' });

describe('DB.listBlobAssetIds（blobRef 命名空間過濾）', () => {
    it('混用表裡只返回 img_ / b_ 前綴的 id，其他 id 族一律不可見', async () => {
        await DB.putBlobAsset('img_aaa', tinyBlob());
        await DB.putBlobAsset('b_bbb', tinyBlob());
        // 同表共存的三族非 blobRef id：VRM 模型 / Live2D 運行時緩存 / 遺留陪伴語音
        await DB.putBlobAsset('video-avatar-1234-5678', tinyBlob());
        await DB.putBlobAsset('x:live2d-runtime-store-v1', tinyBlob());
        await DB.putBlobAsset('companion-startup-voice:y', tinyBlob());

        const ids = await DB.listBlobAssetIds();
        expect([...ids].sort()).toEqual(['b_bbb', 'img_aaa']);
    });
});
