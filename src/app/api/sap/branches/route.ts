import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

/**
 * GET /api/sap/branches
 * Busca as filiais (Branches) configuradas no SAP Business One
 * via BranchesService_GetBranchList.
 *
 * Retorna lista de { BPLId, BPLName, Disabled, DefaultWarehouseID, ... }
 */
export async function GET() {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const config = await getConfig();

        // 1. Login SAP
        const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CompanyDB: config.sap.companyDB,
                UserName: config.sap.userName,
                Password: config.sap.password,
                Language: config.sap.language || 29,
            }),
        });

        if (!loginRes.ok) {
            const errText = await loginRes.text();
            return NextResponse.json({ success: false, message: `SAP Login falhou: ${errText}` }, { status: 401 });
        }

        const cookies = loginRes.headers.get('set-cookie') || '';

        // 2. Busca filiais via /BusinessPlaces (endpoint correto para Multi-Branch SAP B1)
        // Retorna: BPLID, BPLName, Disabled, DefaultWarehouseID, FederalTaxID, AliasName, etc.
        const branchRes = await fetch(
            `${config.sap.serviceLayerUrl}/BusinessPlaces?$select=BPLID,BPLName,AliasName,Disabled,DefaultWarehouseID,FederalTaxID,MainBPL`,
            {
                method: 'GET',
                headers: { 'Cookie': cookies },
            }
        );

        if (!branchRes.ok) {
            const errText = await branchRes.text();
            return NextResponse.json({
                success: false,
                message: `BusinessPlaces falhou (${branchRes.status}): ${errText}`,
            }, { status: branchRes.status });
        }

        const branchJson = await branchRes.json();

        // A resposta é { value: [ { BPLID, BPLName, ... }, ... ] }
        const allBranches: any[] = branchJson.value ?? [];

        // Filtra apenas filiais ativas (Disabled !== 'tYES')
        const activeBranches = allBranches.filter((b: any) => b.Disabled !== 'tYES');

        return NextResponse.json({
            success: true,
            data: activeBranches.map((b: any) => ({
                bplId: b.BPLID,
                bplName: b.BPLName,
                aliasName: b.AliasName ?? null,
                disabled: b.Disabled === 'tYES',
                defaultWarehouse: b.DefaultWarehouseID ?? null,
                federalTaxId: b.FederalTaxID ?? null,
                isMain: b.MainBPL === 'tYES',
            })),
        });




    } catch (error: any) {
        console.error('[sap/branches]', error.message);
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
