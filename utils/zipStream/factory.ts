/**
 * 打 zip、開 zip 的共用入口（plans/backup-streaming.md 第 4 批）。
 *
 * 整合備份以外，還有幾個地方也會打大包（模型備份、表情包）。它們不需要知道 OPFS、Worker、退路這些細節，
 * 只要：
 * - `buildZip(...)`：給一個「把檔案丟進寫入器」的函式，拿回整包。能寫磁碟就寫磁碟上的暫存檔，
 *   寫不成就用記憶體重跑一次。
 * - `openZipWithFallback(blob)`：開一個 zip 來讀。只讀目錄、要哪個檔才讀那一段；讀不懂才退回 JSZip。
 */
import { createMemorySink, createZipStreamWriter, type DeflateRaw, type ZipStreamWriter } from './writer';
import { clearBackupTempFiles, createOpfsSink, isOpfsSinkSupported, type OpfsSink, type OpfsSinkDeps } from './opfsSink';
import { openZipReader, type BackupZipReader, type InflateRaw, type InflateStream } from './reader';

/** 原始 DEFLATE 壓縮（fflate，用到才載） */
let deflateRawPromise: Promise<DeflateRaw> | null = null;
export const loadDeflateRaw = (): Promise<DeflateRaw> => {
    if (!deflateRawPromise) {
        deflateRawPromise = import('fflate')
            .then((mod): DeflateRaw => (data, options) => mod.deflateSync(data, { level: options.level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }))
            .catch((error) => {
                deflateRawPromise = null;
                throw new Error(`壓縮元件載入失敗：${error instanceof Error ? error.message : 'unknown error'}`);
            });
    }
    return deflateRawPromise;
};

/** 原始 DEFLATE 解壓：整塊解的和邊餵邊吐的各一個 */
let inflatersPromise: Promise<{ inflate: InflateRaw; createInflateStream: () => InflateStream }> | null = null;
export const loadInflaters = (): Promise<{ inflate: InflateRaw; createInflateStream: () => InflateStream }> => {
    if (!inflatersPromise) {
        inflatersPromise = import('fflate')
            .then((mod) => ({
                inflate: ((data, size) => mod.inflateSync(data, { out: new Uint8Array(size) })) as InflateRaw,
                createInflateStream: (): InflateStream => {
                    let out: Uint8Array[] = [];
                    const inflater = new mod.Inflate((chunk) => { out.push(chunk); });
                    return { push(data, final) { out = []; inflater.push(data, final); return out; } };
                },
            }))
            .catch((error) => {
                inflatersPromise = null;
                throw new Error(`解壓元件載入失敗：${error instanceof Error ? error.message : 'unknown error'}`);
            });
    }
    return inflatersPromise;
};

/**
 * 開一個 zip 來讀。預設用隨機讀取器（整個檔不進記憶體）；它讀不懂的（加密、分卷、不認得的壓縮法）
 * 才退回 JSZip 整包讀。`forceLegacy` 給排查開關用。
 */
export const openZipWithFallback = async (blob: Blob, options: { forceLegacy?: boolean } = {}): Promise<BackupZipReader> => {
    if (!options.forceLegacy) {
        try {
            return await openZipReader(blob, await loadInflaters());
        } catch (error) {
            console.warn('[Zip] 隨機讀取開不了這個檔，退回整包讀', error);
        }
    }
    const JSZip = (await import('jszip')).default;
    // JSZip 收 Blob 時自己也是先整個讀成 ArrayBuffer；這裡直接給，少繞一層 FileReader
    return (await JSZip.loadAsync(await blob.arrayBuffer())) as unknown as BackupZipReader;
};

/** 開始打新的一包之前，別人的暫存檔放超過這麼久才清（可能還在下載中） */
const OTHER_TEMP_KEEP_MS = 10 * 60 * 1000;

/**
 * 打一包 zip。`build` 只管把檔案丟進寫入器（記得每丟一個大檔就 `await writer.drain()`）。
 * 輸出能寫磁碟就寫 OPFS 的暫存檔（`backup-tmp/<tmpPrefix>-<時間>.zip`），整包不留在記憶體；
 * 沒有 OPFS 或開不了檔就用記憶體。寫到一半失敗或寫完驗不過，用記憶體把 `build` 重跑一次，
 * 所以 `build` 要能重跑（每次自己重新讀來源）。
 */
export async function buildZip(
    options: { tmpPrefix: string; level?: number },
    build: (writer: ZipStreamWriter) => Promise<void>,
    /** 測試用：換掉 Worker 和讀檔，有給就當作這台裝置能寫暫存檔 */
    deps?: { opfs?: OpfsSinkDeps },
): Promise<Blob> {
    const deflate = await loadDeflateRaw();
    // 同一種包上一次留下的暫存檔可以清；別種的（例如剛導出還在下載的整合備份）放久了才清
    await clearBackupTempFiles({ prefixes: [`${options.tmpPrefix}-`], olderThanMs: OTHER_TEMP_KEEP_MS });

    let opfs: OpfsSink | null = null;
    if (deps?.opfs || isOpfsSinkSupported()) {
        try {
            opfs = await createOpfsSink({ fileName: `${options.tmpPrefix}-${Date.now()}.zip` }, deps?.opfs);
        } catch (error) {
            console.warn('[Zip] 開不了暫存檔，輸出留在記憶體', error);
        }
    }

    const run = async (sink: OpfsSink | null): Promise<Blob> => {
        const writer = createZipStreamWriter({ deflate, sink: sink || createMemorySink(), level: options.level });
        try {
            await build(writer);
            return await writer.finish();
        } catch (error) {
            await writer.abort().catch(() => undefined);
            throw error;
        }
    };

    try {
        return await run(opfs);
    } catch (error) {
        // 暫存檔那一頭出的事（空間不夠、驗不過、背景執行緒掛了）：來源沒問題，改用記憶體重來
        if (opfs?.failed) {
            console.warn('[Zip] 暫存檔寫入失敗，改用記憶體重新打包', error);
            return run(null);
        }
        throw error;
    }
}
