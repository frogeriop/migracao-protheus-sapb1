'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import * as XLSX from 'xlsx';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle, Database, Trash2, Loader2, Save, RefreshCw, Briefcase, Map, ArrowLeft } from 'lucide-react';
import { AgGridModal } from '@/components/ui/AgGridModal';
import { ColDef } from 'ag-grid-community';
import styles from './page.module.css';

interface IbgeMunicipio {
    codigo_ibge: string;
    nome_municipio: string;
    uf: string;
    nome_uf?: string;
    regiao_geografica_intermediaria?: string;
    nome_regiao_geografica_intermediaria?: string;
    regiao_geografica_imediata?: string;
    nome_regiao_geografica_imediata?: string;
    municipio?: string;
    codigo_municipio_completo?: string;
}

interface SapCnae {
    id: string; // AbsId
    code: string; // CNAECode
    description: string; // Descrip
}

type Tab = 'ibge' | 'cnae';

export default function AuxiliaryPage() {
    const [activeTab, setActiveTab] = useState<Tab>('ibge');

    // Modal State
    const [modalOpen, setModalOpen] = useState(false);
    const [modalType, setModalType] = useState<'ibge' | 'cnae'>('ibge');

    // IBGE State
    const [file, setFile] = useState<File | null>(null);
    const [previewData, setPreviewData] = useState<IbgeMunicipio[]>([]);
    const [loading, setLoading] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [ibgeCount, setIbgeCount] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const parsedDataRef = useRef<IbgeMunicipio[]>([]);

    // CNAE State
    const [cnaeCount, setCnaeCount] = useState<number | null>(null);
    const [cnaeFile, setCnaeFile] = useState<File | null>(null);
    const [previewCnaeData, setPreviewCnaeData] = useState<SapCnae[]>([]);
    const cnaeFileInputRef = useRef<HTMLInputElement>(null);
    const parsedCnaeDataRef = useRef<SapCnae[]>([]);

    useEffect(() => {
        fetchCounts();
        return () => {
            parsedDataRef.current = [];
            parsedCnaeDataRef.current = [];
        };
    }, []);

    const fetchCounts = async () => {
        fetchIbgeCount();
        fetchCnaeCount();
    };

    const fetchIbgeCount = async () => {
        try {
            const { count, error } = await supabase
                .from('ibge_municipios')
                .select('*', { count: 'exact', head: true });

            if (!error) setIbgeCount(count);
        } catch (error) {
            console.error('Error fetching IBGE count:', error);
        }
    };

    const fetchCnaeCount = async () => {
        try {
            const { count, error } = await supabase
                .from('sap_cnaes')
                .select('*', { count: 'exact', head: true });

            if (!error) setCnaeCount(count);
        } catch (error) {
            console.error('Error fetching CNAE count:', error);
        }
    };

    // --- IBGE LOGIC ---

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            parseFile(selectedFile);
        }
    };

    const parseFile = async (file: File) => {
        setLoading(true);
        setMessage(null);
        setPreviewData([]);

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

            if (jsonData.length < 2) throw new Error('Arquivo vazio ou formato inválido');

            // Find header row by looking for key columns
            const headerRowIndex = jsonData.findIndex((row: any[]) =>
                row.some((cell: any) =>
                    typeof cell === 'string' &&
                    (cell.toLowerCase().includes('código') || cell.toLowerCase().includes('codigo') || cell.toLowerCase().includes('município'))
                )
            );

            if (headerRowIndex === -1) throw new Error('Não foi possível identificar o cabeçalho. Certifique-se que o arquivo tenha colunas como "Código", "Nome" e "UF".');

            const headers = (jsonData[headerRowIndex] as any[]).map((h: any) => String(h).trim().toLowerCase());
            const rows = jsonData.slice(headerRowIndex + 1);

            // Helper to find column index with exact match priority
            const findCol = (exact: string[], partial: string[] = []) => {
                let idx = headers.findIndex(h => exact.some(e => h === e));
                if (idx === -1 && partial.length > 0) {
                    idx = headers.findIndex(h => partial.some(p => h.includes(p)));
                }
                return idx;
            };

            const ufIndex = findCol(['uf'], ['sigla']);
            const nomeUfIndex = findCol(['nome_uf', 'nome uf']);
            const regiaoIntermediariaIndex = findCol(['região geográfica intermediária', 'regiao geografica intermediaria']);
            const nomeRegiaoIntermediariaIndex = findCol(['nome região geográfica intermediária', 'nome regiao geografica intermediaria']);
            const regiaoImediataIndex = findCol(['região geográfica imediata', 'regiao geografica imediata']);
            const nomeRegiaoImediataIndex = findCol(['nome região geográfica imediata', 'nome regiao geografica imediata']);
            const municipioIndex = findCol(['município', 'municipio']);
            const codigoMunicipioCompletoIndex = findCol(['código município completo', 'codigo municipio completo'], ['código', 'codigo']);
            const nameIndex = findCol(['nome_município', 'nome_municipio'], ['nome']);

            if (codigoMunicipioCompletoIndex === -1) throw new Error('Coluna "Código Município Completo" não encontrada.');

            // Prefer Nome_Município > Município for the name
            const finalNameIndex = nameIndex !== -1 ? nameIndex : municipioIndex;

            if (finalNameIndex === -1) throw new Error('Coluna "Nome_Município" ou "Município" não encontrada.');

            const mappedData: IbgeMunicipio[] = rows.map((row: any) => {
                const codeRaw = row[codigoMunicipioCompletoIndex];
                if (!codeRaw) return null;

                let code = String(codeRaw).replace(/\D/g, '');
                // Usually 7 digits for full code
                if (code.length > 7) code = code.substring(0, 7);
                if (code.length < 6) return null; // Minimum 6 digits for valid IBGE code

                let uf = '';
                if (ufIndex !== -1 && row[ufIndex]) {
                    uf = String(row[ufIndex]).trim().toUpperCase();
                    if (uf.length > 2) uf = uf.substring(0, 2);
                }

                return {
                    codigo_ibge: code,
                    nome_municipio: String(row[finalNameIndex]).trim(),
                    uf: uf,
                    nome_uf: nomeUfIndex !== -1 ? String(row[nomeUfIndex]).trim() : undefined,
                    regiao_geografica_intermediaria: regiaoIntermediariaIndex !== -1 ? String(row[regiaoIntermediariaIndex]).trim() : undefined,
                    nome_regiao_geografica_intermediaria: nomeRegiaoIntermediariaIndex !== -1 ? String(row[nomeRegiaoIntermediariaIndex]).trim() : undefined,
                    regiao_geografica_imediata: regiaoImediataIndex !== -1 ? String(row[regiaoImediataIndex]).trim() : undefined,
                    nome_regiao_geografica_imediata: nomeRegiaoImediataIndex !== -1 ? String(row[nomeRegiaoImediataIndex]).trim() : undefined,
                    municipio: municipioIndex !== -1 ? String(row[municipioIndex]).trim() : undefined,
                    codigo_municipio_completo: codigoMunicipioCompletoIndex !== -1 ? String(row[codigoMunicipioCompletoIndex]).trim() : undefined,
                } as IbgeMunicipio;
            }).filter((item): item is IbgeMunicipio => item !== null);

            parsedDataRef.current = mappedData;
            setPreviewData(mappedData.slice(0, 10));
            setFile(file);
            setMessage({ type: 'success', text: `${mappedData.length} registros identificados com sucesso.` });

        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Erro ao ler o arquivo.' });
            setPreviewData([]);
            parsedDataRef.current = [];
        } finally {
            setLoading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleUploadIbge = async () => {
        const dataToUpload = parsedDataRef.current;
        if (!dataToUpload || dataToUpload.length === 0) return;

        setUploading(true);
        setMessage(null);

        try {
            // Clear existing data before import as requested
            const { error: deleteError } = await supabase.from('ibge_municipios').delete().neq('codigo_ibge', '0000000');
            if (deleteError) throw deleteError;

            const batchSize = 1000;
            for (let i = 0; i < dataToUpload.length; i += batchSize) {
                const batch = dataToUpload.slice(i, i + batchSize);
                const { error } = await supabase
                    .from('ibge_municipios')
                    .insert(batch);

                if (error) throw error;
            }

            setMessage({ type: 'success', text: 'Importação concluída com sucesso!' });
            setFile(null);
            setPreviewData([]);
            parsedDataRef.current = [];
            fetchIbgeCount();
        } catch (error: any) {
            setMessage({ type: 'error', text: 'Erro ao salvar no banco de dados: ' + error.message });
        } finally {
            setUploading(false);
        }
    };

    const handleClearIbge = async () => {
        if (!confirm('Tem certeza que deseja apagar TODOS os registros da tabela de municípios?')) return;

        setUploading(true);
        try {
            const { error } = await supabase.from('ibge_municipios').delete().neq('codigo_ibge', '0000000');
            if (error) throw error;
            setMessage({ type: 'success', text: 'Tabela limpa com sucesso.' });
            fetchIbgeCount();
        } catch (error: any) {
            setMessage({ type: 'error', text: 'Erro ao limpar tabela: ' + error.message });
        } finally {
            setUploading(false);
        }
    };

    // --- CNAE LOGIC ---

    const handleFileChangeCnae = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = e.target.files?.[0];
        if (selectedFile) {
            parseFileCnae(selectedFile);
        }
    };

    const parseFileCnae = async (file: File) => {
        setLoading(true);
        setMessage(null);
        setPreviewCnaeData([]);
        parsedCnaeDataRef.current = [];

        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

            if (jsonData.length < 2) throw new Error('Arquivo vazio ou formato inválido');

            // Find header row
            const headerRowIndex = jsonData.findIndex((row: any[]) =>
                row.some((cell: any) =>
                    typeof cell === 'string' &&
                    (cell.toLowerCase().includes('cnae') || cell.toLowerCase().includes('descrição') || cell.toLowerCase().includes('descricao'))
                )
            );

            if (headerRowIndex === -1) throw new Error('Cabeçalho não encontrado. O arquivo deve ter colunas como "CNAE" e "Descrição".');

            const headers = (jsonData[headerRowIndex] as any[]).map((h: any) => String(h).trim().toLowerCase());
            const rows = jsonData.slice(headerRowIndex + 1);

            const findCol = (exact: string[], partial: string[] = []) => {
                let idx = headers.findIndex(h => exact.some(e => h === e));
                if (idx === -1 && partial.length > 0) {
                    idx = headers.findIndex(h => partial.some(p => h.includes(p)));
                }
                return idx;
            };

            const codeIndex = findCol(['cnae', 'código', 'codigo'], ['cnae']);
            const descIndex = findCol(['descrição', 'descricao', 'descrip'], ['desc']);
            const idIndex = findCol(['absid', 'id'], ['id']);

            if (codeIndex === -1) throw new Error('Coluna "CNAE" não encontrada.');
            if (descIndex === -1) throw new Error('Coluna "Descrição" não encontrada.');

            const mappedData: SapCnae[] = rows.map((row: any, idx) => {
                const codeRaw = row[codeIndex];
                if (!codeRaw) return null;

                const code = String(codeRaw).trim();
                const desc = row[descIndex] ? String(row[descIndex]).trim() : '';
                const id = idIndex !== -1 && row[idIndex] ? String(row[idIndex]) : String(idx + 1);

                return {
                    id: id,
                    code: code,
                    description: desc
                } as SapCnae;
            }).filter((item): item is SapCnae => item !== null);

            parsedCnaeDataRef.current = mappedData;
            setPreviewCnaeData(mappedData.slice(0, 10));
            setCnaeFile(file);
            setMessage({ type: 'success', text: `${mappedData.length} registros identificados com sucesso.` });

        } catch (error: any) {
            setMessage({ type: 'error', text: error.message || 'Erro ao ler o arquivo.' });
            setPreviewCnaeData([]);
            parsedCnaeDataRef.current = [];
        } finally {
            setLoading(false);
            if (cnaeFileInputRef.current) cnaeFileInputRef.current.value = '';
        }
    };

    const handleUploadCnae = async () => {
        const dataToUpload = parsedCnaeDataRef.current;
        if (!dataToUpload || dataToUpload.length === 0) return;

        setUploading(true);
        setMessage(null);

        try {
            const { error: deleteError } = await supabase.from('sap_cnaes').delete().neq('code', '0000000');
            if (deleteError) throw deleteError;

            const batchSize = 1000;
            for (let i = 0; i < dataToUpload.length; i += batchSize) {
                const batch = dataToUpload.slice(i, i + batchSize).map(item => ({
                    id: item.id,
                    code: item.code,
                    description: item.description
                }));

                const { error } = await supabase
                    .from('sap_cnaes')
                    .insert(batch);

                if (error) throw error;
            }

            setMessage({ type: 'success', text: 'Importação de CNAEs concluída com sucesso!' });
            setCnaeFile(null);
            setPreviewCnaeData([]);
            parsedCnaeDataRef.current = [];
            fetchCnaeCount();
        } catch (error: any) {
            setMessage({ type: 'error', text: 'Erro ao salvar CNAEs: ' + error.message });
        } finally {
            setUploading(false);
        }
    };

    const handleClearCnae = async () => {
        if (!confirm('Tem certeza que deseja apagar TODOS os registros da tabela de CNAEs?')) return;

        setUploading(true);
        try {
            const { error } = await supabase.from('sap_cnaes').delete().neq('code', '0000000');
            if (error) throw error;
            setMessage({ type: 'success', text: 'Tabela de CNAEs limpa com sucesso.' });
            fetchCnaeCount();
        } catch (error: any) {
            setMessage({ type: 'error', text: 'Erro ao limpar tabela: ' + error.message });
        } finally {
            setUploading(false);
        }
    };

    const handleOpenModal = (type: 'ibge' | 'cnae') => {
        setModalType(type);
        setModalOpen(true);
    };

    const fetchAllData = async () => {
        let allData: any[] = [];
        let from = 0;
        const step = 1000;
        const table = modalType === 'ibge' ? 'ibge_municipios' : 'sap_cnaes';

        while (true) {
            const { data, error } = await supabase
                .from(table)
                .select('*')
                .range(from, from + step - 1);

            if (error) throw error;
            if (!data || data.length === 0) break;

            allData = [...allData, ...data];

            if (data.length < step) break; // Reached end
            from += step;
        }

        return allData;
    };

    const getColumnDefs = (): ColDef[] => {
        if (modalType === 'ibge') {
            return [
                { field: 'uf', headerName: 'UF', sortable: true, filter: true, width: 80 },
                { field: 'nome_uf', headerName: 'Nome UF', sortable: true, filter: true, width: 150 },
                { field: 'regiao_geografica_intermediaria', headerName: 'Região Geográfica Intermediária', sortable: true, filter: true, width: 200 },
                { field: 'nome_regiao_geografica_intermediaria', headerName: 'Nome Região Geográfica Intermediária', sortable: true, filter: true, width: 250 },
                { field: 'regiao_geografica_imediata', headerName: 'Região Geográfica Imediata', sortable: true, filter: true, width: 200 },
                { field: 'nome_regiao_geografica_imediata', headerName: 'Nome Região Geográfica Imediata', sortable: true, filter: true, width: 250 },
                { field: 'municipio', headerName: 'Município', sortable: true, filter: true, width: 150 },
                { field: 'codigo_municipio_completo', headerName: 'Código Município Completo', sortable: true, filter: true, width: 200 },
                { field: 'nome_municipio', headerName: 'Nome Município', sortable: true, filter: true, width: 200 },
            ];
        } else {
            return [
                { field: 'code', headerName: 'Código CNAE', sortable: true, filter: true, flex: 1 },
                { field: 'description', headerName: 'Descrição', sortable: true, filter: true, flex: 3 },
                { field: 'id', headerName: 'ID Interno', sortable: true, filter: true, flex: 0.5 },
            ];
        }
    };

    return (
        <div className={styles.container}>
            <div style={{ marginBottom: '1.5rem' }}>
                <Link href="/settings" style={{ display: 'flex', alignItems: 'center', color: 'var(--secondary)', textDecoration: 'none', fontSize: '0.9rem' }}>
                    <ArrowLeft size={16} style={{ marginRight: '0.5rem' }} /> Voltar para Configurações
                </Link>
            </div>
            <div className={styles.header}>
                <h1 className={styles.title}>Tabelas Auxiliares</h1>
                <p className={styles.subtitle}>
                    Gerencie tabelas de apoio para a migração (Municípios IBGE e CNAEs SAP).
                </p>
            </div>

            <div className={styles.grid}>
                <div
                    className={styles.metricCard}
                    onDoubleClick={() => handleOpenModal('ibge')}
                    style={{ cursor: 'pointer', transition: 'transform 0.2s', userSelect: 'none' }}
                    title="Clique duplo para ver todos os registros"
                >
                    <div style={{ backgroundColor: 'rgba(59, 130, 246, 0.1)', padding: '1rem', borderRadius: '50%', color: 'var(--primary)' }}>
                        <Map size={24} />
                    </div>
                    <div>
                        <div className={styles.metricValue}>{ibgeCount !== null ? ibgeCount.toLocaleString('pt-BR') : '-'}</div>
                        <div className={styles.metricLabel}>Municípios (IBGE)</div>
                    </div>
                </div>

                <div
                    className={styles.metricCard}
                    onDoubleClick={() => handleOpenModal('cnae')}
                    style={{ cursor: 'pointer', transition: 'transform 0.2s', userSelect: 'none' }}
                    title="Clique duplo para ver todos os registros"
                >
                    <div style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', padding: '1rem', borderRadius: '50%', color: 'var(--success)' }}>
                        <Briefcase size={24} />
                    </div>
                    <div>
                        <div className={styles.metricValue}>{cnaeCount !== null ? cnaeCount.toLocaleString('pt-BR') : '-'}</div>
                        <div className={styles.metricLabel}>CNAEs (SAP)</div>
                    </div>
                </div>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--card-border)' }}>
                <button
                    onClick={() => { setActiveTab('ibge'); setMessage(null); }}
                    style={{
                        padding: '1rem 1.5rem',
                        background: 'none',
                        border: 'none',
                        borderBottom: activeTab === 'ibge' ? '2px solid var(--primary)' : '2px solid transparent',
                        color: activeTab === 'ibge' ? 'var(--primary)' : 'var(--secondary)',
                        fontWeight: activeTab === 'ibge' ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                    }}
                >
                    IBGE Municípios
                </button>
                <button
                    onClick={() => { setActiveTab('cnae'); setMessage(null); }}
                    style={{
                        padding: '1rem 1.5rem',
                        background: 'none',
                        border: 'none',
                        borderBottom: activeTab === 'cnae' ? '2px solid var(--success)' : '2px solid transparent',
                        color: activeTab === 'cnae' ? 'var(--success)' : 'var(--secondary)',
                        fontWeight: activeTab === 'cnae' ? 600 : 400,
                        cursor: 'pointer',
                        transition: 'all 0.2s'
                    }}
                >
                    CNAEs (SAP)
                </button>
            </div>

            <div className={styles.card}>
                {message && (
                    <div style={{
                        marginBottom: '1.5rem',
                        padding: '1rem',
                        borderRadius: '8px',
                        backgroundColor: message.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        color: message.type === 'success' ? 'var(--success)' : 'var(--error)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem'
                    }}>
                        {message.type === 'success' ? <CheckCircle size={20} /> : <AlertCircle size={20} />}
                        {message.text}
                    </div>
                )}

                {activeTab === 'ibge' && (
                    <div className="animate-fade-in">
                        <div style={{ marginBottom: '2rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>Importar via Excel</h3>
                            <p style={{ color: 'var(--secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                                Utilize um arquivo contendo as colunas <strong>Código</strong>, <strong>Nome</strong> e <strong>UF</strong>.
                            </p>

                            <div
                                className={styles.dropzone}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept=".xlsx, .xls, .csv"
                                    style={{ display: 'none' }}
                                />
                                <div className={styles.dropzoneIcon}>
                                    <FileSpreadsheet size={48} className={styles.dropzoneIcon} />
                                </div>
                                <div className={styles.dropzoneText}>
                                    {file ? file.name : 'Clique para selecionar o arquivo XLS/XLSX'}
                                </div>
                                <div className={styles.dropzoneSubtext}>
                                    Arraste ou clique para upload
                                </div>
                            </div>
                        </div>

                        {loading && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '2rem 0', gap: '0.5rem', color: 'var(--secondary)' }}>
                                <Loader2 className="animate-spin" size={20} /> Processando arquivo...
                            </div>
                        )}

                        {previewData.length > 0 && (
                            <div style={{ marginBottom: '2rem' }}>
                                <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Pré-visualização (10 primeiros)</h3>
                                <div style={{ overflowX: 'auto' }}>
                                    <table className={styles.previewTable}>
                                        <thead>
                                            <tr>
                                                <th>Código IBGE</th>
                                                <th>Município</th>
                                                <th>UF</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {previewData.map((row) => (
                                                <tr key={row.codigo_ibge}>
                                                    <td>{row.codigo_ibge}</td>
                                                    <td>{row.nome_municipio}</td>
                                                    <td>{row.uf}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <div className={styles.actions}>
                                    <button
                                        className={`${styles.button} ${styles.buttonSecondary}`}
                                        onClick={() => {
                                            setFile(null);
                                            setPreviewData([]);
                                            setMessage(null);
                                        }}
                                        disabled={uploading}
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        className={`${styles.button} ${styles.buttonPrimary}`}
                                        onClick={handleUploadIbge}
                                        disabled={uploading}
                                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                                    >
                                        {uploading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                                        Importar Dados
                                    </button>
                                </div>
                            </div>
                        )}

                        <div style={{ marginTop: '2rem', borderTop: '1px solid var(--card-border)', paddingTop: '2rem' }}>
                            <button
                                onClick={handleClearIbge}
                                className={styles.button}
                                style={{ backgroundColor: 'transparent', border: '1px solid var(--error)', color: 'var(--error)', display: 'flex', alignItems: 'center', gap: '0.5rem', paddingLeft: 0 }}
                                disabled={uploading}
                            >
                                <Trash2 size={16} />
                                Esvaziar Tabela de Municípios
                            </button>
                        </div>
                    </div>
                )}

                {activeTab === 'cnae' && (
                    <div className="animate-fade-in">
                        <div style={{ marginBottom: '2rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>Importar CNAEs via Excel</h3>
                            <p style={{ color: 'var(--secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                                Utilize um arquivo contendo as colunas <strong>CNAE</strong> e <strong>Descrição</strong>.
                            </p>

                            <div
                                className={styles.dropzone}
                                onClick={() => cnaeFileInputRef.current?.click()}
                            >
                                <input
                                    type="file"
                                    ref={cnaeFileInputRef}
                                    onChange={handleFileChangeCnae}
                                    accept=".xlsx, .xls, .csv"
                                    style={{ display: 'none' }}
                                />
                                <div className={styles.dropzoneIcon}>
                                    <FileSpreadsheet size={48} className={styles.dropzoneIcon} />
                                </div>
                                <div className={styles.dropzoneText}>
                                    {cnaeFile ? cnaeFile.name : 'Clique para selecionar o arquivo CNAE (XLS/XLSX)'}
                                </div>
                                <div className={styles.dropzoneSubtext}>
                                    Arraste ou clique para upload
                                </div>
                            </div>
                        </div>

                        {loading && (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '2rem 0', gap: '0.5rem', color: 'var(--secondary)' }}>
                                <Loader2 className="animate-spin" size={20} /> Processando arquivo...
                            </div>
                        )}

                        {previewCnaeData.length > 0 && (
                            <div style={{ marginBottom: '2rem' }}>
                                <h3 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '1rem' }}>Pré-visualização (10 primeiros)</h3>
                                <div style={{ overflowX: 'auto' }}>
                                    <table className={styles.previewTable}>
                                        <thead>
                                            <tr>
                                                <th>Código</th>
                                                <th>Descrição</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {previewCnaeData.map((row, idx) => (
                                                <tr key={idx}>
                                                    <td>{row.code}</td>
                                                    <td>{row.description}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <div className={styles.actions}>
                                    <button
                                        className={`${styles.button} ${styles.buttonSecondary}`}
                                        onClick={() => {
                                            setCnaeFile(null);
                                            setPreviewCnaeData([]);
                                            setMessage(null);
                                            parsedCnaeDataRef.current = [];
                                        }}
                                        disabled={uploading}
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        className={`${styles.button} ${styles.buttonPrimary}`}
                                        onClick={handleUploadCnae}
                                        disabled={uploading}
                                        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}
                                    >
                                        {uploading ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
                                        Importar CNAEs
                                    </button>
                                </div>
                            </div>
                        )}

                        <div style={{ marginTop: '2rem', borderTop: '1px solid var(--card-border)', paddingTop: '2rem' }}>
                            <button
                                onClick={handleClearCnae}
                                className={styles.button}
                                style={{ backgroundColor: 'transparent', border: '1px solid var(--error)', color: 'var(--error)', display: 'flex', alignItems: 'center', gap: '0.5rem', paddingLeft: 0 }}
                                disabled={uploading}
                            >
                                <Trash2 size={16} />
                                Esvaziar Tabela de CNAEs
                            </button>
                        </div>

                        <div style={{ marginTop: '2rem', padding: '1.5rem', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                            <h4 style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--secondary)' }}>Informações Técnicas</h4>
                            <ul style={{ listStyle: 'none', fontSize: '0.85rem', color: 'var(--secondary)' }}>
                                <li style={{ marginBottom: '0.25rem' }}>• Tabela Destino: <code>public.sap_cnaes</code></li>
                                <li style={{ marginBottom: '0.25rem' }}>• Origem Importação: <code>Arquivo Excel (.xls, .xlsx, .csv)</code></li>
                                <li>• Colunas Esperadas: CNAE, Descrição</li>
                            </ul>
                        </div>
                    </div>
                )}
            </div>

            <AgGridModal
                isOpen={modalOpen}
                onClose={() => setModalOpen(false)}
                title={modalType === 'ibge' ? 'Dados: IBGE Municípios' : 'Dados: CNAEs SAP'}
                columnDefs={getColumnDefs()}
                fetchData={fetchAllData}
            />
        </div >
    );
}
