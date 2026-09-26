// The only file that knows Summaryception's storage format (chatMetadata.summaryception).
// Mirrors its assembleSummaryBlock(): higher layers first (last down to 1), then layer 0.
// Summaryception keeps injecting the summary itself; this only reads it.
export const summaryceptionMemory = {
    id: 'summaryception',
    label: 'Summaryception',
    available(ctx) {
        const settings = ctx?.extensionSettings?.summaryception;
        if (!settings) return 'Summaryception is not installed';
        if ((ctx.disabledExtensions ?? []).some((name) => /summaryception$/i.test(name))) return 'Summaryception is disabled';
        if (settings.enabled === false) return 'Summaryception is turned off';
        if (!Array.isArray(ctx.chatMetadata?.summaryception?.layers)) return 'no Summaryception summary in this chat yet';
        return true;
    },
    getSummary(ctx) {
        const layers = ctx?.chatMetadata?.summaryception?.layers;
        if (!Array.isArray(layers) || !layers.length) return null;
        const texts = [];
        for (const layer of [...layers.slice(1).reverse(), layers[0]]) {
            if (!Array.isArray(layer)) continue;
            for (const snippet of layer) {
                if (typeof snippet?.text === 'string' && snippet.text.trim()) texts.push(snippet.text.trim());
            }
        }
        return texts.length ? texts.join(' ') : null;
    },
};
