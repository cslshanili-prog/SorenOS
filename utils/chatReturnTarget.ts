import { AppID } from '../types';

let target: AppID | null = null;

/**
 * 私聊 Chat 的返回键默认回桌面（Launcher）。从 Chat 主页「消息/联系人」tab 点进某个私聊时，
 * 记一下"应该回哪"，Chat 自己的返回键消费掉后按这个走，而不是无脑回桌面。
 * 不用 context：只有点返回键那一刻才需要读它，不需要为此触发额外重渲染，跟
 * utils/characterLaunch.ts 是同一个理由用同一个模式。
 */
export const chatReturnTarget = {
    set(appId: AppID): void { target = appId; },
    consume(): AppID | null {
        const value = target;
        target = null;
        return value;
    },
};
