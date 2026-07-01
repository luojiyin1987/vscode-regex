export interface MatchSpan {
    start: number;
    end: number;
}

export interface MatchResult {
    status: 'cancelled' | 'complete' | 'input-limit' | 'match-limit' | 'timeout' | 'unsupported' | 'worker-error';
    matches: MatchSpan[];
}

export interface MatchCancellationToken {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => void): { dispose(): void };
}

export interface MatchOptions {
    cancellationToken?: MatchCancellationToken;
    maxInputLength?: number;
    maxMatches?: number;
    timeoutMs?: number;
}

export const DEFAULT_MAX_INPUT_LENGTH = 1_000_000;
const DEFAULT_MAX_MATCHES = 10_000;
const DEFAULT_TIMEOUT_MS = 250;

export function readTextForMatching(
    readPrefix: (maxLength: number) => string,
    maxInputLength = DEFAULT_MAX_INPUT_LENGTH,
): string {
    return readPrefix(maxInputLength + 1);
}

export function describeMatchStatus(result: Pick<MatchResult, 'status'>): string | undefined {
    switch (result.status) {
        case 'input-limit':
            return 'Preview skipped: the document exceeds the input limit.';
        case 'match-limit':
            return 'Preview truncated: the match limit was reached.';
        case 'timeout':
            return 'Preview stopped: regular expression evaluation timed out.';
        case 'unsupported':
            return 'Preview unavailable: this environment cannot create a worker.';
        case 'worker-error':
            return 'Preview stopped: the matching worker failed.';
        case 'cancelled':
        case 'complete':
            return undefined;
    }
}

export async function findRegexMatches(regex: RegExp, text: string, options: MatchOptions = {}): Promise<MatchResult> {
    const matches: MatchSpan[] = [];
    if (options.cancellationToken?.isCancellationRequested) {
        return { status: 'cancelled', matches };
    }

    const maxInputLength = options.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH;
    if (text.length > maxInputLength) {
        return { status: 'input-limit', matches };
    }

    const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
    if (maxMatches <= 0) {
        return { status: 'match-limit', matches };
    }

    let worker: WorkerAdapter | undefined;
    try {
        worker = createWorker();
    } catch {
        return { status: 'worker-error', matches };
    }
    if (!worker) {
        return { status: 'unsupported', matches };
    }

    return new Promise(resolve => {
        let settled = false;
        let cancellationDisposable: { dispose(): void } | undefined;
        const finish = (result: MatchResult) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            cancellationDisposable?.dispose();
            worker.dispose();
            resolve(result);
        };

        const timeout = setTimeout(() => {
            finish({ status: 'timeout', matches: [] });
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

        cancellationDisposable = options.cancellationToken?.onCancellationRequested(() => {
            finish({ status: 'cancelled', matches: [] });
        });
        worker.onMessage(result => finish(result));
        worker.onError(() => finish({ status: 'worker-error', matches: [] }));
        try {
            worker.postMessage({
                source: regex.source,
                flags: regex.flags,
                text,
                maxMatches,
            });
        } catch {
            finish({ status: 'worker-error', matches: [] });
        }
    });
}

interface WorkerRequest {
    source: string;
    flags: string;
    text: string;
    maxMatches: number;
}

interface WorkerAdapter {
    postMessage(message: WorkerRequest): void;
    onMessage(listener: (result: MatchResult) => void): void;
    onError(listener: () => void): void;
    dispose(): void;
}

interface NodeWorker {
    postMessage(message: WorkerRequest): void;
    on(event: 'message', listener: (result: MatchResult) => void): void;
    on(event: 'error', listener: () => void): void;
    terminate(): Promise<number>;
}

interface BrowserWorker {
    postMessage(message: WorkerRequest): void;
    addEventListener(type: 'message', listener: (event: { data: MatchResult }) => void): void;
    addEventListener(type: 'error', listener: () => void): void;
    terminate(): void;
}

interface BrowserWorkerGlobals {
    Worker?: new (url: string) => BrowserWorker;
    Blob?: new (parts: string[], options: { type: string }) => unknown;
    URL?: {
        createObjectURL(blob: unknown): string;
        revokeObjectURL(url: string): void;
    };
}

declare const process: { versions?: { node?: string } } | undefined;
declare const require: ((id: string) => unknown) | undefined;
declare function setTimeout(fn: () => void, delay: number): object;
declare function clearTimeout(token: object): void;

function createWorker(): WorkerAdapter | undefined {
    if (typeof process !== 'undefined' && process.versions?.node && typeof require === 'function') {
        const workerThreads = require('node:worker_threads') as {
            Worker: new (source: string, options: { eval: boolean }) => NodeWorker;
        };
        const worker = new workerThreads.Worker(WORKER_SOURCE, { eval: true });
        return {
            postMessage: message => worker.postMessage(message),
            onMessage: listener => worker.on('message', listener),
            onError: listener => worker.on('error', listener),
            dispose: () => {
                void worker.terminate();
            },
        };
    }

    const globals = globalThis as unknown as BrowserWorkerGlobals;
    if (!globals.Worker || !globals.Blob || !globals.URL) {
        return undefined;
    }

    const url = globals.URL.createObjectURL(new globals.Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    const worker = new globals.Worker(url);
    return {
        postMessage: message => worker.postMessage(message),
        onMessage: listener => worker.addEventListener('message', event => listener(event.data)),
        onError: listener => worker.addEventListener('error', listener),
        dispose: () => {
            worker.terminate();
            globals.URL!.revokeObjectURL(url);
        },
    };
}

const WORKER_SOURCE = `
function advanceStringIndex(text, index, unicode) {
    if (!unicode || index + 1 >= text.length) {
        return index + 1;
    }

    const first = text.charCodeAt(index);
    if (first < 0xD800 || first > 0xDBFF) {
        return index + 1;
    }

    const second = text.charCodeAt(index + 1);
    return second >= 0xDC00 && second <= 0xDFFF ? index + 2 : index + 1;
}

function findMatches({ source, flags, text, maxMatches }) {
    const regex = new RegExp(source, flags);
    const matches = [];
    let match;

    while ((regex.global || matches.length === 0) && (match = regex.exec(text))) {
        matches.push({
            start: match.index,
            end: match.index + match[0].length,
        });

        if (matches.length >= maxMatches) {
            return { status: 'match-limit', matches };
        }

        if (regex.lastIndex === match.index) {
            regex.lastIndex = advanceStringIndex(
                text,
                regex.lastIndex,
                regex.unicode || flags.includes('v'),
            );
        }
    }

    return { status: 'complete', matches };
}

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', message => parentPort.postMessage(findMatches(message)));
} else {
    self.addEventListener('message', event => self.postMessage(findMatches(event.data)));
}
`;
