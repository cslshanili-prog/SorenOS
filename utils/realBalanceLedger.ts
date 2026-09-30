/**
 * 聊天裡的錢怎麼動兩邊的 Real Balance：用戶轉帳被角色收下 / 退回、角色主動轉帳、代付外賣、送禮。
 *
 * 這組回調餵給 ChatParser（parseAndExecuteActions / settleTransferCommands），角色每條會回話的路
 * 都得用同一組：前台本機聊天（hooks/useChatAI.ts）、雲端回覆沖刷（utils/activeMsgRuntime.ts：
 * 即時對話、雲端延遲回覆、主動消息）、背景延遲回覆（OSContext 的 runProactive）。以前只有前台
 * 那條接了，開即時對話的人轉帳給角色，卡片顯示「已收款」、角色的銀行卻一分錢沒進。
 *
 * 寫入走 OSContext 的 updateCharacter / updateUserProfile（函數式更新，拿的是最新狀態）。
 * 不在 React 裡的調用方（activeMsgRuntime）拿不到它們，所以 OSContext 掛載時把自己的兩個寫入口
 * 註冊到這裡（registerRealBalanceWriters），那邊用 ledgerCallbacksFromRegistry 取。
 */
import type { CharacterProfile, UserProfile } from '../types';
import { applyRealBalanceDelta, ensureRealBalanceState } from './realBalance';

export interface RealBalanceWriters {
    updateCharacter: (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;
    updateUserProfile: (updates: (prev: UserProfile) => Partial<UserProfile>) => void;
}

export interface TransferLedgerCallbacks {
    onUserTransferReturned: (amount: number) => Promise<void>;
    onUserTransferAccepted: (amount: number) => Promise<void>;
    onCharTransferSend: (amount: number) => Promise<boolean>;
    onCharDaifuAccept: (amount: number) => Promise<boolean>;
    onCharGiftSend: (amount: number) => Promise<boolean>;
}

/**
 * 一輪回覆用的一組回調。char 是這一輪拿到手的角色（夠新的快照）：角色要付錢的三種（轉帳、代付、
 * 送禮）得**同步**算出夠不夠，不能把結果塞進 updateCharacter 的函數式 updater 再讀出來——updater
 * 何時真的執行是 React 調度決定的，踩過「明明有餘額卻被判不足、整筆轉帳被攔」的坑。所以三者共用
 * 一份「從這一輪開始算起」的餘額快照，同一輪裡又轉帳又代付也不會拿同一份起始餘額重複通過檢查。
 */
export function makeTransferLedgerCallbacks(params: {
    char: CharacterProfile;
    userName: string;
    writers: RealBalanceWriters;
}): TransferLedgerCallbacks {
    const { char, userName, writers } = params;
    let charSnapshot: ReturnType<typeof ensureRealBalanceState> | undefined;

    const charPays = (amount: number, label: string): boolean => {
        const before = charSnapshot ?? ensureRealBalanceState(char.phoneState?.realBalance);
        const result = applyRealBalanceDelta(before, -amount, label);
        if (!result.ok) return false;
        charSnapshot = result.state;
        writers.updateCharacter(char.id, previous => ({
            phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state },
        }));
        return true;
    };

    return {
        // 角色退回用戶的轉帳：錢在用戶發送那一刻就扣走了（apps/Chat.tsx 的 handleSendTransfer），退回得還回去
        onUserTransferReturned: async (amount) => {
            writers.updateUserProfile(prev => {
                const result = applyRealBalanceDelta(ensureRealBalanceState(prev.realBalance), amount, `${char.name} 退回了轉帳`);
                return result.ok ? { realBalance: result.state } : {};
            });
        },
        // 角色收下用戶的轉帳：這時錢才真的到帳角色（跟用戶收下角色轉帳的 handleResolveTransfer 對稱）
        onUserTransferAccepted: async (amount) => {
            writers.updateCharacter(char.id, previous => {
                const result = applyRealBalanceDelta(ensureRealBalanceState(previous.phoneState?.realBalance), amount, `收到${userName}的轉帳`);
                if (!result.ok) return {};
                return { phoneState: { ...previous.phoneState, records: previous.phoneState?.records || [], realBalance: result.state } };
            });
        },
        // 角色主動轉帳：發送即結清，扣不出來返回 false，chatParser 就不落卡
        onCharTransferSend: async (amount) => charPays(amount, `轉帳給${userName}`),
        // 角色替用戶付外賣：單向支出，只扣角色
        onCharDaifuAccept: async (amount) => charPays(amount, `代付給${userName}的外賣`),
        // 角色送用戶禮物／外賣
        onCharGiftSend: async (amount) => charPays(amount, `送給${userName}的禮物`),
    };
}

let registeredWriters: RealBalanceWriters | null = null;

/** OSContext 掛載時註冊自己的寫入口；卸載時傳 null。 */
export function registerRealBalanceWriters(writers: RealBalanceWriters | null): void {
    registeredWriters = writers;
}

/**
 * 不在 React 裡的調用方用：OSContext 還沒掛上（或已卸載）就返回空物件——等於不動餘額，
 * 跟以前一樣，不會因為拿不到寫入口就把整條回覆處理搞掛。
 */
export function ledgerCallbacksFromRegistry(char: CharacterProfile, userName: string): Partial<TransferLedgerCallbacks> {
    if (!registeredWriters) {
        console.warn('[RealBalance] 還沒有註冊寫入口，這一輪的轉帳不動餘額', { charId: char.id });
        return {};
    }
    return makeTransferLedgerCallbacks({ char, userName, writers: registeredWriters });
}
