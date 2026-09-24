import React, { useEffect, useRef, useState } from 'react';
import { Phone, PhoneDisconnect, VideoCamera } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { DB } from '../utils/db';
import { resolveUserProfileForChar } from '../utils/userPersona';
import {
    buildCharCallDeclinedNote, CHAR_CALL_RING_MS, INCOMING_CHAR_CALL_EVENT,
    type CharCallStatus, type IncomingCharCallDetail,
} from '../utils/charCall';
import TokenImg from './os/TokenImg';

/** 改完卡片狀態，讓開著的聊天頁重讀（OSContext 聽到會推 lastMsgTimestamp，不彈 toast）。 */
const refreshChat = () => window.dispatchEvent(new CustomEvent('active-msg-progress'));

const setCallStatus = (messageId: number, status: CharCallStatus) =>
    DB.updateMessageMetadata(messageId, (prev) => ({
        ...(prev || {}),
        charCall: { ...(prev?.charCall || {}), status, respondedAt: Date.now() },
    }));

/**
 * 角色打來的全域來電畫面（聊天設定 · 允許角色主動打電話，見 utils/charCall.ts）。
 * 後處理落了「響鈴中」的來電卡之後發 INCOMING_CHAR_CALL_EVENT，這裡接住：
 * - 正在通話（或有掛起的通話）、已經有一通在響 → 直接記未接；
 * - 否則全螢幕響 30 秒：接聽 → 直接進通話（角色先開口）；拒接 → 落旁白；沒接 → 記未接。
 * 瀏覽器不讓沒被點過的頁面自己出聲，鈴聲只是盡量；手機上會震動。
 */
const IncomingCallOverlay: React.FC = () => {
    const { characters, activeApp, suspendedCall, openCallWithChar, userProfileBase } = useOS();
    const [call, setCall] = useState<IncomingCharCallDetail | null>(null);
    const callRef = useRef<IncomingCharCallDetail | null>(null);
    const busyRef = useRef(false);
    busyRef.current = activeApp === AppID.Call || !!suspendedCall;

    useEffect(() => {
        const onIncoming = (event: Event) => {
            const detail = (event as CustomEvent<IncomingCharCallDetail>).detail;
            if (!detail) return;
            if (busyRef.current || callRef.current) {
                void setCallStatus(detail.messageId, 'missed').then(refreshChat);
                return;
            }
            callRef.current = detail;
            setCall(detail);
        };
        window.addEventListener(INCOMING_CHAR_CALL_EVENT, onIncoming);
        return () => window.removeEventListener(INCOMING_CHAR_CALL_EVENT, onIncoming);
    }, []);

    const finish = async (status: CharCallStatus) => {
        const current = callRef.current;
        if (!current) return;
        callRef.current = null;
        setCall(null);
        await setCallStatus(current.messageId, status);
        const char = characters.find(c => c.id === current.charId);
        if (status === 'declined' && char) {
            const userName = resolveUserProfileForChar(userProfileBase, char.id).name || '你';
            await DB.saveMessage({
                charId: char.id, role: 'system', type: 'text',
                content: buildCharCallDeclinedNote(userName, char.chatNickname?.trim() || char.name, current.mode),
            });
        }
        refreshChat();
        if (status === 'accepted') openCallWithChar(current.charId, current.mode, current.reason);
    };

    // 響鈴：30 秒沒接記未接；能震就震，能出聲就出聲（被瀏覽器擋掉就算了）
    useEffect(() => {
        if (!call) return;
        const timeout = window.setTimeout(() => { void finish('missed'); }, CHAR_CALL_RING_MS);
        const vibrate = () => { try { navigator.vibrate?.([600, 400, 600]); } catch { /* 不支援 */ } };
        vibrate();
        const vibrateTimer = window.setInterval(vibrate, 2500);
        let audioCtx: AudioContext | null = null;
        let ringTimer: number | undefined;
        try {
            const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (Ctx) {
                audioCtx = new Ctx();
                const ctx = audioCtx;
                const ring = () => {
                    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
                    for (const [offset, freq] of [[0, 880], [0.25, 660], [0.5, 880], [0.75, 660]] as const) {
                        const osc = ctx.createOscillator();
                        const gain = ctx.createGain();
                        osc.frequency.value = freq;
                        gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
                        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + offset + 0.02);
                        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.22);
                        osc.connect(gain).connect(ctx.destination);
                        osc.start(ctx.currentTime + offset);
                        osc.stop(ctx.currentTime + offset + 0.24);
                    }
                };
                ring();
                ringTimer = window.setInterval(ring, 2500);
            }
        } catch { /* 沒有聲音也照樣響畫面 */ }
        return () => {
            window.clearTimeout(timeout);
            window.clearInterval(vibrateTimer);
            if (ringTimer) window.clearInterval(ringTimer);
            try { navigator.vibrate?.(0); } catch { /* 不支援 */ }
            void audioCtx?.close().catch(() => {});
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [call]);

    if (!call) return null;
    const char = characters.find(c => c.id === call.charId);
    const name = char?.chatNickname?.trim() || char?.name || '來電';
    const isVideo = call.mode === 'video';

    return (
        <div className="absolute inset-0 z-[90] flex flex-col items-center justify-between bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-white animate-fade-in" role="dialog" aria-label={`${name} ${isVideo ? '視訊' : '語音'}來電`}>
            <div className="flex flex-col items-center pt-28">
                <div className="relative">
                    <span className="absolute inset-0 rounded-full bg-white/20 animate-ping" />
                    <TokenImg value={char?.avatar} alt="" className="relative w-28 h-28 rounded-full object-cover border-4 border-white/20 bg-slate-700" />
                </div>
                <div className="mt-6 text-3xl font-bold tracking-wide">{name}</div>
                <div className="mt-2 flex items-center gap-1.5 text-sm text-white/60">
                    {isVideo ? <VideoCamera size={16} weight="fill" /> : <Phone size={16} weight="fill" />}
                    {isVideo ? '視訊來電' : '語音來電'}…
                </div>
            </div>
            <div className="mb-24 flex w-full justify-around px-12">
                <button type="button" onClick={() => void finish('declined')} className="flex flex-col items-center gap-2" aria-label="拒接">
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500 shadow-lg active:scale-90 transition-transform">
                        <PhoneDisconnect size={30} weight="fill" />
                    </span>
                    <span className="text-xs text-white/70">拒接</span>
                </button>
                <button type="button" onClick={() => void finish('accepted')} className="flex flex-col items-center gap-2" aria-label="接聽">
                    <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 shadow-lg animate-bounce active:scale-90 transition-transform">
                        {isVideo ? <VideoCamera size={30} weight="fill" /> : <Phone size={30} weight="fill" />}
                    </span>
                    <span className="text-xs text-white/70">接聽</span>
                </button>
            </div>
        </div>
    );
};

export default IncomingCallOverlay;
