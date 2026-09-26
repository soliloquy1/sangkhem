// Story text for scene extraction: the content of story tags if the reply has them, otherwise the
// reply with custom-tagged blocks (CoT, notes, trackers) removed. Ported from Laya WI Director's
// guard-heuristics.js (extractNarrative), with line breaks instead of " | " separators.

// Custom XML tags from CoT presets, e.g. <ellen_planning~>, <tucao>, <progress>.
const TAG_NAME = '[A-Za-z][\\w:~.-]*';
// Plain HTML formatting inside the story: unwrap (keep the text), don't drop.
// <details> is deliberately absent — presets use it to fold away CoT.
const HTML_FORMATTING = new Set([
    'b', 'i', 'u', 's', 'em', 'strong', 'span', 'font', 'small', 'big', 'sub', 'sup', 'del', 'ins',
    'mark', 'q', 'p', 'div', 'center', 'br', 'hr', 'img', 'a', 'code', 'blockquote', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const isHtml = (name) => HTML_FORMATTING.has(name.toLowerCase());
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unwrapHtml(text) {
    return text.replace(new RegExp(`</?(${TAG_NAME})(?:\\s[^>]*)?\\/?>`, 'g'), (tag, name) => (isHtml(name) ? ' ' : tag));
}

// Drop every custom-tagged block. An opening tag that never closes swallows the rest of the reply.
function stripTagged(text) {
    let out = unwrapHtml(text);
    const pair = new RegExp(`<(${TAG_NAME})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, 'g');
    let prev;
    do {
        prev = out;
        out = out.replace(pair, '\n');
    } while (out !== prev);
    out = out.replace(new RegExp(`<${TAG_NAME}(?:\\s[^>]*)?>[\\s\\S]*$`), '\n');
    return out.replace(new RegExp(`</${TAG_NAME}\\s*>`, 'g'), '\n');
}

const tidy = (text) => text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/**
 * @param {string} text reply text
 * @param {string[]} storyTags tag names whose content is the story, e.g. ['content']
 */
export function extractStory(text, storyTags = ['content']) {
    if (!text) return '';
    const parts = [];
    for (const tag of storyTags.map((t) => t.trim()).filter(Boolean)) {
        const t = escapeRegex(tag);
        for (const match of text.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${t}\\s*>|$)`, 'gi'))) {
            parts.push(match[1]);
        }
    }
    return tidy(parts.length ? parts.map(stripTagged).join('\n') : stripTagged(text));
}

/** "content, story" → ['content', 'story'] */
export function parseTagList(value) {
    return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
