export interface MigrationLog {
    id: string;
    table: string;
    sourceIds?: any;
    targetId?: string;
    action: 'insert' | 'update';
    status: 'pending' | 'success' | 'error';
    message?: string;
    payload: any;
    createdAt: string;
}

export interface PreviewRecord {
    source: any;
    target: any;
    existsInSap: boolean;
    action: 'insert' | 'update';
}
