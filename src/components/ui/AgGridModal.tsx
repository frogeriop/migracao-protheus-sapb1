'use client';

import { useEffect, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ColDef, ModuleRegistry, Theme } from 'ag-grid-community';
import { X, Loader2 } from 'lucide-react';


// Register all community modules
ModuleRegistry.registerModules([AllCommunityModule]);

interface AgGridModalProps {
    title: string;
    isOpen: boolean;
    onClose: () => void;
    columnDefs: ColDef[];
    fetchData: () => Promise<any[]>; // Fetch function to load all data
}

export function AgGridModal({ title, isOpen, onClose, columnDefs, fetchData }: AgGridModalProps) {
    const [rowData, setRowData] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (isOpen) {
            handleFetch();
        }
    }, [isOpen]);

    const handleFetch = async () => {
        setLoading(true);
        try {
            const data = await fetchData();
            setRowData(data);
        } catch (error) {
            console.error('Error fetching grid data:', error);
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    // Use a portal or fixed overlay
    return (
        <div style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            zIndex: 1000,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '2rem'
        }}>
            <div style={{
                backgroundColor: 'var(--card-bg)', // Assuming dark theme variable exists, or fallback
                width: '100%',
                maxWidth: '1200px',
                height: '80vh',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
                position: 'relative',
                overflow: 'hidden',
                border: '1px solid var(--card-border)'
            }}>
                {/* Header */}
                <div style={{
                    padding: '1.5rem',
                    borderBottom: '1px solid var(--card-border)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    backgroundColor: 'rgba(255, 255, 255, 0.02)'
                }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--foreground)' }}>
                        {title}
                        <span style={{ marginLeft: '1rem', fontSize: '0.875rem', color: 'var(--secondary)', fontWeight: 400 }}>
                            {rowData.length > 0 ? `${rowData.length} registros` : ''}
                        </span>
                    </h2>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            color: 'var(--secondary)',
                            padding: '0.5rem',
                            borderRadius: '50%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'background-color 0.2s'
                        }}
                    >
                        <X size={24} />
                    </button>
                </div>

                {/* Content */}
                <div style={{ flex: 1, position: 'relative' }}>
                    {loading ? (
                        <div style={{
                            position: 'absolute',
                            top: 0, left: 0, right: 0, bottom: 0,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '1rem',
                            color: 'var(--secondary)'
                        }}>
                            <Loader2 className="animate-spin" size={32} />
                            <span>Carregando dados...</span>
                        </div>
                    ) : (
                        <div className="ag-theme-alpine-dark" style={{ height: '100%', width: '100%' }}>
                            <AgGridReact
                                rowData={rowData}
                                columnDefs={columnDefs}
                                defaultColDef={{
                                    flex: 1,
                                    resizable: true,
                                    sortable: true,
                                    filter: true
                                }}
                                pagination={true}
                                paginationPageSize={100}
                                paginationPageSizeSelector={[100, 200, 500]}
                            />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
