/**
 * 消化一條 `schedule-change` 結果（角色在後台改了自己的日程）。
 *
 * 結果的形狀與「為什麼要單獨走一條通道」見 utils/amsgScheduleResult.ts。這份文件只管
 * 落地：取表 → 改 → 存 → 通知界面 → 把雲端那份 fire_pack 打髒。
 *
 * 單獨一份文件是為了讓 amsgResults 的分發表能動態 import 它——落庫這條路要拖 IndexedDB
 * 和整套日程依賴，靜態引進去會把它們塞進補收鏈路的首屏包。
 */

import { DB } from './db';
import { announceScheduleChanges, applyScheduleChangeDirectives } from './scheduleChange';
import { parseScheduleChangeResult } from './amsgScheduleResult';
import { markAmsgStateDirty } from './amsgStateSync';
import type { AmsgResultContext } from './amsgResults';

const HEADER = '[amsg2:schedule-change]';

export const applyScheduleChangeResult = async (
    payload: unknown,
    _context?: AmsgResultContext,
): Promise<boolean> => {
    const result = parseScheduleChangeResult(payload);
    if (!result) {
        console.warn(`${HEADER} 結果形狀認不出來，丟棄`, payload);
        return true;
    }

    const characters = await DB.getAllCharacters();
    const char = characters.find((c) => c.id === result.charId);
    if (!char) {
        // 角色已經被刪了：這條永遠沒有落點，留著只會每次上線重放一遍。
        console.warn(`${HEADER} 找不到角色 ${result.charId}（已刪除？），銷帳丟棄`);
        return true;
    }

    // spokenAt 是角色說這句話的那一刻。躺一夜才被拿到的話，applyScheduleChangeDirectives
    // 的日曆日門檻會把整批丟掉——昨晚的意思不該蓋到今天的表上。
    const applied = await applyScheduleChangeDirectives(result.directives, char, new Date(result.spokenAt));

    if (applied.changes.length > 0 && applied.schedule) {
        announceScheduleChanges(char.id, applied.schedule, applied.changes);
        // 雲端那份 fire_pack 裡烤著打包那會兒的日程快照。不打髒的話，下一次主動消息
        // 讀到的還是舊安排，角色會再想改一次。
        const [userProfile, groups] = await Promise.all([
            DB.getUserProfile().catch(() => null),
            DB.getGroups().catch(() => undefined),
        ]);
        if (userProfile && groups) {
            markAmsgStateDirty({ char, userProfile, groups });
        } else {
            // 這兩樣是拼 fire_pack 的必需材料，編不出來，所以這一輪只能不打髒。
            // 後果要說清楚：本地的表已經改好了，雲端那份還留著舊安排，下一次主動消息
            // 角色會照舊安排再改一次——而那一次會因為「活動名已經一樣」被當成無落點
            // 銷帳，於是每次觸發都重來一遍，直到用戶打開這個角色的聊天順手帶上一次打髒。
            console.warn(`${HEADER} 取不到用戶資料 / 群組，雲端 fire_pack 這一輪沒能打髒`, {
                charId: char.id,
                hasUserProfile: !!userProfile,
                hasGroups: !!groups,
            });
        }
    } else {
        // 沒落地也照常銷帳：原因要麼是隔天了、要麼是表裡沒有對得上的時段，兩種都不會
        // 因為「下次再試」變得能落——留著只是每次上線重放一次。
        console.warn(`${HEADER} 這批改動沒有落點（${applied.rejectedReason ?? 'none'}），銷帳丟棄`, result.directives);
    }
    return true;
};
