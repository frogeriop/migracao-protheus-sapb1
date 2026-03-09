'use client';

import { useState } from 'react';
import {
    Database, Copy, Check, AlertCircle, Loader2, BookOpen,
    Server, ChevronDown, ChevronUp, Trash2
} from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';

interface ProcessLog {
    table: string;
    status: 'pending' | 'processing' | 'success' | 'error';
    message: string;
    rowsCopied?: number;
}

// ── Tabelas Protheus ──────────────────────────────────────────────────────────
const STRUCTURE_TABLES = ['SA1010', 'SA2010', 'SB1010', 'SE1010', 'SE2010'];
const CUSTOM_IMPORT_ROUTES: Record<string, string> = {
    SED010: '/api/naturezas/import',
};
// Tabelas que após importação do TOTVS fazem sync automático com o SAP B1
const SAP_SYNC_TABLES = ['SA1010', 'SA2010', 'SE1010', 'SE2010'];

interface ProtheusTable { code: string; name: string; badge?: string; }
const PROTHEUS_TABLES: ProtheusTable[] = [
    { code: 'SA1010', name: 'Clientes' },
    { code: 'SA2010', name: 'Fornecedores' },
    { code: 'SB1010', name: 'Produtos' },
    { code: 'SE1010', name: 'Contas a Receber' },
    { code: 'SE2010', name: 'Contas a Pagar' },
    { code: 'SED010', name: 'Naturezas de Lançamento', badge: 'Reimporta do zero' },
];

// ── Tabelas SAP B1 ────────────────────────────────────────────────────────────
interface SapTable {
    code: string;
    name: string;
    description: string;
    apiRoute: string;
    deleteRoute: string;
    supabaseTable: string;
}
const SAP_TABLES: SapTable[] = [
    {
        code: 'CoA',
        name: 'Plano de Contas',
        description: 'ChartOfAccounts — contas contáveis do SAP B1 para mapeamento de naturezas.',
        apiRoute: '/api/sap/chart-of-accounts',
        deleteRoute: '/api/sap/chart-of-accounts',
        supabaseTable: 'sap_chart_of_accounts',
    },
    {
        code: 'CC',
        name: 'Centros de Custo',
        description: 'ProfitCenters — centros de custo (dimensões) disponíveis no SAP B1.',
        apiRoute: '/api/sap/cost-centers',
        deleteRoute: '/api/sap/cost-centers',
        supabaseTable: 'sap_cost_centers',
    },
    {
        code: 'BP',
        name: 'Filiais (Business Places)',
        description: 'BusinessPlaces — filiais com CNPJ, endereço, depósito padrão e dados fiscais/SPED.',
        apiRoute: '/api/sap/business-places/import',
        deleteRoute: '/api/sap/business-places/import',
        supabaseTable: 'sap_business_places',
    },
    {
        code: 'CDP',
        name: 'Períodos Contábeis',
        description: 'OFPR — períodos de lançamento contábil (mensal/anual) configurados no SAP B1.',
        apiRoute: '/api/sap/posting-periods',
        deleteRoute: '/api/sap/posting-periods',
        supabaseTable: 'sap_posting_periods',
    },
];

export default function TablesPage() {
    const { config, loading } = useConfig();

    // ── Protheus state ────────────────────────────────────────────────────────
    const [selectedProtheus, setSelectedProtheus] = useState<string[]>([]);
    const [replicating, setReplicating] = useState(false);
    const [logs, setLogs] = useState<ProcessLog[]>([]);

    // ── SAP B1 state ──────────────────────────────────────────────────────────
    const [selectedSap, setSelectedSap] = useState<string[]>([]);
    const [sapLogs, setSapLogs] = useState<ProcessLog[]>([]);
    const [importingSap, setImportingSap] = useState(false);
    const [sapSectionOpen, setSapSectionOpen] = useState(true);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const toggleProtheus = (code: string) =>
        setSelectedProtheus(prev => prev.includes(code) ? prev.filter(t => t !== code) : [...prev, code]);

    const toggleSap = (code: string) =>
        setSelectedSap(prev => prev.includes(code) ? prev.filter(t => t !== code) : [...prev, code]);

    // ── Protheus replication ──────────────────────────────────────────────────
    const replicateViaStructure = async (tableName: string) => {
        setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'processing', message: 'Verificando estrutura...' } : l));
        const initRes = await fetch('/api/migration/structure', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'init', tableName }),
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.message);

        const totalRows = initData.totalRows;
        if (totalRows === 0) {
            setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'success', message: 'Tabela criada (0 registros).', rowsCopied: 0 } : l));
            return;
        }

        let copied = 0;
        const BATCH = 1000;
        while (copied < totalRows) {
            setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'processing', message: `Copiando ${copied + 1}/${totalRows}...` } : l));
            const batchRes = await fetch('/api/migration/structure', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'batch', tableName, offset: copied, limit: BATCH }),
            });
            const batchData = await batchRes.json();
            if (!batchData.success) throw new Error(batchData.message);
            copied += batchData.rowsCopied;
        }
        setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'success', message: 'Concluído.', rowsCopied: copied } : l));

        // ── Sync SAP automático após importação (stream de progresso) ────────
        if (SAP_SYNC_TABLES.includes(tableName)) {
            setLogs(prev => prev.map(l => l.table === tableName
                ? { ...l, message: `✅ ${copied} importados. 🔄 Sincronizando códigos SAP...` }
                : l));
            try {
                const syncRes = await fetch('/api/migration/structure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'sync_sap', tableName }),
                });

                // Lê o stream NDJSON linha a linha e atualiza o log em tempo real
                const reader = syncRes.body?.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() ?? ''; // guarda linha incompleta

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const data = JSON.parse(line);
                                if (data.progress) {
                                    // Mensagem de progresso intermediária
                                    setLogs(prev => prev.map(l => l.table === tableName
                                        ? { ...l, status: 'processing', message: data.progress }
                                        : l));
                                } else if ('success' in data) {
                                    // Linha final com resultado
                                    const finalMsg = data.success
                                        ? `✅ ${copied} importados — ${data.message}`
                                        : `✅ ${copied} importados — ⚠️ sync SAP: ${data.message}`;
                                    setLogs(prev => prev.map(l => l.table === tableName
                                        ? { ...l, status: 'success', message: finalMsg, rowsCopied: copied }
                                        : l));
                                }
                            } catch { /* linha inválida, ignora */ }
                        }
                    }
                }
            } catch {
                setLogs(prev => prev.map(l => l.table === tableName
                    ? { ...l, status: 'success', message: `✅ ${copied} importados — ⚠️ sync SAP falhou (sem conexão).`, rowsCopied: copied }
                    : l));
            }
        }
    };

    const replicateViaCustomRoute = async (tableName: string, apiRoute: string) => {
        setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'processing', message: 'Verificando conexão...' } : l));
        const initRes = await fetch(apiRoute, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'init' }) });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.message);

        const totalRows = initData.totalRows || 0;
        if (totalRows === 0) {
            setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'success', message: 'Nenhum registro ativo encontrado.', rowsCopied: 0 } : l));
            return;
        }

        let offset = 0, copied = 0;
        const BATCH = 200;
        while (offset < totalRows) {
            setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'processing', message: `Importando ${Math.min(copied + BATCH, totalRows).toLocaleString('pt-BR')} / ${totalRows.toLocaleString('pt-BR')}...` } : l));
            const batchRes = await fetch(apiRoute, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'batch', offset, limit: BATCH }) });
            const batchData = await batchRes.json();
            if (!batchData.success) throw new Error(batchData.message);
            copied += batchData.rowsCopied || 0;
            offset += BATCH;
            if (batchData.rowsCopied === 0) break;
        }
        setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'success', message: 'Importado (mapeamentos preservados).', rowsCopied: copied } : l));
    };

    const handleReplicateProtheus = async () => {
        if (selectedProtheus.length === 0) return;
        setReplicating(true);
        setLogs(selectedProtheus.map(t => ({ table: t, status: 'pending', message: 'Aguardando...' })));
        for (const tableName of selectedProtheus) {
            try {
                const custom = CUSTOM_IMPORT_ROUTES[tableName];
                custom ? await replicateViaCustomRoute(tableName, custom) : await replicateViaStructure(tableName);
            } catch (e: any) {
                setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'error', message: e.message || 'Erro.' } : l));
            }
        }
        setReplicating(false);
    };

    // ── SAP B1 import ─────────────────────────────────────────────────────────
    const importSapTable = async (sapTable: SapTable) => {
        const { code, apiRoute } = sapTable;
        setSapLogs(prev => prev.map(l => l.table === code ? { ...l, status: 'processing', message: 'Conectando ao SAP B1 e buscando registros...' } : l));

        // BP usa POST simples (sem action); os outros usam { action: 'init' }
        const isBusinessPlaces = code === 'BP';

        const initRes = await fetch(apiRoute, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: isBusinessPlaces ? undefined : JSON.stringify({ action: 'init' }),
        });
        const initData = await initRes.json();
        if (!initData.success) throw new Error(initData.message);

        // BP retorna { upserted }, os outros retornam { rowsCopied, total, synthetic }
        const total: number = initData.total ?? initData.upserted ?? 0;
        const rowsCopied: number = initData.rowsCopied ?? initData.upserted ?? 0;
        const synthetic: number = initData.synthetic ?? 0;

        if (rowsCopied === 0) {
            setSapLogs(prev => prev.map(l => l.table === code ? {
                ...l, status: 'success',
                message: total === 0 ? 'Nenhum registro encontrado.' : `Nenhuma conta analítica encontrada (${total} sintéticas descartadas).`,
                rowsCopied: 0,
            } : l));
            return;
        }

        const msg = synthetic > 0
            ? `Importado: ${rowsCopied.toLocaleString('pt-BR')} registros (${synthetic} sintéticos descartados).`
            : `${rowsCopied.toLocaleString('pt-BR')} registro(s) importado(s) com sucesso.`;

        setSapLogs(prev => prev.map(l => l.table === code ? {
            ...l, status: 'success', message: msg, rowsCopied,
        } : l));
    };

    const handleImportSap = async () => {
        if (selectedSap.length === 0) return;
        setImportingSap(true);
        setSapLogs(selectedSap.map(code => ({ table: code, status: 'pending', message: 'Aguardando...' })));
        for (const code of selectedSap) {
            const sapTable = SAP_TABLES.find(t => t.code === code)!;
            try {
                await importSapTable(sapTable);
            } catch (e: any) {
                setSapLogs(prev => prev.map(l => l.table === code ? { ...l, status: 'error', message: e.message || 'Erro.' } : l));
            }
        }
        setImportingSap(false);
    };

    const handleClearSap = async (sapTable: SapTable) => {
        if (!confirm(`Apagar todos os registros de "${sapTable.name}"?`)) return;
        await fetch(sapTable.deleteRoute, { method: 'DELETE' });
    };

    if (loading) return <div>Carregando...</div>;

    const logBar = (log: ProcessLog) => (
        <div key={log.table} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0.75rem', backgroundColor: 'var(--background)', borderRadius: '6px',
            borderLeft: `4px solid ${log.status === 'success' ? 'var(--success)' : log.status === 'error' ? 'var(--error)' : log.status === 'processing' ? 'var(--accent)' : 'var(--secondary)'}`
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontWeight: 700, width: '90px', fontFamily: 'monospace', fontSize: '0.85rem' }}>{log.table}</span>
                <span style={{ color: 'var(--secondary)', fontSize: '0.875rem' }}>
                    {log.status === 'processing' && <Loader2 size={14} className="spinner" style={{ display: 'inline', marginRight: 5 }} />}
                    {log.message}
                </span>
            </div>
            {log.rowsCopied !== undefined && (
                <span style={{ backgroundColor: 'rgba(16,185,129,0.1)', color: 'var(--success)', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.78rem', fontWeight: 700 }}>
                    {log.rowsCopied.toLocaleString('pt-BR')} registros
                </span>
            )}
        </div>
    );

    return (
        <div className="container">
            <h1 className="page-title">Seleção de Tabelas</h1>
            <p style={{ color: 'var(--secondary)', marginBottom: '2rem' }}>
                Importe tabelas de origem (TOTVS Protheus) e de destino (SAP Business One) para o banco intermediário Supabase.
            </p>

            {/* ── SEÇÃO PROTHEUS ─────────────────────────────────────────────── */}
            <div style={{ marginBottom: '2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
                    <div style={{ width: '4px', height: '24px', backgroundColor: 'var(--primary)', borderRadius: '2px' }} />
                    <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                        Origem: TOTVS Protheus
                    </h2>
                    <span style={{ fontSize: '0.78rem', color: 'var(--secondary)', backgroundColor: 'var(--background)', border: '1px solid var(--card-border)', padding: '1px 8px', borderRadius: '999px' }}>
                        Replicação completa para Supabase
                    </span>
                </div>

                <div className="card">
                    <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.5rem' }}>
                        {PROTHEUS_TABLES.map((table) => {
                            const isSelected = selectedProtheus.includes(table.code);
                            const isCustom = !!CUSTOM_IMPORT_ROUTES[table.code];
                            const accent = isCustom ? '#8b5cf6' : 'var(--primary)';
                            return (
                                <div key={table.code}
                                    onClick={() => !replicating && toggleProtheus(table.code)}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.875rem 1rem',
                                        backgroundColor: isSelected ? (isCustom ? 'rgba(139,92,246,0.08)' : 'rgba(59,130,246,0.08)') : 'var(--background)',
                                        border: `1px solid ${isSelected ? accent : 'var(--card-border)'}`,
                                        borderRadius: '8px', cursor: replicating ? 'not-allowed' : 'pointer',
                                        opacity: replicating ? 0.7 : 1, transition: 'all 0.15s',
                                    }}
                                >
                                    <div style={{
                                        width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                                        border: `2px solid ${isSelected ? accent : 'var(--secondary)'}`,
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        backgroundColor: isSelected ? accent : 'transparent',
                                    }}>
                                        {isSelected && <Check size={13} color="white" />}
                                    </div>
                                    {isCustom && <BookOpen size={15} style={{ color: '#8b5cf6', flexShrink: 0 }} />}
                                    <div style={{ flex: 1 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <strong style={{ fontFamily: 'monospace', color: 'var(--foreground)', fontSize: '0.9rem' }}>{table.code}</strong>
                                            <span style={{ color: 'var(--secondary)', fontSize: '0.85rem' }}>{table.name}</span>
                                        </div>
                                        {table.badge && (
                                            <span style={{
                                                display: 'inline-block', marginTop: '0.2rem', fontSize: '0.68rem', fontWeight: 700,
                                                padding: '1px 7px', borderRadius: '999px', textTransform: 'uppercase', letterSpacing: '0.04em',
                                                backgroundColor: 'rgba(139,92,246,0.12)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.25)',
                                            }}>{table.badge}</span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <button onClick={handleReplicateProtheus} disabled={replicating || selectedProtheus.length === 0}
                        className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                        {replicating
                            ? <><Loader2 className="spinner" size={17} style={{ marginRight: '0.5rem' }} />Processando...</>
                            : <><Copy size={17} style={{ marginRight: '0.5rem' }} />Iniciar Replicação Completa</>
                        }
                    </button>

                    {logs.length > 0 && (
                        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--card-border)', paddingTop: '1.25rem' }}>
                            <h3 style={{ fontSize: '0.95rem', marginBottom: '0.75rem', color: 'var(--foreground)' }}>Log de Execução</h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                {logs.map(logBar)}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* ── SEÇÃO SAP B1 ───────────────────────────────────────────────── */}
            <div>
                <div
                    style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', cursor: 'pointer' }}
                    onClick={() => setSapSectionOpen(o => !o)}
                >
                    <div style={{ width: '4px', height: '24px', backgroundColor: '#10b981', borderRadius: '2px' }} />
                    <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                        Destino: SAP Business One
                    </h2>
                    <span style={{
                        fontSize: '0.78rem', color: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)',
                        border: '1px solid rgba(16,185,129,0.25)', padding: '1px 8px', borderRadius: '999px',
                    }}>
                        Dados de referência para mapeamento
                    </span>
                    <span style={{ marginLeft: 'auto', color: 'var(--secondary)' }}>
                        {sapSectionOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    </span>
                </div>

                {sapSectionOpen && (
                    <div className="card">
                        <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.5rem' }}>
                            {SAP_TABLES.map((table) => {
                                const isSelected = selectedSap.includes(table.code);
                                return (
                                    <div key={table.code}
                                        onClick={() => !importingSap && toggleSap(table.code)}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.875rem 1rem',
                                            backgroundColor: isSelected ? 'rgba(16,185,129,0.08)' : 'var(--background)',
                                            border: `1px solid ${isSelected ? '#10b981' : 'var(--card-border)'}`,
                                            borderRadius: '8px', cursor: importingSap ? 'not-allowed' : 'pointer',
                                            opacity: importingSap ? 0.7 : 1, transition: 'all 0.15s',
                                        }}
                                    >
                                        <div style={{
                                            width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                                            border: `2px solid ${isSelected ? '#10b981' : 'var(--secondary)'}`,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            backgroundColor: isSelected ? '#10b981' : 'transparent',
                                        }}>
                                            {isSelected && <Check size={13} color="white" />}
                                        </div>
                                        <Server size={15} style={{ color: '#10b981', flexShrink: 0 }} />
                                        <div style={{ flex: 1 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <strong style={{ fontFamily: 'monospace', color: 'var(--foreground)', fontSize: '0.9rem' }}>{table.code}</strong>
                                                <span style={{ color: 'var(--foreground)', fontSize: '0.85rem', fontWeight: 600 }}>{table.name}</span>
                                            </div>
                                            <span style={{ color: 'var(--secondary)', fontSize: '0.8rem' }}>{table.description}</span>
                                        </div>
                                        <button
                                            onClick={e => { e.stopPropagation(); handleClearSap(table); }}
                                            disabled={importingSap}
                                            title={`Limpar ${table.name}`}
                                            style={{
                                                background: 'none', border: '1px solid var(--card-border)', borderRadius: '6px',
                                                padding: '4px 7px', cursor: 'pointer', color: 'var(--secondary)',
                                                display: 'flex', alignItems: 'center',
                                            }}
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        <button onClick={handleImportSap} disabled={importingSap || selectedSap.length === 0}
                            style={{
                                width: '100%', justifyContent: 'center', display: 'flex', alignItems: 'center',
                                gap: '0.5rem', padding: '0.7rem', borderRadius: '8px', fontWeight: 600,
                                backgroundColor: selectedSap.length === 0 || importingSap ? 'rgba(16,185,129,0.4)' : '#10b981',
                                color: 'white', border: 'none', cursor: selectedSap.length === 0 || importingSap ? 'not-allowed' : 'pointer',
                                fontSize: '0.9rem', transition: 'all 0.15s',
                            }}>
                            {importingSap
                                ? <><Loader2 className="spinner" size={17} />Importando do SAP B1...</>
                                : <><Database size={17} />Importar do SAP Business One</>
                            }
                        </button>

                        {sapLogs.length > 0 && (
                            <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--card-border)', paddingTop: '1.25rem' }}>
                                <h3 style={{ fontSize: '0.95rem', marginBottom: '0.75rem', color: 'var(--foreground)' }}>Log SAP B1</h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                    {sapLogs.map(logBar)}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
