export type RuleType =
    | 'none'
    | 'prefix'
    | 'suffix'
    | 'map'
    | 'address_part'
    | 'tax_id'
    | 'lookup'
    | 'lookup_composite'   // NEW: lookup com chave composta (ex: cod+loja)
    | 'sap_sequence'
    | 'date'
    | 'date_iso'
    | 'concat'
    | 'expression'         // NEW: expressão com templates (e.g. {e1_num}/{e1_titulo})
    | 'static';            // NEW: valor fixo (literal), ignorando source

export interface ValueMap {
    from: string;
    to: string;
}

export interface RuleCondition {
    field: string;
    operator: 'equals' | 'not_equals';
    value: string;
}

/**
 * Chave composta para lookup: combina múltiplos campos da fonte como chave.
 * Ex: { sourceFields: ['e1_cliente','e1_loja'], separator: '' }
 *     + { lookupTable: 'sa1010', lookupKey: ... }
 * Para lookup_composite, usa lookupKeyFields (array) ao invés de lookupKey.
 */
export interface CompositeKey {
    sourceFields: string[];   // campos da fonte a concatenar
    separator?: string;       // separador entre eles (default '')
    lookupKeyFields: string[]; // campos da tabela de lookup a concatenar para comparação
}

export interface MappingRule {
    type: RuleType;
    value?: string;            // prefix/suffix/static: valor literal
    expression?: string;       // expression: template string (ex: {e1_num}/{e1_titulo})
    map?: ValueMap[];          // map: de/para
    part?: 'street' | 'number' | 'complement' | 'type'; // address_part
    lookupTable?: string;      // lookup/lookup_composite: tabela Supabase
    lookupKey?: string;        // lookup: campo único de chave na tabela de lookup
    lookupValue?: string;      // lookup/lookup_composite: campo a retornar
    compositeKey?: CompositeKey; // lookup_composite: definição da chave composta
    lookupFallback?: string;   // lookup: valor padrão se não encontrar
    seriesCode?: number;       // sap_sequence: Series code
    objectType?: string;       // sap_sequence: tipo do objeto SAP
    condition?: RuleCondition; // Aplicar somente se condição for verdadeira
}

export interface FieldMapping {
    source: string;   // Campo Protheus (ex: e1_cliente) — ignorado para rule.type==='static'
    target: string;   // Campo SAP (ex: CardCode)
    rule?: MappingRule;
}

/**
 * Configuração de linhas (DocumentLines) para documentos com itens.
 * Ex: Sales Order, A/R Invoice, Purchase Order, etc.
 *
 * Cada registro na tabela fonte gerará UMA linha no documento SAP.
 * Campos do cabeçalho (header) são copiados de um registro âncora
 * (o primeiro do grupo ou fornecidos externamente).
 */
export interface DocumentLinesMapping {
    /** Campos que identificam o grupo/documento (para agrupar linhas do mesmo pedido).
     *  Ex: ['e1_num', 'e1_prefixo', 'e1_filial'] */
    groupByFields: string[];
    /** Mapeamento dos campos de cada linha → DocumentLines[i] */
    fields: FieldMapping[];
}

export interface TableMapping {
    sourceTable: string;    // ex: SE1010
    targetObject: string;   // ex: Orders (Sales Order), Invoices, JournalEntries...
    fields: FieldMapping[]; // Campos do cabeçalho
    lines?: DocumentLinesMapping; // Mapeamento das linhas (itens do documento)
    keyField?: string;      // Campo SAP usado como chave de deduplicação (ex: DocNum)
}

export interface MappingConfig {
    [key: string]: TableMapping;
}
