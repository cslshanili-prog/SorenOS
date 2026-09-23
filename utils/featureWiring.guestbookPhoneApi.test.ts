import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('留言簿定向回覆接線', () => {
    it('用戶回覆會同時保存目標 id/name，並在輸入區展示取消入口', () => {
        const source = read('apps/VRWorldApp.tsx');
        expect(source).toContain('replyToId: replyTo?.id');
        expect(source).toContain('replyToName: replyTo?.authorName');
        expect(source).toContain('onClick={() => startReply(m)}');
        expect(source).toContain('aria-label="取消回覆"');
    });
});

describe('查手機獨立 API 接線', () => {
    it('全部查手機生成入口統一走 effectiveApiConfig，並在選人頁提供設置', () => {
        const source = read('apps/CheckPhone.tsx');
        expect(source).toContain('resolveCheckPhoneApi(phoneApiConfig, apiConfig)');
        expect(source).toContain('aria-label="查手機 API 設置"');
        expect(source).toContain('api: effectiveApiConfig as any');
        expect(source).not.toMatch(/fetch\(`\$\{apiConfig\.baseUrl/);
        expect(source).not.toContain('api: apiConfig as any');
        expect(source).not.toContain('apiConfig: apiConfig as any');
    });

    it('獨立 API 會進入完整/純文本備份並在導入時恢復', () => {
        const context = read('context/OSContext.tsx');
        const types = read('types.ts');
        expect(types).toContain('checkPhoneApi?: APIConfig | null');
        expect(context).toContain('checkPhoneApi: (mode === \'text_only\' || mode === \'full\') ? getCheckPhoneApi() : undefined');
        expect(context).toContain('setCheckPhoneApi(data.checkPhoneApi ?? null)');
    });
});
