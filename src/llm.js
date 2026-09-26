/**
 * Pulls the first JSON object out of a model reply (plain, fenced, or wrapped in chatter).
 * @param {string} text
 */
export function parseJsonReply(text) {
    if (typeof text !== 'string') throw new Error('model reply is not text');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in model reply');
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch (error) {
        throw new Error(`model reply is not valid JSON: ${error.message}`);
    }
}

/**
 * @param {(profileId: string, messages: object[], options: { maxTokens: number, temperature?: number, signal?: AbortSignal }) => Promise<any>} sendRequest
 */
export function createLlm(sendRequest) {
    return {
        async complete(profileId, messages, { maxTokens = 800, temperature, signal } = {}) {
            const result = await sendRequest(profileId, messages, { maxTokens, temperature, signal });
            const text = typeof result === 'string' ? result : result?.content;
            if (typeof text !== 'string' || !text.trim()) throw new Error('empty reply from connection profile');
            return text;
        },
    };
}
