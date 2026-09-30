import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CharacterProfile, UserProfile } from '../types';
import { ledgerCallbacksFromRegistry, makeTransferLedgerCallbacks, registerRealBalanceWriters, type RealBalanceWriters } from './realBalanceLedger';

const balanceState = (balance: number) => ({ balance, cards: [], transactions: [] });

/** 假的寫入口：跟 OSContext 一樣拿「最新狀態」跑 updater，並把結果留下來給斷言看 */
const makeStore = (charBalance: number, userBalance: number) => {
    let char = { id: 'c1', name: 'Susu', phoneState: { records: [], realBalance: balanceState(charBalance) } } as unknown as CharacterProfile;
    let user = { name: '小柔', avatar: '', bio: '', realBalance: balanceState(userBalance) } as unknown as UserProfile;
    const writers: RealBalanceWriters = {
        updateCharacter: (_id, updates) => { char = { ...char, ...updates(char) }; },
        updateUserProfile: (updates) => { user = { ...user, ...updates(user) }; },
    };
    return { writers, get char() { return char; }, get user() { return user; } };
};

describe('makeTransferLedgerCallbacks', () => {
    it('角色收下你的轉帳：錢記進角色的帳戶', async () => {
        const store = makeStore(100, 1000);
        const cb = makeTransferLedgerCallbacks({ char: store.char, userName: '小柔', writers: store.writers });
        await cb.onUserTransferAccepted(20);
        expect(store.char.phoneState?.realBalance?.balance).toBe(120);
        expect(store.char.phoneState?.realBalance?.transactions.at(-1)?.label).toBe('收到小柔的轉帳');
        expect(store.user.realBalance?.balance).toBe(1000);
    });

    it('角色退回你的轉帳：錢還回你的帳戶', async () => {
        const store = makeStore(100, 980);
        const cb = makeTransferLedgerCallbacks({ char: store.char, userName: '小柔', writers: store.writers });
        await cb.onUserTransferReturned(20);
        expect(store.user.realBalance?.balance).toBe(1000);
        expect(store.char.phoneState?.realBalance?.balance).toBe(100);
    });

    it('角色同一輪連著付錢：從同一份餘額往下扣，不夠就擋下', async () => {
        const store = makeStore(100, 0);
        const cb = makeTransferLedgerCallbacks({ char: store.char, userName: '小柔', writers: store.writers });
        expect(await cb.onCharTransferSend(60)).toBe(true);
        expect(await cb.onCharGiftSend(50)).toBe(false); // 只剩 40
        expect(await cb.onCharDaifuAccept(40)).toBe(true);
        expect(store.char.phoneState?.realBalance?.balance).toBe(0);
    });
});

describe('ledgerCallbacksFromRegistry', () => {
    beforeEach(() => registerRealBalanceWriters(null));

    it('OSContext 還沒註冊寫入口：返回空的回調，不動餘額也不拋錯', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(ledgerCallbacksFromRegistry({ id: 'c1', name: 'Susu' } as CharacterProfile, '小柔')).toEqual({});
        warn.mockRestore();
    });

    it('註冊之後：雲端回覆那條路也能把錢記進角色帳戶', async () => {
        const store = makeStore(0, 0);
        registerRealBalanceWriters(store.writers);
        const cb = ledgerCallbacksFromRegistry(store.char, '小柔');
        await cb.onUserTransferAccepted?.(80);
        expect(store.char.phoneState?.realBalance?.balance).toBe(80);
    });
});
