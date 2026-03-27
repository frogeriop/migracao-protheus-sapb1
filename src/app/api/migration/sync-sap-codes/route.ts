import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

/**
 * POST /api/migration/sync-sap-codes
 *
 * Ressincroniza __sap_id nas tabelas de cadastro (SA1010, SA2010, SB1010)
 * consultando BusinessPartners e Items no SAP B1 e gravando os códigos de volta.
 *
 * Útil após reimportação do TOTVS (que destrói a coluna __sap_id).
 */
export async function POST(request: Request) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
        const body = await request.json();
        const { table } = body; // 'SA1010' | 'SA2010' | 'SB1010'

        if (!['SA1010', 'SA2010', 'SB1010'].includes(table)) {
            return NextResponse.json({ success: false, message: 'Tabela inválida. Use SA1010, SA2010 ou SB1010.' });
        }

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // ── 1. Login SAP ────────────────────────────────────────────────────────
        const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                CompanyDB: config.sap.companyDB,
                UserName: config.sap.userName,
                Password: config.sap.password,
            }),
        });
        if (!loginRes.ok) {
            return NextResponse.json({ success: false, message: 'SAP Login failed' }, { status: 401 });
        }
        const cookies = loginRes.headers.get('set-cookie') || '';

        // ── 2. Configuração por tabela ───────────────────────────────────────────
        const tableConfig: Record<string, {
            pgTable: string;
            pkField: string;      // campo PK no Supabase
            sapObject: string;    // endpoint SAP
            sapKey: string;       // campo retornado pelo SAP como código
            cardType?: string;    // filtro CardType para BPs
        }> = {
            SA1010: { pgTable: 'sa1010', pkField: 'a1_cod', sapObject: 'BusinessPartners', sapKey: 'CardCode', cardType: 'C' },
            SA2010: { pgTable: 'sa2010', pkField: 'a2_cod', sapObject: 'BusinessPartners', sapKey: 'CardCode', cardType: 'S' },
            SB1010: { pgTable: 'sb1010', pkField: 'b1_cod', sapObject: 'Items', sapKey: 'ItemCode' },
        };
        const cfg = tableConfig[table];

        // ── 3. Busca registros do Supabase sem __sap_id (inclui CNPJ para cruzamento) ──
        const cgcField = table === 'SA1010' ? 'a1_cgc' : table === 'SA2010' ? 'a2_cgc' : null;
        const selectFields = cgcField
            ? `${cfg.pkField}, ${cgcField}, __sap_id`
            : `${cfg.pkField}, __sap_id`;

        const { data: localRows, error: localErr } = await supabase
            .from(cfg.pgTable)
            .select(selectFields)
            .is('__sap_id', null)
            .eq('d_e_l_e_t_', '');

        if (localErr) {
            return NextResponse.json({ success: false, message: localErr.message });
        }
        if (!localRows || localRows.length === 0) {
            return NextResponse.json({ success: true, updated: 0, message: 'Nenhum registro sem __sap_id encontrado.' });
        }

        console.log(`[sync-sap-codes] ${table}: ${localRows.length} registros sem __sap_id.`);

        // ── 4. Busca todos os BPs/Items do SAP com CardCode + FederalTaxID ─────────
        // Para BPs (SA1010/SA2010): cruzamento por FederalTaxID (CNPJ/CPF) — chave confiável
        // Para Items (SB1010): cruzamento por ItemCode (mapeamento direto de b1_cod)
        const PAGE_SIZE = 100;

        // cnpjToCardCode: CNPJ (só números) → CardCode SAP
        const cnpjToCardCode: Record<string, string> = {};
        // itemCodeMap: ItemCode SAP → ItemCode SAP (lookup direto)
        const sapItemCodes = new Set<string>();

        if (cfg.sapObject === 'BusinessPartners') {
            const cardTypeFilter = cfg.cardType ? `CardType eq '${cfg.cardType}'` : '';
            let skip = 0;
            let hasMore = true;

            while (hasMore) {
                const url = `${config.sap.serviceLayerUrl}/BusinessPartners` +
                    `?$select=CardCode,FederalTaxID` +
                    `${cardTypeFilter ? '&$filter=' + encodeURIComponent(cardTypeFilter) : ''}` +
                    `&$skip=${skip}&$top=${PAGE_SIZE}`;

                const res: Response = await fetch(url, { headers: { Cookie: cookies } });
                if (!res.ok) { hasMore = false; break; }

                const json: { value?: any[] } = await res.json();
                const bps: any[] = json.value || [];

                for (const bp of bps) {
                    if (bp.FederalTaxID) {
                        // Normaliza CNPJ: remove não numéricos
                        const cnpjNorm = String(bp.FederalTaxID).replace(/\D/g, '');
                        if (cnpjNorm) cnpjToCardCode[cnpjNorm] = bp.CardCode;
                    }
                }

                hasMore = bps.length === PAGE_SIZE;
                skip += PAGE_SIZE;
            }
            console.log(`[sync-sap-codes] ${table}: ${Object.keys(cnpjToCardCode).length} BPs com FederalTaxID encontrados no SAP.`);
        } else {
            // Items: busca ItemCode de forma paginada
            let skip = 0;
            let hasMore = true;
            while (hasMore) {
                const res = await fetch(
                    `${config.sap.serviceLayerUrl}/Items?$select=ItemCode&$skip=${skip}&$top=${PAGE_SIZE}`,
                    { headers: { Cookie: cookies } }
                );
                if (!res.ok) break;
                const json = await res.json();
                const items: any[] = json.value || [];
                for (const item of items) sapItemCodes.add(item.ItemCode);
                hasMore = items.length === PAGE_SIZE;
                skip += PAGE_SIZE;
            }
            console.log(`[sync-sap-codes] ${table}: ${sapItemCodes.size} Items encontrados no SAP.`);
        }

        // ── 5. Cruza cada registro local com o mapa do SAP ────────────────────────
        let updated = 0;
        let notFound = 0;

        for (const row of (localRows as any[])) {
            const pkVal = String(row[cfg.pkField] ?? '').trim();
            if (!pkVal) continue;

            let resolvedSapCode: string | undefined;

            if (cfg.sapObject === 'BusinessPartners' && cgcField) {
                // Cruzamento por CNPJ (FederalTaxID)
                const cgcRaw = String(row[cgcField] ?? '').replace(/\D/g, '');
                if (cgcRaw && cnpjToCardCode[cgcRaw]) {
                    resolvedSapCode = cnpjToCardCode[cgcRaw];
                } else if (cgcRaw) {
                    // Fallback: busca individual por FederalTaxID (cobre variações de formato)
                    try {
                        const filterQ = `FederalTaxID eq '${cgcRaw}'`;
                        const r: Response = await fetch(
                            `${config.sap.serviceLayerUrl}/BusinessPartners?$select=CardCode&$filter=${encodeURIComponent(filterQ)}&$top=1`,
                            { headers: { Cookie: cookies } }
                        );
                        if (r.ok) {
                            const j: { value?: any[] } = await r.json();
                            if (j.value?.[0]?.CardCode) resolvedSapCode = j.value[0].CardCode;
                        }
                    } catch { /* ignore */ }
                }
            } else if (cfg.sapObject === 'Items') {
                // Items: verifica se ItemCode existe no SAP
                if (sapItemCodes.has(pkVal)) resolvedSapCode = pkVal;
            }

            if (resolvedSapCode) {
                const { error: upErr } = await supabase
                    .from(cfg.pgTable)
                    .update({ __sap_id: resolvedSapCode })
                    .eq(cfg.pkField, pkVal);

                if (!upErr) {
                    updated++;
                    console.log(`[sync-sap-codes] ${table}/${pkVal} (CNPJ-match) → __sap_id=${resolvedSapCode}`);
                }
            } else {
                notFound++;
            }
        }

        return NextResponse.json({
            success: true,
            table,
            totalSemCodigo: localRows.length,
            updated,
            notFound,
            message: `${updated} registros atualizados com __sap_id. ${notFound} não encontrados no SAP (não integrados).`,
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
