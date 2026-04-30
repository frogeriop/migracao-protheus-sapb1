import { NextResponse } from 'next/server';
import axios from 'axios';
import https from 'https';
import fs from 'fs/promises';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

/**
 * Debug route: retorna os primeiros registros brutos de UserFieldsMD e UserFields
 * para inspecionar quais TableNames existem no SAP.
 * Uso: GET /api/sap/debug-udf
 */
export async function GET(request: Request) {
    try {
        const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
        const config = JSON.parse(raw);
        if (!config.sap) return NextResponse.json({ error: 'SAP não configurado' }, { status: 400 });

        const { serviceLayerUrl, companyDB, userName, password, language } = config.sap;
        const baseURL = serviceLayerUrl.replace(/\/$/, '');
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });
        const client = axios.create({ baseURL, httpsAgent, headers: { 'Content-Type': 'application/json' } });

        const loginRes = await client.post('/Login', { CompanyDB: companyDB, UserName: userName, Password: password, Language: language || 29 });
        const rawCookies: string[] = loginRes.headers['set-cookie'] || [];
        const cookieHeader = rawCookies.map(c => c.split(';')[0]).join('; ');

        const results: Record<string, any> = {};

        // Tenta UserFieldsMD
        try {
            const r = await client.get('/UserFieldsMD', {
                params: { $select: 'TableName,FieldID,Name', $top: 100 },
                headers: { Cookie: cookieHeader },
            });
            const data: any[] = r.data?.value || [];
            // Agrupa TableNames únicos
            const tableNames = [...new Set(data.map(f => f.TableName))].sort();
            results.UserFieldsMD = { count: data.length, tableNames, sample: data.slice(0, 10) };
        } catch (e: any) {
            results.UserFieldsMD = { error: e?.response?.data?.error?.message?.value || e.message };
        }

        // Tenta UserFields
        try {
            const r = await client.get('/UserFields', {
                params: { $select: 'TableName,FieldID,Name', $top: 100 },
                headers: { Cookie: cookieHeader },
            });
            const data: any[] = r.data?.value || [];
            const tableNames = [...new Set(data.map(f => f.TableName))].sort();
            results.UserFields = { count: data.length, tableNames, sample: data.slice(0, 10) };
        } catch (e: any) {
            results.UserFields = { error: e?.response?.data?.error?.message?.value || e.message };
        }

        await client.post('/Logout', {}, { headers: { Cookie: cookieHeader } }).catch(() => {});

        return NextResponse.json(results);
    } catch (error: any) {
        return NextResponse.json({ error: error?.response?.data?.error?.message?.value || error.message }, { status: 500 });
    }
}
