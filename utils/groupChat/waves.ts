/**
 * 群聊「各自發言模式」（原輪詢模式，replyMode roundRobin）的排班：一輪裡誰先開口、誰後開口。
 *
 * 順序每輪隨機打亂，分兩波：
 * - 第一波隨機抽 1～2 人（成員只有兩個時就 1 人）同時生成，誰的 API 先回來誰先出現在群裡；
 * - 第二波是剩下的人，也是同時生成，但他們看得到第一波剛說的話，可以接話、吐槽或沉默。
 *
 * 全員排隊一個一個來太慢，全員同時開口又看不到彼此、容易全對著用戶各說一句撞在一起，
 * 兩波是中間的折衷。這裡只排班，不碰網絡。
 */
export function planGroupWaves<T>(speakers: readonly T[], random: () => number = Math.random): T[][] {
    const order = [...speakers];
    // Fisher–Yates
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.length <= 1) return order.length ? [order] : [];
    const firstSize = order.length === 2 ? 1 : (random() < 0.5 ? 1 : 2);
    return [order.slice(0, firstSize), order.slice(firstSize)];
}
