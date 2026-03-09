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
 * Busca TODOS os registros do SAP paginando corretamente.
 *
 * PROBLEMA anterior: $top=200, mas SAP SL retorna max 20 por página.
 * O loop encerrava após a 1ª página porque items.length (20) < TOP (200).
 *
 * SOLUÇÃO: usa $top=20 e segue @odata.nextLink quando disponível.
 * Fallback: continua enquanto page cheia (items.length === PAGE_SIZE).
 */
async function fetchAllAccounts(serviceLayerUrl: string, cookieStr: string): Promise<any[]> {
    const PAGE_SIZE = 20; // valor seguro para todas as versões do SAP SL
    const all: any[] = [];
    let currentUrl = `${serviceLayerUrl}/ChartOfAccounts?$top=${PAGE_SIZE}&$skip=0`;

    while (currentUrl) {
        type SapResponse = { value: any[]; '@odata.nextLink'?: string };
        const res = await axios.get<SapResponse>(currentUrl, {
            httpsAgent,
            headers: { Cookie: cookieStr },
        });

        const items: any[] = res.data?.value ?? [];
        all.push(...items);

        const nextLink: string | undefined = res.data?.['@odata.nextLink'];
        if (nextLink) {
            // Segue nextLink fornecido pelo SAP SL
            currentUrl = nextLink.startsWith('http')
                ? nextLink
                : `${serviceLayerUrl}/${nextLink}`;
        } else if (items.length === PAGE_SIZE) {
            // Página cheia sem nextLink → provavelmente há mais registros
            currentUrl = `${serviceLayerUrl}/ChartOfAccounts?$top=${PAGE_SIZE}&$skip=${all.length}`;
        } else {
            // Última página
            break;
        }
    }

    return all;
}

/**
 * Detecta o campo de nível no objeto de conta (SAP SL varia entre versões).
 * Possíveis nomes: Level, AcctLevel, LvlCode, AccountLevel
 */
function getLevelValue(account: any): number | null {
    const candidates = ['Level', 'AcctLevel', 'LvlCode', 'AccountLevel', 'level'];
    for (const key of candidates) {
        const val = account[key];
        if (val !== undefined && val !== null) {
            const num = Number(val);
            if (!isNaN(num)) return num;
        }
    }
    return null;
}

/**
 * Filtra apenas contas ANALÍTICAS (nível mais profundo).
 *
 * Estratégia 1 — Campo de nível detectado:
 *   Encontra o nível máximo entre todas as contas e mantém apenas esse nível.
 *
 * Estratégia 2 — Fallback (sem campo de nível):
 *   Mantém contas cujo código NÃO aparece como FatherAccountKey de outra conta (folhas).
 */
function filterAnalytical(accounts: any[]): { items: any[]; strategy: string; maxLevel: number | null } {
    // Tenta pelo campo de nível
    const levels = accounts.map(a => getLevelValue(a)).filter((v): v is number => v !== null);

    if (levels.length > 0) {
        const maxLevel = Math.max(...levels);
        const items = accounts.filter(a => getLevelValue(a) === maxLevel);
        return { items, strategy: `level=${maxLevel}`, maxLevel };
    }

    // Fallback: detecção de folhas via FatherAccountKey
    const parentCodes = new Set(
        accounts
            .map(a => (a.FatherAccountKey ?? a.ParentAccount ?? '').trim())
            .filter(Boolean)
    );
    const items = accounts.filter(a => {
        const code = (a.Code ?? a.AcctCode ?? '').trim();
        return code && !parentCodes.has(code);
    });
    return { items, strategy: 'leaf-detection', maxLevel: null };
}

// POST: { action: 'init' } — faz tudo em uma única chamada (fetch + filter + upsert)
// POST: { action: 'batch', offset, cookieStr } — mantido p/ compatibilidade (fat unused)
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { action } = body;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false }
        });

        // ── INIT: autentica, busca tudo, filtra analíticas, salva ─────────────
        if (action === 'init') {
            const cookies = await sapLogin(config);
            const cookieStr = cookies.join('; ');

            // 1. Busca todos os registros
            const allAccounts = await fetchAllAccounts(config.sap.serviceLayerUrl, cookieStr);

            // 2. Filtra analíticas pelo nível máximo (ou fallback por folhas)
            const { items: analytical, strategy, maxLevel } = filterAnalytical(allAccounts);

            if (analytical.length === 0) {
                return NextResponse.json({ success: true, total: 0, rowsCopied: 0, message: 'Nenhuma conta analítica encontrada.' });
            }

            // 2. DROP + CREATE — tabela sempre recriada do zero
            const dropRes = await supabase.rpc('exec_sql', { query: 'DROP TABLE IF EXISTS "sap_chart_of_accounts";' });
            if (dropRes.error) throw new Error(`DROP falhou: ${dropRes.error.message}`);

            const createRes = await supabase.rpc('exec_sql', {
                query: `
                CREATE TABLE "sap_chart_of_accounts" (
                    code           text PRIMARY KEY,
                    name           text,
                    balance        numeric,
                    account_type   text,
                    external_code  text,
                    currency       text,
                    protected      boolean DEFAULT false,
                    father_account text,
                    imported_at    timestamp
                );
            ` });
            if (createRes.error) throw new Error(`CREATE falhou: ${createRes.error.message}`);

            // 3. Mapeamento defensivo
            const rows = analytical.map((i: any) => ({
                code: i.Code ?? i.AcctCode ?? '',
                name: i.Name ?? i.AcctName ?? '',
                balance: i.Balance ?? i.CurrTotal ?? null,
                account_type: i.AccountType ?? i.AccType ?? '',
                external_code: i.ExternalCode ?? i.ExtCode ?? '',
                currency: i.ActCurr ?? i.AcctCurr ?? i.CurrCode ?? '',
                protected: (i.Protected ?? i.Locked) === 'tYES',
                father_account: i.FatherAccountKey ?? i.ParentAccount ?? '',
                imported_at: new Date().toISOString(),
            }));

            // 4. Upsert em lotes de 200
            const BATCH = 200;
            let saved = 0;
            for (let i = 0; i < rows.length; i += BATCH) {
                const chunk = rows.slice(i, i + BATCH);
                const { error } = await supabase
                    .from('sap_chart_of_accounts')
                    .insert(chunk); // tabela foi recriada do zero, sem conflitos
                if (error) throw new Error(error.message);
                saved += chunk.length;
            }

            return NextResponse.json({
                success: true,
                total: allAccounts.length,
                synthetic: allAccounts.length - analytical.length,
                rowsCopied: saved,
                strategy,     // ex: 'level=5' ou 'leaf-detection'
                maxLevel,
                cookieStr,
            });
        }

        // ── BATCH: mantido por compatibilidade com o frontend atual ───────────
        // O frontend pode chamar batch com offset, retornamos 0 rows para encerrar
        if (action === 'batch') {
            return NextResponse.json({ success: true, rowsCopied: 0 });
        }

        return NextResponse.json({ success: false, message: 'Action inválida.' }, { status: 400 });

    } catch (error: any) {
        console.error('[sap/chart-of-accounts]', error?.response?.data || error.message);
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
        const { error } = await supabase.from('sap_chart_of_accounts').delete().neq('code', '~~never~~');
        if (error) throw new Error(error.message);
        return NextResponse.json({ success: true, message: 'Plano de Contas limpo.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
