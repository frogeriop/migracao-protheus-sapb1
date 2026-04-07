import type { ResultCenterDistributionConfig, ResultCenterFormulaExecution } from '@/types/mapping';
import {
    evalNumericExpression,
    lineMonetaryAmount,
    normalizeKey,
    substitutePlaceholdersNumeric,
    substitutePlaceholdersString,
} from '@/utils/lineFormulaHelpers';

/** Resolve campo de conferência numérico; null se vazio ou inválido (evita tratar ausência como 0). */
function resolveCompareTotal(src: any, field: string | undefined): number | null {
    if (!field || !String(field).trim()) return null;
    const raw = src[field] ?? src[field.toUpperCase()] ?? src[normalizeKey(field)];
    if (raw === undefined || raw === null) return null;
    const rawStr = String(raw).trim();
    if (rawStr === '') return null;
    const n = Number(rawStr.replace(/\s/g, '').replace(/,/g, '.'));
    return Number.isFinite(n) ? n : null;
}

/**
 * SAP B1: em muitas bases, Dimensão 2 (Centro de resultado) mapeia para DocumentLines.CostingCode2.
 * Confirme em $metadata ou teste POST no seu ambiente (InWhichDimension nos cadastros de centro).
 */
export function buildResultCenterDocumentLines(
    src: any,
    config: ResultCenterDistributionConfig,
    baseLine: Record<string, any>
): { lines: Record<string, any>[]; warnings: string[]; formulaExecutions: ResultCenterFormulaExecution[] } {
    const warnings: string[] = [];
    const formulaExecutions: ResultCenterFormulaExecution[] = [];
    const tplLines = (config.lines || []).filter(l => l && String(l.centerCode || '').trim());
    if (tplLines.length === 0) {
        return { lines: [], warnings: [], formulaExecutions: [] };
    }

    const itemCode = String(baseLine.ItemCode ?? '').trim();
    if (!itemCode) {
        warnings.push('Centro de resultado: ItemCode ausente no mapeamento plano (ex.: e1_xtipo → ItemCode).');
        return { lines: [], warnings, formulaExecutions };
    }

    const dimField = config.lineDimensionField ?? 'CostingCode2';
    /** Ausente no JSON legado = várias linhas (comportamento anterior). */
    const singleLineMode = config.distributionMode === 'singleLine';

    const lines: Record<string, any>[] = [];

    for (let i = 0; i < tplLines.length; i++) {
        const t = tplLines[i];
        const centerCode = substitutePlaceholdersString(String(t.centerCode), src).trim();
        if (!centerCode) {
            warnings.push(`Centro ${i + 1}: código vazio após substituição.`);
            continue;
        }

        const qtyRaw = t.quantityFormula?.trim()
            ? substitutePlaceholdersNumeric(t.quantityFormula, src)
            : '1';
        let quantity = 1;
        try {
            quantity = evalNumericExpression(qtyRaw);
            if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('qty');
        } catch {
            warnings.push(`Centro ${i + 1} (${centerCode}): quantidade inválida (${qtyRaw}). Usando 1.`);
            quantity = 1;
        }

        const hasLineTotal = !!t.lineTotalFormula?.trim();
        const hasUnitPrice = !!t.unitPriceFormula?.trim();

        if (!hasLineTotal && !hasUnitPrice) {
            warnings.push(`Centro ${i + 1} (${centerCode}): informe unitPriceFormula ou lineTotalFormula.`);
            continue;
        }

        if (hasLineTotal && hasUnitPrice) {
            warnings.push(`Centro ${i + 1} (${centerCode}): use só unitPriceFormula ou lineTotalFormula; usando lineTotal.`);
        }

        const line: Record<string, any> = { ...baseLine };
        delete line.LineNum;
        line.ItemCode = itemCode;
        delete line.CostingCode;
        delete line.CostingCode2;
        /** baseLine pode trazer LineTotal do mapeamento plano (ex.: e1_valor); lineMonetaryAmount prioriza LineTotal e ignoraria UnitPrice da fórmula. */
        delete line.LineTotal;
        line[dimField] = centerCode;

        if (hasLineTotal) {
            const sub = substitutePlaceholdersNumeric(t.lineTotalFormula!, src);
            try {
                const lt = evalNumericExpression(sub);
                if (!Number.isFinite(lt)) throw new Error('NaN');
                line.Quantity = 1;
                line.UnitPrice = lt;
            } catch (e: any) {
                warnings.push(`Centro ${i + 1} (${centerCode}): lineTotal inválido — ${e?.message || sub}`);
                continue;
            }
            formulaExecutions.push({
                centerIndex: i + 1,
                centerCode,
                mode: 'lineTotal',
                formulaTemplate: String(t.lineTotalFormula ?? '').trim(),
                substitutedExpression: sub,
                quantitySubstituted: qtyRaw,
                quantity: Number(line.Quantity) || 1,
                evaluatedMain: Number(line.UnitPrice),
                monetaryAmount: lineMonetaryAmount(line),
            });
        } else {
            const sub = substitutePlaceholdersNumeric(t.unitPriceFormula!, src);
            try {
                const up = evalNumericExpression(sub);
                if (!Number.isFinite(up)) throw new Error('NaN');
                line.Quantity = quantity;
                line.UnitPrice = up;
            } catch (e: any) {
                warnings.push(`Centro ${i + 1} (${centerCode}): UnitPrice inválido — ${e?.message || sub}`);
                continue;
            }
            formulaExecutions.push({
                centerIndex: i + 1,
                centerCode,
                mode: 'unitPrice',
                formulaTemplate: String(t.unitPriceFormula ?? '').trim(),
                substitutedExpression: sub,
                quantitySubstituted: qtyRaw,
                quantity: Number(line.Quantity) || 1,
                evaluatedMain: Number(line.UnitPrice),
                monetaryAmount: lineMonetaryAmount(line),
            });
        }

        lines.push(line);
    }

    /** Centros com valor líquido zero não entram no rateio: alocação direta quando sobra um só com valor. */
    const EPS = 0.005;
    const keptLines: Record<string, any>[] = [];
    const keptExecs: ResultCenterFormulaExecution[] = [];
    const droppedZeroCenters: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const L = lines[i]!;
        const amt = lineMonetaryAmount(L);
        if (amt <= EPS) {
            const cc = String(L[dimField] ?? '').trim();
            if (cc) droppedZeroCenters.push(cc);
            continue;
        }
        keptLines.push(L);
        keptExecs.push(formulaExecutions[i]!);
    }
    if (droppedZeroCenters.length > 0) {
        warnings.push(
            `Centro(s) com valor zero omitido(s) do rateio: ${droppedZeroCenters.join(', ')}.` +
                (keptLines.length === 1 ? ' Alocação direta no centro com valor.' : '')
        );
    }
    lines.length = 0;
    lines.push(...keptLines);
    formulaExecutions.length = 0;
    formulaExecutions.push(...keptExecs);

    if (lines.length === 0) {
        return { lines: [], warnings, formulaExecutions };
    }

    let outLines = lines;

    if (singleLineMode) {
        const amounts: number[] = [];
        let sumParts = 0;
        for (const L of lines) {
            const a = lineMonetaryAmount(L);
            amounts.push(a);
            sumParts += a;
        }
        sumParts = Math.round(sumParts * 100) / 100;

        const tf = config.compareTotalField;
        const resolved = resolveCompareTotal(src, tf);
        const hasTarget = resolved !== null;
        const targetTotal = resolved ?? 0;

        /** Valor da linha SAP: prioriza o campo de conferência (ex.: e1_valor), senão a soma das fórmulas. */
        const lineTotal = hasTarget ? Math.round(targetTotal * 100) / 100 : sumParts;

        const breakdown: string[] = [];
        let breakdownRunning = 0;
        for (let i = 0; i < lines.length; i++) {
            const cc = String(lines[i]![dimField] ?? '').trim();
            let showAmt = amounts[i]!;
            if (hasTarget && sumParts > 0 && resolved !== null) {
                if (i === lines.length - 1) {
                    showAmt = Math.round((resolved - breakdownRunning) * 100) / 100;
                } else {
                    showAmt = Math.round((amounts[i]! / sumParts) * resolved * 100) / 100;
                    breakdownRunning += showAmt;
                }
            }
            breakdown.push(`${cc || '?'}: ${showAmt.toFixed(2)}`);
        }

        const merged: Record<string, any> = { ...baseLine };
        delete merged.LineNum;
        merged.ItemCode = itemCode;
        delete merged.CostingCode;
        delete merged.CostingCode2;
        /** Vários centros: não fixar só o primeiro em dimField — integração usa DistributionRules + OcrCode. */
        if (lines.length < 2) {
            merged[dimField] = String(lines[0][dimField] ?? '').trim() || undefined;
        }
        merged.Quantity = 1;
        merged.UnitPrice = lineTotal;
        delete merged.LineTotal;

        const dimNote =
            lines.length >= 2
                ? `${dimField} omitido na linha (rateio multi-centro; não usar só o 1º centro)`
                : `${dimField}=${merged[dimField] ?? '—'} (centro único)`;

        let msg =
            `Linha única (produto): UnitPrice=${lineTotal.toFixed(2)}` +
            (hasTarget ? ` (conferência ${tf}=${targetTotal.toFixed(2)})` : ` (soma das fórmulas por centro: ${sumParts.toFixed(2)})`) +
            `; ${dimNote}. ` +
            (lines.length >= 2
                ? `Na integração: POST DistributionRules (rateio %), depois POST do pedido com OcrCode na linha. `
                : `O Service Layer não grava a matriz de distribuição manual do SAP; conclua o rateio nos centros no pedido. `) +
            `Rateio indicativo (soma = ${hasTarget ? targetTotal.toFixed(2) : sumParts.toFixed(2)}): ${breakdown.join('; ')}.`;
        if (hasTarget && Math.abs(sumParts - targetTotal) > 0.02) {
            msg +=
                ` Atenção: as fórmulas por centro somam ${sumParts.toFixed(2)}; o valor da linha segue ${tf} (${targetTotal.toFixed(2)}). ` +
                `O rateio indicativo acima foi proporcionalizado para bater com ${tf}.`;
        }
        warnings.push(msg);

        outLines = [merged];
    } else if (config.reconcileLastLine && config.compareTotalField && outLines.length >= 1) {
        const tf = config.compareTotalField;
        const targetTotal = resolveCompareTotal(src, tf);
        if (targetTotal !== null) {
            let sumExceptLast = 0;
            for (let j = 0; j < outLines.length - 1; j++) {
                sumExceptLast += lineMonetaryAmount(outLines[j]);
            }
            const last = { ...outLines[outLines.length - 1] };
            const lastQty = Number(last.Quantity) || 1;
            const remainder = Math.round((targetTotal - sumExceptLast) * 100) / 100;
            last.UnitPrice = Math.round((remainder / lastQty) * 100) / 100;
            last.Quantity = lastQty;
            delete last.LineTotal;
            outLines[outLines.length - 1] = last;
            warnings.push(`Última linha (CR) ajustada para reconciliar com ${tf}=${targetTotal}.`);
        }
    }

    if (config.compareTotalField) {
        const tf = config.compareTotalField;
        const targetTotal = resolveCompareTotal(src, tf);
        if (targetTotal !== null) {
            let sum = 0;
            for (const L of outLines) {
                sum += lineMonetaryAmount(L);
            }
            sum = Math.round(sum * 100) / 100;
            const diff = Math.round((sum - targetTotal) * 100) / 100;
            if (Math.abs(diff) > 0.02) {
                warnings.push(
                    `Soma das linhas CR (${sum.toFixed(2)}) difere de ${tf} (${targetTotal.toFixed(2)}) em ${diff.toFixed(2)}.`
                );
            }
        }
    }

    return { lines: outLines, warnings, formulaExecutions };
}
