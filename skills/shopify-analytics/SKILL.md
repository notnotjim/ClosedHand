---
name: Shopify Analytics
description: Query Shopify orders, products, inventory, customers, and sales summaries
requires_service: shopify
triggers: [sales, orders, revenue, shopify, inventory, customers, products, e-commerce, ecommerce, sold, stock, low stock]
---

Use `api_request` with `service=shopify` for all Shopify API calls.
Shopify REST Admin API base path is used automatically — just provide the endpoint path.

## Orders

**List recent orders:**
```
GET /orders.json?status=any&created_at_min={ISO_DATE}&limit=10
```
Status options: any, open, closed, cancelled. Use `created_at_min` for date filtering.
Key response fields: `orders[].id`, `order_number`, `customer.first_name/last_name`, `email`, `total_price`, `currency`, `financial_status`, `fulfillment_status`, `line_items[].title/quantity`, `created_at`.

**Order detail:**
```
GET /orders/{order_id}.json
```
If the user gives a short order number like #1042, search first:
```
GET /orders.json?name=%231042&status=any&limit=1
```
Then use the `id` from the result. Returns full details: line items, shipping address, tracking, refunds, notes, tags.

## Products

**List/search products:**
```
GET /products.json?limit=15
GET /products.json?title={search_term}&limit=15
```
Key fields: `products[].id`, `title`, `status`, `product_type`, `vendor`, `variants[].price/sku/inventory_quantity`.

## Inventory

**Check inventory levels:**
Fetch products and examine `variants[].inventory_quantity`.
```
GET /products.json?limit=50
```
Flag low stock: items with quantity <= 5 and >= 0.
If user asks about a specific product, filter by title match.

## Customers

**Search/list customers:**
```
GET /customers/search.json?query={search}&limit=10
GET /customers.json?limit=10&order=created_at+desc
```
Key fields: `customers[].id`, `first_name`, `last_name`, `email`, `phone`, `orders_count`, `total_spent`, `default_address.city/country`.

## Sales Summary

For "how are sales?" or revenue analysis, fetch orders with pagination and aggregate:
```
GET /orders.json?status=any&created_at_min={ISO_DATE}&limit=250&fields=id,order_number,total_price,subtotal_price,total_discounts,total_tax,total_shipping_price_set,total_line_items_price,currency,financial_status,created_at,line_items,refunds
```
Paginate using `since_id` of last order if you get 250 results.

**Metrics (match Shopify's definitions):**
- Gross Sales = sum(line_item.price * quantity) before discounts
- Discounts = sum(total_discounts)
- Returns = sum(refunds[].refund_line_items[].subtotal)
- Net Sales = Gross - Discounts - Returns
- Shipping = sum(total_shipping_price_set.shop_money.amount)
- Tax = sum(total_tax)
- Total Sales = Net Sales + Shipping + Tax
- AOV = Gross Sales / Total Orders

Group by day, week, or month as appropriate. Track top products by gross revenue.
