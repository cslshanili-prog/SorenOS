import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildZip, openZipWithFallback } from './factory';
import { depsFor, makeDisk, makeWorker } from './opfsFake.testkit';
import type { ZipStreamWriter } from './writer';

const model = (size: number, seed: number) => new Blob([new Uint8Array(size).map((_, i) => (i * seed + 3) & 0xFF)]);

/** 一個「把檔案丟進寫入器」的函式，順便數被叫了幾次 */
const makeBuild = () => {
    let runs = 0;
    const build = async (zip: ZipStreamWriter) => {
        runs++;
        zip.file('models/001.vrm', model(300_000, 7), { compression: 'STORE' });
        await zip.drain();
        zip.file('models/002.live2d.zip', model(200_000, 11), { compression: 'STORE' });
        await zip.drain();
        zip.file('manifest.json', JSON.stringify({ models: 2 }));
    };
    return { build, runs: () => runs };
};

const expectComplete = async (blob: Blob) => {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'models/001.vrm', 'models/002.live2d.zip']);
    expect(await zip.file('manifest.json')!.async('string')).toBe('{"models":2}');
    expect(await zip.file('models/001.vrm')!.async('uint8array')).toEqual(new Uint8Array(await model(300_000, 7).arrayBuffer()));
    expect(await zip.file('models/002.live2d.zip')!.async('uint8array')).toEqual(new Uint8Array(await model(200_000, 11).arrayBuffer()));
};

describe('buildZip：打一包 zip 的共用入口', () => {
    it('這台裝置寫不了暫存檔：輸出留在記憶體，內容完整', async () => {
        const { build, runs } = makeBuild();
        await expectComplete(await buildZip({ tmpPrefix: 'models' }, build));
        expect(runs()).toBe(1);
    });

    it('能寫暫存檔：整包寫進磁碟上的檔，檔名帶種類，只跑一次', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk);
        const { build, runs } = makeBuild();
        await expectComplete(await buildZip({ tmpPrefix: 'models' }, build, { opfs: depsFor(disk, w) }));
        expect(runs()).toBe(1);
        expect([...disk.files.keys()]).toHaveLength(1);
        expect([...disk.files.keys()][0]).toMatch(/^backup-tmp\/models-\d+\.zip$/);
    });

    it('暫存檔寫到一半空間不夠：用記憶體把整段重跑一次，交出來的包還是完整的', async () => {
        const disk = makeDisk({ quotaBytes: 250_000 });
        const w = makeWorker(disk);
        const { build, runs } = makeBuild();
        await expectComplete(await buildZip({ tmpPrefix: 'models' }, build, { opfs: depsFor(disk, w) }));
        expect(runs()).toBe(2);
    });

    it('暫存檔寫完驗不過（讀回來是空的）：一樣用記憶體重跑', async () => {
        const disk = makeDisk({ corruptOnRead: 'empty' });
        const w = makeWorker(disk);
        const { build, runs } = makeBuild();
        await expectComplete(await buildZip({ tmpPrefix: 'emoji' }, build, { opfs: depsFor(disk, w) }));
        expect(runs()).toBe(2);
    });

    it('來源自己出錯（不是暫存檔的問題）：不重跑，錯誤原樣丟出去，暫存檔刪掉', async () => {
        const disk = makeDisk();
        const w = makeWorker(disk);
        let runs = 0;
        await expect(buildZip({ tmpPrefix: 'models' }, async (zip) => {
            runs++;
            zip.file('models/001.vrm', model(1000, 7), { compression: 'STORE' });
            await zip.drain();
            throw new Error('角色資料裡有模型索引，但本地模型文件已經丟失。');
        }, { opfs: depsFor(disk, w) })).rejects.toThrow('已經丟失');
        expect(runs).toBe(1);
        expect([...disk.files.keys()]).toEqual([]);
    });
});

describe('openZipWithFallback：開一個 zip 來讀', () => {
    const pack = async () => {
        const zip = new JSZip();
        zip.file('manifest.json', '{"ok":true}');
        zip.file('models/001.vrm', new Uint8Array([1, 2, 3]), { compression: 'STORE' });
        return zip.generateAsync({ type: 'blob', streamFiles: true });
    };

    it('預設用隨機讀取器（條目有 blob()），內容讀得對', async () => {
        const zip = await openZipWithFallback(await pack());
        expect(await zip.file('manifest.json')!.async('string')).toBe('{"ok":true}');
        const entry = zip.file('models/001.vrm')!;
        expect(typeof entry.blob).toBe('function');
        expect(new Uint8Array(await (await entry.blob()).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('排查開關：強制走 JSZip 也讀得到同樣的內容', async () => {
        const zip = await openZipWithFallback(await pack(), { forceLegacy: true });
        expect(await zip.file('manifest.json')!.async('string')).toBe('{"ok":true}');
        expect(typeof (zip.file('models/001.vrm') as { blob?: unknown }).blob).toBe('undefined');
        expect(await zip.file('models/001.vrm')!.async('uint8array')).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('根本不是 zip：兩種讀法都開不了，丟錯', async () => {
        await expect(openZipWithFallback(new Blob(['這不是壓縮檔']))).rejects.toThrow();
    });
});
