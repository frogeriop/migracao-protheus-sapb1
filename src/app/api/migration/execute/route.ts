import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { AppConfig } from '@/types/config';
import { createClient } from '@supabase/supabase-js';
import { type ResultCenterFormulaExecution, TableMapping } from '@/types/mapping';
import {
    documentLineOcrSupportedInMetadata,
    injectDistributionRuleCodeIntoOrderFirstLine,
    injectPrimaryCostCenterIntoOrderFirstLine,
    postDistributionRule,
    shouldCreateDistributionRuleForOrder,
} from '@/utils/sapDistributionRules';
import {
    fetchContactEmployeesForBusinessPartner,
    fetchContactEmployeesViaFullPartnerGet,
    sanitizeContactEmployeeEmail,
} from '@/utils/sapContactEmployees';
import { formatRuntimeToday, resolveRuntimeTodayPlaceholdersDeep } from '@/utils/transformations';

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

// ── Tabelas que suportam write-back de __sap_id ─────────────────────────────
// Mapa: sourceTable → { pkField: coluna PK no Protheus, sapField: campo SAP retornado }
const SAP_ID_WRITEBACK: Record<string, { pkField: string; sapField: string }> = {
    SA1010: { pkField: 'a1_cod', sapField: 'CardCode' },
    SA2010: { pkField: 'a2_cod', sapField: 'CardCode' },
    SB1010: { pkField: 'b1_cod', sapField: 'ItemCode' },
    SU5010: { pkField: 'r_e_c_n_o_', sapField: 'LineNum' },
    stg_plano_contas: { pkField: 'Code', sapField: 'Code' },
};

/**
 * Write-back: salva o ID (ex: CardCode/ItemCode/JdtNum/DocEntry) do SAP de volta na tabela de staging do Supabase.
 */
async function writeSapIdBack(
    supabase: any,
    table: string,
    pkColumn: string,
    pkValue: string | number,
    sapId: string | number
) {
    if (!pkColumn || !pkValue || !sapId) return;

    const pgTable = table.toLowerCase();
    const { error } = await (supabase as any)
        .from(pgTable)
        .update({ __sap_id: String(sapId) })
        .eq(pkColumn, pkValue);

    if (error) {
        console.warn(`[execute] write-back __sap_id falhou para ${table}/${pkValue}:`, error.message);
    } else {
        console.log(`[execute] write-back OK: ${table}/${pkValue} → __sap_id=${sapId}`);
    }
}

/** Remove chaves @odata / @... para reenviar coleção no PATCH. */
function stripODataAnnotations<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(row)) {
        if (k.startsWith('@')) continue;
        const v = row[k];
        if (v !== undefined && v !== null) o[k] = v;
    }
    return o;
}

/**
 * Reenvio no merge com ReplaceCollectionsOnPatch: o GET pode trazer E_MailL;
 * o mesmo SL rejeita E_MailL no PATCH (-1000). Unifica em E_Mail sanitizado.
 */
function normalizeContactEmployeeForPatchMerge(row: Record<string, unknown>): Record<string, unknown> {
    const o = stripODataAnnotations(row);
    const mailRaw = o.E_Mail ?? o.E_MailL;
    delete o.E_MailL;
    delete o.E_Mail;
    const s = sanitizeContactEmployeeEmail(mailRaw);
    if (s) o.E_Mail = s;
    return o;
}

function lineNumFromContactList(list: any[], wantName: string): number | undefined {
    const w = wantName.trim().toLowerCase();
    const matches = list.filter((c) => String(c?.Name ?? '').trim().toLowerCase() === w);
    if (matches.length === 0) return undefined;
    const best = matches.reduce((a, b) => (Number(b?.LineNum ?? -1) > Number(a?.LineNum ?? -1) ? b : a));
    const n = Number(best?.LineNum);
    return Number.isFinite(n) ? n : undefined;
}

/** Quando a releitura traz uma linha a mais que antes do merge, o novo contato costuma ser o maior LineNum. */
function resolveLineNumFromVerifyList(
    list: any[],
    wantName: string,
    contactCountBeforeMerge: number
): number | undefined {
    const byName = lineNumFromContactList(list, wantName);
    if (byName !== undefined) return byName;
    const nums = list.map((c) => Number(c?.LineNum)).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return undefined;
    if (list.length >= contactCountBeforeMerge + 1) {
        return Math.max(...nums);
    }
    return undefined;
}

/** Próximo LineNum após acrescentar um contato (OCPR costuma ser sequencial por parceiro). */
function inferNextLineNumAfterAppend(existingRaw: any[]): number {
    let max = -1;
    for (const r of existingRaw) {
        const n = Number(r?.LineNum);
        if (Number.isFinite(n)) max = Math.max(max, n);
    }
    return max < 0 ? 0 : max + 1;
}

function parseLineNumFromPatchResponseBody(patchText: string, wantName: string): number | undefined {
    const t = patchText?.trim();
    if (!t || !t.startsWith('{')) return undefined;
    try {
        const j = JSON.parse(t);
        const list = j?.ContactEmployees;
        if (!Array.isArray(list)) return undefined;
        return lineNumFromContactList(list, wantName);
    } catch {
        return undefined;
    }
}

/** POST em .../ContactEmployees não existe em alguns ambientes SL (-1008 Command Not Found). */
function contactEmployeesPostUnsupported(status: number, responseText: string): boolean {
    if (status !== 400 && status !== 404) return false;
    const t = responseText.toLowerCase();
    return t.includes('-1008') || t.includes('command not found');
}

/**
 * Inclui contato via PATCH no BP com replace da coleção (após GET dos existentes).
 * Usado quando o POST no sub-recurso /ContactEmployees não é suportado.
 */
async function addContactEmployeeViaPatchMerge(
    serviceLayerUrl: string,
    cookieHeader: string,
    cardCode: string,
    fields: { Name: string; Position?: string; Phone1?: string; E_Mail?: string }
): Promise<
    | { ok: true; lineNum: number; lineNumInferred?: boolean }
    | { ok: false; message: string }
> {
    const base = serviceLayerUrl.replace(/\/$/, '');
    const cc = cardCode.replace(/'/g, "''");

    const loaded = await fetchContactEmployeesForBusinessPartner(serviceLayerUrl, cookieHeader, cardCode);
    if (loaded.businessPartnerError) {
        return { ok: false, message: loaded.businessPartnerError };
    }
    if (loaded.contactListWarning && loaded.contacts.length === 0) {
        return {
            ok: false,
            message:
                'Merge PATCH exige a lista atual de contatos; este Service Layer não retornou /ContactEmployees nem $expand. ' +
                loaded.contactListWarning,
        };
    }
    const existingRaw = loaded.contacts;
    const existing = existingRaw.map((r) => normalizeContactEmployeeForPatchMerge(r as Record<string, unknown>));

    const newLine: Record<string, unknown> = { Name: fields.Name };
    if (fields.Position) newLine.Position = fields.Position;
    if (fields.Phone1) newLine.Phone1 = fields.Phone1;
    const em = sanitizeContactEmployeeEmail(fields.E_Mail);
    if (em) newLine.E_Mail = em;

    const patchRes = await fetch(`${base}/BusinessPartners('${cc}')`, {
        method: 'PATCH',
        headers: {
            Cookie: cookieHeader,
            'Content-Type': 'application/json',
            'B1S-ReplaceCollectionsOnPatch': 'true',
            Prefer: 'return=representation',
        },
        body: JSON.stringify({ ContactEmployees: [...existing, newLine] }),
    });
    const patchText = await patchRes.text();
    if (!patchRes.ok && patchRes.status !== 204) {
        return {
            ok: false,
            message: `PATCH ContactEmployees (merge) falhou (${patchRes.status}): ${patchText.slice(0, 400)}`,
        };
    }

    const fromBody = parseLineNumFromPatchResponseBody(patchText, fields.Name);
    if (fromBody !== undefined) {
        return { ok: true, lineNum: fromBody };
    }

    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    let list: any[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await delay(400);
        const verifyLoaded = await fetchContactEmployeesForBusinessPartner(
            serviceLayerUrl,
            cookieHeader,
            cardCode
        );
        if (verifyLoaded.businessPartnerError) {
            if (attempt === 3) {
                return {
                    ok: false,
                    message:
                        `Contato pode ter sido criado, mas releitura falhou: ${verifyLoaded.businessPartnerError}`,
                };
            }
            continue;
        }
        if (verifyLoaded.contacts.length > 0) {
            list = verifyLoaded.contacts;
            break;
        }
    }

    if (list.length === 0) {
        const full = await fetchContactEmployeesViaFullPartnerGet(serviceLayerUrl, cookieHeader, cardCode);
        if (full && full.length > 0) list = full;
    }

    const beforeN = existingRaw.length;
    const lineNumResolved = resolveLineNumFromVerifyList(list, fields.Name, beforeN);
    if (lineNumResolved !== undefined) {
        return { ok: true, lineNum: lineNumResolved };
    }

    const inferred = inferNextLineNumAfterAppend(existingRaw);
    return {
        ok: true,
        lineNum: inferred,
        lineNumInferred: true,
    };
}

export async function POST(request: Request) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
        const body = await request.json();
        // source_pk: chave Protheus original (a1_cod, a2_cod, b1_cod) — enviada pela página de execução
        // source_recno: r_e_c_n_o_ do SE2010, usado para write-back de sap_jdt_num
        const { table, targetObject, action, source_pk, source_recno, source_row_id, e1_num } = body;
        let payload = body.payload;
        if (payload && typeof payload === 'object') {
            payload = JSON.parse(JSON.stringify(payload));
            resolveRuntimeTodayPlaceholdersDeep(payload);
            // SE1010 → pedido (Draft): DocDate e TaxDate = data da integração (não E1_VENCREA)
            if (table === 'SE1010' && targetObject === 'Orders') {
                const today = formatRuntimeToday('iso');
                (payload as Record<string, unknown>).DocDate = today;
                (payload as Record<string, unknown>).TaxDate = today;
            }
        }

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
        if (targetObject === 'ChartOfAccounts') key = payload.Code;
        if (targetObject === 'Invoices' || targetObject === 'PurchaseInvoices') key = payload.DocEntry;
        if (targetObject === 'JournalEntries') key = payload._sapJdtNum || payload.JdtNum || '';
        if (targetObject === 'Orders') key = payload._sapDocEntry || payload.DocEntry || '';
        if (targetObject === 'ProfitCenters') key = payload.CenterCode || '';

        let finalAction = action;

        // ── SU5010 → ContactEmployees (POST sub-recurso ou PATCH coleção no BP) ──
        if (targetObject === 'ContactEmployees') {
            const cardCode = String(payload.CardCode || '').trim();
            const name = String(payload.Name || '').trim();
            if (!cardCode) {
                return NextResponse.json(
                    {
                        success: false,
                        message:
                            'CardCode ausente: o cliente precisa existir no SAP (lookup SA1010 → __sap_id).',
                    },
                    { status: 400 }
                );
            }
            if (!name) {
                return NextResponse.json(
                    { success: false, message: 'Nome do contato (Name) é obrigatório.' },
                    { status: 400 }
                );
            }
            const cc = cardCode.replace(/'/g, "''");
            const lineNumRaw = payload._contactLineNum ?? payload._sapContactLineNum;
            const lineNum =
                lineNumRaw !== undefined && lineNumRaw !== null && String(lineNumRaw).trim() !== ''
                    ? Number(lineNumRaw)
                    : NaN;

            const contactPost: Record<string, unknown> = {
                CardCode: cardCode,
                Name: name,
            };
            if (payload.Position) contactPost.Position = String(payload.Position).trim();
            if (payload.Phone1) contactPost.Phone1 = String(payload.Phone1).trim();
            const emailSap = sanitizeContactEmployeeEmail(
                (payload as Record<string, unknown>).E_Mail ?? (payload as Record<string, unknown>).E_MailL
            );
            if (emailSap) contactPost.E_Mail = emailSap;

            if (finalAction === 'update' && Number.isFinite(lineNum) && lineNum >= 0) {
                const patchLine: Record<string, unknown> = {
                    LineNum: lineNum,
                    Name: contactPost.Name,
                };
                if (contactPost.Position) patchLine.Position = contactPost.Position;
                if (contactPost.Phone1) patchLine.Phone1 = contactPost.Phone1;
                if (contactPost.E_Mail) patchLine.E_Mail = contactPost.E_Mail;

                const patchRes = await fetch(`${config.sap.serviceLayerUrl}/BusinessPartners('${cc}')`, {
                    method: 'PATCH',
                    headers: {
                        Cookie: cookies || '',
                        'Content-Type': 'application/json',
                        'B1S-ReplaceCollectionsOnPatch': 'false',
                    },
                    body: JSON.stringify({ ContactEmployees: [patchLine] }),
                });

                if (!patchRes.ok && patchRes.status !== 204) {
                    let errDetail = '';
                    try {
                        errDetail = await patchRes.text();
                    } catch {
                        /* ignore */
                    }
                    return NextResponse.json({
                        success: false,
                        message: `PATCH ContactEmployees falhou (${patchRes.status}): ${errDetail.slice(0, 500)}`,
                    });
                }

                if (source_recno && table === 'SU5010') {
                    await writeSapIdBack(supabase, 'SU5010', 'r_e_c_n_o_', source_recno, String(lineNum));
                }
                return NextResponse.json({
                    success: true,
                    data: { CardCode: cardCode, LineNum: lineNum, Name: name },
                });
            }

            const baseSl = config.sap.serviceLayerUrl.replace(/\/$/, '');
            const postUrl = `${baseSl}/BusinessPartners('${cc}')/ContactEmployees`;
            const postRes = await fetch(postUrl, {
                method: 'POST',
                headers: { Cookie: cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(contactPost),
            });
            const postText = await postRes.text();
            let newLineNum: string | number | undefined;
            let contactMergeInferred: boolean | undefined;

            if (postRes.ok) {
                try {
                    const j = JSON.parse(postText);
                    newLineNum = j?.LineNum ?? j?.InternalCode;
                } catch {
                    /* ignore */
                }
            } else if (contactEmployeesPostUnsupported(postRes.status, postText)) {
                const merged = await addContactEmployeeViaPatchMerge(
                    config.sap.serviceLayerUrl,
                    cookies || '',
                    cardCode,
                    {
                        Name: name,
                        Position: contactPost.Position as string | undefined,
                        Phone1: contactPost.Phone1 as string | undefined,
                        E_Mail: contactPost.E_Mail as string | undefined,
                    }
                );
                if (!merged.ok) {
                    return NextResponse.json({
                        success: false,
                        message:
                            `POST ${postUrl} não suportado neste Service Layer (-1008). ` +
                            `Tentativa PATCH (merge) também falhou: ${merged.message}`,
                    });
                }
                newLineNum = merged.lineNum;
                contactMergeInferred = merged.lineNumInferred;
            } else {
                return NextResponse.json({
                    success: false,
                    message: `POST ${postUrl} falhou (${postRes.status}): ${postText.slice(0, 500)}`,
                });
            }

            if (newLineNum !== undefined && newLineNum !== null && String(newLineNum).trim() !== '') {
                if (source_recno && table === 'SU5010') {
                    await writeSapIdBack(supabase, 'SU5010', 'r_e_c_n_o_', source_recno, String(newLineNum));
                }
            }
            return NextResponse.json({
                success: true,
                data: { CardCode: cardCode, LineNum: newLineNum ?? null, Name: name },
                ...(contactMergeInferred
                    ? {
                          message:
                              'PATCH de contatos OK; LineNum foi inferido (o Service Layer não devolveu a lista após gravar). Confira o contato no cadastro do parceiro no SAP.',
                      }
                    : {}),
            });
        }

        // --- UNIVERSAL PRE-FLIGHT CHECK ---
        // Se a ação for de inserção e tivermos a chave primária mapeada no payload,
        // checa primeiro se ele já existe no SAP Service Layer.
        if (finalAction === 'insert' && key) {
            const isNumericKey = ['Orders', 'JournalEntries', 'Invoices', 'PurchaseInvoices'].includes(targetObject);
            // Replace simple quotes with double single quotes for OData escaping
            const escapedKey = String(key).replace(/'/g, "''");
            const keyStr = isNumericKey ? escapedKey : `'${escapedKey}'`;
            const checkUrl = `${config.sap.serviceLayerUrl}/${targetObject}(${keyStr})`;
            
            try {
                const selectFields = targetObject === 'Orders'
                    ? 'DocEntry,CANCELED,Cancelled'
                    : (isNumericKey ? 'ObjectCode' : 'UpdateDate');
                const checkRes = await fetch(`${checkUrl}?$select=${selectFields}`, {
                    method: 'GET',
                    headers: { 'Cookie': cookies || '' }
                });
                
                if (checkRes.ok) {
                    if (targetObject === 'Orders') {
                        const order = await checkRes.json();
                        const rawCanceled = order?.CANCELED ?? order?.Cancelled ?? order?.Canceled ?? order?.cancelled;
                        const canceled = rawCanceled !== undefined && rawCanceled !== null && ['Y', 'TYES', 'YES', 'TRUE', '1'].includes(String(rawCanceled).trim().toUpperCase());
                        if (canceled) {
                            console.log(`[execute] Orders(${key}) encontrado com CANCELED=Y. Mantendo INSERT para nova inclusão.`);
                        } else {
                            console.log(`[execute] Registro ${key} já existe em ${targetObject}. Mudando ação de INSERT para UPDATE.`);
                            finalAction = 'update';
                        }
                    } else {
                        console.log(`[execute] Registro ${key} já existe em ${targetObject}. Mudando ação de INSERT para UPDATE.`);
                        finalAction = 'update';
                    }
                }
            } catch (err) {
                console.warn(`[execute] Erro no pre-flight check para ${targetObject}(${key}):`, err);
            }
        }

        // ── IBGE to SAP AbsId Translation (`County`) ──
        // SAP B1 requires the County field in BPAddresses to be the internal AbsId of the OCNT table, not the IBGE code string.
        if (targetObject === 'BusinessPartners' && Array.isArray(payload.BPAddresses)) {
            for (const addr of payload.BPAddresses) {
                if (addr.County && !isNaN(Number(addr.County)) && String(addr.County).length >= 4) {
                    console.log(`[execute] Intercepting SAP County IBGE Code: ${addr.County}`);
                    try {
                        const ibgeStr = String(addr.County);
                        let translated = false;

                        // 1. Pesquisa OData no campo 'IbgeCode' (Padrão para localizações B1 brasileiras mais recentes)
                        let oDataRes = await fetch(`${config.sap.serviceLayerUrl}/Counties?$select=AbsId,Code,Name,IbgeCode&$filter=IbgeCode eq '${ibgeStr}'`, {
                            headers: { 'Cookie': cookies || '' }
                        });
                        
                        if (oDataRes.ok) {
                            const oData = await oDataRes.json();
                            if (oData.value && oData.value.length > 0) {
                                addr.County = String(oData.value[0].AbsId);
                                translated = true;
                                console.log(`[execute] OData Transformed IBGE ${ibgeStr} (via IbgeCode) -> OCNT.AbsId ${addr.County} (${oData.value[0].Name})`);
                            }
                        }

                        // 2. Pesquisa fallback no campo 'Code' (Padrão para Add-ons customizados ou implantações antigas)
                        if (!translated) {
                            oDataRes = await fetch(`${config.sap.serviceLayerUrl}/Counties?$select=AbsId,Code,Name,IbgeCode&$filter=Code eq '${ibgeStr}'`, {
                                headers: { 'Cookie': cookies || '' }
                            });
                            if (oDataRes.ok) {
                                const oData = await oDataRes.json();
                                if (oData.value && oData.value.length > 0) {
                                    addr.County = String(oData.value[0].AbsId);
                                    translated = true;
                                    console.log(`[execute] OData Transformed IBGE ${ibgeStr} (via Code) -> OCNT.AbsId ${addr.County} (${oData.value[0].Name})`);
                                }
                            }
                        }

                        if (!translated) {
                            console.warn(`[execute] Ignored County IBGE ${ibgeStr} (Not found in SAP OCNT)`);
                            delete addr.County;
                        }

                    } catch (e) {
                        console.error('[execute] Failed to translate County IBGE.', e);
                        delete addr.County;
                    }
                }
            }
        }


        // ── JournalEntries: PATCH cirúrgico com campos comprovadamente aceitos ──────
        if (targetObject === 'JournalEntries' && finalAction === 'update') {
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
                    await writeSapIdBack(supabase, pgTbl, 'r_e_c_n_o_', source_recno, key);
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
        // Em Orders lançados: CardCode, CardName, DocType, DocumentLines costumam ser imutáveis no PATCH.
        // Em Drafts (SE1010): CardName pode ser atualizado conforme mapeamento (ex.: nome do cliente na origem).
        if (targetObject === 'Orders' && finalAction === 'update') {
            const isSe1010DraftFlow = table === 'SE1010';
            if (!key) {
                return NextResponse.json({
                    success: false,
                    message: isSe1010DraftFlow
                        ? 'Draft já existe no SAP B1, mas o DocEntry não foi identificado.'
                        : 'Sales Order já existe no SAP B1, mas o DocEntry não foi identificado.'
                });
            }

            // Monta payload apenas com campos seguros para PATCH em Orders / Drafts
            const orderPatch: Record<string, any> = {};
            if (payload.DocDueDate) orderPatch.DocDueDate = payload.DocDueDate;
            if (payload.TaxDate) orderPatch.TaxDate = payload.TaxDate;
            if (payload.DocDate) orderPatch.DocDate = payload.DocDate;
            if (payload.Comments) orderPatch.Comments = payload.Comments;
            if (payload.NumAtCard) orderPatch.NumAtCard = payload.NumAtCard;
            if (payload.BPL_IDAssignedToInvoice !== undefined)
                orderPatch.BPL_IDAssignedToInvoice = payload.BPL_IDAssignedToInvoice;
            if (isSe1010DraftFlow) {
                const cn = payload.CardName;
                if (cn !== undefined && cn !== null && String(cn).trim() !== '') {
                    orderPatch.CardName = String(cn).trim();
                }
            }

            const ordersUpdateObject = isSe1010DraftFlow ? 'Drafts' : 'Orders';
            const patchRes = await fetch(`${config.sap.serviceLayerUrl}/${ordersUpdateObject}(${Number(key)})`, {
                method: 'PATCH',
                headers: { 'Cookie': cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(orderPatch)
            });

            if (patchRes.status === 204 || patchRes.ok) {
                // Write-back do DocEntry (reutilizando __sap_id)
                if (source_recno && key) {
                    await writeSapIdBack(supabase, 'se1010', 'r_e_c_n_o_', source_recno, key);
                }
                return NextResponse.json({
                    success: true,
                    data: { DocEntry: key },
                    message: isSe1010DraftFlow
                        ? `Draft DocEntry ${key} atualizado.`
                        : `Sales Order DocEntry ${key} atualizada.`
                });
            } else {
                let errMsg = isSe1010DraftFlow
                    ? `Falha ao atualizar Draft ${key}.`
                    : `Falha ao atualizar Sales Order ${key}.`;
                try {
                    const errJson = await patchRes.json();
                    errMsg = errJson?.error?.message?.value || errMsg;
                } catch { /* ignore */ }
                return NextResponse.json({
                    success: false,
                    message: `${isSe1010DraftFlow ? 'Draft' : 'Order'} ${key} — PATCH falhou (${patchRes.status}): ${errMsg}`
                });
            }
        }


        let response;
        let createdAsDraft = false;
        /** SE1010 → Orders: regra criada antes do POST; mensagem opcional no retorno. */
        let distributionRuleMessage: string | undefined;
        /** Quando o $metadata não declara OcrCode em DocumentLine, o SL pode ignorar o vínculo na linha. */
        let distributionRuleWarning: string | undefined;
        let serviceLayerDocumentLineOcrSupported: boolean | undefined;
        /** SE1010 → Orders: rateio (linha única); DistributionRules antes do pedido + OcrCode na linha do POST. */
        let orderInsertExecutions: ResultCenterFormulaExecution[] | undefined;
        let orderInsertMeta:
            | {
                  inWhichDimension?: number;
                  distributionMode?: 'multiLine' | 'singleLine';
                  lineDimensionField?: 'CostingCode' | 'CostingCode2';
              }
            | undefined;
        let orderInsertDocLines: unknown;
        let orderInsertDocDate: string | undefined;

        if (finalAction === 'insert') {
            const insertPayload = { ...payload };
            const willCreateOrderDraft = table === 'SE1010' && targetObject === 'Orders';
            orderInsertExecutions = insertPayload._resultCenterFormulaExecutions as
                | ResultCenterFormulaExecution[]
                | undefined;
            orderInsertMeta = insertPayload._resultCenterDistributionMeta as
                | {
                      inWhichDimension?: number;
                      distributionMode?: 'multiLine' | 'singleLine';
                      lineDimensionField?: 'CostingCode' | 'CostingCode2';
                  }
                | undefined;
            orderInsertDocLines = insertPayload.DocumentLines;
            orderInsertDocDate = insertPayload.DocDate as string | undefined;
            // Remover campos internos do pipeline antes de enviar ao SAP
            delete insertPayload._sapJdtNum;
            delete insertPayload._sapDocEntry;
            delete insertPayload._orderLineTemplateWarnings;
            delete insertPayload._resultCenterDistributionWarnings;
            delete insertPayload._resultCenterFormulaExecutions;
            delete insertPayload._resultCenterDistributionMeta;

            // Limpeza defensiva de campos vazios para ChartOfAccounts
            if (targetObject === 'ChartOfAccounts') {
                if (insertPayload.AccountType === '') delete insertPayload.AccountType;
                if (insertPayload.FormatCode === '') delete insertPayload.FormatCode;
            }

            // DocumentLines para Orders deve ser array
            if (targetObject === 'Orders' && insertPayload.DocumentLines && !Array.isArray(insertPayload.DocumentLines)) {
                insertPayload.DocumentLines = [insertPayload.DocumentLines];
            }

            // Linha única + vários centros, sem OOCR neste POST: evitar só o 1º centro em CostingCode* (preview já omite).
            // Com OOCR (bloco abaixo), o centro na dimensão é gravado após criar a regra — CostingCode* é aceito pelo SL.
            const willPostOOCR =
                targetObject === 'Orders' &&
                orderInsertExecutions &&
                shouldCreateDistributionRuleForOrder(orderInsertExecutions, orderInsertDocLines);
            if (
                targetObject === 'Orders' &&
                orderInsertExecutions &&
                orderInsertExecutions.length >= 2 &&
                orderInsertMeta?.distributionMode === 'singleLine' &&
                Array.isArray(insertPayload.DocumentLines) &&
                insertPayload.DocumentLines.length === 1 &&
                !willPostOOCR
            ) {
                const first = { ...(insertPayload.DocumentLines[0] as Record<string, unknown>) };
                const dimField = orderInsertMeta.lineDimensionField ?? 'CostingCode2';
                if (dimField === 'CostingCode2') delete first.CostingCode2;
                else delete first.CostingCode;
                insertPayload.DocumentLines = [first];
            }

            // ── SE1010: POST DistributionRules primeiro; OcrCode na linha no POST /Orders (sem PATCH) ──
            if (
                targetObject === 'Orders' &&
                orderInsertExecutions &&
                shouldCreateDistributionRuleForOrder(orderInsertExecutions, orderInsertDocLines)
            ) {
                try {
                    const metaRes = await fetch(`${config.sap.serviceLayerUrl.replace(/\/$/, '')}/$metadata`, {
                        headers: { Cookie: cookies || '' },
                    });
                    if (metaRes.ok) {
                        serviceLayerDocumentLineOcrSupported = documentLineOcrSupportedInMetadata(
                            await metaRes.text()
                        );
                    }
                } catch {
                    /* ignore — aviso só quando soubermos que não há OcrCode no metadata */
                }

                const se1010TitleNum =
                    table === 'SE1010' && e1_num != null && String(e1_num).trim() !== ''
                        ? String(e1_num).trim()
                        : undefined;
                const dr = await postDistributionRule(
                    config.sap.serviceLayerUrl,
                    cookies || '',
                    orderInsertExecutions,
                    {
                        inWhichDimension: orderInsertMeta?.inWhichDimension ?? 2,
                        docDate: orderInsertDocDate,
                        titleDocumentNumber: se1010TitleNum,
                    }
                );
                if (!dr.ok) {
                    return NextResponse.json({
                        success: false,
                        message: dr.message || 'Falha ao criar regra de distribuição no SAP.',
                    });
                }
                const dimForRule = orderInsertMeta?.inWhichDimension ?? 2;
                injectDistributionRuleCodeIntoOrderFirstLine(insertPayload, dr.factorCode, dimForRule);
                if (willCreateOrderDraft) {
                    // Em Drafts, alguns ambientes não vinculam a OOCR por OcrCode*.
                    // Forçamos o FactorCode também no campo de dimensão da linha (CostingCode*)
                    // para refletir a "Regra de distribuição" no esboço.
                    const dl = insertPayload.DocumentLines;
                    const arr = Array.isArray(dl) ? [...dl] : dl ? [dl] : [];
                    if (arr.length > 0 && arr[0]) {
                        const first = { ...(arr[0] as Record<string, unknown>) };
                        const dimField = dimForRule === 1 ? 'CostingCode' : `CostingCode${dimForRule}`;
                        first[dimField] = dr.factorCode;
                        arr[0] = first;
                        insertPayload.DocumentLines = arr;
                    }
                    distributionRuleMessage = `DistributionRules criada; FactorCode=${dr.factorCode} (${dr.ruleLinesPosted ?? orderInsertExecutions.length} centro(s)); Draft com regra vinculada na dimensão (CostingCode…).`;
                } else {
                    injectPrimaryCostCenterIntoOrderFirstLine(insertPayload, orderInsertExecutions, dimForRule);
                    distributionRuleMessage = `DistributionRules criada; FactorCode=${dr.factorCode} (${dr.ruleLinesPosted ?? orderInsertExecutions.length} centro(s)); OcrCode na linha + centro principal na dimensão (CostingCode…).`;
                }
                if (serviceLayerDocumentLineOcrSupported === false) {
                    distributionRuleWarning =
                        'O Service Layer deste ambiente não declara OcrCode/OcrCode2 no tipo DocumentLine ($metadata). ' +
                        'Foi gravado o centro principal na coluna de dimensão (CostingCode…) na linha; a coluna "Regra de distribuição" pode continuar vazia até o SAP expor OcrCode no SL ou vínculo manual do FactorCode. ' +
                        'Alternativa: modo várias linhas (um centro por linha).';
                }
            }

            // SE1010/Orders: criar como esboço no SAP (endpoint Drafts)
            const insertEndpointObject =
                table === 'SE1010' && targetObject === 'Orders' ? 'Drafts' : targetObject;
            createdAsDraft = insertEndpointObject === 'Drafts';
            if (createdAsDraft) {
                // SAP Service Layer exige o tipo do documento ao criar Draft.
                insertPayload.DocObjectCode = '17'; // Sales Order
            }
            response = await fetch(`${config.sap.serviceLayerUrl}/${insertEndpointObject}`, {
                method: 'POST',
                headers: { 'Cookie': cookies || '', 'Content-Type': 'application/json' },
                body: JSON.stringify(insertPayload)
            });

        } else if (finalAction === 'update') {
            // Remove PK and immutable fields for Update
            const updatePayload = { ...payload };
            delete updatePayload.CardCode;  // PK: cannot be sent in update body
            delete updatePayload.CardType;  // Immutable: type cannot change
            delete updatePayload.ItemCode;  // PK Items
            delete updatePayload.Code;      // PK ChartOfAccounts
            delete updatePayload.CenterCode; // PK ProfitCenters

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
                    if (updatePayload.BPFiscalTaxIDCollection && Array.isArray(updatePayload.BPFiscalTaxIDCollection)) {
                        const existingFiscal: any[] = currentBP.BPFiscalTaxIDCollection || [];
                        const newBPFiscal = JSON.parse(JSON.stringify(existingFiscal));
                        let hasFiscalChanges = false;
                        
                        updatePayload.BPFiscalTaxIDCollection.forEach((fiscal: any) => {
                            const paramsAddr = fiscal.Address || "";
                            const existingIndex = newBPFiscal.findIndex((e: any) => (e.Address || "") === paramsAddr);
                            
                            if (existingIndex !== -1) {
                                let localChanges = false;
                                for (const key of Object.keys(fiscal)) {
                                    if (key !== 'Address' && String(fiscal[key]) !== String(newBPFiscal[existingIndex][key])) {
                                        newBPFiscal[existingIndex][key] = fiscal[key];
                                        localChanges = true;
                                        console.log(`[execute] CRD7 mudou ${key}: SAP="${newBPFiscal[existingIndex][key]}" → novo="${fiscal[key]}"`);
                                    }
                                }
                                if (localChanges) hasFiscalChanges = true;
                            } else {
                                newBPFiscal.push(fiscal);
                                hasFiscalChanges = true;
                                console.log(`[execute] CRD7 PATCH: novo registro fiscal incluído.`);
                            }
                        });

                        if (hasFiscalChanges) {
                            updatePayload.BPFiscalTaxIDCollection = newBPFiscal;
                        } else {
                            delete updatePayload.BPFiscalTaxIDCollection;
                            console.log(`[execute] CRD7 PATCH: nenhuma atualização necessária para ${key}`);
                        }
                    }

                    // ── BPAddresses (CRD1): Atualização completa via Merge ──
                    if (updatePayload.BPAddresses && Array.isArray(updatePayload.BPAddresses)) {
                        const existingAddresses: any[] = currentBP.BPAddresses || [];
                        const newBPAddresses = JSON.parse(JSON.stringify(existingAddresses));
                        let hasAddressChanges = false;

                        updatePayload.BPAddresses.forEach((addr: any) => {
                            const name = addr.AddressName || (addr.AddressType === 'bo_BillTo' ? 'Cobranca' : 'Entrega');
                            addr.AddressName = name; // Garante primary key

                            const existingIndex = newBPAddresses.findIndex((e: any) => e.AddressName === name);
                            
                            if (existingIndex !== -1) {
                                let localChanges = false;
                                for (const field of Object.keys(addr)) {
                                    if (field !== 'AddressName' && field !== 'RowNum') {
                                        const v1 = addr[field] !== undefined && addr[field] !== null ? String(addr[field]).trim() : '';
                                        const v2 = newBPAddresses[existingIndex][field] !== undefined && newBPAddresses[existingIndex][field] !== null ? String(newBPAddresses[existingIndex][field]).trim() : '';
                                        
                                        if (v1 !== v2) {
                                            newBPAddresses[existingIndex][field] = addr[field];
                                            localChanges = true;
                                            console.log(`[execute] CRD1 mudou ${field}: SAP="${v2}" → novo="${v1}"`);
                                        }
                                    }
                                }
                                if (localChanges) hasAddressChanges = true;
                            } else {
                                // Novo endereço
                                newBPAddresses.push(addr);
                                hasAddressChanges = true;
                            }
                        });
                        
                        if (hasAddressChanges) {
                            updatePayload.BPAddresses = newBPAddresses;
                        } else {
                            delete updatePayload.BPAddresses;
                            console.log(`[execute] CRD1 PATCH: nenhuma atualização necessária para endereços`);
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

            const reqHeaders: any = { 'Cookie': cookies || '', 'Content-Type': 'application/json' };
            if (targetObject === 'BusinessPartners' && (updatePayload.BPAddresses || updatePayload.BPFiscalTaxIDCollection)) {
                // Habilitando a substituição total de coleções
                // Isso resolve a falha (ODBC -2035) permitindo que enviemos AddressName tranquilamente
                reqHeaders['B1S-ReplaceCollectionsOnPatch'] = 'true';
            }

            response = await fetch(`${config.sap.serviceLayerUrl}/${targetObject}('${key}')`, {
                method: 'PATCH',
                headers: reqHeaders,
                body: JSON.stringify(updatePayload)
            });

            if (!response.ok) {
                const errText = await response.text();
                return NextResponse.json({
                    success: false,
                    message: `Update Failed: ${errText} - Payload: ${JSON.stringify(updatePayload)}`
                });
            }

            // ── Write-back: PATCH bem-sucedido → __sap_id já era conhecido (= key) ──
            const sapIdToSave = key;
            if (sapIdToSave) {
                if (source_row_id) {
                    await supabase
                        .from(table.toLowerCase())
                        .update({ __sap_id: String(sapIdToSave) })
                        .or(`__source_key.eq.${source_row_id},id.eq.${source_row_id}`);
                } else if (source_pk && SAP_ID_WRITEBACK[table]) {
                    await writeSapIdBack(supabase, table, SAP_ID_WRITEBACK[table].pkField, source_pk, sapIdToSave);
                } else if (source_recno && (table === 'SE1010' || table === 'SE2010')) {
                    await writeSapIdBack(supabase, table, 'r_e_c_n_o_', source_recno, sapIdToSave);
                } else if (source_pk || source_recno) {
                    const fallbackSource = source_pk || source_recno;
                    await supabase
                        .from(table.toLowerCase())
                        .update({ __sap_id: String(sapIdToSave) })
                        .or(`__source_key.eq.${fallbackSource},id.eq.${fallbackSource}`);
                }
            }

            // Para PATCH, geralmente 204 No Content
            if (response.status === 204) {
                return NextResponse.json({ success: true, data: { [SAP_ID_WRITEBACK[table]?.sapField ?? 'key']: key } });
            }

        } else {
            return NextResponse.json({ success: false, message: 'Invalid action: ' + finalAction });
        }

        // Shared Response Handling
        if (response.status === 204) {
            return NextResponse.json({ success: true, data: {} });
        }

        const json = await response.json();

        if (!response.ok) {
            return NextResponse.json({ success: false, message: json.error?.message?.value || 'Unknown SAP Error' });
        }

        // ── Write-back: INSERT bem-sucedido → salva __sap_id retornado pelo SAP ──
        const sapIdToSave = json?.Code || json?.DocEntry || json?.ItemCode || json?.CardCode || json?.JdtNum || key;
        
        if (sapIdToSave) {
            if (source_row_id) {
                await supabase
                    .from(table.toLowerCase())
                    .update({ __sap_id: String(sapIdToSave) })
                    .or(`__source_key.eq.${source_row_id},id.eq.${source_row_id}`);
            } else if (source_pk && SAP_ID_WRITEBACK[table]) {
                await writeSapIdBack(supabase, table, SAP_ID_WRITEBACK[table].pkField, source_pk, sapIdToSave);
            } else if (source_recno && (table === 'SE1010' || table === 'SE2010')) {
                await writeSapIdBack(supabase, table, 'r_e_c_n_o_', source_recno, sapIdToSave);
            } else if (source_pk || source_recno) {
                const fallbackSource = source_pk || source_recno;
                await supabase
                    .from(table.toLowerCase())
                    .update({ __sap_id: String(sapIdToSave) })
                    .or(`__source_key.eq.${fallbackSource},id.eq.${fallbackSource}`);
            }
        }

        const successMessage =
            createdAsDraft && targetObject === 'Orders'
                ? `Sales Order criada como Draft no SAP (DocEntry: ${json?.DocEntry ?? 'n/a'}).`
                : undefined;

        return NextResponse.json({
            success: true,
            data:
                distributionRuleMessage || distributionRuleWarning
                    ? {
                          ...json,
                          ...(distributionRuleMessage ? { distributionRuleMessage } : {}),
                          ...(distributionRuleWarning ? { distributionRuleWarning } : {}),
                      }
                    : json,
            ...(successMessage ? { message: successMessage } : {}),
        });

    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
