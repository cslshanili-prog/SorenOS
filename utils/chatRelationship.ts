import type { CharacterProfile } from '../types';

/**
 * 聊天設定頁 Relationship 一排的提示詞注入、「我們已相識 N 天」、角色自主改關係的動作標籤。
 * 純函數，worker 端不用（改關係只在客戶端落地，見 ChatParser.parseAndExecuteActions）。
 */

/** 角色改「角色認為的關係」：[[ACTION:RELATIONSHIP|新關係]]，也認中文別名和全形標點。 */
const RELATIONSHIP_TAG_RE = /\[\[\s*ACTION\s*[:：]\s*(?:SET_RELATIONSHIP|RELATIONSHIP|關係|关系)\s*[|｜]\s*([^\]\n]*?)\s*\]\]/gi;

export const RELATIONSHIP_MAX_LENGTH = 30;

/** 剝掉所有改關係標籤；有多個時以最後一個為準。空值或過長的當作沒寫。 */
export function extractRelationshipChange(text: string): { cleanedText: string; relationship: string | null } {
    let relationship: string | null = null;
    let matched = false;
    const stripped = text.replace(RELATIONSHIP_TAG_RE, (_m, value: string) => {
        matched = true;
        const v = value.trim().replace(/^[「『"“]|[」』"”]$/g, '').trim();
        if (v && v.length <= RELATIONSHIP_MAX_LENGTH) relationship = v;
        return '';
    });
    if (!matched) return { cleanedText: text, relationship: null };
    return { cleanedText: stripped.replace(/[ \t]+\n/g, '\n').trim(), relationship };
}

/** 角色改完關係後由 ChatParser 發出，OSContext 接住寫回角色。 */
export const CHAR_RELATIONSHIP_CHANGE_EVENT = 'char-relationship-change';
export interface CharRelationshipChangeDetail {
    charId: string;
    relationship: string;
}

type RelationshipFields = Pick<CharacterProfile,
    'chatNickname' | 'userNickname' | 'userViewRelationship' | 'charViewRelationship' | 'allowCharChangeRelationship'>;

/**
 * 穩定段的「稱呼與關係」區塊。全都沒設、也沒開自主改關係時回空字串。
 * 放穩定段是因為這些很少變——角色自己改關係時才會讓快取失效一次。
 */
export function buildRelationshipPrompt(char: RelationshipFields, userName: string): string {
    const lines: string[] = [];
    const nickname = char.chatNickname?.trim();
    const userNickname = char.userNickname?.trim();
    const userView = char.userViewRelationship?.trim();
    const charView = char.charViewRelationship?.trim();
    if (nickname) lines.push(`- ${userName}給你取的暱稱是「${nickname}」，聊天時會這樣叫你。`);
    if (userNickname) lines.push(`- 你稱呼${userName}為「${userNickname}」。`);
    if (userView) lines.push(`- ${userName}認為你們的關係是：${userView}`);
    if (charView) lines.push(`- 你認為你們的關係是：${charView}`);
    if (char.allowCharChangeRelationship) {
        lines.push(`- 如果劇情發展讓你真心覺得你們的關係變了，可以在回覆最後另起一行寫 [[ACTION:RELATIONSHIP|新的關係]]，更新「你認為的關係」（${RELATIONSHIP_MAX_LENGTH} 字以內，例如：曖昧對象、冷戰中的戀人）。關係不會因為一兩句話就改變，只在真正的轉折點才用，平常不要寫。`);
    }
    if (lines.length === 0) return '';
    return `\n### 你們之間的稱呼與關係\n${lines.join('\n')}\n`;
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 從起點到今天是相識的第幾天（起點當天算第 1 天）。格式不對或起點在未來回 null。 */
export function acquaintanceDays(startKey: string | undefined, todayKey: string): number | null {
    const a = startKey ? DATE_KEY_RE.exec(startKey) : null;
    const b = DATE_KEY_RE.exec(todayKey);
    if (!a || !b) return null;
    const diff = Math.round(
        (Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86_400_000,
    );
    return diff < 0 ? null : diff + 1;
}

/** 易變段的一行「相識第 N 天」；沒設起點或算不出來時回空字串。 */
export function buildAcquaintanceLine(startKey: string | undefined, todayKey: string, userName: string): string {
    const days = acquaintanceDays(startKey, todayKey);
    if (days === null) return '';
    return `\n（你和${userName}從 ${startKey} 認識到今天，是相識的第 ${days} 天。）\n`;
}
