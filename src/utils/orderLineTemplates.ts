import type { OrderLineTemplatesConfig } from '@/types/mapping';
import {
    evalNumericExpression,
    lineMonetaryAmount,
    normalizeKey,
    substitutePlaceholdersNumeric,
    substitutePlaceholdersString,
} from '@/utils/lineFormulaHelpers';

/**
 * Monta DocumentLines[] a partir de orderLineTemplates (SE1010 → Orders).
 * Retorno vazio: caller usa mapeamento plano (uma linha).
 */
export function buildOrderLinesFromTemplates(
    src: any,
    config: OrderLineTemplatesConfig
): { lines: Record<string, any>[]; warnings: string[] } {
    const warnings: string[] = [];
    const tplLines = (config.lines || []).filter(l => l && String(l.itemCode || '').trim());
    if (tplLines.length === 0) {
        return { lines: [], warnings: [] };
    }

    const lines: Record<string, any>[] = [];

    for (let i = 0; i < tplLines.length; i++) {
        const t = tplLines[i];
        const itemCode = substitutePlaceholdersString(String(t.itemCode), src).trim();
        if (!itemCode) {
            warnings.push(`Linha ${i + 1}: ItemCode vazio após substituição.`);
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
            warnings.push(`Linha ${i + 1}: quantidade inválida (${qtyRaw}). Usando 1.`);
            quantity = 1;
        }

        const hasLineTotal = !!t.lineTotalFormula?.trim();
        const hasUnitPrice = !!t.unitPriceFormula?.trim();

        if (!hasLineTotal && !hasUnitPrice) {
            warnings.push(`Linha ${i + 1}: informe unitPriceFormula ou lineTotalFormula.`);
            continue;
        }

        if (hasLineTotal && hasUnitPrice) {
            warnings.push(`Linha ${i + 1}: use só unitPriceFormula ou lineTotalFormula; usando lineTotal.`);
        }

        const line: Record<string, any> = { ItemCode: itemCode };

        if (hasLineTotal) {
            const sub = substitutePlaceholdersNumeric(t.lineTotalFormula!, src);
            try {
                const lt = evalNumericExpression(sub);
                if (!Number.isFinite(lt)) throw new Error('NaN');
                line.Quantity = 1;
                line.UnitPrice = lt;
            } catch (e: any) {
                warnings.push(`Linha ${i + 1}: lineTotal inválido — ${e?.message || sub}`);
                continue;
            }
        } else {
            const sub = substitutePlaceholdersNumeric(t.unitPriceFormula!, src);
            try {
                const up = evalNumericExpression(sub);
                if (!Number.isFinite(up)) throw new Error('NaN');
                line.Quantity = quantity;
                line.UnitPrice = up;
            } catch (e: any) {
                warnings.push(`Linha ${i + 1}: UnitPrice inválido — ${e?.message || sub}`);
                continue;
            }
        }

        lines.push(line);
    }

    if (lines.length === 0) {
        return { lines: [], warnings };
    }

    if (config.reconcileLastLine && config.compareTotalField && lines.length >= 1) {
        const tf = config.compareTotalField;
        const rawTotal = src[tf] ?? src[tf.toUpperCase()] ?? src[normalizeKey(tf)];
        const targetTotal = Number(String(rawTotal ?? '').replace(/\s/g, '').replace(/,/g, '.'));
        if (Number.isFinite(targetTotal)) {
            let sumExceptLast = 0;
            for (let j = 0; j < lines.length - 1; j++) {
                sumExceptLast += lineMonetaryAmount(lines[j]);
            }
            const last = { ...lines[lines.length - 1] };
            const lastQty = Number(last.Quantity) || 1;
            const remainder = Math.round((targetTotal - sumExceptLast) * 100) / 100;
            last.UnitPrice = Math.round((remainder / lastQty) * 100) / 100;
            last.Quantity = lastQty;
            delete last.LineTotal;
            lines[lines.length - 1] = last;
            warnings.push(`Última linha ajustada para reconciliar com ${tf}=${targetTotal}.`);
        }
    }

    if (config.compareTotalField) {
        const tf = config.compareTotalField;
        const rawTotal = src[tf] ?? src[tf.toUpperCase()] ?? src[normalizeKey(tf)];
        const targetTotal = Number(String(rawTotal ?? '').replace(/\s/g, '').replace(/,/g, '.'));
        if (Number.isFinite(targetTotal)) {
            let sum = 0;
            for (const L of lines) {
                sum += lineMonetaryAmount(L);
            }
            sum = Math.round(sum * 100) / 100;
            const diff = Math.round((sum - targetTotal) * 100) / 100;
            if (Math.abs(diff) > 0.02) {
                warnings.push(
                    `Soma das linhas (${sum.toFixed(2)}) difere de ${tf} (${targetTotal.toFixed(2)}) em ${diff.toFixed(2)}.`
                );
            }
        }
    }

    return { lines, warnings };
}
