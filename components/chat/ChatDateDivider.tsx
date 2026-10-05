import React from 'react';
import { formatChatDateDivider } from '../../utils/chatListTime';

/** 聊天視窗的日期分隔（一天一次，像 LINE）。`sully-chat-date-divider` 留給自訂 CSS。 */
const ChatDateDivider: React.FC<{ timestamp: number }> = ({ timestamp }) => (
    <div className="sully-chat-date-divider flex justify-center my-3 px-4 pointer-events-none select-none">
        <span className="px-3 py-1 rounded-full bg-white/60 backdrop-blur-sm text-[11px] font-medium text-slate-500 shadow-sm border border-white/70">
            {formatChatDateDivider(timestamp)}
        </span>
    </div>
);

export default ChatDateDivider;
