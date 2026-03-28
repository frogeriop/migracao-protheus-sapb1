export interface SapEntitySchema {
    targetObject: string;
    label: string;
    identifyingFields: string[]; // Fields that strongly identify this object (e.g. CardCode for BP)
    templateFields: string[];    // All expected fields for a complete migration template
    aliases: Record<string, string[]>; // Common aliases for identifying fields
}

export const SAP_SCHEMAS: Record<string, SapEntitySchema> = {
    'BusinessPartners': {
        targetObject: 'BusinessPartners',
        label: 'Parceiros de Negócio',
        identifyingFields: ['CardCode', 'CardName', 'CardType'],
        templateFields: [
            'CardCode', 'CardName', 'AliasName', 'CardType', 'GroupCode', 'FederalTaxID', 
            'EmailAddress', 'Phone1', 'BPAddresses.AddressName', 'BPAddresses.AddressType',
            'BPAddresses.Street', 'BPAddresses.StreetNo', 'BPAddresses.Block', 
            'BPAddresses.ZipCode', 'BPAddresses.City', 'BPAddresses.U_TX_CNAE'
        ],
        aliases: {
            'CardCode': ['Código', 'Código do PN', 'CardCode', 'ID'],
            'CardName': ['Nome', 'Razão Social', 'CardName', 'Nome do Parceiro'],
            'CardType': ['Tipo', 'CardType']
        }
    },
    'ProfitCenters': {
        targetObject: 'ProfitCenters',
        label: 'Centros de Custo',
        identifyingFields: ['CenterCode', 'CenterName', 'CostCenterType', 'CenterOwner', 'Active', 'GroupCode', 'EffectiveFrom'],
        templateFields: ['CenterCode', 'CenterName', 'CostCenterType', 'CenterOwner', 'Active', 'GroupCode', 'InWhichDimension', 'EffectiveFrom'],
        aliases: {
            'CenterCode': ['Código', 'Código do Centro', 'Cód. Centro', 'CenterCode', 'PrcCode'],
            'CenterName': ['Nome', 'Nome do Centro', 'CenterName', 'PrcName'],
            'CostCenterType': ['Tipo', 'CostCenterType', 'CCType'],
            'CenterOwner': ['Proprietário', 'CenterOwner', 'Owner'],
            'Active': ['Ativo', 'Active', 'Status'],
            'GroupCode': ['Grupo', 'GroupCode'],
            'EffectiveFrom': ['Data de Início', 'Válido Desde', 'EffectiveFrom', 'ValidFrom']
        }
    },
    'Items': {
        targetObject: 'Items',
        label: 'Itens',
        identifyingFields: ['ItemCode', 'ItemName'],
        templateFields: ['ItemCode', 'ItemName', 'ForeignName', 'ItemsGroupCode', 'PurchaseUnit', 'SalesUnit', 'InventoryUoM'],
        aliases: {
            'ItemCode': ['Código', 'Código do Item', 'ItemCode'],
            'ItemName': ['Descrição', 'Nome do Item', 'ItemName']
        }
    },
    'ChartOfAccounts': {
        targetObject: 'ChartOfAccounts',
        label: 'Plano de Contas',
        identifyingFields: ['Code', 'Name'],
        templateFields: ['Code', 'Name', 'AccountType', 'FatherAccountKey', 'ExternalCode', 'Currency'],
        aliases: {
            'Code': ['Código', 'Conta', 'Code', 'AcctCode'],
            'Name': ['Nome', 'Descrição', 'Name', 'AcctName']
        }
    },
    'BusinessPartnerGroups': {
        targetObject: 'BusinessPartnerGroups',
        label: 'Grupos de Parceiros',
        identifyingFields: ['Code', 'Name'],
        templateFields: ['Code', 'Name', 'Type'],
        aliases: {
            'Code': ['Código', 'Nº do grupo', 'Code'],
            'Name': ['Nome', 'Nome do grupo', 'Name']
        }
    }
};

export function detectEntityMismatch(entityName: string, targetObject: string, columns: string[]): { mismatch: boolean; expectedObject?: string } {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedCols = columns.map(normalize);

    const checkMatch = (schema: SapEntitySchema) => {
        // Return true only if ALL identifying fields (or their aliases) are found
        return schema.identifyingFields.every(field => {
            const normalizedField = normalize(field);
            if (normalizedCols.includes(normalizedField)) return true;
            
            const aliases = schema.aliases[field] || [];
            return aliases.some(alias => normalizedCols.includes(normalize(alias)));
        });
    };

    // 1. Check if the current columns match the target object
    const targetSchema = SAP_SCHEMAS[targetObject];
    if (!targetSchema) return { mismatch: false };

    if (checkMatch(targetSchema)) {
        return { mismatch: false };
    }

    // 2. If it doesn't match the target, check if it matches ANY OTHER schema instead
    for (const [key, otherSchema] of Object.entries(SAP_SCHEMAS)) {
        if (key === targetObject) continue;
        if (checkMatch(otherSchema)) {
            return { mismatch: true, expectedObject: otherSchema.label };
        }
    }

    // 3. If it matches nothing, it's still a mismatch because it lacks identifying fields for the target
    return { mismatch: true };
}
