import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { adminFetch } from '../../services/escrowApi';

// Admin review queue + role management (Stage 1, trust foundation).
// The server enforces admin-only access; a 403 here only changes the message.
// Stage 2 hardening: documents live in the PRIVATE verification-docs
// bucket, so there is no public URL to build — the admin fetches a
// 5-minute signed URL on demand (GET /verifications/:id/document).
const PAGE_SIZE = 20;

const isForbidden = (err) =>
    err?.message?.includes('do not have permission');

const VerificationQueue = () => {
    const [status, setStatus] = useState('pending');
    const [page, setPage] = useState(1);
    const [rows, setRows] = useState([]);
    const [pagination, setPagination] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [forbidden, setForbidden] = useState(false);
    const [rejectingId, setRejectingId] = useState(null);
    const [rejectNote, setRejectNote] = useState('');
    const [actionBusy, setActionBusy] = useState(null);
    const [docBusy, setDocBusy] = useState(null);
    const [docError, setDocError] = useState('');

    const [roles, setRoles] = useState([]);
    const [rolesPage, setRolesPage] = useState(1);
    const [rolesPagination, setRolesPagination] = useState(null);
    const [rolesLoading, setRolesLoading] = useState(true);
    const [rolesError, setRolesError] = useState('');
    const [roleBusy, setRoleBusy] = useState(null);

    const fetchQueue = async (nextStatus, nextPage) => {
        setLoading(true);
        setError('');
        try {
            const res = await adminFetch(`/verifications?status=${nextStatus}&page=${nextPage}&pageSize=${PAGE_SIZE}`);
            setRows(res.data || []);
            setPagination(res.pagination || null);
        } catch (err) {
            if (isForbidden(err)) setForbidden(true);
            else setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const fetchRoles = async (nextPage) => {
        setRolesLoading(true);
        setRolesError('');
        try {
            const res = await adminFetch(`/roles?page=${nextPage}&pageSize=${PAGE_SIZE}`);
            setRoles(res.data || []);
            setRolesPagination(res.pagination || null);
        } catch (err) {
            if (isForbidden(err)) setForbidden(true);
            else setRolesError(err.message);
        } finally {
            setRolesLoading(false);
        }
    };

    useEffect(() => { fetchQueue(status, page); }, [status, page]);
    useEffect(() => { fetchRoles(rolesPage); }, [rolesPage]);

    const handleViewDocument = async (row) => {
        setDocBusy(row.id);
        setDocError('');
        try {
            const res = await adminFetch(`/verifications/${row.id}/document`);
            window.open(res.signedUrl, '_blank', 'noopener,noreferrer');
        } catch (err) {
            setDocError(err.message);
        } finally {
            setDocBusy(null);
        }
    };

    const handleApprove = async (row) => {
        const name = `${row.farmer?.first_name || ''} ${row.farmer?.last_name || ''}`.trim() || 'this farmer';
        if (!window.confirm(`Approve verification for ${name}?`)) return;
        setActionBusy(row.id);
        try {
            await adminFetch(`/verifications/${row.id}/approve`, { method: 'POST' });
            await fetchQueue(status, page);
        } catch (err) {
            alert(err.message);
        } finally {
            setActionBusy(null);
        }
    };

    const handleReject = async (row) => {
        const name = `${row.farmer?.first_name || ''} ${row.farmer?.last_name || ''}`.trim() || 'this farmer';
        if (!rejectNote.trim()) return;
        if (!window.confirm(`Reject verification for ${name}?`)) return;
        setActionBusy(row.id);
        try {
            await adminFetch(`/verifications/${row.id}/reject`, { method: 'POST', body: { note: rejectNote.trim() } });
            setRejectingId(null);
            setRejectNote('');
            await fetchQueue(status, page);
        } catch (err) {
            alert(err.message);
        } finally {
            setActionBusy(null);
        }
    };

    const handleRoleChange = async (row, newRole) => {
        const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.email_address;
        if (!window.confirm(`Change ${name}'s role to ${newRole}?`)) return;
        setRoleBusy(row.id);
        try {
            await adminFetch(`/roles/${row.id}`, { method: 'POST', body: { role: newRole } });
            await fetchRoles(rolesPage);
        } catch (err) {
            alert(err.message);
        } finally {
            setRoleBusy(null);
        }
    };

    if (forbidden) {
        return (
            <div className="min-h-screen bg-cream font-dmsans p-6 md:p-12 flex items-center justify-center">
                <p className="text-xl font-black text-green-deep">You don't have access to this page.</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-cream font-dmsans p-6 md:p-12">
            <div className="max-w-6xl mx-auto">
                <Link to="/" className="inline-flex items-center gap-2 text-green-deep font-black mb-10 hover:text-amber transition-colors">
                    ← Back to Home
                </Link>
                <h1 className="font-playfair text-3xl font-black text-green-deep mb-2">Admin review queue</h1>
                <p className="text-gray-500 text-sm font-medium mb-10">Review farmer verification documents and manage user roles.</p>

                {/* Verification queue */}
                <div className="bg-white rounded-[32px] p-8 shadow-sm border border-cream-dark mb-10">
                    <div className="flex flex-col md:flex-row md:items-center gap-4 mb-6">
                        <h2 className="text-xl font-bold text-green-deep flex-1">Verification submissions</h2>
                        <select
                            value={status}
                            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
                            className="bg-cream/50 border border-transparent focus:border-green-fresh px-4 py-2 rounded-2xl outline-none font-bold text-green-deep text-sm"
                        >
                            <option value="pending">Pending</option>
                            <option value="approved">Approved</option>
                            <option value="rejected">Rejected</option>
                        </select>
                    </div>

                    {loading ? (
                        <p className="font-bold text-green-deep">Loading verifications...</p>
                    ) : error ? (
                        <p className="font-bold text-red-500">{error}</p>
                    ) : rows.length === 0 ? (
                        <p className="font-bold text-gray-500">No {status} verifications.</p>
                    ) : (
                        <div className="space-y-4">
                            {rows.map((row) => (
                                <div key={row.id} className="bg-cream/30 rounded-[28px] border border-cream-dark/50 p-6">
                                    <div className="flex flex-col md:flex-row md:items-center gap-4">
                                        <div className="flex-1">
                                            <p className="font-black text-green-deep">
                                                {row.farmer ? `${row.farmer.first_name || ''} ${row.farmer.last_name || ''}`.trim() : 'Unknown farmer'}
                                            </p>
                                            <p className="text-sm font-bold text-gray-500">
                                                Submitted {row.created_at ? new Date(row.created_at).toLocaleDateString() : '—'}
                                                {' · '}Status: {row.status}
                                            </p>
                                            <button
                                                onClick={() => handleViewDocument(row)}
                                                disabled={docBusy === row.id}
                                                className="text-sm font-bold text-green-fresh underline hover:text-amber disabled:opacity-50"
                                            >
                                                {docBusy === row.id ? 'Loading document...' : 'View document'}
                                            </button>
                                            {docError && (
                                                <p className="text-sm font-bold text-red-500">{docError}</p>
                                            )}
                                        </div>
                                        {row.status === 'pending' && (
                                            <div className="flex items-center gap-2">
                                                <button
                                                    onClick={() => handleApprove(row)}
                                                    disabled={actionBusy === row.id}
                                                    className="bg-green-deep text-white px-5 py-2.5 rounded-full text-sm font-bold shadow-lg hover:bg-green-mid transition-all disabled:opacity-50"
                                                >
                                                    {actionBusy === row.id ? 'Working...' : 'Approve'}
                                                </button>
                                                <button
                                                    onClick={() => { setRejectingId(row.id); setRejectNote(''); }}
                                                    disabled={actionBusy === row.id}
                                                    className="bg-white text-red-500 border-2 border-red-200 px-5 py-2.5 rounded-full text-sm font-bold shadow-sm hover:bg-red-50 transition-all disabled:opacity-50"
                                                >
                                                    Reject
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    {rejectingId === row.id && (
                                        <div className="mt-4 flex flex-col md:flex-row gap-2">
                                            <input
                                                value={rejectNote}
                                                onChange={(e) => setRejectNote(e.target.value)}
                                                placeholder="Rejection note (required)"
                                                className="flex-1 bg-white border-2 border-transparent focus:border-amber px-5 py-3 rounded-2xl outline-none font-bold text-green-deep text-sm"
                                            />
                                            <button
                                                onClick={() => handleReject(row)}
                                                disabled={!rejectNote.trim() || actionBusy === row.id}
                                                className="bg-red-500 text-white px-5 py-3 rounded-full text-sm font-bold shadow-lg hover:bg-red-600 transition-all disabled:opacity-50"
                                            >
                                                Confirm reject
                                            </button>
                                            <button
                                                onClick={() => { setRejectingId(null); setRejectNote(''); }}
                                                className="bg-white text-green-deep border-2 border-cream-dark px-5 py-3 rounded-full text-sm font-bold hover:bg-cream transition-all"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {pagination && pagination.totalPages > 1 && (
                        <div className="flex items-center justify-between mt-6">
                            <button
                                onClick={() => setPage((p) => Math.max(1, p - 1))}
                                disabled={page <= 1}
                                className="bg-white text-green-deep border-2 border-cream-dark px-5 py-2 rounded-full text-sm font-bold hover:bg-cream transition-all disabled:opacity-50"
                            >
                                ← Prev
                            </button>
                            <p className="text-sm font-bold text-gray-500">Page {pagination.page} of {pagination.totalPages}</p>
                            <button
                                onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                                disabled={page >= pagination.totalPages}
                                className="bg-white text-green-deep border-2 border-cream-dark px-5 py-2 rounded-full text-sm font-bold hover:bg-cream transition-all disabled:opacity-50"
                            >
                                Next →
                            </button>
                        </div>
                    )}
                </div>

                {/* Roles */}
                <div className="bg-white rounded-[32px] p-8 shadow-sm border border-cream-dark">
                    <h2 className="text-xl font-bold text-green-deep mb-6">User roles</h2>
                    {rolesLoading ? (
                        <p className="font-bold text-green-deep">Loading users...</p>
                    ) : rolesError ? (
                        <p className="font-bold text-red-500">{rolesError}</p>
                    ) : roles.length === 0 ? (
                        <p className="font-bold text-gray-500">No users found.</p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr className="text-[10px] font-black uppercase text-gray-400 tracking-widest">
                                        <th className="py-3 pr-4">Name</th>
                                        <th className="py-3 pr-4">Email</th>
                                        <th className="py-3 pr-4">Role</th>
                                        <th className="py-3 pr-4">Verification</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {roles.map((row) => (
                                        <tr key={row.id} className="border-t border-cream-dark font-bold text-green-deep">
                                            <td className="py-3 pr-4">{`${row.first_name || ''} ${row.last_name || ''}`.trim() || '—'}</td>
                                            <td className="py-3 pr-4 text-gray-500">{row.email_address}</td>
                                            <td className="py-3 pr-4">
                                                <select
                                                    value={row.role}
                                                    disabled={roleBusy === row.id}
                                                    onChange={(e) => handleRoleChange(row, e.target.value)}
                                                    className="bg-cream/50 border border-transparent focus:border-green-fresh px-3 py-2 rounded-xl outline-none font-bold text-green-deep text-sm disabled:opacity-50"
                                                >
                                                    <option value="buyer">buyer</option>
                                                    <option value="farmer">farmer</option>
                                                    <option value="admin">admin</option>
                                                </select>
                                            </td>
                                            <td className="py-3 pr-4 text-gray-500">{row.verification_status || 'unverified'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {rolesPagination && rolesPagination.totalPages > 1 && (
                        <div className="flex items-center justify-between mt-6">
                            <button
                                onClick={() => setRolesPage((p) => Math.max(1, p - 1))}
                                disabled={rolesPage <= 1}
                                className="bg-white text-green-deep border-2 border-cream-dark px-5 py-2 rounded-full text-sm font-bold hover:bg-cream transition-all disabled:opacity-50"
                            >
                                ← Prev
                            </button>
                            <p className="text-sm font-bold text-gray-500">Page {rolesPagination.page} of {rolesPagination.totalPages}</p>
                            <button
                                onClick={() => setRolesPage((p) => Math.min(rolesPagination.totalPages, p + 1))}
                                disabled={rolesPage >= rolesPagination.totalPages}
                                className="bg-white text-green-deep border-2 border-cream-dark px-5 py-2 rounded-full text-sm font-bold hover:bg-cream transition-all disabled:opacity-50"
                            >
                                Next →
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default VerificationQueue;
