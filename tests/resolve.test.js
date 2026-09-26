import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackend } from '../src/backends/resolve.js';

const none = { id: 'none', available: () => true };
const real = (availability) => ({ id: 'real', available: () => availability });

test('returns the chosen backend when available', () => {
    const backend = real(true);
    assert.deepEqual(resolveBackend({ real: backend, none }, 'real', {}), { backend, reason: null });
});

test('falls back to none with the reason when unavailable', () => {
    assert.deepEqual(resolveBackend({ real: real('not installed'), none }, 'real', {}), { backend: none, reason: 'not installed' });
    assert.deepEqual(resolveBackend({ real: real(false), none }, 'real', {}), { backend: none, reason: 'real unavailable' });
});

test('falls back to none for unknown ids', () => {
    assert.deepEqual(resolveBackend({ none }, 'jev', {}), { backend: none, reason: 'unknown backend "jev"' });
});
