type SpeechLine = { text: string };
export interface SARDateSpeech {
    id: number;
    moduleTitle: string;
    surface: SpeechLine[];
    canonical: SpeechLine[];
}

/** 用整批台詞和播放位置定位，避免「嗯」等重複短句串行。舊快照也可以存著原台詞。 */
export function resolveSARDateSpeech(
    messages: SARDateSpeech[], batch: SpeechLine[], queueLength: number, currentText: string,
) {
    if (!currentText) return null;
    const sameBatch = (lines: SpeechLine[]) => lines.length === batch.length && lines.every((line, i) => line.text === batch[i].text);
    for (const message of [...messages].reverse()) {
        let index = -1;
        if (batch.length) {
            if (!sameBatch(message.surface) && !sameBatch(message.canonical)) continue;
            index = batch.length - queueLength - 1;
            if (index < 0 || batch[index]?.text !== currentText) continue;
        } else {
            // 沒有整批信息的舊快照只接受唯一命中，不能把重複句強行配到第一句。
            const indices = new Set<number>();
            for (const lines of [message.surface, message.canonical]) {
                lines.forEach((line, i) => { if (line.text === currentText) indices.add(i); });
            }
            if (indices.size !== 1) continue;
            index = [...indices][0];
        }
        const aligned = message.surface.length === message.canonical.length;
        return {
            key: `${message.id}:${index}`,
            messageId: message.id,
            moduleTitle: message.moduleTitle,
            // 掉格式導致行數不同時顯示完整段落，避免丟尾句或把別人的一句配過來。
            surface: aligned ? message.surface[index]?.text || '' : message.surface.map(line => line.text).join('\n'),
            canonical: aligned ? message.canonical[index]?.text || '' : message.canonical.map(line => line.text).join('\n'),
        };
    }
    return null;
}
