import React from 'react';

// One crop-passport lot: crop, quantity, harvest date, quality grade, photos
// and the mandi-price reference exactly as recorded. Never invents a price:
// when none was recorded the card says so.
const CropPassportCard = ({ lot }) => {
  const photo = lot.photos?.[0];
  const harvestDate = lot.harvest_date
    ? new Date(lot.harvest_date).toLocaleDateString()
    : null;

  return (
    <div className="bg-white rounded-[24px] p-6 shadow-sm border border-transparent hover:border-green-fresh transition-all">
      {photo ? (
        <img src={photo} alt={lot.crop} className="w-full h-40 object-cover rounded-[20px] mb-4" />
      ) : (
        <div className="w-full h-40 bg-cream-dark rounded-[20px] flex items-center justify-center text-6xl mb-4">🌾</div>
      )}

      {lot.product_name && (
        <p className="text-xs font-bold text-green-mid uppercase tracking-wider mb-1">{lot.product_name}</p>
      )}
      <h3 className="font-playfair text-xl font-bold text-green-deep mb-2">
        {lot.crop}{lot.variety ? ` (${lot.variety})` : ''}
      </h3>

      <p className="text-sm text-[#4a4a4a] mb-1">
        {lot.quantity} {lot.unit}
      </p>
      {harvestDate && <p className="text-sm text-[#4a4a4a] mb-1">Harvested: {harvestDate}</p>}
      {lot.quality_grade && (
        <p className="text-sm text-[#4a4a4a] mb-1">Quality grade: {lot.quality_grade}</p>
      )}

      <p className="text-sm text-gray-500 mt-3">
        {lot.mandi_price_reference != null
          ? `Mandi price at listing: ₹${lot.mandi_price_reference}`
          : 'No mandi price recorded for this lot.'}
      </p>
    </div>
  );
};

export default CropPassportCard;
