import React from 'react';
import type { QixiEventChatCard } from '../../utils/qixiChatCard';
import './QixiEventCard.css';

const QixiEventCardView: React.FC<{
    card: QixiEventChatCard;
    timestamp?: number;
    interactionProps?: React.HTMLAttributes<HTMLDivElement>;
}> = ({ card, timestamp, interactionProps }) => {
    const bridgeNames = (card.bridgeNodes || []).map(node => node.name || node.artifactLabel).filter(Boolean).slice(0, 4);
    const sceneCount = Array.isArray(card.scenes) ? card.scenes.length : 7;
    return (
        <div className="qixi-chat-card" {...interactionProps}>
            <div className="qixi-chat-card__orbit" /><div className="qixi-chat-card__moon"><i /></div>
            <div className="qixi-chat-card__body">
                <div className="qixi-chat-card__eyebrow">SPECIAL MOMENT · QIXI 2026</div>
                <div className="qixi-chat-card__title">{card.title || '星月夢境童話'}</div>
                <div className="qixi-chat-card__en">THE CONTEXT BETWEEN TWO WORLDS</div>
                <div className="qixi-chat-card__summary">
                    <div className="qixi-chat-card__pair"><i className="is-user" /><b>{card.userName || 'User'}</b><span /><b>{card.charName || 'Char'}</b><i className="is-char" /></div>
                    <p>{card.summary}</p>
                </div>
                <div className="qixi-chat-card__stats"><span>{String(sceneCount).padStart(2, '0')} 個地點</span><span>記憶喚鵲織路</span><span>約定完成</span></div>
                {bridgeNames.length > 0 && <div className="qixi-chat-card__nodes">{bridgeNames.map((name, index) => <span key={`${name}-${index}`}>{name}</span>)}</div>}
                <div className="qixi-chat-card__footer"><span>共同經歷已寫入上下文</span><time>✦ {new Date(card.timestamp || timestamp || Date.now()).toLocaleDateString()}</time></div>
            </div>
        </div>
    );
};

export default QixiEventCardView;
