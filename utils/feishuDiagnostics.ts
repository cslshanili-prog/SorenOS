/** 飛書讀連接成功但新增記錄被拒時，給用戶能直接照做的權限診斷。 */
export const formatFeishuWriteFailure = (
    status: number,
    payload: { msg?: unknown; error?: unknown; code?: unknown } | null | undefined,
): string => {
    const raw = String(payload?.msg || payload?.error || status || '寫入失敗');
    if (status === 403 || /forbidden|permission|access denied|[无無][权權]限|[权權]限不足/i.test(raw)) {
        return '飛書拒絕寫入（403）：讀取測試已通過，但應用沒有新增記錄權限。請在開放平台開通“查看、評論、編輯和管理多維表格”，發佈並審批新版本；再到這張多維表格的“添加文檔應用”中加入該應用並授予可編輯權限。';
    }
    return `寫入失敗: ${raw}`;
};
