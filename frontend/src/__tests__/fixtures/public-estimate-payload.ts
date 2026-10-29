/**
 * #2090 - a REAL captured `GET /api/estimates/:id/public?token=` response.
 *
 * Captured from a running server, not hand-written. Only uuids, the org row and the customer row
 * were substituted; every key, every nesting level and every string-vs-number encoding is exactly
 * what the API serialises. That matters more than it sounds: the hand-built fixture this replaces
 * carried `kind: 'DEPOSIT'` on the deposit invoice, which the projection did not actually send,
 * so a page test asserting the lock passed against a server where the lock could never fire.
 *
 * Note what the capture shows and a hand-written object would not: money arrives as STRINGS
 * (`"1000"`, `"0"`), a line carries `price_book_item`, and the estimate carries the whole
 * document projection. Re-capture rather than edit if the payload shape changes.
 *
 * Two states of the SAME estimate: the deposit outstanding (selections open) and the deposit paid
 * (selections locked).
 */
export const PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING = {
  "estimate": {
    "id": "id-1",
    "estimate_number": "E00042",
    "status": "SENT",
    "created_at": "2026-09-16T03:57:05.237Z",
    "organization_id": "id-2",
    "subtotal": "1200",
    "discount_type": null,
    "discount_value": null,
    "discount_name": null,
    "discount_amount": "0",
    "tax_rate": "0",
    "tax_amount": "0",
    "total_amount": "1200",
    "signature_data": null,
    "signature_at": null,
    "snapshot_terms": "",
    "snapshot_notes": "",
    "snapshot_payment_terms": "",
    "scope_notes": null,
    "scopes": [
      {
        "id": "id-3",
        "body": "City permit handled for you.",
        "title": "Permit filing",
        "flat_price": 150,
        "is_taxable": true,
        "is_optional": true,
        "is_selected": false
      }
    ],
    "scope_photos": [],
    "customer": {
      "first_name": "Jane",
      "last_name": "Doe",
      "company_name": null
    },
    "service_location": {},
    "lead": null,
    "line_items": [
      {
        "id": "id-4",
        "sequence": 1,
        "description": "Door install",
        "item_type": "SERVICE",
        "quantity": "1",
        "unit_price": "1000",
        "is_taxable": true,
        "line_total": "1000",
        "discount_type": null,
        "discount_value": null,
        "discount_amount": "0",
        "is_optional": false,
        "is_selected": true,
        "price_book_item": null
      },
      {
        "id": "id-5",
        "sequence": 2,
        "description": "Smart keypad\nBluetooth unlock",
        "item_type": "SERVICE",
        "quantity": "1",
        "unit_price": "300",
        "is_taxable": true,
        "line_total": "300",
        "discount_type": null,
        "discount_value": null,
        "discount_amount": "0",
        "is_optional": true,
        "is_selected": false,
        "price_book_item": null
      },
      {
        "id": "id-6",
        "sequence": 3,
        "description": "Extended warranty",
        "item_type": "SERVICE",
        "quantity": "1",
        "unit_price": "200",
        "is_taxable": true,
        "line_total": "200",
        "discount_type": null,
        "discount_value": null,
        "discount_amount": "0",
        "is_optional": true,
        "is_selected": true,
        "price_book_item": null
      }
    ],
    "terms_accepted": false,
    "terms_accepted_at": null,
    "sent_at": "2026-09-16T03:57:05.342Z",
    "approved_at": null,
    "declined_at": null,
    "valid_until": "2026-10-16T03:57:05.341Z",
    "send_config": {
      "deposit_required": true,
      "deposit_percentage": "50",
      "deposit_amount": "600",
      "payment_methods": [
        "CHECK"
      ],
      "message_body": null
    },
    "invoices": [
      {
        "id": "id-7",
        "kind": "DEPOSIT",
        "status": "SENT",
        "total_amount": "600",
        "amount_due": "600",
        "public_token": "token-8"
      }
    ]
  },
  "organization": {
    "name": "Test Org",
    "logo_url": null,
    "brand_color": "#3B82F6",
    "email": "hello@example.com",
    "phone": null,
    "phone_ext": null,
    "website": null,
    "estimate_terms": ""
  },
  "terms": null,
  "payment_instructions": {
    "bank_transfer": null,
    "check": null,
    "cash": null
  },
  "expired": false,
  "service_fee_bps": 350,
  "service_fee_preview": 21
} as const;

export const PUBLIC_PAYLOAD_DEPOSIT_PAID = {
  "estimate": {
    "id": "id-1",
    "estimate_number": "E00042",
    "status": "SENT",
    "created_at": "2026-09-16T03:57:05.237Z",
    "organization_id": "id-2",
    "subtotal": "1200",
    "discount_type": null,
    "discount_value": null,
    "discount_name": null,
    "discount_amount": "0",
    "tax_rate": "0",
    "tax_amount": "0",
    "total_amount": "1200",
    "signature_data": null,
    "signature_at": null,
    "snapshot_terms": "",
    "snapshot_notes": "",
    "snapshot_payment_terms": "",
    "scope_notes": null,
    "scopes": [
      {
        "id": "id-3",
        "body": "City permit handled for you.",
        "title": "Permit filing",
        "flat_price": 150,
        "is_taxable": true,
        "is_optional": true,
        "is_selected": false
      }
    ],
    "scope_photos": [],
    "customer": {
      "first_name": "Jane",
      "last_name": "Doe",
      "company_name": null
    },
    "service_location": {},
    "lead": null,
    "line_items": [
      {
        "id": "id-4",
        "sequence": 1,
        "description": "Door install",
        "item_type": "SERVICE",
        "quantity": "1",
        "unit_price": "1000",
        "is_taxable": true,
        "line_total": "1000",
        "discount_type": null,
        "discount_value": null,
        "discount_amount": "0",
        "is_optional": false,
        "is_selected": true,
        "price_book_item": null
      },
      {
        "id": "id-5",
        "sequence": 2,
        "description": "Smart keypad\nBluetooth unlock",
        "item_type": "SERVICE",
        "quantity": "1",
        "unit_price": "300",
        "is_taxable": true,
        "line_total": "300",
        "discount_type": null,
        "discount_value": null,
        "discount_amount": "0",
        "is_optional": true,
        "is_selected": false,
        "price_book_item": null
      },
      {
        "id": "id-6",
        "sequence": 3,
        "description": "Extended warranty",
        "item_type": "SERVICE",
        "quantity": "1",
        "unit_price": "200",
        "is_taxable": true,
        "line_total": "200",
        "discount_type": null,
        "discount_value": null,
        "discount_amount": "0",
        "is_optional": true,
        "is_selected": true,
        "price_book_item": null
      }
    ],
    "terms_accepted": false,
    "terms_accepted_at": null,
    "sent_at": "2026-09-16T03:57:05.342Z",
    "approved_at": null,
    "declined_at": null,
    "valid_until": "2026-10-16T03:57:05.341Z",
    "send_config": {
      "deposit_required": true,
      "deposit_percentage": "50",
      "deposit_amount": "600",
      "payment_methods": [
        "CHECK"
      ],
      "message_body": null
    },
    "invoices": [
      {
        "id": "id-7",
        "kind": "DEPOSIT",
        "status": "PAID",
        "total_amount": "600",
        "amount_due": "0",
        "public_token": "token-8"
      }
    ]
  },
  "organization": {
    "name": "Test Org",
    "logo_url": null,
    "brand_color": "#3B82F6",
    "email": "hello@example.com",
    "phone": null,
    "phone_ext": null,
    "website": null,
    "estimate_terms": ""
  },
  "terms": null,
  "payment_instructions": {
    "bank_transfer": null,
    "check": null,
    "cash": null
  },
  "expired": false,
  "service_fee_bps": 350,
  "service_fee_preview": 21
} as const;

/** The captured rows this fixture's tests address by id. */
export const CAPTURED = {
  requiredLineId: 'id-4',
  declinedLineId: 'id-5',
  preselectedLineId: 'id-6',
  optionalScopeId: 'id-3',
  estimateId: 'id-1',
} as const;
