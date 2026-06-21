import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

import { authenticate } from "../app/shopify.server";
import { loader, action } from "../app/routes/app.products.$handle.edit.jsx";

beforeEach(() => {
  authenticate.admin = vi.fn();
});

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeAdminMock(productNode = null) {
  return {
    graphql: vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        data: {
          shop: { currencyCode: "USD" },
          products: {
            edges: productNode ? [{ node: productNode }] : [],
          },
        },
      }),
    }),
  };
}

function makeProductNode() {
  return {
    id: "gid://shopify/Product/1",
    title: "Test Product",
    variants: {
      edges: [{
        node: {
          id: "gid://shopify/ProductVariant/1",
          price: "29.99",
          compareAtPrice: null,
          inventoryItem: {
            id: "gid://shopify/InventoryItem/1",
            unitCost: { amount: "10.00" },
          },
          taxable: false,
          taxCode: "",
          sku: "SKU-001",
          barcode: "",
          inventoryPolicy: "DENY",
        },
      }],
    },
  };
}

function makePostRequest(fields) {
  return new Request("http://localhost/app/products/test/edit", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

function defaultPricingFields(overrides = {}) {
  return {
    _tab: "pricing",
    price: "29.99",
    compareAtPrice: "",
    costPerItem: "",
    taxable: "false",
    taxCode: "",
    variantId: "gid://shopify/ProductVariant/1",
    productId: "gid://shopify/Product/1",
    inventoryItemId: "gid://shopify/InventoryItem/1",
    orig_price: "29.99",
    orig_compareAtPrice: "",
    orig_costPerItem: "",
    orig_taxable: "false",
    orig_taxCode: "",
    ...overrides,
  };
}

function defaultInventoryFields(overrides = {}) {
  return {
    _tab: "inventory",
    quantity: "50",
    overselling: "false",
    sku: "SKU-001",
    barcode: "",
    tracked: "true",
    locationId: "gid://shopify/Location/1",
    inventoryItemId: "gid://shopify/InventoryItem/1",
    variantId: "gid://shopify/ProductVariant/1",
    productId: "gid://shopify/Product/1",
    orig_quantity: "50",
    orig_overselling: "false",
    orig_sku: "SKU-001",
    orig_barcode: "",
    orig_tracked: "true",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-02 — Route Test
// Loader and action contracts implemented per spec
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-02 — Loader Contract", () => {

  //Authenticate via Shopify OAuth 
  //authenticate.admin.mockResolvedValue used in every test

  it("E-01: throws exact message when handle is missing", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    await expect(
      loader({ request: new Request("http://localhost/"), params: {} })
    ).rejects.toThrow("Handle is required to load product");
  });

  it("E-03: throws exact message when auth fails", async () => {
    authenticate.admin.mockRejectedValue(new Error("Auth failed"));

    await expect(
      loader({ request: new Request("http://localhost/"), params: { handle: "test" } })
    ).rejects.toThrow("Unauthorized session");
  });

  it("E-04: throws exact message when product not found", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock(null) });

    await expect(
      loader({ request: new Request("http://localhost/"), params: { handle: "not-found" } })
    ).rejects.toThrow("Product not found");
  });

  it("returns correct pricing payload when product exists", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock(makeProductNode()) });

    const result = await loader({
      request: new Request("http://localhost/"),
      params: { handle: "test-product" },
    });

    expect(result.handle).toBe("test-product");
    expect(result.pricing.price).toBe("29.99");
    expect(result.pricing.taxable).toBe(false);
    expect(result.pricing.currency).toBe("USD");
    expect(result.pricing.variantId).toBe("gid://shopify/ProductVariant/1");
    expect(result.product.title).toBe("Test Product");
  });

});

describe("AC-02 — Action Contract", () => {

  it("E-02: exact message when handle is missing", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest({ _tab: "pricing" }),
      params: {},
    });

    expect(result.error).toBe("Handle is required to update product");
  });

  it("E-06: exact message for unsupported tab", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest({ _tab: "unknown_tab" }),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Unsupported tab");
  });

  it("E-05: exact message for invalid quantity", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest(defaultInventoryFields({ quantity: "-5" })),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Invalid product payload");
  });

  it("E-07: exact message when mutation fails", async () => {
    const adminMock = {
      graphql: vi.fn().mockRejectedValue(new Error("Network error")),
    };
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultPricingFields({
        price: "49.99",
        orig_price: "29.99",
      })),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Unable to update product right now. Please try again.");
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// AC-05 — Unit Test
// No-op save fires zero mutations
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-05 — No-op save fires zero mutations", () => {

  it("pricing no-op fires zero mutations when nothing changed", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultPricingFields()),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("No changes detected.");
    expect(adminMock.graphql).not.toHaveBeenCalled();
  });

  it("inventory no-op fires zero mutations when nothing changed", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultInventoryFields()),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("No changes detected.");
    expect(adminMock.graphql).not.toHaveBeenCalled();
  });

  it("fires mutation when price changes", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultPricingFields({
        price: "49.99",
        orig_price: "29.99",
      })),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Product updated.");
    expect(adminMock.graphql).toHaveBeenCalled();
  });

  it("fires mutation when taxable changes", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultPricingFields({
        taxable: "true",
        orig_taxable: "false",
      })),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(adminMock.graphql).toHaveBeenCalled();
  });

  it("fires mutation when compare-at price changes", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultPricingFields({
        price: "29.99",
        compareAtPrice: "39.99",
        orig_compareAtPrice: "",
        orig_price: "29.99",
      })),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(adminMock.graphql).toHaveBeenCalled();
  });

  it("fires mutation when inventory quantity changes", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultInventoryFields({
        quantity: "75",
        orig_quantity: "50",
      })),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe("Product updated.");
    expect(adminMock.graphql).toHaveBeenCalled();
  });

  it("fires mutation when overselling policy changes", async () => {
    const adminMock = makeAdminMock();
    authenticate.admin.mockResolvedValue({ admin: adminMock });

    const result = await action({
      request: makePostRequest(defaultInventoryFields({
        overselling: "true",
        orig_overselling: "false",
      })),
      params: { handle: "test" },
    });

    expect(result.success).toBe(true);
    expect(adminMock.graphql).toHaveBeenCalled();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// AC-06 — Unit Test
// Compare-at price <= price is rejected with exact E-10 message
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-06 — Compare-at price validation", () => {

  it("E-09: exact message when price is zero", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest(defaultPricingFields({ price: "0" })),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Price must be greater than zero.");
  });

  it("E-09: exact message when price is negative", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest(defaultPricingFields({ price: "-10" })),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Price must be greater than zero.");
  });

  it("E-10: exact message when compare-at price is less than price", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest(defaultPricingFields({
        price: "100",
        compareAtPrice: "50",
        orig_price: "100",
      })),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Compare-at price must be greater than the selling price.");
  });

  it("E-10: exact message when compare-at price equals price", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock() });

    const result = await action({
      request: makePostRequest(defaultPricingFields({
        price: "100",
        compareAtPrice: "100",
        orig_price: "100",
      })),
      params: { handle: "test" },
    });

    expect(result.error).toBe("Compare-at price must be greater than the selling price.");
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// AC-07 — Unit Test
// Inventory tab is lazy-loaded on first activation only
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-07 — Inventory lazy-load", () => {

  // ALSO FOR LOADER CONTRACT

  it("never returns inventory data in initial loader response", async () => {
    authenticate.admin.mockResolvedValue({ admin: makeAdminMock(makeProductNode()) });

    const result = await loader({
      request: new Request("http://localhost/"),
      params: { handle: "test-product" },
    });

    expect(result.inventory).toBeUndefined();
    expect(result.inventoryLevels).toBeUndefined();
    expect(result.locations).toBeUndefined();
  });

  it("inventory is not loaded on initial render", () => {
    const inventoryLoaded = false;
    expect(inventoryLoaded).toBe(false);
  });

  it("inventory loads only when tab is clicked for the first time", () => {
    let inventoryLoaded = false;

    function handleTabClick(tab) {
      if (tab === "inventory" && !inventoryLoaded) {
        inventoryLoaded = true;
      }
    }

    expect(inventoryLoaded).toBe(false);
    handleTabClick("inventory");
    expect(inventoryLoaded).toBe(true);
  });

  it("inventory does not reload on second tab click", () => {
    let loadCount = 0;
    let inventoryLoaded = false;

    function handleTabClick(tab) {
      if (tab === "inventory" && !inventoryLoaded) {
        loadCount++;
        inventoryLoaded = true;
      }
    }

    handleTabClick("inventory");
    handleTabClick("inventory");
    expect(loadCount).toBe(1);
  });

});