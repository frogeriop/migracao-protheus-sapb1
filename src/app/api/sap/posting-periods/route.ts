import { NextResponse } from 'next/server';
import axios from 'axios';
import https from 'https';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function sapLogin(config: AppConfig): Promise<string> {
    const { serviceLayerUrl, companyDB, userName, password, language } = config.sap;
    const res = await axios.post(`${serviceLayerUrl}/Login`, {
        CompanyDB: companyDB, UserName: userName, Password: password, Language: language || 29
    }, { httpsAgent });
    return (res.headers['set-cookie'] || []).join('; ');
}

/**
 * Importa períodos contábeis (OFPR) via SQLQueries do SAP Service Layer.
 * OFPR não tem endpoint OData direto — usamos query SQL temporária.
 *
 * Campos confirmados: AbsEntry, Name, F_RefDate, T_RefDate, F_DueDate, T_DueDate, Indicator
 */
async function fetchPostingPeriods(serviceLayerUrl: string, cookieStr: string): Promise<any[]> {
    const SQL_CODE = 'OFPR_IMP';
    const SQL_TEXT = 'SELECT AbsEntry, Name, F_RefDate, T_RefDate, F_DueDate, T_DueDate, Indicator FROM OFPR ORDER BY AbsEntry';

    // Remove query anterior se existir
    try {
        await axios.delete(`${serviceLayerUrl}/SQLQueries('${SQL_CODE}')`, {
            httpsAgent, headers: { Cookie: cookieStr }
        });
    } catch { /* ignora se não existia */ }

    // Cria a query SQL no SAP
    await axios.post(`${serviceLayerUrl}/SQLQueries`, {
        SqlCode: SQL_CODE,
        SqlName: SQL_CODE,
        SqlText: SQL_TEXT
    }, { httpsAgent, headers: { Cookie: cookieStr } });

    // Pagina os resultados
    const all: any[] = [];
    let skip = 0;
    const PAGE = 50;

    while (true) {
        const res = await axios.get<{ value: any[] }>(
            `${serviceLayerUrl}/SQLQueries('${SQL_CODE}')/List?$top=${PAGE}&$skip=${skip}`,
            { httpsAgent, headers: { Cookie: cookieStr } }
        );
        const rows = res.data?.value ?? [];
        all.push(...rows);
        if (rows.length < PAGE) break;
        skip += PAGE;
    }

    // Remove query temporária
    try {
        await axios.delete(`${serviceLayerUrl}/SQLQueries('${SQL_CODE}')`, {
            httpsAgent, headers: { Cookie: cookieStr }
        });
    } catch { /* ignora */ }

    return all;
}

/**
 * Converte string de data SAP (YYYYMMDD ou '99991231') para ISO date ou null.
 */
function toDate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = String(raw).replace(/\D/g, '');
    if (s.length !== 8 || s === '99991231') return null;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// POST: { action: 'init' } — importa todos os períodos de OFPR
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { action } = body;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        if (action === 'init') {
            const cookieStr = await sapLogin(config);
            const records = await fetchPostingPeriods(config.sap.serviceLayerUrl, cookieStr);

            if (records.length === 0) {
                return NextResponse.json({ success: true, total: 0, rowsCopied: 0, message: 'Nenhum período encontrado em OFPR.' });
            }

            const rows = records.map((r: any) => ({
                abs_entry: Number(r.AbsEntry),
                name: r.Name ?? '',
                f_ref_date: toDate(r.F_RefDate),
                t_ref_date: toDate(r.T_RefDate),
                f_due_date: toDate(r.F_DueDate),
                t_due_date: toDate(r.T_DueDate),
                indicator: r.Indicator ?? '',
                imported_at: new Date().toISOString(),
            }));

            // Upsert completo — recria os dados
            const { error } = await supabase
                .from('sap_posting_periods')
                .upsert(rows, { onConflict: 'abs_entry' });

            if (error) throw new Error(error.message);

            return NextResponse.json({
                success: true,
                total: records.length,
                rowsCopied: rows.length,
            });
        }

        if (action === 'batch') {
            return NextResponse.json({ success: true, rowsCopied: 0 });
        }

        return NextResponse.json({ success: false, message: 'Action inválida.' }, { status: 400 });

    } catch (error: any) {
        console.error('[sap/posting-periods]', error?.response?.data || error.message);
        return NextResponse.json({
            success: false,
            message: error?.response?.data?.error?.message?.value || error.message
        }, { status: 500 });
    }
}

// DELETE: limpa a tabela
export async function DELETE() {
    try {
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });
        const { error } = await supabase
            .from('sap_posting_periods')
            .delete()
            .neq('abs_entry', -999999);
        if (error) throw new Error(error.message);
        return NextResponse.json({ success: true, message: 'Períodos Contábeis limpos.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
