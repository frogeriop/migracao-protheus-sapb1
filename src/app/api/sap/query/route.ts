import { NextResponse } from 'next/server';
import { sapService } from '@/services/sapService';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const entity = searchParams.get('entity');
        const limit = searchParams.get('limit') || '50';
        const skip = searchParams.get('skip') || '0';

        if (!entity) {
            return NextResponse.json({ success: false, message: 'Entity parameter is required' }, { status: 400 });
        }

        // Safe query building
        let query = `$top=${limit}&$skip=${skip}`;
        
        const data = await (sapService as any).request('GET', `/${entity}?${query}`);
        
        return NextResponse.json({ 
            success: true, 
            data: data.value || [],
            meta: {
                total: undefined, // OData might not return inlinecount by default unless $inlinecount=allpages
                totalPages: 1
            }
        });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
