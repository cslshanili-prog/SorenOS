/** 把消息時間轉成模型更容易感知的相對時間，避免把幾天前的群聊當成“剛才”。 */
export function formatRelativeAge(timestamp: number, now: number = Date.now()): string {
    if (!Number.isFinite(timestamp)) return '時間未知';

    const deltaMs = Math.max(0, now - timestamp);
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 1) return '剛剛';
    if (minutes < 60) return `約 ${minutes} 分鐘前`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `約 ${hours} 小時前`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `約 ${days} 天前`;

    const months = Math.floor(days / 30);
    if (months < 12) return `約 ${months} 個月前`;

    const years = Math.max(1, Math.floor(days / 365));
    return `約 ${years} 年前`;
}
