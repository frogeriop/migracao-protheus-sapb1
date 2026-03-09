import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';
import { createClient } from '@supabase/supabase-js';
import { TableMapping } from '@/types/mapping';

// Load config
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const MAPPING_FILE = path.join(process.cwd(), 'mapping.json');

async function getConfig(): Promise<AppConfig> {
    const data = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
}

async function getMappings(): Promise<{ [key: string]: TableMapping }> {
    try {
        const data = await fs.readFile(MAPPING_FILE, 'utf-8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

// ── Tabelas que suportam write-back de sap_code ─────────────────────────────
// Mapa: sourceTable → { pkField: coluna PK no Protheus, sapField: campo SAP retornado }
const SAP_CODE_WRITEBACK: Record<string, { pkField: string; sapField: string }> = {
    SA1010: { pkField: 'a1_cod', sapField: 'CardCode' },
    SA2010: { pkField: 'a2_cod', sapField: 'CardCode' },
    SB1010: { pkField: 'b1_cod', sapField: 'ItemCode' },
};

/**
 * Write-back do JdtNum do SAP para {se2010|se1010}.sap_jdt_num após integração bem-sucedida.
 * Usa o r_e_c_n_o_ (PK interna do Protheus/Supabase) como chave de update.
 * Funciona para SE2010 (JournalEntries) e SE1010 (Invoices/PurchaseInvoices).
 */
async function writeJdtNumBack(
    supabase: any,
    pgTable: 'se2010' | 'se1010',
    recno: number,
    jdtNum: number
) {
    if (!recno || !jdtNum) return;
    const { error } = await supabase
        .from(pgTable)
        .update({ sap_jdt_num: jdtNum })
        .eq('r_e_c_n_o_', recno);

    if (error) {
        console.warn(`[execute] write-back sap_jdt_num falhou para ${pgTable}/recno=${recno}:`, error.message);
    } else {
        console.log(`[execute] write-back OK: ${pgTable}/recno=${recno} → sap_jdt_num=${jdtNum}`);
    }
}

/**
 * Write-back: salva o CardCode/ItemCode do SAP de volta na tabela de staging do Supabase.
 * Isso permite que outros módulos (ex: SE2010) resolvam o CardCode pelo código Protheus.
 */
async function writeSapCodeBack(
    supabase: any,
    table: string,
    protheus_pk_value: string,
    sapCode: string
) {
    const cfg = SAP_CODE_WRITEBACK[table];
    if (!cfg || !protheus_pk_value || !sapCode) return;

    const pgTable = table.toLowerCase();
    const { error } = await (supabase as any)
        .from(pgTable)
        .update({ sap_code: sapCode })
        .eq(cfg.pkField, protheus_pk_value);

    if (error) {
        console.warn(`[execute] write-back sap_code falhou para ${table}/${protheus_pk_value}:`, error.message);
    } else {
        console.log(`[execute] write-back OK: ${table}/${protheus_pk_value} → sap_code=${sapCode}`);
    }
}

export async function POST(request: Request) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
        const body = await request.json();
        // source_pk: chave Protheus original (a1_cod, a2_cod, b1_cod) — enviada pela página de execução
        // source_recno: r_e_c_n_o_ do SE2010, usado para write-back de sap_jdt_num
        const { table, targetObject, payload, action, source_pk, source_recno } = body;

        const config = await getConfig();
        const supabase = createClient(config.supabase.url, config.supabase.key, { auth: { persistSession: false } });

        // 1. Login to SAP
        const loginRes = await fetch(`${config.sap.serviceLayerUrl}/Login`, {
            method: 'POST',
            body: JSON.stringify({
                CompanyDB: config.sap.companyDB,
                UserName: config.sap.userName,
                Password: config.sap.password
            })
        });

        if (!loginRes.ok) {
            return NextResponse.json({ success: false, message: 'SAP Login Failed' }, { status: 401 });
        }

        const cookies = loginRes.headers.get('set-cookie');

        // 2. Execute Action
        let key: string | number = '';
        if (targetObject === 'BusinessPartners') key = payload.CardCode;
        if (targetObject === 'Items') key = payload.ItemCode;
        if (targetObject === 'Invoices' || targetObject === 'PurchaseInvoices') key = payload.DocEntry;
        if (targetObject === 'JournalEntries') key = payload._sapJdtNum || payload.JdtNum || '';
        if (targetObject === 'Orders') key = payload._sapDocEntry || payload.DocEntry || '';

        // ── JournalEntries: PATCH cirúrgico com campos comprovadamente aceitos ──────
        if (targetObject === 'JournalEntries' && action === 'update') {
            if (!key) {
                return NextResponse.json({
                    success: false,
                    message: 'Lançamento já existe no SAP B1, mas o JdtNum não foi identificado. Nenhuma ação realizada.'
                });
            }

            const patchPayload: Record<string, any> = {};
            if (payload.Memo) patchPayload.Memo = payload.Memo;
            if (payload.Reference2) patchPayload.Reference2 = payload.Reference2;
            if (payload.Reference3) patchPayload.Reference3 = payload.Reference3;
            if (payload.DueDate) patchPayload.DueDate = payload.DueDate;
            if (payload.TransactionCode) patchPayload.TransactionCode = payload.TransactionCode;

            const patchRes = await fetch(`${config.sap.serviceLayerUrl}/JournalEntries(${key})`, {
                method: 'PATCH',
                headers: { 'Cookie': cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(patchPayload)
            });

            if (patchRes.status === 204 || patchRes.ok) {
                if (source_recno && key) {
                    const pgTbl = table === 'SE1010' ? 'se1010' : 'se2010';
                    await writeJdtNumBack(supabase, pgTbl, Number(source_recno), Number(key));
                }
                return NextResponse.json({
                    success: true,
                    data: { JdtNum: key },
                    message: `JE ${key} atualizado (Memo/Ref/DueDate).`
                });
            } else {
                let errMsg = `JE ${key} já existe no SAP B1.`;
                try {
                    const errJson = await patchRes.json();
                    errMsg = errJson?.error?.message?.value || errMsg;
                } catch { /* ignore */ }
                return NextResponse.json({
                    success: false,
                    message: `JE ${key} já integrado — PATCH falhou (${patchRes.status}): ${errMsg}`
                });
            }
        }

        // ── Orders (SE1010): PATCH com campos atualizáveis ───────────────────────
        // DocEntry é numérico → URL sem aspas: /Orders(5176) e não /Orders('5176')
        // Campos imutáveis em Orders: CardCode, CardName, DocType, DocumentLines (não atualiza linhas via PATCH)
        if (targetObject === 'Orders' && action === 'update') {
            if (!key) {
                return NextResponse.json({
                    success: false,
                    message: 'Sales Order já existe no SAP B1, mas o DocEntry não foi identificado.'
                });
            }

            // Monta payload apenas com campos seguros para PATCH em Orders
            const orderPatch: Record<string, any> = {};
            if (payload.DocDueDate) orderPatch.DocDueDate = payload.DocDueDate;
            if (payload.TaxDate) orderPatch.TaxDate = payload.TaxDate;
            if (payload.DocDate) orderPatch.DocDate = payload.DocDate;
            if (payload.Comments) orderPatch.Comments = payload.Comments;
            if (payload.NumAtCard) orderPatch.NumAtCard = payload.NumAtCard;
            if (payload.BPL_IDAssignedToInvoice !== undefined)
                orderPatch.BPL_IDAssignedToInvoice = payload.BPL_IDAssignedToInvoice;

            const patchRes = await fetch(`${config.sap.serviceLayerUrl}/Orders(${Number(key)})`, {
                method: 'PATCH',
                headers: { 'Cookie': cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(orderPatch)
            });

            if (patchRes.status === 204 || patchRes.ok) {
                // Write-back do DocEntry (reutilizando sap_jdt_num)
                if (source_recno && key) {
                    await writeJdtNumBack(supabase, 'se1010', Number(source_recno), Number(key));
                }
                return NextResponse.json({
                    success: true,
                    data: { DocEntry: key },
                    message: `Sales Order DocEntry ${key} atualizada.`
                });
            } else {
                let errMsg = `Falha ao atualizar Sales Order ${key}.`;
                try {
                    const errJson = await patchRes.json();
                    errMsg = errJson?.error?.message?.value || errMsg;
                } catch { /* ignore */ }
                return NextResponse.json({
                    success: false,
                    message: `Order ${key} — PATCH falhou (${patchRes.status}): ${errMsg}`
                });
            }
        }


        let response;

        if (action === 'insert') {
            const insertPayload = { ...payload };
            // Remover campos internos do pipeline antes de enviar ao SAP
            delete insertPayload._sapJdtNum;
            delete insertPayload._sapDocEntry;

            // DocumentLines para Orders deve ser array
            if (targetObject === 'Orders' && insertPayload.DocumentLines && !Array.isArray(insertPayload.DocumentLines)) {
                insertPayload.DocumentLines = [insertPayload.DocumentLines];
            }

            response = await fetch(`${config.sap.serviceLayerUrl}/${targetObject}`, {
                method: 'POST',
                headers: { 'Cookie': cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(insertPayload)
            });

        } else if (action === 'update') {
            // Remove PK and immutable fields for Update
            const updatePayload = { ...payload };
            delete updatePayload.CardCode;  // PK: cannot be sent in update body
            delete updatePayload.CardType;  // Immutable: type cannot change

            // ── Smart Matching para BusinessPartners ─────────────────────────────────
            // Busca estado atual do BP para:
            //   1. BPAddresses (CRD1): só envia se o BP ainda não tem endereços
            //   2. BPFiscalTaxIDCollection (CRD7): envia apenas se o CNPJ está vazio ou diferente
            //   3. FederalTaxID (OCRD): SEMPRE enviado — campo simples, PATCH seguro
            try {
                const currentBPRes = await fetch(
                    `${config.sap.serviceLayerUrl}/${targetObject}('${key}')?$select=BPAddresses,BPFiscalTaxIDCollection,FederalTaxID`,
                    { headers: { 'Cookie': cookies || '' } }
                );

                if (currentBPRes.ok) {
                    const currentBP = await currentBPRes.json();

                    // ── FederalTaxID (OCRD): sempre atualiza — campo simples ──────────
                    // Sem restrição de PATCH. Atualiza CNPJ/CPF na tabela OCRD sempre.
                    // updatePayload.FederalTaxID já está presente — não remover.

                    // ── BPFiscalTaxIDCollection (CRD7): PATCH inteligente ────────────
                    // Só envia linhas cujo TaxId está VAZIO ou DIFERENTE no SAP atual.
                    // Evita erro "duplicate key" (chave composta AddressName+AddrType).
                    if (updatePayload.BPFiscalTaxIDCollection && Array.isArray(updatePayload.BPFiscalTaxIDCollection)) {
                        const existingFiscal: any[] = currentBP.BPFiscalTaxIDCollection || [];

                        const hasData = (v: any) => v !== null && v !== undefined && String(v).trim() !== '';

                        // Filtra: só mantém entradas cujo campo esteja vazio no SAP atual
                        const filteredFiscal = updatePayload.BPFiscalTaxIDCollection.filter((newRow: any) => {
                            // Para cada TaxId field no new row
                            for (const field of ['TaxId0', 'TaxId1', 'TaxId2', 'TaxId3', 'TaxId4', 'CNAECode']) {
                                if (!hasData(newRow[field])) continue;
                                // Verifica se o SAP já tem valor para este campo
                                const existing = existingFiscal[0]; // CRD7 tem geralmente 1 linha por BP
                                if (existing && hasData(existing[field])) {
                                    // SAP já tem valor — verificar se é diferente
                                    if (String(existing[field]).trim() !== String(newRow[field]).trim()) {
                                        console.log(`[execute] CRD7 ${field}: SAP="${existing[field]}" → novo="${newRow[field]}" — inclui no PATCH`);
                                        return true; // valor diferente → atualiza
                                    } else {
                                        return false; // igual → não envia (evita erro)
                                    }
                                }
                                return true; // SAP vazio → envia
                            }
                            return false;
                        });

                        if (filteredFiscal.length > 0) {
                            updatePayload.BPFiscalTaxIDCollection = filteredFiscal;
                            console.log(`[execute] CRD7 PATCH: ${filteredFiscal.length} linha(s) incluída(s) para ${key}`);
                        } else {
                            delete updatePayload.BPFiscalTaxIDCollection;
                            console.log(`[execute] CRD7 PATCH: nenhuma atualização necessária para ${key}`);
                        }
                    }

                    // ── BPAddresses (CRD1): só envia se o BP ainda não tem endereços ──
                    // CRD1 não tem campo de CNPJ — apenas endereço físico.
                    const existingAddresses: any[] = currentBP.BPAddresses || [];
                    if (existingAddresses.length > 0) {
                        delete updatePayload.BPAddresses;
                    } else {
                        const seenNames = new Set<string>();
                        if (updatePayload.BPAddresses && Array.isArray(updatePayload.BPAddresses)) {
                            updatePayload.BPAddresses = updatePayload.BPAddresses.filter((addr: any) => {
                                const name = addr.AddressName || (addr.AddressType === 'bo_BillTo' ? 'Cobranca' : 'Entrega');
                                addr.AddressName = name;
                                if (seenNames.has(name)) return false;
                                seenNames.add(name);
                                return true;
                            });
                        }
                    }
                } else {
                    // Fallback: fetch do BP atual falhou — envia apenas campos básicos seguros
                    console.warn('[execute] Could not fetch current BP — sending only safe fields.');
                    delete updatePayload.BPAddresses;
                    delete updatePayload.BPFiscalTaxIDCollection;
                    // FederalTaxID mantido mesmo no fallback (campo simples OCRD)
                }
            } catch (e) {
                console.warn('[execute] Smart matching exception, sending only safe fields.', e);
                delete updatePayload.BPAddresses;
                delete updatePayload.BPFiscalTaxIDCollection;
                // FederalTaxID mantido mesmo no fallback (campo simples OCRD)
            }

            response = await fetch(`${config.sap.serviceLayerUrl}/${targetObject}('${key}')`, {
                method: 'PATCH',
                headers: { 'Cookie': cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(updatePayload)
            });

            if (!response.ok) {
                const errText = await response.text();
                return NextResponse.json({
                    success: false,
                    message: `Update Failed: ${errText} - Payload: ${JSON.stringify(updatePayload)}`
                });
            }

            // ── Write-back: PATCH bem-sucedido → sap_code já era conhecido (= key) ──
            // Para UPDATE, o CardCode/ItemCode já estava em payload.CardCode/ItemCode
            if (source_pk && key && SAP_CODE_WRITEBACK[table]) {
                await writeSapCodeBack(supabase, table, source_pk, String(key));
            }

            // Para PATCH, geralmente 204 No Content
            if (response.status === 204) {
                return NextResponse.json({ success: true, data: { [SAP_CODE_WRITEBACK[table]?.sapField ?? 'key']: key } });
            }

        } else {
            return NextResponse.json({ success: false, message: 'Invalid action: ' + action });
        }

        // Shared Response Handling
        if (response.status === 204) {
            return NextResponse.json({ success: true, data: {} });
        }

        const json = await response.json();

        if (!response.ok) {
            return NextResponse.json({ success: false, message: json.error?.message?.value || 'Unknown SAP Error' });
        }

        // ── Write-back: INSERT bem-sucedido → salva sap_code retornado pelo SAP ──
        if (action === 'insert' && source_pk && SAP_CODE_WRITEBACK[table]) {
            const cfg = SAP_CODE_WRITEBACK[table];
            const sapCode = json[cfg.sapField]; // ex: json.CardCode ou json.ItemCode
            if (sapCode) {
                await writeSapCodeBack(supabase, table, source_pk, sapCode);
            }
        }

        // ── Write-back: SE1010 INSERT → salva DocEntry em sap_jdt_num ────────────
        // Sales Orders retornam DocEntry (não JdtNum). Reutilizamos sap_jdt_num para armazenar.
        if (action === 'insert' && table === 'SE1010' && source_recno && json?.DocEntry) {
            await writeJdtNumBack(supabase, 'se1010', Number(source_recno), Number(json.DocEntry));
            console.log(`[execute] SE1010 write-back: recno=${source_recno} → sap_jdt_num(DocEntry)=${json.DocEntry}`);
        }

        // ── Write-back: SE2010 INSERT → salva JdtNum em sap_jdt_num ────────────
        if (action === 'insert' && table === 'SE2010' && source_recno && json?.JdtNum) {
            await writeJdtNumBack(supabase, 'se2010', Number(source_recno), Number(json.JdtNum));
        }

        return NextResponse.json({ success: true, data: json });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
