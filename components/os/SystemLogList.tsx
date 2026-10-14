import React from 'react';
import type { SystemLog } from '../../types';

/**
 * 系統日誌的終端樣式列表：頂端紅膠囊的「系統調試終端」和設置 → 錯誤記錄共用。
 * showDate：歷史記錄跨天，要帶日期；紅膠囊只看這次打開 App 的，時間就夠。
 */
const SystemLogList: React.FC<{
    logs: SystemLog[];
    emptyText: string;
    showDate?: boolean;
    className?: string;
}> = ({ logs, emptyText, showDate = false, className = 'h-64' }) => {
    const when = (ts: number) => {
        const d = new Date(ts);
        return showDate ? `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString()}` : d.toLocaleTimeString();
    };
    return (
        <div className={`${className} bg-slate-900 rounded-xl p-3 overflow-y-auto font-mono text-[10px] space-y-2 no-scrollbar shadow-inner select-text`}>
            {logs.length === 0 ? (
                <div className="text-slate-500 text-center mt-20">{emptyText}</div>
            ) : (
                logs.map(log => (
                    <div key={log.id} className="border-b border-white/10 pb-2 mb-2 last:border-0 last:mb-0 last:pb-0">
                        <div className="flex justify-between items-start gap-2 text-white/50 mb-1">
                            <span>
                                [{when(log.timestamp)}]
                                {(log.count || 1) > 1 && (
                                    <span className="ml-1 text-amber-300">×{log.count}{log.firstAt ? `（從 ${when(log.firstAt)} 起）` : ''}</span>
                                )}
                            </span>
                            <span className={`uppercase font-bold ${log.type === 'error' ? 'text-red-400' : 'text-orange-400'}`}>{log.type}</span>
                        </div>
                        <div className="text-white font-bold mb-1 break-words">{log.message}</div>
                        {log.detail && (
                            <pre className="text-slate-400 whitespace-pre-wrap break-all bg-black/30 p-2 rounded">{log.detail}</pre>
                        )}
                        <div className="text-white/30 text-right mt-1">Src: {log.source}</div>
                    </div>
                ))
            )}
        </div>
    );
};

export default SystemLogList;
