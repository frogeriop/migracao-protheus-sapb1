export interface BusinessPartner {
    CardCode: string; // Primary Key
    CardName?: string;
    CardType?: 'C' | 'S' | 'L'; // C=Customer, S=Vendor, L=Lead
    GroupCode?: number;
    FederalTaxID?: string;
    EmailAddress?: string;
    Phone1?: string;
    ContactPerson?: string;
    Notes?: string;
    [key: string]: any; // Allow dynamic fields
}

export interface BusinessPartnerPayload {
    CardCode: string;
    CardName: string;
    CardType: 'C' | 'S' | 'L';
    GroupCode?: number;
    FederalTaxID?: string;
    EmailAddress?: string;
    [key: string]: any;
}
