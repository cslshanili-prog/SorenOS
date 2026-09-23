import { describe, expect, it } from 'vitest';
import { formatFeishuWriteFailure } from './feishuDiagnostics';

describe('formatFeishuWriteFailure', () => {
    it('403 Forbidden 明確區分讀取連接與新增記錄權限', () => {
        const text = formatFeishuWriteFailure(403, { error: 'Forbidden' });
        expect(text).toContain('讀取測試已通過');
        expect(text).toContain('新增記錄權限');
        expect(text).toContain('添加文檔應用');
    });

    it('普通參數錯誤保留上游信息', () => {
        expect(formatFeishuWriteFailure(400, { msg: 'Invalid field' })).toBe('寫入失敗: Invalid field');
    });
});
