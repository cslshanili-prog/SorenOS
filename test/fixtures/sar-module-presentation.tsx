// Only used by isolated browser QA; uses the real OS store, persistence and DateSession.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import DateSession from '../../components/date/DateSession';
import { SARModuleMonitor } from '../../components/sar/SARModuleMonitor';
import { DB } from '../../utils/db';
import type { DateState, Message } from '../../types';

function Harness() {
    const os = useOS();
    const char = os.characters.find(char => char.id === 'qa-sar-presentation');
    const [messages, setMessages] = useState<Message[]>([]);
    const [showDate, setShowDate] = useState(true);
    useEffect(() => { (window as any).moduleQA = { os, setShowDate }; });
    useEffect(() => { if (char) void DB.getRecentMessagesByCharId(char.id, 50).then(setMessages); }, [char?.id]);
    const initialState = useMemo(() => (messages.length ? { timestamp: 1, peekStatus: '' } as DateState : undefined), [messages]);
    return <>
        <div style={{ position: 'absolute', inset: 0, isolation: 'isolate' }}>
            {char && initialState && showDate ? <DateSession char={char} userProfile={os.userProfile} messages={messages} initialState={initialState}
                peekStatus="" onSendMessage={async () => { throw Error('QA never calls model'); }} onReroll={async () => { throw Error('QA never calls model'); }}
                onExit={() => setShowDate(false)} onEditMessage={() => {}} onDeleteMessage={() => {}} onDeleteMessages={async () => {}} onSettings={() => {}}/>
                : <p style={{ color: 'white', padding: 20 }}>頁面已切換</p>}
        </div>
        <SARModuleMonitor/>
    </>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><Harness/></OSProvider>);
