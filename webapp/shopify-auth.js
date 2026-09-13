// Store-owned Shopify apps use renewable credentials; existing access tokens still work.
function storeDomain(value) {
  if (typeof value !== "string") throw new Error("Enter your store's myshopify.com address.");
  let domain = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!domain.includes(".")) domain += ".myshopify.com";
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(domain)) {
    throw new Error("Use your store's myshopify.com address, without a page path.");
  }
  return domain;
}

async function shopifyJson(domain, path, options = {}, request = fetch) {
  domain = storeDomain(domain);
  const res = await request(`https://${domain}${path}`, {
    ...options, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Shopify rejected the connection (${res.status}). Check your app is installed on this store and its permissions are enabled.`);
  return res.json();
}

async function exchangeCredentials(domain, clientId, clientSecret, request = fetch) {
  if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string" || !clientSecret.trim()) {
    throw new Error("Enter the Client ID and Client secret from your Shopify app's settings.");
  }
  const data = await shopifyJson(domain, "/admin/oauth/access_token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId.trim(), client_secret: clientSecret.trim() }).toString(),
  }, request);
  if (!data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 60) {
    throw new Error("Shopify did not return a usable connection. Check the app and store belong to the same organization.");
  }
  return { access_token: data.access_token, client_id: clientId.trim(), client_secret: clientSecret.trim(),
    expires_at: Date.now() + Number(data.expires_in) * 1000, scope: data.scope || "" };
}

async function inspectShop(domain, token, request = fetch) {
  const data = await shopifyJson(domain, "/admin/api/2026-01/graphql.json", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query: "{ shop { name } currentAppInstallation { accessScopes { handle } } }" }),
  }, request);
  if (data.errors?.length || !data.data?.shop?.name || !data.data?.currentAppInstallation?.accessScopes) {
    throw new Error("Shopify could not confirm access to this store. Check the app's permissions.");
  }
  return { name: data.data.shop.name, scopes: data.data.currentAppInstallation.accessScopes.map(s => s.handle) };
}
module.exports = { storeDomain, exchangeCredentials, inspectShop };
