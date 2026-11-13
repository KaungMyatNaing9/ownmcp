# Review these tools before shipping

Declared owner origin: `http://127.0.0.1:44731`.

ownmcp only turns recordings, forms, and OpenAPI that you point it at into `registerTool` handlers for that origin. It does not crawl other sites.

- Dropped 1 request whose origin was not http://127.0.0.1:44731.
- Skipped 1 static or discovery request. Those are not tools.

## add_to_cart

- Effect: **state-changing**
- Confirmation: required before the request is sent
- Call: `POST /api/cart`
- Sources: form, har, openapi
- consequentialHint: true
- readOnlyHint: false
- A recording or form used a form body. The handler sends JSON because an OpenAPI application/json schema is present.

## get_cart

- Effect: **read**
- Confirmation: not required
- Call: `GET /api/cart`
- Sources: har, openapi
- consequentialHint: false
- readOnlyHint: true

## list_orders

- Effect: **read**
- Confirmation: not required
- Call: `GET /api/orders`
- Sources: har, openapi
- consequentialHint: false
- readOnlyHint: true

## list_products

- Effect: **read**
- Confirmation: not required
- Call: `GET /api/products`
- Sources: har, openapi
- consequentialHint: false
- readOnlyHint: true

## place_order

- Effect: **state-changing**
- Confirmation: required before the request is sent
- Call: `POST /api/checkout`
- Sources: form, har, openapi
- consequentialHint: true
- readOnlyHint: false
- This looks hard to undo. Keep the confirmation gate.

untrustedContentHint is false on every generated tool. Set it to true if a response includes content your site does not control.
