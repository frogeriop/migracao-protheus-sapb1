'use client';

import { useState, useMemo, useEffect } from 'react';
import { Loader2, Plus, RefreshCw, Trash2, ArrowRight, ArrowLeft, Eye, MapPin, Receipt, X } from 'lucide-react';
import { AgGridReact } from 'ag-grid-react';
import { ColDef, ModuleRegistry, AllCommunityModule, ICellRendererParams } from 'ag-grid-community';
import { BusinessPartner, BusinessPartnerPayload } from '@/types/sap';

// Register modules for AG Grid
ModuleRegistry.registerModules([AllCommunityModule]);

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

export default function SapBusinessPartnersPage() {
    const [partners, setPartners] = useState<BusinessPartner[]>([]);
    const [loading, setLoading] = useState(false);
    const [generatedColDefs, setGeneratedColDefs] = useState<ColDef[]>([]);

    // Pagination
    const [skip, setSkip] = useState(0);
    const [limit] = useState(20);

    // Create Modal
    const [showCreate, setShowCreate] = useState(false);
    const [newItem, setNewItem] = useState<Partial<BusinessPartnerPayload>>({
        CardCode: '',
        CardName: '',
        CardType: 'C',
        GroupCode: 100,
    });

    // Details Modal
    const [selectedPartner, setSelectedPartner] = useState<any | null>(null);
    const [activeTab, setActiveTab] = useState<'addresses' | 'fiscal'>('addresses');

    // Fetch Data
    const fetchPartners = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/sap/business-partners?limit=${limit}&offset=${skip}`);
            const json = await res.json();
            if (json.success) {
                const list = json.data.value || json.data || [];
                setPartners(list);

                if (list.length > 0) {
                    const first = list[0];
                    // Filter out complex array types from main grid
                    const keys = Object.keys(first).filter(k => k !== 'BPAddresses' && k !== 'BPFiscalTaxIDCollection');

                    const dynamicCols: ColDef[] = keys.map(key => ({
                        field: key,
                        headerName: key,
                        editable: key !== 'CardCode',
                        filter: true,
                        sortable: true,
                        flex: 1,
                        minWidth: 150,
                        valueFormatter: (params) => {
                            if (typeof params.value === 'object' && params.value !== null) {
                                return JSON.stringify(params.value); // Fallback for other objects
                            }
                            return params.value;
                        }
                    }));

                    // Add Actions Column
                    dynamicCols.push({
                        field: 'actions',
                        headerName: 'Ações',
                        width: 140,
                        pinned: 'right',
                        cellRenderer: (params: ICellRendererParams) => (
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button
                                    onClick={() => setSelectedPartner(params.data)}
                                    style={{ color: 'var(--primary)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                                    title="Ver Detalhes (Endereços/Fiscal)"
                                >
                                    <Eye size={18} />
                                </button>
                                <button
                                    onClick={() => handleDelete(params.data.CardCode)}
                                    style={{ color: 'var(--error)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                                    title="Excluir"
                                >
                                    <Trash2 size={18} />
                                </button>
                            </div>
                        )
                    });

                    setGeneratedColDefs(dynamicCols);
                }
            } else {
                alert('Erro ao buscar parceiros: ' + json.message);
            }
        } catch (error) {
            console.error(error);
            alert('Erro de conexão ao buscar parceiros.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPartners();
    }, [skip, limit]);

    // Inline Edit
    const onCellValueChanged = async (event: any) => {
        const { data, colDef, newValue, oldValue } = event;
        if (newValue === oldValue) return;

        try {
            const res = await fetch(`/api/sap/business-partners/${data.CardCode}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [colDef.field]: newValue })
            });
            const json = await res.json();
            if (!json.success) {
                alert('Erro ao atualizar: ' + json.message);
                event.node.setDataValue(colDef.field, oldValue);
            }
        } catch (error) {
            alert('Erro de conexão ao atualizar.');
            event.node.setDataValue(colDef.field, oldValue);
        }
    };

    // Delete
    const handleDelete = async (cardCode: string) => {
        if (!confirm(`Tem certeza que deseja excluir o parceiro ${cardCode}?`)) return;

        setLoading(true);
        try {
            const res = await fetch(`/api/sap/business-partners/${cardCode}`, {
                method: 'DELETE'
            });
            const json = await res.json();
            if (json.success) {
                alert('Parceiro removido com sucesso.');
                fetchPartners();
            } else {
                alert('Erro ao remover: ' + json.message);
            }
        } catch (error) {
            alert('Erro de conexão ao remover.');
        } finally {
            setLoading(false);
        }
    };

    // Create
    const handleCreate = async () => {
        if (!newItem.CardCode || !newItem.CardName) {
            alert('CardCode e CardName são obrigatórios.');
            return;
        }

        try {
            const res = await fetch('/api/sap/business-partners', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newItem)
            });
            const json = await res.json();
            if (json.success) {
                alert('Parceiro criado com sucesso!');
                setShowCreate(false);
                setNewItem({ CardCode: '', CardName: '', CardType: 'C', GroupCode: 100 });
                fetchPartners();
            } else {
                alert('Erro ao criar: ' + json.message);
            }
        } catch (error) {
            console.error(error);
            alert('Erro ao criar parceiro.');
        }
    };

    return (
        <div className="container" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h1 className="page-title">SAP Business Partners</h1>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn btn-secondary" onClick={fetchPartners} disabled={loading}>
                        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} style={{ marginRight: '0.5rem' }} /> Att
                    </button>
                    <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
                        <Plus size={16} style={{ marginRight: '0.5rem' }} /> Novo
                    </button>
                </div>
            </div>

            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
                <div className="ag-theme-quartz-dark" style={{ flex: 1, width: '100%' }}>
                    <AgGridReact
                        theme="legacy"
                        rowData={partners}
                        columnDefs={generatedColDefs.length > 0 ? generatedColDefs : []}
                        defaultColDef={{
                            sortable: true,
                            filter: true,
                            resizable: true
                        }}
                        onCellValueChanged={onCellValueChanged}
                        pagination={false}
                    />
                </div>
                <div style={{ padding: '0.5rem', borderTop: '1px solid var(--card-border)', display: 'flex', justifyContent: 'flex-end', gap: '1rem', alignItems: 'center' }}>
                    <button className="btn btn-secondary" disabled={skip <= 0} onClick={() => setSkip(Math.max(0, skip - limit))}>
                        <ArrowLeft size={16} /> Ant
                    </button>
                    <span>Offset: {skip} (Exibindo até {limit})</span>
                    <button className="btn btn-secondary" onClick={() => setSkip(skip + limit)}>
                        Prox <ArrowRight size={16} />
                    </button>
                </div>
            </div>

            {/* Create Modal */}
            {showCreate && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                    <div className="card" style={{ width: '400px' }}>
                        <h2 style={{ marginBottom: '1rem' }}>Novo Parceiro de Negócios</h2>
                        {/* Form inputs same as before */}
                        <div className="input-group">
                            <label className="label">CardCode (PK) *</label>
                            <input className="input" value={newItem.CardCode} onChange={e => setNewItem({ ...newItem, CardCode: e.target.value })} placeholder="Ex: CLI001" />
                        </div>
                        <div className="input-group">
                            <label className="label">CardName *</label>
                            <input className="input" value={newItem.CardName} onChange={e => setNewItem({ ...newItem, CardName: e.target.value })} placeholder="Nome do Cliente" />
                        </div>
                        <div className="input-group">
                            <label className="label">Tipo</label>
                            <select className="input" value={newItem.CardType} onChange={e => setNewItem({ ...newItem, CardType: e.target.value as any })}>
                                <option value="C">Cliente</option>
                                <option value="S">Fornecedor</option>
                                <option value="L">Lead</option>
                            </select>
                        </div>
                        <div className="input-group">
                            <label className="label">Group Code</label>
                            <input className="input" type="number" value={newItem.GroupCode} onChange={e => setNewItem({ ...newItem, GroupCode: Number(e.target.value) })} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
                            <button className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancelar</button>
                            <button className="btn btn-primary" onClick={handleCreate}>Criar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Details Modal */}
            {selectedPartner && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
                    <div className="card" style={{ width: '800px', height: '600px', display: 'flex', flexDirection: 'column', padding: 0 }}>
                        {/* Header */}
                        <div style={{ padding: '1rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <h2 style={{ fontSize: '1.25rem' }}>{selectedPartner.CardName}</h2>
                                <span style={{ color: 'var(--secondary)', fontSize: '0.9rem' }}>{selectedPartner.CardCode}</span>
                            </div>
                            <button onClick={() => setSelectedPartner(null)} style={{ color: 'var(--secondary)' }}><X size={24} /></button>
                        </div>

                        {/* Tabs */}
                        <div style={{ display: 'flex', borderBottom: '1px solid var(--card-border)' }}>
                            <button
                                onClick={() => setActiveTab('addresses')}
                                style={{
                                    flex: 1,
                                    padding: '1rem',
                                    background: activeTab === 'addresses' ? 'var(--card-bg)' : 'rgba(0,0,0,0.2)',
                                    borderBottom: activeTab === 'addresses' ? '2px solid var(--primary)' : 'none',
                                    fontWeight: activeTab === 'addresses' ? 600 : 400,
                                    display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem'
                                }}
                            >
                                <MapPin size={18} /> Endereços (BPAddresses)
                            </button>
                            <button
                                onClick={() => setActiveTab('fiscal')}
                                style={{
                                    flex: 1,
                                    padding: '1rem',
                                    background: activeTab === 'fiscal' ? 'var(--card-bg)' : 'rgba(0,0,0,0.2)',
                                    borderBottom: activeTab === 'fiscal' ? '2px solid var(--primary)' : 'none',
                                    fontWeight: activeTab === 'fiscal' ? 600 : 400,
                                    display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem'
                                }}
                            >
                                <Receipt size={18} /> Fiscal (BPFiscalTaxIDCollection)
                            </button>
                        </div>

                        {/* Content */}
                        <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
                            {activeTab === 'addresses' && (
                                <div>
                                    {selectedPartner.BPAddresses && selectedPartner.BPAddresses.length > 0 ? (
                                        <div style={{ display: 'grid', gap: '1rem' }}>
                                            {selectedPartner.BPAddresses.map((addr: any, i: number) => (
                                                <div key={i} style={{ border: '1px solid var(--card-border)', padding: '1rem', borderRadius: '8px', background: 'var(--background)' }}>
                                                    <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent)' }}>{addr.AddressName} ({addr.AddressType})</div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Rua:</span> {addr.Street}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Número:</span> {addr.StreetNo}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Bairro:</span> {addr.Block}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>CEP:</span> {addr.ZipCode}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Cidade:</span> {addr.City}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Estado:</span> {addr.State}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>País:</span> {addr.Country}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p style={{ textAlign: 'center', color: 'var(--secondary)', padding: '2rem' }}>Nenhum endereço cadastrado.</p>
                                    )}
                                </div>
                            )}

                            {activeTab === 'fiscal' && (
                                <div>
                                    {selectedPartner.BPFiscalTaxIDCollection && selectedPartner.BPFiscalTaxIDCollection.length > 0 ? (
                                        <div style={{ display: 'grid', gap: '1rem' }}>
                                            {selectedPartner.BPFiscalTaxIDCollection.map((tax: any, i: number) => (
                                                <div key={i} style={{ border: '1px solid var(--card-border)', padding: '1rem', borderRadius: '8px', background: 'var(--background)' }}>
                                                    <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--accent)' }}>{tax.Address}</div>
                                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.9rem' }}>
                                                        <div><span style={{ color: 'var(--secondary)' }}>CNPJ/CPF:</span> {tax.TaxId0 || tax.TaxId4}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Inscrição Estadual:</span> {tax.TaxId1}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>Inscrição Municipal:</span> {tax.TaxId2}</div>
                                                        <div><span style={{ color: 'var(--secondary)' }}>CNAE:</span> {tax.CNAECode}</div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <p style={{ textAlign: 'center', color: 'var(--secondary)', padding: '2rem' }}>Nenhum dado fiscal encontrado.</p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
