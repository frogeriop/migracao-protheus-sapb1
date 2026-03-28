'use client';

import React from 'react';
import { useState, useEffect, useRef } from 'react';
import { Layers, Play, AlertCircle, ArrowRight, CheckCircle, XCircle, Loader2, Minimize2, Maximize2, Building2 } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import { useMapping } from '@/hooks/useMapping';

interface PreviewItem {
    source: any;
    target: any;
    existsInSap: boolean;
    action: 'insert' | 'update';
    matchMethod?: 'card_code' | 'tax_id' | 'none';
    status?: 'pending' | 'loading' | 'success' | 'error';
    message?: string;
}

interface SapBranch {
    bplId: number;
    bplName: string;
    aliasName: string | null;
    disabled: boolean;
    defaultWarehouse: string | null;
    federalTaxId: string | null;
    isMain: boolean;
}

interface ExcelFilter {
    field: string;
    operator: 'contains' | 'equals' | 'starts_with';
    value: string;
}

const TABLE_OPTIONS = [
    { code: 'SA1010', name: 'Clientes (BusinessPartners)' },
    { code: 'SA2010', name: 'Fornecedores (BusinessPartners)' },
    { code: 'SB1010', name: 'Produtos (Items)' },
    { code: 'SE1010', name: 'Contas a Receber (Sales Orders)' },
    { code: 'SE2010', name: 'Contas a Pagar (JournalEntries / LCM)' },
];

export default function RunMigrationPage() {
    const { config } = useConfig();
    const [selectedTable, setSelectedTable] = useState('SA1010');
    const [dataSource, setDataSource] = useState<'protheus' | 'excel'>('protheus');
    const [step, setStep] = useState<'select' | 'preview' | 'executing' | 'done'>('select');
    const [limit, setLimit] = useState(50);
    const [offset, setOffset] = useState(0);

    const [stagingTable, setStagingTable] = useState<string>('');

    // Preview Data
    const [previewList, setPreviewList] = useState<PreviewItem[]>([]);
    const [loadingPreview, setLoadingPreview] = useState(false);
    const [loadingMessage, setLoadingMessage] = useState('Processando...');
    const [totalSourceRows, setTotalSourceRows] = useState(0);
    const [periodFilterWarning, setPeriodFilterWarning] = useState<string | null>(null);

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (loadingPreview) {
            const messages = [
                'Buscando dados de origem...',
                'Processando mapeamentos...',
                'Verificando duplicatas no SAP via Service Layer...',
                'Quase pronto...',
            ];
            let idx = 0;
            setLoadingMessage(messages[0]);
            interval = setInterval(() => {
                idx = (idx + 1) % messages.length;
                setLoadingMessage(messages[idx]);
            }, 3500);
        }
        return () => {
            if (interval) clearInterval(interval);
        };
    }, [loadingPreview]);

    // Execution
    const [progress, setProgress] = useState({ current: 0, total: 0, success: 0, error: 0 });
    const [expandedRow, setExpandedRow] = useState<number | null>(null);
    const [duplicateAddress, setDuplicateAddress] = useState(false);

    const interruptRef = useRef(false);
    const [isInterrupting, setIsInterrupting] = useState(false);

    const handleInterrupt = () => {
        interruptRef.current = true;
        setIsInterrupting(true);
    };

    // ── Filial (Branch) ──────────────────────────────────────────────────────
    const [branches, setBranches] = useState<SapBranch[]>([]);
    const [loadingBranches, setLoadingBranches] = useState(false);
    const [selectedBplId, setSelectedBplId] = useState<string>('');

    // ── Filtros Movimentos (SE2010 / SE1010) ─────────────────────────────
    const [filterCodigo, setFilterCodigo] = useState(''); // e2_fornece / e1_cliente / a1_cod ...
    const [filterTipo, setFilterTipo] = useState(''); // e2_tipo    / e1_tipo
    const [filterPrefixo, setFilterPrefixo] = useState(''); // e2_prefixo / e1_prefixo
    const [filterNumero, setFilterNumero] = useState(''); // e2_num     / e1_num
    const [filterDtIni, setFilterDtIni] = useState(''); // vencimento de (YYYY-MM-DD)
    const [filterDtFim, setFilterDtFim] = useState(''); // vencimento até (YYYY-MM-DD)
    const [filterNaturez, setFilterNaturez] = useState(''); // e2_naturez
    const [filterFilial, setFilterFilial] = useState(''); // filial Protheus
    const [filterEmpfat, setFilterEmpfat] = useState(''); // empresa faturamento
    const [filterNome, setFilterNome] = useState(''); // nome fornecedor / cliente
    const [filterEmIni, setFilterEmIni] = useState(''); // emissão de  (YYYY-MM-DD)
    const [filterEmFim, setFilterEmFim] = useState(''); // emissão até (YYYY-MM-DD)
    // ── Filtros Cadastros (SA1010 / SA2010 / SB1010) ────────────────────────
    const [filterDescricao, setFilterDescricao] = useState(''); // b1_desc (SB1010)
    const [filterEstado, setFilterEstado] = useState(''); // a1_est / a2_est
    const [filterMunicipio, setFilterMunicipio] = useState(''); // a1_mun / a2_mun
    const [filterLoja, setFilterLoja] = useState(''); // a1_loja / a2_loja
    const [filterCgc, setFilterCgc] = useState(''); // a1_cgc / a2_cgc (CNPJ/CPF)
    const [filterGrupo, setFilterGrupo] = useState(''); // b1_grupo (SB1010)
    const [filterSapCode, setFilterSapCode] = useState(''); // valor específico de __sap_id / __sap_id
    const [filterSapStatus, setFilterSapStatus] = useState(''); // '' | 'null' | 'notnull'
    const [syncingSapCodes, setSyncingSapCodes] = useState(false);

    // Migration Entities
    const [entities, setEntities] = useState<any[]>([]);
    const [selectedEntityId, setSelectedEntityId] = useState<string>('');
    const [excelColumns, setExcelColumns] = useState<string[]>([]);
    const [excelFilters, setExcelFilters] = useState<ExcelFilter[]>([{ field: '', operator: 'equals', value: '' }]);

    // ── Reseta a paginação automaticamente quando alterar qualquer filtro
    useEffect(() => {
        setOffset(0);
    }, [
        filterCodigo, filterTipo, filterPrefixo, filterNumero, filterDtIni, filterDtFim,
        filterNaturez, filterFilial, filterEmpfat, filterNome, filterEmIni, filterEmFim,
        filterDescricao, filterEstado, filterMunicipio, filterLoja, filterCgc, filterGrupo,
        filterSapCode, filterSapStatus, excelFilters, dataSource, selectedTable, selectedEntityId
    ]);

    // Busca entidades de migração do banco
    const fetchEntities = async () => {
        try {
            const res = await fetch('/api/migration/entities');
            const json = await res.json();
            if (json.success && json.data) {
                // Para a rotina de execução, queremos apenas entidades configuradas (com target_object)
                const configured = json.data.filter((e: any) => e.target_object && e.staging_table);
                setEntities(configured);
            }
        } catch (e) {
            console.error('Erro ao buscar entidades:', e);
        }
    };

    useEffect(() => {
        fetchEntities();
    }, []);

    useEffect(() => {
        const loadExcelColumns = async () => {
            if (dataSource !== 'excel' || !stagingTable) {
                setExcelColumns([]);
                return;
            }
            try {
                const params = new URLSearchParams({ table: stagingTable, action: 'columns' });
                const res = await fetch(`/api/data?${params.toString()}`);
                const json = await res.json();
                if (json.success && Array.isArray(json.data)) {
                    setExcelColumns(json.data);
                } else {
                    setExcelColumns([]);
                }
            } catch (err) {
                console.error('Erro ao carregar colunas da staging:', err);
                setExcelColumns([]);
            }
        };
        loadExcelColumns();
    }, [dataSource, stagingTable]);

    // Sincroniza __sap_id do Supabase com os códigos do SAP B1
    const syncSapCodes = async () => {
        if (!['SA1010', 'SA2010', 'SB1010'].includes(selectedTable)) return;
        setSyncingSapCodes(true);
        try {
            const res = await fetch('/api/migration/sync-sap-codes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table: selectedTable }),
            });
            const json = await res.json();
            if (json.success) {
                alert(`✅ Sincronização concluída!\n\n${json.message}`);
            } else {
                alert(`❌ Erro: ${json.message}`);
            }
        } catch (e: any) {
            alert(`❌ Erro: ${e.message}`);
        } finally {
            setSyncingSapCodes(false);
        }
    };

    // Busca filiais quando SE2010 é selecionado
    useEffect(() => {
        if (selectedTable === 'SE2010') {
            fetchBranches();
        } else {
            setBranches([]);
            setSelectedBplId('');
        }
        // Reseta todos os filtros ao trocar de tabela
        setFilterCodigo(''); setFilterTipo(''); setFilterPrefixo(''); setFilterNumero('');
        setFilterNaturez(''); setFilterFilial(''); setFilterEmpfat(''); setFilterNome('');
        setFilterDtIni(''); setFilterDtFim(''); setFilterEmIni(''); setFilterEmFim('');
        setFilterDescricao(''); setFilterEstado(''); setFilterMunicipio('');
        setFilterLoja(''); setFilterCgc(''); setFilterGrupo('');
        setFilterSapCode(''); setFilterSapStatus('');
        setPeriodFilterWarning(null);
        setExcelFilters([{ field: '', operator: 'equals', value: '' }]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedTable]);


    const fetchBranches = async () => {
        setLoadingBranches(true);
        try {
            const res = await fetch('/api/sap/branches');
            const json = await res.json();
            if (json.success && json.data) {
                setBranches(json.data);
                // Pré-seleciona a filial principal (isMain=true) ou a primeira ativa
                if (!selectedBplId) {
                    const main = json.data.find((b: SapBranch) => b.isMain) ?? json.data[0];
                    if (main) setSelectedBplId(String(main.bplId));
                }
            } else {
                console.error('Erro ao buscar filiais:', json.message);
            }
        } catch (e: any) {
            console.error('Erro ao buscar filiais:', e.message);
        } finally {
            setLoadingBranches(false);
        }
    };



    const fetchPreview = async () => {
        setLoadingPreview(true);
        setPreviewList([]);
        try {
            // Se a carga for via Excel, usamos a tabela dinâmica retornada no upload
            const sourceTable = dataSource === 'excel' ? stagingTable : selectedTable;
            const body: any = { 
                table: selectedTable, 
                sourceTable, 
                limit, 
                offset, 
                duplicateAddress,
                entityId: dataSource === 'excel' ? selectedEntityId : undefined
            };
            // Envia bplId apenas para SE2010
            if (selectedTable === 'SE2010' && selectedBplId) {
                body.bplId = Number(selectedBplId);
            }
            // Envia filtros para SE2010 / SE1010
            if (selectedTable === 'SE2010' || selectedTable === 'SE1010') {
                const filters: Record<string, string> = {};
                if (filterCodigo.trim()) filters.codigo = filterCodigo.trim();
                if (filterTipo.trim()) filters.tipo = filterTipo.trim();
                if (filterPrefixo.trim()) filters.prefixo = filterPrefixo.trim();
                if (filterNumero.trim()) filters.numero = filterNumero.trim();
                if (filterNaturez.trim()) filters.naturez = filterNaturez.trim();
                if (filterFilial.trim()) filters.filial = filterFilial.trim();
                if (filterEmpfat.trim()) filters.empfat = filterEmpfat.trim();
                if (filterNome.trim()) filters.nome = filterNome.trim();
                if (filterDtIni.trim()) filters.dtIni = filterDtIni.trim().replace(/-/g, '');
                if (filterDtFim.trim()) filters.dtFim = filterDtFim.trim().replace(/-/g, '');
                if (filterEmIni.trim()) filters.emIni = filterEmIni.trim().replace(/-/g, '');
                if (filterEmFim.trim()) filters.emFim = filterEmFim.trim().replace(/-/g, '');
                if (filterSapCode.trim()) filters.sapCode = filterSapCode.trim();
                if (filterSapStatus) filters.sapStatus = filterSapStatus;
                if (Object.keys(filters).length > 0) body.filters = filters;
            }
            // ── Filtros cadastros (SA1010 / SA2010 / SB1010) ──
            if (['SA1010', 'SA2010', 'SB1010'].includes(selectedTable)) {
                const filters: Record<string, string> = {};
                if (filterCodigo.trim()) filters.codigo = filterCodigo.trim();
                if (filterNome.trim()) filters.nome = filterNome.trim();
                if (filterDescricao.trim()) filters.descricao = filterDescricao.trim();
                if (filterFilial.trim()) filters.filial = filterFilial.trim();
                if (filterEmpfat.trim()) filters.empfat = filterEmpfat.trim();
                if (filterEstado.trim()) filters.estado = filterEstado.trim().toUpperCase();
                if (filterMunicipio.trim()) filters.municipio = filterMunicipio.trim();
                if (filterLoja.trim()) filters.loja = filterLoja.trim();
                if (filterCgc.trim()) filters.cgc = filterCgc.trim().replace(/\D/g, '');
                if (filterGrupo.trim()) filters.grupo = filterGrupo.trim();
                if (filterSapCode.trim()) filters.sapCode = filterSapCode.trim();
                if (filterSapStatus) filters.sapStatus = filterSapStatus;
                if (Object.keys(filters).length > 0) body.filters = filters;
            }
            if (dataSource === 'excel') {
                const validExcelFilters = excelFilters
                    .map(f => ({ ...f, value: f.value.trim() }))
                    .filter(f => f.field && f.value);
                if (validExcelFilters.length > 0) {
                    body.excelFilters = validExcelFilters;
                }
            }

            const res = await fetch('/api/migration/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const json = await res.json();
            if (json.success) {
                setPreviewList(json.preview);
                setTotalSourceRows(json.totalProcessed);
                setPeriodFilterWarning(json.periodFilterWarning || null);
                setStep('preview');
            } else {
                alert('Erro ao carregar preview: ' + json.message);
            }
        } catch (e: any) {
            alert('Erro: ' + e.message);
        } finally {
            setLoadingPreview(false);
        }
    };

    const handleExecute = async () => {
        console.log('Starting execution...');

        setStep('executing');
        setProgress({ current: 0, total: previewList.length, success: 0, error: 0 });
        interruptRef.current = false;
        setIsInterrupting(false);

        let successCount = 0;
        let errorCount = 0;

        const newList = [...previewList];

        for (let i = 0; i < newList.length; i++) {
            if (interruptRef.current) {
                console.log('Execution interrupted by user.');
                break;
            }

            const item = newList[i];

            // ── Mark as Loading & Yield Paint ──
            newList[i].status = 'loading';
            setPreviewList([...newList]);
            
            // Auto-scroll to the row
            const rowElem = document.getElementById(`preview-row-${i}`);
            if (rowElem) {
                rowElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            
            // tiny delay to ensure React renders the loading icon before fetch blocks
            await new Promise(r => setTimeout(r, 50));

            const tableCode = selectedTable;
            let mappingTarget = tableCode; // default (useful for Excel where selectedTable is already target_object)
            if (dataSource === 'protheus') {
                if (tableCode.startsWith('SA')) mappingTarget = 'BusinessPartners';
                else if (tableCode.startsWith('SB')) mappingTarget = 'Items';
                else if (tableCode === 'SE1010') mappingTarget = 'Orders';
                else if (tableCode === 'SE2010') mappingTarget = 'JournalEntries';
                else mappingTarget = 'PurchaseInvoices';
            }

            try {
                const sourcePk: string | undefined = (
                    selectedTable === 'SA1010' ? item.source?.a1_cod :
                        selectedTable === 'SA2010' ? item.source?.a2_cod :
                            selectedTable === 'SB1010' ? item.source?.b1_cod :
                                undefined
                )?.toString().trim();

                const sourceRowId: string | undefined = 
                    dataSource === 'excel' ? (item.source?.__source_key || item.source?.id?.toString()) : undefined;

                // SE2010 e SE1010: envia o r_e_c_n_o_ para write-back (JdtNum / DocEntry)
                const sourceRecno: number | undefined =
                    (selectedTable === 'SE2010' || selectedTable === 'SE1010')
                        ? item.source?.r_e_c_n_o_
                        : undefined;

                const res = await fetch('/api/migration/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        table: dataSource === 'excel' ? stagingTable : selectedTable,
                        targetObject: mappingTarget,
                        payload: item.target,
                        action: item.action,
                        source_pk: sourcePk,
                        source_recno: sourceRecno,
                        source_row_id: sourceRowId
                    })
                });

                const json = await res.json();

                if (json.success) {
                    newList[i].status = 'success';
                    const d = json.data || {};
                    let successMsg = 'Integrado com sucesso';
                    if (selectedTable === 'SE1010') {
                        if (item.action === 'insert') {
                            const docNum = d.DocNum ?? '';
                            const docEntry = d.DocEntry ?? '';
                            successMsg = `Pedido criado — DocNum: ${docNum} | DocEntry: ${docEntry}`;
                        } else {
                            successMsg = `Sales Order atualizada — DocEntry: ${d.DocEntry ?? ''}`;
                        }
                    } else if (selectedTable === 'SE2010') {
                        successMsg = `LCM criado — JdtNum: ${d.JdtNum ?? 'OK'}`;
                    } else {
                        const sapId = d.CardCode || d.ItemCode || d.DocEntry || 'OK';
                        successMsg = `Integrado com sucesso ID: ${sapId}`;
                    }
                    newList[i].message = successMsg;
                    successCount++;
                } else {
                    newList[i].status = 'error';
                    newList[i].message = json.message || 'Erro desconhecido';
                    errorCount++;
                }
            } catch (e: any) {
                newList[i].status = 'error';
                newList[i].message = 'Falha de conexão/script: ' + e.message;
                errorCount++;
            }

            setProgress({ current: i + 1, total: newList.length, success: successCount, error: errorCount });
            setPreviewList([...newList]);
        }

        setStep('done');
        setIsInterrupting(false);
    };

    const toggleRow = (idx: number) => {
        setExpandedRow(expandedRow === idx ? null : idx);
    };

    // --- UI HELPERS --- //
    const getStatusIcon = (status?: string) => {
        if (status === 'success') return <CheckCircle size={18} color="var(--success)" />;
        if (status === 'error') return <XCircle size={18} color="var(--error)" />;
        if (status === 'loading') return <Loader2 size={18} className="animate-spin" color="var(--accent)" />;
        if (step === 'executing' && !status) return <div style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--secondary)', opacity: 0.3 }} />;
        return <div style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--secondary)' }} />;
    };

    // Nome da filial selecionada (para exibir no preview)
    const selectedBranchName = branches.find(b => String(b.bplId) === selectedBplId)?.bplName;

    return (
        <div className="container" style={{ maxWidth: '1200px' }}>
            <h1 className="page-title">Migração de Dados</h1>

            {/* STEP 1: SELECT */}
            {step === 'select' && (
                <div className="card">
                    <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', borderBottom: '1px solid var(--card-border)' }}>
                        <button
                            onClick={() => setDataSource('protheus')}
                            style={{
                                padding: '0.75rem 1.5rem',
                                background: 'none',
                                border: 'none',
                                borderBottom: dataSource === 'protheus' ? '2px solid var(--accent)' : 'none',
                                color: dataSource === 'protheus' ? 'var(--accent)' : 'var(--secondary)',
                                fontWeight: 600,
                                cursor: 'pointer'
                            }}
                        >
                            Origem: Protheus (Direct SQL)
                        </button>
                        <button
                            onClick={() => setDataSource('excel')}
                            style={{
                                padding: '0.75rem 1.5rem',
                                background: 'none',
                                border: 'none',
                                borderBottom: dataSource === 'excel' ? '2px solid var(--accent)' : 'none',
                                color: dataSource === 'excel' ? 'var(--accent)' : 'var(--secondary)',
                                fontWeight: 600,
                                cursor: 'pointer'
                            }}
                        >
                            Origem: Planilha Excel
                        </button>
                    </div>

                    <h2 style={{ marginBottom: '1.5rem', color: 'var(--foreground)', fontSize: '1.1rem' }}>
                        1. {dataSource === 'protheus' ? 'Selecione a Tabela/Objeto (PROTHEUS)' : 'Selecione a Tabela/Objeto (PLANILHAS)'}
                    </h2>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem', maxWidth: '500px' }}>


                        <div className="input-group">
                            {dataSource === 'excel' ? (
                                <>
                                    <label className="label">Planilha / Tabela de Staging</label>
                                    <select 
                                        className="input" 
                                        value={selectedEntityId} 
                                        onChange={e => {
                                            const id = e.target.value;
                                            setSelectedEntityId(id);
                                            const entity = entities.find(ent => ent.id === id);
                                            if (entity) {
                                                setStagingTable(entity.staging_table);
                                                setSelectedTable(entity.target_object);
                                            } else {
                                                setStagingTable('');
                                            }
                                            setExcelFilters([{ field: '', operator: 'equals', value: '' }]);
                                        }}
                                    >
                                        <option value="">— Selecione a Planilha —</option>
                                        {entities.map(ent => (
                                            <option key={ent.id} value={ent.id}>
                                                {ent.name} (Destino: {ent.target_object})
                                            </option>
                                        ))}
                                    </select>
                                </>
                            ) : (
                                <>
                                    <label className="label">Tabela / Objeto SAP (Protheus)</label>
                                    <select className="input" value={selectedTable} onChange={e => setSelectedTable(e.target.value)}>
                                        {TABLE_OPTIONS.map(opt => (
                                            <option key={opt.code} value={opt.code}>{opt.code} - {opt.name}</option>
                                        ))}
                                    </select>
                                </>
                            )}

                        </div>

                        <div className="input-group">
                            <label className="label">Limite de Registros (Lote)</label>
                            <input type="number" className="input" value={limit} onChange={e => setLimit(Number(e.target.value))} />
                            <small style={{ color: 'var(--secondary)' }}>Máximo recomendado: 100.</small>
                        </div>

                        <div className="input-group">
                            <label className="label">Ignorar (Offset)</label>
                            <input type="number" className="input" value={offset} onChange={e => setOffset(Number(e.target.value))} />
                        </div>

                        {dataSource === 'excel' && (
                            <div style={{
                                marginTop: '0.5rem',
                                padding: '1rem',
                                borderRadius: '8px',
                                border: '1px solid rgba(16,185,129,0.35)',
                                backgroundColor: 'rgba(16,185,129,0.06)',
                            }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#34d399', marginBottom: '0.75rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                    🔎 Filtros por Campo da Planilha
                                </div>

                                {excelColumns.length === 0 ? (
                                    <small style={{ color: 'var(--secondary)' }}>
                                        Selecione uma planilha para carregar os campos disponíveis.
                                    </small>
                                ) : (
                                    <>
                                        <div style={{ display: 'grid', gap: '0.5rem' }}>
                                            {excelFilters.map((filter, idx) => (
                                                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1.3fr auto', gap: '0.45rem', alignItems: 'center' }}>
                                                    <select
                                                        className="input"
                                                        style={{ padding: '0.4rem 0.55rem', fontSize: '0.82rem' }}
                                                        value={filter.field}
                                                        onChange={e => {
                                                            const next = [...excelFilters];
                                                            next[idx] = { ...next[idx], field: e.target.value };
                                                            setExcelFilters(next);
                                                        }}
                                                    >
                                                        <option value="">Campo</option>
                                                        {excelColumns.map(col => (
                                                            <option key={col} value={col}>{col}</option>
                                                        ))}
                                                    </select>
                                                    <select
                                                        className="input"
                                                        style={{ padding: '0.4rem 0.55rem', fontSize: '0.82rem' }}
                                                        value={filter.operator}
                                                        onChange={e => {
                                                            const next = [...excelFilters];
                                                            next[idx] = { ...next[idx], operator: e.target.value as ExcelFilter['operator'] };
                                                            setExcelFilters(next);
                                                        }}
                                                    >
                                                        <option value="equals">igual a</option>
                                                        <option value="contains">contém</option>
                                                        <option value="starts_with">começa com</option>
                                                    </select>
                                                    <input
                                                        className="input"
                                                        style={{ padding: '0.4rem 0.55rem', fontSize: '0.82rem' }}
                                                        placeholder="Valor"
                                                        value={filter.value}
                                                        onChange={e => {
                                                            const next = [...excelFilters];
                                                            next[idx] = { ...next[idx], value: e.target.value };
                                                            setExcelFilters(next);
                                                        }}
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            if (excelFilters.length === 1) {
                                                                setExcelFilters([{ field: '', operator: 'equals', value: '' }]);
                                                                return;
                                                            }
                                                            setExcelFilters(excelFilters.filter((_, i) => i !== idx));
                                                        }}
                                                        style={{ padding: '0.35rem 0.55rem', borderRadius: 6, border: '1px solid var(--card-border)', background: 'none', color: 'var(--secondary)', cursor: 'pointer', fontSize: '0.78rem' }}
                                                    >
                                                        Remover
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                        <div style={{ display: 'flex', gap: '0.55rem', marginTop: '0.6rem' }}>
                                            <button
                                                type="button"
                                                onClick={() => setExcelFilters([...excelFilters, { field: '', operator: 'equals', value: '' }])}
                                                style={{ padding: '0.35rem 0.7rem', borderRadius: 6, border: '1px solid rgba(16,185,129,0.5)', background: 'none', color: '#34d399', cursor: 'pointer', fontSize: '0.78rem' }}
                                            >
                                                + Adicionar filtro
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setExcelFilters([{ field: '', operator: 'equals', value: '' }])}
                                                style={{ padding: '0.35rem 0.7rem', borderRadius: 6, border: '1px solid var(--card-border)', background: 'none', color: 'var(--secondary)', cursor: 'pointer', fontSize: '0.78rem' }}
                                            >
                                                Limpar filtros
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}

                        {dataSource === 'protheus' && (selectedTable === 'SA1010' || selectedTable === 'SA2010') && (
                            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                                <input
                                    type="checkbox"
                                    id="dupAddress"
                                    checked={duplicateAddress}
                                    onChange={e => setDuplicateAddress(e.target.checked)}
                                    style={{ width: 'auto', margin: 0, cursor: 'pointer' }}
                                />
                                <label htmlFor="dupAddress" style={{ margin: 0, cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text)' }}>
                                    Replicar endereço para Entrega?
                                </label>
                            </div>
                        )}

                        {/* ── Seletor de Filial (apenas SE2010) ── */}
                        {dataSource === 'protheus' && selectedTable === 'SE2010' && (
                            <div className="input-group">
                                <label className="label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                    <Building2 size={14} />
                                    Filial de Destino (SAP)
                                    {loadingBranches && <Loader2 size={13} className="animate-spin" style={{ marginLeft: '4px' }} />}
                                </label>

                                {branches.length > 0 ? (
                                    <select
                                        className="input"
                                        value={selectedBplId}
                                        onChange={e => setSelectedBplId(e.target.value)}
                                    >
                                        <option value="">— Sem filial específica —</option>
                                        {branches.map(b => (
                                            <option key={b.bplId} value={String(b.bplId)}>
                                                {b.isMain ? '★ ' : ''}{b.aliasName || b.bplName}
                                                {b.defaultWarehouse ? ` [Dep.${b.defaultWarehouse}]` : ''}
                                                {' — '}{b.bplName}
                                            </option>
                                        ))}
                                    </select>
                                ) : !loadingBranches ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        <span style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>
                                            Não foi possível carregar as filiais.
                                        </span>
                                        <button
                                            onClick={fetchBranches}
                                            style={{ fontSize: '0.8rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                                        >
                                            Tentar novamente
                                        </button>
                                    </div>
                                ) : (
                                    <div style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>Carregando filiais do SAP...</div>
                                )}

                                <small style={{ color: 'var(--secondary)' }}>
                                    Obrigatório quando Multi-Branch está ativo no SAP B1 (BPLId nas linhas do JE).
                                </small>
                            </div>
                        )}

                        {/* ── Filtros SE2010 / SE1010 ── */}
                        {dataSource === 'protheus' && (selectedTable === 'SE2010' || selectedTable === 'SE1010') && (
                            <div style={{
                                marginTop: '0.5rem',
                                padding: '1rem',
                                borderRadius: '8px',
                                border: '1px solid rgba(99,102,241,0.25)',
                                backgroundColor: 'rgba(99,102,241,0.05)',
                            }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent)', marginBottom: '0.75rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                    🔍 Filtros de Seleção
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                                    {/* Fornecedor / Cliente */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SE2010' ? 'Fornecedor (E2_FORNECE)' : 'Cliente (E1_CLIENTE)'}
                                        </label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: FOPAHN"
                                            value={filterCodigo}
                                            onChange={e => setFilterCodigo(e.target.value)}
                                        />
                                    </div>

                                    {/* Natureza — só SE2010 */}
                                    {selectedTable === 'SE2010' && (
                                        <div className="input-group" style={{ margin: 0 }}>
                                            <label className="label" style={{ fontSize: '0.75rem' }}>Natureza (E2_NATUREZ)</label>
                                            <input
                                                className="input"
                                                style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: FOPHN"
                                                value={filterNaturez}
                                                onChange={e => setFilterNaturez(e.target.value)}
                                            />
                                        </div>
                                    )}

                                    {/* Tipo */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SE2010' ? 'Tipo (E2_TIPO)' : 'Tipo (E1_TIPO)'}
                                        </label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: DP, NF, CT"
                                            value={filterTipo}
                                            onChange={e => setFilterTipo(e.target.value)}
                                        />
                                    </div>

                                    {/* Prefixo */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Prefixo</label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: MAN"
                                            value={filterPrefixo}
                                            onChange={e => setFilterPrefixo(e.target.value)}
                                        />
                                    </div>

                                    {/* Número */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Número do Documento</label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: 000033330"
                                            value={filterNumero}
                                            onChange={e => setFilterNumero(e.target.value)}
                                        />
                                    </div>

                                    {/* Filial */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SE2010' ? 'Filial Prot. (E2_FILIAL)' : 'Filial Prot. (E1_FILIAL)'}
                                        </label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: 0101"
                                            value={filterFilial}
                                            onChange={e => setFilterFilial(e.target.value)}
                                        />
                                    </div>

                                    {/* Empfat */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SE2010' ? 'Emp. Fat. (E2_EMPFAT)' : 'Emp. Fat. (E1_EMPFAT)'}
                                        </label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: 01"
                                            value={filterEmpfat}
                                            onChange={e => setFilterEmpfat(e.target.value)}
                                        />
                                    </div>

                                    {/* Nome */}
                                    <div className="input-group" style={{ margin: 0, gridColumn: '1 / -1' }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SE2010' ? 'Nome Forn. (E2_NOMFOR)' : 'Nome Cliente (E1_NOMCLI)'}
                                        </label>
                                        <input
                                            className="input"
                                            style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: COOPERATIVA"
                                            value={filterNome}
                                            onChange={e => setFilterNome(e.target.value)}
                                        />
                                    </div>
                                </div>

                                {/* Range de datas Vencimento */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginTop: '0.6rem' }}>
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Vencimento — De</label>
                                        <input type="date" className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            value={filterDtIni} onChange={e => setFilterDtIni(e.target.value)} />
                                    </div>
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Vencimento — Até</label>
                                        <input type="date" className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            value={filterDtFim} onChange={e => setFilterDtFim(e.target.value)} />
                                    </div>
                                    {/* Range de datas Emissão */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Emissão — De</label>
                                        <input type="date" className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            value={filterEmIni} onChange={e => setFilterEmIni(e.target.value)} />
                                    </div>
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Emissão — Até</label>
                                        <input type="date" className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            value={filterEmFim} onChange={e => setFilterEmFim(e.target.value)} />
                                    </div>
                                </div>

                                {/* Status SAP (__sap_id) — painel movimentos */}
                                <div className="input-group" style={{ margin: '0.6rem 0 0' }}>
                                    <label className="label" style={{ fontSize: '0.75rem' }}>🔗 Status de Integração SAP</label>
                                    <select
                                        className="input"
                                        style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                        value={filterSapStatus}
                                        onChange={e => { setFilterSapStatus(e.target.value); if (e.target.value !== '') setFilterSapCode(''); }}
                                    >
                                        <option value="">Todos os registros</option>
                                        <option value="null">❌ Não integrados ({selectedTable === 'SE1010' ? 'DocEntry vazio' : 'JdtNum vazio'})</option>
                                        <option value="notnull">✅ Já integrados ({selectedTable === 'SE1010' ? 'DocEntry preenchido' : 'JdtNum preenchido'})</option>
                                    </select>
                                    {filterSapStatus === '' && (
                                        <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem', marginTop: '0.35rem' }}
                                            placeholder={selectedTable === 'SE1010' ? 'ou busque DocEntry específico (ex: 1045)' : 'ou busque JdtNum específico (ex: 899)'}
                                            value={filterSapCode} onChange={e => setFilterSapCode(e.target.value)} />
                                    )}
                                </div>

                                {/* Badge filtros ativos */}
                                {[filterCodigo, filterTipo, filterPrefixo, filterNumero, filterNaturez,
                                    filterFilial, filterEmpfat, filterNome,
                                    filterDtIni, filterDtFim, filterEmIni, filterEmFim,
                                    filterSapCode, filterSapStatus].some(Boolean) && (
                                        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                            {[
                                                filterFilial && `Filial: ${filterFilial}`,
                                                filterEmpfat && `EmpFat: ${filterEmpfat}`,
                                                filterCodigo && `Cód: ${filterCodigo}`,
                                                filterNome && `Nome: ${filterNome}`,
                                                filterNaturez && `Nat: ${filterNaturez}`,
                                                filterTipo && `Tipo: ${filterTipo}`,
                                                filterPrefixo && `Pre: ${filterPrefixo}`,
                                                filterNumero && `Num: ${filterNumero}`,
                                                filterDtIni && `Venc De: ${filterDtIni}`,
                                                filterDtFim && `Venc Até: ${filterDtFim}`,
                                                filterEmIni && `Em. De: ${filterEmIni}`,
                                                filterEmFim && `Em. Até: ${filterEmFim}`,
                                                filterSapStatus === 'null' && '❌ Não integrados',
                                                filterSapStatus === 'notnull' && '✅ Já integrados',
                                                filterSapCode && `${selectedTable === 'SE1010' ? 'DocEntry' : 'JdtNum'}: ${filterSapCode}`,
                                            ].filter(Boolean).map((label, i) => (
                                                <span key={i} style={{
                                                    padding: '2px 8px', borderRadius: 99, fontSize: '0.72rem',
                                                    backgroundColor: 'rgba(99,102,241,0.2)', color: 'var(--accent)', fontWeight: 600,
                                                }}>{label}</span>
                                            ))}
                                            <button
                                                onClick={() => {
                                                    setFilterCodigo(''); setFilterTipo(''); setFilterPrefixo(''); setFilterNumero('');
                                                    setFilterNaturez(''); setFilterFilial(''); setFilterEmpfat(''); setFilterNome('');
                                                    setFilterDtIni(''); setFilterDtFim(''); setFilterEmIni(''); setFilterEmFim('');
                                                    setFilterSapCode(''); setFilterSapStatus('');
                                                }}
                                                style={{ fontSize: '0.72rem', color: 'var(--secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', textDecoration: 'underline' }}
                                            >
                                                Limpar tudo
                                            </button>
                                        </div>
                                    )}
                            </div>
                        )}

                        {/* ── Filtros SA1010 / SA2010 / SB1010 ── */}
                        {dataSource === 'protheus' && (['SA1010', 'SA2010', 'SB1010'] as string[]).includes(selectedTable) && (
                            <div style={{
                                marginTop: '0.5rem', padding: '1rem', borderRadius: '8px',
                                border: '1px solid rgba(99,102,241,0.25)', backgroundColor: 'rgba(99,102,241,0.05)',
                            }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent)', marginBottom: '0.75rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                                    🔍 Filtros de Seleção
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                                    {/* Código */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SA1010' ? 'Código (A1_COD)' : selectedTable === 'SA2010' ? 'Código (A2_COD)' : 'Código (B1_COD)'}
                                        </label>
                                        <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: C00001" value={filterCodigo} onChange={e => setFilterCodigo(e.target.value)} />
                                    </div>

                                    {/* Loja — só SA1010 / SA2010 */}
                                    {(selectedTable === 'SA1010' || selectedTable === 'SA2010') && (
                                        <div className="input-group" style={{ margin: 0 }}>
                                            <label className="label" style={{ fontSize: '0.75rem' }}>
                                                {selectedTable === 'SA1010' ? 'Loja (A1_LOJA)' : 'Loja (A2_LOJA)'}
                                            </label>
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: 01" value={filterLoja} onChange={e => setFilterLoja(e.target.value)} />
                                        </div>
                                    )}

                                    {/* Nome (Clientes/Fornecedores) ou Descrição (Produtos) */}
                                    <div className="input-group" style={{ margin: 0, gridColumn: '1 / -1' }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>
                                            {selectedTable === 'SA1010' ? 'Nome (A1_NOME)' : selectedTable === 'SA2010' ? 'Nome (A2_NOME)' : 'Descrição (B1_DESC)'}
                                        </label>
                                        {selectedTable === 'SB1010' ? (
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: PARAFUSO" value={filterDescricao} onChange={e => setFilterDescricao(e.target.value)} />
                                        ) : (
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: EMPRESA LTDA" value={filterNome} onChange={e => setFilterNome(e.target.value)} />
                                        )}
                                    </div>

                                    {/* Filial */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Filial Prot.</label>
                                        <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: 0101" value={filterFilial} onChange={e => setFilterFilial(e.target.value)} />
                                    </div>

                                    {/* EmpFat */}
                                    <div className="input-group" style={{ margin: 0 }}>
                                        <label className="label" style={{ fontSize: '0.75rem' }}>Emp. Fat.</label>
                                        <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                            placeholder="ex: 01" value={filterEmpfat} onChange={e => setFilterEmpfat(e.target.value)} />
                                    </div>

                                    {/* CNPJ — só clientes/fornecedores */}
                                    {(selectedTable === 'SA1010' || selectedTable === 'SA2010') && (<>
                                        <div className="input-group" style={{ margin: 0 }}>
                                            <label className="label" style={{ fontSize: '0.75rem' }}>CNPJ/CPF</label>
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: 00000000000100" value={filterCgc} onChange={e => setFilterCgc(e.target.value)} />
                                        </div>

                                        {/* Estado */}
                                        <div className="input-group" style={{ margin: 0 }}>
                                            <label className="label" style={{ fontSize: '0.75rem' }}>Estado (UF)</label>
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: SP" maxLength={2} value={filterEstado} onChange={e => setFilterEstado(e.target.value)} />
                                        </div>

                                        {/* Município */}
                                        <div className="input-group" style={{ margin: 0, gridColumn: '1 / -1' }}>
                                            <label className="label" style={{ fontSize: '0.75rem' }}>Município</label>
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: SAO PAULO" value={filterMunicipio} onChange={e => setFilterMunicipio(e.target.value)} />
                                        </div>
                                    </>)}

                                    {/* Grupo — só SB1010 */}
                                    {selectedTable === 'SB1010' && (
                                        <div className="input-group" style={{ margin: 0 }}>
                                            <label className="label" style={{ fontSize: '0.75rem' }}>Grupo (B1_GRUPO)</label>
                                            <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                                placeholder="ex: 001" value={filterGrupo} onChange={e => setFilterGrupo(e.target.value)} />
                                        </div>
                                    )}
                                </div>

                                {/* Status SAP (__sap_id) — painel cadastros */}
                                <div className="input-group" style={{ margin: '0.6rem 0 0' }}>
                                    <label className="label" style={{ fontSize: '0.75rem' }}>🔗 Status de Integração SAP</label>
                                    <select
                                        className="input"
                                        style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}
                                        value={filterSapStatus}
                                        onChange={e => { setFilterSapStatus(e.target.value); if (e.target.value !== '') setFilterSapCode(''); }}
                                    >
                                        <option value="">Todos os registros</option>
                                        <option value="null">❌ Não integrados (__sap_id vazio)</option>
                                        <option value="notnull">✅ Já integrados (__sap_id preenchido)</option>
                                    </select>
                                    {filterSapStatus === '' && (
                                        <input className="input" style={{ padding: '0.4rem 0.6rem', fontSize: '0.85rem', marginTop: '0.35rem' }}
                                            placeholder={selectedTable === 'SB1010' ? 'ou busque ItemCode (ex: PARAF-001)' : 'ou busque CardCode (ex: F000688)'}
                                            value={filterSapCode} onChange={e => setFilterSapCode(e.target.value)} />
                                    )}
                                    {/* Botão de ressincronização após reimportação do TOTVS */}
                                    <button
                                        onClick={syncSapCodes}
                                        disabled={syncingSapCodes}
                                        style={{
                                            marginTop: '0.5rem', width: '100%', padding: '0.35rem 0.6rem',
                                            fontSize: '0.75rem', borderRadius: 6, border: '1px solid rgba(99,102,241,0.4)',
                                            background: syncingSapCodes ? 'rgba(99,102,241,0.1)' : 'transparent',
                                            color: 'var(--accent)', cursor: syncingSapCodes ? 'wait' : 'pointer',
                                        }}
                                    >
                                        {syncingSapCodes ? '⏳ Sincronizando...' : '🔄 Ressincronizar __sap_id com SAP'}
                                    </button>
                                    <small style={{ color: 'var(--secondary)', fontSize: '0.7rem' }}>
                                        Use após reimportar tabela do TOTVS para repopular os códigos SAP já integrados.
                                    </small>
                                </div>

                                {/* Badges */}
                                {[filterCodigo, filterNome, filterDescricao, filterFilial, filterEmpfat,
                                    filterCgc, filterEstado, filterMunicipio, filterLoja, filterGrupo, filterSapCode].some(Boolean) && (
                                        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                                            {[
                                                filterFilial && `Filial: ${filterFilial}`,
                                                filterEmpfat && `EmpFat: ${filterEmpfat}`,
                                                filterCodigo && `Cód: ${filterCodigo}`,
                                                filterLoja && `Loja: ${filterLoja}`,
                                                filterNome && `Nome: ${filterNome}`,
                                                filterDescricao && `Desc: ${filterDescricao}`,
                                                filterCgc && `CNPJ: ${filterCgc}`,
                                                filterEstado && `UF: ${filterEstado}`,
                                                filterMunicipio && `Mun: ${filterMunicipio}`,
                                                filterGrupo && `Grupo: ${filterGrupo}`,
                                                filterSapCode && `SAP: ${filterSapCode}`,
                                            ].filter(Boolean).map((label, i) => (
                                                <span key={i} style={{ padding: '2px 8px', borderRadius: 99, fontSize: '0.72rem', backgroundColor: 'rgba(99,102,241,0.2)', color: 'var(--accent)', fontWeight: 600 }}>{label}</span>
                                            ))}
                                            <button
                                                onClick={() => {
                                                    setFilterCodigo(''); setFilterNome(''); setFilterDescricao('');
                                                    setFilterFilial(''); setFilterEmpfat(''); setFilterCgc('');
                                                    setFilterEstado(''); setFilterMunicipio(''); setFilterLoja(''); setFilterGrupo('');
                                                    setFilterSapCode('');
                                                }}
                                                style={{ fontSize: '0.72rem', color: 'var(--secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', textDecoration: 'underline' }}
                                            >Limpar tudo</button>
                                        </div>
                                    )}
                            </div>
                        )}

                        <button
                            className="btn btn-primary"
                            onClick={fetchPreview}
                            disabled={loadingPreview || (selectedTable === 'SE2010' && loadingBranches) || (dataSource === 'excel' && !stagingTable)}
                            style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                        >
                            {loadingPreview ? (
                                <>
                                    <Loader2 className="animate-spin" />
                                    {loadingMessage}
                                </>
                            ) : (
                                <>
                                    <Play size={18} />
                                    Gerar Preview
                                </>
                            )}
                        </button>
                    </div>
                </div>
            )}

            {/* STEP 2 & 3: PREVIEW & EXECUTION */}
            {(step === 'preview' || step === 'executing' || step === 'done') && (
                <div className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1.25rem' }}>
                                Preview: {selectedTable}
                                <span style={{ fontSize: '1rem', fontWeight: 400, marginLeft: '0.5rem', color: 'var(--secondary)' }}>
                                    ({previewList.length} registros)
                                </span>
                            </h2>
                            {step === 'preview' || step === 'done' ? (
                                <button onClick={() => setStep('select')} style={{ fontSize: '0.85rem', color: 'var(--accent)', marginTop: '0.25rem', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                                    &larr; Voltar para seleção
                                </button>
                            ) : null}
                            {/* Badge filial selecionada */}
                            {selectedTable === 'SE2010' && selectedBranchName && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.4rem', fontSize: '0.82rem', color: 'var(--accent)' }}>
                                    <Building2 size={13} />
                                    Filial: <strong>{selectedBranchName}</strong>
                                    <span style={{ color: 'var(--secondary)', marginLeft: '2px' }}>(BPLId: {selectedBplId})</span>
                                </div>
                            )}
                        </div>

                        {step === 'preview' && (
                            <button type="button" className="btn btn-primary" onClick={handleExecute}>
                                <Play size={18} style={{ marginRight: '0.5rem' }} /> Iniciar Integração
                            </button>
                        )}

                        {(step === 'executing' || step === 'done') && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', textAlign: 'right' }}>
                                {step === 'executing' && (
                                    <button 
                                        type="button" 
                                        style={{
                                            display: 'flex', 
                                            alignItems: 'center', 
                                            gap: '0.5rem', 
                                            padding: '0.5rem 1rem', 
                                            borderRadius: '6px', 
                                            border: 'none', 
                                            background: isInterrupting ? 'var(--secondary)' : '#ef4444', 
                                            color: '#fff', 
                                            cursor: isInterrupting ? 'wait' : 'pointer',
                                            fontWeight: 600
                                        }}
                                        onClick={handleInterrupt} 
                                        disabled={isInterrupting}
                                    >
                                        <AlertCircle size={16} />
                                        {isInterrupting ? 'Interrompendo...' : 'Interromper'}
                                    </button>
                                )}
                                <div>
                                    <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                                        {progress.current} / {progress.total}
                                    </div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>
                                        <span style={{ color: 'var(--success)' }}>{progress.success} Sucessos</span> •
                                        <span style={{ color: 'var(--error)', marginLeft: '4px' }}>{progress.error} Erros</span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* ── Banner: filtro de períodos contábeis ── */}
                    {periodFilterWarning && (
                        <div style={{
                            display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                            padding: '0.65rem 1rem', borderRadius: '8px', marginBottom: '1rem',
                            backgroundColor: 'rgba(245,158,11,0.1)',
                            border: '1px solid rgba(245,158,11,0.3)',
                            color: '#f59e0b', fontSize: '0.85rem',
                        }}>
                            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '1px' }} />
                            <span>{periodFilterWarning}</span>
                        </div>
                    )}
                    {!periodFilterWarning && (selectedTable === 'SE2010' || selectedTable === 'SE1010') && step === 'preview' && (
                        <div style={{
                            display: 'flex', alignItems: 'center', gap: '0.6rem',
                            padding: '0.55rem 1rem', borderRadius: '8px', marginBottom: '1rem',
                            backgroundColor: 'rgba(16,185,129,0.08)',
                            border: '1px solid rgba(16,185,129,0.25)',
                            color: '#10b981', fontSize: '0.82rem',
                        }}>
                            <CheckCircle size={14} style={{ flexShrink: 0 }} />
                            <span>Exibindo apenas lançamentos dentro dos <strong>períodos contábeis em aberto</strong> (OFPR).</span>
                        </div>
                    )}

                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--card-border)', textAlign: 'left' }}>
                                    <th style={{ padding: '0.75rem', width: '50px' }}>St</th>
                                    <th style={{ padding: '0.75rem' }}>Chave (Origem)</th>
                                    <th style={{ padding: '0.75rem' }}>Chave (Destino/SAP)</th>
                                    <th style={{ padding: '0.75rem' }}>Ação</th>
                                    <th style={{ padding: '0.75rem', width: '60px' }}>JSON</th>
                                </tr>
                            </thead>
                            <tbody>
                                {previewList.map((row, idx) => (
                                    <React.Fragment key={idx}>
                                        <tr id={`preview-row-${idx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', backgroundColor: idx % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent' }}>
                                            <td style={{ padding: '0.75rem', textAlign: 'center' }}>
                                                {row.status ? getStatusIcon(row.status) : (
                                                    <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--secondary)', display: 'inline-block', opacity: 0.3 }}></span>
                                                )}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {selectedTable === 'SE2010'
                                                    ? [
                                                        row.source?.e2_fornece,
                                                        row.source?.e2_prefixo,
                                                        row.source?.e2_num,
                                                        row.source?.e2_parcela,
                                                        row.source?.e2_tipo
                                                    ].filter(Boolean).map((v: string) => v.trim()).filter(Boolean).join('/')
                                                    : selectedTable === 'SE1010'
                                                        ? [
                                                            row.source?.e1_cliente,
                                                            row.source?.e1_prefixo,
                                                            row.source?.e1_num,
                                                            row.source?.e1_parcela,
                                                            row.source?.e1_tipo
                                                        ].filter(Boolean).map((v: string) => v.trim()).filter(Boolean).join('/')
                                                        : ['SA1010', 'SA2010', 'SB1010'].includes(selectedTable) 
                                                            ? (row.source?.a1_cod || row.source?.a2_cod || row.source?.b1_cod || '---')
                                                            : (
                                                                <div style={{ display: 'grid', gridTemplateColumns: 'min-content 1fr', gap: '2px 8px', fontSize: '0.75rem', marginTop: '4px' }}>
                                                                    {Object.entries(row.source || {})
                                                                        .filter(([k]) => !k.startsWith('__') && k !== 'd_e_l_e_t_' && k !== 'id')
                                                                        .slice(0, 4)
                                                                        .map(([k, v]) => (
                                                                            <React.Fragment key={k}>
                                                                                <span style={{ color: 'var(--secondary)', textAlign: 'right' }}>{k}:</span>
                                                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>{String(v)}</span>
                                                                            </React.Fragment>
                                                                        ))}
                                                                </div>
                                                            )
                                                }
                                                <br />
                                                {selectedTable === 'SE2010' && (
                                                    <div style={{ fontSize: '0.78rem', marginTop: '3px', lineHeight: 1.4 }}>
                                                        {row.source?.e2_nomfor && (
                                                            <span style={{ opacity: 0.75, display: 'block' }}>
                                                                {row.source.e2_nomfor.toString().trim()}
                                                            </span>
                                                        )}
                                                        {row.source?.e2_hist && (
                                                            <span style={{ opacity: 0.55, display: 'block', fontStyle: 'italic' }}>
                                                                {row.source.e2_hist.toString().trim().slice(0, 60)}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                {selectedTable === 'SE1010' && (
                                                    <div style={{ fontSize: '0.78rem', marginTop: '3px', lineHeight: 1.4 }}>
                                                        {row.source?.e1_nomcli && (
                                                            <span style={{ opacity: 0.75, display: 'block' }}>
                                                                {row.source.e1_nomcli.toString().trim()}
                                                            </span>
                                                        )}
                                                        {row.source?.e1_hist && (
                                                            <span style={{ opacity: 0.55, display: 'block', fontStyle: 'italic' }}>
                                                                {row.source.e1_hist.toString().trim().slice(0, 60)}
                                                            </span>
                                                        )}
                                                    </div>
                                                )}
                                                {selectedTable !== 'SE2010' && selectedTable !== 'SE1010' && (
                                                    <small style={{ opacity: 0.6 }}>
                                                        {row.source?.a1_nome || row.source?.a2_nome || row.source?.b1_desc || ''}
                                                        {!['SA1010', 'SA2010', 'SB1010'].includes(selectedTable) && (
                                                            <div style={{ marginTop: '2px' }}>
                                                                Expandir para ver chaves e valores completos
                                                            </div>
                                                        )}
                                                    </small>
                                                )}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                {selectedTable === 'SE2010'
                                                    ? (
                                                        <>
                                                            <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                                                                {row.target?.Memo
                                                                    ? row.target.Memo.toString().replace(/^CP\s+/, '').split(' ')[0]
                                                                    : '---'}
                                                            </span>
                                                            {row.target?.Reference1 && (
                                                                <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: '2px' }}>
                                                                    Ref1/Ref2 (SAP): <code>{row.target.Reference1}</code>
                                                                </div>
                                                            )}
                                                        </>
                                                    )
                                                    : row.target?.CardCode || row.target?.ItemCode || row.target?.DocNum || row.target?.Code || row.target?.AcctCode || '---'
                                                }
                                                {row.matchMethod === 'tax_id' && (
                                                    <div style={{ fontSize: '0.72rem', color: 'var(--secondary)', marginTop: '2px' }}>
                                                        Origem: {row.source?.a2_cod || row.source?.a1_cod || row.source?.b2_cod || '?'}
                                                        <span style={{ margin: '0 4px', opacity: 0.5 }}>→</span>
                                                        SAP: <strong style={{ color: '#fb923c' }}>{row.target?.CardCode}</strong>
                                                    </div>
                                                )}
                                            </td>
                                            <td style={{ padding: '0.75rem' }}>
                                                <span style={{
                                                    padding: '2px 8px',
                                                    borderRadius: '4px',
                                                    fontSize: '0.75rem',
                                                    backgroundColor: row.action === 'insert'
                                                        ? 'rgba(34, 197, 94, 0.2)'
                                                        : row.matchMethod === 'tax_id'
                                                            ? 'rgba(251, 146, 60, 0.2)'
                                                            : 'rgba(234, 179, 8, 0.2)',
                                                    color: row.action === 'insert'
                                                        ? '#22c55e'
                                                        : row.matchMethod === 'tax_id'
                                                            ? '#fb923c'
                                                            : '#eab308'
                                                }}>
                                                    {row.action === 'insert'
                                                        ? 'INCLUSÃO'
                                                        : row.matchMethod === 'tax_id'
                                                            ? '✓ ATUALIZ. via CNPJ/CPF'
                                                            : 'ATUALIZAÇÃO'
                                                    }
                                                </span>
                                                <div style={{ fontSize: '0.65rem', marginTop: '4px', opacity: 0.7, color: 'var(--accent)', fontFamily: 'monospace' }}>
                                                    /b1s/v1/{
                                                        dataSource === 'protheus' ? (
                                                            selectedTable.startsWith('SA') ? 'BusinessPartners' :
                                                                selectedTable.startsWith('SB') ? 'Items' :
                                                                    selectedTable === 'SE1010' ? 'Orders' :
                                                                        selectedTable === 'SE2010' ? 'JournalEntries' :
                                                                            'PurchaseInvoices'
                                                        ) : selectedTable
                                                    }
                                                </div>
                                                {row.message && (
                                                    <div style={{
                                                        fontSize: '0.72rem',
                                                        color: row.status === 'error'
                                                            ? 'var(--error)'
                                                            : row.status === 'success'
                                                                ? 'var(--success)'
                                                                : '#fb923c',
                                                        marginTop: '4px',
                                                        maxWidth: '320px',
                                                        lineHeight: 1.4
                                                    }}>
                                                        {row.message}
                                                    </div>
                                                )}
                                            </td>
                                            <td style={{ padding: '0.75rem', textAlign: 'center' }}>
                                                <button onClick={() => toggleRow(idx)} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' }}>
                                                    {expandedRow === idx ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                                                </button>
                                            </td>
                                        </tr>
                                        {expandedRow === idx && (
                                            <tr>
                                                <td colSpan={5} style={{ padding: '0', backgroundColor: 'rgba(0,0,0,0.3)' }}>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '1rem' }}>
                                                        <div>
                                                            <strong style={{ display: 'block', marginBottom: '0.5rem', color: '#a1a1aa' }}>Origem ({dataSource === 'excel' ? 'Planilha' : 'Protheus'})</strong>
                                                            <pre style={{ fontSize: '0.75rem', padding: '0.5rem', backgroundColor: '#000', borderRadius: '4px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '300px' }}>
                                                                {JSON.stringify(row.source, null, 2)}
                                                            </pre>
                                                        </div>
                                                        <div>
                                                            <strong style={{ display: 'block', marginBottom: '0.5rem', color: '#a1a1aa' }}>Destino (SAP / Service Layer)</strong>
                                                            <pre style={{ fontSize: '0.75rem', padding: '0.5rem', backgroundColor: '#000', borderRadius: '4px', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '300px' }}>
                                                                {JSON.stringify(row.target, null, 2)}
                                                            </pre>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )
            }
        </div >
    );
}
