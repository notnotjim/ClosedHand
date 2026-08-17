---
name: Intelligence Loop
description: Cross-reference Shopify sales and Meta Ads data for smart business recommendations
requires_service: shopify,meta
triggers: [intelligence, cross-reference, ad roi, which ads, what's working, performance review, business review, marketing roi]
---

When both Shopify and Meta Ads are connected, you can cross-reference data for powerful insights.

## Workflow

### 1. Pull Shopify sales data

Use `api_request` with `service=shopify`:
```
GET /orders.json?status=any&created_at_min={30_DAYS_AGO}&limit=250&fields=id,total_price,currency,created_at,line_items,referring_site,landing_site
```
Calculate: total revenue, top products, average order value, daily revenue trend.

### 2. Pull Meta Ads performance

Use `api_request` with `service=meta`:
```
GET https://graph.facebook.com/v21.0/{ad_account_id}/insights?fields=spend,impressions,clicks,actions,cost_per_action_type,purchase_roas&date_preset=last_30d&level=campaign
```
Extract: total spend, purchases attributed, ROAS, cost per purchase per campaign.

### 3. Cross-reference and analyse

Key calculations:
- **Blended ROAS**: Total Shopify revenue / Total Meta spend
- **True CPA**: Total Meta spend / Total Shopify orders (includes organic orders in denominator)
- **Ad-attributed %**: Meta-attributed purchases / Total Shopify orders
- **Best performing campaigns**: Highest ROAS, lowest CPA
- **Worst performers**: Campaigns spending but not converting

### 4. Generate recommendations

Based on the data:
- Which campaigns to scale (high ROAS, room to grow)
- Which to pause (high spend, low/no returns)
- Budget reallocation suggestions
- Top products to promote (high margin + high demand)
- Time-of-day or day-of-week patterns

Keep recommendations specific and actionable — "Pause Campaign X (spent 200, 0 purchases)" not "consider reviewing underperformers."
