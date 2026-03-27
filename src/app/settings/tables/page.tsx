'use client';

import { useState, useEffect } from 'react';
import {
    Database, Copy, Check, AlertCircle, Loader2, BookOpen, FileSpreadsheet, Filter
} from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';

interface ProcessLog {
    table: string;
    status: 'pending' | 'processing' | 'success' | 'error';
    message: string;
    rowsCopied?: number;
}

interface MigrationEntity {
    id: string;
    name: string;
    target_object: string;
    source_file_path: string | null;
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

export default function TablesPage() {
    const { config, loading } = useConfig();

    // ── Protheus state ────────────────────────────────────────────────────────
    const [selectedProtheus, setSelectedProtheus] = useState<string[]>([]);
    const [replicating, setReplicating] = useState(false);
    const [logs, setLogs] = useState<ProcessLog[]>([]);

    interface ProtheusFilters {
        status: 'active' | 'inactive' | 'all';
        balance: 'all' | 'open';
    }
    const [protheusFilters, setProtheusFilters] = useState<Record<string, ProtheusFilters>>({
        SA1010: { status: 'active', balance: 'all' },
        SA2010: { status: 'active', balance: 'all' }
    });
    const [expandedFilter, setExpandedFilter] = useState<string | null>(null);

    // ── Excel state ───────────────────────────────────────────────────────────
    const [excelEntities, setExcelEntities] = useState<MigrationEntity[]>([]);
    const [importingExcel, setImportingExcel] = useState(false);
    const [excelLogs, setExcelLogs] = useState<ProcessLog[]>([]);

    // ── Tab state ─────────────────────────────────────────────────────────────
    const [activeSourceTab, setActiveSourceTab] = useState<'protheus' | 'excel'>('protheus');
    const [selectedExcelEntityId, setSelectedExcelEntityId] = useState<string | null>(null);

    useEffect(() => {
        if (!loading) {
            fetch('/api/migration/entities')
                .then(res => res.json())
                .then(data => {
                    if (data.success && data.data) {
                        const linked = data.data.filter((e: MigrationEntity) => e.source_file_path);
                        setExcelEntities(linked);
                        // Auto-select the first one if none selected
                        if (linked.length > 0) setSelectedExcelEntityId(linked[0].id);
                    }
                })
                .catch(console.error);
        }
    }, [loading]);

    // ── Handlers ──────────────────────────────────────────────────────────────
    const toggleProtheus = (code: string) =>
        setSelectedProtheus(prev => prev.includes(code) ? prev.filter(t => t !== code) : [...prev, code]);

    // ── Protheus replication ──────────────────────────────────────────────────
    const replicateViaStructure = async (tableName: string) => {
        const filters = {
            sa1010: protheusFilters.SA1010,
            sa2010: protheusFilters.SA2010
        };

        setLogs(prev => prev.map(l => l.table === tableName ? { ...l, status: 'processing', message: 'Verificando estrutura...' } : l));
        const initRes = await fetch('/api/migration/structure', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'init', tableName, filters }),
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
                body: JSON.stringify({ action: 'batch', tableName, offset: copied, limit: BATCH, filters }),
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

    // ── Excel Import ──────────────────────────────────────────────────────────
    const handleImportExcel = async () => {
        if (!selectedExcelEntityId) return;
        setImportingExcel(true);
        const entity = excelEntities.find(e => e.id === selectedExcelEntityId);
        if (!entity) return;

        const tableName = entity.name;
        
        setExcelLogs([{ table: tableName, status: 'processing', message: 'Lendo arquivo local...' }]);
        try {
            const res = await fetch('/api/migration/excel/import-local', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entityId: selectedExcelEntityId })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.message);
            
            setExcelLogs([{ table: tableName, status: 'success', message: 'Planilha importada com sucesso.', rowsCopied: data.rowsCopied }]);
        } catch (e: any) {
            setExcelLogs([{ table: tableName, status: 'error', message: e.message || 'Erro ao importar planilha.' }]);
        }
        
        setImportingExcel(false);
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
        <div className="container" style={{ paddingBottom: '3rem' }}>
            <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
                <div>
                    <h1 className="page-title">Importação de Dados (Staging)</h1>
                    <p className="page-description" style={{ marginBottom: '2rem' }}>
                        Importe dados de origem (TOTVS Protheus ou Planilha Excel) para as tabelas de staging do banco Supabase.
                    </p>
                </div>
            {/* ── SEÇÃO ORIGEM TABS ───────────────────────────────────────────── */}
            <div style={{ marginBottom: '2rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', borderBottom: '1px solid var(--card-border)', paddingBottom: '1rem' }}>
                    <h2 style={{ fontSize: '1.25rem', color: 'var(--foreground)' }}>1. Origem</h2>
                    <div style={{ display: 'flex', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '8px', padding: '0.25rem' }}>
                        <button
                            onClick={() => setActiveSourceTab('protheus')}
                            style={{
                                padding: '0.5rem 1rem',
                                borderRadius: '6px',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                backgroundColor: activeSourceTab === 'protheus' ? 'var(--primary)' : 'transparent',
                                color: activeSourceTab === 'protheus' ? '#fff' : 'var(--secondary)',
                                transition: 'all 0.2s'
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <Database size={14} /> Totvs Protheus
                            </div>
                        </button>
                        <button
                            onClick={() => setActiveSourceTab('excel')}
                            style={{
                                padding: '0.5rem 1rem',
                                borderRadius: '6px',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                backgroundColor: activeSourceTab === 'excel' ? 'var(--primary)' : 'transparent',
                                color: activeSourceTab === 'excel' ? '#fff' : 'var(--secondary)',
                                transition: 'all 0.2s'
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <FileSpreadsheet size={14} /> Planilha Excel
                            </div>
                        </button>
                    </div>
                </div>

                {activeSourceTab === 'protheus' ? (
                    <div className="card">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                            <span style={{ fontSize: '0.78rem', color: 'var(--secondary)', backgroundColor: 'var(--background)', border: '1px solid var(--card-border)', padding: '1px 8px', borderRadius: '999px' }}>
                                Selecione Múltiplas Tabelas
                            </span>
                        </div>
                        <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.5rem' }}>
                            {PROTHEUS_TABLES.map((table) => {
                                const isSelected = selectedProtheus.includes(table.code);
                                const isCustom = !!CUSTOM_IMPORT_ROUTES[table.code];
                                const accent = isCustom ? '#8b5cf6' : 'var(--primary)';
                                return (
                                    <div key={table.code} style={{ display: 'flex', flexDirection: 'column' }}>
                                        <div
                                            onClick={() => !replicating && toggleProtheus(table.code)}
                                            style={{
                                                display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.875rem 1rem',
                                                backgroundColor: isSelected ? (isCustom ? 'rgba(139,92,246,0.08)' : 'rgba(59,130,246,0.08)') : 'var(--background)',
                                                border: `1px solid ${isSelected ? accent : 'var(--card-border)'}`,
                                                borderRadius: expandedFilter === table.code ? '8px 8px 0 0' : '8px', cursor: replicating ? 'not-allowed' : 'pointer',
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

                                            {/* Botão de Filtro apenas para SA1010/SA2010 */}
                                            {(table.code === 'SA1010' || table.code === 'SA2010') && (
                                                <div style={{ marginLeft: 'auto', position: 'relative', zIndex: 10 }}>
                                                    <button 
                                                        type="button"
                                                        onClick={(e) => { 
                                                            e.preventDefault();
                                                            e.stopPropagation(); 
                                                            setExpandedFilter(expandedFilter === table.code ? null : table.code); 
                                                        }}
                                                        style={{ 
                                                            background: 'none', border: 'none', 
                                                            color: expandedFilter === table.code ? 'var(--primary)' : 'var(--secondary)', 
                                                            cursor: 'pointer', padding: '12px', borderRadius: '4px',
                                                            backgroundColor: expandedFilter === table.code ? 'rgba(59,130,246,0.1)' : 'transparent',
                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                            outline: 'none', minWidth: '40px', minHeight: '40px', margin: '-8px 0'
                                                        }}
                                                        title="Configurar Filtros de Importação"
                                                    >
                                                        <Filter size={18} pointerEvents="none" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                        
                                        {/* Painel Expansível de Filtros */}
                                        {expandedFilter === table.code && (
                                            <div style={{ 
                                                padding: '1rem', borderTop: `1px solid var(--card-border)`, 
                                                borderRight: `1px solid ${isSelected ? accent : 'var(--card-border)'}`,
                                                borderLeft: `1px solid ${isSelected ? accent : 'var(--card-border)'}`,
                                                borderBottom: `1px solid ${isSelected ? accent : 'var(--card-border)'}`,
                                                backgroundColor: 'rgba(0,0,0,0.1)', borderRadius: '0 0 8px 8px' 
                                            }}>
                                                <div style={{ display: 'flex', gap: '2rem' }}>
                                                    <div>
                                                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--secondary)', marginBottom: '0.4rem', fontWeight: 600 }}>Status do Cadastro</label>
                                                        <select 
                                                            value={protheusFilters[table.code].status} 
                                                            onChange={e => setProtheusFilters(p => ({ ...p, [table.code]: { ...p[table.code], status: e.target.value as any } }))}
                                                            style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--card-border)', padding: '0.4rem', borderRadius: '4px', fontSize: '0.8rem', outline: 'none', minWidth: '180px' }}
                                                        >
                                                            <option value="active">Somente Ativos (Padrão)</option>
                                                            <option value="inactive">Somente Inativos</option>
                                                            <option value="all">Trazer Todos</option>
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--secondary)', marginBottom: '0.4rem', fontWeight: 600 }}>Títulos em Aberto</label>
                                                        <select 
                                                            value={protheusFilters[table.code].balance} 
                                                            onChange={e => setProtheusFilters(p => ({ ...p, [table.code]: { ...p[table.code], balance: e.target.value as any } }))}
                                                            style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--card-border)', padding: '0.4rem', borderRadius: '4px', fontSize: '0.8rem', outline: 'none', minWidth: '220px' }}
                                                        >
                                                            <option value="all">Trazer Todos (Padrão)</option>
                                                            <option value="open">Somente com saldo em aberto</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
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
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '1rem' }}>
                        {/* Left Sidebar: Excel Entity Selection */}
                        <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '500px', overflowY: 'auto' }}>
                            <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--secondary)' }}>Tabelas de Importação</h4>
                            {excelEntities.length === 0 ? (
                                <p style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>Nenhuma planilha configurada com arquivo vinculado.</p>
                            ) : (
                                excelEntities.map(entity => (
                                    <button
                                        key={entity.id}
                                        onClick={() => !importingExcel && setSelectedExcelEntityId(entity.id)}
                                        disabled={importingExcel}
                                        style={{
                                            padding: '0.75rem',
                                            borderRadius: '8px',
                                            border: '1px solid ' + (selectedExcelEntityId === entity.id ? '#eab308' : 'var(--card-border)'),
                                            backgroundColor: selectedExcelEntityId === entity.id ? 'rgba(234, 179, 8, 0.08)' : 'transparent',
                                            color: selectedExcelEntityId === entity.id ? '#eab308' : 'var(--foreground)',
                                            textAlign: 'left',
                                            cursor: importingExcel ? 'not-allowed' : 'pointer',
                                            opacity: importingExcel && selectedExcelEntityId !== entity.id ? 0.6 : 1,
                                            fontSize: '0.9rem',
                                            transition: 'all 0.2s',
                                        }}
                                    >
                                        <div style={{ fontWeight: selectedExcelEntityId === entity.id ? 600 : 400 }}>{entity.name}</div>
                                        <div style={{ fontSize: '0.75rem', color: selectedExcelEntityId === entity.id ? '#ca8a04' : 'var(--secondary)', marginTop: '2px' }}>
                                            {entity.source_file_path}
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>

                        {/* Right Content: Import Info & Logs */}
                        <div className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                            {selectedExcelEntityId ? (() => {
                                const selectedEnt = excelEntities.find(e => e.id === selectedExcelEntityId);
                                if (!selectedEnt) return null;
                                return (
                                    <>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
                                            <div style={{ backgroundColor: 'rgba(234, 179, 8, 0.1)', padding: '0.75rem', borderRadius: '8px', color: '#eab308' }}>
                                                <FileSpreadsheet size={24} />
                                            </div>
                                            <div>
                                                <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>Planilha: {selectedEnt.name}</h3>
                                                <p style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>
                                                    Arquivo Alvo: <code style={{ color: 'var(--primary)', backgroundColor: 'transparent' }}>imports/{selectedEnt.source_file_path}</code>
                                                </p>
                                            </div>
                                        </div>

                                        <button onClick={handleImportExcel} disabled={importingExcel}
                                            style={{
                                                width: '100%', justifyContent: 'center', display: 'flex', alignItems: 'center',
                                                gap: '0.5rem', padding: '0.7rem', borderRadius: '8px', fontWeight: 600,
                                                backgroundColor: importingExcel ? 'rgba(234,179,8,0.4)' : '#eab308',
                                                color: 'white', border: 'none', cursor: importingExcel ? 'not-allowed' : 'pointer',
                                                fontSize: '0.9rem', transition: 'all 0.15s',
                                                marginBottom: '1.5rem'
                                            }}>
                                            {importingExcel
                                                ? <><Loader2 className="spinner" size={17} />Lendo & Inserindo dados...</>
                                                : <><Copy size={17} />Processar Arquivo Local</>
                                            }
                                        </button>

                                        {excelLogs.length > 0 && (
                                            <div style={{ flex: 1 }}>
                                                <h3 style={{ fontSize: '0.95rem', marginBottom: '0.75rem', color: 'var(--foreground)' }}>Log de Importação</h3>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                                    {excelLogs.map(logBar)}
                                                </div>
                                            </div>
                                        )}
                                    </>
                                );
                            })() : (
                                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                                    <FileSpreadsheet size={32} style={{ opacity: 0.5, marginBottom: '1rem' }} />
                                    <p>Selecione uma tabela à esquerda para importar registros do Excel salvo localmente.</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            </div>
        </div>
    );
}
