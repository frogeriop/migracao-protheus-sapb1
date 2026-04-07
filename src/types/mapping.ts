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
    | 'static'             // NEW: valor fixo (literal), ignorando source
    | 'today';             // data do dia na integração (preview = marcador; execute substitui)

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
    value?: string;            // prefix/suffix/static: valor literal | today: formato (iso, br, yyyymmdd, isodt, iso_z)
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
    source: string;   // Campo Protheus (ex: e1_cliente) — ignorado para static / expression / today
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

/**
 * SE1010 → Orders: desmembra um título em várias linhas de DocumentLines.
 * Cada linha tem ItemCode e fórmulas próprias (placeholders {e1_valor}, {campo}).
 * Se `orderLineTemplates.lines` tiver pelo menos uma linha válida, substitui
 * o DocumentLines gerado pelo mapeamento plano (uma linha por título).
 */
export interface OrderLineTemplate {
    /** ItemCode SAP (literal ou template com {campo}) */
    itemCode: string;
    /** Expressão com {campo}; default "1" */
    quantityFormula?: string;
    /** Use com Quantity: valor unitário da linha */
    unitPriceFormula?: string;
    /** Alternativa: total da linha (Quantity 1); não use junto com unitPriceFormula */
    lineTotalFormula?: string;
}

export interface OrderLineTemplatesConfig {
    lines: OrderLineTemplate[];
    /** Campo numérico do título para aviso de conferência (ex.: e1_valor) */
    compareTotalField?: string;
    /** Ajusta a última linha para fechar com compareTotalField (diferença de arredondamento) */
    reconcileLastLine?: boolean;
}

/**
 * SE1010 → Orders: um único ItemCode (linha base do mapeamento), valor repartido em
 * vários Centros de Resultado (tipicamente DocumentLines.CostingCode2 = Dimensão 2).
 * Se `resultCenterDistribution.lines` tiver itens válidos, tem precedência sobre
 * `orderLineTemplates` (não combina os dois).
 */
export interface ResultCenterLine {
    /** Código do centro no SAP (ou template com {campo}) */
    centerCode: string;
    /** Legado: preferir `lineTotalFormula` (tela simplificada = um único “Valor”) */
    quantityFormula?: string;
    unitPriceFormula?: string;
    /** Valor total da linha (fórmula); no motor vira Quantity=1 e UnitPrice=avaliado */
    lineTotalFormula?: string;
}

/** Debug do preview: expressão numérica após substituir placeholders (o que o eval executa). */
export interface ResultCenterFormulaExecution {
    centerIndex: number;
    centerCode: string;
    mode: 'lineTotal' | 'unitPrice';
    formulaTemplate: string;
    /** Expressão após `substitutePlaceholdersNumeric` — entrada de `evalNumericExpression`. */
    substitutedExpression: string;
    quantitySubstituted: string;
    quantity: number;
    /** Resultado do eval da fórmula principal (valor de UnitPrice ou line-total conforme o modo). */
    evaluatedMain: number;
    /** `Quantity * UnitPrice` da linha montada (equivale a `lineMonetaryAmount`). */
    monetaryAmount: number;
}

export interface ResultCenterDistributionConfig {
    lines: ResultCenterLine[];
    compareTotalField?: string;
    reconcileLastLine?: boolean;
    /**
     * Campo na linha do pedido onde gravar o código do centro.
     * CostingCode2 costuma ser Dimensão 2 (Centro de resultado) — validar no seu SAP.
     */
    lineDimensionField?: 'CostingCode' | 'CostingCode2';
    /**
     * multiLine (padrão se ausente): várias linhas com o mesmo ItemCode e CostingCode2 por centro.
     * singleLine: uma linha com valor total; o rateio por centro deve ser concluído no SAP (distribuição manual / dimensões).
     */
    distributionMode?: 'multiLine' | 'singleLine';
    /**
     * Dimensão usada em DistributionRules.InWhichDimension (ex.: 2 = CostingCode2 / centro de resultado).
     * Usado ao criar OOCR via Service Layer após inclusão do pedido.
     */
    inWhichDimension?: number;
}

export interface TableMapping {
    sourceTable: string;    // ex: SE1010
    targetObject: string;   // ex: Orders (Sales Order), Invoices, JournalEntries...
    fields: FieldMapping[]; // Campos de cabeçalho + linha única (quando sem templates)
    lines?: DocumentLinesMapping; // Legado (não usado no pipeline atual)
    /** SE1010 → Orders: várias linhas por fórmula (tem precedência sobre mapeamento plano de DocumentLines) */
    orderLineTemplates?: OrderLineTemplatesConfig;
    /** SE1010 → Orders: mesmo produto, várias linhas com CostingCode/CostingCode2 (precede orderLineTemplates) */
    resultCenterDistribution?: ResultCenterDistributionConfig;
    keyField?: string;      // Campo SAP usado como chave de deduplicação (ex: DocNum)
}

export interface MappingConfig {
    [key: string]: TableMapping;
}
