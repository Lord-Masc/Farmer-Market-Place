'use strict';
// Shared transport booking (Stage 6 integration point) — the Stage 5
// group detail response carries the pooled lot's shipment here: one
// shipment per pooled order (enforced by the shipments.order_id UNIQUE),
// so a pooled lot books exactly one shared shipment. Returns a summary
// or null when the group has no order yet or no shipment booked.
// shared_by is the number of farmers pooling the lot.
const supabaseAdmin = require('../utils/supabaseAdmin');

async function getTransportBooking(group) {
  if (!group || !group.order_id) return null;
  const { data, error } = await supabaseAdmin
    .from('shipments')
    .select('*')
    .eq('order_id', group.order_id);
  if (error || !data || data.length === 0) return null;
  const shipment = data[0];
  const { data: participants } = await supabaseAdmin
    .from('group_buy_participants')
    .select('id')
    .eq('group_buy_id', group.id);
  return {
    shipment_id: shipment.id,
    transporter_id: shipment.transporter_id,
    status: shipment.status,
    price_paise: shipment.price_paise,
    shared_by: (participants || []).length,
  };
}

module.exports = { getTransportBooking };
