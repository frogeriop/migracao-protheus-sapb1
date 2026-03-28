import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';
import { createClient } from '@supabase/supabase-js';
import { TableMapping } from '@/types/mapping';
import { TransformationUtils } from '@/utils/transformations';

// Load config
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const MAPPING_FILE = path.join(process.cwd(), 'mapping.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

async function getMappings(): Promise<{ [key: string]: TableMapping }> {
    try {
        const data = await fs.readFile(MAPPING_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

type ExcelFilter = {
    field: string;
    operator: 'contains' | 'equals' | 'starts_with';
    value: string;
};

// Helper to normalize column names (mirrors excel/route.ts)
function normalizeKey(name: string): string {
    return name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^_+|_+$/g, "");
}

function readSourceByAliases(source: any, aliases: string[]): any {
    for (const alias of aliases) {
        const val =
            source?.[alias] ??
            source?.[alias.toUpperCase?.()] ??
            source?.[alias.toLowerCase?.()] ??
            source?.[normalizeKey(alias)];
        if (val !== undefined && val !== null && String(val).trim() !== '') return val;
    }
    return undefined;
}

function normalizeTargetPayloadKeys(target: any, targetObject: string): any {
    const out = { ...target };
    const mapKey = (from: string, to: string) => {
        const val = out[from];
        if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) return;
        if (out[to] === undefined || out[to] === null || (typeof out[to] === 'string' && out[to].trim() === '')) {
            out[to] = val;
        }
        delete out[from];
    };

    if (targetObject === 'ChartOfAccounts') {
        // Normaliza aliases DI API/coluna para nomes esperados no Service Layer.
        mapKey('AcctCode', 'Code');
        mapKey('acctcode', 'Code');
        mapKey('code', 'Code');
        mapKey('AcctName', 'Name');
        mapKey('acctname', 'Name');
        mapKey('name', 'Name');
        mapKey('FatherNum', 'FatherAccountKey');
        mapKey('fathernum', 'FatherAccountKey');
        mapKey('fatheraccountkey', 'FatherAccountKey');
        mapKey('Postable', 'ActiveAccount');
        mapKey('postable', 'ActiveAccount');
        mapKey('ActType', 'AccountType');
        mapKey('acttype', 'AccountType');
        mapKey('accounttype', 'AccountType');
        mapKey('formatcode', 'FormatCode');

        // Tax Extension Fields (Brazil Localization UDFs)
        mapKey('u_tx_contacosif', 'U_TX_ContaCOSIF');
        mapKey('u_tx_codigodesif', 'U_TX_CodigoDesIf');
        mapKey('u_tx_outrosprodservdesif', 'U_TX_OutrosProdServDesIf');
        mapKey('u_tx_des_mista', 'U_TX_Des_Mista');
        mapKey('u_tx_des_contasuperior', 'U_TX_Des_ContaSuperior');
        mapKey('u_tx_nataccount', 'U_TX_NatAccount');
        mapKey('u_tx_nat_rec', 'U_TX_NAT_REC');
        mapKey('u_tx_tiporeceitabruta', 'U_TX_TipoReceitaBruta');
        mapKey('u_tx_regcaixa', 'U_TX_RegCaixa');
        mapKey('u_tx_ocultarconta', 'U_TX_OcultarConta');

        // Campo de nível vindo da origem costuma ser informativo; não é campo de criação.
        delete out.Levels;
        delete out.levels;
        delete out.Level;
        delete out.level;
        delete out.AccountLevel;
    } else if (targetObject === 'BusinessPartners') {
        mapKey('cardcode', 'CardCode');
        mapKey('cardname', 'CardName');
        mapKey('cardtype', 'CardType');
    } else if (targetObject === 'Items') {
        mapKey('itemcode', 'ItemCode');
        mapKey('itemname', 'ItemName');
    } else if (targetObject === 'Orders') {
        mapKey('cardcode', 'CardCode');
        mapKey('documentlines', 'DocumentLines');
    } else if (targetObject === 'JournalEntries') {
        mapKey('journalentrylines', 'JournalEntryLines');
    }

    return out;
}

function ensureMandatoryPayloadFields(target: any, source: any, targetObject: string, mapping: TableMapping): any {
    const out = { ...target };
    const setIfMissing = (field: string, aliases: string[], fallback?: any) => {
        const hasSapSequence = mapping.fields.some(f => f.target === field && f.rule?.type === 'sap_sequence');
        if (hasSapSequence) return;
        
        const cur = out[field];
        if (cur !== undefined && cur !== null && String(cur).trim() !== '') return;
        const fromSource = readSourceByAliases(source, aliases);
        if (fromSource !== undefined) {
            out[field] = fromSource;
        } else if (fallback !== undefined) {
            out[field] = fallback;
        } else {
            delete out[field];
        }
    };

    if (targetObject === 'BusinessPartners') {
        setIfMissing('CardCode', ['CardCode', 'cardcode', 'a1_cod', 'a2_cod', 'codigo'], '');
        setIfMissing('CardName', ['CardName', 'cardname', 'a1_nome', 'a2_nome', 'nome'], '');
        setIfMissing('CardType', ['CardType', 'cardtype', 'tipo'], '');
    } else if (targetObject === 'Items') {
        setIfMissing('ItemCode', ['ItemCode', 'itemcode', 'b1_cod', 'codigo'], '');
        setIfMissing('ItemName', ['ItemName', 'itemname', 'b1_desc', 'descricao', 'nome'], '');
    } else if (targetObject === 'ChartOfAccounts') {
        setIfMissing('Code', ['Code', 'code', 'AcctCode', 'acctcode', 'conta', 'codigo'], '');
        setIfMissing('FormatCode', ['FormatCode', 'formatcode']); // Sem fallback: remove campo vazio
        setIfMissing('Name', ['Name', 'name', 'AcctName', 'acctname', 'descricao', 'nome'], '');
        setIfMissing('FatherAccountKey', ['FatherAccountKey', 'fatheraccountkey', 'FatherNum', 'fathernum', 'conta_pai', 'pai'], '');
        setIfMissing('ActiveAccount', ['ActiveAccount', 'activeaccount', 'Postable', 'postable'], 'tYES');
        setIfMissing('AccountType', ['AccountType', 'accounttype', 'ActType', 'acttype']); // Sem fallback: remove campo vazio
    } else if (targetObject === 'Orders') {
        setIfMissing('CardCode', ['CardCode', 'cardcode', 'e1_cliente', 'cliente'], '');
        if (!Array.isArray(out.DocumentLines)) {
            out.DocumentLines = out.DocumentLines ? [out.DocumentLines] : [];
        }
    } else if (targetObject === 'JournalEntries') {
        if (!Array.isArray(out.JournalEntryLines)) {
            out.JournalEntryLines = out.JournalEntryLines ? [out.JournalEntryLines] : [];
        }
    }

    return out;
}

// Helper to transform record based on mapping
async function transformRecord(sourceRecord: any, mapping: TableMapping, supabase: any, duplicateAddress: boolean = false): Promise<any> {
    const targetRecord: any = {};
    const sapObject = mapping.targetObject; // e.g. BusinessPartners

    // Process each field mapping
    for (const field of mapping.fields) {
        if (!field.target) continue;

        // Para tipo 'static', 'expression' ou 'sap_sequence', source não é obrigatório
        const isSourceOptional = field.rule?.type === 'static' || field.rule?.type === 'sap_sequence' || field.rule?.type === 'expression' || field.rule?.type === 'lookup_composite';
        if (!isSourceOptional && !field.source) continue;

        let originalValue = field.source
            ? (sourceRecord[field.source] ?? 
               sourceRecord[field.source.toUpperCase()] ?? 
               sourceRecord[field.source.toLowerCase()] ??
               sourceRecord[normalizeKey(field.source)])
            : undefined;

        // Auto-match fallback: If the explicit source map yielded nothing, see if the Excel file provided
        // a column exactly matching the target SAP field name (e.g. 'cardname' -> 'CardName').
        if (originalValue === undefined || originalValue === null) {
            const targetBaseName = field.target.includes('.') ? field.target.split('.').pop()! : field.target;
            originalValue = sourceRecord[normalizeKey(targetBaseName)] ?? sourceRecord[targetBaseName] ?? sourceRecord[targetBaseName.toLowerCase()];
        }

        // Pula registros sem valor de origem APENAS para regras que exigem origem
        if (!isSourceOptional && (originalValue === undefined || originalValue === null || String(originalValue).trim() === '')) continue;

        let finalValue: any = typeof originalValue === 'string' ? originalValue.trim() : originalValue;

        // Apply Rule
        if (field.rule) {
            // Condition check
            if (field.rule.condition) {
                const cond = field.rule.condition;
                const recordVal = sourceRecord[cond.field] ?? 
                                sourceRecord[cond.field.toLowerCase()] ??
                                sourceRecord[normalizeKey(cond.field)];
                if (cond.operator === 'equals' && String(recordVal) !== String(cond.value)) continue;
                if (cond.operator === 'not_equals' && String(recordVal) === String(cond.value)) continue;
            }

            switch (field.rule.type) {
                case 'prefix':
                    finalValue = (field.rule.value || '') + originalValue;
                    break;
                case 'suffix':
                    finalValue = originalValue + (field.rule.value || '');
                    break;
                case 'static': {
                    // Auto-coerção de tipo: '1' → 1, 'true'/'false' → boolean, resto → string
                    const raw = field.rule.value ?? null;
                    console.log(`[static] target=${field.target} raw=${JSON.stringify(raw)}`);
                    if (raw === null || raw === '') {
                        finalValue = raw;
                    } else if (raw === 'true') {
                        finalValue = true;
                    } else if (raw === 'false') {
                        finalValue = false;
                    } else (!isNaN(Number(raw)) && raw.trim() !== '') ?
                        finalValue = Number(raw) : finalValue = raw;
                    console.log(`[static] → finalValue=${JSON.stringify(finalValue)}`);
                    break;
                }
                case 'expression': {
                    if (field.rule.expression) {
                        finalValue = field.rule.expression.replace(/\{([^}]+)\}/g, (_: string, key: string) => {
                            const val = sourceRecord[key] ?? sourceRecord[key.toUpperCase()] ?? sourceRecord[key.toLowerCase()] ?? sourceRecord[normalizeKey(key)];
                            return val !== undefined && val !== null ? String(val).trim() : '';
                        });
                    }
                    break;
                }
                case 'map':
                    const mapEntry = field.rule.map?.find((m: any) => m.from == originalValue);
                    if (mapEntry) finalValue = mapEntry.to;
                    break;
                case 'address_part':
                    const parts = TransformationUtils.parseAddress(originalValue);
                    if (field.rule.part && parts[field.rule.part as keyof typeof parts]) {
                        finalValue = parts[field.rule.part as keyof typeof parts];
                    } else {
                        finalValue = '';
                    }
                    break;
                case 'tax_id':
                    finalValue = TransformationUtils.formatTaxId(originalValue);
                    break;
                case 'lookup':
                    if (field.rule.lookupTable && field.rule.lookupKey && field.rule.lookupValue) {
                        try {
                            const { data } = await supabase
                                .from(field.rule.lookupTable)
                                .select(field.rule.lookupValue)
                                .eq(field.rule.lookupKey, originalValue)
                                .maybeSingle();
                            finalValue = data
                                ? data[field.rule.lookupValue]
                                : (field.rule.lookupFallback ?? null);
                        } catch {
                            finalValue = field.rule.lookupFallback ?? null;
                        }
                    }
                    break;
                case 'lookup_composite': {
                    // JOIN com chave composta: ex e1_cliente+e1_loja → sa1010.(a1_cod+a1_loja) → __sap_id
                    const ck = field.rule.compositeKey;
                    if (ck && field.rule.lookupTable && field.rule.lookupValue) {
                        let q = supabase.from(field.rule.lookupTable).select(field.rule.lookupValue);
                        for (let i = 0; i < ck.sourceFields.length; i++) {
                            const sf = ck.sourceFields[i];
                            const lf = ck.lookupKeyFields[i];
                            const sv = (sourceRecord[sf] || 
                                        sourceRecord[sf.toUpperCase()] || 
                                        sourceRecord[normalizeKey(sf)] || 
                                        '').toString().trim();
                                        
                            // Build dictionary for prefix lookup
                            const UF_CODES: Record<string, string> = {
                                'RO':'11', 'AC':'12', 'AM':'13', 'RR':'14', 'PA':'15', 'AP':'16', 'TO':'17',
                                'MA':'21', 'PI':'22', 'CE':'23', 'RN':'24', 'PB':'25', 'PE':'26', 'AL':'27', 'SE':'28', 'BA':'29',
                                'MG':'31', 'ES':'32', 'RJ':'33', 'SP':'35',
                                'PR':'41', 'SC':'42', 'RS':'43',
                                'MS':'50', 'MT':'51', 'GO':'52', 'DF':'53'
                            };

                            const isIbgeTarget = lf === 'uf' || lf === 'municipio' || lf.includes('codigo_ibge');
                            if (field.rule.lookupTable === 'ibge_municipios' && isIbgeTarget) {
                                // Extract the UF state code from ck
                                const ufIndex = ck.lookupKeyFields.indexOf('uf');
                                let munIndex = ck.lookupKeyFields.indexOf('municipio');
                                if (munIndex === -1) munIndex = ck.lookupKeyFields.findIndex((f: string) => f.includes('codigo_ibge'));
                                
                                if (ufIndex !== -1 && munIndex !== -1) {
                                    const rawUf = sourceRecord[ck.sourceFields[ufIndex]] || sourceRecord[normalizeKey(ck.sourceFields[ufIndex])] || '';
                                    const rawMun = sourceRecord[ck.sourceFields[munIndex]] || sourceRecord[normalizeKey(ck.sourceFields[munIndex])] || '';
                                    const parsedUf = String(rawUf).toString().trim().toUpperCase();
                                    const parsedMun = String(rawMun).toString().trim();
                                    
                                    if (UF_CODES[parsedUf]) {
                                        const exactIbge = UF_CODES[parsedUf] + parsedMun;
                                        // Apenas aplicamos o filtro UMA VEZ no loop (quando lf for uf, a gente aplica. quando for municipio, pula)
                                        if (lf === 'uf') {
                                            q = q.eq('codigo_ibge', exactIbge);
                                        }
                                        continue;
                                    }
                                }
                                
                                // Fallback se não conseguir parsear
                                if (lf !== 'uf') q = q.like('codigo_ibge', `%${sv}`);
                                continue;
                            }

                            if (lf.startsWith('endsWith:')) {
                                q = q.like(lf.split(':')[1], `%${sv}`);
                            } else if (lf.startsWith('startsWith:')) {
                                q = q.like(lf.split(':')[1], `${sv}%`);
                            } else if (lf.startsWith('like:')) {
                                q = q.ilike(lf.split(':')[1], `%${sv}%`);
                            } else {
                                q = q.eq(lf, sv);
                            }
                        }
                        try {
                            const { data, error } = await q.maybeSingle();
                            if (error) {
                                console.error('lookup_composite Supabase error:', error, 'Params:', ck, 'Fields:', sourceRecord);
                            }
                            finalValue = data
                                ? data[field.rule.lookupValue]
                                : (field.rule.lookupFallback ?? null);
                        } catch (e) {
                            console.error('lookup_composite Exception:', e);
                            finalValue = field.rule.lookupFallback ?? null;
                        }
                    }
                    break;
                }
                case 'date':
                    if (finalValue && String(finalValue).length === 8) {
                        const s = String(finalValue);
                        finalValue = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
                    }
                    break;
                case 'date_iso':
                    if (finalValue && typeof finalValue === 'string') {
                        // Converte 01/01/2026 para 2026-01-01T00:00:00Z
                        const parts = finalValue.split(/[\/\-]/);
                        if (parts.length >= 3) {
                            let day, month, year;
                            if (parts[0].length === 4) {
                                // Already YYYY-MM-DD
                                year = parts[0];
                                month = parts[1];
                                day = parts[2];
                            } else {
                                // Assuming DD/MM/YYYY
                                day = parts[0].padStart(2, '0');
                                month = parts[1].padStart(2, '0');
                                year = parts[2];
                            }
                            finalValue = `${year}-${month}-${day}T00:00:00Z`;
                        }
                    }
                    break;
                case 'sap_sequence':
                    finalValue = undefined;
                    break;
            }
        }

        if (finalValue === null || finalValue === undefined) continue;

        if (field.target.includes('.')) {
            const parts = field.target.split('.');
            const COLLECTION_FIELDS = ['BPAddresses', 'BPFiscalTaxIDCollection', 'ContactEmployees'];
            if (COLLECTION_FIELDS.includes(parts[0])) {
                const collectionName = parts[0];
                const propName = parts[1];

                if (!targetRecord[collectionName]) targetRecord[collectionName] = [];

                let itemIndex = 0;
                if (!targetRecord[collectionName][itemIndex]) targetRecord[collectionName][itemIndex] = {};

                targetRecord[collectionName][itemIndex][propName] = finalValue;
            } else {
                let current = targetRecord;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!current[parts[i]]) current[parts[i]] = {};
                    current = current[parts[i]];
                }
                current[parts[parts.length - 1]] = finalValue;
            }
        } else {
            targetRecord[field.target] = finalValue;
        }
    }

    if (sapObject === 'BusinessPartners') {
        const hasSapSequenceCardCode = mapping.fields.some(f => f.target === 'CardCode' && f.rule?.type === 'sap_sequence');
        if (!targetRecord.CardCode && !hasSapSequenceCardCode) {
            targetRecord.CardCode = sourceRecord['a1_cod'] || sourceRecord['A1_COD'];
        }

        if (!targetRecord.CardType) {
            if (mapping.sourceTable.startsWith('SA1')) targetRecord.CardType = 'C';
            else if (mapping.sourceTable.startsWith('SA2')) targetRecord.CardType = 'S';
        }

        if (targetRecord.BPAddresses && targetRecord.BPAddresses.length > 0) {
            if (!targetRecord.BPAddresses[0].AddressName) targetRecord.BPAddresses[0].AddressName = "Cobranca";
            targetRecord.BPAddresses[0].AddressType = "bo_BillTo";
            
            // Fix for Protheus country code (105 = Brazil in Siscomex) mapped to SAP format (BR)
            if (targetRecord.BPAddresses[0].Country === '105') {
                targetRecord.BPAddresses[0].Country = 'BR';
            }

            if (duplicateAddress) {
                const copy = { ...targetRecord.BPAddresses[0] };
                copy.AddressName = "Entrega";
                copy.AddressType = "bo_ShipTo";
                targetRecord.BPAddresses.push(copy);
            }
        }
    }

    return targetRecord;
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { entityId, table, sourceTable, limit = 50, offset = 0, duplicateAddress = false, bplId, filters = {}, excelFilters = [] } = body;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        let mapping: TableMapping | null = null;
        let pgTable: string = '';

        if (entityId) {
            console.log(`[Preview] Fetching mapping for entityId: ${entityId}`);
            const { data: entity, error: entityErr } = await supabase
                .from('migration_entities')
                .select('*')
                .eq('id', entityId)
                .single();

            if (!entityErr && entity) {
                const mappings = await getMappings();
                if (mappings[`EXCEL_${entityId}`]) {
                    mapping = mappings[`EXCEL_${entityId}`] as TableMapping;
                    console.log(`[Preview] Using local mapping.json override for EXCEL_${entityId}`);
                } else if (entity.mapping_config) {
                    mapping = entity.mapping_config as TableMapping;
                }
                pgTable = entity.staging_table;
                console.log(`[Preview] Found entity ${entity.name}. Using staging table: ${pgTable}`);
            } else {
                console.warn(`[Preview] Entity ${entityId} not found or error:`, entityErr?.message);
            }
        }

        if (!mapping) {
            const mappings = await getMappings();
            mapping = mappings[table];
            pgTable = (sourceTable || table).toLowerCase();
            console.log(`[Preview] Using file-based mapping for ${table}. Table: ${pgTable}`);
        }

        if (!mapping) {
            return NextResponse.json({ success: false, message: 'Mapping not found.' }, { status: 404 });
        }

        // ── Filtro por Períodos Contábeis em Aberto (OFPR) ───────────────────────
        // Aplica apenas para SE2010 e SE1010: restringe aos lançamentos cujo
        // campo de vencimento cai dentro de um período de lançamento em aberto.
        // Período "aberto" = t_due_date IS NULL (9999-12-31 foi convertido a NULL).
        //
        // SE2010: campo e2_vencrea (vencimento real, formato YYYYMMDD)
        // SE1010: campo e1_vencto  (vencimento, formato YYYYMMDD)
        const POSTING_PERIOD_TABLES = ['SE2010', 'SE1010'];
        const DATE_FIELD_MAP: Record<string, string> = {
            SE2010: 'e2_vencrea',
            SE1010: 'e1_vencto',
        };

        let openPeriodFilter: { gte: string; lte: string }[] = [];
        let periodFilterWarning: string | null = null;

        if (POSTING_PERIOD_TABLES.includes(table)) {
            const { data: openPeriods, error: ppErr } = await supabase
                .from('sap_posting_periods')
                .select('f_ref_date, t_ref_date')
                .is('t_due_date', null)           // apenas períodos em aberto
                .order('f_ref_date', { ascending: true });

            if (ppErr) {
                console.warn('[PostingPeriods] Erro ao buscar períodos:', ppErr.message);
                periodFilterWarning = 'Não foi possível carregar períodos contábeis. Exibindo todos os registros.';
            } else if (!openPeriods || openPeriods.length === 0) {
                periodFilterWarning = 'Nenhum período contábil em aberto encontrado em sap_posting_periods. Importe os períodos primeiro.';
            } else {
                openPeriodFilter = openPeriods
                    .filter((p: any) => p.f_ref_date && p.t_ref_date)
                    .map((p: any) => ({
                        gte: p.f_ref_date.replace(/-/g, ''), // YYYYMMDD
                        lte: p.t_ref_date.replace(/-/g, ''), // YYYYMMDD
                    }));
                console.log(`[PostingPeriods] ${openPeriodFilter.length} período(s) aberto(s) carregados.`);
            }
        }

        // Monta a query base com filtro de registros nao-deletados
        let query = supabase.from(pgTable).select('*').eq('d_e_l_e_t_', '');

        // ── Filtro fixo de Filial para SE1010 ─────────────────────────────────────
        // Importa apenas títulos da filial 01
        if (table === 'SE1010') {
            query = query.eq('e1_filial', '01');
            console.log('[SE1010] Filtro fixo: e1_filial = 01');
        }

        // Aplica filtro de período se disponível
        if (openPeriodFilter.length > 0) {
            const dateField = DATE_FIELD_MAP[table];
            const minDate = openPeriodFilter[0].gte;
            const maxDate = openPeriodFilter[openPeriodFilter.length - 1].lte;
            query = query.gte(dateField, minDate).lte(dateField, maxDate);
            console.log(`[PostingPeriods] Filtrando ${table}.${dateField} entre ${minDate} e ${maxDate}`);
        }

        // ── Filtros dinâmicos para carga de Planilha Excel ────────────────────────
        // Campos vêm da própria tabela de staging selecionada na UI.
        if (Array.isArray(excelFilters) && excelFilters.length > 0) {
            const safeFilters = (excelFilters as ExcelFilter[])
                .filter(f => f && typeof f.field === 'string' && typeof f.value === 'string')
                .filter(f => /^[a-zA-Z0-9_]+$/.test(f.field) && f.value.trim() !== '');

            for (const f of safeFilters) {
                const v = f.value.trim();
                if (f.operator === 'contains') {
                    query = query.ilike(f.field, `%${v}%`);
                } else if (f.operator === 'starts_with') {
                    query = query.ilike(f.field, `${v}%`);
                } else {
                    query = query.eq(f.field, v);
                }
            }
        }

        // ── Filtros manuais do usuário (SE2010 / SE1010) ─────────────────────────
        // Mapeamento dos campos de filtro para os campos reais em cada tabela.
        if (POSTING_PERIOD_TABLES.includes(table)) {
            // Campos comuns (mapeados por tabela)
            const FIELD_MAP: Record<string, Record<string, string>> = {
                SE2010: { codigo: 'e2_fornece', tipo: 'e2_tipo', prefixo: 'e2_prefixo', numero: 'e2_num', naturez: 'e2_naturez', filial: 'e2_filial', empfat: 'e2_empfat', nome: 'e2_nomfor', dtIni: 'e2_vencrea', dtFim: 'e2_vencrea', emIni: 'e2_emissao', emFim: 'e2_emissao' },
                SE1010: { codigo: 'e1_cliente', tipo: 'e1_tipo', prefixo: 'e1_prefixo', numero: 'e1_num', filial: 'e1_filial', empfat: 'e1_empfat', nome: 'e1_nomcli', dtIni: 'e1_vencto', dtFim: 'e1_vencto', emIni: 'e1_emissao', emFim: 'e1_emissao' },
            };
            const fm = FIELD_MAP[table] || {};

            if (filters.codigo && fm.codigo) query = query.ilike(fm.codigo, `${filters.codigo}%`);
            if (filters.tipo && fm.tipo) query = query.eq(fm.tipo, filters.tipo.toUpperCase());
            if (filters.prefixo && fm.prefixo) query = query.eq(fm.prefixo, filters.prefixo.toUpperCase());
            if (filters.numero && fm.numero) query = query.ilike(fm.numero, `%${filters.numero}%`);
            if (filters.naturez && fm.naturez) query = query.ilike(fm.naturez, `${filters.naturez}%`);
            if (filters.filial && fm.filial) query = query.eq(fm.filial, filters.filial);
            if (filters.empfat && fm.empfat) query = query.eq(fm.empfat, filters.empfat);
            if (filters.nome && fm.nome) query = query.ilike(fm.nome, `%${filters.nome}%`);
            // Vencimento (range extra, além do filtro de período)
            if (filters.dtIni && fm.dtIni) query = query.gte(fm.dtIni, filters.dtIni);
            if (filters.dtFim && fm.dtFim) query = query.lte(fm.dtFim, filters.dtFim);
            // Emissão (range)
            if (filters.emIni && fm.emIni) query = query.gte(fm.emIni, filters.emIni);
            if (filters.emFim && fm.emFim) query = query.lte(fm.emFim, filters.emFim);
            // Código SAP retornado após integração
            // sapCode: busca por valor específico
            if (filters.sapCode) {
                if (table === 'SE2010') {
                    const jdtNum = Number(filters.sapCode);
                    if (!isNaN(jdtNum)) query = query.eq('__sap_id', jdtNum);
                }
            }
            // sapStatus: IS NULL / IS NOT NULL — usa .filter() que gera SQL direto no PostgREST
            console.log(`[preview] ${table} filters recebidos:`, JSON.stringify(filters));
            if (filters.sapStatus === 'null') query = query.filter('__sap_id', 'is', null);
            if (filters.sapStatus === 'notnull') query = query.filter('__sap_id', 'not.is', null);

            const activeFilters = Object.entries(filters).filter(([, v]) => v).map(([k]) => k);
            if (activeFilters.length) console.log(`[Filters] ${table} filtros ativos:`, activeFilters);
        }

        // ── Filtros manuais do usuário (SA1010 / SA2010 / SB1010) ────────────────
        const CATALOG_TABLES = ['SA1010', 'SA2010', 'SB1010'];
        if (CATALOG_TABLES.includes(table)) {
            const CATALOG_FIELD_MAP: Record<string, Record<string, string>> = {
                SA1010: { codigo: 'a1_cod', loja: 'a1_loja', nome: 'a1_nome', filial: 'a1_filial', empfat: 'a1_empfat', cgc: 'a1_cgc', estado: 'a1_est', municipio: 'a1_mun' },
                SA2010: { codigo: 'a2_cod', loja: 'a2_loja', nome: 'a2_nome', filial: 'a2_filial', empfat: 'a2_empfat', cgc: 'a2_cgc', estado: 'a2_est', municipio: 'a2_mun' },
                SB1010: { codigo: 'b1_cod', descricao: 'b1_desc', filial: 'b1_filial', empfat: 'b1_empfat', grupo: 'b1_grupo' },
            };
            const cfm = CATALOG_FIELD_MAP[table] || {};

            if (filters.codigo && cfm.codigo) query = query.ilike(cfm.codigo, `${filters.codigo}%`);
            if (filters.loja && cfm.loja) query = query.eq(cfm.loja, filters.loja);
            if (filters.nome && cfm.nome) query = query.ilike(cfm.nome, `%${filters.nome}%`);
            if (filters.descricao && cfm.descricao) query = query.ilike(cfm.descricao, `%${filters.descricao}%`);
            if (filters.filial && cfm.filial) query = query.eq(cfm.filial, filters.filial);
            if (filters.empfat && cfm.empfat) query = query.eq(cfm.empfat, filters.empfat);
            if (filters.estado && cfm.estado) query = query.eq(cfm.estado, filters.estado.toUpperCase());
            if (filters.municipio && cfm.municipio) query = query.ilike(cfm.municipio, `%${filters.municipio}%`);
            if (filters.cgc && cfm.cgc) query = query.ilike(cfm.cgc, `%${filters.cgc}%`);
            if (filters.grupo && cfm.grupo) query = query.eq(cfm.grupo, filters.grupo);
            // sapCode: busca por valor específico em __sap_id
            if (filters.sapCode) query = query.ilike('__sap_id', `%${filters.sapCode}%`);
            // sapStatus: IS NULL / IS NOT NULL
            console.log(`[preview] ${table} filters recebidos:`, JSON.stringify(filters));
            if (filters.sapStatus === 'null') query = query.filter('__sap_id', 'is', null);
            if (filters.sapStatus === 'notnull') query = query.filter('__sap_id', 'not.is', null);

            const activeFilters = Object.entries(filters).filter(([, v]) => v).map(([k]) => k);
            if (activeFilters.length) console.log(`[Filters] ${table} filtros ativos:`, activeFilters);
        }

        const { data: sourceData, error } = await query.range(offset, offset + limit - 1);

        if (error) throw error;
        if (!sourceData || sourceData.length === 0) {
            return NextResponse.json({
                success: true,
                preview: [],
                periodFilterWarning,
            });
        }

        // DEV ONLY: Ignore SSL for self-signed certs
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        // Authenticate SAP once
        console.log('Attempting SAP Login at:', `${config.sap.serviceLayerUrl}/Login`);
        let cookies = '';
        let loginRes: Response | undefined;
        try {
            loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    CompanyDB: config.sap.companyDB,
                    UserName: config.sap.userName,
                    Password: config.sap.password
                })
            });
            if (loginRes.ok) {
                const setCookie = loginRes.headers.get('set-cookie');
                if (setCookie) cookies = setCookie;
                console.log('SAP Login Successful.');
            } else {
                console.error('SAP Login Failed:', await loginRes.text());
            }
        } catch (loginErr: any) {
            console.error('SAP Login Fetch Error (network unreachable?):', loginErr.message);
        }

        // Pre-resolve SAP sequences for fields with 'sap_sequence' rule
        const sapSequenceCache: Record<string, number | null> = {};

        if (cookies) {
            for (const field of mapping.fields) {
                if (field.rule?.type === 'sap_sequence' && field.rule.objectType) {
                    const cacheKey = `${field.rule.objectType}::${field.rule.seriesCode ?? 'default'}`;
                    if (!(cacheKey in sapSequenceCache)) {

                        const isLegacyBP = field.rule.objectType === 'bp_customer' || field.rule.objectType === 'bp_supplier';
                        if (isLegacyBP && !field.rule.seriesCode) {
                            const cardType = field.rule.objectType === 'bp_customer' ? 'C' : 'S';
                            const prefix = field.rule.objectType === 'bp_customer' ? 'C' : 'F';

                            try {
                                const filterQ = `CardType eq '${cardType}'`;
                                const bpUrl = `${config.sap.serviceLayerUrl}/BusinessPartners?$select=CardCode&$filter=${encodeURIComponent(filterQ)}&$orderby=CardCode desc&$top=1`;
                                const bpRes = await fetch(bpUrl, { headers: { 'Cookie': cookies } });

                                if (bpRes.ok) {
                                    const bpJson = await bpRes.json();
                                    const lastCode: string | undefined = bpJson.value?.[0]?.CardCode;
                                    if (lastCode && lastCode.startsWith(prefix)) {
                                        const numPart = parseInt(lastCode.replace(prefix, ''), 10);
                                        const nextNum = numPart + 1;
                                        const digits = lastCode.length - prefix.length;
                                        const nextCode = `${prefix}${String(nextNum).padStart(digits, '0')}`;
                                        sapSequenceCache[cacheKey] = nextCode as any;
                                        console.log(`[sap_sequence] BP ${cardType} next code: ${nextCode} (last was ${lastCode})`);
                                    } else {
                                        sapSequenceCache[cacheKey] = null;
                                    }
                                } else {
                                    sapSequenceCache[cacheKey] = null;
                                }
                            } catch (e) {
                                sapSequenceCache[cacheKey] = null;
                            }

                        } else {
                            try {
                                let sapDoc = field.rule.objectType;
                                let sapSubType = undefined;
                                if (sapDoc === 'bp_supplier') { sapDoc = '2'; sapSubType = 'S'; }
                                else if (sapDoc === 'bp_customer') { sapDoc = '2'; sapSubType = 'C'; }

                                const seriesPayload: any = { DocumentTypeParams: { Document: sapDoc } };
                                if (sapSubType) {
                                    seriesPayload.DocumentTypeParams.DocumentSubType = sapSubType;
                                }

                                const seriesRes = await fetch(`${config.sap.serviceLayerUrl}/SeriesService_GetDocumentSeries`, {
                                    method: 'POST',
                                    headers: { 'Cookie': cookies, 'Content-Type': 'application/json' },
                                    body: JSON.stringify(seriesPayload)
                                });
                                if (seriesRes.ok) {
                                    const seriesJson = await seriesRes.json();
                                    const seriesList: any[] = seriesJson.value || [];
                                    let chosenSeries = seriesList.find((s: any) => s.IsDefault === 'tYES');
                                    if (field.rule.seriesCode !== undefined && field.rule.seriesCode !== null) {
                                        const override = seriesList.find((s: any) => String(s.Series) === String(field.rule!.seriesCode));
                                        if (override) chosenSeries = override;
                                    }
                                    
                                    if (chosenSeries && chosenSeries.NextNumber !== undefined && chosenSeries.NextNumber !== null) {
                                        let nextStr = String(chosenSeries.NextNumber);
                                        if (chosenSeries.NumSize && chosenSeries.NumSize > 0) {
                                            nextStr = nextStr.padStart(chosenSeries.NumSize, '0');
                                        }
                                        const prefix = chosenSeries.BeginStr || '';
                                        const suffix = chosenSeries.EndStr || '';
                                        sapSequenceCache[cacheKey] = `${prefix}${nextStr}${suffix}` as any;
                                    } else {
                                        sapSequenceCache[cacheKey] = null;
                                    }
                                    console.log(`[sap_sequence] ObjectType ${field.rule.objectType} next number resolved: ${sapSequenceCache[cacheKey]}`);
                                } else {
                                    sapSequenceCache[cacheKey] = null;
                                }
                            } catch (e) {
                                sapSequenceCache[cacheKey] = null;
                            }
                        }
                    }
                }
            }
        }

        // ── Pré-carrega mapeamento Natureza → Conta SAP (sed010) ─────────────────
        const naturezaAccountMap: Record<string, string> = {};
        if (mapping.targetObject === 'JournalEntries') {
            const naturezaCodes = [...new Set(
                sourceData
                    .map((r: any) => (r.e2_naturez || r.E2_NATUREZ || '').trim())
                    .filter(Boolean)
            )];

            if (naturezaCodes.length > 0) {
                const { data: natRows } = await supabase
                    .from('sed010')
                    .select('ed_codigo, sap_account_code')
                    .in('ed_codigo', naturezaCodes);

                (natRows || []).forEach((n: any) => {
                    if (n.ed_codigo && n.sap_account_code) {
                        naturezaAccountMap[n.ed_codigo.trim()] = n.sap_account_code.trim();
                    }
                });
            }
        }

        // Transform all rows
        const transformedRows: any[] = [];
        for (const row of sourceData) {
            const transformed = await transformRecord(row, mapping, supabase, duplicateAddress);
            const normalized = normalizeTargetPayloadKeys(transformed, mapping.targetObject);
            const targetRec = ensureMandatoryPayloadFields(normalized, row, mapping.targetObject, mapping);

            // ── Special post-transform for JournalEntries (SE2010 → LCM) ──
            if (mapping.targetObject === 'JournalEntries') {
                const src = row;
                const amount = parseFloat(src.e2_saldo || src.e2_valor || '0');

                // ── Histórico / Observação (E2_HIST) ─────────────────────────────
                const hist = (src.e2_hist || '').trim();

                // ── Referências ──────────────────────────────────────────────────
                const fornCode = (src.e2_fornece || '').trim();
                const prefixo = (src.e2_prefixo || '').trim();
                const numero = (src.e2_num || '').trim();
                const parcela = (src.e2_parcela || '').trim();
                const tipo = (src.e2_tipo || '').trim();

                // Chave legível completa — apenas para o Memo
                const fullKey = [fornCode, prefixo, numero, parcela, tipo].filter(Boolean).join('/');

                // ── Data de vencimento real (E2_VENCREA) ────────────────────
                // Usado como DueDate e TaxDate tanto no header do JE quanto nas linhas.
                const vencreaRaw = (src.e2_vencrea || '').trim().replace(/\D/g, '');
                const dueDate = vencreaRaw.length === 8
                    ? `${vencreaRaw.slice(0, 4)}-${vencreaRaw.slice(4, 6)}-${vencreaRaw.slice(6, 8)}`
                    : targetRec.DueDate || undefined;

                // Aplica no header do JournalEntry
                // ReferenceDate = data em que o lançamento está sendo feito no sistema (hoje)
                const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
                targetRec.ReferenceDate = today;
                if (dueDate) {
                    targetRec.DueDate = dueDate;   // data de vencimento (E2_VENCREA)
                    targetRec.TaxDate = dueDate;   // data fiscal (E2_VENCREA)
                }

                // ── Resolve CardCode do fornecedor ───────────────────────────────
                // Estratégia em cascata:
                //   0. __sap_id já gravado em sa2010 (write-back) — mais rápido
                //   1. Tenta 'F' + fornCode.padStart(6,'0') — para códigos numéricos
                //   2. Tenta lookup por CNPJ: sa2010.a2_cgc → SAP FederalTaxID
                let cardCode: string | undefined = undefined;

                if (fornCode) {
                    // Opção 0: __sap_id já salvo em sa2010
                    try {
                        const { data: sa2Row0 } = await supabase
                            .from('sa2010')
                            .select('__sap_id')
                            .eq('a2_cod', fornCode)
                            .maybeSingle();
                        if (sa2Row0?.__sap_id) {
                            cardCode = sa2Row0.__sap_id.toString().trim();
                            console.log(`[SE2010] BP via __sap_id para ${fornCode}: ${cardCode}`);
                        }
                    } catch { /* skip */ }
                }

                if (fornCode && !cardCode && cookies) {
                    // Opção 1: código F + padStart numérico
                    const isNumeric = /^\d+$/.test(fornCode);
                    const candidateCode = isNumeric ? 'F' + fornCode.padStart(6, '0') : undefined;

                    if (candidateCode) {
                        try {
                            const bpCheckRes = await fetch(
                                `${config.sap.serviceLayerUrl}/BusinessPartners('${candidateCode}')?$select=CardCode`,
                                { headers: { 'Cookie': cookies } }
                            );
                            if (bpCheckRes.ok) cardCode = candidateCode;
                        } catch { /* skip */ }
                    }

                    // Opção 2: CNPJ via sa2010 → SAP FederalTaxID
                    if (!cardCode) {
                        try {
                            const { data: sa2Row } = await supabase
                                .from('sa2010')
                                .select('a2_cgc')
                                .eq('a2_cod', fornCode)
                                .maybeSingle();

                            const cnpj = sa2Row?.a2_cgc?.toString().trim();
                            if (cnpj) {
                                const taxFilter = `FederalTaxID eq '${cnpj}' and CardType eq 'S'`;
                                const bpUrl = `${config.sap.serviceLayerUrl}/BusinessPartners?$select=CardCode&$filter=${encodeURIComponent(taxFilter)}&$top=1`;
                                const bpRes = await fetch(bpUrl, { headers: { 'Cookie': cookies } });
                                if (bpRes.ok) {
                                    const bpJson = await bpRes.json();
                                    const found = bpJson.value?.[0]?.CardCode;
                                    if (found) {
                                        cardCode = found;
                                        console.log(`[SE2010] BP found via CNPJ for ${fornCode}: ${cardCode}`);
                                    }
                                }
                            }
                        } catch (e) {
                            console.warn(`[SE2010] CNPJ lookup failed for fornCode=${fornCode}`, e);
                        }
                    }

                    if (!cardCode) {
                        console.warn(`[SE2010] BP not found for fornCode=${fornCode} — ShortName omitido`);
                    }
                }

                // ── Conta de Débito (Despesa / Estoque) ──────────────────────────
                // Prioridade:
                //   1. sap_account_code mapeado na natureza (e2_naturez → sed010)
                //   2. e2_debito do Protheus
                //   3. Sentinela 'SEM_MAPEAMENTO': fácil de filtrar no preview
                const naturezaCode = (src.e2_naturez || '').trim();
                const mappedAccount = naturezaCode ? naturezaAccountMap[naturezaCode] : undefined;
                const debitAccount = mappedAccount
                    || (src.e2_debito || '').trim()
                    || 'SEM_MAPEAMENTO';
                const debitSource = mappedAccount ? `nat:${naturezaCode}`
                    : (src.e2_debito || '').trim() ? 'e2_debito'
                        : 'FALLBACK';

                // ── Conta de Crédito (Fornecedores a Pagar) ──────────────────────
                // IMPORTANTE: No SAP B1, contas de controle de BP (controlling type)
                // NÃO aceitam AccountCode direto em JournalEntries.
                // Quando ShortName (CardCode) é fornecido, o SAP B1 resolve a conta de
                // controle do fornecedor automaticamente — basta enviar ShortName sem AccountCode.
                const creditLine: Record<string, any> = {
                    Debit: 0,
                    Credit: amount,
                    ShortName: cardCode || undefined,
                    LineMemo: hist.slice(0, 50),
                    DueDate: dueDate,
                };
                // Só inclui AccountCode explícito se NÃO temos CardCode do fornecedor.
                if (!cardCode) {
                    creditLine.AccountCode = '201010010001'; // fallback: Fornecedores Nacionais
                }

                // ── Memo, Reference2, Reference3 e chave de deduplicação ─────────
                // Reference2 e Reference3 são atualizáveis via PATCH (campo patchável
                // confirmado empiricamente em 2026-02-26).
                const nomFor = (src.e2_nomfor || '').trim();
                targetRec.Memo = `CP ${fullKey} ${nomFor} ${hist}`.slice(0, 100);
                targetRec.Reference2 = fullKey.slice(0, 100);       // chave Protheus rastreável
                targetRec.Reference3 = nomFor.slice(0, 100);        // nome do fornecedor
                targetRec._fullKey = fullKey;

                targetRec.JournalEntryLines = [
                    {
                        // DEBIT: conta de despesa via natureza mapeada
                        // IMPORTANTE: NÃO enviar ShortName aqui — conta analítica normal.
                        // ShortName em conta de despesa faz o SAP tratar como controlling account.
                        AccountCode: debitAccount,
                        Debit: amount,
                        Credit: 0,
                        LineMemo: `[${debitSource}] ${hist}`.slice(0, 50),
                        DueDate: dueDate,   // E2_VENCREA também na linha de débito
                    },
                    creditLine,     // já contém DueDate: dueDate
                ];

                // ── Aplica BPLID (filial) em todas as linhas se informado ──────────
                // IMPORTANTE: No SAP Service Layer, o campo de filial nas linhas do
                // JournalEntry é 'BPLID' (maiúsculo), NÃO 'BPLId'.
                // 'BPLId' é inválido e gera erro -1000.
                // 'BPLID' é obrigatório quando Multi-Branch está habilitado no SAP B1.
                if (bplId !== undefined && bplId !== null && bplId !== '') {
                    const branchId = Number(bplId);
                    targetRec.JournalEntryLines = targetRec.JournalEntryLines.map((line: any) => ({
                        ...line,
                        BPLID: branchId,
                    }));
                }

                transformedRows.push({ source: row, target: targetRec });
            } else if (mapping.targetObject === 'Orders') {
                // ── SE1010 → Sales Orders SAP B1 ──────────────────────────────────
                const src = row;

                // DocDueDate e TaxDate a partir de E1_VENCREA
                const vencreaRaw1 = (src.e1_vencrea || '').trim().replace(/\D/g, '');
                if (vencreaRaw1.length === 8) {
                    const vencreaDate = `${vencreaRaw1.slice(0, 4)}-${vencreaRaw1.slice(4, 6)}-${vencreaRaw1.slice(6, 8)}`;
                    targetRec.DocDueDate = vencreaDate;
                    targetRec.TaxDate = vencreaDate;
                    targetRec.DocDate = vencreaDate;
                }

                // ── Chave de deduplicação: CLIENTE/PREFIXO/NUMERO/PARCELA/TIPO ──
                // Usamos NumAtCard (referência do cliente) como chave de busca no SAP.
                // Reference2 em Orders tem limite de chars menor — NÃO usar para fullKey.
                const clienteCode1 = (src.e1_cliente || '').trim();
                const prefixo1 = (src.e1_prefixo || '').trim();
                const numero1 = (src.e1_num || '').trim();
                const parcela1 = (src.e1_parcela || '').trim();
                const tipo1 = (src.e1_tipo || '').trim();
                const fullKey1 = [clienteCode1, prefixo1, numero1, parcela1, tipo1].filter(Boolean).join('/');

                // NumAtCard = chave composta usada para busca de duplicata no SAP
                targetRec.NumAtCard = fullKey1.slice(0, 100);
                targetRec._fullKey = fullKey1;

                // ── DocumentLines: SAP B1 exige ARRAY — converter objeto aninhado ──
                // transformRecord() cria { DocumentLines: { Quantity, ItemCode, ... } }
                // mas Orders exige [ { Quantity, ItemCode, ... } ]
                if (targetRec.DocumentLines && !Array.isArray(targetRec.DocumentLines)) {
                    targetRec.DocumentLines = [targetRec.DocumentLines];
                }

                transformedRows.push({ source: row, target: targetRec });
            } else {
                // Para outros tipos de mapeamento (BusinessPartners, Items, etc.)
                transformedRows.push({ source: row, target: targetRec });
            }
        } // fim: for (const row of sourceData)

        // --- SAP EXISTENCE CHECK LOGIC ---
        const chunkSize = 20;
        const results: { source: any, target: any, existsInSap: boolean, action: 'insert' | 'update', matchMethod?: 'card_code' | 'tax_id' | 'none', message?: string }[] = [];

        if (!cookies) {
            transformedRows.forEach(item => {
                results.push({
                    source: item.source,
                    target: item.target,
                    existsInSap: false,
                    action: 'insert',
                    message: "Skipped SAP existence check: No SAP session."
                });
            });
        } else if (mapping.targetObject === 'BusinessPartners') {
            const bpRows = transformedRows.map((item, index) => ({ ...item, originalIndex: index }));
            const notFoundByCardCode: typeof bpRows = [];

            const expectedCardType = table === 'SA2010' ? 'S' : table === 'SA1010' ? 'C' : null;
            const cardTypeFilter = expectedCardType ? ` and CardType eq '${expectedCardType}'` : '';

            console.log(`[BP Existence] Table: ${table}, expected CardType: ${expectedCardType ?? 'any'}`);

            // Step 1: Batch check by CardCode (filtered by CardType)
            const cardCodesToCheck = bpRows.filter(item => item.target.CardCode).map(item => item.target.CardCode);
            const existingCardCodes = new Set<string>();
            let cardCodeBatchDebugMsg = '';

            if (cardCodesToCheck.length > 0) {
                for (let i = 0; i < cardCodesToCheck.length; i += chunkSize) {
                    const chunk = cardCodesToCheck.slice(i, i + chunkSize);
                    const cardCodePart = chunk.map(k => `CardCode eq '${k}'`).join(' or ');
                    const filterQuery = `(${cardCodePart})${cardTypeFilter}`;
                    const checkUrl = `${config.sap.serviceLayerUrl}/BusinessPartners?$select=CardCode,CardType&$filter=${encodeURIComponent(filterQuery)}`;

                    try {
                        const checkRes = await fetch(checkUrl, {
                            headers: { 'Cookie': cookies, 'Prefer': 'odata.maxpagesize=500' }
                        });
                        if (checkRes.ok) {
                            const json = await checkRes.json();
                            json.value.forEach((rec: any) => existingCardCodes.add(String(rec.CardCode)));
                            console.log(`[BP CardCode Batch] Found ${json.value.length} existing BPs of type '${expectedCardType}'.`);
                        } else {
                            console.error(`BP CardCode Batch Check Failed: ${checkRes.status} - ${await checkRes.text()}`);
                            cardCodeBatchDebugMsg = `BP CardCode batch check failed (${checkRes.status})`;
                        }
                    } catch (e: any) {
                        console.error('BP CardCode Batch Check Exception:', e);
                        cardCodeBatchDebugMsg = `BP CardCode batch check error: ${e.message}`;
                    }
                }
            }

            bpRows.forEach(item => {
                const cardCode = item.target.CardCode;
                if (cardCode && existingCardCodes.has(cardCode)) {
                    results[item.originalIndex] = {
                        source: item.source,
                        target: item.target,
                        existsInSap: true,
                        action: 'update',
                        message: cardCodeBatchDebugMsg || undefined
                    };
                } else {
                    notFoundByCardCode.push(item);
                }
            });

            // Step 2: Individual check by FederalTaxID (CNPJ/CPF)
            for (const item of notFoundByCardCode) {
                const federalTaxID = item.target.FederalTaxID;
                let foundByFederalTaxID = false;
                let sapCardCode = null;
                let federalTaxIDDebugMsg = '';

                if (federalTaxID) {
                    const taxIdFilter = `FederalTaxID eq '${federalTaxID}'${cardTypeFilter}`;
                    const checkUrl = `${config.sap.serviceLayerUrl}/BusinessPartners?$select=CardCode,CardType,FederalTaxID&$filter=${encodeURIComponent(taxIdFilter)}`;

                    try {
                        const checkRes = await fetch(checkUrl, { headers: { 'Cookie': cookies } });
                        if (checkRes.ok) {
                            const json = await checkRes.json();
                            if (json.value && json.value.length > 0) {
                                foundByFederalTaxID = true;
                                sapCardCode = json.value[0].CardCode;
                                console.log(`[BP TaxID Match] FederalTaxID '${federalTaxID}' found as CardCode '${sapCardCode}' (CardType: ${json.value[0].CardType}).`);
                            }
                        } else {
                            console.error(`BP FederalTaxID Check Failed for ${federalTaxID}: ${checkRes.status} - ${await checkRes.text()}`);
                            federalTaxIDDebugMsg = `BP FederalTaxID check failed (${checkRes.status})`;
                        }
                    } catch (e: any) {
                        console.error(`BP FederalTaxID Check Exception for ${federalTaxID}:`, e);
                        federalTaxIDDebugMsg = `BP FederalTaxID check error: ${e.message}`;
                    }
                }

                if (foundByFederalTaxID && sapCardCode) {
                    item.target.CardCode = sapCardCode;
                    results[item.originalIndex] = {
                        source: item.source,
                        target: item.target,
                        existsInSap: true,
                        action: 'update',
                        matchMethod: 'tax_id',
                        message: federalTaxIDDebugMsg || undefined
                    };
                } else {
                    // INSERT: assign next sequential CardCode
                    for (const field of mapping.fields) {
                        if (field.rule?.type === 'sap_sequence' && field.rule.objectType && field.target) {
                            const cacheKey = `${field.rule.objectType}::${field.rule.seriesCode ?? 'default'}`;
                            const seqEntry = sapSequenceCache[cacheKey];
                            if (seqEntry !== null && seqEntry !== undefined) {
                                const seqStr = String(seqEntry);
                                if (isNaN(Number(seqStr)) || seqStr.match(/^[A-Za-z]/)) {
                                    item.target[field.target] = seqStr;
                                    const prefix = seqStr.match(/^[A-Za-z]+/)?.[0] ?? '';
                                    const numPart = parseInt(seqStr.slice(prefix.length), 10);
                                    const digits = seqStr.length - prefix.length;
                                    sapSequenceCache[cacheKey] = `${prefix}${String(numPart + 1).padStart(digits, '0')}` as any;
                                } else {
                                    const numVal = Number(seqStr);
                                    item.target[field.target] = numVal;
                                    sapSequenceCache[cacheKey] = (numVal + 1) as any;
                                }
                                
                                // Explicitly inject the Series property so SAP registers the document to the right sequence
                                if (field.rule.seriesCode !== undefined && field.rule.seriesCode !== null) {
                                    item.target['Series'] = field.rule.seriesCode;
                                }
                            }
                        }
                    }
                    results[item.originalIndex] = {
                        source: item.source,
                        target: item.target,
                        existsInSap: false,
                        action: 'insert',
                        message: cardCodeBatchDebugMsg || federalTaxIDDebugMsg || undefined
                    };
                }
            }
        } else if (
            mapping.targetObject === 'JournalEntries' ||
            mapping.targetObject === 'Invoices'
        ) {   // SE2010 / Invoices: deduplicação por Reference2 / JdtNum
            // ── Deduplicação por Reference2 — SE2010 (JournalEntries) e SE1010 (Invoices) ──
            //
            // Chave de rastreamento gravada em Reference2:
            //   SE2010: FORNECEDOR/PREFIXO/NUMERO/PARCELA/TIPO
            //   SE1010: CLIENTE/PREFIXO/NUMERO/PARCELA/TIPO
            //
            // Estratégia em cascata:
            //   1. Primário: __sap_id / sap_doc_entry gravado no Supabase (write-back) — rápido
            //   2. Fallback: busca por Reference2 no SAP — mais preciso que Memo

            const pgTable = table.toLowerCase();  // se2010 ou se1010
            const sapObject = mapping.targetObject; // 'JournalEntries' ou 'Invoices'

            const fullKeyToSapNum: Record<string, number> = {};

            // ── 1. Primário: __sap_id no Supabase ─────────────────────────────
            const recnosToCheck = sourceData.map((r: any) => r.r_e_c_n_o_).filter(Boolean);
            if (recnosToCheck.length > 0) {
                try {
                    const { data: jdtRows } = await supabase
                        .from(pgTable)
                        .select('r_e_c_n_o_, __sap_id')
                        .in('r_e_c_n_o_', recnosToCheck)
                        .not('__sap_id', 'is', null);

                    const recnoToJdtNum: Record<number, number> = {};
                    (jdtRows || []).forEach((row: any) => {
                        if (row.r_e_c_n_o_ && row.__sap_id) {
                            recnoToJdtNum[row.r_e_c_n_o_] = row.__sap_id;
                        }
                    });

                    transformedRows.forEach(item => {
                        const recno = item.source?.r_e_c_n_o_;
                        const jdtNum = recno ? recnoToJdtNum[recno] : undefined;
                        if (jdtNum) {
                            const fk = item.target._fullKey as string;
                            if (fk) fullKeyToSapNum[fk] = jdtNum;
                        }
                    });
                    console.log(`[${pgTable} dedup] __sap_id encontrados: ${Object.keys(fullKeyToSapNum).length}/${transformedRows.length}`);
                } catch (e) {
                    console.warn(`[${pgTable} dedup] Erro ao buscar __sap_id:`, e);
                }
            }

            // ── 2. Fallback: busca por Reference2 no SAP ─────────────────────────
            // Mais preciso que Memo — usa a chave composta exata gravada em Reference2
            if (cookies) {
                for (const item of transformedRows) {
                    const fk = item.target._fullKey as string;
                    if (!fk || fullKeyToSapNum[fk]) continue; // já resolvido

                    // Reference2 é truncado em 100 chars — usar eq para match exato
                    const ref2 = fk.slice(0, 100).replace(/'/g, "''");
                    const filterQ = `Reference2 eq '${ref2}'`;
                    const checkUrl = `${config.sap.serviceLayerUrl}/${sapObject}?$select=JdtNum,Reference2&$filter=${encodeURIComponent(filterQ)}&$top=1`;
                    try {
                        const res = await fetch(checkUrl, { headers: { 'Cookie': cookies } });
                        if (res.ok) {
                            const j = await res.json();
                            const found = (j.value || [])[0];
                            if (found?.JdtNum) {
                                fullKeyToSapNum[fk] = found.JdtNum;
                                console.log(`[${pgTable} dedup] Reference2 match: JdtNum=${found.JdtNum} para "${fk}"`);
                            }
                        }
                    } catch { /* ignore */ }
                }
            }

            transformedRows.forEach(item => {
                const fk = item.target._fullKey as string;
                delete item.target._fullKey;
                const existingJdtNum = fk ? fullKeyToSapNum[fk] : undefined;
                const exists = !!existingJdtNum;

                if (existingJdtNum) {
                    item.target._sapJdtNum = existingJdtNum;
                }

                results.push({
                    source: item.source,
                    target: item.target,
                    existsInSap: exists,
                    action: exists ? 'update' : 'insert',
                    message: exists
                        ? `Já integrado no SAP (${sapObject === 'JournalEntries' ? 'JdtNum' : 'DocEntry'}: ${existingJdtNum})`
                        : undefined
                });
            });
        } else if (mapping.targetObject === 'Orders') {
            // ── SE1010 → Orders: deduplicação por NumAtCard ──────────────────────
            // NumAtCard = CLIENTE/PREFIXO/NUMERO/PARCELA/TIPO
            // Primário: sap_jdt_num salvo no Supabase (write-back após INSERT)
            // Fallback: busca no SAP por NumAtCard

            const fullKeyToDocEntry: Record<string, number> = {};

            // 1. Primário: sap_jdt_num no Supabase (reutilizamos o campo como doc_entry)
            const recnosOrders = sourceData.map((r: any) => r.r_e_c_n_o_).filter(Boolean);
            if (recnosOrders.length > 0) {
                try {
                    const { data: docRows } = await supabase
                        .from('se1010')
                        .select('r_e_c_n_o_, sap_jdt_num')
                        .in('r_e_c_n_o_', recnosOrders)
                        .not('sap_jdt_num', 'is', null);

                    (docRows || []).forEach((row: any) => {
                        const fk = transformedRows.find(t => t.source?.r_e_c_n_o_ === row.r_e_c_n_o_)?.target?._fullKey;
                        if (fk && row.sap_jdt_num) fullKeyToDocEntry[fk] = row.sap_jdt_num;
                    });
                } catch (e) { console.warn('[Orders dedup] sap_jdt_num lookup falhou:', e); }
            }

            // 2. Fallback: busca no SAP por NumAtCard
            if (cookies) {
                for (const item of transformedRows) {
                    const fk = item.target._fullKey as string;
                    if (!fk || fullKeyToDocEntry[fk]) continue;

                    const numAtCard = (item.target.NumAtCard || '').replace(/'/g, "''");
                    if (!numAtCard) continue;

                    const filterQ = `NumAtCard eq '${numAtCard}'`;
                    const checkUrl = `${config.sap.serviceLayerUrl}/Orders?$select=DocEntry,NumAtCard&$filter=${encodeURIComponent(filterQ)}&$top=1`;
                    try {
                        const res = await fetch(checkUrl, { headers: { 'Cookie': cookies } });
                        if (res.ok) {
                            const j = await res.json();
                            const found = (j.value || [])[0];
                            if (found?.DocEntry) {
                                fullKeyToDocEntry[fk] = found.DocEntry;
                                console.log(`[Orders dedup] NumAtCard match: DocEntry=${found.DocEntry} para "${fk}"`);
                            }
                        }
                    } catch { /* ignore */ }
                }
            }

            transformedRows.forEach(item => {
                const fk = item.target._fullKey as string;
                delete item.target._fullKey;
                const existingDocEntry = fk ? fullKeyToDocEntry[fk] : undefined;
                const exists = !!existingDocEntry;

                if (existingDocEntry) {
                    item.target._sapDocEntry = existingDocEntry;
                }

                results.push({
                    source: item.source,
                    target: item.target,
                    existsInSap: exists,
                    action: exists ? 'update' : 'insert',
                    message: exists
                        ? `Sales Order já integrada (DocEntry: ${existingDocEntry})`
                        : undefined
                });
            });
        } else {
            // Generic batch check for other object types
            const keysToCheck = new Set<string>();
            const keyFieldMap: Record<string, string> = {
                'Items': 'ItemCode',
                'Invoices': 'DocEntry',
                'PurchaseInvoices': 'DocEntry',
                'ChartOfAccounts': 'Code',
                'BusinessPartners': 'CardCode',
                'BusinessPartnerGroups': 'Code',
            };
            const keyField = keyFieldMap[mapping.targetObject] || 'CardCode';

            transformedRows.forEach(item => {
                const key = item.target[keyField];
                if (key) keysToCheck.add(String(key));
            });

            const existingKeys = new Set<string>();
            let batchDebugMsg = '';

            if (keysToCheck.size > 0) {
                const keysArray = Array.from(keysToCheck);
                for (let i = 0; i < keysArray.length; i += chunkSize) {
                    const chunk = keysArray.slice(i, i + chunkSize);
                    const filterQuery = chunk.map(k => `${keyField} eq '${k}'`).join(' or ');
                    const checkUrl = `${config.sap.serviceLayerUrl}/${mapping.targetObject}?$select=${keyField}&$filter=${encodeURIComponent(filterQuery)}`;

                    try {
                        const checkRes = await fetch(checkUrl, {
                            headers: { 'Cookie': cookies, 'Prefer': 'odata.maxpagesize=500' }
                        });
                        if (checkRes.ok) {
                            const json = await checkRes.json();
                            json.value.forEach((rec: any) => existingKeys.add(String(rec[keyField])));
                        } else {
                            console.error(`${mapping.targetObject} Batch Check Failed: ${checkRes.status} - ${await checkRes.text()}`);
                            batchDebugMsg = `${mapping.targetObject} batch check failed (${checkRes.status})`;
                        }
                    } catch (e: any) {
                        console.error(`${mapping.targetObject} Batch Check Exception:`, e);
                        batchDebugMsg = `${mapping.targetObject} batch check error: ${e.message}`;
                    }
                }
            }

            const bgUpdates: Promise<any>[] = [];

            transformedRows.forEach(item => {
                const key = item.target[keyField];
                const exists = key && existingKeys.has(String(key));

                if (exists && item.source) {
                    const pkField = item.source.r_e_c_n_o_ ? 'r_e_c_n_o_' : 'id';
                    const stagingId = item.source[pkField];
                    if (stagingId) {
                        if (sourceTable.startsWith('EXCEL_') && !item.source.__sap_id) {
                            bgUpdates.push(supabase.from(sourceTable).update({ __sap_id: String(key) }).eq(pkField, stagingId) as unknown as Promise<any>);
                        } else if (!sourceTable.startsWith('EXCEL_') && !item.source.sap_code && !['SE1010', 'SE2010'].includes(sourceTable)) {
                            bgUpdates.push(supabase.from(sourceTable).update({ sap_code: String(key) }).eq(pkField, stagingId) as unknown as Promise<any>);
                        }
                    }
                }

                results.push({
                    source: item.source,
                    target: item.target,
                    existsInSap: exists,
                    action: exists ? 'update' : 'insert',
                    message: (!exists && batchDebugMsg) ? batchDebugMsg : undefined
                });
            });

            if (bgUpdates.length > 0) {
                 Promise.allSettled(bgUpdates).catch(e => console.error('[Preview] Failed to update staging keys:', e));
            }
        }

        return NextResponse.json({
            success: true,
            preview: results,
            totalProcessed: sourceData.length,
            ...(periodFilterWarning ? { periodFilterWarning } : {}),
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
