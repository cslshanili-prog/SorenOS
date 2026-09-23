import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatInputArea from '../../components/chat/ChatInputArea';

const emojis = ['親親', '親親你', '親親抱抱', '給你親親'].map((name, index) => ({
    name, url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="${['#f2d9d5', '#e6def1', '#f3e6be', '#dbe6f0'][index]}"/><text x="32" y="43" text-anchor="middle" font-size="32">${['♥', '☺', '♡', '♪'][index]}</text></svg>`)}`,
}));
function App() {
    const [input, setInput] = useState('你好');
    const [showPanel, setShowPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const [custom, setCustom] = useState(true), [countdown, setCountdown] = useState<number | null>(null);
    const [sent, setSent] = useState<string[]>([]);
    return <main className={`sully-chat-root ${custom ? 'qa-custom' : ''}`}>
        <div className="qa-controls"><label><input type="checkbox" checked={custom} onChange={e => setCustom(e.target.checked)}/> 社區結構選擇器美化</label> <button onClick={() => setCountdown(5)}>倒計時</button></div>
        <div className="qa-conversation"><p>今天在水邊坐了一會兒。</p><p>風很舒服，下次一起去吧。</p><output data-testid="sent">{JSON.stringify(sent)}</output></div>
        <ChatInputArea input={input} setInput={setInput} isTyping={false} selectionMode={false}
            showPanel={showPanel} setShowPanel={setShowPanel} onSend={() => setSent(v => [...v, input])}
            onDeleteSelected={() => {}} selectedCount={0} emojis={emojis} emojiSuggestionsEnabled
            autoReplySeconds={countdown} onCancelAutoReply={() => setCountdown(null)}
            onPanelAction={(type, emoji) => setSent(v => [...v, `${type}:${emoji.name}`])}
            onImageSelect={() => {}} isSummarizing={false} onReroll={() => {}} canReroll={false}/>
    </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
