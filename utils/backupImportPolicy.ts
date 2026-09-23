/**
 * SullyOS 只恢復自身備份。
 *
 * v1 SullyOS 備份仍是寬鬆的單根 data.json，不能僅靠擴展名或 ZIP 佈局識別來源；
 * 這裡攔截已經明確屬於舊第三方遷移格式的頂層字段。檢查必須在任何數據庫寫入前完成。
 */
import { trackEvent } from './analytics';

const UNSUPPORTED_THIRD_PARTY_FIELDS = [
    'vectorMemories',
    'extraLocalStorageConfig',
] as const;

export function assertSupportedSullyBackup(input: unknown): asserts input is Record<string, unknown> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        trackEvent('拒绝导入第三方备份', { reason: 'invalid_shape' });
        throw new Error('備份內容無效：只支持 Soren 導出的 ZIP 或 JSON 備份。');
    }

    const record = input as Record<string, unknown>;
    if (UNSUPPORTED_THIRD_PARTY_FIELDS.some(field => Object.prototype.hasOwnProperty.call(record, field))) {
        trackEvent('拒绝导入第三方备份', { reason: 'third_party_field' });
        throw new Error('不支持導入第三方系統備份，請選擇由 Soren 導出的 ZIP 或 JSON 文件。');
    }
}
