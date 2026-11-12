import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { uploadProofPhoto, verifyShipmentOtp } from '../services/escrowApi';
import { validateImageFile } from '../utils/fileValidation';

// Delivery proof (Stage 6, module E): the transporter at handover uploads
// a proof photo (kind=proof — the path starts with `delivery-proofs/`)
// and enters the OTP the buyer shows them. Both are required: submit
// stays disabled until a photo is uploaded AND an OTP is entered. The
// backend's errors are surfaced plainly — wrong OTP (401/403), missing
// proof (422), locked after 5 failures (429). On success the shipment
// is delivered and payment is released.
const DeliveryProof = ({ shipmentId, orderId, onDelivered }) => {
  const [file, setFile] = useState(null);
  const [photoPath, setPhotoPath] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState(false);

  const handleUpload = async () => {
    const validationError = validateImageFile(file);
    if (validationError) {
      setUploadError(validationError);
      return;
    }
    setUploading(true);
    setUploadError('');
    try {
      const res = await uploadProofPhoto(file);
      setPhotoPath(res.path || '');
    } catch (err) {
      setUploadError(err.message || 'Could not upload the proof photo.');
    } finally {
      setUploading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!photoPath || !otp.trim()) return;
    setBusy(true);
    setError('');
    try {
      await verifyShipmentOtp(shipmentId, { otp: otp.trim(), proof_photo_path: photoPath });
      setDelivered(true);
      if (onDelivered) onDelivered();
    } catch (err) {
      // Backend message already names the failure (wrong OTP, missing
      // proof, locked after too many attempts) — show it as-is.
      setError(err.message || 'Could not verify the delivery.');
    } finally {
      setBusy(false);
    }
  };

  if (delivered) {
    return (
      <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
        <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Delivery confirmed</h2>
        <p className="text-sm text-gray-500 mb-4">The OTP matched and the proof photo was accepted — the shipment is delivered and payment has been released.</p>
        {orderId && (
          <Link to={`/checkout?orderId=${encodeURIComponent(orderId)}`} className="font-bold text-green-mid hover:text-green-deep">View order →</Link>
        )}
      </section>
    );
  }

  return (
    <section className="bg-white rounded-[24px] p-6 shadow-sm mb-10">
      <h2 className="font-playfair text-xl font-bold text-green-deep mb-2">Confirm delivery</h2>
      <p className="text-sm text-gray-500 mb-6">Upload a photo of the handover, then enter the OTP the buyer shows you. Both are required.</p>
      <form onSubmit={handleVerify} className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <label className="text-xs font-bold uppercase text-gray-600" htmlFor="proof-photo">Proof photo</label>
          <input id="proof-photo" type="file" accept="image/*" className="w-full bg-cream rounded-xl p-4 mt-1" onChange={(e) => { setFile(e.target.files?.[0] || null); setPhotoPath(''); setUploadError(''); }} />
          {file && !photoPath && (
            <button type="button" onClick={() => void handleUpload()} disabled={uploading} className="mt-3 bg-green-deep text-white font-bold px-5 py-3 rounded-xl disabled:opacity-50">
              {uploading ? 'Uploading...' : 'Upload photo'}
            </button>
          )}
          {photoPath && <p className="text-sm font-bold text-green-mid mt-3">Photo uploaded.</p>}
          {uploadError && <p aria-live="polite" className="text-sm text-red-600 mt-2">{uploadError}</p>}
        </div>
        <div>
          <label className="text-xs font-bold uppercase text-gray-600" htmlFor="delivery-otp">Delivery OTP</label>
          <input id="delivery-otp" className="w-full bg-cream rounded-xl p-4 mt-1" placeholder="6-digit OTP from the buyer" value={otp} onChange={(e) => setOtp(e.target.value)} />
        </div>
        {error && <p aria-live="polite" className="md:col-span-2 text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={busy || !photoPath || !otp.trim()} className="md:col-span-2 bg-green-deep text-white font-black py-4 rounded-xl disabled:opacity-50">
          {busy ? 'Verifying...' : 'Confirm Delivery'}
        </button>
      </form>
    </section>
  );
};

export default DeliveryProof;
