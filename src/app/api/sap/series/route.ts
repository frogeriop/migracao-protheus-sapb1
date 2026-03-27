import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const objectType = searchParams.get('objectType');

    if (!objectType) {
        return NextResponse.json({ success: false, message: 'objectType é obrigatório' }, { status: 400 });
    }

    try {
        const configPath = path.join(process.cwd(), 'config.json');
        if (!fs.existsSync(configPath)) {
            return NextResponse.json({ success: false, message: 'Configuração SAP ausente' }, { status: 500 });
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!config.sap) {
            return NextResponse.json({ success: false, message: 'Credenciais SAP ausentes' }, { status: 500 });
        }

        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        // Login
        const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CompanyDB: config.sap.companyDB,
                UserName: config.sap.userName,
                Password: config.sap.password
            })
        });

        if (!loginRes.ok) {
            const errText = await loginRes.text();
            return NextResponse.json({ success: false, message: 'Falha no login SAP: ' + errText }, { status: 401 });
        }

        const cookies = loginRes.headers.get('set-cookie') || '';

        // Parse specific subtypes mapping (like BP Customer vs BP Supplier)
        let sapDocument = objectType;
        let sapDocSubType = undefined;

        if (objectType === 'bp_supplier') {
            sapDocument = '2';
            sapDocSubType = 'S';
        } else if (objectType === 'bp_customer') {
            sapDocument = '2';
            sapDocSubType = 'C';
        }

        // Query Series
        const seriesPayload: any = { DocumentTypeParams: { Document: sapDocument } };
        if (sapDocSubType) {
            seriesPayload.DocumentTypeParams.DocumentSubType = sapDocSubType;
        }

        const seriesRes = await fetch(`${config.sap.serviceLayerUrl}/SeriesService_GetDocumentSeries`, {
            method: 'POST',
            headers: {
                'Cookie': cookies,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(seriesPayload)
        });

        if (!seriesRes.ok) {
            const errText = await seriesRes.text();
            return NextResponse.json({ success: false, message: 'Falha ao buscar séries: ' + errText }, { status: seriesRes.status });
        }

        const seriesJson = await seriesRes.json();
        
        // optional: auto logout since it's a stateless quick fetch
        await fetch(`${config.sap.serviceLayerUrl}/Logout`, { method: 'POST', headers: { 'Cookie': cookies } }).catch(() => {});

        const activeSeries = (seriesJson.value || []).filter((s: any) => s.Locked === 'tNO');
        return NextResponse.json({ success: true, series: activeSeries });

    } catch (e: any) {
        return NextResponse.json({ success: false, message: 'Erro interno: ' + e.message }, { status: 500 });
    }
}
