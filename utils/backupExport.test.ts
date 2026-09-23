import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { buildMalformedImageDiagnostics, extractImagesInPlace, deepCloneForExport, EXPORT_CHUNK_SIZE, parseImageDataUrlForBackup, sliceRanges, type MalformedBackupImageDiagnostic } from './backupExport';

const IMG = 'data:image/png;base64,AAAA';

describe('extractImagesInPlace', () => {
    it('原地把 data:image 字符串換成 resolveImage 的返回值（不另起一棵樹）', () => {
        const root = { a: IMG, nested: { b: IMG }, list: ['x', IMG] };
        const nestedRef = root.nested;
        extractImagesInPlace(root, () => 'assets/p.png');
        expect(root.a).toBe('assets/p.png');
        expect(root.nested.b).toBe('assets/p.png');
        expect(root.list[1]).toBe('assets/p.png');
        // 是原地改：對象引用沒變
        expect(root.nested).toBe(nestedRef);
    });

    it('非 data:image 字符串和其它原始值原樣保留', () => {
        const root = { keep: 'hello', n: 1, b: true, url: 'https://x/y.png' };
        extractImagesInPlace(root, () => 'assets/SHOULD_NOT_APPEAR.png');
        expect(root).toEqual({ keep: 'hello', n: 1, b: true, url: 'https://x/y.png' });
    });

    it('resolveImage 返回原值時（無法抽取的 data url）字符串保持不變', () => {
        const root = { a: IMG };
        extractImagesInPlace(root, (v) => v);
        expect(root.a).toBe(IMG);
    });

    it('共享子圖只處理一次', () => {
        const shared = { img: IMG };
        const root = { left: shared, right: shared };
        const resolve = vi.fn(() => 'assets/p.png');
        extractImagesInPlace(root, resolve);
        // shared.img 這個 data url 只被解析一次
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(root.left.img).toBe('assets/p.png');
        expect(root.right).toBe(root.left);
    });

    it('遇到自引用循環拋出清楚的錯誤', () => {
        const a: any = { img: IMG };
        a.self = a;
        expect(() => extractImagesInPlace(a, () => 'assets/p.png')).toThrow(/循[环環]引用/);
    });

    it('遇到多級循環（a→b→a）也拋錯', () => {
        const a: any = {};
        const b: any = { back: a };
        a.next = b;
        expect(() => extractImagesInPlace(a, () => 'assets/p.png')).toThrow(/循[环環]引用/);
    });

    it('根是數組時也能遍歷', () => {
        const root: any[] = [IMG, { img: IMG }];
        extractImagesInPlace(root, () => 'assets/p.png');
        expect(root[0]).toBe('assets/p.png');
        expect(root[1].img).toBe('assets/p.png');
    });

    it('把圖片所在對象路徑交給解析器，導出日誌能指出具體字段', () => {
        const root = { rows: [{ id: 'row-1', nested: { image: IMG } }] };
        const paths: Array<Array<string | number>> = [];
        extractImagesInPlace(root, (_value, path) => {
            paths.push(path);
            return 'assets/p.png';
        });
        expect(paths).toEqual([['rows', 0, 'nested', 'image']]);
    });

    // 迴歸：QQ捏人工坊往整合導出/導入。抽取是全字段遞歸、無白名單，所以角色裡
    // 深埋在 chibiStudio / vrState.chibi / specialMomentRecords 下的 data:image 都必須
    // 被抽走（換成 assets/*）。若日後有人給抽取加字段白名單，這條會紅。
    it('角色的 chibiStudio / vrState.chibi / 520 記錄裡的圖都會被遞歸抽取', () => {
        const char: any = {
            id: 'char-1',
            avatar: IMG,
            sprites: { chibi: IMG },
            vrState: { chibi: { img: IMG, state: { selected: { skin: 'skin_1' } } } },
            chibiStudio: {
                room: { state: { selected: { fronthair: 'f_1' } } },          // 純 state 無圖，原樣保留
                like520: { img: IMG, state: { selected: {} } },                // 兜底大頭貼
            },
            specialMomentRecords: {
                like520_2026: { customData: { charChibi: { dataUrl: IMG } } },
            },
        };
        extractImagesInPlace(char, () => 'assets/p.png');
        expect(char.avatar).toBe('assets/p.png');
        expect(char.sprites.chibi).toBe('assets/p.png');
        expect(char.vrState.chibi.img).toBe('assets/p.png');
        expect(char.chibiStudio.like520.img).toBe('assets/p.png');
        expect(char.specialMomentRecords.like520_2026.customData.charChibi.dataUrl).toBe('assets/p.png');
        // state（選件 JSON）不是圖，不動
        expect(char.chibiStudio.room.state.selected.fronthair).toBe('f_1');
        expect(char.vrState.chibi.state.selected.skin).toBe('skin_1');
    });
});

describe('parseImageDataUrlForBackup', () => {
    it('合法圖片正文規範化後可安全交給 JSZip', () => {
        expect(parseImageDataUrlForBackup('data:image/jpeg;base64,AQID\nBA==')).toEqual({
            ok: true,
            extension: 'jpg',
            base64: 'AQIDBA==',
        });
    });

    it('提前攔住截圖裡的 bad content length，不等 generateAsync 才炸整包', () => {
        expect(parseImageDataUrlForBackup('data:image/png;base64,A')).toEqual({
            ok: false,
            reason: 'invalid-length',
        });
    });

    it('非法字符、錯誤 padding、空正文都按損壞素材處理', () => {
        expect(parseImageDataUrlForBackup('data:image/png;base64,@@@@')).toMatchObject({ ok: false });
        expect(parseImageDataUrlForBackup('data:image/png;base64,AA=A')).toMatchObject({ ok: false });
        expect(parseImageDataUrlForBackup('data:image/png;base64,')).toMatchObject({ ok: false });
    });

    it('壞圖只從導出副本置空，不進入 JSZip，也不汙染下一台設備', async () => {
        const zip = new JSZip();
        const assets = zip.folder('assets')!;
        const broken = 'data:image/png;base64,A';
        const liveData = { broken, valid: IMG };
        const root = deepCloneForExport(liveData);
        let malformed = 0;
        const diagnostics: MalformedBackupImageDiagnostic[] = [];

        extractImagesInPlace(root, (value, path) => {
            const parsed = parseImageDataUrlForBackup(value);
            if (!parsed.ok) {
                if (parsed.reason === 'unsupported-header') return value;
                malformed++;
                diagnostics.push({
                    location: path.join('.'),
                    reason: parsed.reason,
                    originalLength: value.length,
                });
                return '';
            }
            assets.file(`asset.${parsed.extension}`, parsed.base64, { base64: true, compression: 'STORE' });
            return `assets/asset.${parsed.extension}`;
        });

        zip.file('data.json', JSON.stringify(root));
        zip.file('diagnostics/malformed-images.json', JSON.stringify(buildMalformedImageDiagnostics({
            createdAt: '2026-08-26T00:00:00.000Z',
            mode: 'full',
            total: malformed,
            items: diagnostics,
        })));
        const bytes = await zip.generateAsync({ type: 'uint8array' });
        const generated = await JSZip.loadAsync(bytes);
        const diagnosticDocument = JSON.parse(await generated.file('diagnostics/malformed-images.json')!.async('string'));

        expect(malformed).toBe(1);
        expect(root.broken).toBe('');
        expect(root.valid).toBe('assets/asset.png');
        expect(JSON.stringify(root)).not.toContain(broken);
        expect(liveData.broken).toBe(broken);
        expect(diagnosticDocument).toMatchObject({
            format: 'sully-backup-malformed-images',
            total: 1,
            included: 1,
            truncated: false,
            items: [{ location: 'broken', reason: 'invalid-length', originalLength: broken.length }],
        });
    });

    it('壞圖過多時診斷清單會明確標記已截斷', () => {
        const one: MalformedBackupImageDiagnostic = {
            location: 'messages[0].image',
            reason: 'invalid-length',
            originalLength: 25,
        };
        const document = buildMalformedImageDiagnostics({
            createdAt: '2026-08-26T00:00:00.000Z',
            mode: 'media_only',
            total: 101,
            items: [one],
        });

        expect(document.truncated).toBe(true);
        expect(document.total).toBe(101);
        expect(document.included).toBe(1);
        expect(document.items).toEqual([one]);
        expect(document).not.toHaveProperty('base64');
    });

    it('SVG 等舊流程本來就不抽取的 data URL 原樣保留，不算損壞', () => {
        const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
        const parsed = parseImageDataUrlForBackup(svg);
        expect(parsed).toEqual({ ok: false, reason: 'unsupported-header' });
    });
});

describe('deepCloneForExport', () => {
    it('深拷貝後改副本不影響原對象', () => {
        const src = { theme: { wallpaper: IMG, nested: { x: 1 } } };
        const copy = deepCloneForExport(src);
        copy.theme.wallpaper = 'changed';
        copy.theme.nested.x = 999;
        expect(src.theme.wallpaper).toBe(IMG);
        expect(src.theme.nested.x).toBe(1);
    });
});

describe('sliceRanges / EXPORT_CHUNK_SIZE', () => {
    it('導出分片大小能被 3 整除（base64 拼接不插入中途補位）', () => {
        expect(EXPORT_CHUNK_SIZE % 3).toBe(0);
    });

    it('切出的區間連續且覆蓋整段', () => {
        const ranges = sliceRanges(25, 10);
        expect(ranges).toEqual([[0, 10], [10, 20], [20, 25]]);
    });

    it('3 字節對齊的分片：各自 base64 後首尾相接，解碼回來就是原始字節', () => {
        const bytes = new Uint8Array(50).map((_, i) => (i * 37) % 256);
        const concat = sliceRanges(bytes.length, 9) // 9 % 3 === 0
            .map(([s, e]) => Buffer.from(bytes.slice(s, e)).toString('base64'))
            .join('');
        const decoded = new Uint8Array(Buffer.from(concat, 'base64'));
        expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });

    it('非 3 字節對齊的分片會在中途分片塞進 = 補位（這就是必須對齊的原因）', () => {
        const bytes = new Uint8Array(20).map((_, i) => i);
        const chunksB64 = sliceRanges(bytes.length, 10) // 10 % 3 !== 0
            .map(([s, e]) => Buffer.from(bytes.slice(s, e)).toString('base64'));
        // 非末尾分片帶上了 '='，拼起來後整體就無法正確解碼
        expect(chunksB64[0]).toContain('=');
    });
});
