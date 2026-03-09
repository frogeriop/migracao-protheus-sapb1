'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
    ArrowLeft, Download, RefreshCw, Search, Loader2,
    CheckCircle, AlertCircle, Trash2, ChevronLeft,
    ChevronRight, BookOpen, Tag, Edit2, Save, X
} from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import { ColDef, ModuleRegistry, AllCommunityModule, ICellRendererParams, GridReadyEvent } from 'ag-grid-community';
import styles from './page.module.css';

ModuleRegistry.registerModules([AllCommunityModule]);
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

interface Natureza {
    ed_filial: string;
    ed_codigo: string;
    ed_descric: string;
    ed_tipo: string;
    ed_grupo: string;
    ed_debcred: string;
    ed_conta: string;
    sap_account_code: string | null;
    sap_account_name: string | null;
    imported_at: string;
    updated_at: string;
}

interface Meta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

interface ImportStatus {
    phase: 'idle' | 'checking' | 'importing' | 'done' | 'error';
    message: string;
    progress: number;
    total: number;
    current: number;
}

interface InlineEdit {
    ed_codigo: string;
    ed_filial: string;
    sap_account_code: string;
    sap_account_name: string;
}

export default function NaturezasPage() {
    const [naturezas, setNaturezas] = useState<Natureza[]>([]);
    const [meta, setMeta] = useState<Meta>({ page: 1, limit: 50, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [importStatus, setImportStatus] = useState<ImportStatus>({
        phase: 'idle', message: '', progress: 0, total: 0, current: 0
    });
    const [editRow, setEditRow] = useState<InlineEdit | null>(null);
    const [saving, setSaving] = useState(false);
    const gridRef = useRef<any>(null);

    // ── AUTOCOMPLETE CONTA SAP ───────────────────────────────────────────────
    interface SapAccount { code: string; name: string; account_type?: string; }
    const [acSuggestions, setAcSuggestions] = useState<SapAccount[]>([]);
    const [acLoading, setAcLoading] = useState(false);
    const [acOpen, setAcOpen] = useState(false);
    const acRef = useRef<HTMLDivElement>(null);
    const acDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    const searchAccounts = useCallback(async (q: string) => {
        if (!q || q.trim().length < 1) {
            setAcSuggestions([]);
            setAcOpen(false);
            return;
        }
        setAcLoading(true);
        try {
            const res = await fetch(`/api/sap/chart-of-accounts/search?q=${encodeURIComponent(q.trim())}&limit=15`);
            const json = await res.json();
            if (json.success) {
                setAcSuggestions(json.data || []);
                setAcOpen((json.data || []).length > 0);
            }
        } catch {
            // silencioso
        } finally {
            setAcLoading(false);
        }
    }, []);

    const handleAccountCodeChange = (value: string) => {
        setEditRow(prev => prev ? { ...prev, sap_account_code: value } : prev);
        if (acDebounce.current) clearTimeout(acDebounce.current);
        acDebounce.current = setTimeout(() => searchAccounts(value), 280);
    };

    const selectAccount = (acc: SapAccount) => {
        setEditRow(prev => prev ? { ...prev, sap_account_code: acc.code, sap_account_name: acc.name } : prev);
        setAcSuggestions([]);
        setAcOpen(false);
    };

    // Fecha dropdown ao clicar fora
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (acRef.current && !acRef.current.contains(e.target as Node)) {
                setAcOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const showToast = (type: 'success' | 'error', text: string) => {
        setToast({ type, text });
        setTimeout(() => setToast(null), 4000);
    };

    const fetchNaturezas = useCallback(async (page = 1, searchTerm = '') => {
        setLoading(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: '50',
                ...(searchTerm ? { search: searchTerm } : {})
            });
            const res = await fetch(`/api/naturezas?${params}`);
            const json = await res.json();
            if (json.success) {
                setNaturezas(json.data || []);
                setMeta(json.meta);
            } else {
                showToast('error', json.message);
            }
        } catch (e: any) {
            showToast('error', 'Erro de conexão: ' + e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchNaturezas(1, search);
    }, [search, fetchNaturezas]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        setSearch(searchInput);
        setMeta(m => ({ ...m, page: 1 }));
    };

    // ── IMPORTAÇÃO ──────────────────────────────────────────────────────────
    const handleImport = async () => {
        if (!confirm('Iniciar a importação da tabela SED010 do TOTVS Protheus?\n\nOs dados existentes serão atualizados. Os mapeamentos de conta SAP já preenchidos serão preservados.')) return;

        setImportStatus({ phase: 'checking', message: 'Verificando conexão com o Protheus...', progress: 0, total: 0, current: 0 });

        try {
            // 1. Init: conta total de registros
            const initRes = await fetch('/api/naturezas/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'init' })
            });
            const initJson = await initRes.json();

            if (!initJson.success) {
                setImportStatus({ phase: 'error', message: initJson.message, progress: 0, total: 0, current: 0 });
                showToast('error', initJson.message);
                return;
            }

            const totalRows: number = initJson.totalRows || 0;
            if (totalRows === 0) {
                setImportStatus({ phase: 'done', message: 'Nenhum registro ativo encontrado na SED010.', progress: 100, total: 0, current: 0 });
                showToast('success', 'SED010 não possui registros ativos.');
                return;
            }

            // 2. Batch loop
            const batchSize = 200;
            let offset = 0;
            let copied = 0;

            setImportStatus({ phase: 'importing', message: 'Importando...', progress: 0, total: totalRows, current: 0 });

            while (offset < totalRows) {
                const batchRes = await fetch('/api/naturezas/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'batch', offset, limit: batchSize })
                });
                const batchJson = await batchRes.json();

                if (!batchJson.success) {
                    setImportStatus(s => ({ ...s, phase: 'error', message: batchJson.message }));
                    showToast('error', 'Erro no batch: ' + batchJson.message);
                    return;
                }

                copied += batchJson.rowsCopied || 0;
                offset += batchSize;

                const progress = Math.min(100, Math.round((copied / totalRows) * 100));
                setImportStatus({
                    phase: 'importing',
                    message: `Importando... ${copied.toLocaleString('pt-BR')} de ${totalRows.toLocaleString('pt-BR')} registros`,
                    progress,
                    total: totalRows,
                    current: copied
                });

                // Se não copiou nada neste batch, parar (fim dos dados)
                if (batchJson.rowsCopied === 0) break;
            }

            setImportStatus({
                phase: 'done',
                message: `Importação concluída! ${copied.toLocaleString('pt-BR')} registros importados.`,
                progress: 100,
                total: totalRows,
                current: copied
            });
            showToast('success', `SED010 importada com sucesso! ${copied.toLocaleString('pt-BR')} registros.`);
            fetchNaturezas(1, search);

        } catch (e: any) {
            setImportStatus({ phase: 'error', message: e.message, progress: 0, total: 0, current: 0 });
            showToast('error', 'Erro fatal na importação: ' + e.message);
        }
    };

    const handleClearTable = async () => {
        if (!confirm('Tem certeza que deseja APAGAR TODOS os registros da tabela SED010?\n\nEsta ação também apagará os mapeamentos de conta SAP já preenchidos.')) return;

        setLoading(true);
        try {
            const res = await fetch('/api/naturezas?confirm=true', { method: 'DELETE' });
            const json = await res.json();
            if (json.success) {
                showToast('success', json.message);
                setNaturezas([]);
                setMeta({ page: 1, limit: 50, total: 0, totalPages: 0 });
                setImportStatus({ phase: 'idle', message: '', progress: 0, total: 0, current: 0 });
            } else {
                showToast('error', json.message);
            }
        } catch (e: any) {
            showToast('error', e.message);
        } finally {
            setLoading(false);
        }
    };

    // ── EDIÇÃO INLINE DE CONTA SAP ──────────────────────────────────────────
    const startEdit = (row: Natureza) => {
        setEditRow({
            ed_codigo: row.ed_codigo,
            ed_filial: row.ed_filial,
            sap_account_code: row.sap_account_code || '',
            sap_account_name: row.sap_account_name || '',
        });
    };

    const cancelEdit = () => setEditRow(null);

    const saveEdit = async () => {
        if (!editRow) return;
        setSaving(true);
        try {
            const res = await fetch('/api/naturezas', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editRow)
            });
            const json = await res.json();
            if (json.success) {
                showToast('success', 'Conta SAP salva com sucesso!');
                setEditRow(null);
                fetchNaturezas(meta.page, search);
            } else {
                showToast('error', json.message);
            }
        } catch (e: any) {
            showToast('error', e.message);
        } finally {
            setSaving(false);
        }
    };

    // ── COLUNAS AG GRID ──────────────────────────────────────────────────────
    const columnDefs: ColDef[] = [
        {
            field: 'ed_codigo',
            headerName: 'Código',
            width: 100,
            pinned: 'left',
            cellStyle: { fontWeight: 600, fontFamily: 'monospace' }
        },
        {
            field: 'ed_descric',
            headerName: 'Descrição',
            flex: 2,
            minWidth: 200,
        },
        {
            field: 'ed_tipo',
            headerName: 'Tipo',
            width: 80,
        },
        {
            field: 'ed_debcred',
            headerName: 'D/C',
            width: 70,
            cellRenderer: (p: ICellRendererParams) => {
                const v = p.value?.trim();
                if (!v) return null;
                const isCredit = v === 'C';
                return (
                    <span style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        backgroundColor: isCredit ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                        color: isCredit ? 'var(--success)' : 'var(--error)',
                    }}>
                        {isCredit ? 'C' : 'D'}
                    </span>
                );
            }
        },
        {
            field: 'ed_conta',
            headerName: 'Conta Protheus',
            width: 140,
            cellStyle: { fontFamily: 'monospace', fontSize: '0.85rem' }
        },
        {
            field: 'sap_account_code',
            headerName: '🔗 Conta SAP B1',
            width: 160,
            pinned: 'right',
            cellRenderer: (p: ICellRendererParams) => {
                const val = p.value;
                if (!val) {
                    return (
                        <span style={{
                            color: 'var(--secondary)',
                            fontStyle: 'italic',
                            fontSize: '0.8rem'
                        }}>
                            Não mapeado
                        </span>
                    );
                }
                return (
                    <span style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        fontFamily: 'monospace',
                        backgroundColor: 'rgba(59,130,246,0.15)',
                        color: 'var(--primary)',
                    }}>
                        {val}
                    </span>
                );
            }
        },
        {
            field: 'sap_account_name',
            headerName: 'Nome Conta SAP',
            flex: 1,
            minWidth: 160,
            cellStyle: { color: 'var(--secondary)', fontSize: '0.85rem' }
        },
        {
            field: 'actions',
            headerName: '',
            width: 80,
            pinned: 'right',
            sortable: false,
            filter: false,
            cellRenderer: (p: ICellRendererParams) => (
                <button
                    onClick={() => startEdit(p.data)}
                    title="Mapear conta SAP"
                    style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '4px 8px', borderRadius: 6,
                        background: 'rgba(59,130,246,0.12)',
                        border: '1px solid rgba(59,130,246,0.3)',
                        color: 'var(--primary)',
                        cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500
                    }}
                >
                    <Edit2 size={12} /> Mapear
                </button>
            )
        }
    ];

    const isImporting = importStatus.phase === 'importing' || importStatus.phase === 'checking';

    return (
        <div className={styles.container}>
            {/* Toast */}
            {toast && (
                <div className={styles.toast} data-type={toast.type}>
                    {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                    {toast.text}
                </div>
            )}

            {/* Header */}
            <div className={styles.header}>
                <div>
                    <Link href="/settings" className={styles.backLink}>
                        <ArrowLeft size={16} /> Voltar para Configurações
                    </Link>
                    <h1 className={styles.title}>
                        <BookOpen size={28} />
                        Naturezas de Lançamento
                        <span className={styles.badge}>SED010</span>
                    </h1>
                    <p className={styles.subtitle}>
                        Importe as naturezas do TOTVS Protheus e mapeie a conta contábil correspondente no SAP Business One.
                    </p>
                </div>
                <div className={styles.actions}>
                    <button
                        className={styles.btnDanger}
                        onClick={handleClearTable}
                        disabled={loading || isImporting}
                        title="Limpar tabela"
                    >
                        <Trash2 size={15} /> Limpar
                    </button>
                    <button
                        className={styles.btnSecondary}
                        onClick={() => fetchNaturezas(meta.page, search)}
                        disabled={loading || isImporting}
                    >
                        <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Atualizar
                    </button>
                    <button
                        className={styles.btnPrimary}
                        onClick={handleImport}
                        disabled={isImporting || loading}
                    >
                        {isImporting
                            ? <><Loader2 size={15} className="animate-spin" /> Importando...</>
                            : <><Download size={15} /> Importar do Protheus</>
                        }
                    </button>
                </div>
            </div>

            {/* Stats */}
            <div className={styles.stats}>
                <div className={styles.statCard}>
                    <div className={styles.statValue}>{meta.total.toLocaleString('pt-BR')}</div>
                    <div className={styles.statLabel}>Total de Naturezas</div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statValue} style={{ color: 'var(--primary)' }}>
                        {naturezas.filter(n => n.sap_account_code).length}
                    </div>
                    <div className={styles.statLabel}>Com Conta SAP Mapeada (pág. atual)</div>
                </div>
                <div className={styles.statCard}>
                    <div className={styles.statValue} style={{ color: 'var(--error)' }}>
                        {naturezas.filter(n => !n.sap_account_code).length}
                    </div>
                    <div className={styles.statLabel}>Sem Mapeamento (pág. atual)</div>
                </div>
            </div>

            {/* Import Progress */}
            {importStatus.phase !== 'idle' && (
                <div className={styles.progressCard} data-phase={importStatus.phase}>
                    <div className={styles.progressHeader}>
                        {importStatus.phase === 'done' && <CheckCircle size={18} />}
                        {importStatus.phase === 'error' && <AlertCircle size={18} />}
                        {isImporting && <Loader2 size={18} className="animate-spin" />}
                        <span>{importStatus.message}</span>
                        {importStatus.phase === 'done' || importStatus.phase === 'error' ? (
                            <button
                                className={styles.closeProgress}
                                onClick={() => setImportStatus({ phase: 'idle', message: '', progress: 0, total: 0, current: 0 })}
                            >
                                <X size={16} />
                            </button>
                        ) : null}
                    </div>
                    {importStatus.total > 0 && (
                        <div className={styles.progressBar}>
                            <div
                                className={styles.progressFill}
                                style={{ width: `${importStatus.progress}%` }}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* Search & Grid */}
            <div className={styles.gridWrapper}>
                <div className={styles.toolbar}>
                    <form onSubmit={handleSearch} className={styles.searchForm}>
                        <Search size={16} />
                        <input
                            className={styles.searchInput}
                            placeholder="Buscar por código, descrição ou conta SAP..."
                            value={searchInput}
                            onChange={e => setSearchInput(e.target.value)}
                        />
                        <button type="submit" className={styles.btnSearch}>Buscar</button>
                        {search && (
                            <button
                                type="button"
                                className={styles.btnClearSearch}
                                onClick={() => { setSearchInput(''); setSearch(''); }}
                            >
                                <X size={14} /> Limpar
                            </button>
                        )}
                    </form>
                    <span className={styles.totalInfo}>
                        {meta.total.toLocaleString('pt-BR')} registros · Pág. {meta.page}/{meta.totalPages || 1}
                    </span>
                </div>

                <div className="ag-theme-quartz-dark" style={{ height: 480, width: '100%' }}>
                    <AgGridReact
                        ref={gridRef}
                        theme="legacy"
                        rowData={naturezas}
                        columnDefs={columnDefs}
                        defaultColDef={{ sortable: true, filter: true, resizable: true }}
                        rowHeight={42}
                        headerHeight={44}
                        pagination={false}
                        animateRows
                        suppressCellFocus
                        noRowsOverlayComponent={() => (
                            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--secondary)' }}>
                                {meta.total === 0
                                    ? 'Nenhuma natureza importada. Clique em "Importar do Protheus".'
                                    : 'Nenhum resultado para a busca.'
                                }
                            </div>
                        )}
                    />
                </div>

                {/* Pagination */}
                <div className={styles.pagination}>
                    <button
                        className={styles.btnSecondary}
                        disabled={meta.page <= 1 || loading}
                        onClick={() => {
                            const newPage = meta.page - 1;
                            setMeta(m => ({ ...m, page: newPage }));
                            fetchNaturezas(newPage, search);
                        }}
                    >
                        <ChevronLeft size={16} /> Anterior
                    </button>
                    <span className={styles.pageInfo}>
                        Página {meta.page} de {meta.totalPages || 1}
                    </span>
                    <button
                        className={styles.btnSecondary}
                        disabled={meta.page >= (meta.totalPages || 1) || loading}
                        onClick={() => {
                            const newPage = meta.page + 1;
                            setMeta(m => ({ ...m, page: newPage }));
                            fetchNaturezas(newPage, search);
                        }}
                    >
                        Próxima <ChevronRight size={16} />
                    </button>
                </div>
            </div>

            {/* Modal de Edição de Conta SAP */}
            {editRow && (
                <div className={styles.modalOverlay}>
                    <div className={styles.modal}>
                        <div className={styles.modalHeader}>
                            <div>
                                <h2 className={styles.modalTitle}>
                                    <Tag size={20} /> Mapear Conta Contábil SAP B1
                                </h2>
                                <p className={styles.modalSubtitle}>
                                    Natureza: <strong>{editRow.ed_codigo}</strong>
                                </p>
                            </div>
                            <button className={styles.modalClose} onClick={cancelEdit}>
                                <X size={20} />
                            </button>
                        </div>

                        <div className={styles.modalBody}>
                            <div className={styles.naturalInfo}>
                                <div className={styles.infoItem}>
                                    <span className={styles.infoLabel}>Natureza (Protheus)</span>
                                    <span className={styles.infoValue} style={{ fontFamily: 'monospace', fontWeight: 700 }}>
                                        {editRow.ed_codigo}
                                    </span>
                                </div>
                                <div className={styles.infoItem}>
                                    <span className={styles.infoLabel}>Descrição</span>
                                    <span className={styles.infoValue}>
                                        {naturezas.find(n => n.ed_codigo === editRow.ed_codigo)?.ed_descric || '—'}
                                    </span>
                                </div>
                                <div className={styles.infoItem}>
                                    <span className={styles.infoLabel}>Conta Protheus (ed_conta)</span>
                                    <span className={styles.infoValue} style={{ fontFamily: 'monospace' }}>
                                        {naturezas.find(n => n.ed_codigo === editRow.ed_codigo)?.ed_conta || '—'}
                                    </span>
                                </div>
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.formLabel}>
                                    Código da Conta SAP B1 <span className={styles.required}>*</span>
                                </label>
                                <div className={styles.acWrapper} ref={acRef}>
                                    <div className={styles.acInputRow}>
                                        <input
                                            className={`${styles.formInput} ${styles.acInputInner}`}
                                            value={editRow.sap_account_code}
                                            onChange={e => handleAccountCodeChange(e.target.value)}
                                            onFocus={() => editRow.sap_account_code.length >= 1 && acSuggestions.length > 0 && setAcOpen(true)}
                                            placeholder="Digite o código ou nome da conta..."
                                            autoFocus
                                            autoComplete="off"
                                        />
                                        {acLoading && (
                                            <span className={styles.acSpinner}>
                                                <Loader2 size={15} className="animate-spin" />
                                            </span>
                                        )}
                                    </div>
                                    {acOpen && acSuggestions.length > 0 && (
                                        <ul className={styles.acDropdown}>
                                            {acSuggestions.map(acc => (
                                                <li
                                                    key={acc.code}
                                                    className={styles.acItem}
                                                    onMouseDown={() => selectAccount(acc)}
                                                >
                                                    <span className={styles.acCode}>{acc.code}</span>
                                                    <span className={styles.acName}>{acc.name}</span>
                                                    {acc.account_type && (
                                                        <span className={styles.acType}>{acc.account_type}</span>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <span className={styles.formHint}>
                                    Digite o código ou nome para buscar no Plano de Contas do SAP B1.
                                </span>
                            </div>

                            <div className={styles.formGroup}>
                                <label className={styles.formLabel}>Descrição da Conta SAP B1</label>
                                <input
                                    className={styles.formInput}
                                    value={editRow.sap_account_name}
                                    onChange={e => setEditRow({ ...editRow, sap_account_name: e.target.value })}
                                    placeholder="Ex: Receitas de Serviços"
                                />
                                <span className={styles.formHint}>
                                    Campo informativo — facilita a identificação da conta no contexto de migração.
                                </span>
                            </div>
                        </div>

                        <div className={styles.modalFooter}>
                            <button className={styles.btnSecondary} onClick={cancelEdit} disabled={saving}>
                                Cancelar
                            </button>
                            <button
                                className={styles.btnPrimary}
                                onClick={saveEdit}
                                disabled={saving || !editRow.sap_account_code.trim()}
                            >
                                {saving
                                    ? <><Loader2 size={14} className="animate-spin" /> Salvando...</>
                                    : <><Save size={14} /> Salvar Mapeamento</>
                                }
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
