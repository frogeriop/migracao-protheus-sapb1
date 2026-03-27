'use client';

import { useState, useMemo, useEffect } from 'react';
import { Database, Loader2, Server, Trash2, Search, X, ArrowLeft, ArrowRight } from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import { ColDef, ModuleRegistry, AllCommunityModule, ICellRendererParams } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

interface SapTable {
    code: string;
    name: string;
    description: string;
    apiRoute: string;
    deleteRoute: string;
    supabaseTable: string;
    orderBy: string;
    isDirectSap?: boolean;
    sapEntity?: string;
}

const SAP_TABLES: SapTable[] = [
    {
        code: 'CoA',
        name: 'Plano de Contas',
        description: 'ChartOfAccounts — contas contáveis do SAP B1 para mapeamento de naturezas.',
        apiRoute: '/api/sap/chart-of-accounts',
        deleteRoute: '/api/sap/chart-of-accounts',
        supabaseTable: 'sap_chart_of_accounts',
        orderBy: 'code'
    },
    {
        code: 'CC',
        name: 'Centros de Custo',
        description: 'ProfitCenters — centros de custo (dimensões) disponíveis no SAP B1.',
        apiRoute: '/api/sap/cost-centers',
        deleteRoute: '/api/sap/cost-centers',
        supabaseTable: 'sap_cost_centers',
        orderBy: 'code'
    },
    {
        code: 'BP',
        name: 'Filiais (Business Places)',
        description: 'BusinessPlaces — filiais com CNPJ, endereço, depósito padrão e dados fiscais.',
        apiRoute: '/api/sap/business-places/import',
        deleteRoute: '/api/sap/business-places/import',
        supabaseTable: 'sap_business_places',
        orderBy: 'bpl_id'
    },
    {
        code: 'CDP',
        name: 'Períodos Contábeis',
        description: 'OFPR — períodos de lançamento contábil configurados no SAP B1.',
        apiRoute: '/api/sap/posting-periods',
        deleteRoute: '/api/sap/posting-periods',
        supabaseTable: 'sap_posting_periods',
        orderBy: 'abs_entry'
    },
    {
        code: 'ITM',
        name: 'Itens',
        description: 'Items — visualizar itens e produtos cadastrados no SAP B1.',
        apiRoute: '', deleteRoute: '', supabaseTable: '', orderBy: '',
        isDirectSap: true, sapEntity: 'Items'
    },
    {
        code: 'BPG',
        name: 'Grupos de PN',
        description: 'BusinessPartnerGroups — visualizar grupos de Parceiros de Negócio.',
        apiRoute: '', deleteRoute: '', supabaseTable: '', orderBy: '',
        isDirectSap: true, sapEntity: 'BusinessPartnerGroups'
    },
    {
        code: 'BPN',
        name: 'Parceiros de Negócio',
        description: 'BusinessPartners — visualizar Parceiros de Negócio (Clientes/Fornecedores) migrados.',
        apiRoute: '', deleteRoute: '', supabaseTable: '', orderBy: '',
        isDirectSap: true, sapEntity: 'BusinessPartners'
    },
    {
        code: 'SO',
        name: 'Sales Order',
        description: 'Orders — visualizar Pedidos de Venda (ORDR) migrados.',
        apiRoute: '', deleteRoute: '', supabaseTable: '', orderBy: '',
        isDirectSap: true, sapEntity: 'Orders'
    },
    {
        code: 'PO',
        name: 'Purchase Order',
        description: 'PurchaseOrders — visualizar Pedidos de Compra (OPOR) migrados.',
        apiRoute: '', deleteRoute: '', supabaseTable: '', orderBy: '',
        isDirectSap: true, sapEntity: 'PurchaseOrders'
    },
    {
        code: 'LCM',
        name: 'Lanç. Contábil. Man.',
        description: 'JournalEntries — visualizar Lançamentos Contábeis Manuais migrados.',
        apiRoute: '', deleteRoute: '', supabaseTable: '', orderBy: '',
        isDirectSap: true, sapEntity: 'JournalEntries'
    }
];

interface ProcessLog {
    table: string;
    status: 'pending' | 'processing' | 'success' | 'error';
    message: string;
    rowsCopied?: number;
}

interface TableMeta {
    total: number;
    totalPages: number;
}

// Colunas customizadas — Plano de Contas SAP
function buildSapCoAColDefs(keys: string[]): ColDef[] {
    return keys.map((key): ColDef => {
        const base: ColDef = { field: key, headerName: key.toUpperCase(), sortable: true, filter: true, resizable: true, minWidth: 90 };
        if (key === 'code') return { ...base, pinned: 'left', width: 150, cellStyle: { fontWeight: 700, fontFamily: 'monospace' } };
        if (key === 'name') return { ...base, flex: 2, minWidth: 220 };
        if (key === 'account_type') {
            return {
                ...base, width: 120,
                cellRenderer: (p: ICellRendererParams) => {
                    const map: Record<string, string> = { R: 'Receita', E: 'Despesa', A: 'Ativo', L: 'Passivo', O: 'PL', N: 'Neutro' };
                    const label = map[p.value] ?? p.value ?? '—';
                    const colors: Record<string, string> = { R: 'rgba(16,185,129,0.15)', E: 'rgba(239,68,68,0.15)', A: 'rgba(59,130,246,0.15)', L: 'rgba(245,158,11,0.15)' };
                    return <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700, backgroundColor: colors[p.value] || 'rgba(100,100,100,0.1)' }}>{label}</span>;
                }
            };
        }
        if (key === 'father_account') return { ...base, width: 150, cellStyle: { fontFamily: 'monospace', fontSize: '0.85rem', color: 'var(--secondary)' } };
        if (key === 'balance') return { ...base, width: 140, cellRenderer: (p: ICellRendererParams) => p.value != null ? Number(p.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—' };
        if (key === 'imported_at' || key === 'updated_at') return { ...base, width: 160, cellRenderer: (p: ICellRendererParams) => p.value ? new Date(p.value).toLocaleString('pt-BR') : '—' };
        return { ...base, flex: 1 };
    });
}

// Colunas customizadas — Centros de Custo SAP
function buildSapCcColDefs(keys: string[]): ColDef[] {
    return keys.map((key): ColDef => {
        const base: ColDef = { field: key, headerName: key.toUpperCase(), sortable: true, filter: true, resizable: true, minWidth: 90 };
        if (key === 'code') return { ...base, pinned: 'left', width: 160, cellStyle: { fontWeight: 700, fontFamily: 'monospace' } };
        if (key === 'name') return { ...base, flex: 2, minWidth: 220 };
        if (key === 'imported_at' || key === 'updated_at') return { ...base, width: 160, cellRenderer: (p: ICellRendererParams) => p.value ? new Date(p.value).toLocaleString('pt-BR') : '—' };
        return { ...base, flex: 1 };
    });
}

// Colunas customizadas — Business Places (Filiais SAP)
function buildSapBpColDefs(keys: string[]): ColDef[] {
    const PRIORITY = ['bpl_id', 'bpl_name', 'alias_name', 'main_bpl', 'disabled', 'federal_tax_id', 'state', 'city', 'default_warehouse_id', 'default_tax_code', 'environment_type'];
    const SKIP = ['bpl_name_foreign', 'address_full', 'address_foreign', 'ie_numbers', 'tributary_infos'];
    const others = keys.filter(k => !PRIORITY.includes(k) && !SKIP.includes(k));
    const skipped = keys.filter(k => SKIP.includes(k));
    const ordered = [...PRIORITY.filter(k => keys.includes(k)), ...others, ...skipped];

    return ordered.map((key): ColDef => {
        const base: ColDef = { field: key, headerName: key.toUpperCase(), sortable: true, filter: true, resizable: true, minWidth: 90 };

        if (key === 'bpl_id') return {
            ...base, pinned: 'left', width: 80, headerName: 'BPLID',
            cellStyle: { fontWeight: 700, fontFamily: 'monospace', textAlign: 'center' },
        };
        if (key === 'bpl_name') return { ...base, flex: 2, minWidth: 220, headerName: 'NOME' };
        if (key === 'alias_name') return { ...base, width: 160, headerName: 'ALIAS' };

        if (key === 'main_bpl') return {
            ...base, width: 90, headerName: 'MATRIZ',
            cellRenderer: (p: ICellRendererParams) => p.value
                ? <span style={{ padding: '2px 10px', borderRadius: 99, fontSize: '0.72rem', fontWeight: 700, backgroundColor: 'rgba(16,185,129,0.15)', color: '#10b981' }}>★ Sim</span>
                : <span style={{ color: 'var(--secondary)', fontSize: '0.78rem' }}>—</span>,
        };
        if (key === 'disabled') return {
            ...base, width: 90, headerName: 'STATUS',
            cellRenderer: (p: ICellRendererParams) => p.value
                ? <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, backgroundColor: 'rgba(239,68,68,0.15)', color: 'var(--error)' }}>Inativa</span>
                : <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, backgroundColor: 'rgba(16,185,129,0.12)', color: '#10b981' }}>Ativa</span>,
        };
        if (key === 'federal_tax_id') return {
            ...base, width: 160, headerName: 'CNPJ',
            cellStyle: { fontFamily: 'monospace', fontSize: '0.85rem' },
            cellRenderer: (p: ICellRendererParams) => {
                if (!p.value) return <span style={{ color: 'var(--secondary)' }}>—</span>;
                const v = String(p.value).replace(/\D/g, '');
                if (v.length === 14) return `${v.slice(0, 2)}.${v.slice(2, 5)}.${v.slice(5, 8)}/${v.slice(8, 12)}-${v.slice(12)}`;
                return p.value;
            },
        };
        if (key === 'environment_type') return {
            ...base, width: 120, headerName: 'AMBIENTE',
            cellRenderer: (p: ICellRendererParams) => {
                if (p.value === 1) return <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, backgroundColor: 'rgba(239,68,68,0.12)', color: 'var(--error)' }}>Produção</span>;
                if (p.value === 2) return <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, backgroundColor: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>Homologação</span>;
                return <span style={{ color: 'var(--secondary)' }}>—</span>;
            },
        };
        if (key === 'default_warehouse_id') return { ...base, width: 100, headerName: 'DEPÓSITO', cellStyle: { fontFamily: 'monospace', fontWeight: 600 } };
        if (key === 'default_tax_code') return { ...base, width: 110, headerName: 'COD. FISCAL', cellStyle: { fontFamily: 'monospace' } };
        if (key === 'state') return { ...base, width: 70, headerName: 'UF' };
        if (key === 'city') return { ...base, width: 160, headerName: 'CIDADE' };
        if (key === 'zip_code') return { ...base, width: 110, headerName: 'CEP', cellStyle: { fontFamily: 'monospace' } };
        if (key === 'federal_tax_id2') return { ...base, width: 130, headerName: 'IE', cellStyle: { fontFamily: 'monospace', fontSize: '0.82rem' } };
        if (key === 'ie_numbers' || key === 'tributary_infos') return {
            ...base, width: 120, headerName: key === 'ie_numbers' ? 'IE NÚMEROS' : 'INF. TRIB.',
            cellRenderer: (p: ICellRendererParams) => {
                const arr = Array.isArray(p.value) ? p.value : [];
                return arr.length > 0
                    ? <span style={{ fontSize: '0.75rem', color: 'var(--secondary)' }}>{arr.length} item(s)</span>
                    : <span style={{ color: 'var(--secondary)' }}>—</span>;
            },
        };
        if (key === 'imported_at' || key === 'updated_at') return {
            ...base, width: 160,
            cellRenderer: (p: ICellRendererParams) => p.value ? new Date(p.value).toLocaleString('pt-BR') : '—',
        };
        if (key === 'main_bpl' || typeof key === 'boolean') return { ...base, width: 90 };
        return { ...base, flex: 1, minWidth: 110 };
    });
}

// Colunas customizadas — Períodos Contábeis SAP (OFPR)
function buildSapCdpColDefs(keys: string[]): ColDef[] {
    const fmtDate = (v: string | null) => {
        if (!v) return '—';
        try { return new Date(v).toLocaleDateString('pt-BR'); } catch { return v; }
    };
    return keys.map((key): ColDef => {
        const base: ColDef = { field: key, headerName: key.toUpperCase(), sortable: true, filter: true, resizable: true, minWidth: 90 };
        if (key === 'abs_entry') return { ...base, pinned: 'left', width: 90, headerName: 'ID', cellStyle: { fontWeight: 700, fontFamily: 'monospace', textAlign: 'center' } };
        if (key === 'name') return {
            ...base, pinned: 'left', width: 110, headerName: 'PERÍODO',
            cellRenderer: (p: ICellRendererParams) => (
                <span style={{
                    padding: '2px 10px', borderRadius: 99, fontSize: '0.8rem', fontWeight: 700,
                    fontFamily: 'monospace', backgroundColor: 'rgba(59,130,246,0.12)', color: 'var(--primary)',
                }}>{p.value}</span>
            ),
        };
        if (key === 'f_ref_date') return { ...base, width: 130, headerName: 'INÍCIO LANÇAM.', cellRenderer: (p: ICellRendererParams) => fmtDate(p.value) };
        if (key === 't_ref_date') return { ...base, width: 130, headerName: 'FIM LANÇAM.', cellRenderer: (p: ICellRendererParams) => fmtDate(p.value) };
        if (key === 'f_due_date') return { ...base, width: 130, headerName: 'INÍCIO VENCIM.', cellRenderer: (p: ICellRendererParams) => fmtDate(p.value) };
        if (key === 't_due_date') return {
            ...base, width: 130, headerName: 'FIM VENCIM.',
            cellRenderer: (p: ICellRendererParams) => {
                if (!p.value) return <span style={{ color: 'var(--secondary)' }}>Aberto</span>;
                return <span style={{ color: 'var(--secondary)' }}>{fmtDate(p.value)}</span>;
            },
        };
        if (key === 'indicator') return {
            ...base, width: 110, headerName: 'INDICADOR',
            cellRenderer: (p: ICellRendererParams) => p.value
                ? <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700, backgroundColor: 'rgba(16,185,129,0.12)', color: '#10b981' }}>{p.value}</span>
                : <span style={{ color: 'var(--secondary)' }}>—</span>,
        };
        if (key === 'imported_at') return { ...base, width: 160, cellRenderer: (p: ICellRendererParams) => p.value ? new Date(p.value).toLocaleString('pt-BR') : '—' };
        return { ...base, flex: 1 };
    });
}

function buildGenericColDefs(keys: string[]): ColDef[] {
    return keys.map((key): ColDef => ({
        field: key,
        headerName: key.toUpperCase(),
        sortable: true,
        filter: true,
        resizable: true,
        flex: 1,
        minWidth: 100,
    }));
}

export default function SapReferencePage() {
    const [selectedTable, setSelectedTable] = useState<SapTable | null>(null);
    const [importingSap, setImportingSap] = useState(false);
    
    // Grid e paginação
    const [page, setPage] = useState(1);
    const [limit] = useState(100);
    const [data, setData] = useState<any[]>([]);
    const [meta, setMeta] = useState<TableMeta | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [error, setError] = useState<string | null>(null);

    const columnDefs = useMemo<ColDef[]>(() => {
        if (!data || data.length === 0) return [];
        const keys = Object.keys(data[0]);
        if (selectedTable?.code === 'CoA') return buildSapCoAColDefs(keys);
        if (selectedTable?.code === 'CC') return buildSapCcColDefs(keys);
        if (selectedTable?.code === 'BP') return buildSapBpColDefs(keys);
        if (selectedTable?.code === 'CDP') return buildSapCdpColDefs(keys);
        return buildGenericColDefs(keys);
    }, [data, selectedTable]);

    const fetchTableData = async (tableDef: SapTable, p: number = 1, searchTerm = '') => {
        setIsLoading(true);
        setSelectedTable(tableDef);
        setPage(p);
        setError(null);

        try {
            let res;
            if (tableDef.isDirectSap) {
                const skip = (p - 1) * limit;
                res = await fetch(`/api/sap/query?entity=${tableDef.sapEntity}&limit=${limit}&skip=${skip}`);
            } else {
                const params = new URLSearchParams({
                    table: tableDef.supabaseTable,
                    page: String(p),
                    limit: String(limit),
                    orderBy: tableDef.orderBy || 'code',
                    ...(searchTerm ? { search: searchTerm } : {}),
                });
                res = await fetch(`/api/data?${params}`);
            }

            const result = await res.json();
            if (result.success) {
                setData(result.data || []);
                setMeta(result.meta || { total: result.data?.length || 0, totalPages: 1 });
            } else {
                setError(result.message);
                setData([]);
            }
        } catch (err: any) {
            setError(err.message);
            setData([]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedTable) return;
        setSearch(searchInput);
        fetchTableData(selectedTable, 1, searchInput);
    };

    const clearSearch = () => {
        setSearchInput('');
        setSearch('');
        if (selectedTable) fetchTableData(selectedTable, 1, '');
    };

    const importSapTable = async (sapTable: SapTable) => {
        setImportingSap(true);
        try {
            const { code, apiRoute } = sapTable;
            const isBusinessPlaces = code === 'BP';

            const initRes = await fetch(apiRoute, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: isBusinessPlaces ? undefined : JSON.stringify({ action: 'init' }),
            });
            const initData = await initRes.json();
            if (!initData.success) throw new Error(initData.message);
            alert('Importação concluída com sucesso!');
            fetchTableData(sapTable, 1, search);
        } catch (e: any) {
            alert('Erro na importação: ' + e.message);
        } finally {
            setImportingSap(false);
        }
    };

    const handleClearSap = async (sapTable: SapTable) => {
        if (!confirm(`Apagar todos os registros de "${sapTable.name}"?`)) return;
        setImportingSap(true);
        try {
            await fetch(sapTable.deleteRoute, { method: 'DELETE' });
            fetchTableData(sapTable, 1, search);
        } catch(e: any) {
            alert('Erro ao apagar registros: ' + e.message);
        } finally {
            setImportingSap(false);
        }
    };

    return (
        <div className="container" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)' }}>
            <div>
                <h1 className="page-title">Conferência de Dados Migrados</h1>
            </div>

            <div className="card" style={{ marginBottom: '1rem' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#10b981', marginRight: '0.5rem' }}>Tabelas de Referência SAP B1</span>
                <div style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                    {SAP_TABLES.map(t => {
                        const isActive = selectedTable?.code === t.code;
                        return (
                            <button key={t.code} onClick={() => fetchTableData(t, 1, '')} style={{
                                display: 'flex', alignItems: 'center', gap: '0.35rem',
                                padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.82rem',
                                fontWeight: isActive ? 700 : 500, cursor: 'pointer',
                                border: `1px solid ${isActive ? '#10b981' : 'var(--card-border)'}`,
                                backgroundColor: isActive ? 'rgba(16,185,129,0.1)' : 'var(--background)',
                                color: isActive ? '#10b981' : 'var(--secondary)', transition: 'all 0.15s',
                            }}>
                                <Server size={12} />
                                <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{t.code}</span>
                                <span style={{ fontSize: '0.75rem', opacity: 0.75 }}>{t.name}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {isLoading ? (
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                    <Loader2 className="animate-spin" size={32} style={{ color: 'var(--primary)' }} />
                </div>
            ) : selectedTable ? (
                <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
                    {/* Toolbar */}
                    <div style={{
                        padding: '0.75rem 1rem',
                        borderBottom: '1px solid var(--card-border)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '1rem',
                        flexWrap: 'wrap',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <h2 style={{ fontSize: '1rem', fontWeight: 700, fontFamily: 'monospace' }}>
                                {selectedTable.code}
                            </h2>
                            <span style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>
                                — {selectedTable.name}
                            </span>
                            <span style={{
                                backgroundColor: 'rgba(59,130,246,0.1)',
                                color: 'var(--primary)',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '0.78rem',
                                fontWeight: 600,
                            }}>
                                {meta?.total?.toLocaleString('pt-BR') ?? 0} registros
                            </span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {/* Buttons only for non-direct SAP tables because direct SAP doesn't use Supabase reference table DB */}
                            {!selectedTable.isDirectSap && (
                                <div style={{ display: 'flex', gap: '0.75rem' }}>
                                    <button onClick={() => importSapTable(selectedTable)} disabled={importingSap} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 1rem' }}>
                                        {importingSap ? <Loader2 size={16} className="spin" /> : <Server size={16} />} 
                                        {importingSap ? 'Sincronizando...' : 'Sincronizar Supabase'}
                                    </button>
                                    <button onClick={() => handleClearSap(selectedTable)} disabled={importingSap} className="btn" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', border: '1px solid rgba(239, 68, 68, 0.3)', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 1rem' }}>
                                        <Trash2 size={16} /> Apagar Ref.
                                    </button>
                                </div>
                            )}
                            
                            <div style={{ width: '1px', height: '20px', backgroundColor: 'var(--card-border)', margin: '0 0.5rem' }} />

                            <form onSubmit={handleSearch} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <div style={{
                                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                                    backgroundColor: 'var(--background)',
                                    border: '1px solid var(--card-border)',
                                    borderRadius: '6px', padding: '0.3rem 0.6rem',
                                }}>
                                    <Search size={14} style={{ color: 'var(--secondary)' }} />
                                    <input
                                        value={searchInput}
                                        onChange={e => setSearchInput(e.target.value)}
                                        placeholder="Buscar..."
                                        style={{
                                            background: 'transparent', border: 'none', outline: 'none',
                                            color: 'var(--foreground)', fontSize: '0.85rem', width: '160px',
                                        }}
                                    />
                                </div>
                                <button type="submit" className="btn btn-secondary" style={{ padding: '0.35rem 0.7rem', fontSize: '0.82rem' }}>
                                    Buscar
                                </button>
                                {search && (
                                    <button type="button" onClick={clearSearch} style={{
                                        background: 'none', border: 'none', cursor: 'pointer',
                                        color: 'var(--secondary)', display: 'flex', alignItems: 'center',
                                    }}>
                                        <X size={15} />
                                    </button>
                                )}
                            </form>

                            <button
                                className="btn btn-secondary"
                                style={{ padding: '0.35rem 0.6rem' }}
                                disabled={page <= 1}
                                onClick={() => fetchTableData(selectedTable, page - 1, search)}
                            >
                                <ArrowLeft size={16} />
                            </button>
                            <span style={{ fontSize: '0.82rem', color: 'var(--secondary)', whiteSpace: 'nowrap' }}>
                                {page} / {meta?.totalPages ?? 1}
                            </span>
                            <button
                                className="btn btn-secondary"
                                style={{ padding: '0.35rem 0.6rem' }}
                                disabled={page >= (meta?.totalPages || 1)}
                                onClick={() => fetchTableData(selectedTable, page + 1, search)}
                            >
                                <ArrowRight size={16} />
                            </button>
                        </div>
                    </div>

                    {error && (
                        <div style={{
                            padding: '0.75rem 1rem',
                            backgroundColor: 'rgba(239,68,68,0.1)',
                            color: 'var(--error)',
                            borderBottom: '1px solid var(--card-border)',
                            fontSize: '0.875rem',
                        }}>
                            ⚠ {error}
                        </div>
                    )}

                    {/* AG Grid */}
                    <div className="ag-theme-quartz-dark" style={{ flex: 1, width: '100%' }}>
                        <AgGridReact
                            theme="legacy"
                            rowData={data}
                            columnDefs={columnDefs}
                            defaultColDef={{
                                sortable: true,
                                filter: true,
                                resizable: true,
                            }}
                            rowHeight={40}
                            headerHeight={42}
                            pagination={false}
                            animateRows
                            noRowsOverlayComponent={() => (
                                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--secondary)' }}>
                                    {error ? 'Erro ao carregar dados.' : 'Nenhum registro encontrado. Clique em Importar SAP B1 para atualizar a tabela local.'}
                                </div>
                            )}
                        />
                    </div>
                </div>
            ) : (
                <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--secondary)' }}>
                    <p style={{ fontSize: '1rem' }}>Selecione uma tabela acima para visualizar os dados migrados e sincronizar configurações do SAP.</p>
                </div>
            )}
        </div>
    );
}
