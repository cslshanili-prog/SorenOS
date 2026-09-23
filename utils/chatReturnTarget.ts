import { AppID } from '../types';

let target: AppID | null = null;

/**
 * Chat / GroupChat 的返回鍵默認各自回桌面（Launcher）/ 群聊列表。從 Chat 主頁「消息/聯繫人」
 * tab 點進某個私聊或群聊時，記一下"這次應該回哪"，對應頁面的返回鍵消費掉後按這個走，
 * 而不是走各自原本的默認目標。
 * 不用 context：只有點返回鍵那一刻才需要讀它，不需要為此觸發額外重渲染，跟
 * utils/characterLaunch.ts 是同一個理由用同一個模式。
 */
export const chatReturnTarget = {
    set(appId: AppID): void { target = appId; },
    consume(): AppID | null {
        const value = target;
        target = null;
        return value;
    },
};
