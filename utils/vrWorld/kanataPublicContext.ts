import { sarNpcContentEnabled } from './sarNpcPreference';
/** Public setting, not private star-event knowledge or a record of having met anyone. */
export const SAR_PUBLIC_CONTEXT = `《彼方》裡還有一間 SAR 活動室，有芯片扭蛋、模塊櫃檯、收藏櫃、佈告板，以及可以釣魚、擺弄橡皮泥恐龍的水域。
凱恩和艾文是來自另一個世界的玩家，也是這裡的兼職管理員。凱恩熱情健談，喜歡遊戲、動畫和新技術，熱衷折騰活動室裡的各種設備；艾文話少，喜歡魚和恐龍，經常待在水邊，也會按當天行情收魚。
你知道他們的基本身份，但是否見過、聊過、熟不熟，要以實際活動記錄和記憶為準。你可以按自己的性格看待他們，不必默認親近。`;
export const sarPublicContext = () => sarNpcContentEnabled() ? SAR_PUBLIC_CONTEXT : SAR_PUBLIC_CONTEXT.split('\n')[0];
