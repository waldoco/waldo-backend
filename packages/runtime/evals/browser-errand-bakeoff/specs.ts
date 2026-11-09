// Errand types for the engine bake-off. Each names a kind of site, not a vendor: the operator maps every type to a
// real site and a test account in a local targets file that is never committed. `expected` is what the account must
// show afterwards; the harness checks it against the test account itself, not through either engine.
export type ErrandCategory = 'cancellation' | 'booking' | 'form' | 'refund' | 'dispute' | 'account_change';

export type ErrandSpec = Readonly<{
  type: string;
  category: ErrandCategory;
  site: string;
  goal: string;
  finalAction: string;
  // Keys the approval card must show before the operator approves.
  cardMustShow: readonly string[];
  expected: Readonly<Record<string, string>>;
  verifyCheck: string;
}>;

export const BAKEOFF_SPECS: readonly ErrandSpec[] = [
  { type: 'streaming_cancel', category: 'cancellation', site: 'video streaming subscription', goal: 'Cancel the paid plan at the end of the current billing period.', finalAction: 'Confirm cancellation', cardMustShow: ['plan', 'ends_on'], expected: { plan_status: 'Cancelled' }, verifyCheck: 'Open the account membership page and report plan_status.' },
  { type: 'saas_trial_cancel', category: 'cancellation', site: 'software free trial that converts to paid', goal: 'Cancel the trial before it converts.', finalAction: 'Cancel trial', cardMustShow: ['plan', 'trial_ends'], expected: { trial_status: 'Cancelled' }, verifyCheck: 'Open billing settings and report trial_status.' },
  { type: 'news_subscription_cancel', category: 'cancellation', site: 'newspaper digital subscription', goal: 'Stop the digital subscription renewal.', finalAction: 'Turn off auto-renew', cardMustShow: ['plan', 'renews_on'], expected: { auto_renew: 'Off' }, verifyCheck: 'Open subscription settings and report auto_renew.' },
  { type: 'mobile_addon_cancel', category: 'cancellation', site: 'mobile carrier account (prepaid add-on pack)', goal: 'Remove the recurring data add-on pack.', finalAction: 'Deactivate pack', cardMustShow: ['pack', 'price'], expected: { addon_status: 'Inactive' }, verifyCheck: 'Open active packs and report addon_status.' },
  { type: 'gym_membership_freeze', category: 'cancellation', site: 'gym or fitness studio membership portal', goal: 'Freeze the membership for one month.', finalAction: 'Confirm freeze', cardMustShow: ['membership', 'freeze_from', 'freeze_to'], expected: { membership_status: 'Frozen' }, verifyCheck: 'Open membership details and report membership_status.' },
  { type: 'restaurant_booking', category: 'booking', site: 'restaurant reservation site', goal: 'Book a table for two at 8 pm on the test date.', finalAction: 'Complete reservation', cardMustShow: ['restaurant', 'date', 'time', 'party_size'], expected: { reservation_status: 'Confirmed' }, verifyCheck: 'Open upcoming reservations and report reservation_status for the test date.' },
  { type: 'salon_appointment', category: 'booking', site: 'salon or barber booking page', goal: 'Book the first available haircut slot on the test date.', finalAction: 'Book appointment', cardMustShow: ['service', 'date', 'time'], expected: { appointment_status: 'Booked' }, verifyCheck: 'Open my appointments and report appointment_status.' },
  { type: 'car_service_booking', category: 'booking', site: 'car or bike service centre booking', goal: 'Book a general service drop-off on the test date.', finalAction: 'Confirm booking', cardMustShow: ['vehicle', 'date', 'centre'], expected: { booking_status: 'Confirmed' }, verifyCheck: 'Open service bookings and report booking_status.' },
  { type: 'meeting_room_booking', category: 'booking', site: 'co-working or library room booking', goal: 'Book a room for one hour on the test date.', finalAction: 'Reserve room', cardMustShow: ['room', 'date', 'time'], expected: { room_booking: 'Reserved' }, verifyCheck: 'Open my bookings and report room_booking.' },
  { type: 'reschedule_booking', category: 'booking', site: 'existing appointment on a booking platform', goal: 'Move the existing test appointment one day later, same time.', finalAction: 'Confirm new time', cardMustShow: ['old_date', 'new_date', 'time'], expected: { appointment_date: 'test date + 1' }, verifyCheck: 'Open the appointment and report appointment_date.' },
  { type: 'utility_address_update', category: 'form', site: 'electricity or gas utility account', goal: 'Update the billing address to the test address.', finalAction: 'Save address', cardMustShow: ['new_address'], expected: { billing_address: 'test address' }, verifyCheck: 'Open profile and report billing_address.' },
  { type: 'warranty_registration', category: 'form', site: 'appliance maker warranty registration', goal: 'Register the test appliance serial for warranty.', finalAction: 'Submit registration', cardMustShow: ['model', 'serial', 'purchase_date'], expected: { warranty_status: 'Registered' }, verifyCheck: 'Open registered products and report warranty_status.' },
  { type: 'event_rsvp', category: 'form', site: 'event platform with an RSVP form', goal: 'RSVP yes for one person to the test event.', finalAction: 'Send RSVP', cardMustShow: ['event', 'date', 'guests'], expected: { rsvp_status: 'Going' }, verifyCheck: 'Open the event page and report rsvp_status.' },
  { type: 'support_contact_form', category: 'form', site: 'retailer customer-support contact form', goal: 'Ask support about the test order delivery date.', finalAction: 'Send message', cardMustShow: ['order_id', 'subject'], expected: { ticket_status: 'Open' }, verifyCheck: 'Open support tickets and report ticket_status for the test order.' },
  { type: 'ecommerce_return', category: 'refund', site: 'online store order history', goal: 'Start a return for the test item with pickup.', finalAction: 'Request return', cardMustShow: ['order_id', 'item', 'refund_amount', 'pickup_date'], expected: { return_status: 'Requested' }, verifyCheck: 'Open the order and report return_status.' },
  { type: 'food_delivery_refund', category: 'refund', site: 'food delivery app web help centre', goal: 'Ask for a refund for the missing item in the test order.', finalAction: 'Submit refund request', cardMustShow: ['order_id', 'item', 'amount'], expected: { refund_status: 'Requested' }, verifyCheck: 'Open the order help page and report refund_status.' },
  { type: 'travel_cancel_refund', category: 'refund', site: 'bus or train booking site with a cancellable test ticket', goal: 'Cancel the test ticket and claim the refund.', finalAction: 'Cancel ticket', cardMustShow: ['pnr', 'refund_amount'], expected: { ticket_status: 'Cancelled' }, verifyCheck: 'Open my trips and report ticket_status.' },
  { type: 'telecom_bill_dispute', category: 'dispute', site: 'telecom or broadband bill', goal: 'Dispute the test charge on the latest bill and ask for a credit.', finalAction: 'Submit dispute', cardMustShow: ['bill_month', 'charge', 'amount'], expected: { dispute_status: 'Under review' }, verifyCheck: 'Open billing disputes and report dispute_status.' },
  { type: 'plan_downgrade', category: 'account_change', site: 'SaaS or cloud storage plan settings', goal: 'Downgrade to the free tier at the next renewal.', finalAction: 'Confirm downgrade', cardMustShow: ['current_plan', 'new_plan', 'effective'], expected: { next_plan: 'Free' }, verifyCheck: 'Open plan settings and report next_plan.' },
  { type: 'delivery_address_change', category: 'account_change', site: 'grocery delivery account', goal: 'Set the test address as the default delivery address.', finalAction: 'Save default address', cardMustShow: ['new_address'], expected: { default_address: 'test address' }, verifyCheck: 'Open saved addresses and report default_address.' },
];
