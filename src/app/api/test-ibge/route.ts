import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export async function GET() {
    try {
        const config = JSON.parse(await fs.readFile(path.join(process.cwd(), 'config.json'), 'utf8'));
        const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
            method: 'POST',
            body: JSON.stringify({
                CompanyDB: config.sap.companyDB, 
                UserName: config.sap.userName, 
                Password: config.sap.password
            })
        });
        const cookies = loginRes.headers.get('set-cookie');
        
        // Let's get 5 counties
        const res = await fetch(`${config.sap.serviceLayerUrl}/Counties?$top=5`, {
            headers: { 'Cookie': cookies || '' }
        });
        const data = await res.json();
        
        // Also look up explicitly Sao Luis (2111300) to see what it looks like
        const res2 = await fetch(`${config.sap.serviceLayerUrl}/Counties?$filter=Name eq 'São Luís' or Name eq 'SAO LUIS' or Name eq 'Sao Luis'`, {
            headers: { 'Cookie': cookies || '' }
        });
        const data2 = await res2.json();

        return NextResponse.json({
            countiesSubset: data,
            saoLuis: data2
        });
    } catch(err: any) {
        return NextResponse.json({ error: err.message });
    }
}
