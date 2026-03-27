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

async function sapLogin(config: AppConfig): Promise<string[]> {
    const { serviceLayerUrl, companyDB, userName, password, language } = config.sap;
    const res = await axios.post(`${serviceLayerUrl}/Login`, {
        CompanyDB: companyDB, UserName: userName, Password: password, Language: language || 29
    }, { httpsAgent, headers: { 'Content-Type': 'application/json' } });
    return res.headers['set-cookie'] || [];
}

/**
 * Busca TODOS os centros de custo do SAP, paginando internamente.
 */
async function fetchAllCenters(serviceLayerUrl: string, cookieStr: string): Promise<any[]> {
    const all: any[] = [];
    let skip = 0;

    while (true) {
        const res = await axios.get(`${serviceLayerUrl}/ProfitCenters`, {
            httpsAgent,
            headers: { Cookie: cookieStr },
            // Sem $select para evitar erros de propriedade inválida nesta versão do SAP SL
            params: { $skip: skip },
        });
        const items: any[] = res.data?.value || [];
        if (items.length === 0) break;
        
        all.push(...items);
        skip += items.length;
    }

    return all;
}

/**
 * Filtra apenas centros de custo ANALÍTICOS (folhas).
 * Um centro é sintético se seu código aparece como parent de outro.
 * Campos possíveis de parent: ParentCenterCode, ParentCode, GroupCode.
 */
function filterAnalytical(centers: any[]): any[] {
    const parentCodes = new Set(
        centers
            .map(c => (
                c.ParentCenterCode ?? c.ParentCode ?? c.GroupCode ?? ''
            ).trim())
            .filter(Boolean)
    );

    // Se não houver nenhuma hierarquia, retorna todos (ProfitCenters flat)
    if (parentCodes.size === 0) return centers;

    return centers.filter(c => {
        const code = (c.CenterCode ?? c.Code ?? '').trim();
        return code && !parentCodes.has(code);
    });
}

// POST: { action: 'init' } — faz tudo em uma única chamada (fetch + filter + upsert)
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { action } = body;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        // ── INIT: busca tudo, filtra analíticos, salva ────────────────────────
        if (action === 'init') {
            const cookies = await sapLogin(config);
            const cookieStr = cookies.join('; ');

            // 1. Busca todos os registros
            const allCenters = await fetchAllCenters(config.sap.serviceLayerUrl, cookieStr);

            // 2. Filtra apenas analíticos
            const analytical = filterAnalytical(allCenters);

            if (analytical.length === 0) {
                return NextResponse.json({ success: true, total: 0, rowsCopied: 0, message: 'Nenhum centro de custo analítico encontrado.' });
            }

            // 2. DROP + CREATE — tabela sempre recriada do zero
            const dropRes = await supabase.rpc('exec_sql', { query: 'DROP TABLE IF EXISTS "sap_cost_centers";' });
            if (dropRes.error) throw new Error(`DROP falhou: ${dropRes.error.message}`);

            const createRes = await supabase.rpc('exec_sql', {
                query: `
                CREATE TABLE "sap_cost_centers" (
                    code        text PRIMARY KEY,
                    name        text,
                    imported_at timestamp
                );
            ` });
            if (createRes.error) throw new Error(`CREATE falhou: ${createRes.error.message}`);

            // 3. Mapeamento
            const rows = analytical.map((i: any) => ({
                code: i.CenterCode ?? i.Code ?? '',
                name: i.CenterName ?? i.Name ?? '',
                imported_at: new Date().toISOString(),
            }));

            // 4. Upsert em lotes
            const BATCH = 200;
            let saved = 0;
            for (let i = 0; i < rows.length; i += BATCH) {
                const chunk = rows.slice(i, i + BATCH);
                const { error } = await supabase
                    .from('sap_cost_centers')
                    .upsert(chunk, { onConflict: 'code', ignoreDuplicates: false });
                if (error) throw new Error(error.message);
                saved += chunk.length;
            }

            return NextResponse.json({
                success: true,
                total: allCenters.length,
                synthetic: allCenters.length - analytical.length,
                rowsCopied: saved,
                cookieStr,
            });
        }

        // ── BATCH: compatibilidade ────────────────────────────────────────────
        if (action === 'batch') {
            return NextResponse.json({ success: true, rowsCopied: 0 });
        }

        return NextResponse.json({ success: false, message: 'Action inválida.' }, { status: 400 });

    } catch (error: any) {
        console.error('[sap/cost-centers]', error?.response?.data || error.message);
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
        const { error } = await supabase.from('sap_cost_centers').delete().neq('code', '~~never~~');
        if (error) throw new Error(error.message);
        return NextResponse.json({ success: true, message: 'Centros de Custo limpos.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
