---
name: Meta Ads
description: View and manage Facebook/Instagram ad campaigns, ad sets, and performance insights
requires_service: meta
triggers: [ads, campaigns, ad spend, meta, facebook ads, instagram ads, roas, ad performance, adsets, ad budget]
---

Use `api_request` with `service=meta` for all Meta Marketing API calls.
Base URL: `https://graph.facebook.com/v21.0`

## Ad Accounts

First, discover the user's ad accounts:
```
GET https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_status,currency
```
Use the returned `id` (format: `act_XXXXX`) for subsequent queries. Check all accounts if multiple.

## Campaigns

**List campaigns:**
```
GET https://graph.facebook.com/v21.0/{ad_account_id}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time&limit=50
```
Filter by status: append `&filtering=[{"field":"status","operator":"EQUAL","value":"ACTIVE"}]`
Note: budgets are in cents — divide by 100 for display.

## Ad Sets

**List ad sets for a campaign:**
```
GET https://graph.facebook.com/v21.0/{campaign_id}/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,bid_strategy,start_time
```
Targeting summary: `targeting.age_min/age_max`, `targeting.geo_locations.countries`.

## Insights (Performance)

**Account-level insights:**
```
GET https://graph.facebook.com/v21.0/{ad_account_id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type,purchase_roas,reach,frequency&date_preset=last_7d
```

**Campaign-level breakdown:**
Add `&level=campaign` and include `campaign_name` in fields.

**Ad set-level breakdown:**
Add `&level=adset` and include `campaign_name,adset_name` in fields.

**Custom date range:**
Replace `date_preset` with: `time_range={"since":"2024-01-01","until":"2024-01-31"}`

Date presets: `today`, `yesterday`, `last_7d`, `last_14d`, `last_30d`, `last_90d`, `this_month`, `last_month`.

**Key metrics to extract from response:**
- `spend`, `impressions`, `reach`, `clicks`, `ctr`, `cpc`, `frequency`
- Purchases: find in `actions[]` where `action_type === "purchase"`
- Cost per purchase: find in `cost_per_action_type[]` where `action_type === "purchase"`
- ROAS: find in `purchase_roas[]` where `action_type === "omni_purchase"`

## Updates (require confirmation)

**Pause/enable a campaign or ad set:**
```
POST https://graph.facebook.com/v21.0/{object_id}
Body: { "status": "PAUSED" }  or  { "status": "ACTIVE" }
```

**Set daily budget:**
```
POST https://graph.facebook.com/v21.0/{object_id}
Body: { "daily_budget": 5000 }
```
Budget is in cents — multiply the user's amount by 100.
