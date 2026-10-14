import React, { useState } from 'react';
import Modal from '../os/Modal';
import SystemLogList from '../os/SystemLogList';
import { useOS } from '../../context/OSContext';

/**
 * 設置 → 錯誤記錄（2026-10-14）：頂端紅膠囊那份日誌的歷史。存在本機、留 7 天、最多 200 筆，
 * 同一個錯誤短時間重複會合併（utils/systemLogStore.ts）。API 請求的成敗另見「API 調用記錄」。
 */
const ErrorLogModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
    const { systemLogs = [], deleteAllLogs } = useOS();
    const [copied, setCopied] = useState(false);

    const copyAll = async () => {
        try {
            await navigator.clipboard.writeText(JSON.stringify(systemLogs, null, 2));
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch { /* 有的 WebView 不給剪貼簿；記錄本身可以手動圈選 */ }
    };
    const removeAll = () => {
        if (!window.confirm('確定刪除全部錯誤記錄嗎？刪了就找不回來。')) return;
        deleteAllLogs();
    };

    return (
        <Modal
            isOpen={isOpen}
            title="錯誤記錄"
            onClose={onClose}
            footer={
                <div className="flex gap-2 w-full">
                    <button onClick={copyAll} disabled={systemLogs.length === 0} className="flex-1 py-3 bg-slate-100 font-bold rounded-2xl text-slate-600 disabled:opacity-40">{copied ? '已複製' : '複製 JSON'}</button>
                    <button onClick={removeAll} disabled={systemLogs.length === 0} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl disabled:opacity-40">全部刪除</button>
                </div>
            }
        >
            <p className="mb-2 text-[11px] text-slate-500 leading-relaxed">
                頂端紅色提示的歷史，只存在這台裝置上，留 7 天、最多 {200} 筆；同一個錯誤短時間內重複發生會合併成一筆。API 請求成功或失敗的明細在「API 調用記錄」。
            </p>
            <SystemLogList logs={systemLogs} emptyText="最近 7 天沒有錯誤記錄。" showDate className="h-[45vh]" />
        </Modal>
    );
};

export default ErrorLogModal;
