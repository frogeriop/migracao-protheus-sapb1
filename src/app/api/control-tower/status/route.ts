import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig() {
    try { return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8')); } catch { return null; }
}

// Store to accumulate API metrics (in-memory, resets on restart)
export const apiMetrics: Record<string, { count: number; totalMs: number; errors: number; last: number }> = {};

// Track process start time
const processStartTime = Date.now();

export async function GET() {
    const config = await getConfig();
    const uptime = Math.floor((Date.now() - processStartTime) / 1000);

    // ── Server info ───────────────────────────────────────────────────────────
    const serverInfo = {
        status: 'online',
        uptime,
        uptimeHuman: formatUptime(uptime),
        environment: process.env.NODE_ENV || 'development',
        nodeVersion: process.version,
        platform: `${os.type()} ${os.arch()}`,
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
        cpuLoad: os.loadavg()[0].toFixed(2),
        hostname: os.hostname(),
    };

    // ── Package version ───────────────────────────────────────────────────────
    let appVersion = 'N/A';
    try {
        const pkg = JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf-8'));
        appVersion = pkg.version || '0.1.0';
    } catch { /**/ }

    // ── Database (Supabase) health ────────────────────────────────────────────
    let dbStatus = { status: 'unknown', latencyMs: -1, tables: 0 };
    if (config?.supabase?.url && config?.supabase?.key) {
        const t0 = Date.now();
        try {
            const sb = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });
            const { data, error } = await sb.rpc('exec_sql', { query: 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=\'public\'' });
            dbStatus = {
                status: error ? 'error' : 'online',
                latencyMs: Date.now() - t0,
                tables: !error && data ? Number(data) : 0,
            };
        } catch { dbStatus = { status: 'error', latencyMs: Date.now() - t0, tables: 0 }; }
    } else {
        dbStatus.status = 'not_configured';
    }

    // ── SAP Service Layer health ──────────────────────────────────────────────
    let sapStatus = { status: 'unknown', latencyMs: -1, version: '' };
    if (config?.sap?.serviceLayerUrl) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
        const t0 = Date.now();
        try {
            const r = await fetch(`${config.sap.serviceLayerUrl}/ServiceLayerVersion`, {
                signal: AbortSignal.timeout(5000),
            });
            const latencyMs = Date.now() - t0;
            if (r.ok) {
                const j = await r.json();
                sapStatus = { status: 'online', latencyMs, version: j.Version || '' };
            } else {
                sapStatus = { status: 'error', latencyMs, version: '' };
            }
        } catch (e: any) {
            sapStatus = { status: 'offline', latencyMs: Date.now() - t0, version: '' };
        }
    } else {
        sapStatus.status = 'not_configured';
    }

    // ── Protheus SQL Server health ────────────────────────────────────────────
    let protheusSt = { status: 'unknown', latencyMs: -1 };
    if (config?.protheus) {
        const t0 = Date.now();
        try {
            const sql = await import('mssql');
            const pool = await (sql as any).connect({
                server: config.protheus.server,
                database: config.protheus.database,
                user: config.protheus.user,
                password: config.protheus.password,
                port: Number(config.protheus.port) || 1433,
                options: { encrypt: false, trustServerCertificate: true },
                connectionTimeout: 4000,
            });
            await pool.request().query('SELECT 1');
            await pool.close();
            protheusSt = { status: 'online', latencyMs: Date.now() - t0 };
        } catch {
            protheusSt = { status: 'offline', latencyMs: Date.now() - t0 };
        }
    } else {
        protheusSt.status = 'not_configured';
    }

    // ── API Metrics summary ───────────────────────────────────────────────────
    const apiSummary = Object.entries(apiMetrics).map(([endpoint, m]) => ({
        endpoint,
        calls: m.count,
        avgMs: m.count > 0 ? Math.round(m.totalMs / m.count) : 0,
        errors: m.errors,
        errorRate: m.count > 0 ? ((m.errors / m.count) * 100).toFixed(1) + '%' : '0%',
        lastCall: m.last,
    })).sort((a, b) => b.calls - a.calls).slice(0, 20);

    return NextResponse.json({
        server: { ...serverInfo, version: appVersion },
        database: dbStatus,
        sap: sapStatus,
        protheus: protheusSt,
        api: apiSummary,
        timestamp: Date.now(),
    });
}

function formatUptime(sec: number) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
