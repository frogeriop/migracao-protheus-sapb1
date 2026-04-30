'use client';

import { useState, useEffect, useRef } from 'react';
import { Layers, ArrowRight, Settings, Plus, Save, Trash2, Edit, Play, Loader2 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useMapping } from '@/hooks/useMapping';
import { useConfig } from '@/hooks/useConfig';
import { FieldMapping, MappingRule, OrderLineTemplate, OrderLineTemplatesConfig, ResultCenterDistributionConfig, ResultCenterLine, RuleType, ValueMap } from '@/types/mapping';
import { TransformationUtils, runtimeTodayPlaceholder } from '@/utils/transformations';
import { buildOrderLinesFromTemplates } from '@/utils/orderLineTemplates';
import { buildResultCenterDocumentLines } from '@/utils/resultCenterDistribution';
import { supabase } from '@/lib/supabase';

type TableOption = { code: string; name: string; targetObject?: string; isExcel?: boolean; pgTableName?: string };

/** Preview local: campos vêm como DocumentLines aninhado (API) ou chaves planas "DocumentLines.ItemCode". */
function pickDocumentLineBaseFromPreviewTarget(tr: Record<string, any>): Record<string, any> {
    if (tr.DocumentLines && typeof tr.DocumentLines === 'object' && !Array.isArray(tr.DocumentLines)) {
        return { ...tr.DocumentLines };
    }
    const base: Record<string, any> = {};
    for (const k of Object.keys(tr)) {
        if (k.startsWith('DocumentLines.')) {
            base[k.slice('DocumentLines.'.length)] = tr[k];
        }
    }
    return base;
}

const PROTHEUS_TABLE_OPTIONS: TableOption[] = [
    { code: 'SA1010', name: 'Clientes', targetObject: 'BusinessPartners', isExcel: false },
    { code: 'SA2010', name: 'Fornecedores', targetObject: 'BusinessPartners', isExcel: false },
    { code: 'SB1010', name: 'Produtos', targetObject: 'Items', isExcel: false },
    { code: 'SU5010', name: 'Contatos (cliente)', targetObject: 'ContactEmployees', isExcel: false },
    { code: 'SE1010', name: 'Contas a Receber', targetObject: 'Orders', isExcel: false },
    { code: 'SE2010', name: 'Contas a Pagar', targetObject: 'JournalEntries', isExcel: false },
];

const COMMON_SAP_FIELDS: { [key: string]: string[] } = {
    'BusinessPartnerGroups': ['Code', 'Name', 'Type'],
    'ProfitCenters': ['CenterCode', 'CenterName', 'CostCenterType', 'CenterOwner', 'Active', 'GroupCode', 'InWhichDimension', 'EffectiveFrom'],
    'BusinessPartners': [
        'CardCode', 'CardName', 'AliasName', 'CardType', 'GroupCode', 'Phone1', 'Phone2', 'Cellular', 'EmailAddress', 'Website', 'Notes', 'FederalTaxID',
        'BPAddresses.AddressName', 'BPAddresses.Street', 'BPAddresses.StreetNo', 'BPAddresses.Block', 'BPAddresses.ZipCode', 'BPAddresses.City',
        'BPAddresses.County', 'BPAddresses.State', 'BPAddresses.Country', 'BPAddresses.AddressType', 'BPAddresses.AddrType', 'BPAddresses.TaxCode', 'BPAddresses.BuildingFloorRoom',
        'BPAddresses.U_TX_CNAE',
        'BPFiscalTaxIDCollection.TaxId0', 'BPFiscalTaxIDCollection.TaxId1', 'BPFiscalTaxIDCollection.TaxId2', 'BPFiscalTaxIDCollection.TaxId3', 'BPFiscalTaxIDCollection.TaxId4',
        'BPFiscalTaxIDCollection.CNAECode',
        'U_TX_IE', 'U_TX_CNPJ', 'U_TX_INDFINAL', 'U_TX_INDIEDEST'
    ],
    'Items': ['ItemCode', 'ItemName', 'ItemsGroupCode', 'ForeignName', 'SalesUnit', 'PurchaseUnit', 'InventoryItem', 'SalesItem', 'PurchaseItem', 'QuantityOnStock'],
    // Cabeçalho da Sales Order (SE1010 → SAP Orders)
    'Orders': [
        'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'NumAtCard', 'Comments',
        'DocCurrency', 'Series', 'BPL_IDAssignedToInvoice',
        'DocumentLines.ItemCode', 'DocumentLines.Quantity', 'DocumentLines.UnitPrice',
        'DocumentLines.TaxCode', 'DocumentLines.AccountCode', 'DocumentLines.CostingCode',
        'DocumentLines.CostingCode2', 'DocumentLines.LineTotal',
    ],
    'JournalEntries': [
        'ReferenceDate', 'DueDate', 'TaxDate', 'Reference', 'Reference2', 'TransactionCode',
        'ProjectCode', 'Indicator', 'UseAutoStorno', 'StornDate',
        'JournalEntryLines.AccountCode', 'JournalEntryLines.Debit', 'JournalEntryLines.Credit',
        'JournalEntryLines.LineMemo', 'JournalEntryLines.CostingCode', 'JournalEntryLines.ProjectCode',
    ],
    'ContactEmployees': ['CardCode', 'Name', 'Position', 'Phone1', 'E_Mail'],
    // Legacy (mantido para compatibilidade)
    'Invoices': ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocTotal', 'Comments'],
    'PurchaseInvoices': ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocTotal', 'Comments']
};

export default function MappingPage() {
    const { config: mappings, updateTableMapping, loading: mappingLoading } = useMapping();
    const [tableOptions, setTableOptions] = useState<TableOption[]>(PROTHEUS_TABLE_OPTIONS);
    const [selectedTableCode, setSelectedTableCode] = useState<string>('SA1010');
    const [sourceColumns, setSourceColumns] = useState<string[]>([]);
    const [loadingSourceCols, setLoadingSourceCols] = useState(false);

    // Campos de usuário (UDFs) do SAP — carregados dinamicamente por objeto
    const [sapUserFields, setSapUserFields] = useState<string[]>([]);
    const [loadingUserFields, setLoadingUserFields] = useState(false);

    const selectedTableOpt = tableOptions.find(o => o.code === selectedTableCode) || PROTHEUS_TABLE_OPTIONS[0];
    const rawTargetObject = selectedTableOpt.targetObject || 'Unknown';
    const queryTableName = selectedTableOpt.isExcel ? (selectedTableOpt.pgTableName || selectedTableCode) : selectedTableCode;

    // Load Excel Entities
    useEffect(() => {
        const fetchEntities = async () => {
            try {
                const res = await fetch('/api/migration/entities');
                const json = await res.json();
                if (json.success && json.data) {
                    const excelOptions: TableOption[] = json.data.map((ent: any) => ({
                        code: `EXCEL_${ent.id}`,
                        name: ent.name,
                        targetObject: ent.target_object,
                        isExcel: true,
                        pgTableName: ent.staging_table || `stg_${ent.target_object.toLowerCase()}_${ent.id}`
                    }));
                    setTableOptions([...PROTHEUS_TABLE_OPTIONS, ...excelOptions]);
                }
            } catch (e) {
                console.error('Failed to load excel entities:', e);
            }
        };
        fetchEntities();
    }, []);

    // Preview State
    const [showPreview, setShowPreview] = useState(false);
    const [previewData, setPreviewData] = useState<{ source: any, target: any } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    // Modal State
    const [showRuleModal, setShowRuleModal] = useState(false);
    const [currentField, setCurrentField] = useState<FieldMapping | null>(null);
    const [ruleType, setRuleType] = useState<RuleType>('none');
    const [ruleValue, setRuleValue] = useState('');
    const [mapValues, setMapValues] = useState<ValueMap[]>([]);
    const [addressPart, setAddressPart] = useState<'street' | 'number' | 'complement' | 'type'>('street');
    const [condField, setCondField] = useState('');
    const [condValue, setCondValue] = useState('');

    // Lookup State
    const [lookupTable, setLookupTable] = useState('');
    const [lookupKey, setLookupKey] = useState('');
    const [lookupValue, setLookupValue] = useState('');

    // SAP Sequence State
    const [seriesCode, setSeriesCode] = useState<number | ''>('');
    const [objectType, setObjectType] = useState('');
    const [sapSeriesList, setSapSeriesList] = useState<{ Series: number, Name: string, IsDefault: string }[]>([]);
    const [loadingSapSeries, setLoadingSapSeries] = useState(false);

    useEffect(() => {
        if (ruleType === 'sap_sequence' && objectType) {
            let isCurrent = true;
            const fetchSeries = async () => {
                setLoadingSapSeries(true);
                try {
                    const res = await fetch(`/api/sap/series?objectType=${objectType}`);
                    const json = await res.json();
                    if (isCurrent && json.success) {
                        setSapSeriesList(json.series || []);
                    }
                } catch (e) {
                    console.error('Falha ao buscar séries:', e);
                } finally {
                    if (isCurrent) setLoadingSapSeries(false);
                }
            };
            fetchSeries();
            return () => { isCurrent = false; };
        } else {
            setSapSeriesList([]);
        }
    }, [ruleType, objectType]);

    const [editingIndex, setEditingIndex] = useState<number>(-1);

    /** SE1010 → Orders: várias linhas por fórmula (orderLineTemplates) */
    const [orderLineTplDraft, setOrderLineTplDraft] = useState<OrderLineTemplatesConfig>({
        lines: [],
        compareTotalField: 'e1_valor',
        reconcileLastLine: false,
    });

    const [resultCenterTplDraft, setResultCenterTplDraft] = useState<ResultCenterDistributionConfig>({
        lines: [],
        compareTotalField: 'e1_valor',
        reconcileLastLine: false,
        lineDimensionField: 'CostingCode2',
        distributionMode: 'singleLine',
        inWhichDimension: 2,
    });

    useEffect(() => {
        if (selectedTableCode !== 'SE1010' || rawTargetObject !== 'Orders') return;
        const m = mappings[selectedTableCode];
        const ot = m?.orderLineTemplates;
        if (ot && Array.isArray(ot.lines)) {
            setOrderLineTplDraft({
                lines: ot.lines.length > 0 ? ot.lines.map((l: OrderLineTemplate) => ({ ...l })) : [],
                compareTotalField: ot.compareTotalField ?? 'e1_valor',
                reconcileLastLine: ot.reconcileLastLine ?? false,
            });
        } else {
            setOrderLineTplDraft({
                lines: [],
                compareTotalField: 'e1_valor',
                reconcileLastLine: false,
            });
        }
        const rc = m?.resultCenterDistribution;
        if (rc && Array.isArray(rc.lines)) {
            setResultCenterTplDraft({
                lines: rc.lines.length > 0 ? rc.lines.map((l: ResultCenterLine) => ({ ...l })) : [],
                compareTotalField: rc.compareTotalField ?? 'e1_valor',
                reconcileLastLine: rc.reconcileLastLine ?? false,
                lineDimensionField: rc.lineDimensionField ?? 'CostingCode2',
                distributionMode: rc.distributionMode,
                inWhichDimension: rc.inWhichDimension ?? 2,
            });
        } else {
            setResultCenterTplDraft({
                lines: [],
                compareTotalField: 'e1_valor',
                reconcileLastLine: false,
                lineDimensionField: 'CostingCode2',
                distributionMode: 'singleLine',
                inWhichDimension: 2,
            });
        }
    }, [selectedTableCode, rawTargetObject, mappings]);

    // Lookup Composite state
    const [lookupFallback, setLookupFallback] = useState('');
    // For lookup_composite: source fields (two inputs) and lookup key fields (two inputs)
    const [ckSourceFields, setCkSourceFields] = useState<string[]>(['', '']);
    const [ckLookupKeyFields, setCkLookupKeyFields] = useState<string[]>(['', '']);

    // Colunas conhecidas por tabela (fallback imediato, antes do fetch)
    const KNOWN_COLS: Record<string, string[]> = {
        sa1010: ['a1_filial', 'a1_cod', 'a1_loja', 'a1_nome', 'a1_nreduz', 'a1_cgc', 'a1_tipo', 'a1_est', 'a1_mun', 'a1_tel', 'a1_email', 'a1_end', '__sap_id'],
        sa2010: ['a2_filial', 'a2_cod', 'a2_loja', 'a2_nome', 'a2_nreduz', 'a2_cgc', 'a2_tipo', 'a2_est', 'a2_mun', 'a2_tel', 'a2_email', 'a2_end', '__sap_id'],
        sb1010: ['b1_filial', 'b1_cod', 'b1_desc', 'b1_tipo', 'b1_um', 'b1_grupo', 'b1_localiz', '__sap_id'],
        su5010: ['u5_filial', 'u5_codcont', 'u5_cliente', 'u5_loja', 'u5_contat', 'u5_email', 'u5_fcom1', 'u5_fone', 'u5_ddd', 'u5_dfuncao', 'u5_funcao', '__sap_id'],
        sed010: ['ed_filial', 'ed_codigo', 'ed_descri', 'ed_naturez', 'sap_account_code', 'sap_account_name'],
        sap_items: ['item_code', 'item_name', 'item_type', 'svc_code', 'u_svc_code', 'purchase', 'sales', 'imported_at'],
        sap_chart_of_accounts: ['code', 'name', 'account_type', 'external_code', 'currency', 'father_account', 'balance'],
        sap_cost_centers: ['code', 'name'],
        sap_business_places: ['bpl_id', 'bpl_name', 'federal_tax_id', 'city', 'state', 'country', 'zip_code'],
        ibge_municipios: ['codigo_ibge', 'nome_municipio', 'uf', 'nome_uf', 'municipio', 'codigo_municipio_completo'],
        sap_cnaes: ['id', 'code', 'description'],
    };

    // Colunas da tabela de lookup (carregadas dinamicamente)
    const [lookupTableCols, setLookupTableCols] = useState<string[]>([]);
    const [lookupTableColsLoading, setLookupTableColsLoading] = useState(false);

    // Estado da busca para o Testar Preview
    const [previewSearch, setPreviewSearch] = useState('');

    // Busca dinâmica das colunas — aplica fallback imediato e enriquece via API
    const fetchLookupCols = async (table: string) => {
        if (!table) { setLookupTableCols([]); return; }
        // Aplica imediatamente as colunas conhecidas
        const known = KNOWN_COLS[table] ?? [];
        if (known.length > 0) setLookupTableCols(known);
        // Tenta enriquecer via API (pode conter colunas extras reais)
        setLookupTableColsLoading(true);
        try {
            const res = await fetch(`/api/data?table=${table}&limit=1`);
            const json = await res.json();
            if (json.success && json.data && json.data.length > 0) {
                const dynamic = Object.keys(json.data[0]);
                // Merge: mantém conhecidos + adiciona qualquer extra real
                const merged = Array.from(new Set([...known, ...dynamic])).sort();
                setLookupTableCols(merged);
            }
            // Se tabela vazia mas há colunas conhecidas, mantém as conhecidas
        } catch {
            // mantém as colunas conhecidas já aplicadas
        } finally {
            setLookupTableColsLoading(false);
        }
    };

    // Fetch Source Cols on Table Select
    useEffect(() => {
        if (!queryTableName) return;
        let cancelled = false;
        const fetchCols = async () => {
            setLoadingSourceCols(true);
            try {
                const res = await fetch(`/api/data?action=columns&table=${queryTableName}`);
                const json = await res.json();
                if (cancelled) return;
                if (json.success && Array.isArray(json.data) && json.data.length > 0) {
                    const hiddenCols = ['id', 'd_e_l_e_t_', '__source_key', '__sap_id', '__integration_status', '__sync_message', '__last_sync', 'r_e_c_n_o_'];
                    const cols = json.data.filter((c: string) => !hiddenCols.includes(c));
                    setSourceColumns(cols.length > 0 ? cols : ['(Sem colunas mapeáveis)']);
                } else {
                    setSourceColumns(['(Tabela vazia ou sem estrutura)']);
                }
            } catch (e) {
                if (!cancelled) console.error(e);
            } finally {
                if (!cancelled) setLoadingSourceCols(false);
            }
        };
        fetchCols();
        return () => { cancelled = true; };
    }, [queryTableName]);

    // Busca campos de usuário (UDFs) do SAP ao mudar o objeto destino
    useEffect(() => {
        if (!rawTargetObject || rawTargetObject === 'Unknown') {
            setSapUserFields([]);
            return;
        }
        let cancelled = false;
        const fetchUserFields = async () => {
            setLoadingUserFields(true);
            try {
                const res = await fetch(`/api/sap/user-fields?object=${encodeURIComponent(rawTargetObject)}`);
                const json = await res.json();
                if (!cancelled && json.success && Array.isArray(json.fields)) {
                    setSapUserFields(json.fields);
                } else if (!cancelled) {
                    setSapUserFields([]);
                }
            } catch {
                if (!cancelled) setSapUserFields([]);
            } finally {
                if (!cancelled) setLoadingUserFields(false);
            }
        };
        fetchUserFields();
        return () => { cancelled = true; };
    }, [rawTargetObject]);



    const handleAddField = () => {
        const currentMapping = mappings[selectedTableCode] || { sourceTable: selectedTableCode, targetObject: rawTargetObject, fields: [] };
        const newField: FieldMapping = { source: '', target: '' };
        updateTableMapping(selectedTableCode, { ...currentMapping, fields: [...currentMapping.fields, newField] });
    };

    const handleRemoveField = (index: number) => {
        const currentMapping = mappings[selectedTableCode];
        if (!currentMapping) return;
        const newFields = [...currentMapping.fields];
        newFields.splice(index, 1);
        updateTableMapping(selectedTableCode, { ...currentMapping, fields: newFields });
    };

    const handleChangeField = (index: number, key: 'source' | 'target', value: string) => {
        const currentMapping = mappings[selectedTableCode];
        if (!currentMapping) return;
        const newFields = [...currentMapping.fields];
        newFields[index] = { ...newFields[index], [key]: value };
        updateTableMapping(selectedTableCode, { ...currentMapping, fields: newFields });
    };

    const openRuleModal = (field: FieldMapping, index: number) => {
        setCurrentField({ ...field });
        setRuleType(field.rule?.type || 'none');
        if (field.rule?.type === 'expression') {
            setRuleValue(field.rule?.expression || '');
        } else if (field.rule?.type === 'today') {
            setRuleValue(field.rule?.value || 'iso');
        } else {
            setRuleValue(field.rule?.value || field.rule?.expression || '');
        }
        setMapValues(field.rule?.map || []);
        setCondField(field.rule?.condition?.field || '');
        setCondValue(field.rule?.condition?.value || '');

        setLookupTable(field.rule?.lookupTable || '');
        setLookupKey(field.rule?.lookupKey || '');
        setLookupValue(field.rule?.lookupValue || '');
        setLookupFallback(field.rule?.lookupFallback || '');
        // Carrega as colunas da tabela de lookup ao abrir o modal
        if (field.rule?.lookupTable) fetchLookupCols(field.rule.lookupTable);
        else setLookupTableCols([]);

        // Composite key
        const ck = field.rule?.compositeKey;
        setCkSourceFields(ck?.sourceFields || ['', '']);
        setCkLookupKeyFields(ck?.lookupKeyFields || ['', '']);

        setSeriesCode(field.rule?.seriesCode ?? '');
        
        let defaultObjType = field.rule?.objectType || '';
        if (!defaultObjType) {
            if (selectedTableCode === 'SA1010') defaultObjType = 'bp_customer';
            else if (selectedTableCode === 'SA2010') defaultObjType = 'bp_supplier';
        }
        setObjectType(defaultObjType);

        // @ts-ignore
        setAddressPart(field.rule?.part || 'street');
        setShowRuleModal(true);
        setEditingIndex(index);
    };

    const saveRule = () => {
        if (editingIndex === -1 || !selectedTableCode) return;

        const currentMapping = mappings[selectedTableCode];
        const newFields = [...currentMapping.fields];

        const rule: MappingRule = { type: ruleType };
        if (ruleType === 'prefix' || ruleType === 'suffix') {
            rule.value = ruleValue;
        } else if (ruleType === 'static') {
            rule.value = ruleValue;
        } else if (ruleType === 'today') {
            rule.value = (ruleValue || 'iso').trim() || 'iso';
        } else if (ruleType === 'expression') {
            rule.expression = ruleValue;
        } else if (ruleType === 'map') {
            rule.map = mapValues;
        } else if (ruleType === 'address_part') {
            rule.part = addressPart;
        } else if (ruleType === 'lookup') {
            rule.lookupTable = lookupTable;
            rule.lookupKey = lookupKey;
            rule.lookupValue = lookupValue;
            if (lookupFallback) rule.lookupFallback = lookupFallback;
        } else if (ruleType === 'lookup_composite') {
            rule.lookupTable = lookupTable;
            rule.lookupValue = lookupValue;
            rule.compositeKey = {
                sourceFields: ckSourceFields.filter(Boolean),
                lookupKeyFields: ckLookupKeyFields.filter(Boolean),
            };
            if (lookupFallback) rule.lookupFallback = lookupFallback;
        } else if (ruleType === 'sap_sequence') {
            rule.objectType = objectType;
            if (seriesCode !== '') rule.seriesCode = Number(seriesCode);
        }

        if (condField && condValue) {
            rule.condition = { field: condField, operator: 'equals', value: condValue };
        }

        // Para regra 'static', 'expression' e 'today', source não é necessário — limpa para evitar confusão
        const updatedField = { ...newFields[editingIndex], rule };
        if (ruleType === 'static' || ruleType === 'expression' || ruleType === 'today') updatedField.source = '';
        newFields[editingIndex] = updatedField;
        updateTableMapping(selectedTableCode, { ...currentMapping, fields: newFields });
        setShowRuleModal(false);
    };

    const addMapValue = () => {
        setMapValues([...mapValues, { from: '', to: '' }]);
    };

    const removeMapValue = (idx: number) => {
        const newMap = [...mapValues];
        newMap.splice(idx, 1);
        setMapValues(newMap);
    };

    const updateMapValue = (idx: number, key: keyof ValueMap, val: string) => {
        const newMap = [...mapValues];
        newMap[idx] = { ...newMap[idx], [key]: val };
        setMapValues(newMap);
    };

    const handlePreview = async () => {
        const currentMapping = mappings[selectedTableCode];
        if (!currentMapping || currentMapping.fields.length === 0) {
            alert('Configure o mapeamento antes de visualizar.');
            return;
        }

        setPreviewLoading(true);

        try {
            // Fetch one record
            const url = `/api/data?table=${queryTableName}&limit=1${previewSearch ? `&search=${encodeURIComponent(previewSearch)}` : ''}`;
            const res = await fetch(url);
            const json = await res.json();

            if (!json.success || !json.data || json.data.length === 0) {
                alert('Não foi possível obter dados de exemplo.');
                return;
            }

            const sourceRecord = json.data[0];
            const targetRecord: any = {};

            // Apply logical transformation
            currentMapping.fields.forEach(field => {
                if (!field.target) return;

                // Para tipo 'static', 'sap_sequence' ou 'expression', source não é obrigatório
                const isSourceOptional =
                    field.rule?.type === 'static' ||
                    field.rule?.type === 'sap_sequence' ||
                    field.rule?.type === 'expression' ||
                    field.rule?.type === 'today';
                if (!isSourceOptional && !field.source) return;

                const originalValue = field.source ? sourceRecord[field.source] : undefined;

                // Pula campos sem valor de origem APENAS para regras que exigem origem
                if (!isSourceOptional && (originalValue === undefined || originalValue === null)) return;

                let finalValue: any = typeof originalValue === 'string' ? originalValue.trim() : originalValue;

                // Check condition if exists
                if (field.rule?.condition) {
                    const cond = field.rule.condition;
                    const recordVal = sourceRecord[cond.field];
                    if (cond.operator === 'equals' && String(recordVal) !== String(cond.value)) return;
                    if (cond.operator === 'not_equals' && String(recordVal) === String(cond.value)) return;
                }

                if (field.rule) {
                    switch (field.rule.type) {
                        case 'today': {
                            finalValue = runtimeTodayPlaceholder(field.rule.value || 'iso');
                            break;
                        }
                        case 'static': {
                            // Auto-coerção: '1' → 1, 'true'/'false' → boolean, resto → string
                            const raw = field.rule.value ?? null;
                            if (raw === null || raw === '') {
                                finalValue = raw;
                            } else if (raw === 'true') {
                                finalValue = true;
                            } else if (raw === 'false') {
                                finalValue = false;
                            } else if (!isNaN(Number(raw)) && raw.trim() !== '') {
                                finalValue = Number(raw);
                            } else {
                                finalValue = raw;
                            }
                            break;
                        }
                        case 'expression': {
                            if (field.rule.expression) {
                                finalValue = field.rule.expression.replace(/\{([^}]+)\}/g, (_, key) => {
                                    const val = sourceRecord[key] ?? sourceRecord[key.toUpperCase()] ?? sourceRecord[key.toLowerCase()];
                                    return val !== undefined && val !== null ? String(val).trim() : '';
                                });
                            }
                            break;
                        }
                        case 'prefix':
                            finalValue = (field.rule.value || '') + originalValue;
                            break;
                        case 'suffix':
                            finalValue = originalValue + (field.rule.value || '');
                            break;
                        case 'map': {
                            const mapEntry = field.rule.map?.find(m => m.from == originalValue);
                            if (mapEntry) finalValue = mapEntry.to;
                            break;
                        }
                        case 'address_part': {
                            const parts = TransformationUtils.parseAddress(originalValue);
                            if (field.rule.part && parts[field.rule.part]) {
                                finalValue = parts[field.rule.part];
                            }
                            break;
                        }
                        case 'tax_id':
                            finalValue = TransformationUtils.formatTaxId(originalValue);
                            break;
                        case 'date':
                            if (finalValue && String(finalValue).length === 8) {
                                const s = String(finalValue);
                                finalValue = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
                            }
                            break;
                        case 'date_iso':
                            if (finalValue && typeof finalValue === 'string') {
                                const parts = finalValue.split(/[\/\-]/);
                                if (parts.length >= 3) {
                                    let day, month, year;
                                    if (parts[0].length === 4) {
                                        year = parts[0];
                                        month = parts[1];
                                        day = parts[2];
                                    } else {
                                        day = parts[0].padStart(2, '0');
                                        month = parts[1].padStart(2, '0');
                                        year = parts[2];
                                    }
                                    finalValue = `${year}-${month}-${day}T00:00:00Z`;
                                }
                            }
                            break;
                        case 'sap_sequence':
                            finalValue = `[Sequência SAP - Série: ${field.rule.seriesCode || 'Auto'}]`;
                            break;
                        case 'lookup':
                            // Will be handled asynchronously below
                            break;
                    }
                }

                if (finalValue === null || finalValue === undefined) return;
                targetRecord[field.target] = finalValue;
            });

            // Perform Lookups for Preview
            for (const field of currentMapping.fields) {
                if (field.rule?.type === 'lookup' && field.rule.lookupTable && field.rule.lookupKey && field.rule.lookupValue && sourceRecord[field.source]) {
                    const valToLookup = sourceRecord[field.source];
                    try {
                        const { data, error } = await supabase
                            .from(field.rule.lookupTable)
                            .select(field.rule.lookupValue)
                            .eq(field.rule.lookupKey, valToLookup)
                            .maybeSingle();

                        if (!error && data) {
                            targetRecord[field.target] = data[field.rule.lookupValue as keyof typeof data];
                        } else {
                            targetRecord[field.target] = `(Lookup Falhou: ${valToLookup})`;
                        }
                    } catch (e) {
                        targetRecord[field.target] = '(Erro Lookup)';
                    }
                }
            }

            // SE1010 → Orders: centros de resultado (precede linhas por produto)
            if (selectedTableCode === 'SE1010' && currentMapping.targetObject === 'Orders') {
                const rcDraftHas = resultCenterTplDraft.lines.some(l => String(l.centerCode || '').trim());
                const rcSource = rcDraftHas ? resultCenterTplDraft : currentMapping.resultCenterDistribution;
                if (rcSource?.lines?.length) {
                    const baseLine = pickDocumentLineBaseFromPreviewTarget(targetRecord);
                    const builtRc = buildResultCenterDocumentLines(sourceRecord, {
                        lines: rcSource.lines.filter(l => String(l.centerCode || '').trim()),
                        compareTotalField: rcSource.compareTotalField,
                        reconcileLastLine: rcSource.reconcileLastLine,
                        lineDimensionField: rcSource.lineDimensionField,
                        distributionMode: rcSource.distributionMode,
                    }, baseLine);
                    if (builtRc.lines.length > 0) {
                        targetRecord.DocumentLines = builtRc.lines;
                        (targetRecord as any)._resultCenterFormulaExecutions = builtRc.formulaExecutions;
                        (targetRecord as any)._resultCenterDistributionMeta = {
                            inWhichDimension: rcSource.inWhichDimension ?? 2,
                            distributionMode: rcSource.distributionMode,
                            lineDimensionField: rcSource.lineDimensionField ?? 'CostingCode2',
                        };
                        if (builtRc.warnings.length > 0) {
                            (targetRecord as any)._resultCenterDistributionWarnings = builtRc.warnings;
                        }
                    }
                } else {
                    const tplDraftHasLines = orderLineTplDraft.lines.some(l => String(l.itemCode || '').trim());
                    const tplSource = tplDraftHasLines ? orderLineTplDraft : currentMapping.orderLineTemplates;
                    if (tplSource?.lines?.length) {
                        const built = buildOrderLinesFromTemplates(sourceRecord, {
                            lines: tplSource.lines.filter(l => String(l.itemCode || '').trim()),
                            compareTotalField: tplSource.compareTotalField,
                            reconcileLastLine: tplSource.reconcileLastLine,
                        });
                        if (built.lines.length > 0) {
                            targetRecord.DocumentLines = built.lines;
                            if (built.warnings.length > 0) {
                                (targetRecord as any)._orderLineTemplateWarnings = built.warnings;
                            }
                        }
                    }
                }
            }

            setPreviewData({ source: sourceRecord, target: targetRecord });
            setShowPreview(true);

        } catch (error) {
            console.error(error);
            alert('Erro ao gerar preview.');
        } finally {
            setPreviewLoading(false);
        }
    };

    const currentMapping = mappings[selectedTableCode] || { sourceTable: selectedTableCode, targetObject: rawTargetObject, fields: [] };

    const saveOrderLineTemplates = () => {
        const lines = orderLineTplDraft.lines
            .filter(l => String(l.itemCode || '').trim())
            .map(l => ({
                itemCode: l.itemCode.trim(),
                quantityFormula: l.quantityFormula?.trim() || undefined,
                unitPriceFormula: l.unitPriceFormula?.trim() || undefined,
                lineTotalFormula: l.lineTotalFormula?.trim() || undefined,
            }));
        updateTableMapping(selectedTableCode, {
            ...currentMapping,
            orderLineTemplates: {
                lines,
                compareTotalField: orderLineTplDraft.compareTotalField?.trim() || undefined,
                reconcileLastLine: orderLineTplDraft.reconcileLastLine,
            },
        });
    };

    const addOrderLineRow = () => {
        setOrderLineTplDraft(prev => ({
            ...prev,
            lines: [...prev.lines, { itemCode: '', unitPriceFormula: '' }],
        }));
    };

    const updateOrderLineRow = (idx: number, patch: Partial<OrderLineTemplate>) => {
        setOrderLineTplDraft(prev => ({
            ...prev,
            lines: prev.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
        }));
    };

    const removeOrderLineRow = (idx: number) => {
        setOrderLineTplDraft(prev => ({
            ...prev,
            lines: prev.lines.filter((_, i) => i !== idx),
        }));
    };

    const saveResultCenterDistribution = () => {
        const lines = resultCenterTplDraft.lines
            .filter(l => String(l.centerCode || '').trim())
            .map(l => ({
                centerCode: l.centerCode.trim(),
                quantityFormula: l.quantityFormula?.trim() || undefined,
                unitPriceFormula: l.unitPriceFormula?.trim() || undefined,
                lineTotalFormula: l.lineTotalFormula?.trim() || undefined,
            }));
        updateTableMapping(selectedTableCode, {
            ...currentMapping,
            resultCenterDistribution: {
                lines,
                compareTotalField: resultCenterTplDraft.compareTotalField?.trim() || undefined,
                reconcileLastLine: resultCenterTplDraft.reconcileLastLine,
                lineDimensionField: resultCenterTplDraft.lineDimensionField ?? 'CostingCode2',
                distributionMode: resultCenterTplDraft.distributionMode,
                inWhichDimension: resultCenterTplDraft.inWhichDimension ?? 2,
            },
        });
    };

    const addResultCenterRow = () => {
        setResultCenterTplDraft(prev => ({
            ...prev,
            lines: [...prev.lines, { centerCode: '', lineTotalFormula: '' }],
        }));
    };

    /** Exibe um único campo "Valor": prioriza total da linha; senão legado (preço unit.). */
    const resultCenterValorDisplay = (line: ResultCenterLine) =>
        (line.lineTotalFormula?.trim() ? line.lineTotalFormula : line.unitPriceFormula) ?? '';

    const updateResultCenterRow = (idx: number, patch: Partial<ResultCenterLine>) => {
        setResultCenterTplDraft(prev => ({
            ...prev,
            lines: prev.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
        }));
    };

    const removeResultCenterRow = (idx: number) => {
        setResultCenterTplDraft(prev => ({
            ...prev,
            lines: prev.lines.filter((_, i) => i !== idx),
        }));
    };

    return (
        <div className="container" style={{ paddingBottom: '4rem' }}>
            <h1 className="page-title">Mapeamento de Campos (De/Para)</h1>
            <p style={{ color: 'var(--secondary)', marginBottom: '2rem' }}>
                Defina como os campos do Protheus (Supabase) serão traduzidos para o SAP Business One.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr', gap: '2rem' }}>

                {/* SIDEBAR: Table Selection */}
                <div className="card" style={{ height: 'fit-content' }}>
                    
                    <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem', color: 'var(--accent)' }}>Tabelas Protheus</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
                        {tableOptions.filter(o => !o.isExcel).map(opt => (
                            <button
                                key={opt.code}
                                onClick={() => setSelectedTableCode(opt.code)}
                                style={{
                                    textAlign: 'left',
                                    padding: '0.75rem',
                                    borderRadius: '6px',
                                    backgroundColor: selectedTableCode === opt.code ? 'var(--primary)' : 'transparent',
                                    color: selectedTableCode === opt.code ? 'white' : 'var(--foreground)',
                                    fontWeight: selectedTableCode === opt.code ? 600 : 400,
                                    transition: 'all 0.2s',
                                    border: '1px solid transparent'
                                }}
                            >
                                <strong>{opt.code}</strong> <br />
                                <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>{opt.name}</span>
                            </button>
                        ))}
                    </div>

                    <h3 style={{ marginBottom: '1rem', fontSize: '1.1rem', color: 'var(--success)' }}>Planilhas (Excel)</h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {tableOptions.filter(o => o.isExcel).length === 0 ? (
                            <p style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>Nenhuma planilha carregada.</p>
                        ) : tableOptions.filter(o => o.isExcel).map(opt => (
                            <button
                                key={opt.code}
                                onClick={() => setSelectedTableCode(opt.code)}
                                style={{
                                    textAlign: 'left',
                                    padding: '0.75rem',
                                    borderRadius: '6px',
                                    backgroundColor: selectedTableCode === opt.code ? 'var(--primary)' : 'transparent',
                                    color: selectedTableCode === opt.code ? 'white' : 'var(--foreground)',
                                    fontWeight: selectedTableCode === opt.code ? 600 : 400,
                                    transition: 'all 0.2s',
                                    border: selectedTableCode === opt.code ? '1px solid var(--primary)' : '1px solid var(--card-border)'
                                }}
                            >
                                <span style={{ fontSize: '0.9rem', display: 'block', wordBreak: 'break-word' }}>{opt.name}</span>
                                <span style={{ fontSize: '0.75rem', opacity: 0.8, color: selectedTableCode === opt.code ? '#e2e8f0' : 'var(--success)' }}>→ {opt.targetObject}</span>
                            </button>
                        ))}
                    </div>

                </div>

                {/* MAIN: Mapping Area */}
                <div className="card">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1.25rem' }}>
                                {selectedTableOpt.isExcel ? selectedTableOpt.name : selectedTableCode} 
                                <ArrowRight size={16} style={{ margin: '0 0.5rem' }} /> 
                                <span style={{ color: 'var(--success)' }}>{rawTargetObject}</span>
                            </h2>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                                type="text"
                                className="input"
                                placeholder="Filtrar (Ex: Cód, nº título e1_num, Nome, CNPJ)..."
                                value={previewSearch}
                                onChange={e => setPreviewSearch(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handlePreview() }}
                                style={{ width: '250px', padding: '0.5rem', fontSize: '0.9rem' }}
                            />
                            <button className="btn btn-secondary" onClick={handlePreview} disabled={previewLoading}>
                                {previewLoading ? <Loader2 size={16} className="spinner" style={{ marginRight: '0.5rem' }} /> : <Play size={16} style={{ marginRight: '0.5rem' }} />} 
                                {previewLoading ? 'Gerando...' : 'Testar Preview'}
                            </button>
                            <button className="btn btn-primary" onClick={handleAddField}>
                                <Plus size={16} style={{ marginRight: '0.5rem' }} /> Adicionar Campo
                            </button>
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '600px', overflowY: 'auto', paddingRight: '0.5rem' }}>
                        {currentMapping.fields.length === 0 ? (
                            <p style={{ color: 'var(--secondary)', textAlign: 'center', padding: '2rem' }}>
                                Nenhum campo mapeado. Adicione um novo mapeamento para começar.
                            </p>
                        ) : (
                            currentMapping.fields.map((field, idx) => (
                                <div key={idx} style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 30px 1fr 120px 40px',
                                    gap: '1rem',
                                    alignItems: 'center',
                                    padding: '1rem',
                                    backgroundColor: 'var(--background)',
                                    borderRadius: '8px',
                                    border: '1px solid var(--card-border)'
                                }}>
                                    {/* Source Field */}
                                    <div>
                                        <label className="label" style={{ marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            Origem {selectedTableOpt.isExcel ? '(Planilha)' : '(Protheus)'}
                                            {loadingSourceCols && (
                                                <span style={{ fontSize: '0.72rem', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: 3, fontWeight: 400 }}>
                                                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                                                    Carregando colunas...
                                                </span>
                                            )}
                                            {!loadingSourceCols && sourceColumns.length > 0 && !sourceColumns[0].startsWith('(') && (
                                                <span style={{ fontSize: '0.7rem', color: 'var(--accent)', fontWeight: 400, background: 'rgba(56,189,248,0.1)', padding: '1px 6px', borderRadius: 10 }}>
                                                    {sourceColumns.length} campos
                                                </span>
                                            )}
                                        </label>

                                        {field.rule?.type === 'static' ? (
                                            <div style={{
                                                padding: '0.5rem 0.75rem',
                                                backgroundColor: 'rgba(var(--primary-rgb, 99,102,241),0.12)',
                                                border: '1px dashed var(--primary)',
                                                borderRadius: '8px',
                                                fontSize: '0.82rem',
                                                color: 'var(--primary)',
                                                fontStyle: 'italic',
                                            }}>
                                                📌 Valor Fixo: <strong>{field.rule.value ?? '(vazio)'}</strong>
                                            </div>
                                        ) : field.rule?.type === 'today' ? (
                                            <div style={{
                                                padding: '0.5rem 0.75rem',
                                                backgroundColor: 'rgba(var(--accent-rgb, 56,189,248),0.12)',
                                                border: '1px dashed var(--accent)',
                                                borderRadius: '8px',
                                                fontSize: '0.82rem',
                                                color: 'var(--accent)',
                                                fontStyle: 'italic',
                                            }}>
                                                📅 Data do dia (integração): formato <strong>{field.rule.value || 'iso'}</strong>
                                                <span style={{ display: 'block', marginTop: '0.25rem', opacity: 0.9 }}>
                                                    Preview usa marcador; no POST ao SAP vira a data corrente (America/São_Paulo).
                                                </span>
                                            </div>
                                        ) : field.rule?.type === 'expression' ? (
                                            <div style={{
                                                padding: '0.5rem 0.75rem',
                                                backgroundColor: 'rgba(var(--success-rgb, 16,185,129),0.12)',
                                                border: '1px dashed var(--success)',
                                                borderRadius: '8px',
                                                fontSize: '0.82rem',
                                                color: 'var(--success)',
                                                fontStyle: 'italic',
                                                wordBreak: 'break-all'
                                            }}>
                                                ƒ(x) Expressão: <strong>{field.rule.expression ?? '(vazio)'}</strong>
                                            </div>
                                        ) : (
                                            <AutocompleteInput
                                                value={field.source}
                                                onChange={(val: string) => handleChangeField(idx, 'source', val)}
                                                options={sourceColumns}
                                                placeholder="Origem..."
                                            />
                                        )}
                                    </div>

                                    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '1.5rem' }}>
                                        <ArrowRight size={16} color="var(--secondary)" />
                                    </div>

                                    {/* Target Field */}
                                    <div>
                                        <label className="label" style={{ marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                            Destino (SAP)
                                            {loadingUserFields && (
                                                <span style={{ fontSize: '0.72rem', color: 'var(--secondary)', display: 'flex', alignItems: 'center', gap: 3, fontWeight: 400 }}>
                                                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                                                    Carregando UDFs...
                                                </span>
                                            )}
                                            {!loadingUserFields && sapUserFields.length > 0 && (
                                                <span style={{ fontSize: '0.7rem', color: 'var(--success)', fontWeight: 400, background: 'rgba(34,197,94,0.1)', padding: '1px 6px', borderRadius: 10 }}>
                                                    +{sapUserFields.length} UDFs
                                                </span>
                                            )}
                                        </label>

                                        <AutocompleteInput
                                            value={field.target}
                                            onChange={(val: string) => handleChangeField(idx, 'target', val)}
                                            options={[
                                                ...(COMMON_SAP_FIELDS[rawTargetObject] || []),
                                                ...sapUserFields,
                                            ].filter(opt =>
                                                // Exclude targets used in OTHER rows (allow current row's value)
                                                !currentMapping.fields.some((f, i) => i !== idx && f.target === opt)
                                            )}
                                            placeholder="Destino..."
                                        />
                                    </div>

                                    {/* Rule Button */}
                                    <div style={{ paddingTop: '1.5rem' }}>
                                        <button
                                            className="btn btn-secondary"
                                            style={{ width: '100%', fontSize: '0.8rem', padding: '0.5rem', backgroundColor: field.rule?.type !== 'none' ? 'var(--primary)' : undefined, color: field.rule?.type !== 'none' ? 'white' : undefined }}
                                            onClick={() => openRuleModal(field, idx)}
                                        >
                                            <Settings size={14} style={{ marginRight: '4px' }} />
                                            {field.rule && field.rule.type !== 'none' ? field.rule.type : 'Regra'}
                                        </button>
                                    </div>

                                    {/* Delete Button */}
                                    <div style={{ paddingTop: '1.5rem', display: 'flex', justifyContent: 'center' }}>
                                        <button onClick={() => handleRemoveField(idx)} style={{ color: 'var(--error)' }}>
                                            <Trash2 size={18} />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    {selectedTableCode === 'SE1010' && rawTargetObject === 'Orders' && (
                        <div style={{ marginTop: '1.5rem', paddingTop: '1.25rem', borderTop: '1px solid var(--card-border)' }}>
                            <h3 style={{ fontSize: '1.05rem', marginBottom: '0.5rem', color: 'var(--accent)' }}>
                                Centros de resultado (Dimensão 2)
                            </h3>
                            <p style={{ fontSize: '0.82rem', color: 'var(--secondary)', marginBottom: '1rem', lineHeight: 1.45 }}>
                                Mantém <strong>um único ItemCode</strong> vindo do mapeamento (ex.: <code>e1_xtipo</code> → item). Com{' '}
                                <strong>linha única</strong> e <strong>dois ou mais centros</strong>, na integração o sistema cria uma{' '}
                                <strong>DistributionRules</strong> primeiro (FactorCode gerado), depois o pedido com <strong>OcrCode</strong> na linha igual ao FactorCode.
                                Na integração, após criar a OOCR, o sistema grava também o <strong>centro principal</strong> (maior valor no rateio) no campo de dimensão (<code>CostingCode</code>/<code>CostingCode2</code>… conforme a dimensão da regra), para a grade mostrar o centro de custo/resultado.
                                Se o Service Layer não declarar <code>OcrCode</code> no <code>$metadata</code>, a coluna &quot;Regra de distribuição&quot; pode continuar vazia — a OOCR ainda é criada.
                                O rateio indicativo continua nos avisos do preview. Com <strong>várias linhas</strong>, o sistema gera uma linha por centro (sem criação automática de OOCR).
                                Se esta seção tiver linhas salvas, ela <strong>substitui</strong> o desmembramento por vários produtos abaixo.
                            </p>
                            <label
                                style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: '0.5rem',
                                    cursor: 'pointer',
                                    fontSize: '0.85rem',
                                    marginBottom: '1rem',
                                    maxWidth: '52rem',
                                    lineHeight: 1.45,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={resultCenterTplDraft.distributionMode === 'singleLine'}
                                    onChange={e =>
                                        setResultCenterTplDraft(p => ({
                                            ...p,
                                            distributionMode: e.target.checked ? 'singleLine' : 'multiLine',
                                        }))
                                    }
                                    style={{ marginTop: '0.15rem' }}
                                />
                                <span>
                                    <strong>Uma única linha de produto</strong> (valor total no pedido). O rateio por centro não é gravado como várias linhas no Service Layer;
                                    use a <strong>distribuição manual</strong> de dimensões / centro de resultado no SAP para espelhar os valores do mapeamento.
                                </span>
                            </label>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem', alignItems: 'flex-end' }}>
                                <div>
                                    <label className="label" style={{ fontSize: '0.8rem' }}>Campo na linha SAP</label>
                                    <select
                                        className="input"
                                        style={{ width: '200px' }}
                                        value={resultCenterTplDraft.lineDimensionField ?? 'CostingCode2'}
                                        onChange={e =>
                                            setResultCenterTplDraft(p => ({
                                                ...p,
                                                lineDimensionField: e.target.value as 'CostingCode' | 'CostingCode2',
                                            }))
                                        }
                                    >
                                        <option value="CostingCode2">CostingCode2 (geralmente Dim. 2)</option>
                                        <option value="CostingCode">CostingCode (geralmente Dim. 1)</option>
                                    </select>
                                </div>
                                <div>
                                    <label className="label" style={{ fontSize: '0.8rem' }}>Dim. (regra OOCR)</label>
                                    <input
                                        type="number"
                                        className="input"
                                        style={{ width: '72px' }}
                                        min={1}
                                        max={5}
                                        value={resultCenterTplDraft.inWhichDimension ?? 2}
                                        onChange={e =>
                                            setResultCenterTplDraft(p => ({
                                                ...p,
                                                inWhichDimension: Math.min(5, Math.max(1, parseInt(e.target.value, 10) || 2)),
                                            }))
                                        }
                                        title="Dimensão da regra OOCR: no pedido grava OcrCode (dim 1) ou OcrCode2 (dim 2), etc. Deve bater com a dimensão do centro de resultado."
                                    />
                                </div>
                                <div>
                                    <label className="label" style={{ fontSize: '0.8rem' }}>Conferência total (opcional)</label>
                                    <input
                                        className="input"
                                        style={{ width: '160px' }}
                                        value={resultCenterTplDraft.compareTotalField ?? ''}
                                        onChange={e => setResultCenterTplDraft(p => ({ ...p, compareTotalField: e.target.value }))}
                                        placeholder="e1_valor"
                                    />
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={resultCenterTplDraft.reconcileLastLine ?? false}
                                        onChange={e => setResultCenterTplDraft(p => ({ ...p, reconcileLastLine: e.target.checked }))}
                                    />
                                    Ajustar última linha para fechar o total
                                </label>
                                <button type="button" className="btn btn-primary" onClick={saveResultCenterDistribution}>
                                    <Save size={16} style={{ marginRight: '0.35rem' }} />
                                    Salvar centros de resultado
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={addResultCenterRow}>
                                    <Plus size={16} style={{ marginRight: '0.35rem' }} />
                                    Adicionar centro
                                </button>
                            </div>
                            {resultCenterTplDraft.lines.length === 0 ? (
                                <p style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>
                                    Nenhum centro. Deixe vazio para usar apenas o mapeamento plano ou o desmembramento por produto (bloco seguinte).
                                </p>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {resultCenterTplDraft.lines.map((line, idx) => (
                                        <div
                                            key={idx}
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: 'minmax(140px, 1fr) minmax(200px, 2fr) 40px',
                                                gap: '0.75rem',
                                                alignItems: 'start',
                                                padding: '0.75rem',
                                                backgroundColor: 'var(--background)',
                                                borderRadius: '8px',
                                                border: '1px solid var(--card-border)',
                                            }}
                                        >
                                            <div>
                                                <label className="label" style={{ fontSize: '0.75rem' }}>Código do Centro</label>
                                                <input
                                                    className="input"
                                                    value={line.centerCode}
                                                    onChange={e => updateResultCenterRow(idx, { centerCode: e.target.value })}
                                                    placeholder="D001"
                                                />
                                            </div>
                                            <div>
                                                <label className="label" style={{ fontSize: '0.75rem' }}>Valor (fórmula)</label>
                                                <input
                                                    className="input"
                                                    value={resultCenterValorDisplay(line)}
                                                    onChange={e =>
                                                        updateResultCenterRow(idx, {
                                                            lineTotalFormula: e.target.value,
                                                            unitPriceFormula: '',
                                                            quantityFormula: '',
                                                        })
                                                    }
                                                    placeholder="{e1_valor} * 0.5"
                                                />
                                                <p style={{ fontSize: '0.68rem', color: 'var(--secondary)', marginTop: '0.35rem', marginBottom: 0, lineHeight: 1.35 }}>
                                                    Expressão numérica = valor total da linha no SAP (Quantity=1, UnitPrice=resultado). Use {'{campo}'} do título.
                                                </p>
                                            </div>
                                            <div style={{ paddingTop: '1.4rem' }}>
                                                <button type="button" onClick={() => removeResultCenterRow(idx)} style={{ color: 'var(--error)' }} title="Remover">
                                                    <Trash2 size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    {selectedTableCode === 'SE1010' && rawTargetObject === 'Orders' && (
                        <div style={{ marginTop: '1.5rem', paddingTop: '1.25rem', borderTop: '1px solid var(--card-border)' }}>
                            <h3 style={{ fontSize: '1.05rem', marginBottom: '0.5rem', color: 'var(--accent)' }}>
                                Linhas do pedido (fórmulas) — vários produtos
                            </h3>
                            <p style={{ fontSize: '0.82rem', color: 'var(--secondary)', marginBottom: '1rem', lineHeight: 1.45 }}>
                                Ignorado se <strong>Centros de resultado</strong> acima tiver linhas salvas. Caso contrário, se houver ao menos uma linha com ItemCode preenchido, o sistema <strong>substitui</strong> o{' '}
                                <code>DocumentLines</code> gerado pelo mapeamento plano acima. Use{' '}
                                <code>{'{e1_valor}'}</code>, <code>{'{campo}'}</code> nas fórmulas. Informe{' '}
                                <strong>preço unitário</strong> ou <strong>total da linha</strong> (não ambos). Atualização (PATCH)
                                de pedido no SAP <strong>não altera linhas</strong>; desmembramento aplica principalmente em novas inclusões.
                            </p>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem', alignItems: 'flex-end' }}>
                                <div>
                                    <label className="label" style={{ fontSize: '0.8rem' }}>Campo para conferência (opcional)</label>
                                    <input
                                        className="input"
                                        style={{ width: '160px' }}
                                        value={orderLineTplDraft.compareTotalField ?? ''}
                                        onChange={e => setOrderLineTplDraft(p => ({ ...p, compareTotalField: e.target.value }))}
                                        placeholder="e1_valor"
                                    />
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                                    <input
                                        type="checkbox"
                                        checked={orderLineTplDraft.reconcileLastLine ?? false}
                                        onChange={e => setOrderLineTplDraft(p => ({ ...p, reconcileLastLine: e.target.checked }))}
                                    />
                                    Ajustar última linha para fechar com o campo acima
                                </label>
                                <button type="button" className="btn btn-primary" onClick={saveOrderLineTemplates}>
                                    <Save size={16} style={{ marginRight: '0.35rem' }} />
                                    Salvar linhas do pedido
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={addOrderLineRow}>
                                    <Plus size={16} style={{ marginRight: '0.35rem' }} />
                                    Adicionar linha
                                </button>
                            </div>
                            {orderLineTplDraft.lines.length === 0 ? (
                                <p style={{ fontSize: '0.85rem', color: 'var(--secondary)' }}>
                                    Nenhuma linha extra. Clique em &quot;Adicionar linha&quot; ou salve vazio para usar só o mapeamento plano (uma linha por título).
                                </p>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                    {orderLineTplDraft.lines.map((line, idx) => (
                                        <div
                                            key={idx}
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: '1fr 120px 1fr 1fr 40px',
                                                gap: '0.5rem',
                                                alignItems: 'start',
                                                padding: '0.75rem',
                                                backgroundColor: 'var(--background)',
                                                borderRadius: '8px',
                                                border: '1px solid var(--card-border)',
                                            }}
                                        >
                                            <div>
                                                <label className="label" style={{ fontSize: '0.75rem' }}>ItemCode (ou {'{campo}'})</label>
                                                <input
                                                    className="input"
                                                    value={line.itemCode}
                                                    onChange={e => updateOrderLineRow(idx, { itemCode: e.target.value })}
                                                    placeholder="004 ou {e1_xtipo}"
                                                />
                                            </div>
                                            <div>
                                                <label className="label" style={{ fontSize: '0.75rem' }}>Qtd (fórmula)</label>
                                                <input
                                                    className="input"
                                                    value={line.quantityFormula ?? ''}
                                                    onChange={e => updateOrderLineRow(idx, { quantityFormula: e.target.value })}
                                                    placeholder="1"
                                                />
                                            </div>
                                            <div>
                                                <label className="label" style={{ fontSize: '0.75rem' }}>Preço unitário (fórmula)</label>
                                                <input
                                                    className="input"
                                                    value={line.unitPriceFormula ?? ''}
                                                    onChange={e => updateOrderLineRow(idx, { unitPriceFormula: e.target.value, lineTotalFormula: '' })}
                                                    placeholder="{e1_valor} * 0.6"
                                                />
                                            </div>
                                            <div>
                                                <label className="label" style={{ fontSize: '0.75rem' }}>Total linha (fórmula)</label>
                                                <input
                                                    className="input"
                                                    value={line.lineTotalFormula ?? ''}
                                                    onChange={e => updateOrderLineRow(idx, { lineTotalFormula: e.target.value, unitPriceFormula: '' })}
                                                    placeholder="alternativa ao preço unit."
                                                />
                                            </div>
                                            <div style={{ paddingTop: '1.4rem' }}>
                                                <button type="button" onClick={() => removeOrderLineRow(idx)} style={{ color: 'var(--error)' }} title="Remover">
                                                    <Trash2 size={18} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* PREVIEW MODAL */}
            {showPreview && previewData && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
                    <div className="card" style={{ width: '900px', height: '80vh', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid var(--card-border)', paddingBottom: '1rem' }}>
                            <h2 style={{ fontSize: '1.5rem' }}>Preview da Migração</h2>
                            <button onClick={() => setShowPreview(false)} style={{ color: 'var(--secondary)' }}><Trash2 size={24} style={{ transform: 'rotate(45deg)' }} /></button>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', flex: 1, overflow: 'hidden' }}>
                            {/* Source */}
                            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                                <h3 style={{ marginBottom: '1rem', color: 'var(--accent)' }}>
                                    {selectedTableOpt?.isExcel ? 'Origem (Planilha)' : 'Origem (Protheus/Supabase)'}
                                </h3>
                                <div style={{ flex: 1, overflow: 'auto', backgroundColor: '#000', padding: '1rem', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                                    <pre>{JSON.stringify(previewData.source, null, 2)}</pre>
                                </div>
                            </div>

                            {/* Target */}
                            <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                                <h3 style={{ marginBottom: '1rem', color: 'var(--success)' }}>Destino (Objeto SAP)</h3>
                                {Array.isArray((previewData.target as any)._resultCenterFormulaExecutions) &&
                                    (previewData.target as any)._resultCenterFormulaExecutions.length > 0 && (
                                    <div
                                        style={{
                                            marginBottom: '0.75rem',
                                            padding: '0.75rem',
                                            backgroundColor: '#12121a',
                                            border: '1px solid var(--card-border)',
                                            borderRadius: '8px',
                                            fontFamily: 'monospace',
                                            fontSize: '0.8rem',
                                            maxHeight: '28%',
                                            overflow: 'auto',
                                        }}
                                    >
                                        <div style={{ color: 'var(--accent)', marginBottom: '0.5rem', fontWeight: 600 }}>
                                            Fórmulas por centro (template → substituída → eval)
                                        </div>
                                        {(previewData.target as any)._resultCenterFormulaExecutions.map((ex: any) => (
                                            <div key={ex.centerIndex} style={{ marginBottom: '0.75rem', borderLeft: '3px solid var(--success)', paddingLeft: '0.5rem' }}>
                                                <div style={{ color: 'var(--secondary)' }}>
                                                    Centro {ex.centerIndex} · {ex.centerCode} · {ex.mode}
                                                </div>
                                                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                                    <span style={{ opacity: 0.75 }}>template: </span>
                                                    {ex.formulaTemplate}
                                                </div>
                                                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#a8d4a8' }}>
                                                    <span style={{ opacity: 0.75 }}>substituída: </span>
                                                    {ex.substitutedExpression}
                                                </div>
                                                <div>
                                                    <span style={{ opacity: 0.75 }}>qty: </span>
                                                    {ex.quantitySubstituted} → {ex.quantity} ·{' '}
                                                    <span style={{ opacity: 0.75 }}>eval principal: </span>
                                                    {ex.evaluatedMain} ·{' '}
                                                    <span style={{ opacity: 0.75 }}>valor linha (Q×P): </span>
                                                    {ex.monetaryAmount}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                <div style={{ flex: 1, overflow: 'auto', backgroundColor: '#000', padding: '1rem', borderRadius: '8px', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                                    <pre>{JSON.stringify(previewData.target, null, 2)}</pre>
                                </div>
                            </div>
                        </div>

                        <div style={{ marginTop: '1rem', textAlign: 'right' }}>
                            <button className="btn btn-secondary" onClick={() => setShowPreview(false)}>Fechar Preview</button>
                        </div>
                    </div>
                </div>
            )}

            {/* RULE MODAL */}
            {showRuleModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                    <div className="card" style={{ width: '500px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <h2 style={{ marginBottom: '1.5rem' }}>Configurar Regra de Transformação</h2>

                        <div className="input-group">
                            <label className="label">Tipo de Regra</label>
                            <select className="input" value={ruleType} onChange={(e) => {
                                const newType = e.target.value as RuleType;
                                setRuleType(newType);
                                if (newType === 'sap_sequence' && !objectType) {
                                    if (selectedTableCode === 'SA1010') setObjectType('bp_customer');
                                    else if (selectedTableCode === 'SA2010') setObjectType('bp_supplier');
                                }
                            }}>
                                <option value="none">Nenhuma (Cópia Direta)</option>
                                <option value="static">Valor Fixo (static — literal)</option>
                                <option value="today">Data do dia — hoje (na integração, tipo Today())</option>
                                <option value="expression">Expressão com Templates (ex: {'{campo1}/{campo2}'})</option>
                                <option value="prefix">Adicionar Prefixo</option>
                                <option value="suffix">Adicionar Sufixo</option>
                                <option value="map">Mapeamento de Valores (De/Para)</option>
                                <option value="date">Converter Data YYYYMMDD → ISO</option>
                                <option value="date_iso">Converter Data DD/MM/YYYY → ISO</option>
                                <option value="address_part">Análise de Endereço (Extração)</option>
                                <option value="tax_id">Análise de CGC (Formatação)</option>
                                <optgroup label="Lookup (busca em outra tabela)">
                                    <option value="lookup">Lookup simples (chave única)</option>
                                    <option value="lookup_composite">Lookup composto (múltiplas chaves — ex: cod+loja)</option>
                                </optgroup>
                                <option value="sap_sequence">Utilizar Regra de Sequência do SAP</option>
                            </select>
                        </div>

                        {(ruleType === 'prefix' || ruleType === 'suffix') && (
                            <div className="input-group">
                                <label className="label">Valor do {ruleType === 'prefix' ? 'Prefixo' : 'Sufixo'}</label>
                                <input className="input" value={ruleValue} onChange={e => setRuleValue(e.target.value)} placeholder={`Ex: ${ruleType === 'prefix' ? 'CLI-' : '-BR'}`} />
                            </div>
                        )}

                        {ruleType === 'static' && (
                            <div className="input-group">
                                <label className="label">Valor Fixo</label>
                                <input
                                    className="input"
                                    value={ruleValue}
                                    onChange={e => setRuleValue(e.target.value)}
                                    placeholder="Ex: 100, tYES, BR, 1, Ativo..."
                                />
                                <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem' }}>
                                    Este valor será enviado <strong>literalmente</strong> para o campo SAP, independente do valor de origem.
                                </p>
                            </div>
                        )}

                        {ruleType === 'today' && (
                            <div className="input-group">
                                <label className="label">Formato da data (calendário America/São_Paulo)</label>
                                <select
                                    className="input"
                                    value={ruleValue || 'iso'}
                                    onChange={(e) => setRuleValue(e.target.value)}
                                >
                                    <option value="iso">YYYY-MM-DD (DocDate / campos data SAP)</option>
                                    <option value="yyyymmdd">YYYYMMDD</option>
                                    <option value="br">DD/MM/YYYY</option>
                                    <option value="isodt">YYYY-MM-DDTHH:mm:ss (meia-noite)</option>
                                    <option value="iso_z">YYYY-MM-DDT00:00:00Z (UTC)</option>
                                </select>
                                <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem', lineHeight: 1.45 }}>
                                    No preview o JSON mostra <code>{runtimeTodayPlaceholder('iso')}</code> (marcador). Ao clicar em integrar, a API substitui pela <strong>data do dia</strong> naquele momento — como um <code>Today()</code>.
                                </p>
                            </div>
                        )}

                        {ruleType === 'expression' && (
                            <div className="input-group">
                                <label className="label">Template da Expressão</label>
                                <input
                                    className="input"
                                    value={ruleValue}
                                    onChange={e => setRuleValue(e.target.value)}
                                    placeholder="Ex: {e1_num}/{e1_titulo}"
                                />
                                <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem' }}>
                                    Escreva o texto combinando campos da origem entre chaves <strong>{'{campo}'}</strong>. <br />Exemplo: <code>{'{e1_num}/{e1_titulo}'}</code> virá <code>000101/AB</code>.
                                </p>
                            </div>
                        )}

                        {ruleType === 'map' && (
                            <div className="input-group">
                                <label className="label">Valores (Origem -&gt; Destino)</label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '200px', overflowY: 'auto', padding: '0.5rem', border: '1px solid var(--card-border)', borderRadius: '8px' }}>
                                    {mapValues.map((v, i) => (
                                        <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                            <input className="input" value={v.from} onChange={e => updateMapValue(i, 'from', e.target.value)} placeholder="De" style={{ flex: 1 }} />
                                            <ArrowRight size={14} color="var(--secondary)" />
                                            <input className="input" value={v.to} onChange={e => updateMapValue(i, 'to', e.target.value)} placeholder="Para" style={{ flex: 1 }} />
                                            <button onClick={() => removeMapValue(i)} style={{ color: 'var(--error)' }}><Trash2 size={16} /></button>
                                        </div>
                                    ))}
                                    <button className="btn btn-secondary" onClick={addMapValue} style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}>
                                        <Plus size={14} style={{ marginRight: '4px' }} /> Adicionar Valor
                                    </button>
                                </div>
                            </div>
                        )}

                        {ruleType === 'address_part' && (
                            <div className="input-group">
                                <label className="label">Parte do Endereço</label>
                                <select
                                    className="input"
                                    // @ts-ignore
                                    value={addressPart}
                                    onChange={e => setAddressPart(e.target.value as any)}
                                >
                                    <option value="street">Nome da Rua / Logradouro</option>
                                    <option value="number">Número</option>
                                    <option value="complement">Complemento</option>
                                    <option value="type">Tipo (Rua, Av, etc)</option>
                                </select>
                                <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem' }}>
                                    Extrai automaticamente esta parte do campo de origem.
                                </p>
                            </div>
                        )}

                        {ruleType === 'tax_id' && (
                            <div className="input-group">
                                <p style={{ color: 'var(--foreground)' }}>
                                    O CGC será formatado para remover pontuação (apenas dígitos) conforme padrão CRD7.
                                </p>
                            </div>
                        )}

                        {(ruleType === 'lookup' || ruleType === 'lookup_composite') && (
                            <div className="input-group">
                                <label className="label">
                                    {ruleType === 'lookup_composite'
                                        ? '🔗 Lookup Composto (múltiplas chaves)'
                                        : '🔗 Lookup Simples'}
                                </label>
                                <div style={{ display: 'grid', gap: '0.8rem', padding: '1rem', border: '1px solid var(--card-border)', borderRadius: 8 }}>

                                    {/* Tabela de lookup */}
                                    <div>
                                        <label className="label" style={{ fontSize: '0.82rem' }}>Tabela Auxiliar (Supabase)</label>
                                        <select className="input" value={lookupTable} onChange={e => {
                                            const t = e.target.value;
                                            setLookupTable(t);
                                            setLookupKey('');
                                            setLookupValue('');
                                            setCkLookupKeyFields(['', '']);
                                            fetchLookupCols(t);
                                        }}>
                                            <option value="">Selecione...</option>
                                            <optgroup label="Protheus (replicados no Supabase)">
                                                <option value="sa1010">sa1010 — Clientes (código SAP via sap_code)</option>
                                                <option value="sa2010">sa2010 — Fornecedores (código SAP via sap_code)</option>
                                                <option value="sb1010">sb1010 — Produtos/Itens (código SAP via sap_code)</option>
                                                <option value="sed010">sed010 — Naturezas (conta SAP via sap_account_code)</option>
                                            </optgroup>
                                            <optgroup label="SAP importado para Supabase">
                                                <option value="sap_items">sap_items — Itens SAP (E1_XTPSRV → svc_code → item_code)</option>
                                                <option value="sap_chart_of_accounts">sap_chart_of_accounts — Plano de Contas</option>
                                                <option value="sap_cost_centers">sap_cost_centers — Centros de Custo</option>
                                            </optgroup>
                                            <optgroup label="Tabelas Auxiliares">
                                                <option value="ibge_municipios">ibge_municipios — Mun. IBGE</option>
                                                <option value="sap_cnaes">sap_cnaes — CNAEs SAP</option>
                                            </optgroup>
                                        </select>
                                        {lookupTableColsLoading && (
                                            <p style={{ fontSize: '0.75rem', color: 'var(--accent)', marginTop: 4 }}>
                                                ⟳ Carregando campos da tabela...
                                            </p>
                                        )}
                                        {!lookupTableColsLoading && lookupTable && lookupTableCols.length > 0 && (
                                            <p style={{ fontSize: '0.72rem', color: 'var(--secondary)', marginTop: 4 }}>
                                                {lookupTableCols.length} campos disponíveis
                                            </p>
                                        )}
                                    </div>

                                    {/* Helper: Sempre um <select> com as colunas disponíveis */}
                                    {(() => {
                                        const ColSelect = ({
                                            value, onChange, placeholder, allowFreeText = false
                                        }: {
                                            value: string;
                                            onChange: (v: string) => void;
                                            placeholder?: string;
                                            allowFreeText?: boolean;
                                        }) => {
                                            const isCustom = value && !lookupTableCols.includes(value);
                                            return (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                    <select
                                                        className="input"
                                                        value={isCustom ? '__custom__' : value}
                                                        onChange={e => {
                                                            if (e.target.value === '__custom__') return;
                                                            onChange(e.target.value);
                                                        }}
                                                    >
                                                        <option value="">
                                                            {lookupTableColsLoading ? '⟳ Carregando...' : (placeholder || '— Selecione o campo —')}
                                                        </option>
                                                        {lookupTableCols.map(c => (
                                                            <option key={c} value={c}>{c}</option>
                                                        ))}
                                                        {lookupTableCols.length === 0 && !lookupTableColsLoading && (
                                                            <option disabled value="">Selecione uma tabela primeiro</option>
                                                        )}
                                                        {allowFreeText && (
                                                            <option value="__custom__">✎ Digitar manualmente...</option>
                                                        )}
                                                    </select>
                                                    {/* Input livre visível se campo digitado não está na lista */}
                                                    {(isCustom || (allowFreeText && value === '__custom__')) && (
                                                        <input
                                                            className="input"
                                                            value={isCustom ? value : ''}
                                                            onChange={e => onChange(e.target.value)}
                                                            placeholder="Digite o nome do campo..."
                                                            style={{ fontSize: '0.85rem' }}
                                                        />
                                                    )}
                                                </div>
                                            );
                                        };

                                        return (
                                            <>
                                                {/* Chave simples */}
                                                {ruleType === 'lookup' && (
                                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                                                        <div>
                                                            <label className="label" style={{ fontSize: '0.82rem' }}>
                                                                Campo Chave na Tabela {lookupTableColsLoading && '(carregando...)'}
                                                            </label>
                                                            <ColSelect value={lookupKey} onChange={setLookupKey} placeholder="Campo para comparar..." />
                                                        </div>
                                                        <div>
                                                            <label className="label" style={{ fontSize: '0.82rem' }}>Retornar Campo</label>
                                                            <ColSelect value={lookupValue} onChange={setLookupValue} placeholder="Campo para retornar..." />
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Chave composta */}
                                                {ruleType === 'lookup_composite' && (
                                                    <>
                                                        <p style={{ fontSize: '0.78rem', color: 'var(--secondary)' }}>
                                                            ⚠️ Use quando a chave for a combinação de 2 campos. Ex: e1_cliente+e1_loja → sa1010.(a1_cod+a1_loja) → sap_code
                                                        </p>
                                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.8rem' }}>
                                                            <div>
                                                                <label className="label" style={{ fontSize: '0.82rem' }}>Campos Origem (tabela fonte)</label>
                                                                <select className="input" style={{ marginBottom: 4 }}
                                                                    value={ckSourceFields[0]} onChange={e => setCkSourceFields([e.target.value, ckSourceFields[1]])}>
                                                                    <option value="">1º campo — ex: e1_cliente</option>
                                                                    {sourceColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                                                </select>
                                                                <select className="input"
                                                                    value={ckSourceFields[1]} onChange={e => setCkSourceFields([ckSourceFields[0], e.target.value])}>
                                                                    <option value="">2º campo — ex: e1_loja</option>
                                                                    {sourceColumns.map(c => <option key={c} value={c}>{c}</option>)}
                                                                </select>
                                                            </div>
                                                            <div>
                                                                <label className="label" style={{ fontSize: '0.82rem' }}>
                                                                    Campos na Tabela Lookup {lookupTableColsLoading && '(carregando...)'}
                                                                </label>
                                                                <ColSelect value={ckLookupKeyFields[0]}
                                                                    onChange={v => setCkLookupKeyFields([v, ckLookupKeyFields[1]])}
                                                                    placeholder="1º campo — ex: a1_cod" />
                                                                <div style={{ marginTop: 4 }}>
                                                                    <ColSelect value={ckLookupKeyFields[1]}
                                                                        onChange={v => setCkLookupKeyFields([ckLookupKeyFields[0], v])}
                                                                        placeholder="2º campo — ex: a1_loja" />
                                                                </div>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <label className="label" style={{ fontSize: '0.82rem' }}>Retornar Campo</label>
                                                            <ColSelect value={lookupValue} onChange={setLookupValue} placeholder="Ex: sap_code" />
                                                        </div>
                                                    </>
                                                )}
                                            </>
                                        );
                                    })()}

                                    {/* Fallback */}
                                    <div>
                                        <label className="label" style={{ fontSize: '0.82rem' }}>Valor Padrão (se não encontrar)</label>
                                        <input className="input" value={lookupFallback} onChange={e => setLookupFallback(e.target.value)}
                                            placeholder="Ex: CLIENTE_NAO_ENCONTRADO (ou deixe vazio para null)" />
                                    </div>

                                    <p style={{ fontSize: '0.78rem', color: 'var(--secondary)' }}>
                                        Busca o valor de origem na tabela auxiliar e retorna o campo configurado (ex: sap_code do cliente).
                                    </p>
                                </div>
                            </div>
                        )}

                        {ruleType === 'sap_sequence' && (
                            <div className="input-group">
                                <label className="label">Configuração de Sequência SAP (Série)</label>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem', padding: '1rem', border: '1px solid var(--card-border)', borderRadius: '8px' }}>

                                    <div>
                                        <label className="label" style={{ fontSize: '0.85rem' }}>Tipo de Objeto SAP</label>
                                        <select
                                            className="input"
                                            value={objectType}
                                            onChange={e => setObjectType(e.target.value)}
                                        >
                                            <option value="">Selecione o Objeto...</option>
                                            <optgroup label="Parceiros de Negócios (auto C##### / F#####)">
                                                <option value="bp_customer">BP - Cliente → próximo C###### (ex: C022769)</option>
                                                <option value="bp_supplier">BP - Fornecedor → próximo F###### (ex: F000508)</option>
                                            </optgroup>
                                            <optgroup label="Documentos de Venda">
                                                <option value="17">Ordem de Venda (Sales Order) - 17</option>
                                                <option value="23">Nota Fiscal de Saída (Invoice) - 23</option>
                                                <option value="4">Entrega (Delivery) - 4</option>
                                            </optgroup>
                                            <optgroup label="Documentos de Compra">
                                                <option value="18">Pedido de Compra (Purchase Order) - 18</option>
                                                <option value="13">Nota Fiscal de Entrada (Purchase Invoice) - 13</option>
                                                <option value="15">Recebimento de Mercadorias (Goods Receipt PO) - 15</option>
                                            </optgroup>
                                            <optgroup label="Estoque">
                                                <option value="59">Transferência de Estoque (Stock Transfer) - 59</option>
                                            </optgroup>
                                        </select>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem' }}>
                                            Define qual objeto do SAP gerencia esta numeração.
                                        </p>
                                    </div>

                                    <div>
                                        <label className="label" style={{ fontSize: '0.85rem' }}>Código da Série (Opcional)</label>
                                        <select
                                            className="input"
                                            value={seriesCode === '' ? '' : seriesCode}
                                            onChange={e => setSeriesCode(e.target.value === '' ? '' : Number(e.target.value))}
                                            disabled={loadingSapSeries}
                                        >
                                            <option value="">{loadingSapSeries ? 'Carregando séries do SAP...' : 'Padrão do SAP (Auto)'}</option>
                                            {sapSeriesList.map(s => (
                                                <option key={s.Series} value={s.Series}>
                                                    {s.Name} (Série {s.Series}){s.IsDefault === 'tYES' ? ' - PADRÃO' : ''}
                                                </option>
                                            ))}
                                        </select>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem' }}>
                                            Código numérico da série no SAP (campo <code>Series</code>). Se vazio, utiliza a série padrão do objeto.
                                        </p>
                                    </div>

                                </div>
                                <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginTop: '0.5rem' }}>
                                    O campo de destino receberá o próximo número da sequência definida nas <strong>Séries de Numeração</strong> do SAP B1 (Administração → Definições do Sistema → Séries de Numeração).
                                </p>
                            </div>
                        )}

                        {/* Condition Section */}
                        <div style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--card-border)' }}>
                            <label className="label" style={{ fontWeight: 600, color: 'var(--accent)' }}>Condição de Execução (Opcional)</label>
                            <p style={{ fontSize: '0.8rem', color: 'var(--secondary)', marginBottom: '0.5rem' }}>
                                Aplica esta regra apenas se o valor de outro campo for igual ao especificado.
                            </p>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                                <div>
                                    <label className="label">Campo de Condição</label>
                                    <select
                                        className="input"
                                        value={condField}
                                        onChange={e => setCondField(e.target.value)}
                                    >
                                        <option value="">(Sempre Executar)</option>
                                        {sourceColumns.map(col => (
                                            <option key={col} value={col}>{col}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="label">Valor Igual a</label>
                                    <input
                                        className="input"
                                        value={condValue}
                                        onChange={e => setCondValue(e.target.value)}
                                        placeholder="Ex: J, F, TRUE"
                                        disabled={!condField}
                                    />
                                </div>
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '2rem' }}>
                            <button className="btn btn-secondary" onClick={() => setShowRuleModal(false)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={saveRule}>Salvar Regra</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function AutocompleteInput({ value, onChange, options, placeholder }: { value: string, onChange: (v: string) => void, options: string[], placeholder?: string }) {
    const [isOpen, setIsOpen] = useState(false);
    const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });
    // Use proper ref
    const inputRef = useRef<HTMLInputElement>(null);

    // Filter options
    const filteredOptions = (options || []).filter((opt) =>
        opt.toLowerCase().includes((value || '').toLowerCase())
    );

    const updateCoords = () => {
        if (inputRef.current) {
            const rect = inputRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + window.scrollY,
                left: rect.left + window.scrollX,
                width: rect.width
            });
        }
    };

    return (
        <>
            <input
                ref={inputRef}
                className="input"
                value={value}
                onChange={(e) => { onChange(e.target.value); setIsOpen(true); }}
                onFocus={() => { updateCoords(); setIsOpen(true); }}
                onBlur={() => setTimeout(() => setIsOpen(false), 200)}
                placeholder={placeholder}
            />
            {isOpen && filteredOptions.length > 0 && typeof document !== 'undefined' && createPortal(
                <ul style={{
                    position: 'absolute',
                    top: coords.top,
                    left: coords.left,
                    width: coords.width,
                    maxHeight: '200px',
                    overflowY: 'auto',
                    backgroundColor: '#1f2937', // Dark bg
                    border: '1px solid #374151',
                    borderRadius: '0.375rem',
                    zIndex: 9999,
                    padding: '0.25rem',
                    margin: '2px 0 0 0',
                    listStyle: 'none',
                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)'
                }}>
                    {filteredOptions.map((opt) => (
                        <li
                            key={opt}
                            style={{ padding: '0.5rem', cursor: 'pointer', fontSize: '0.875rem', color: '#e5e7eb' }}
                            onMouseDown={() => { onChange(opt); setIsOpen(false); }}
                            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#374151'; }}
                            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                        >
                            {opt}
                        </li>
                    ))}
                </ul>,
                document.body
            )}
        </>
    );
}
