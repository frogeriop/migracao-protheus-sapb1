'use client';

import { useState, useRef, useEffect } from 'react';
import {
    Ban, Trash2, AlertTriangle, CheckCircle, XCircle,
    Loader2, ChevronDown, ChevronUp, RotateCcw, ShieldAlert,
    Terminal
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type DocMode = 'orders' | 'journal-entries' | 'chart-of-accounts' | 'business-partners' | 'items' | 'profit-centers';
type Scope = 'list' | 'all';

interface SseEvent {
    type: 'start' | 'fetching' | 'fetched' | 'progress' | 'writeback' | 'done' | 'error';
    message?: string;
    current?: number;
    total?: number;
    docEntry?: number;
    status?: 'processing' | 'cancelled' | 'error';
    cancelled?: number;
    skipped?: number;
    errors?: number;
    writebackCleared?: number;
}

interface LogLine {
    time: string;
    text: string;
    kind: 'info' | 'ok' | 'error' | 'dim';
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function now() {
    return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────
export default function SapDeletePage() {
    const [docMode, setDocMode] = useState<DocMode>('orders');
    const [scope, setScope] = useState<Scope>('list');
    const [idsInput, setIdsInput] = useState('');
    const [clearWriteback, setClearWriteback] = useState(true);
    const [sourceTable, setSourceTable] = useState('se1010');
    const [confirmed, setConfirmed] = useState(false);
    const [confirmText, setConfirmText] = useState('');

    // Runtime state
    const [running, setRunning] = useState(false);
    const [logs, setLogs] = useState<LogLine[]>([]);
    const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
    const [summary, setSummary] = useState<SseEvent | null>(null);
    const [apiError, setApiError] = useState<string | null>(null);
    const [excelTables, setExcelTables] = useState<any[]>([]);

    useEffect(() => {
        const fetchEntities = async () => {
            try {
                const res = await fetch('/api/migration/entities');
                const json = await res.json();
                if (json.success && json.data) {
                    const tables = json.data
                        .filter((e: any) => e.staging_table)
                        .map((e: any) => e.staging_table)
                        .filter(Boolean);
                    setExcelTables(Array.from(new Set(tables)));
                }
            } catch (e) {
                console.error('Erro ao buscar tabelas exportadas:', e);
            }
        };
        fetchEntities();
    }, []);

    const logRef = useRef<HTMLDivElement>(null);

    // Auto-scroll do console
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [logs]);

    const parsedIdsNumeric = idsInput
        .split(/[\n,;\s]+/)
        .map(s => Number(s.trim()))
        .filter(n => !isNaN(n) && n > 0);

    const parsedIdsString = idsInput
        .split(/[\n,;\s]+/)
        .map(s => s.trim())
        .filter(Boolean);

    const isNumericTarget = docMode === 'orders' || docMode === 'journal-entries';
    const parsedIds = isNumericTarget ? parsedIdsNumeric : parsedIdsString;

    const isAll = scope === 'all';
    const allConfirmed = isAll ? confirmText.trim() === 'CONFIRMAR' : confirmed;
    const canRun = !running && allConfirmed && (!isAll ? parsedIds.length > 0 : true);

    const addLog = (text: string, kind: LogLine['kind'] = 'info') => {
        setLogs(prev => [...prev, { time: now(), text, kind }]);
    };

    // ── Cancelar Orders via SSE ─────────────────────────────────────────────
    const runCancelOrders = async () => {
        setRunning(true);
        setLogs([]);
        setProgress(null);
        setSummary(null);
        setApiError(null);

        const body = isAll
            ? { cancelAll: true, clearWriteback, sourceTable }
            : { docEntries: parsedIds, clearWriteback, sourceTable };

        try {
            const res = await fetch('/api/sap/cancel-orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            if (!res.ok || !res.body) {
                const err = await res.json().catch(() => ({ message: 'Erro desconhecido' }));
                setApiError(err.message ?? 'Falha na requisição');
                setRunning(false);
                return;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop() ?? '';

                for (const part of parts) {
                    const line = part.replace(/^data: /, '').trim();
                    if (!line) continue;
                    try {
                        const evt: SseEvent = JSON.parse(line);
                        switch (evt.type) {
                            case 'start':
                                addLog(evt.message ?? '', 'info');
                                break;
                            case 'fetching':
                                addLog(evt.message ?? '', 'dim');
                                break;
                            case 'fetched':
                                addLog(evt.message ?? '', 'info');
                                setProgress({ current: 0, total: evt.total ?? 0 });
                                break;
                            case 'progress':
                                addLog(evt.message ?? '', evt.status === 'error' ? 'error' : evt.status === 'cancelled' ? 'ok' : 'dim');
                                if (evt.current != null && evt.total != null) {
                                    setProgress({ current: evt.current, total: evt.total });
                                }
                                break;
                            case 'writeback':
                                addLog(evt.message ?? '', 'dim');
                                break;
                            case 'done':
                                addLog(evt.message ?? '', 'ok');
                                setSummary(evt);
                                setProgress(null);
                                break;
                            case 'error':
                                addLog(`✕ Erro: ${evt.message}`, 'error');
                                setApiError(evt.message ?? 'Erro desconhecido');
                                break;
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
        } catch (e: any) {
            setApiError(e.message);
            addLog(`✕ ${e.message}`, 'error');
        } finally {
            setRunning(false);
            setConfirmed(false);
            setConfirmText('');
        }
    };

    // ── Excluir Journal Entries (sem SSE, simples) ──────────────────────────
    const runDeleteJE = async () => {
        if (!parsedIds.length) return;
        setRunning(true);
        setLogs([]);
        setProgress(null);
        setSummary(null);
        setApiError(null);

        addLog(`Enviando ${parsedIds.length} JdtNum(s) para exclusão no SAP...`, 'info');
        try {
            const res = await fetch('/api/sap/delete-journal-entries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jdtNums: parsedIds, clearWriteback, sourceTable: 'se2010' }),
            });
            const json = await res.json();
            if (!json.success && !json.total) {
                addLog(`✕ ${json.message}`, 'error');
                setApiError(json.message);
            } else {
                for (const d of json.details ?? []) {
                    const id = d.jdtNum ?? d.docEntry;
                    if (d.status === 'deleted') addLog(`✓ JdtNum=${id} excluído.`, 'ok');
                    else addLog(`✕ JdtNum=${id} — ${d.message}`, 'error');
                }
                addLog(`Concluído: ${json.deleted} excluído(s), ${json.errors} erro(s).`, json.errors > 0 ? 'error' : 'ok');
                setSummary({ type: 'done', cancelled: json.deleted, errors: json.errors, total: json.total, writebackCleared: json.writebackCleared });
            }
        } catch (e: any) {
            setApiError(e.message);
            addLog(`✕ ${e.message}`, 'error');
        } finally {
            setRunning(false);
            setConfirmed(false);
        }
    };

    // ── Excluir Chart Of Accounts (sem SSE, simples) ──────────────────────────
    const runDeleteCOA = async () => {
        if (!isAll && !parsedIds.length) return;
        if (isAll && (!sourceTable || sourceTable === 'se1010')) {
            setApiError('Por favor, selecione a Tabela de origem primeiro.');
            return;
        }

        setRunning(true);
        setLogs([]);
        setProgress(null);
        setSummary(null);
        setApiError(null);

        const body = isAll 
            ? { deleteAllFromTable: true, clearWriteback, sourceTable }
            : { acctCodes: parsedIds, clearWriteback, sourceTable };

        addLog(isAll ? `Preparando exclusão de todas as contas da tabela ${sourceTable}...` : `Enviando ${parsedIds.length} conta(s) para exclusão no SAP...`, 'info');
        try {
            const res = await fetch('/api/sap/delete-chart-of-accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!json.success && !json.total) {
                addLog(`✕ ${json.message}`, 'error');
                setApiError(json.message);
            } else {
                for (const d of json.details ?? []) {
                    const id = d.code;
                    if (d.status === 'deleted') addLog(`✓ AcctCode=${id} excluído.`, 'ok');
                    else addLog(`✕ AcctCode=${id} — ${d.message}`, 'error');
                }
                addLog(`Concluído: ${json.deleted} excluído(s), ${json.errors} erro(s).`, json.errors > 0 ? 'error' : 'ok');
                setSummary({ type: 'done', cancelled: json.deleted, errors: json.errors, total: json.total, writebackCleared: json.writebackCleared });
            }
        } catch (e: any) {
            setApiError(e.message);
            addLog(`✕ ${e.message}`, 'error');
        } finally {
            setRunning(false);
            setConfirmed(false);
            setConfirmText('');
        }
    };

    // ── Excluir Entidades Genéricas (BPs, Items, Profit Centers) ────────────
    const runDeleteGeneric = async () => {
        if (!isAll && !parsedIds.length) return;
        if (isAll && !sourceTable) {
            setApiError('Por favor, selecione a Tabela de origem primeiro.');
            return;
        }

        setRunning(true);
        setLogs([]);
        setProgress(null);
        setSummary(null);
        setApiError(null);

        let entityObject = '';
        if (docMode === 'business-partners') entityObject = 'BusinessPartners';
        if (docMode === 'items') entityObject = 'Items';
        if (docMode === 'profit-centers') entityObject = 'ProfitCenters';

        const body = isAll 
            ? { entityObject, deleteAllFromTable: true, clearWriteback, sourceTable }
            : { entityObject, keys: parsedIds, clearWriteback, sourceTable };

        addLog(isAll ? `Preparando exclusão de todas as chaves da tabela ${sourceTable}...` : `Enviando ${parsedIds.length} chave(s) para exclusão no SAP...`, 'info');
        try {
            const res = await fetch('/api/sap/delete-entity', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!json.success && !json.total) {
                addLog(`✕ ${json.message}`, 'error');
                setApiError(json.message);
            } else {
                for (const d of json.details ?? []) {
                    const id = d.key;
                    if (d.status === 'deleted') addLog(`✓ Chave=${id} excluída.`, 'ok');
                    else addLog(`✕ Chave=${id} — ${d.message}`, 'error');
                }
                addLog(`Concluído: ${json.deleted} excluído(s), ${json.errors} erro(s).`, json.errors > 0 ? 'error' : 'ok');
                setSummary({ type: 'done', cancelled: json.deleted, errors: json.errors, total: json.total, writebackCleared: json.writebackCleared });
            }
        } catch (e: any) {
            setApiError(e.message);
            addLog(`✕ ${e.message}`, 'error');
        } finally {
            setRunning(false);
            setConfirmed(false);
            setConfirmText('');
        }
    };

    const handleRun = () => {
        if (!canRun) return;
        if (docMode === 'orders') runCancelOrders();
        else if (docMode === 'journal-entries') runDeleteJE();
        else if (docMode === 'chart-of-accounts') runDeleteCOA();
        else runDeleteGeneric();
    };

    const reset = () => {
        setLogs([]);
        setProgress(null);
        setSummary(null);
        setApiError(null);
        setConfirmed(false);
        setConfirmText('');
        setIdsInput('');
    };

    const actionLabel = docMode === 'orders' ? 'Cancelar' : 'Excluir';
    const idLabel = docMode === 'orders' ? 'DocEntry' : docMode === 'journal-entries' ? 'JdtNum' : docMode === 'chart-of-accounts' ? 'AcctCode' : docMode === 'business-partners' ? 'CardCode' : docMode === 'items' ? 'ItemCode' : 'CenterCode';

    return (
        <div className="container" style={{ maxWidth: 860 }}>
            <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {docMode === 'orders' && <><Ban size={26} style={{ color: 'var(--error)' }} /> Cancelar Sales Orders no SAP</>}
                {docMode === 'journal-entries' && <><Trash2 size={26} style={{ color: 'var(--error)' }} /> Excluir Journal Entries no SAP</>}
                {(docMode !== 'orders' && docMode !== 'journal-entries') && <><Trash2 size={26} style={{ color: 'var(--error)' }} /> Excluir {idLabel}s ({docMode}) no SAP</>}
            </h1>

            {/* ── Tipo de documento ── */}
            <div className="card" style={{ marginBottom: '1.25rem' }}>
                <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>Tipo de Documento</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                    {([
                        { id: 'orders', icon: '🛒', label: 'Sales Orders', desc: 'Cancela pedidos de venda. Informe DocEntry.' },
                        { id: 'journal-entries', icon: '📒', label: 'Journal Entries (LCMs)', desc: 'Exclui lançamentos contábeis. Informe JdtNum.' },
                        { id: 'chart-of-accounts', icon: '🏦', label: 'Plano de Contas', desc: 'Exclui contas. Informe os Codes.' },
                        { id: 'business-partners', icon: '👥', label: 'Parceiros de Negócio', desc: 'Exclui parceiros de negócio. Informe os CardCodes.' },
                        { id: 'items', icon: '📦', label: 'Itens (Produtos)', desc: 'Exclui produtos cadastrados. Informe os ItemCodes.' },
                        { id: 'profit-centers', icon: '🏢', label: 'Centros de Custo', desc: 'Exclui centros de custo do SAP. Informe os CenterCodes.' }
                    ] as { id: DocMode; icon: string; label: string; desc: string }[]).map(m => (
                        <div key={m.id}
                            onClick={() => { 
                                setDocMode(m.id); 
                                reset(); 
                                setScope('list'); 
                                setSourceTable((m.id !== 'orders' && m.id !== 'journal-entries') ? '' : 'se1010'); 
                            }}
                            style={{
                                padding: '1rem 1.25rem', borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s',
                                border: `2px solid ${docMode === m.id ? 'var(--error)' : 'var(--card-border)'}`,
                                backgroundColor: docMode === m.id ? 'rgba(239,68,68,0.07)' : 'transparent',
                            }}
                        >
                            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 3 }}>{m.icon} {m.label}</div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--secondary)' }}>{m.desc}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── Escopo (Geral, exceto JE) ── */}
            {(docMode !== 'journal-entries') && (
                <div className="card" style={{ marginBottom: '1.25rem' }}>
                    <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>Escopo {docMode === 'orders' ? 'do Cancelamento' : 'da Exclusão'}</h2>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        {([
                            { id: 'list', icon: '🔢', label: `Por lista de ${idLabel}s`, desc: 'Informe manualmente os códigos.' },
                            { id: 'all', icon: '💣', label: docMode === 'orders' ? 'Cancelar TODOS os abertos' : 'Excluir TODOS do arquivo', desc: docMode === 'orders' ? 'Busca e cancela todos os Orders abertos.' : 'Exclui todas as entitades vinculadas à origem selecionada.' },
                        ] as { id: Scope; icon: string; label: string; desc: string }[]).map(s => (
                            <div key={s.id}
                                onClick={() => { setScope(s.id); reset(); }}
                                style={{
                                    padding: '1rem 1.25rem', borderRadius: 10, cursor: 'pointer', transition: 'all 0.15s',
                                    border: `2px solid ${scope === s.id ? (s.id === 'all' ? 'var(--error)' : 'var(--accent)') : 'var(--card-border)'}`,
                                    backgroundColor: scope === s.id ? (s.id === 'all' ? 'rgba(239,68,68,0.07)' : 'rgba(99,102,241,0.07)') : 'transparent',
                                }}
                            >
                                <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: 3, color: (scope === s.id && s.id === 'all') ? 'var(--error)' : undefined }}>
                                    {s.icon} {s.label}
                                </div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--secondary)' }}>{s.desc}</div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* ── Lista de IDs ── */}
            {(!isAll || docMode === 'journal-entries') && (
                <div className="card" style={{ marginBottom: '1.25rem' }}>
                    <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
                        Números ({idLabel})
                    </h2>
                    <textarea className="input" rows={4} value={idsInput} onChange={e => setIdsInput(e.target.value)}
                        placeholder={`Cole os ${idLabel}s separados por vírgula, espaço ou nova linha.\nEx: 100, 101, 102`}
                        style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '0.9rem' }}
                    />
                    {parsedIds.length > 0 && (
                        <p style={{ fontSize: '0.8rem', color: 'var(--accent)', marginTop: '0.5rem' }}>
                            ✓ {parsedIds.length} número(s): {parsedIds.slice(0, 8).join(', ')}{parsedIds.length > 8 ? '...' : ''}
                        </p>
                    )}
                </div>
            )}

            {/* ── Opções ── */}
            <div className="card" style={{ marginBottom: '1.25rem' }}>
                <h2 style={{ fontSize: '1rem', marginBottom: '1rem' }}>Opções</h2>
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                        <input type="checkbox" checked={clearWriteback} onChange={e => setClearWriteback(e.target.checked)} />
                        {docMode !== 'orders' && docMode !== 'journal-entries'
                            ? <>Zerar referência de origem na tabela de Staging (permite reintegrar)</>
                            : <>Zerar <code>sap_jdt_num / sap_docentry</code> no Supabase após {docMode === 'orders' ? 'cancelamento' : 'exclusão'} (permite reintegrar depois)</>
                        }
                    </label>
                    {clearWriteback && (
                        <div style={{ marginLeft: '1.5rem' }}>
                            <label className="label" style={{ fontSize: '0.82rem' }}>Tabela de Origem ou Nome da Planilha</label>
                            {docMode !== 'orders' && docMode !== 'journal-entries' ? (
                                <select className="input" value={sourceTable} onChange={e => setSourceTable(e.target.value)} style={{ maxWidth: 280 }}>
                                    <option value="">Selecione a Tabela...</option>
                                    {excelTables.map((t: string) => (
                                        <option key={t} value={t}>{t}</option>
                                    ))}
                                </select>
                            ) : (
                                <select className="input" value={sourceTable} onChange={e => setSourceTable(e.target.value)} style={{ maxWidth: 280 }}>
                                    <option value="se1010">se1010 — Contas a Receber</option>
                                    <option value="se2010">se2010 — Contas a Pagar</option>
                                </select>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Confirmação padrão ── */}
            {!isAll && (
                <div style={{ padding: '1rem 1.25rem', borderRadius: 10, marginBottom: '1.25rem', backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                        <AlertTriangle size={20} style={{ color: 'var(--error)', flexShrink: 0, marginTop: 2 }} />
                        <div style={{ fontSize: '0.875rem', lineHeight: 1.6 }}>
                            <strong style={{ color: 'var(--error)' }}>Atenção: operação irreversível!</strong><br />
                            {docMode === 'orders' ? 'Os pedidos serão cancelados no SAP.' : 
                             docMode === 'chart-of-accounts' ? 'As contas serão excluídas permanentemente.' :
                             'Os lançamentos serão excluídos permanentemente.'}
                            {clearWriteback && <> A referência/ID na staging será zerada.</>}
                        </div>
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem', fontWeight: 600 }}>
                        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
                        Confirmo que desejo {actionLabel.toLowerCase()} {parsedIds.length || '?'} documento(s)
                    </label>
                </div>
            )}

            {/* ── Confirmação especial (cancelar todos) ── */}
            {isAll && (docMode !== 'journal-entries') && (
                <div style={{ padding: '1.25rem', borderRadius: 10, marginBottom: '1.25rem', backgroundColor: 'rgba(239,68,68,0.1)', border: '2px solid rgba(239,68,68,0.5)' }}>
                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', marginBottom: '1rem' }}>
                        <ShieldAlert size={24} style={{ color: 'var(--error)', flexShrink: 0, marginTop: 2 }} />
                        <div style={{ fontSize: '0.9rem', lineHeight: 1.7 }}>
                            <strong style={{ color: 'var(--error)', fontSize: '1rem' }}>⚠️ EXCLUSÃO / CANCELAMENTO TOTAL</strong><br />
                            {docMode === 'orders' 
                                ? <>Todos os Sales Orders com status <strong>aberto</strong> serão cancelados no SAP B1.<br/></>
                                : <>Todos os registros previamente integrados selecionados pela origem <strong>{sourceTable}</strong> serão apagados do SAP.<br/></>
                            }
                            {clearWriteback && <>As referências serão zeradas na tabela <strong>{sourceTable}</strong>.<br /></>}
                            <strong>Não é possível desfazer esta operação!</strong>
                        </div>
                    </div>
                    <label className="label" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                        Digite exatamente: <code style={{ color: 'var(--error)', fontWeight: 700 }}>CONFIRMAR</code>
                    </label>
                    <input className="input" value={confirmText} onChange={e => setConfirmText(e.target.value)}
                        placeholder="Digite CONFIRMAR para liberar"
                        style={{
                            maxWidth: 280, fontWeight: 700, letterSpacing: '0.06em',
                            borderColor: confirmText === 'CONFIRMAR' ? 'var(--error)' : undefined,
                            color: confirmText === 'CONFIRMAR' ? 'var(--error)' : undefined,
                        }}
                    />
                    {confirmText === 'CONFIRMAR' && (
                        <p style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--error)', fontWeight: 600 }}>
                            ✓ Confirmação aceita
                        </p>
                    )}
                </div>
            )}

            {/* ── Botão executar ── */}
            <button className="btn" disabled={!canRun} onClick={handleRun}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 240, justifyContent: 'center',
                    backgroundColor: canRun ? 'var(--error)' : undefined,
                    color: canRun ? '#fff' : undefined,
                    borderColor: canRun ? 'var(--error)' : undefined,
                    opacity: canRun ? 1 : 0.45, transition: 'all 0.2s',
                }}
            >
                {running ? <Loader2 size={18} className="animate-spin" /> : (docMode === 'orders' ? <Ban size={18} /> : <Trash2 size={18} />)}
                {running
                    ? `${actionLabel}ndo... aguarde`
                    : isAll
                        ? `💣 ${actionLabel} TOD${docMode === 'orders' ? 'OS os Orders abertos' : 'AS as contas da tabela'}`
                        : `${actionLabel} ${parsedIds.length || '?'} documento(s)`
                }
            </button>

            {/* ── Console de progresso em tempo real ── */}
            {(logs.length > 0 || running) && (
                <div className="card" style={{ marginTop: '1.5rem' }}>
                    {/* Header do console */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <Terminal size={16} style={{ color: 'var(--accent)' }} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--accent)' }}>Console de Progresso</span>
                        {running && (
                            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: 'var(--secondary)' }}>
                                <Loader2 size={12} className="animate-spin" /> Em execução...
                            </span>
                        )}
                    </div>

                    {/* Barra de progresso */}
                    {progress && progress.total > 0 && (
                        <div style={{ marginBottom: '0.75rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--secondary)', marginBottom: 4 }}>
                                <span>{actionLabel}ndo pedidos...</span>
                                <span>{progress.current} / {progress.total}</span>
                            </div>
                            <div style={{ height: 6, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                                <div style={{
                                    height: '100%', borderRadius: 99, transition: 'width 0.3s ease',
                                    width: `${Math.round((progress.current / progress.total) * 100)}%`,
                                    backgroundColor: 'var(--accent)',
                                }} />
                            </div>
                            <div style={{ textAlign: 'right', fontSize: '0.72rem', color: 'var(--secondary)', marginTop: 2 }}>
                                {Math.round((progress.current / progress.total) * 100)}%
                            </div>
                        </div>
                    )}

                    {/* Log lines */}
                    <div ref={logRef} style={{
                        maxHeight: 320, overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.78rem',
                        lineHeight: 1.7, backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8,
                        padding: '0.75rem 1rem',
                    }}>
                        {logs.map((l, i) => (
                            <div key={i} style={{
                                color: l.kind === 'ok' ? 'var(--success)'
                                    : l.kind === 'error' ? 'var(--error)'
                                        : l.kind === 'dim' ? 'var(--secondary)'
                                            : 'var(--text)',
                            }}>
                                <span style={{ opacity: 0.45, marginRight: '0.75rem', userSelect: 'none' }}>{l.time}</span>
                                {l.text}
                            </div>
                        ))}
                        {running && (
                            <div style={{ color: 'var(--accent)', marginTop: 4 }}>
                                <span style={{ opacity: 0.45, marginRight: '0.75rem' }}>{now()}</span>
                                <span className="animate-pulse">▌</span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Resumo final ── */}
            {summary && summary.type === 'done' && !running && (
                <div className="card" style={{ marginTop: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
                        {(summary.errors ?? 0) === 0
                            ? <><CheckCircle size={18} style={{ color: 'var(--success)' }} /><strong style={{ color: 'var(--success)' }}>Concluído com sucesso</strong></>
                            : <><XCircle size={18} style={{ color: 'var(--error)' }} /><strong style={{ color: 'var(--error)' }}>Concluído com erros</strong></>
                        }
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.75rem' }}>
                        {[
                            { label: 'Total', value: summary.total ?? 0, color: 'var(--text)' },
                            { label: docMode === 'orders' ? 'Cancelados' : 'Excluídos', value: summary.cancelled ?? 0, color: 'var(--success)' },
                            { label: 'Erros', value: summary.errors ?? 0, color: (summary.errors ?? 0) > 0 ? 'var(--error)' : 'var(--secondary)' },
                            { label: 'Write-back', value: summary.writebackCleared ?? 0, color: 'var(--accent)' },
                        ].map(({ label, value, color }) => (
                            <div key={label} style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
                                <div style={{ fontSize: '1.5rem', fontWeight: 700, color }}>{value}</div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--secondary)', marginTop: 2 }}>{label}</div>
                            </div>
                        ))}
                    </div>
                    <button onClick={reset}
                        style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                        <RotateCcw size={14} /> Nova operação
                    </button>
                </div>
            )}

            {/* ── Erro geral ── */}
            {apiError && !running && (
                <div style={{ marginTop: '1rem', padding: '0.75rem 1rem', borderRadius: 8, backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)' }}>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: apiError.toLowerCase().includes('login') ? 6 : 0 }}>
                        <XCircle size={16} style={{ color: 'var(--error)', flexShrink: 0 }} />
                        <span style={{ color: 'var(--error)', fontSize: '0.875rem' }}>{apiError}</span>
                    </div>
                    {(apiError.toLowerCase().includes('login') || apiError.toLowerCase().includes('sld')) && (
                        <p style={{ margin: '0 0 0 1.4rem', fontSize: '0.78rem', color: 'var(--secondary)' }}>
                            💡 Falha de autenticação no SAP. Verifique as credenciais em <strong>Configurações</strong>.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
