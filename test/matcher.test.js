const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const test = require('node:test');
const { promisify } = require('node:util');

const { findRegexMatches } = require('../out/matcher');
const execFileAsync = promisify(execFile);

test('finds every match for a global regular expression', async () => {
    const result = await findRegexMatches(/foo/g, 'foo bar foo');

    assert.deepEqual(result, {
        status: 'complete',
        matches: [
            { start: 0, end: 3 },
            { start: 8, end: 11 },
        ],
    });
});

test('terminates after Unicode-aware zero-length matches', async () => {
    const script = `
        const { findRegexMatches } = require(${JSON.stringify(require.resolve('../out/matcher'))});
        findRegexMatches(/(?=.)/gu, '😀x').then(result => {
            process.stdout.write(JSON.stringify(result));
        });
    `;

    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
        timeout: 1000,
    });

    assert.deepEqual(JSON.parse(stdout), {
        status: 'complete',
        matches: [
            { start: 0, end: 0 },
            { start: 2, end: 2 },
        ],
    });
});

test('stops after the configured match limit', async () => {
    const result = await findRegexMatches(/a/g, 'aaaa', { maxMatches: 2 });

    assert.deepEqual(result, {
        status: 'match-limit',
        matches: [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
        ],
    });
});

test('does not evaluate text beyond the configured input limit', async () => {
    const result = await findRegexMatches(/a/g, 'aaaa', { maxInputLength: 3 });

    assert.deepEqual(result, {
        status: 'input-limit',
        matches: [],
    });
});

test('times out catastrophic backtracking without blocking the caller', async () => {
    const script = `
        const { findRegexMatches } = require(${JSON.stringify(require.resolve('../out/matcher'))});
        findRegexMatches(/(a+)+$/, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!', { timeoutMs: 50 }).then(result => {
            process.stdout.write(JSON.stringify(result));
        });
    `;

    const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
        timeout: 2000,
    });

    assert.deepEqual(JSON.parse(stdout), {
        status: 'timeout',
        matches: [],
    });
});

test('cancels an obsolete match operation', async () => {
    const listeners = new Set();
    const cancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        cancel() {
            this.isCancellationRequested = true;
            listeners.forEach(listener => listener());
        },
    };

    const pending = findRegexMatches(
        /(a+)+$/,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!',
        { cancellationToken, timeoutMs: 1000 },
    );
    cancellationToken.cancel();

    assert.deepEqual(await pending, {
        status: 'cancelled',
        matches: [],
    });
});
