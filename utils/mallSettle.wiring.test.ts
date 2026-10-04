import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// 角色在每條會回話的路上都要能真的下單（plans/mall-redesign.md 第二批）：
// 前台聊天走 parseAndExecuteActions；背景延遲回覆／主動訊息走 OSContext 的 runProactive，
// 以前只結算轉帳，購物標籤被剝掉什麼都沒發生；雲端回覆靠 worker 把標籤原樣送回。
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('購物中心標籤在每條路上都會結算', () => {
    it('背景路徑：轉帳之後接著結算購物標籤，用同一組錢包回調', () => {
        const src = read('context/OSContext.tsx');
        const transfer = src.indexOf('ChatParser.settleTransferCommands(aiContent, charId, ledger)');
        const mall = src.indexOf('ChatParser.settleMallCommands(aiContent, charId,');
        expect(transfer).toBeGreaterThan(-1);
        expect(mall).toBeGreaterThan(transfer);
        expect(src.slice(mall, mall + 300)).toContain('onCharGiftSend: ledger.onCharGiftSend');
    });

    it('前台：parseAndExecuteActions 走同一個 settleMallCommands', () => {
        const src = read('utils/chatParser.ts');
        expect(src).toMatch(/content = await ChatParser\.settleMallCommands\(content, charId,/);
    });
});
