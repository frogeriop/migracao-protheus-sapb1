import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

/**
 * POST /api/sap/business-places/import
 * Busca TODOS os campos de /BusinessPlaces no SAP Service Layer
 * e faz upsert completo na tabela local `sap_business_places` do Supabase.
 *
 * Útil para ter os dados de filiais disponíveis offline em qualquer integração.
 */
export async function POST() {
    try {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false },
        });

        // 1. Login SAP ─────────────────────────────────────────────────────────
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
            const text = await loginRes.text();
            return NextResponse.json({ success: false, message: `SAP Login falhou: ${text}` }, { status: 401 });
        }

        const cookies = loginRes.headers.get('set-cookie') || '';

        // 2. Busca BusinessPlaces — todos os campos ──────────────────────────────
        const bpRes = await fetch(`${config.sap.serviceLayerUrl}/BusinessPlaces`, {
            headers: { 'Cookie': cookies, 'Prefer': 'odata.maxpagesize=200' },
        });

        if (!bpRes.ok) {
            const text = await bpRes.text();
            return NextResponse.json({ success: false, message: `BusinessPlaces falhou (${bpRes.status}): ${text}` }, { status: bpRes.status });
        }

        const bpJson = await bpRes.json();
        const records: any[] = bpJson.value ?? [];

        if (records.length === 0) {
            return NextResponse.json({ success: true, message: 'Nenhuma filial encontrada no SAP.', upserted: 0 });
        }

        // 3. Mapeia campos SAP → colunas Supabase ────────────────────────────────
        const rows = records.map((b: any) => {
            // Helper: converte tYES/tNO → boolean
            const toBool = (v: any): boolean => v === 'tYES' || v === true;

            // Helper: converte data SAP (YYYY-MM-DD ou similar) → string ISO para DATE
            const toDate = (v: any): string | null => {
                if (!v) return null;
                const s = String(v).trim();
                if (s === '' || s === 'null') return null;
                // SAP pode retornar "2019-01-01T00:00:00" — pega só a parte da data
                return s.split('T')[0];
            };

            // Helper: converte inteiro, retorna null para -1 (valor padrão SAP de "não definido")
            const toInt = (v: any): number | null => {
                const n = parseInt(String(v ?? '-1'), 10);
                return n === -1 ? null : n;
            };

            return {
                bpl_id: b.BPLID,
                bpl_name: b.BPLName ?? null,
                bpl_name_foreign: b.BPLNameForeign ?? null,
                alias_name: b.AliasName ?? null,
                main_bpl: toBool(b.MainBPL),
                disabled: toBool(b.Disabled),
                // Fiscal
                federal_tax_id: b.FederalTaxID ?? null,
                federal_tax_id2: b.FederalTaxID2 ?? null,
                federal_tax_id3: b.FederalTaxID3 ?? null,
                vat_reg_num: b.VATRegNum ?? null,
                additional_id_number: b.AdditionalIdNumber ?? null,
                tax_office: b.TaxOffice ?? null,
                tax_office_no: b.TaxOfficeNo ?? null,
                // Defaults operacionais
                default_warehouse_id: b.DefaultWarehouseID ?? null,
                default_resource_warehouse_id: b.DefaultResourceWarehouseID ?? null,
                default_tax_code: b.DefaultTaxCode ?? null,
                default_customer_id: b.DefaultCustomerID ?? null,
                default_vendor_id: b.DefaultVendorID ?? null,
                payment_clearing_account: b.PaymentClearingAccount ?? null,
                // Endereço
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
                // Rep / SPED
                rep_name: b.RepName ?? null,
                industry: b.Industry ?? null,
                business: b.Business ?? null,
                sped_profile: b.SPEDProfile ?? null,
                commercial_register: b.CommercialRegister ?? null,
                date_of_incorporation: toDate(b.DateOfIncorporation),
                global_location_number: b.GlobalLocationNumber ?? null,
                // Códigos tributários
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
                // Coleções JSONB
                ie_numbers: b.BusinessPlaceIENumbers ?? [],
                tributary_infos: b.BusinessPlaceTributaryInfos ?? [],
                // Controle
                imported_at: new Date().toISOString(),
            };
        });

        // 4. Upsert no Supabase ───────────────────────────────────────────────────
        const { data: upserted, error } = await supabase
            .from('sap_business_places')
            .upsert(rows, { onConflict: 'bpl_id' })
            .select('bpl_id, bpl_name, disabled');

        if (error) {
            console.error('[business-places/import] Supabase upsert error:', error);
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        console.log(`[business-places/import] ${rows.length} filiais importadas/atualizadas.`);

        return NextResponse.json({
            success: true,
            message: `${rows.length} filial(is) importada(s) com sucesso.`,
            upserted: rows.length,
            summary: (upserted || []).map((r: any) => ({
                bplId: r.bpl_id,
                name: r.bpl_name,
                disabled: r.disabled,
            })),
        });

    } catch (error: any) {
        console.error('[business-places/import]', error.message);
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

/**
 * DELETE /api/sap/business-places/import
 * Limpa todos os registros da tabela local.
 */
export async function DELETE() {
    try {
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false },
        });
        const { error } = await supabase
            .from('sap_business_places')
            .delete()
            .neq('bpl_id', -99999); // remove tudo
        if (error) throw error;
        return NextResponse.json({ success: true, message: 'Filiais removidas da tabela local.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

export async function GET() {
    try {
        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, {
            auth: { persistSession: false },
        });

        const { data, error } = await supabase
            .from('sap_business_places')
            .select('*')
            .order('bpl_id', { ascending: true });

        if (error) throw error;

        return NextResponse.json({
            success: true,
            data: data ?? [],
            count: (data ?? []).length,
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
