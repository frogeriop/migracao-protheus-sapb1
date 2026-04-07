'use client';

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Loader2, ArrowRight, ArrowLeft, Search, X, BookOpen, Server, Link2, CheckCircle2, Sparkles, AlertCircle } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { AgGridReact } from 'ag-grid-react';
import {
    ColDef,
    ModuleRegistry,
    AllCommunityModule,
    ICellRendererParams,
    FilterChangedEvent,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

interface TableMeta {
    total: number;
    totalPages: number;
    columnFiltersApplied?: boolean;
}

interface TableDef {
    code: string;
    name: string;
    supabaseTable: string;
    orderBy?: string;
    isCustom?: boolean;
    group?: 'protheus' | 'sap' | 'excel'; // agrupamento visual
}

const AVAILABLE_TABLES: TableDef[] = [
    // ── TOTVS Protheus ──────────────────────────────────────────────────────
    { code: 'SA1010', name: 'Clientes', supabaseTable: 'sa1010', orderBy: 'r_e_c_n_o_', group: 'protheus' },
    { code: 'SA2010', name: 'Fornecedores', supabaseTable: 'sa2010', orderBy: 'r_e_c_n_o_', group: 'protheus' },
    { code: 'SB1010', name: 'Produtos', supabaseTable: 'sb1010', orderBy: 'r_e_c_n_o_', group: 'protheus' },
    { code: 'SE1010', name: 'Contas a Receber', supabaseTable: 'se1010', orderBy: 'r_e_c_n_o_', group: 'protheus' },
    { code: 'SE2010', name: 'Contas a Pagar', supabaseTable: 'se2010', orderBy: 'r_e_c_n_o_', group: 'protheus' },
    { code: 'SU5010', name: 'Contatos (cliente)', supabaseTable: 'su5010', orderBy: 'r_e_c_n_o_', group: 'protheus' },
    { code: 'SED010', name: 'Naturezas de Lançamento', supabaseTable: 'sed010', orderBy: 'ed_codigo', group: 'protheus', isCustom: true },
    // ── Excel ───────────────────────────────────────────────────────────────
    // Entidades do Excel serão carregadas dinamicamente
];

// Tipos
interface SapAccount {
    code: string;
    name: string;
    account_type?: string;
    father_account?: string;
}

interface AutoMapSuggestion {
    ed_codigo: string;
    ed_filial: string;
    ed_descric: string;
    ed_debcred: string;
    current_account: string | null;
    suggested_code: string;
    suggested_name: string;
    suggested_type: string;
    confidence: number; // 0-100
}

// Colunas com renderizadores especiais para a SED010
function buildSed010ColDefs(keys: string[], onLinkClick: (row: any) => void): ColDef[] {
    // Garante que sap_account_name apareça logo após sap_account_code na ordem das colunas
    const PRIORITY_ORDER = ['ed_codigo', 'ed_descric', 'ed_tipo', 'ed_grupo', 'ed_debcred', 'ed_cond', 'ed_conta'];
    const PINNED_RIGHT = ['sap_account_code', 'sap_account_name'];
    const others = keys.filter(k => !PRIORITY_ORDER.includes(k) && !PINNED_RIGHT.includes(k));
    const orderedKeys = [
        ...PRIORITY_ORDER.filter(k => keys.includes(k)),
        ...others,
        ...PINNED_RIGHT.filter(k => keys.includes(k)),
    ];

    return orderedKeys.map((key): ColDef => {
        const base: ColDef = {
            field: key,
            headerName: key.toUpperCase(),
            sortable: true,
            filter: true,
            resizable: true,
            minWidth: 90,
        };

        if (key === 'ed_codigo') {
            return { ...base, pinned: 'left', width: 110, cellStyle: { fontWeight: 700, fontFamily: 'monospace' } };
        }
        if (key === 'ed_descric') {
            return { ...base, flex: 2, minWidth: 180 };
        }
        if (key === 'ed_debcred') {
            return {
                ...base, width: 80,
                cellRenderer: (p: ICellRendererParams) => {
                    const v = (p.value || '').trim();
                    if (!v) return null;
                    const isC = v === 'C';
                    return (
                        <span style={{
                            padding: '2px 8px', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700,
                            backgroundColor: isC ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                            color: isC ? 'var(--success)' : 'var(--error)',
                        }}>{v}</span>
                    );
                }
            };
        }
        if (key === 'sap_account_code') {
            return {
                ...base, pinned: 'right', width: 165, headerName: '🔗 CONTA SAP B1',
                cellRenderer: (p: ICellRendererParams) => (
                    <div
                        onClick={() => onLinkClick(p.data)}
                        title="Clique para vincular conta SAP B1"
                        style={{
                            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem',
                            height: '100%', padding: '0 4px',
                        }}
                    >
                        {p.value
                            ? <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: '0.8rem', fontWeight: 700, fontFamily: 'monospace', backgroundColor: 'rgba(59,130,246,0.15)', color: 'var(--primary)' }}>{p.value}</span>
                            : <span style={{ color: 'var(--secondary)', fontStyle: 'italic', fontSize: '0.8rem' }}>Não mapeado</span>
                        }
                        <Link2 size={12} style={{ color: 'var(--secondary)', flexShrink: 0, marginLeft: 'auto' }} />
                    </div>
                ),
            };
        }
        if (key === 'sap_account_name') {
            return {
                ...base,
                headerName: '📄 DESCRIÇÃO SAP',
                pinned: 'right',
                flex: 1,
                minWidth: 190,
                cellRenderer: (p: ICellRendererParams) => {
                    if (!p.value) {
                        return <span style={{ color: 'var(--secondary)', fontStyle: 'italic', fontSize: '0.78rem', opacity: 0.4 }}>—</span>;
                    }
                    return (
                        <span style={{
                            fontSize: '0.82rem',
                            fontStyle: 'italic',
                            color: 'rgba(167,139,250,0.85)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            display: 'block',
                        }} title={p.value}>
                            {p.value}
                        </span>
                    );
                }
            };
        }
        if (key === 'ed_conta') {
            return { ...base, width: 140, cellStyle: { fontFamily: 'monospace', fontSize: '0.85rem' } };
        }
        if (key === 'imported_at' || key === 'updated_at') {
            return { ...base, width: 160, cellRenderer: (p: ICellRendererParams) => p.value ? new Date(p.value).toLocaleString('pt-BR') : '—' };
        }
        return { ...base, flex: 1, minWidth: 100 };
    });
}


// Colunas genéricas para as outras tabelas
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



interface ApplyProgress {
    total: number;
    done: number;
    errors: number;
    log: { code: string; name: string; account: string; ok: boolean; msg?: string }[];
}

interface SapAccount { code: string; name: string; }

export default function DataViewerPage() {
    const { config, loading } = useConfig();
    const [selectedTable, setSelectedTable] = useState<TableDef | null>(null);
    // ── Modal: vincular conta SAP B1 ───────────────────────────────────────
    const [modalRow, setModalRow] = useState<any | null>(null);
    const [sapAccounts, setSapAccounts] = useState<SapAccount[]>([]);
    const [sapSearch, setSapSearch] = useState('');
    const [sapLoading, setSapLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'protheus' | 'excel'>('protheus');
    const [excelEntities, setExcelEntities] = useState<any[]>([]);

    const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
    const columnFilterDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gridRef = useRef<AgGridReact>(null);

    useEffect(() => {
        return () => {
            if (columnFilterDebounce.current) clearTimeout(columnFilterDebounce.current);
        };
    }, []);

    useEffect(() => {
        if (!loading) {
            fetch('/api/migration/entities')
                .then(res => res.json())
                .then(data => {
                    if (data.success && data.data) {
                        const linked = data.data.filter((e: any) => e.source_file_path);
                        setExcelEntities(linked);
                    }
                })
                .catch(console.error);
        }
    }, [loading]);

    const openLinkModal = useCallback(async (row: any) => {
        setModalRow(row);
        setSapSearch('');
        setSaveMsg(null);
        setSapLoading(true);
        try {
            const res = await fetch('/api/naturezas/mapping?search=');
            const result = await res.json();
            if (result.success) setSapAccounts(result.data);
        } finally { setSapLoading(false); }
    }, []);

    const searchSapAccounts = async (q: string) => {
        setSapSearch(q);
        if (searchTimeout.current) clearTimeout(searchTimeout.current);
        searchTimeout.current = setTimeout(async () => {
            setSapLoading(true);
            try {
                const res = await fetch(`/api/naturezas/mapping?search=${encodeURIComponent(q)}`);
                const result = await res.json();
                if (result.success) setSapAccounts(result.data);
            } finally { setSapLoading(false); }
        }, 300);
    };

    const linkAccount = async (account: SapAccount | null) => {
        if (!modalRow) return;
        setSaving(true);
        try {
            const res = await fetch('/api/naturezas/mapping', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ed_codigo: modalRow.ed_codigo,
                    ed_filial: modalRow.ed_filial,
                    sap_account_code: account?.code ?? null,
                    sap_account_name: account?.name ?? null,
                }),
            });
            const result = await res.json();
            if (!result.success) throw new Error(result.message);
            setData(prev => prev.map(r =>
                r.ed_codigo === modalRow.ed_codigo && r.ed_filial === modalRow.ed_filial
                    ? { ...r, sap_account_code: account?.code ?? null, sap_account_name: account?.name ?? null }
                    : r
            ));
            setSaveMsg(account ? `✅ ${account.code} — ${account.name}` : '✅ Mapeamento removido');
            setTimeout(() => { setModalRow(null); setSaveMsg(null); }, 1200);
        } catch (e: any) {
            setSaveMsg('❌ ' + e.message);
        } finally { setSaving(false); }
    };

    // ── Auto-mapeamento inteligente ─────────────────────────────────────
    const [autoMapOpen, setAutoMapOpen] = useState(false);
    const [autoMapLoading, setAutoMapLoading] = useState(false);
    const [autoMapSuggestions, setAutoMapSuggestions] = useState<AutoMapSuggestion[]>([]);
    const [autoMapSelected, setAutoMapSelected] = useState<Set<string>>(new Set());
    const [autoMapSaving, setAutoMapSaving] = useState(false);
    const [autoMapMsg, setAutoMapMsg] = useState<string | null>(null);
    const [autoMapOnlyUnmapped, setAutoMapOnlyUnmapped] = useState(true);

    const [applyProgress, setApplyProgress] = useState<ApplyProgress | null>(null);

    const runAutoMap = async (onlyUnmapped: boolean) => {
        setAutoMapLoading(true);
        setAutoMapMsg(null);
        setAutoMapSuggestions([]);
        try {
            const res = await fetch(`/api/naturezas/auto-map?onlyUnmapped=${onlyUnmapped}`);
            const result = await res.json();
            if (!result.success) throw new Error(result.message);
            setAutoMapSuggestions(result.suggestions);
            // Pre-seleciona tudo
            setAutoMapSelected(new Set(result.suggestions.map((s: AutoMapSuggestion) => s.ed_codigo + '|' + s.ed_filial)));
            if (result.suggestions.length === 0) setAutoMapMsg('ℹ️ Nenhuma sugestão encontrada com confiança suficiente.');
        } catch (e: any) {
            setAutoMapMsg('❌ ' + e.message);
        } finally {
            setAutoMapLoading(false);
        }
    };

    const applyAutoMap = async () => {
        const toSave = autoMapSuggestions
            .filter(s => autoMapSelected.has(s.ed_codigo + '|' + s.ed_filial));

        if (toSave.length === 0) return;

        setAutoMapSaving(true);
        setAutoMapMsg(null);

        // Inicia o painel de progresso
        const progress: ApplyProgress = { total: toSave.length, done: 0, errors: 0, log: [] };
        setApplyProgress({ ...progress });

        const updatedInGrid: { ed_codigo: string; ed_filial: string; sap_account_code: string; sap_account_name: string }[] = [];

        for (const s of toSave) {
            try {
                const res = await fetch('/api/naturezas/mapping', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ed_codigo: s.ed_codigo,
                        ed_filial: s.ed_filial,
                        sap_account_code: s.suggested_code,
                        sap_account_name: s.suggested_name,
                    }),
                });
                const result = await res.json();
                if (!result.success) throw new Error(result.message);

                updatedInGrid.push({
                    ed_codigo: s.ed_codigo,
                    ed_filial: s.ed_filial,
                    sap_account_code: s.suggested_code,
                    sap_account_name: s.suggested_name,
                });

                progress.done++;
                progress.log = [
                    { code: s.ed_codigo, name: s.ed_descric, account: s.suggested_code, ok: true },
                    ...progress.log,
                ].slice(0, 60); // mantém últimas 60 entradas
            } catch (e: any) {
                progress.errors++;
                progress.log = [
                    { code: s.ed_codigo, name: s.ed_descric, account: s.suggested_code, ok: false, msg: e.message },
                    ...progress.log,
                ].slice(0, 60);
            }
            // Atualiza estado a cada item
            setApplyProgress({ ...progress });
        }

        // Atualiza o grid com todos os registros aplicados
        if (updatedInGrid.length > 0) {
            setData(prev => prev.map(r => {
                const m = updatedInGrid.find(t => t.ed_codigo === r.ed_codigo && t.ed_filial === r.ed_filial);
                return m ? { ...r, sap_account_code: m.sap_account_code, sap_account_name: m.sap_account_name } : r;
            }));
        }

        const successCount = progress.done;
        const errCount = progress.errors;
        setAutoMapMsg(
            errCount === 0
                ? `✅ ${successCount} mapeamento${successCount !== 1 ? 's' : ''} gravado${successCount !== 1 ? 's' : ''} com sucesso!`
                : `⚠️ ${successCount} gravados, ${errCount} erro${errCount !== 1 ? 's' : ''}.`
        );
        setAutoMapSaving(false);
    };

    const [page, setPage] = useState(1);
    const [limit] = useState(100);
    const [data, setData] = useState<any[]>([]);
    const [meta, setMeta] = useState<TableMeta | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [error, setError] = useState<string | null>(null);
    /** Modelo AG Grid enviado ao servidor (filtro em tabela inteira). */
    const [columnFilterModel, setColumnFilterModel] = useState<Record<string, unknown> | null>(null);

    const columnDefs = useMemo<ColDef[]>(() => {
        if (!data || data.length === 0) return [];
        const keys = Object.keys(data[0]);
        if (selectedTable?.code === 'SED010') return buildSed010ColDefs(keys, openLinkModal);
        return buildGenericColDefs(keys);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [data, selectedTable, openLinkModal]);


    const fetchTableData = useCallback(
        async (
            tableDef: TableDef,
            p: number = 1,
            searchTerm = '',
            columnFilters?: Record<string, unknown> | null
        ) => {
            setIsLoading(true);
            const switchingTable =
                !selectedTable || selectedTable.supabaseTable !== tableDef.supabaseTable;
            setSelectedTable(tableDef);
            setPage(p);
            setError(null);

            const effectiveFilters =
                switchingTable && columnFilters === undefined
                    ? null
                    : columnFilters !== undefined
                      ? columnFilters
                      : columnFilterModel;

            if (columnFilters !== undefined || switchingTable) {
                setColumnFilterModel(
                    effectiveFilters && Object.keys(effectiveFilters).length > 0
                        ? effectiveFilters
                        : null
                );
            }

            try {
                const params = new URLSearchParams({
                    table: tableDef.supabaseTable,
                    page: String(p),
                    limit: String(limit),
                    orderBy: tableDef.orderBy || (tableDef.group === 'excel' ? 'id' : 'r_e_c_n_o_'),
                    ...(searchTerm ? { search: searchTerm } : {}),
                });
                if (effectiveFilters && Object.keys(effectiveFilters).length > 0) {
                    params.set('columnFilters', JSON.stringify(effectiveFilters));
                }
                const res = await fetch(`/api/data?${params}`);
                const result = await res.json();
                if (result.success) {
                    setData(result.data || []);
                    setMeta(result.meta);
                } else {
                    setError(result.message);
                    setData([]);
                }
            } catch (err: unknown) {
                setError(err instanceof Error ? err.message : String(err));
                setData([]);
            } finally {
                setIsLoading(false);
            }
        },
        [selectedTable, columnFilterModel, limit]
    );

    /** Servidor aplica WHERE; ignoramos eventos da API e reavaliação pós-dados para não refetch em loop. O filtro de coluna do AG Grid continua alinhado ao default "contains" + meta da API. */
    const onFilterChanged = useCallback(
        (event: FilterChangedEvent) => {
            if (event.source === 'api') return;
            if (event.afterDataChange) return;
            if (!selectedTable) return;
            if (columnFilterDebounce.current) clearTimeout(columnFilterDebounce.current);
            columnFilterDebounce.current = setTimeout(() => {
                const api = event.api;
                const model = api.getFilterModel() as Record<string, unknown> | null;
                const normalized = model && Object.keys(model).length > 0 ? model : null;
                fetchTableData(selectedTable, 1, search, normalized);
            }, 400);
        },
        [selectedTable, search, fetchTableData]
    );

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

    if (loading) return <div>Carregando...</div>;

    return (
        <div className="container" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)' }}>
            <h1 className="page-title">Conferência de Dados Importados (Staging)</h1>

            <div className="card" style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', gap: '2rem', borderBottom: '1px solid var(--card-border)', marginBottom: '1rem' }}>
                    <button
                        onClick={() => {
                            setActiveTab('protheus');
                            setSelectedTable(null);
                            setData([]);
                            setColumnFilterModel(null);
                        }}
                        style={{
                            padding: '0.8rem 0.5rem', background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: '0.9rem', fontWeight: activeTab === 'protheus' ? 700 : 500,
                            color: activeTab === 'protheus' ? 'var(--primary)' : 'var(--secondary)',
                            borderBottom: activeTab === 'protheus' ? '2px solid var(--primary)' : '2px solid transparent',
                        }}
                    >
                        Origem: TOTVS Protheus
                    </button>
                    <button
                        onClick={() => {
                            setActiveTab('excel');
                            setSelectedTable(null);
                            setData([]);
                            setColumnFilterModel(null);
                        }}
                        style={{
                            padding: '0.8rem 0.5rem', background: 'none', border: 'none', cursor: 'pointer',
                            fontSize: '0.9rem', fontWeight: activeTab === 'excel' ? 700 : 500,
                            color: activeTab === 'excel' ? '#10b981' : 'var(--secondary)',
                            borderBottom: activeTab === 'excel' ? '2px solid #10b981' : '2px solid transparent',
                        }}
                    >
                        Origem: Planilha Excel
                    </button>
                </div>

                {activeTab === 'protheus' && (
                    <div style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {AVAILABLE_TABLES.filter(t => t.group === 'protheus').map(t => {
                            const isActive = selectedTable?.code === t.code;
                            const accent = t.isCustom ? '#8b5cf6' : 'var(--primary)';
                            return (
                                <button key={t.code} onClick={() => fetchTableData(t, 1, '')} style={{
                                    display: 'flex', alignItems: 'center', gap: '0.35rem',
                                    padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.82rem',
                                    fontWeight: isActive ? 700 : 500, cursor: 'pointer',
                                    border: `1px solid ${isActive ? accent : 'var(--card-border)'}`,
                                    backgroundColor: isActive ? (t.isCustom ? 'rgba(139,92,246,0.12)' : 'rgba(59,130,246,0.1)') : 'var(--background)',
                                    color: isActive ? accent : 'var(--secondary)', transition: 'all 0.15s',
                                }}>
                                    {t.isCustom && <BookOpen size={12} />}
                                    <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{t.code}</span>
                                    <span style={{ fontSize: '0.75rem', opacity: 0.75 }}>{t.name}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {activeTab === 'excel' && (
                    <div style={{ display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                        {excelEntities.length === 0 ? (
                            <span style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>Nenhuma planilha vinculada em Configurações.</span>
                        ) : (
                            excelEntities.map(t => {
                                const isActive = selectedTable?.code === t.name;
                                return (
                                    <button
                                        key={t.id}
                                        onClick={() => fetchTableData({
                                            code: t.name,
                                            name: t.target_object,
                                            supabaseTable: t.staging_table,
                                            group: 'excel' as any
                                        }, 1, '')}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '0.35rem',
                                            padding: '0.35rem 0.75rem', borderRadius: '6px', fontSize: '0.82rem',
                                            fontWeight: isActive ? 700 : 500, cursor: 'pointer',
                                            border: `1px solid ${isActive ? '#10b981' : 'var(--card-border)'}`,
                                            backgroundColor: isActive ? 'rgba(16,185,129,0.1)' : 'var(--background)',
                                            color: isActive ? '#10b981' : 'var(--secondary)', transition: 'all 0.15s',
                                        }}
                                    >
                                        <BookOpen size={12} />
                                        <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{t.name}</span>
                                        <span style={{ fontSize: '0.75rem', opacity: 0.75 }}>{t.target_object}</span>
                                    </button>
                                );
                            })
                        )}
                    </div>
                )}
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
                            {selectedTable.isCustom && <BookOpen size={18} style={{ color: '#8b5cf6' }} />}
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
                            {/* Busca — disponível para todas as tabelas */}
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

                            {/* Botão Mapeamento Inteligente — só para SED010 */}
                            {selectedTable.code === 'SED010' && (
                                <button
                                    onClick={() => { setAutoMapOpen(true); setAutoMapSuggestions([]); setAutoMapMsg(null); setApplyProgress(null); }}
                                    style={{
                                        display: 'flex', alignItems: 'center', gap: '0.4rem',
                                        padding: '0.35rem 0.85rem', borderRadius: '6px', fontSize: '0.82rem',
                                        fontWeight: 600, cursor: 'pointer', border: '1px solid rgba(139,92,246,0.4)',
                                        background: 'rgba(139,92,246,0.08)', color: '#a78bfa',
                                        transition: 'all 0.15s',
                                    }}
                                    onMouseEnter={e => { (e.currentTarget).style.background = 'rgba(139,92,246,0.18)'; }}
                                    onMouseLeave={e => { (e.currentTarget).style.background = 'rgba(139,92,246,0.08)'; }}
                                >
                                    <Sparkles size={14} />
                                    Mapeamento Inteligente
                                </button>
                            )}

                            {/* Paginação */}
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

                    {/* Erro */}
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
                            ref={gridRef}
                            key={`${selectedTable.supabaseTable}-${selectedTable.code}`}
                            theme="legacy"
                            rowData={data}
                            columnDefs={columnDefs}
                            defaultColDef={{
                                sortable: true,
                                filter: true,
                                resizable: true,
                                filterParams: {
                                    defaultOption: 'contains',
                                },
                            }}
                            rowHeight={40}
                            headerHeight={42}
                            pagination={false}
                            animateRows
                            onFilterChanged={onFilterChanged}
                            suppressCellFocus={selectedTable.code === 'SED010'}
                            noRowsOverlayComponent={() => (
                                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--secondary)' }}>
                                    {error ? 'Erro ao carregar dados.' : 'Nenhum registro encontrado.'}
                                </div>
                            )}
                        />
                    </div>
                </div>
            ) : (
                <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--secondary)' }}>
                    <p style={{ fontSize: '1rem' }}>Selecione uma tabela acima para visualizar os dados replicados.</p>
                </div>
            )}

            {/* ── MODAL: Vincular Conta SAP B1 ─────────────────────────────── */}
            {modalRow && (
                <div
                    onClick={() => setModalRow(null)}
                    style={{
                        position: 'fixed', inset: 0, zIndex: 1000,
                        backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    <div
                        onClick={e => e.stopPropagation()}
                        style={{
                            backgroundColor: 'var(--card-bg)', border: '1px solid var(--card-border)',
                            borderRadius: '12px', width: '560px', maxWidth: '95vw', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
                        }}
                    >
                        {/* Header */}
                        <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                                <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#10b981', marginBottom: '0.25rem' }}>Vincular Conta SAP B1</div>
                                <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                                    <span style={{ fontFamily: 'monospace', color: '#60a5fa' }}>{modalRow.ed_codigo}</span>
                                    {' — '}
                                    <span>{modalRow.ed_descric}</span>
                                </div>
                                {modalRow.sap_account_code && (
                                    <div style={{ fontSize: '0.78rem', color: 'var(--secondary)', marginTop: '0.2rem' }}>
                                        Atual: <span style={{ fontFamily: 'monospace', color: '#60a5fa' }}>{modalRow.sap_account_code}</span>
                                        {' '}{modalRow.sap_account_name}
                                    </div>
                                )}
                            </div>
                            <button onClick={() => setModalRow(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)', padding: 4 }}>
                                <X size={18} />
                            </button>
                        </div>

                        {/* Search */}
                        <div style={{ padding: '0.75rem 1.25rem', borderBottom: '1px solid var(--card-border)' }}>
                            <div style={{ position: 'relative' }}>
                                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--secondary)' }} />
                                <input
                                    autoFocus
                                    value={sapSearch}
                                    onChange={e => searchSapAccounts(e.target.value)}
                                    placeholder="Buscar por código ou nome da conta..."
                                    style={{
                                        width: '100%', padding: '0.5rem 0.75rem 0.5rem 2rem',
                                        backgroundColor: 'var(--background)', border: '1px solid var(--card-border)',
                                        borderRadius: '6px', color: 'var(--foreground)', fontSize: '0.85rem',
                                        outline: 'none', boxSizing: 'border-box',
                                    }}
                                />
                                {sapLoading && <Loader2 size={14} className="spinner" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--secondary)' }} />}
                            </div>
                        </div>

                        {/* Feedback */}
                        {saveMsg && (
                            <div style={{ margin: '0.5rem 1.25rem 0', padding: '0.5rem 0.75rem', borderRadius: 6, backgroundColor: saveMsg.startsWith('✅') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                                {saveMsg.startsWith('✅') && <CheckCircle2 size={14} style={{ color: '#10b981' }} />}
                                {saveMsg}
                            </div>
                        )}

                        {/* Lista de contas */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 0' }}>
                            {/* Opção: remover vínculo */}
                            {modalRow.sap_account_code && (
                                <button
                                    onClick={() => linkAccount(null)}
                                    disabled={saving}
                                    style={{
                                        display: 'flex', width: '100%', textAlign: 'left', padding: '0.6rem 1.25rem',
                                        background: 'none', border: 'none', cursor: 'pointer', gap: '0.75rem', alignItems: 'center',
                                        color: 'var(--error)', fontSize: '0.8rem', borderBottom: '1px solid var(--card-border)',
                                    }}
                                >
                                    <X size={13} /> Remover vínculo atual
                                </button>
                            )}

                            {sapAccounts.length === 0 && !sapLoading && (
                                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--secondary)', fontSize: '0.85rem' }}>
                                    {sapSearch ? 'Nenhuma conta encontrada.' : 'Nenhum registro importado em sap_chart_of_accounts.'}
                                </div>
                            )}

                            {sapAccounts.map(acc => {
                                const isSelected = acc.code === modalRow.sap_account_code;
                                const typeColors: Record<string, string> = { 
                                    'at_Revenues': '#10b981', // green
                                    'at_Expenses': '#ef4444', // red
                                    'at_Other': '#94a3b8'     // slate
                                };
                                const badgeColor = typeColors[acc.account_type || ''] || '#94a3b8';
                                const badgeBg = badgeColor + '22';
                                
                                return (
                                    <button
                                        key={acc.code}
                                        onClick={() => linkAccount(acc)}
                                        disabled={saving}
                                        style={{
                                            display: 'flex', width: '100%', textAlign: 'left', padding: '0.6rem 1.25rem',
                                            background: isSelected ? 'rgba(59,130,246,0.08)' : 'none',
                                            border: 'none', borderLeft: isSelected ? '3px solid var(--primary)' : '3px solid transparent',
                                            cursor: 'pointer', gap: '0.75rem', alignItems: 'center',
                                            transition: 'background 0.1s',
                                        }}
                                        onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(255,255,255,0.04)'; }}
                                        onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
                                    >
                                        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.85rem', color: '#60a5fa', minWidth: 120, flexShrink: 0 }}>{acc.code}</span>
                                        <span style={{ fontSize: '0.85rem', flex: 1, color: isSelected ? '#fff' : 'var(--foreground)' }}>{acc.name}</span>
                                        {acc.account_type && (
                                            <span style={{ fontSize: '0.7rem', fontWeight: 700, padding: '1px 6px', borderRadius: 4, flexShrink: 0, backgroundColor: badgeBg, color: badgeColor }}>
                                                {acc.account_type}
                                            </span>
                                        )}
                                        {isSelected && <CheckCircle2 size={14} style={{ color: '#10b981', flexShrink: 0 }} />}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Footer */}
                        <div style={{ padding: '0.75rem 1.25rem', borderTop: '1px solid var(--card-border)', display: 'flex', justifyContent: 'flex-end' }}>
                            <button onClick={() => setModalRow(null)} style={{ padding: '0.4rem 1rem', borderRadius: 6, border: '1px solid var(--card-border)', background: 'none', color: 'var(--secondary)', cursor: 'pointer', fontSize: '0.85rem' }}>
                                Fechar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── MODAL: Mapeamento Inteligente ───────────────────────────────── */}
            {autoMapOpen && (
                <div
                    onClick={() => !autoMapSaving && setAutoMapOpen(false)}
                    style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                    <div onClick={e => e.stopPropagation()} style={{ backgroundColor: 'var(--card-bg)', border: '1px solid rgba(139,92,246,0.35)', borderRadius: '14px', width: '680px', maxWidth: '95vw', maxHeight: '87vh', display: 'flex', flexDirection: 'column', boxShadow: '0 30px 70px rgba(0,0,0,0.55)' }}>

                        {/* Header */}
                        <div style={{ padding: '1.1rem 1.4rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(139,92,246,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Sparkles size={16} style={{ color: '#a78bfa' }} />
                                </div>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '1rem' }}>Mapeamento Inteligente</div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--secondary)' }}>Correlação automática por similaridade de texto + tipo de conta D/C</div>
                                </div>
                            </div>
                            <button onClick={() => setAutoMapOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)', padding: 4 }}><X size={18} /></button>
                        </div>

                        {/* Tela inicial */}
                        {autoMapSuggestions.length === 0 && !autoMapLoading && (
                            <div style={{ padding: '1.5rem 1.4rem' }}>
                                <p style={{ fontSize: '0.88rem', color: 'var(--secondary)', marginBottom: '1.25rem', lineHeight: 1.65 }}>
                                    O sistema vai analisar cada natureza de lançamento e buscar a conta contábil SAP B1 mais similar, considerando a descrição e o tipo de movimentação (D/C). Você poderá revisar e desmarcar sugestões antes de confirmar.
                                </p>
                                {autoMapMsg && (
                                    <div style={{ marginBottom: '1rem', padding: '0.65rem 0.9rem', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <AlertCircle size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                                        {autoMapMsg}
                                    </div>
                                )}
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                                    <input type="checkbox" checked={autoMapOnlyUnmapped} onChange={e => setAutoMapOnlyUnmapped(e.target.checked)} style={{ width: 16, height: 16, accentColor: '#8b5cf6' }} />
                                    Analisar apenas naturezas <strong>ainda não mapeadas</strong>
                                </label>
                                <button onClick={() => runAutoMap(autoMapOnlyUnmapped)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', justifyContent: 'center', padding: '0.7rem', borderRadius: 8, background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
                                    <Sparkles size={16} /> Gerar Sugestões Automáticas
                                </button>
                            </div>
                        )}

                        {/* Loading */}
                        {autoMapLoading && (
                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem', gap: '1rem' }}>
                                <Loader2 size={36} className="spinner" style={{ color: '#a78bfa' }} />
                                <span style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>Analisando naturezas e calculando correlações...</span>
                            </div>
                        )}

                        {/* Resultados */}
                        {!autoMapLoading && autoMapSuggestions.length > 0 && (<>
                            <div style={{ padding: '0.65rem 1.4rem', borderBottom: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', gap: '1rem', backgroundColor: 'rgba(139,92,246,0.04)' }}>
                                <span style={{ fontSize: '0.82rem', color: 'var(--secondary)' }}>
                                    <strong style={{ color: '#a78bfa' }}>{autoMapSelected.size}</strong> / {autoMapSuggestions.length} sugestões selecionadas
                                </span>
                                <button onClick={() => setAutoMapSelected(new Set(autoMapSuggestions.map(s => s.ed_codigo + '|' + s.ed_filial)))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', fontSize: '0.78rem', textDecoration: 'underline' }}>Selecionar tudo</button>
                                <button onClick={() => setAutoMapSelected(new Set())} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--secondary)', fontSize: '0.78rem', textDecoration: 'underline' }}>Desmarcar tudo</button>
                            </div>

                            <div style={{ flex: 1, overflowY: 'auto' }}>
                                {autoMapSuggestions.map(s => {
                                    const key = s.ed_codigo + '|' + s.ed_filial;
                                    const isChecked = autoMapSelected.has(key);
                                    const conf = s.confidence;
                                    const confColor = conf >= 50 ? '#10b981' : conf >= 25 ? '#f59e0b' : '#ef4444';
                                    const confLabel = conf >= 50 ? 'Alta' : conf >= 25 ? 'Média' : 'Baixa';
                                    const typeColors: Record<string, string> = { R: '#10b981', E: '#ef4444', A: '#3b82f6', L: '#f59e0b' };
                                    return (
                                        <div key={key} onClick={() => { const n = new Set(autoMapSelected); isChecked ? n.delete(key) : n.add(key); setAutoMapSelected(n); }} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', padding: '0.65rem 1.4rem', cursor: 'pointer', borderBottom: '1px solid var(--card-border)', backgroundColor: isChecked ? 'rgba(139,92,246,0.04)' : 'transparent', transition: 'background 0.1s' }}>
                                            <input type="checkbox" checked={isChecked} onChange={() => { }} style={{ width: 15, height: 15, flexShrink: 0, marginTop: 3, accentColor: '#8b5cf6' }} />
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.2rem' }}>
                                                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.82rem', color: 'var(--primary)', flexShrink: 0 }}>{s.ed_codigo}</span>
                                                    <span style={{ fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.ed_descric}</span>
                                                    <span style={{ flexShrink: 0, fontSize: '0.7rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3, backgroundColor: s.ed_debcred === 'R' ? 'rgba(16,185,129,0.12)' : s.ed_debcred === 'D' ? 'rgba(239,68,68,0.12)' : 'rgba(100,116,139,0.12)', color: s.ed_debcred === 'R' ? '#10b981' : s.ed_debcred === 'D' ? '#ef4444' : 'var(--secondary)' }}>{s.ed_debcred === 'R' ? 'Receita' : s.ed_debcred === 'D' ? 'Despesa' : s.ed_debcred || '?'}</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.775rem' }}>
                                                    <span style={{ color: 'var(--secondary)' }}>→</span>
                                                    <span style={{ fontFamily: 'monospace', color: 'var(--primary)', fontWeight: 600 }}>{s.suggested_code}</span>
                                                    <span style={{ color: 'var(--secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.suggested_name}</span>
                                                    {s.suggested_type && <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3, backgroundColor: `${typeColors[s.suggested_type] || '#64748b'}20`, color: typeColors[s.suggested_type] || 'var(--secondary)', flexShrink: 0 }}>{s.suggested_type}</span>}
                                                </div>
                                            </div>
                                            <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 48 }}>
                                                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: confColor }}>{conf}%</div>
                                                <div style={{ fontSize: '0.63rem', color: confColor, opacity: 0.85 }}>{confLabel}</div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Painel de progresso da aplicação */}
                            {applyProgress && (
                                <div style={{ margin: '0.5rem 1.4rem 0', border: '1px solid rgba(139,92,246,0.2)', borderRadius: 10, overflow: 'hidden', backgroundColor: 'rgba(15,10,30,0.6)' }}>
                                    {/* Header do progresso */}
                                    <div style={{ padding: '0.6rem 0.9rem', borderBottom: '1px solid rgba(139,92,246,0.15)', display: 'flex', alignItems: 'center', gap: '0.75rem', backgroundColor: 'rgba(139,92,246,0.07)' }}>
                                        {autoMapSaving
                                            ? <Loader2 size={14} className="spinner" style={{ color: '#a78bfa', flexShrink: 0 }} />
                                            : applyProgress.errors === 0
                                                ? <CheckCircle2 size={14} style={{ color: '#10b981', flexShrink: 0 }} />
                                                : <AlertCircle size={14} style={{ color: '#f59e0b', flexShrink: 0 }} />
                                        }
                                        <span style={{ fontSize: '0.8rem', color: 'var(--secondary)', flex: 1 }}>
                                            <strong style={{ color: '#a78bfa' }}>{applyProgress.done + applyProgress.errors}</strong> / {applyProgress.total} processados
                                            {applyProgress.errors > 0 && <span style={{ color: '#ef4444', marginLeft: 8 }}>• {applyProgress.errors} erro{applyProgress.errors !== 1 ? 's' : ''}</span>}
                                        </span>
                                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#a78bfa' }}>
                                            {Math.round(((applyProgress.done + applyProgress.errors) / applyProgress.total) * 100)}%
                                        </span>
                                    </div>

                                    {/* Barra de progresso */}
                                    <div style={{ height: 3, backgroundColor: 'rgba(139,92,246,0.12)' }}>
                                        <div style={{
                                            height: '100%',
                                            width: `${Math.round(((applyProgress.done + applyProgress.errors) / applyProgress.total) * 100)}%`,
                                            background: applyProgress.errors > 0
                                                ? 'linear-gradient(90deg, #7c3aed, #f59e0b)'
                                                : 'linear-gradient(90deg, #7c3aed, #4f46e5)',
                                            transition: 'width 0.25s ease',
                                        }} />
                                    </div>

                                    {/* Log em tempo real */}
                                    <div style={{ maxHeight: 130, overflowY: 'auto', padding: '0.4rem 0', fontFamily: 'monospace', fontSize: '0.72rem' }}>
                                        {applyProgress.log.map((entry, i) => (
                                            <div key={i} style={{
                                                display: 'flex', alignItems: 'center', gap: '0.45rem',
                                                padding: '0.18rem 0.9rem',
                                                color: entry.ok ? 'rgba(200,200,220,0.8)' : '#f87171',
                                                backgroundColor: i === 0 && autoMapSaving ? 'rgba(139,92,246,0.06)' : 'transparent',
                                            }}>
                                                <span style={{ color: entry.ok ? '#10b981' : '#ef4444', flexShrink: 0 }}>{entry.ok ? '✓' : '✗'}</span>
                                                <span style={{ color: '#a78bfa', minWidth: 60 }}>{entry.code}</span>
                                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.7 }}>{entry.name}</span>
                                                <span style={{ color: entry.ok ? '#6366f1' : '#ef4444', flexShrink: 0 }}>{entry.ok ? `→ ${entry.account}` : (entry.msg || 'erro')}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {autoMapMsg && !applyProgress && (
                                <div style={{ margin: '0 1.4rem', padding: '0.5rem 0.75rem', borderRadius: 6, backgroundColor: autoMapMsg.startsWith('✅') ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: 6, marginTop: '0.5rem' }}>
                                    {autoMapMsg.startsWith('✅') && <CheckCircle2 size={14} style={{ color: '#10b981' }} />}
                                    {autoMapMsg}
                                </div>
                            )}

                            {/* Footer com msg final quando terminar */}
                            {autoMapMsg && applyProgress && !autoMapSaving && (
                                <div style={{ margin: '0.4rem 1.4rem 0', padding: '0.4rem 0.75rem', borderRadius: 6, backgroundColor: autoMapMsg.startsWith('✅') ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)', border: `1px solid ${autoMapMsg.startsWith('✅') ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'}`, fontSize: '0.83rem', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {autoMapMsg.startsWith('✅') ? <CheckCircle2 size={13} style={{ color: '#10b981' }} /> : <AlertCircle size={13} style={{ color: '#f59e0b' }} />}
                                    {autoMapMsg}
                                </div>
                            )}

                            <div style={{ padding: '0.85rem 1.4rem', borderTop: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <button
                                    onClick={() => { setAutoMapSuggestions([]); setAutoMapMsg(null); setApplyProgress(null); }}
                                    disabled={autoMapSaving}
                                    style={{ padding: '0.4rem 1rem', borderRadius: 6, border: '1px solid var(--card-border)', background: 'none', color: autoMapSaving ? 'var(--secondary)' : 'var(--foreground)', cursor: autoMapSaving ? 'not-allowed' : 'pointer', fontSize: '0.85rem', opacity: autoMapSaving ? 0.5 : 1 }}
                                >← Refazer</button>
                                {!autoMapSaving && applyProgress && (applyProgress.done + applyProgress.errors) === applyProgress.total ? (
                                    <button
                                        onClick={() => { setAutoMapOpen(false); setAutoMapMsg(null); setAutoMapSuggestions([]); setApplyProgress(null); }}
                                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1.25rem', borderRadius: 7, border: 'none', cursor: 'pointer', background: 'linear-gradient(135deg, #059669, #047857)', color: 'white', fontWeight: 600, fontSize: '0.875rem' }}
                                    >
                                        <CheckCircle2 size={15} /> Concluído — Fechar
                                    </button>
                                ) : (
                                    <button
                                        onClick={applyAutoMap}
                                        disabled={autoMapSaving || autoMapSelected.size === 0}
                                        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1.25rem', borderRadius: 7, border: 'none', cursor: autoMapSaving || autoMapSelected.size === 0 ? 'not-allowed' : 'pointer', background: autoMapSaving || autoMapSelected.size === 0 ? 'rgba(139,92,246,0.3)' : 'linear-gradient(135deg, #7c3aed, #4f46e5)', color: 'white', fontWeight: 600, fontSize: '0.875rem' }}
                                    >
                                        {autoMapSaving ? <Loader2 size={15} className="spinner" /> : <CheckCircle2 size={15} />}
                                        {autoMapSaving
                                            ? `Gravando ${applyProgress ? applyProgress.done + applyProgress.errors : 0} / ${applyProgress?.total ?? autoMapSelected.size}...`
                                            : `Aplicar ${autoMapSelected.size} mapeamento${autoMapSelected.size !== 1 ? 's' : ''}`
                                        }
                                    </button>
                                )}
                            </div>
                        </>)}
                    </div>
                </div>
            )}
        </div>
    );
}
