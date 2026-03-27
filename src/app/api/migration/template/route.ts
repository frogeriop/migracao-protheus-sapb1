import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { SAP_SCHEMAS } from '@/lib/sap-schemas';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';
import { createClient } from '@supabase/supabase-js';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const entityId = searchParams.get('entityId');

    if (!entityId) {
        return NextResponse.json({ success: false, message: 'Entity ID is required' }, { status: 400 });
    }

    try {
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // Get entity details
        const { data: entity, error } = await supabase
            .from('migration_entities')
            .select('*')
            .eq('id', entityId)
            .single();

        if (error || !entity) {
            return NextResponse.json({ success: false, message: 'Entity not found' }, { status: 404 });
        }

        const schema = SAP_SCHEMAS[entity.target_object];
        if (!schema) {
            return NextResponse.json({ success: false, message: 'Schema not defined for this entity' }, { status: 404 });
        }

        // Create a template with ALL expected fields as headers
        const headers = schema.templateFields;
        
        // Basic examples based on entity type
        let exampleRow = headers.map(() => '');
        
        if (entity.target_object === 'BusinessPartners') {
            const examples: Record<string, string> = {
                'CardCode': 'C001',
                'CardName': 'Empresa Exemplo Ltda',
                'CardType': 'C',
                'GroupCode': '100',
                'FederalTaxID': '12.345.678/0001-90',
                'EmailAddress': 'contato@exemplo.com',
                'Phone1': '11988887777',
                'BPAddresses.AddressName': 'Principal',
                'BPAddresses.AddressType': 'bo_BillTo',
                'BPAddresses.Street': 'Avenida Paulista',
                'BPAddresses.StreetNo': '1000',
                'BPAddresses.Block': 'Bela Vista',
                'BPAddresses.ZipCode': '01310-100',
                'BPAddresses.City': 'São Paulo',
                'BPAddresses.U_TX_CNAE': '6201501'
            };
            exampleRow = headers.map(h => examples[h] || 'Exemplo');
        } else if (entity.target_object === 'Items') {
            const examples: Record<string, string> = {
                'ItemCode': 'ITEM001',
                'ItemName': 'Produto Exemplo',
                'ForeignName': 'Example Product',
                'ItemsGroupCode': '101',
                'PurchaseUnit': 'UN',
                'SalesUnit': 'UN',
                'InventoryUoM': 'UN'
            };
            exampleRow = headers.map(h => examples[h] || '... ');
        } else if (entity.target_object === 'ChartOfAccounts') {
            const examples: Record<string, string> = {
                'Code': '1.01.01.01',
                'Name': 'Caixa Geral',
                'AccountType': 'atAsset',
                'FatherAccountKey': '1.01.01',
                'ExternalCode': '10001',
                'Currency': 'BRL'
            };
            exampleRow = headers.map(h => examples[h] || '');
        } else if (entity.target_object === 'ProfitCenters') {
            const examples: Record<string, string> = {
                'CenterCode': 'ADM',
                'CenterName': 'Administrativo',
                'GroupCode': '1',
                'InWhichDimension': '1',
                'Active': 'tYES'
            };
            exampleRow = headers.map(h => examples[h] || '');
        }

        const worksheet = XLSX.utils.aoa_to_sheet([headers, exampleRow]);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Modelo');

        // Write to buffer
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        return new Response(buffer, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="modelo_${entity.name.toLowerCase().replace(/\s+/g, '_')}.xlsx"`
            }
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
