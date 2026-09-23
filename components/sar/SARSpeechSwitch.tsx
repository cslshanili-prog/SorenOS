import React from 'react';
import { ArrowsLeftRight, Cpu } from '@phosphor-icons/react';
import './sar-speech.css';

export function SARSpeechSwitch({ truth, onToggle, moduleTitle, className = '' }: {
    truth: boolean; onToggle: () => void; moduleTitle?: string; className?: string;
}) {
    return <button type="button" className={`sar-speech-switch control-panel ${className}`} data-sar-view={truth ? 'truth' : 'surface'}
        aria-label={truth ? '顯示汙染台詞' : '查看原台詞'} aria-pressed={truth}
        title={`${moduleTitle || '臨時模塊'} · 當前${truth ? '原台詞' : '汙染台詞'}`}
        onPointerDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); event.preventDefault(); onToggle(); }}>
        <Cpu size={13}/><strong>{truth ? '原台詞' : '汙染台詞'}</strong><ArrowsLeftRight size={11}/>
        <span>{truth ? '查看汙染' : '查看原話'}</span>
    </button>;
}
