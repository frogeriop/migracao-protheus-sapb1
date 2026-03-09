/**
 * Shared in-process log buffer — captura console.log/warn/error
 * e armazena as últimas MAX_ENTRIES entradas para streaming SSE.
 *
 * Importar este módulo UMA VEZ na inicialização (ex: via `import '@/lib/logBuffer'`)
 * faz com que o patch do console seja aplicado globalmente.
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
    id: number;
    ts: string;       // HH:MM:SS
    level: LogLevel;
    source: string;
    message: string;
}

const MAX_ENTRIES = 500;

class LogBuffer {
    private buffer: LogEntry[] = [];
    private counter = 0;
    private listeners: Set<(e: LogEntry) => void> = new Set();
    private patched = false;

    /** Subscribe to new log entries in real-time */
    subscribe(cb: (e: LogEntry) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** Get last N entries */
    getLast(n = 200): LogEntry[] {
        return this.buffer.slice(-n);
    }

    push(level: LogLevel, source: string, message: string) {
        const now = new Date();
        const ts = now.toTimeString().slice(0, 8);
        const entry: LogEntry = { id: ++this.counter, ts, level, source, message };
        this.buffer.push(entry);
        if (this.buffer.length > MAX_ENTRIES) this.buffer.shift();
        this.listeners.forEach(cb => cb(entry));
    }

    /** Patch global console to capture all logs */
    patchConsole() {
        if (this.patched) return;
        this.patched = true;

        const origLog = console.log.bind(console);
        const origWarn = console.warn.bind(console);
        const origError = console.error.bind(console);

        const extract = (args: unknown[]): { source: string; message: string } => {
            const full = args
                .map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a)))
                .join(' ');
            // Try to parse [source] prefix from log messages like '[preview] doing X'
            const m = full.match(/^\[([^\]]{1,30})\]\s*([\s\S]*)/);
            if (m) return { source: m[1], message: m[2].slice(0, 300) };
            return { source: 'server', message: full.slice(0, 300) };
        };

        console.log = (...args) => {
            origLog(...args);
            const { source, message } = extract(args);
            this.push('INFO', source, message);
        };

        console.warn = (...args) => {
            origWarn(...args);
            const { source, message } = extract(args);
            this.push('WARN', source, message);
        };

        console.error = (...args) => {
            origError(...args);
            const { source, message } = extract(args);
            this.push('ERROR', source, message);
        };
    }
}

// Singleton global (sobrevive hot-reload no Next.js dev através do globalThis)
declare global {
    // eslint-disable-next-line no-var
    var __logBuffer: LogBuffer | undefined;
}

if (!globalThis.__logBuffer) {
    globalThis.__logBuffer = new LogBuffer();
    globalThis.__logBuffer.patchConsole();
}

export const logBuffer = globalThis.__logBuffer;
