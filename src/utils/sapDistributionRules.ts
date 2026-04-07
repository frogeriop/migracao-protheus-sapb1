import { randomBytes } from 'crypto';
import type { ResultCenterFormulaExecution } from '@/types/mapping';

const AMOUNT_EPS = 0.005;

/** OOCR.FactorCode costuma ter até 8 caracteres; geramos um código único antes do POST do pedido. */
export function generateDistributionFactorCode(): string {
    return randomBytes(4).toString('hex').slice(0, 8).toUpperCase();
}

function nonZeroRateioExecutionCount(executions: unknown): number {
    if (!Array.isArray(executions)) return 0;
    return executions.filter(
        (ex: any) => Number(ex?.monetaryAmount) > AMOUNT_EPS
    ).length;
}

/**
 * Rateio em linha única: vários centros na mesma linha do pedido → cria DistributionRules e liga na linha.
 * Centros com valor efetivo zero não contam (alocação direta no centro com valor).
 */
export function shouldCreateDistributionRuleForOrder(
    executions: unknown,
    documentLines: unknown
): boolean {
    if (nonZeroRateioExecutionCount(executions) < 2) return false;
    const lines = Array.isArray(documentLines) ? documentLines : documentLines ? [documentLines] : [];
    return lines.length === 1;
}

/**
 * Rateio por valor efetivo (TotalFactor = soma dos valores; TotalInCenter = valor por centro).
 */
function buildDistributionRuleLinesAmount(
    executions: ResultCenterFormulaExecution[],
    effFrom: string,
    effTo: string
): { lines: Record<string, unknown>[]; totalFactor: number } {
    const lines: Record<string, unknown>[] = [];
    let total = 0;
    for (let i = 0; i < executions.length; i++) {
        const amt = Math.max(0, Math.round(Number(executions[i]!.monetaryAmount) * 100) / 100);
        if (amt <= AMOUNT_EPS) continue;
        const cc = String(executions[i]!.centerCode ?? '').trim();
        lines.push({
            CenterCode: cc,
            EffectiveFrom: effFrom,
            EffectiveTo: effTo,
            TotalInCenter: amt,
        });
        total += amt;
    }
    total = Math.round(total * 100) / 100;
    if (total <= 0 || lines.length === 0) return { lines: [], totalFactor: 0 };
    return { lines, totalFactor: total };
}

const FACTOR_DESCRIPTION_MAX_LEN = 100;

function factorDescriptionForDistributionRule(
    requestedFactorCode: string,
    titleDocumentNumber?: string
): string {
    const raw = String(titleDocumentNumber ?? '').trim();
    if (raw) {
        const desc = `Rateio do Titulo ${raw}`;
        return desc.length > FACTOR_DESCRIPTION_MAX_LEN
            ? desc.slice(0, FACTOR_DESCRIPTION_MAX_LEN)
            : desc;
    }
    return `Migração SE1010 ${requestedFactorCode}`;
}

/**
 * POST /DistributionRules antes do pedido. O FactorCode gerado (ou devolvido pelo SAP) vai em DocumentLines[].OcrCode no POST /Orders.
 */
export async function postDistributionRule(
    serviceLayerUrl: string,
    cookieHeader: string,
    executions: ResultCenterFormulaExecution[],
    opts: { inWhichDimension: number; docDate?: string; titleDocumentNumber?: string }
): Promise<{ ok: boolean; factorCode: string; message?: string; ruleLinesPosted?: number }> {
    const requestedFactorCode = generateDistributionFactorCode();
    const effFrom = opts.docDate && /^\d{4}-\d{2}-\d{2}/.test(opts.docDate)
        ? opts.docDate.slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    const effTo = '2099-12-31';

    const amountBuild = buildDistributionRuleLinesAmount(executions, effFrom, effTo);
    const lines = amountBuild.lines;
    const totalFactor = amountBuild.totalFactor;
    if (lines.length === 0) {
        return {
            ok: false,
            factorCode: requestedFactorCode,
            message: 'Nenhuma linha de rateio (valores zerados).',
        };
    }

    const body: Record<string, unknown> = {
        Active: 'tYES',
        Direct: 'N',
        DistributionRuleLines: lines,
        FactorCode: requestedFactorCode,
        FactorDescription: factorDescriptionForDistributionRule(
            requestedFactorCode,
            opts.titleDocumentNumber
        ),
        InWhichDimension: opts.inWhichDimension,
        TotalFactor: totalFactor,
    };

    const postRes = await fetch(`${serviceLayerUrl.replace(/\/$/, '')}/DistributionRules`, {
        method: 'POST',
        headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    let ruleLinesPosted = lines.length;
    if (!postRes.ok) {
        let errDetail = '';
        try {
            errDetail = await postRes.text();
        } catch {
            /* ignore */
        }
        return {
            ok: false,
            factorCode: requestedFactorCode,
            message: `DistributionRules POST falhou (${postRes.status}): ${errDetail.slice(0, 500)}`,
        };
    }

    let factorCode = requestedFactorCode;
    try {
        const created = await postRes.json();
        if (created?.FactorCode != null && String(created.FactorCode).trim() !== '') {
            factorCode = String(created.FactorCode).trim();
        }
        const n = created?.DistributionRuleLines?.length;
        if (typeof n === 'number' && n > 0) ruleLinesPosted = n;
    } catch {
        /* ignore */
    }

    return { ok: true, factorCode, ruleLinesPosted };
}

/**
 * Indica se o $metadata do Service Layer declara OcrCode na ComplexType DocumentLine.
 * Se não declarar, o POST costuma ignorar OcrCode/OcrCode2 na linha — a OOCR é criada, mas a coluna
 * "Regra de distribuição" pode ficar vazia na UI.
 */
export function documentLineOcrSupportedInMetadata(metadataXml: string): boolean {
    const start = metadataXml.indexOf('<ComplexType Name="DocumentLine"');
    if (start < 0) return false;
    const end = metadataXml.indexOf('</ComplexType>', start);
    const block = end > start ? metadataXml.slice(start, end) : metadataXml.slice(start, start + 200000);
    return /Property Name="OcrCode"/.test(block);
}

/**
 * Liga o FactorCode da OOCR à linha do pedido conforme a dimensão da regra (InWhichDimension).
 * Dim. 1 → OcrCode; Dim. 2 → OcrCode2 (ex.: Centro de resultado / CostingCode2); … até OcrCode5.
 * Só preencher OcrCode sem OcrCode2 quando a regra é dim. 2 deixa a coluna "Regra de distribuição" vazia na grade.
 */
export function injectDistributionRuleCodeIntoOrderFirstLine(
    payload: Record<string, unknown>,
    factorCode: string,
    inWhichDimension: number
): void {
    const dl = payload.DocumentLines;
    const arr = Array.isArray(dl) ? [...dl] : dl != null ? [dl] : [];
    if (arr.length < 1 || !arr[0]) return;
    const first = { ...(arr[0] as Record<string, unknown>) };

    const dim = Math.max(1, Math.min(5, Math.floor(Number(inWhichDimension)) || 2));

    delete first.OcrCode;
    delete first.OcrCode2;
    delete first.OcrCode3;
    delete first.OcrCode4;
    delete first.OcrCode5;

    if (dim === 1) first.OcrCode = factorCode;
    else if (dim === 2) first.OcrCode2 = factorCode;
    else if (dim === 3) first.OcrCode3 = factorCode;
    else if (dim === 4) first.OcrCode4 = factorCode;
    else first.OcrCode5 = factorCode;

    arr[0] = first;
    payload.DocumentLines = arr;
}

/** Dim. 1 → CostingCode; dim. 2 → CostingCode2; … até CostingCode5 (alinhado a InWhichDimension da OOCR). */
function costingCodeFieldForDimension(inWhichDimension: number): string {
    const d = Math.max(1, Math.min(5, Math.floor(Number(inWhichDimension)) || 2));
    return d === 1 ? 'CostingCode' : `CostingCode${d}`;
}

/**
 * Após criar a OOCR, grava o código do centro na dimensão da regra (CostingCode…).
 * O Service Layer costuma aceitar estes campos mesmo quando ignora OcrCode — a grade mostra a dimensão.
 * Usa o centro com maior valor no rateio (monetaryAmount); empate → menor centerIndex.
 */
export function injectPrimaryCostCenterIntoOrderFirstLine(
    payload: Record<string, unknown>,
    executions: ResultCenterFormulaExecution[],
    inWhichDimension: number
): void {
    if (!Array.isArray(executions) || executions.length === 0) return;
    const dl = payload.DocumentLines;
    const arr = Array.isArray(dl) ? [...dl] : dl != null ? [dl] : [];
    if (arr.length < 1 || !arr[0]) return;
    const first = { ...(arr[0] as Record<string, unknown>) };

    const field = costingCodeFieldForDimension(inWhichDimension);
    const sorted = [...executions].sort((a, b) => {
        const ma = Number(a.monetaryAmount) || 0;
        const mb = Number(b.monetaryAmount) || 0;
        if (mb !== ma) return mb - ma;
        return (a.centerIndex ?? 0) - (b.centerIndex ?? 0);
    });
    const primary = sorted[0];
    const cc = String(primary?.centerCode ?? '').trim();
    if (!cc) return;

    first[field] = cc;
    arr[0] = first;
    payload.DocumentLines = arr;
}
