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
        CompanyDB: companyDB, UserName: userName, Password: password, Language: language || 29,
    }, { httpsAgent, headers: { 'Content-Type': 'application/json' } });
    return (res.headers['set-cookie'] || []).join('; ');
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function fetchAllPages(baseUrl: string, cookieStr: string): Promise<any[]> {
    const PAGE = 20;
    const all: any[] = [];
    let url: string | null = `${baseUrl}?$top=${PAGE}&$skip=0`;
    while (url) {
        type PageData = { value: any[]; '@odata.nextLink'?: string };
        const res: { data: PageData } = await axios.get<PageData>(url, { httpsAgent, headers: { Cookie: cookieStr } });
        const items: any[] = res.data?.value ?? [];
        all.push(...items);
        const next: string | undefined = res.data?.['@odata.nextLink'];
        if (next) {
            url = next.startsWith('http') ? next : `${baseUrl.split('/').slice(0, 3).join('/')}/${next}`;
        } else if (items.length === PAGE) {
            url = `${baseUrl}?$top=${PAGE}&$skip=${all.length}`;
        } else {
            url = null;
        }
    }
    return all;
}

const toBool = (v: any) => v === 'tYES' || v === true;
const toInt = (v: any): number | null => { const n = parseInt(String(v ?? '-1'), 10); return n === -1 ? null : n; };
const toDate = (v: any): string | null => { if (!v) return null; const s = String(v).split('T')[0]; return s || null; };

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT: Business Places
// ─────────────────────────────────────────────────────────────────────────────
async function importBusinessPlaces(supabase: any, serviceLayerUrl: string, cookieStr: string) {
    const records = await fetchAllPages(`${serviceLayerUrl}/BusinessPlaces`, cookieStr);

    const rows = records.map((b: any) => ({
        bpl_id: b.BPLID,
        bpl_name: b.BPLName ?? null,
        bpl_name_foreign: b.BPLNameForeign ?? null,
        alias_name: b.AliasName ?? null,
        main_bpl: toBool(b.MainBPL),
        disabled: toBool(b.Disabled),
        federal_tax_id: b.FederalTaxID ?? null,
        federal_tax_id2: b.FederalTaxID2 ?? null,
        federal_tax_id3: b.FederalTaxID3 ?? null,
        vat_reg_num: b.VATRegNum ?? null,
        additional_id_number: b.AdditionalIdNumber ?? null,
        tax_office: b.TaxOffice ?? null,
        tax_office_no: b.TaxOfficeNo ?? null,
        default_warehouse_id: b.DefaultWarehouseID ?? null,
        default_resource_warehouse_id: b.DefaultResourceWarehouseID ?? null,
        default_tax_code: b.DefaultTaxCode ?? null,
        default_customer_id: b.DefaultCustomerID ?? null,
        default_vendor_id: b.DefaultVendorID ?? null,
        payment_clearing_account: b.PaymentClearingAccount ?? null,
        address_type: b.AddressType ?? null,
        street: b.Street ?? null,
        street_no: b.StreetNo ?? null,
        building: b.Building ?? null,
        block: b.Block ?? null,
        zip_code: b.ZipCode ?? null,
        city: b.City ?? null,
        state: b.State ?? null,
        county: b.County ?? null,
        country: b.Country ?? null,
        address_full: b.Address ?? null,
        address_foreign: b.Addressforeign ?? null,
        rep_name: b.RepName ?? null,
        industry: b.Industry ?? null,
        business: b.Business ?? null,
        sped_profile: b.SPEDProfile ?? null,
        commercial_register: b.CommercialRegister ?? null,
        date_of_incorporation: toDate(b.DateOfIncorporation),
        global_location_number: b.GlobalLocationNumber ?? null,
        nature_of_company_code: toInt(b.NatureOfCompanyCode),
        economic_activity_type_code: toInt(b.EconomicActivityTypeCode),
        credit_contribution_origin_code: b.CreditContributionOriginCode ?? null,
        ipi_period_code: b.IPIPeriodCode ?? null,
        cooperative_association_type_code: toInt(b.CooperativeAssociationTypeCode),
        profit_taxation_code: toInt(b.ProfitTaxationCode),
        company_qualification_code: toInt(b.CompanyQualificationCode),
        declarer_type_code: toInt(b.DeclarerTypeCode),
        preferred_state_code: b.PreferredStateCode ?? null,
        environment_type: toInt(b.EnvironmentType),
        opting4_icms: toBool(b.Opting4ICMS),
        ie_numbers: b.BusinessPlaceIENumbers ?? [],
        tributary_infos: b.BusinessPlaceTributaryInfos ?? [],
        imported_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('sap_business_places')
        .upsert(rows, { onConflict: 'bpl_id' });

    if (error) throw new Error(`sap_business_places: ${error.message}`);
    return { total: records.length, saved: rows.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT: Chart of Accounts (apenas analíticas)
// ─────────────────────────────────────────────────────────────────────────────
function getLevelValue(a: any): number | null {
    for (const k of ['Level', 'AcctLevel', 'LvlCode', 'AccountLevel', 'level']) {
        const v = a[k]; if (v !== undefined && v !== null) { const n = Number(v); if (!isNaN(n)) return n; }
    }
    return null;
}

function filterAnalyticalAccounts(accounts: any[]): { items: any[]; strategy: string } {
    const levels = accounts.map(getLevelValue).filter((v): v is number => v !== null);
    if (levels.length > 0) {
        const max = Math.max(...levels);
        return { items: accounts.filter(a => getLevelValue(a) === max), strategy: `level=${max}` };
    }
    const parents = new Set(accounts.map(a => (a.FatherAccountKey ?? a.ParentAccount ?? '').trim()).filter(Boolean));
    return {
        items: accounts.filter(a => { const c = (a.Code ?? a.AcctCode ?? '').trim(); return c && !parents.has(c); }),
        strategy: 'leaf-detection',
    };
}

async function importChartOfAccounts(supabase: any, serviceLayerUrl: string, cookieStr: string) {
    const allAccounts = await fetchAllPages(`${serviceLayerUrl}/ChartOfAccounts`, cookieStr);
    const { items: analytical, strategy } = filterAnalyticalAccounts(allAccounts);

    // Recria tabela do zero
    await supabase.rpc('exec_sql', { query: 'DROP TABLE IF EXISTS "sap_chart_of_accounts";' });
    await supabase.rpc('exec_sql', {
        query: `CREATE TABLE "sap_chart_of_accounts" (
            code           text PRIMARY KEY,
            name           text,
            balance        numeric,
            account_type   text,
            external_code  text,
            currency       text,
            protected      boolean DEFAULT false,
            father_account text,
            imported_at    timestamp
        );`
    });

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

    const BATCH = 200;
    let saved = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase.from('sap_chart_of_accounts').insert(rows.slice(i, i + BATCH));
        if (error) throw new Error(`sap_chart_of_accounts: ${error.message}`);
        saved += rows.slice(i, i + BATCH).length;
    }
    return { total: allAccounts.length, saved, synthetic: allAccounts.length - analytical.length, strategy };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT: Cost Centers (apenas analíticos)
// ─────────────────────────────────────────────────────────────────────────────
async function importCostCenters(supabase: any, serviceLayerUrl: string, cookieStr: string) {
    const TOP = 200;
    const all: any[] = [];
    let skip = 0;
    while (true) {
        const res = await axios.get(`${serviceLayerUrl}/ProfitCenters`, {
            httpsAgent, headers: { Cookie: cookieStr }, params: { $skip: skip, $top: TOP },
        });
        const items: any[] = res.data?.value ?? [];
        all.push(...items);
        if (items.length < TOP) break;
        skip += TOP;
    }

    const parentCodes = new Set(all.map(c => (c.ParentCenterCode ?? c.ParentCode ?? c.GroupCode ?? '').trim()).filter(Boolean));
    const analytical = parentCodes.size === 0 ? all : all.filter(c => { const code = (c.CenterCode ?? c.Code ?? '').trim(); return code && !parentCodes.has(code); });

    await supabase.rpc('exec_sql', { query: 'DROP TABLE IF EXISTS "sap_cost_centers";' });
    await supabase.rpc('exec_sql', {
        query: `CREATE TABLE "sap_cost_centers" (
            code        text PRIMARY KEY,
            name        text,
            imported_at timestamp
        );`
    });

    const rows = analytical.map((i: any) => ({
        code: i.CenterCode ?? i.Code ?? '',
        name: i.CenterName ?? i.Name ?? '',
        imported_at: new Date().toISOString(),
    }));

    const BATCH = 200;
    let saved = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase.from('sap_cost_centers').upsert(rows.slice(i, i + BATCH), { onConflict: 'code' });
        if (error) throw new Error(`sap_cost_centers: ${error.message}`);
        saved += rows.slice(i, i + BATCH).length;
    }
    return { total: all.length, saved, synthetic: all.length - analytical.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT: Itens do SAP B1 (OITM)
// SvcCode (OSvcCode) é o campo que relaciona E1_XTPSRV (TOTVS) com o item SAP
// Mapping: E1_XTPSRV → sap_items.svc_code → sap_items.item_code → DocumentLines.ItemCode
// ─────────────────────────────────────────────────────────────────────────────
async function importSapItems(supabase: any, serviceLayerUrl: string, cookieStr: string) {
    const SELECT = '$select=ItemCode,ItemName,ItemType,PurchaseItem,SalesItem,SvcCode,U_SvcCode';
    const TOP = 100;
    const all: any[] = [];
    let skip = 0;

    while (true) {
        const url = `${serviceLayerUrl}/Items?${SELECT}&$top=${TOP}&$skip=${skip}`;
        const res = await axios.get<{ value: any[] }>(url, { httpsAgent, headers: { Cookie: cookieStr } });
        const items: any[] = res.data?.value ?? [];
        all.push(...items);
        if (items.length < TOP) break;
        skip += TOP;
    }

    await supabase.rpc('exec_sql', { query: 'DROP TABLE IF EXISTS "sap_items";' });
    await supabase.rpc('exec_sql', {
        query: `CREATE TABLE "sap_items" (
            item_code   text PRIMARY KEY,
            item_name   text,
            item_type   text,
            purchase    boolean DEFAULT false,
            sales       boolean DEFAULT false,
            svc_code    text,
            u_svc_code  text,
            imported_at timestamp
        );`
    });

    const rows = all.map((i: any) => ({
        item_code: i.ItemCode ?? '',
        item_name: i.ItemName ?? '',
        item_type: i.ItemType ?? '',
        purchase: toBool(i.PurchaseItem),
        sales: toBool(i.SalesItem),
        svc_code: i.SvcCode?.toString().trim() || null,
        u_svc_code: i.U_SvcCode?.toString().trim() || null,
        imported_at: new Date().toISOString(),
    })).filter((r: any) => r.item_code);

    await supabase.rpc('exec_sql', {
        query: 'CREATE INDEX IF NOT EXISTS sap_items_svc_code_idx ON sap_items(svc_code);'
    }).catch(() => {/* ignora se falhar */ });

    const BATCH = 100;
    let saved = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase.from('sap_items').insert(rows.slice(i, i + BATCH));
        if (error) throw new Error(`sap_items: ${error.message}`);
        saved += rows.slice(i, i + BATCH).length;
    }
    return { total: all.length, saved };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/sap/import-all
 * Body (opcional): { targets: ['business_places', 'chart_of_accounts', 'cost_centers', 'items'] }
 * Se targets estiver vazio/ausente, importa TUDO.
 *
 * Faz login único no SAP e executa os imports em paralelo.
 * Retorna status individual por módulo.
 */
export async function POST(request: Request) {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const body = await request.json().catch(() => ({}));
        const targets: string[] = body.targets ?? ['business_places', 'chart_of_accounts', 'cost_centers', 'items'];

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // Login SAP único para todos
        const cookieStr = await sapLogin(config);
        const { serviceLayerUrl } = config.sap;

        const results: Record<string, any> = {};
        const errors: Record<string, string> = {};

        // Executa em paralelo os módulos solicitados
        await Promise.all([
            targets.includes('business_places') && importBusinessPlaces(supabase, serviceLayerUrl, cookieStr)
                .then(r => { results.business_places = r; })
                .catch(e => { errors.business_places = e.message; }),

            targets.includes('chart_of_accounts') && importChartOfAccounts(supabase, serviceLayerUrl, cookieStr)
                .then(r => { results.chart_of_accounts = r; })
                .catch(e => { errors.chart_of_accounts = e.message; }),

            targets.includes('cost_centers') && importCostCenters(supabase, serviceLayerUrl, cookieStr)
                .then(r => { results.cost_centers = r; })
                .catch(e => { errors.cost_centers = e.message; }),

            targets.includes('items') && importSapItems(supabase, serviceLayerUrl, cookieStr)
                .then(r => { results.items = r; })
                .catch(e => { errors.items = e.message; }),
        ]);

        const hasErrors = Object.keys(errors).length > 0;

        return NextResponse.json({
            success: !hasErrors || Object.keys(results).length > 0,
            results,
            errors: hasErrors ? errors : undefined,
        });

    } catch (error: any) {
        console.error('[import-all]', error?.response?.data || error.message);
        return NextResponse.json({
            success: false,
            message: error?.response?.data?.error?.message?.value || error.message,
        }, { status: 500 });
    }
}
