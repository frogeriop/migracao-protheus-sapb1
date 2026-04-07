import { NextRequest, NextResponse } from 'next/server';
import { sapService } from '@/services/sapService';

type RouteCtx = { params: Promise<{ id: string }> };

// GET: Single Business Partner
export async function GET(_request: NextRequest, context: RouteCtx) {
    try {
        const { id } = await context.params;
        const data = await sapService.getBusinessPartner(id);
        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 404 });
    }
}

// PATCH: Update Business Partner
export async function PATCH(request: NextRequest, context: RouteCtx) {
    try {
        const { id } = await context.params;
        const body = await request.json();
        const data = await sapService.updateBusinessPartner(id, body);
        return NextResponse.json({ success: true, data });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}

// DELETE: Remove Business Partner
export async function DELETE(request: NextRequest, context: RouteCtx) {
    try {
        const { id } = await context.params;
        await sapService.deleteBusinessPartner(id);
        return NextResponse.json({ success: true, message: 'Parceiro de Negócios removido.' });
    } catch (error: any) {
        return NextResponse.json({ success: false, message: error.message }, { status: 500 });
    }
}
