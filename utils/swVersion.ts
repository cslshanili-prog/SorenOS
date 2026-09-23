/**
 * 查詢當前激活 Service Worker 的版本號。
 *
 * 通過 MessageChannel + postMessage 的 GET_SW_VERSION 協議向 SW 詢問，
 * SW 在 worker/sw-keep-alive.ts 裡用 event.ports[0].postMessage({ version }) 回包。
 *
 * 1.5s 總超時通過 race 整個流程實現，避免 `navigator.serviceWorker.ready`
 * 在沒有 SW 接管頁面時（隱私模式、瀏覽器禁用 SW、首次註冊完成前）永遠 pending
 * 讓調用方一直掛著。
 *
 * 釋放：finally 裡 clearTimeout 並 channel.port1.close()——timeout 贏的情況下
 * 內部 Promise 永不 settle，不主動關 port 會讓 MessageChannel + onmessage 閉包
 * 一直掛內存裡，BuildBadge / VersionInfo 反覆掛載會累積。
 *
 * BuildBadge（右下角開發指示器）與 Settings 底部的版本信息都複用這個函數。
 */
const SW_QUERY_TIMEOUT_MS = 1500;

export async function querySwVersion(): Promise<string> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return '?';

    let channel: MessageChannel | undefined;
    let timer: number | undefined;
    // hasTimedOut：保護「ready 永遠 pending → timeout 贏 → finally 已跑」之後 ready 才
    // 終於 resolve 的場景。channel = new MessageChannel() 在 await 之後才發生，
    // 此時 finally 已經過去、再也不會 close()——形成"延遲洩漏"。
    let hasTimedOut = false;

    const query = (async (): Promise<string> => {
        const reg = await navigator.serviceWorker.ready;
        if (hasTimedOut) return '?';
        const target = reg.active || reg.waiting || reg.installing;
        if (!target) return '?';
        channel = new MessageChannel();
        return await new Promise<string>((resolve) => {
            channel!.port1.onmessage = (e) => resolve(e.data?.version ?? '?');
            target.postMessage({ type: 'GET_SW_VERSION' }, [channel!.port2]);
        });
    })();

    const timeout = new Promise<string>((resolve) => {
        timer = window.setTimeout(() => {
            hasTimedOut = true;
            resolve('?');
        }, SW_QUERY_TIMEOUT_MS);
    });

    try {
        return await Promise.race([query, timeout]);
    } catch {
        return '?';
    } finally {
        if (timer !== undefined) window.clearTimeout(timer);
        // 關掉 port1：query 贏時已 resolve，關掉無害；timeout 贏時讓內部 Promise
        // 永遠不會再被外面持有，port + onmessage 閉包可被 GC。
        channel?.port1.close();
    }
}
