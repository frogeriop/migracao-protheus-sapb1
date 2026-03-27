'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────
interface StatusData {
    server: {
        status: string; uptime: number; uptimeHuman: string;
        environment: string; nodeVersion: string; platform: string; version: string;
        memory: { used: number; total: number; rss: number };
        cpuLoad: string; hostname: string;
    };
    database: { status: string; latencyMs: number; tables: number };
    sap: { status: string; latencyMs: number; version: string };
    protheus: { status: string; latencyMs: number };
    api: { endpoint: string; calls: number; avgMs: number; errors: number; errorRate: string; lastCall: number }[];
    timestamp: number;
}

interface LogEntry {
    id: number;
    ts: string;
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    message: string;
    source: string;
}

interface DbTable { table_name: string; col_count: number }
interface DbRow { [key: string]: unknown }

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
    online: '#10b981', offline: '#ef4444', error: '#ef4444',
    unknown: '#64748b', not_configured: '#f59e0b',
};
const LEVEL_COLOR: Record<string, string> = {
    INFO: '#22d3ee', WARN: '#f59e0b', ERROR: '#ef4444', DEBUG: '#94a3b8',
};

function Badge({ status }: { status: string }) {
    const color = STATUS_COLOR[status] || '#64748b';
    return (
        <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 10px', borderRadius: 20, fontSize: '0.72rem', fontWeight: 700,
            background: color + '22', color, border: `1px solid ${color}55`, letterSpacing: 1,
        }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />
            {status.toUpperCase().replace('_', ' ')}
        </span>
    );
}

function Metric({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
    return (
        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: '12px 16px', border: '1px solid #334155' }}>
            <div style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 800, marginTop: 4, color: color || '#f8fafc' }}>{value}</div>
            {sub && <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 2 }}>{sub}</div>}
        </div>
    );
}

function SectionHeader({ icon, title, children }: { icon: string; title: string; children?: React.ReactNode }) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, color: '#f8fafc' }}>
                <span style={{ fontSize: '1.2rem' }}>{icon}</span>{title}
            </h2>
            {children}
        </div>
    );
}

// ── Simulated log generator (client-side demo — replace with SSE in production) ──
let _logId = 0;
const LOG_POOL: Omit<LogEntry, 'id' | 'ts'>[] = [
    { level: 'INFO', message: 'Servidor Next.js iniciado com Turbopack', source: 'next' },
    { level: 'INFO', message: 'Conexão Supabase estabelecida', source: 'supabase' },
    { level: 'INFO', message: 'SAP Login bem-sucedido', source: 'sap' },
    { level: 'INFO', message: '[preview] SA2010: 409 registros carregados', source: 'migration' },
    { level: 'INFO', message: '[sync_sap] SA2010: 312 BPs com CNPJ no SAP', source: 'sync' },
    { level: 'WARN', message: '[execute] write-back __sap_id falhou (recno=1234)', source: 'execute' },
    { level: 'INFO', message: '[execute] INSERT JournalEntry OK → JdtNum=5821', source: 'execute' },
    { level: 'ERROR', message: 'SAP Service Layer timeout após 5000ms', source: 'sap' },
    { level: 'DEBUG', message: '[preview] dedup: Reference2=FOPBMV/MAN/000030/001/DP', source: 'dedup' },
    { level: 'INFO', message: '[sync_sap] write-back OK: se2010/recno=881 → __sap_id=5821', source: 'sync' },
    { level: 'WARN', message: 'Registro sem CNPJ: a2_cod=FOPBKX', source: 'sync' },
    { level: 'INFO', message: 'GET /api/control-tower/status 200 in 121ms', source: 'http' },
    { level: 'INFO', message: 'POST /api/migration/preview 200 in 3412ms', source: 'http' },
    { level: 'ERROR', message: 'Falha ao conectar SQL Server: connection timeout', source: 'protheus' },
    { level: 'INFO', message: 'Importação SA2010 concluída: 409 registros', source: 'import' },
];

function makeLog(): LogEntry {
    const t = new Date();
    const entry = LOG_POOL[Math.floor(Math.random() * LOG_POOL.length)];
    return {
        id: ++_logId,
        ts: t.toTimeString().slice(0, 8),
        ...entry,
        message: entry.message + (Math.random() > 0.7 ? ` [${Math.floor(Math.random() * 9999)}]` : ''),
    };
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ControlTowerPage() {
    const [tab, setTab] = useState<'status' | 'logs' | 'api' | 'db'>('status');
    const [statusData, setStatusData] = useState<StatusData | null>(null);
    const [loading, setLoading] = useState(true);
    const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

    // Logs
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [logFilter, setLogFilter] = useState<string>('ALL');
    const [logSearch, setLogSearch] = useState('');
    const [logsConnected, setLogsConnected] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    // DB Inspector
    const [dbTables, setDbTables] = useState<DbTable[]>([]);
    const [dbSelectedTable, setDbSelectedTable] = useState('');
    const [dbRows, setDbRows] = useState<DbRow[]>([]);
    const [dbColumns, setDbColumns] = useState<string[]>([]);
    const [dbTotal, setDbTotal] = useState(0);
    const [dbOffset, setDbOffset] = useState(0);
    const [dbLoading, setDbLoading] = useState(false);

    // ── Fetch status ──────────────────────────────────────────────────────────
    const fetchStatus = useCallback(async () => {
        try {
            const r = await fetch('/api/control-tower/status');
            const d = await r.json();
            setStatusData(d);
            setLastRefresh(new Date());
        } catch { /**/ } finally { setLoading(false); }
    }, []);

    useEffect(() => {
        fetchStatus();
        const t = setInterval(fetchStatus, 10000);
        return () => clearInterval(t);
    }, [fetchStatus]);

    // ── Live Logs via SSE real ────────────────────────────────────────────────
    useEffect(() => {
        let es: EventSource | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;

        const connect = () => {
            es = new EventSource('/api/control-tower/logs');
            setLogsConnected(false);

            es.onopen = () => {
                setLogsConnected(true);
            };

            es.onmessage = (event) => {
                try {
                    const entry: LogEntry = JSON.parse(event.data);
                    setLogs(prev => {
                        const next = [...prev, entry];
                        return next.slice(-400); // manter últimas 400 entradas
                    });
                } catch { /* ignore */ }
            };

            es.onerror = () => {
                setLogsConnected(false);
                es?.close();
                // Reconnect após 3s
                retryTimer = setTimeout(connect, 3000);
            };
        };

        connect();

        return () => {
            es?.close();
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, []);

    useEffect(() => {
        if (autoScroll) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs, autoScroll]);


    // ── DB Inspector ──────────────────────────────────────────────────────────
    useEffect(() => {
        fetch('/api/control-tower/db-inspector')
            .then(r => r.json())
            .then(d => setDbTables(d.tables || []));
    }, []);

    const loadTable = async (tbl: string, off = 0) => {
        setDbLoading(true);
        setDbSelectedTable(tbl);
        setDbOffset(off);
        try {
            const r = await fetch(`/api/control-tower/db-inspector?table=${tbl}&limit=50&offset=${off}`);
            const d = await r.json();
            setDbRows(d.rows || []);
            setDbColumns(d.rows?.[0] ? Object.keys(d.rows[0]) : []);
            setDbTotal(d.total || 0);
        } finally { setDbLoading(false); }
    };

    // ── Filtered logs ─────────────────────────────────────────────────────────
    const filteredLogs = logs.filter(l =>
        (logFilter === 'ALL' || l.level === logFilter) &&
        (!logSearch || l.message.toLowerCase().includes(logSearch.toLowerCase()) || l.source.toLowerCase().includes(logSearch.toLowerCase()))
    );

    // ── Styles ────────────────────────────────────────────────────────────────
    const card = {
        background: '#1e293b', border: '1px solid #334155',
        borderRadius: 12, padding: 20,
    };

    const tabs = [
        { id: 'status', label: '🖥️ Status', },
        { id: 'logs', label: '📋 Live Logs', },
        { id: 'api', label: '⚡ API Monitor', },
        { id: 'db', label: '🗄️ DB Inspector', },
    ] as const;

    return (
        <div style={{ fontFamily: 'Inter, monospace', color: '#f8fafc', minHeight: '100vh' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                <div>
                    <h1 style={{
                        fontSize: '1.6rem', fontWeight: 800,
                        background: 'linear-gradient(135deg, #22d3ee, #6366f1)', WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                    }}>
                        🗼 Backend Control Tower
                    </h1>
                    <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 4 }}>
                        Painel DevOps • Somente Administradores •{' '}
                        Última atualização: {lastRefresh.toTimeString().slice(0, 8)}
                    </p>
                </div>
                <button
                    onClick={fetchStatus}
                    style={{
                        padding: '8px 16px', borderRadius: 8, border: '1px solid #334155',
                        background: 'transparent', color: '#22d3ee', fontSize: '0.8rem',
                        cursor: 'pointer', transition: 'all .2s',
                    }}
                >
                    🔄 Atualizar
                </button>
            </div>

            {/* Quick status bar */}
            {statusData && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                    {[
                        { label: 'Servidor', st: statusData.server.status, sub: statusData.server.uptimeHuman },
                        { label: 'Supabase', st: statusData.database.status, sub: `${statusData.database.latencyMs}ms` },
                        { label: 'SAP B1', st: statusData.sap.status, sub: `${statusData.sap.latencyMs}ms` },
                        { label: 'Protheus', st: statusData.protheus.status, sub: `${statusData.protheus.latencyMs}ms` },
                    ].map(s => (
                        <div key={s.label} style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>{s.label}</div>
                            <Badge status={s.st} />
                            <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{s.sub}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #334155', paddingBottom: 0 }}>
                {tabs.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)} style={{
                        padding: '8px 18px', borderRadius: '8px 8px 0 0', border: 'none',
                        background: tab === t.id ? '#1e293b' : 'transparent',
                        color: tab === t.id ? '#22d3ee' : '#64748b',
                        fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
                        borderBottom: tab === t.id ? '2px solid #22d3ee' : '2px solid transparent',
                        transition: 'all .15s',
                    }}>{t.label}</button>
                ))}
            </div>

            {/* ── TAB: Status ─────────────────────────────────────────────────── */}
            {tab === 'status' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    {loading && <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>⏳ Carregando...</div>}
                    {statusData && (
                        <>
                            {/* Server metrics */}
                            <div style={card}>
                                <SectionHeader icon="🖥️" title="Servidor Next.js" />
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
                                    <Metric label="Status" value={statusData.server.status.toUpperCase()} color="#10b981" />
                                    <Metric label="Uptime" value={statusData.server.uptimeHuman} />
                                    <Metric label="Versão App" value={`v${statusData.server.version}`} />
                                    <Metric label="Ambiente" value={statusData.server.environment} />
                                    <Metric label="Node.js" value={statusData.server.nodeVersion} />
                                    <Metric label="Heap Usado" value={`${statusData.server.memory.used} MB`} sub={`de ${statusData.server.memory.total} MB`} />
                                    <Metric label="RSS" value={`${statusData.server.memory.rss} MB`} />
                                    <Metric label="CPU Load" value={statusData.server.cpuLoad} />
                                    <Metric label="Host" value={statusData.server.hostname} />
                                    <Metric label="SO" value={statusData.server.platform} />
                                </div>
                            </div>

                            {/* Integrations */}
                            <div style={card}>
                                <SectionHeader icon="🔌" title="Integrações Externas" />
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
                                    {[
                                        { name: 'Supabase (PostgreSQL)', ...statusData.database, extra: `${statusData.database.tables} tabelas` },
                                        { name: 'SAP Service Layer', ...statusData.sap, extra: statusData.sap.version || '—' },
                                        { name: 'Protheus SQL Server', ...statusData.protheus, extra: `Latência: ${statusData.protheus.latencyMs}ms` },
                                    ].map(i => (
                                        <div key={i.name} style={{
                                            background: 'rgba(255,255,255,0.03)', borderRadius: 10,
                                            padding: 16, border: '1px solid #334155',
                                        }}>
                                            <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 10 }}>{i.name}</div>
                                            <Badge status={i.status} />
                                            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 10 }}>
                                                Latência: <b style={{ color: '#f8fafc' }}>{i.latencyMs}ms</b>
                                            </div>
                                            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 4 }}>{i.extra}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Memory bar */}
                            <div style={card}>
                                <SectionHeader icon="💾" title="Memória" />
                                <div style={{ marginBottom: 6 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#94a3b8', marginBottom: 6 }}>
                                        <span>Heap Usada</span>
                                        <span>{statusData.server.memory.used} / {statusData.server.memory.total} MB</span>
                                    </div>
                                    <div style={{ height: 8, background: '#334155', borderRadius: 4, overflow: 'hidden' }}>
                                        <div style={{
                                            height: '100%', borderRadius: 4, transition: 'width .5s',
                                            width: `${Math.round((statusData.server.memory.used / statusData.server.memory.total) * 100)}%`,
                                            background: 'linear-gradient(90deg, #22d3ee, #6366f1)',
                                        }} />
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ── TAB: Live Logs ───────────────────────────────────────────────── */}
            {tab === 'logs' && (
                <div style={card}>
                    <SectionHeader icon="📋" title="Live Logs">
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input
                                value={logSearch} onChange={e => setLogSearch(e.target.value)}
                                placeholder="Buscar..."
                                style={{
                                    padding: '5px 10px', borderRadius: 6, border: '1px solid #334155',
                                    background: '#0f172a', color: '#f8fafc', fontSize: '0.8rem', width: 180,
                                }}
                            />
                            {(['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG'] as const).map(lv => (
                                <button key={lv} onClick={() => setLogFilter(lv)} style={{
                                    padding: '4px 10px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700,
                                    border: logFilter === lv ? `1px solid ${LEVEL_COLOR[lv] || '#334155'}` : '1px solid #334155',
                                    background: logFilter === lv ? (LEVEL_COLOR[lv] || '#334155') + '33' : 'transparent',
                                    color: logFilter === lv ? (LEVEL_COLOR[lv] || '#f8fafc') : '#64748b',
                                    cursor: 'pointer',
                                }}>{lv}</button>
                            ))}
                            <button onClick={() => setAutoScroll(p => !p)} style={{
                                padding: '4px 12px', borderRadius: 6, fontSize: '0.78rem', fontWeight: 700,
                                border: '1px solid #334155', background: 'transparent',
                                color: autoScroll ? '#10b981' : '#ef4444', cursor: 'pointer',
                            }}>
                                {autoScroll ? '⏸ Pausar scroll' : '▶ Auto-scroll'}
                            </button>
                            <button onClick={() => setLogs([])} style={{
                                padding: '4px 10px', borderRadius: 6, fontSize: '0.72rem',
                                border: '1px solid #334155', background: 'transparent', color: '#64748b', cursor: 'pointer',
                            }}>🗑</button>
                        </div>
                    </SectionHeader>

                    <div style={{
                        height: 500, overflowY: 'auto', background: '#0f172a',
                        borderRadius: 8, border: '1px solid #334155', fontFamily: 'Monaco, monospace', fontSize: '0.75rem',
                    }}>
                        {filteredLogs.map(log => (
                            <div key={log.id} style={{
                                display: 'flex', gap: 10, padding: '3px 12px',
                                borderBottom: '1px solid rgba(51,65,85,0.3)',
                                background: log.level === 'ERROR' ? 'rgba(239,68,68,0.05)' : 'transparent',
                            }}>
                                <span style={{ color: '#475569', minWidth: 60 }}>{log.ts}</span>
                                <span style={{
                                    color: LEVEL_COLOR[log.level], minWidth: 44, fontWeight: 700,
                                }}>{log.level}</span>
                                <span style={{ color: '#818cf8', minWidth: 72 }}>[{log.source}]</span>
                                <span style={{ color: log.level === 'ERROR' ? '#fca5a5' : '#cbd5e1', flex: 1 }}>{log.message}</span>
                            </div>
                        ))}
                        <div ref={logsEndRef} />
                    </div>
                    <div style={{ marginTop: 8, fontSize: '0.72rem', color: '#64748b' }}>
                        {filteredLogs.length} linhas exibidas •{' '}
                        {logsConnected
                            ? <span style={{ color: '#10b981' }}>🟢 SSE conectado — logs reais do servidor</span>
                            : <span style={{ color: '#f59e0b' }}>🟡 Reconectando...</span>
                        }
                    </div>
                </div>
            )}

            {/* ── TAB: API Monitor ─────────────────────────────────────────────── */}
            {tab === 'api' && (
                <div style={card}>
                    <SectionHeader icon="⚡" title="API Monitor" />
                    {!statusData?.api?.length ? (
                        <div style={{ color: '#64748b', textAlign: 'center', padding: 40 }}>
                            Nenhuma chamada registrada ainda. Execute operações para ver métricas.
                        </div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid #334155' }}>
                                    {['Endpoint', 'Chamadas', 'Média (ms)', 'Erros', 'Taxa Erro', 'Última'].map(h => (
                                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#64748b', fontWeight: 600 }}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {statusData.api.map((row, i) => (
                                    <tr key={i} style={{ borderBottom: '1px solid rgba(51,65,85,0.5)' }}>
                                        <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: '#22d3ee' }}>{row.endpoint}</td>
                                        <td style={{ padding: '8px 12px' }}>{row.calls}</td>
                                        <td style={{ padding: '8px 12px', color: row.avgMs > 1000 ? '#f59e0b' : '#10b981' }}>{row.avgMs}</td>
                                        <td style={{ padding: '8px 12px', color: row.errors > 0 ? '#ef4444' : '#64748b' }}>{row.errors}</td>
                                        <td style={{ padding: '8px 12px', color: parseFloat(row.errorRate) > 5 ? '#ef4444' : '#94a3b8' }}>{row.errorRate}</td>
                                        <td style={{ padding: '8px 12px', color: '#64748b', fontSize: '0.72rem' }}>
                                            {new Date(row.lastCall).toTimeString().slice(0, 8)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    {/* Nota de instrução */}
                    <div style={{ marginTop: 16, padding: '10px 16px', background: 'rgba(34,211,238,0.07)', borderRadius: 8, border: '1px solid rgba(34,211,238,0.2)', fontSize: '0.78rem', color: '#94a3b8' }}>
                        💡 Métricas resetam ao reiniciar o servidor. Implemente middleware para persistência.
                    </div>
                </div>
            )}

            {/* ── TAB: DB Inspector ────────────────────────────────────────────── */}
            {tab === 'db' && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                    {/* Table list */}
                    <div style={{ ...card, width: 220, flexShrink: 0, minHeight: 400 }}>
                        <SectionHeader icon="🗄️" title="Tabelas" />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {dbTables?.map((t: DbTable) => (
                                <button key={t.table_name} onClick={() => loadTable(t.table_name)} style={{
                                    padding: '6px 10px', borderRadius: 6, textAlign: 'left', border: 'none',
                                    background: dbSelectedTable === t.table_name ? 'rgba(34,211,238,0.12)' : 'transparent',
                                    color: dbSelectedTable === t.table_name ? '#22d3ee' : '#94a3b8',
                                    fontSize: '0.8rem', cursor: 'pointer', fontFamily: 'monospace',
                                    borderLeft: dbSelectedTable === t.table_name ? '3px solid #22d3ee' : '3px solid transparent',
                                }}>
                                    {t.table_name}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Data grid */}
                    <div style={{ ...card, flex: 1, overflow: 'hidden' }}>
                        {!dbSelectedTable && (
                            <div style={{ color: '#64748b', textAlign: 'center', padding: 60 }}>
                                ← Selecione uma tabela para inspecionar
                            </div>
                        )}
                        {dbSelectedTable && (
                            <>
                                <SectionHeader icon="📊" title={dbSelectedTable}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{dbTotal} registros</span>
                                        <button
                                            onClick={() => dbOffset > 0 && loadTable(dbSelectedTable, dbOffset - 50)}
                                            disabled={dbOffset === 0}
                                            style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '0.75rem' }}
                                        >◀</button>
                                        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{dbOffset + 1}–{Math.min(dbOffset + 50, dbTotal)}</span>
                                        <button
                                            onClick={() => dbOffset + 50 < dbTotal && loadTable(dbSelectedTable, dbOffset + 50)}
                                            disabled={dbOffset + 50 >= dbTotal}
                                            style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: '0.75rem' }}
                                        >▶</button>
                                    </div>
                                </SectionHeader>
                                {dbLoading ? (
                                    <div style={{ textAlign: 'center', padding: 40, color: '#64748b' }}>⏳ Carregando...</div>
                                ) : (
                                    <div style={{ overflowX: 'auto' }}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', fontFamily: 'monospace' }}>
                                            <thead>
                                                <tr style={{ borderBottom: '1px solid #334155', background: '#0f172a' }}>
                                                    {dbColumns.map(col => (
                                                        <th key={col} style={{
                                                            padding: '6px 10px', textAlign: 'left', color: '#64748b',
                                                            fontWeight: 700, whiteSpace: 'nowrap', position: 'sticky', top: 0,
                                                        }}>{col}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {dbRows.map((row, i) => (
                                                    <tr key={i} style={{ borderBottom: '1px solid rgba(51,65,85,0.4)', background: i % 2 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                                                        {dbColumns.map(col => {
                                                            const val = row[col];
                                                            return (
                                                                <td key={col} style={{
                                                                    padding: '4px 10px', maxWidth: 180, overflow: 'hidden',
                                                                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                                    color: val === null ? '#475569' : val === true ? '#10b981' : val === false ? '#ef4444' : '#cbd5e1',
                                                                }} title={String(val ?? '')}>
                                                                    {val === null ? 'NULL' : String(val)}
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
