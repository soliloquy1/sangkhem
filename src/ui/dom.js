const ATTRIBUTES = new Set(['type', 'title', 'placeholder', 'rows', 'min', 'max', 'step']);

/**
 * Builds an element. Text goes through textContent or text nodes only, so chat and model text can
 * never inject markup. Unknown props throw rather than being set silently.
 */
export function h(tag, props = {}, children = [], doc = globalThis.document) {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'value') node.value = value;
        else if (key === 'checked') node.checked = Boolean(value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (key.startsWith('data-') || ATTRIBUTES.has(key)) node.setAttribute(key, String(value));
        else throw new Error(`h(): unsupported prop "${key}"`);
    }
    for (const child of [].concat(children)) {
        if (child == null || child === false) continue;
        node.append(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
    }
    return node;
}
