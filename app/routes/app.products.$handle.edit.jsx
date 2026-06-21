import { useState, useReducer, useEffect } from "react";
import { useLoaderData, useActionData, useSubmit, useNavigation, useFetcher, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import PropTypes from "prop-types";
import ProductEditHeader from "../components/ProductEditHeader";

// Loader 

export async function loader({ request, params }) {
  let admin;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
  } catch (e) {
    throw new Error("Unauthorized session");
  }

  if (!params.handle || !params.handle.trim()) {
    throw new Error("Handle is required to load product");
  }

  const response = await admin.graphql(`
    query getProductByHandle($handle: String!) {
      shop {
        currencyCode
      }
      products(first: 1, query: $handle) {
        edges {
          node {
            id
            title
            variants(first: 1) {
              edges {
                node {
                  id
                  price
                  compareAtPrice
                  inventoryItem {
                    id
                    unitCost {
                      amount
                    }
                  }
                  taxable
                  taxCode
                  sku
                  barcode
                  inventoryPolicy
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { handle: `handle:${params.handle}` } });

  const data = await response.json();
  const product = data?.data?.products?.edges[0]?.node;
  const currencyCode = data?.data?.shop?.currencyCode ?? "USD";

  if (!product) {
    throw new Error("Product not found");
  }

  const variant = product.variants.edges[0]?.node;

  // Never return inventory data in the initial loader — lazy loaded on tab click
  return {
    handle: params.handle,
    product: {
      id: product.id,
      title: product.title,
    },
    pricing: {
      variantId: variant?.id ?? null,
      inventoryItemId: variant?.inventoryItem?.id ?? null,
      price: variant?.price ?? "0.00",
      compareAtPrice: variant?.compareAtPrice ?? "",
      costPerItem: variant?.inventoryItem?.unitCost?.amount ?? "",
      taxable: variant?.taxable ?? false,
      taxCode: variant?.taxCode ?? "",
      currency: currencyCode,
    },
  };
}

// Action 
export async function action({ request, params }) {
  let admin;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
  } catch (e) {
    return { error: "Unauthorized session" };
  }

  if (!params.handle) {
    return { error: "Handle is required to update product" };
  }

  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return { error: "Invalid product payload" };
  }

  const _tab = formData.get("_tab");

  if (!_tab || !["pricing", "inventory", "both"].includes(_tab)) {
    return { error: "Unsupported tab" };
  }

  try {
    let pricingChanged = false;
    let inventoryChanged = false;

    // Pricing fields

    if (_tab === "pricing" || _tab === "both") {
      const variantId = formData.get("variantId");
      const price = formData.get("price");
      const compareAtPrice = formData.get("compareAtPrice");
      const costPerItem = formData.get("costPerItem");
      const taxable = formData.get("taxable") === "true";
      const taxCode = formData.get("taxCode");

      if (!price || parseFloat(price) <= 0) {
        return { error: "Price must be greater than zero." };
      }

      // Validate max 2 decimal places
      const priceDecimalCheck = /^\d+(\.\d{1,2})?$/;
      if (!priceDecimalCheck.test(price)) {
        return { error: "Price must have a maximum of 2 decimal places." };
      }

      if (compareAtPrice && !priceDecimalCheck.test(compareAtPrice)) {
        return { error: "Compare-at price must have a maximum of 2 decimal places." };
      }

      if (costPerItem && !priceDecimalCheck.test(costPerItem)) {
        return { error: "Cost per item must have a maximum of 2 decimal places." };
      }

      if (compareAtPrice && parseFloat(compareAtPrice) <= parseFloat(price)) {
        return { error: "Compare-at price must be greater than the selling price." };
      }

      const origPrice = formData.get("orig_price");
      const origCompareAtPrice = formData.get("orig_compareAtPrice");
      const origCostPerItem = formData.get("orig_costPerItem");
      const origTaxable = formData.get("orig_taxable");
      const origTaxCode = formData.get("orig_taxCode");

      pricingChanged =
        normalizePrice(price) !== normalizePrice(origPrice) ||
        normalizePrice(compareAtPrice) !== normalizePrice(origCompareAtPrice) ||
        normalizePrice(costPerItem) !== normalizePrice(origCostPerItem) ||
        taxable !== (origTaxable === "true") ||
        taxCode !== origTaxCode;

      if (pricingChanged) {

        // Fire productVariantsBulkUpdate for pricing fields
        const pricingRes = await admin.graphql(`
          mutation updateVariant($input: [ProductVariantsBulkInput!]!, $productId: ID!) {
            productVariantsBulkUpdate(variants: $input, productId: $productId) {
              userErrors { field message }
            }
          }
        `, {
          variables: {
            productId: formData.get("productId"),
            input: [{
              id: variantId,
              price,
              compareAtPrice: compareAtPrice || null,
              taxable,
              taxCode: taxable ? taxCode : null,
            }],
          },
        });

        const pricingData = await pricingRes.json();
        const pricingErrors = pricingData?.data?.productVariantsBulkUpdate?.userErrors ?? [];
        if (pricingErrors.length > 0) {
          return { error: pricingErrors[0].message };
        }

        // Fire inventoryItemUpdate if costPerItem changed
        const inventoryItemId = formData.get("inventoryItemId");
        if (costPerItem && costPerItem !== origCostPerItem) {
          const costRes = await admin.graphql(`
            mutation updateCost($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { unitCost { amount } }
                userErrors { field message }
              }
            }
          `, {
            variables: {
              id: inventoryItemId,
              input: { cost: costPerItem },
            },
          });

          const costData = await costRes.json();
          const costErrors = costData?.data?.inventoryItemUpdate?.userErrors ?? [];
          if (costErrors.length > 0) {
            return { error: costErrors[0].message };
          }
        }
      }
    }

    // Inventory fields 

    if (_tab === "inventory" || _tab === "both") {
      const inventoryItemId = formData.get("inventoryItemId");
      const locationId = formData.get("locationId");
      const quantity = parseInt(formData.get("quantity") ?? "0", 10);
      const overselling = formData.get("overselling") === "true";
      const variantId = formData.get("variantId");
      const sku = formData.get("sku");
      const origSku = formData.get("orig_sku");
      const barcode = formData.get("barcode");
      const origBarcode = formData.get("orig_barcode");
      const tracked = formData.get("tracked") === "true";
      const origTracked = formData.get("orig_tracked") === "true";
      const origQuantity = parseInt(formData.get("orig_quantity") ?? "0", 10);
      const origOverselling = formData.get("orig_overselling") === "true";

      if (isNaN(quantity) || quantity < 0) {
        return { error: "Invalid product payload" };
      }

      // Validate SKU uniqueness if SKU has changed
      if (sku && sku !== origSku) {
        const skuCheckRes = await admin.graphql(`
          query checkSKU($sku: String!) {
            productVariants(first: 1, query: $sku) {
              edges {
                node {
                  id
                  sku
                }
              }
            }
          }
        `, { variables: { sku: `sku:${sku}` } });

        const skuData = await skuCheckRes.json();
        const existingVariant = skuData?.data?.productVariants?.edges?.[0]?.node;

        // Check if the found variant belongs to a DIFFERENT product variant
        const isDuplicate = existingVariant &&
          existingVariant.sku === sku &&
          existingVariant.id !== variantId;

        if (isDuplicate) {
          return { error: "SKU already exists. Please use a unique SKU." };
        }
      }

      const quantityChanged = quantity !== origQuantity;
      const policyChanged = overselling !== origOverselling;
      const skuChanged = sku !== origSku;
      const barcodeChanged = barcode !== origBarcode;
      const trackedChanged = tracked !== origTracked;

      inventoryChanged = quantityChanged || policyChanged || skuChanged || barcodeChanged || trackedChanged;

      if (inventoryChanged) {
        // Fire inventoryAdjustQuantities if quantity changed
        if (quantityChanged) {
          // Activate location if merchant confirmed
          const shouldActivate = formData.get("activateLocation") === "true";
          if (shouldActivate) {
            const activateRes = await admin.graphql(`
              mutation activateInventory($inventoryItemId: ID!, $locationId: ID!) {
                inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
                  inventoryLevel { id }
                  userErrors { field message }
                }
              }
            `, {
              variables: { inventoryItemId, locationId },
            });

            const activateData = await activateRes.json();
            const activateErrors = activateData?.data?.inventoryActivate?.userErrors ?? [];
            if (activateErrors.length > 0) {
              return { error: activateErrors[0].message };
            }
          }

          // Adjust quantity
          const invRes = await admin.graphql(`
            mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
              inventoryAdjustQuantities(input: $input) {
                userErrors { field message }
              }
            }
          `, {
            variables: {
              input: {
                reason: "correction",
                name: "available",
                changes: [{
                  inventoryItemId,
                  locationId,
                  delta: quantity - origQuantity,
                }],
              },
            },
          });

          const invData = await invRes.json();
          const invErrors = invData?.data?.inventoryAdjustQuantities?.userErrors ?? [];
          if (invErrors.length > 0) {
            return { error: invErrors[0].message };
          }
        }

        // Fire productVariantsBulkUpdate if oversell policy changed
        if (policyChanged) {
          const policyRes = await admin.graphql(`
            mutation updateVariantPolicy($input: [ProductVariantsBulkInput!]!, $productId: ID!) {
              productVariantsBulkUpdate(variants: $input, productId: $productId) {
                userErrors { field message }
              }
            }
          `, {
            variables: {
              productId: formData.get("productId"),
              input: [{
                id: variantId,
                inventoryPolicy: overselling ? "CONTINUE" : "DENY",
              }],
            },
          });

          const policyData = await policyRes.json();
          const policyErrors = policyData?.data?.productVariantsBulkUpdate?.userErrors ?? [];
          if (policyErrors.length > 0) {
            return { error: policyErrors[0].message };
          }
        }

        // Fire productVariantsBulkUpdate if SKU changed
        if (skuChanged) {
          const skuRes = await admin.graphql(`
            mutation updateVariantSku($input: [ProductVariantsBulkInput!]!, $productId: ID!) {
              productVariantsBulkUpdate(variants: $input, productId: $productId) {
                userErrors { field message }
              }
            }
          `, {
            variables: {
              productId: formData.get("productId"),
              input: [{
                id: variantId,
                inventoryItem: { sku },
              }],
            },
          });

          const skuData = await skuRes.json();
          const skuErrors = skuData?.data?.productVariantsBulkUpdate?.userErrors ?? [];
          if (skuErrors.length > 0) {
            return { error: skuErrors[0].message };
          }
        }

        // Fire productVariantsBulkUpdate if barcode changed
        if (barcodeChanged) {
          const barcodeRes = await admin.graphql(`
            mutation updateBarcode($input: [ProductVariantsBulkInput!]!, $productId: ID!) {
              productVariantsBulkUpdate(variants: $input, productId: $productId) {
                userErrors { field message }
              }
            }
          `, {
            variables: {
              productId: formData.get("productId"),
              input: [{
                id: variantId,
                barcode,
              }],
            },
          });

          const barcodeData = await barcodeRes.json();
          const barcodeErrors = barcodeData?.data?.productVariantsBulkUpdate?.userErrors ?? [];
          if (barcodeErrors.length > 0) {
            return { error: barcodeErrors[0].message };
          }
        }

        // Fire inventoryItemUpdate if tracked changed
        if (trackedChanged) {
          const trackedRes = await admin.graphql(`
            mutation updateTracked($id: ID!, $input: InventoryItemInput!) {
              inventoryItemUpdate(id: $id, input: $input) {
                inventoryItem { tracked }
                userErrors { field message }
              }
            }
          `, {
            variables: {
              id: inventoryItemId,
              input: { tracked },
            },
          });

          const trackedData = await trackedRes.json();
          const trackedErrors = trackedData?.data?.inventoryItemUpdate?.userErrors ?? [];
          if (trackedErrors.length > 0) {
            return { error: trackedErrors[0].message };
          }
        }
      }
    }

    // No-op: nothing changed across both tabs
    if (!pricingChanged && !inventoryChanged) {
      return { success: true, message: "No changes detected." };
    }

    return { success: true, message: "Product updated." };

  } catch (e) {
    return { error: "Unable to update product right now. Please try again." };
  }
}

// ─── Shared State Reducer ─────────────────────────────────────────────────────

function formReducer(state, action) {
  switch (action.type) {
    case "SET_PRICING":
      // Update a single pricing field
      return {
        ...state,
        pricing: { ...state.pricing, [action.field]: action.value },
      };
    case "SET_INVENTORY":
      // Update a single inventory field
      return {
        ...state,
        inventory: { ...state.inventory, [action.field]: action.value },
      };
    case "LOAD_INVENTORY":
      // Called when inventory lazy-loads for the first time
      return {
        ...state,
        inventory: { ...action.data },
      };
    case "UPDATE_INVENTORY_LOCATION":
      return {
        ...state,
        inventory: {
          ...state.inventory,
          locationId: action.locationId,
          quantity: action.quantity,
          totalQuantity: action.totalQuantity ?? state.inventory.totalQuantity,
        },
      };
    case "UPDATE_QUANTITY_AND_TOTAL":
      // Called when merchant changes quantity — also updates total
      return {
        ...state,
        inventory: {
          ...state.inventory,
          quantity: action.quantity,
          totalQuantity: action.totalQuantity,
        },
      };
    case "DISCARD":
      // Reset everything back to original values
      return {
        pricing: { ...action.originalPricing },
        inventory: action.originalInventory ? { ...action.originalInventory } : null,
      };
    default:
      return state;
  }
}

// UI Component

export default function ProductEditPage() {
  const { product, pricing, handle } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();

  // useFetcher for lazy-loading inventory tab
  const inventoryFetcher = useFetcher();

  // Shared form state via reducer 
  const [formState, dispatch] = useReducer(formReducer, {
    pricing: { ...pricing },
    inventory: null, // null until lazy loaded
  });

  const [activeTab, setActiveTab] = useState("pricing");
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [localInventoryLevels, setLocalInventoryLevels] = useState(null);
  const [originalInventory, setOriginalInventory] = useState(null);
  const [clientError, setClientError] = useState(null);
  const [actionDataDismissed, setActionDataDismissed] = useState(false);
  const [savedBaseline, setSavedBaseline] = useState(null);  // SAVED AFTER BOTH BUTTONS NEEDS DISABLING SO FOR TRACKING

  // Update baseline only after confirmed successful save BECAUSE DUE TO BASELINE BOTH ERROR AND SUCESS MESSAGE IS COMING EVEN WITH INVALID DATA
  useEffect(() => {
    if (actionData?.success) {
      // Update pricing baseline
      setSavedBaseline({
        price: formState.pricing.price,
        compareAtPrice: formState.pricing.compareAtPrice,
        costPerItem: formState.pricing.costPerItem,
        taxable: formState.pricing.taxable,
        taxCode: formState.pricing.taxCode,
      });

      // Update inventory meta only on success
      if (formState.inventory) {
        setOriginalInventory((prev) => ({
          ...prev,
          quantity: formState.inventory.quantity,
          overselling: formState.inventory.overselling,
          sku: formState.inventory.sku,
          barcode: formState.inventory.barcode,
          tracked: formState.inventory.tracked,
        }));

        // Update local inventory levels
        const inventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
        const updatedLevels = inventoryLevels.map(l => {
          if (l.locationId === formState.inventory.locationId) {
            return { ...l, quantity: formState.inventory.quantity };
          }
          return l;
        });
        setLocalInventoryLevels(updatedLevels);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);
  useEffect(() => {
    setActionDataDismissed(false);
  }, [actionData]);

  // Tracks if merchant is trying to save to an inactive location
  const [pendingActivation, setPendingActivation] = useState(null);

  const isSaving = navigation.state === "submitting";
  const pricingBaseline = savedBaseline ?? pricing;
  const inventoryOrigValues = {
    overselling: originalInventory?.overselling ?? inventoryFetcher.data?.inventory?.overselling ?? false,
    sku: originalInventory?.sku ?? inventoryFetcher.data?.inventory?.sku ?? "",
    barcode: originalInventory?.barcode ?? inventoryFetcher.data?.inventory?.barcode ?? "",
    tracked: originalInventory?.tracked ?? inventoryFetcher.data?.inventory?.tracked ?? false,
  };

  // Populate inventory form once fetcher returns data
  if (inventoryFetcher.data && !formState.inventory) {
    dispatch({ type: "LOAD_INVENTORY", data: inventoryFetcher.data.inventory });
    setOriginalInventory({ ...inventoryFetcher.data.inventory });
  }

  const pricingDirty =
    normalizePrice(formState.pricing.price) !== normalizePrice(pricingBaseline.price) ||
    normalizePrice(formState.pricing.compareAtPrice) !== normalizePrice(pricingBaseline.compareAtPrice) ||
    normalizePrice(formState.pricing.costPerItem) !== normalizePrice(pricingBaseline.costPerItem) ||
    formState.pricing.taxable !== pricingBaseline.taxable ||
    formState.pricing.taxCode !== pricingBaseline.taxCode;

  // Get original quantity for the currently selected location
  const origInventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
  const origLevelForCurrentLocation = origInventoryLevels.find(
    l => l.locationId === formState.inventory?.locationId
  );
  const origQuantityForCurrentLocation = origLevelForCurrentLocation?.quantity ?? 0;

  const inventoryDirty = formState.inventory && originalInventory ? (
    formState.inventory.quantity !== origQuantityForCurrentLocation ||
    formState.inventory.overselling !== originalInventory.overselling ||
    formState.inventory.sku !== originalInventory.sku ||
    formState.inventory.barcode !== originalInventory.barcode ||
    formState.inventory.tracked !== originalInventory.tracked
  ) : false;

  const isDirty = pricingDirty || inventoryDirty;

  function handleTabClick(tab) {
    setActiveTab(tab);
    if (tab === "inventory" && !inventoryLoaded) {
      inventoryFetcher.load(`/app/products/${handle}/inventory`);
      setInventoryLoaded(true);
    }
  }

  function handleDiscard() {
    // Recalculate totalQuantity from original inventory levels
    const originalLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
    const originalTotal = originalLevels.reduce((sum, l) => sum + (l.quantity ?? 0), 0);

    dispatch({
      type: "DISCARD",
      originalPricing: { ...pricingBaseline },  // ✅ reverts to last saved value (or original if never saved)
      originalInventory: originalInventory
        ? { ...originalInventory, totalQuantity: originalTotal }
        : null,
    });
    setClientError(null);
    setActionDataDismissed(true); 
  }

  // Called when merchant confirms activation of an inactive location
  function handleSaveWithActivation() {
    const inventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
    const origLevel = inventoryLevels.find(l => l.locationId === formState.inventory.locationId);
    const origQuantityForLocation = origLevel?.quantity ?? 0;

    const formData = new FormData();
    formData.append("_tab", pricingDirty ? "both" : "inventory");
    formData.append("productId", product.id);
    formData.append("variantId", pricing.variantId);
    formData.append("inventoryItemId", pricing.inventoryItemId);
    formData.append("activateLocation", "true"); // ← tells action to activate first

    // Pricing fields
    formData.append("price", formState.pricing.price);
    formData.append("compareAtPrice", formState.pricing.compareAtPrice);
    formData.append("costPerItem", formState.pricing.costPerItem);
    formData.append("taxable", String(formState.pricing.taxable));
    formData.append("taxCode", formState.pricing.taxCode);
    formData.append("orig_price", pricingBaseline.price);
    formData.append("orig_compareAtPrice", pricingBaseline.compareAtPrice);
    formData.append("orig_costPerItem", pricingBaseline.costPerItem);
    formData.append("orig_taxable", String(pricingBaseline.taxable));
    formData.append("orig_taxCode", pricingBaseline.taxCode);

    // Inventory fields
    formData.append("locationId", formState.inventory.locationId);
    formData.append("quantity", String(formState.inventory.quantity));
    formData.append("overselling", String(formState.inventory.overselling));
    formData.append("sku", formState.inventory.sku);
    formData.append("barcode", formState.inventory.barcode);
    formData.append("tracked", String(formState.inventory.tracked));
    formData.append("orig_quantity", String(origQuantityForLocation));
    formData.append("orig_overselling", String(inventoryOrigValues.overselling));
    formData.append("orig_sku", inventoryOrigValues.sku);
    formData.append("orig_barcode", inventoryOrigValues.barcode);
    formData.append("orig_tracked", String(inventoryOrigValues.tracked));

    submit(formData, { method: "post" });
  }
  
  function handleSave() {
    setClientError(null);

    // Always validate pricing inline — switch to pricing tab if invalid
    const priceVal = parseFloat(formState.pricing.price);
    const compareAtPriceVal = formState.pricing.compareAtPrice
      ? parseFloat(formState.pricing.compareAtPrice)
      : null;
    const decimalCheck = /^\d+(\.\d{1,2})?$/;

    if (!formState.pricing.price || priceVal <= 0) {
      setClientError("Price must be greater than zero.");
      setActiveTab("pricing");
      return;
    }
    if (!decimalCheck.test(formState.pricing.price)) {
      setClientError("Price must have a maximum of 2 decimal places.");
      setActiveTab("pricing");
      return;
    }
    if (compareAtPriceVal !== null) {
      if (compareAtPriceVal <= priceVal) {
        setClientError("Compare-at price must be greater than the selling price.");
        setActiveTab("pricing");
        return;
      }
      if (!decimalCheck.test(formState.pricing.compareAtPrice)) {
        setClientError("Compare-at price must have a maximum of 2 decimal places.");
        setActiveTab("pricing");
        return;
      }
    }
    if (formState.pricing.costPerItem) {
      const cost = parseFloat(formState.pricing.costPerItem);
      if (cost <= 0) {
        setClientError("Cost per item must be greater than zero.");
        setActiveTab("pricing");
        return;
      }
      if (!decimalCheck.test(formState.pricing.costPerItem)) {
        setClientError("Cost per item must have a maximum of 2 decimal places.");
        setActiveTab("pricing");
        return;
      }
    }

    // Validate inventory quantity if inventory is dirty — block entire save if invalid
    if (inventoryDirty && formState.inventory) {
      const qty = formState.inventory.quantity;
      if (isNaN(qty) || qty < 0) {
        setClientError("Quantity must be a number greater than or equal to zero.");
        setActiveTab("inventory"); // Switch to inventory tab to show the error
        return; // Block entire save
      }
    }

    const inventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
    const origLevel = formState.inventory
      ? inventoryLevels.find(l => l.locationId === formState.inventory.locationId)
      : null;
    const origQuantityForLocation = origLevel?.quantity ?? 0;

    const quantityIsChanging = formState.inventory &&
      formState.inventory.quantity !== origQuantityForLocation;

    if (quantityIsChanging) {
      const selectedLevel = inventoryLevels.find(
        l => l.locationId === formState.inventory.locationId
      );
      if (selectedLevel && !selectedLevel.active) {
        setPendingActivation({
          locationId: formState.inventory.locationId,
          locationName: selectedLevel.locationName,
          quantity: formState.inventory.quantity,
        });
        return;
      }
    }

    // Determine which tab(s) have changes
    const hasInventory = formState.inventory !== null;
    const tab = pricingDirty && inventoryDirty ? "both"
      : pricingDirty ? "pricing"
      : inventoryDirty ? "inventory"
      : "pricing"; // fallback — no-op will be detected in action

    const formData = new FormData();
    formData.append("_tab", tab);
    formData.append("productId", product.id);
    formData.append("variantId", pricing.variantId);
    // For pricing cost mutation
    formData.append("inventoryItemId", pricing.inventoryItemId);
    // For inventory mutations — use the inventory item from the loaded inventory data
    if (formState.inventory) {
      formData.set("inventoryItemId", formState.inventory.inventoryItemId);
    }

    // Pricing fields
    formData.append("price", formState.pricing.price);
    formData.append("compareAtPrice", formState.pricing.compareAtPrice);
    formData.append("costPerItem", formState.pricing.costPerItem);
    formData.append("taxable", String(formState.pricing.taxable));
    formData.append("taxCode", formState.pricing.taxCode);
    formData.append("orig_price", pricingBaseline.price);
    formData.append("orig_compareAtPrice", pricingBaseline.compareAtPrice);
    formData.append("orig_costPerItem", pricingBaseline.costPerItem);
    formData.append("orig_taxable", String(pricingBaseline.taxable));
    formData.append("orig_taxCode", pricingBaseline.taxCode);

    // Inventory fields (only if loaded)
    if (hasInventory && formState.inventory) {
      formData.append("locationId", formState.inventory.locationId);
      formData.append("quantity", String(formState.inventory.quantity));
      formData.append("overselling", String(formState.inventory.overselling));
      formData.append("sku", formState.inventory.sku);
      formData.append("barcode", formState.inventory.barcode);
      formData.append("tracked", String(formState.inventory.tracked));

      formData.append("orig_quantity", String(origQuantityForLocation));
      formData.append("orig_overselling", String(inventoryOrigValues.overselling));
      formData.append("orig_sku", inventoryOrigValues.sku);
      formData.append("orig_barcode", inventoryOrigValues.barcode);
      formData.append("orig_tracked", String(inventoryOrigValues.tracked));
    }


    submit(formData, { method: "post" });
  }

  const locations = inventoryFetcher.data?.locations ?? [];

  return (
    <div style={{ fontFamily: "sans-serif", minHeight: "100vh", background: "#fafafa" }}>

      {/* ── Persistent Header Bar ── */}
      <ProductEditHeader
        productTitle={product.title}
        handle={handle}
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onDiscard={handleDiscard}
      />

      <div style={{ padding: "24px", maxWidth: "720px", margin: "0 auto" }}>

        {/* ── Location Activation Confirmation Dialog ── */}
        {pendingActivation && (
          <div style={{
            position: "fixed",
            top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}>
            <div style={{
              background: "#fff",
              borderRadius: "8px",
              padding: "24px",
              maxWidth: "400px",
              width: "90%",
              boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
            }}>
              <h3 style={{ margin: "0 0 8px", fontSize: "16px" }}>
                Activate location?
              </h3>
              <p style={{ color: "#666", fontSize: "14px", margin: "0 0 20px" }}>
                <strong>&quot;{pendingActivation.locationName}&quot;</strong> is not currently
                active for this product. Would you like to activate it and set
                the quantity to <strong>{pendingActivation.quantity}</strong>?
              </p>
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <button
                  onClick={() => setPendingActivation(null)}
                  style={{
                    padding: "8px 16px",
                    background: "none",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setPendingActivation(null);
                    // Mark location as active in local levels so save proceeds
                    const inventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
                    const updatedLevels = inventoryLevels.map(l =>
                      l.locationId === pendingActivation.locationId
                        ? { ...l, active: true }
                        : l
                    );
                    setLocalInventoryLevels(updatedLevels);
                    // Retry save with activation flag
                    handleSaveWithActivation();
                  }}
                  style={{
                    padding: "8px 16px",
                    background: "#000",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Activate & Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab Bar */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "24px", borderBottom: "2px solid #e0e0e0" }}>
          {["pricing", "inventory"].map((tab) => (
            <button
              key={tab}
              onClick={() => handleTabClick(tab)}
              style={{
                padding: "8px 20px",
                border: "none",
                background: "none",
                cursor: "pointer",
                fontWeight: activeTab === tab ? "bold" : "normal",
                borderBottom: activeTab === tab ? "2px solid #000" : "2px solid transparent",
                marginBottom: "-2px",
                textTransform: "capitalize",
              }}
            >
              {tab === "pricing" ? "Pricing" : "Inventory"}
            </button>
          ))}
        </div>

        {/* Client-side validation errors */}
        {clientError && (
          <div style={{ background: "#fff0f0", border: "1px solid #f00", padding: "10px", borderRadius: "4px", marginBottom: "16px" }}>
            ❌ {clientError}
          </div>
        )}

        {/* Feedback messages — hidden if a newer client error exists */}
        {!clientError && !actionDataDismissed && actionData?.error && (
          <div style={{ background: "#fff0f0", border: "1px solid #f00", padding: "10px", borderRadius: "4px", marginBottom: "16px" }}>
            ❌ {actionData.error}
          </div>
        )}
        {!clientError && !actionDataDismissed && actionData?.success && (
          <div style={{ background: "#f0fff0", border: "1px solid #0a0", padding: "10px", borderRadius: "4px", marginBottom: "16px" }}>
            ✅ {actionData.message}
          </div>
        )}

        {/* ── Tab A: Pricing ── */}
        {activeTab === "pricing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

            <Field label={`Price (${pricing.currency})`} required>
              <input
                type="number" step="0.01" min="0"
                value={formState.pricing.price}
                onChange={(e) => dispatch({ type: "SET_PRICING", field: "price", value: e.target.value })}
                style={inputStyle}
              />
            </Field>

            <Field label="Compare-at Price">
              <input
                type="number" step="0.01" min="0"
                value={formState.pricing.compareAtPrice}
                onChange={(e) => dispatch({ type: "SET_PRICING", field: "compareAtPrice", value: e.target.value })}
                style={inputStyle}
              />
            </Field>

            <Field label="Cost per Item">
              <input
                type="number" step="0.01" min="0"
                value={formState.pricing.costPerItem}
                onChange={(e) => dispatch({ type: "SET_PRICING", field: "costPerItem", value: e.target.value })}
                style={inputStyle}
              />
            </Field>

            <Field label="Currency">
              <input
                type="text"
                value={pricing.currency}
                readOnly
                style={{ ...inputStyle, background: "#f5f5f5", color: "#888", cursor: "not-allowed" }}
              />
            </Field>

            <Field label="Taxable">
              <input
                type="checkbox"
                checked={formState.pricing.taxable}
                onChange={(e) => dispatch({ type: "SET_PRICING", field: "taxable", value: e.target.checked })}
              />
            </Field>

            {formState.pricing.taxable && (
              <Field label="Tax Code">
                <input
                  type="text"
                  value={formState.pricing.taxCode}
                  onChange={(e) => dispatch({ type: "SET_PRICING", field: "taxCode", value: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            )}
          </div>
        )}

        {/* ── Tab B: Inventory — lazy loaded ── */}
        {activeTab === "inventory" && (
          <div>
            {/* Loading state — only show on first load, not after saves */}
            {inventoryFetcher.state === "loading" && !formState.inventory && (
              <p style={{ color: "#888" }}>⏳ Loading inventory data...</p>
            )}

            {/* Error state */}
            {inventoryFetcher.state === "idle" && inventoryLoaded && !formState.inventory && (
              <p style={{ color: "red" }}>❌ Unable to load inventory data right now. Please try again.</p>
            )}

            {/* Inventory form */}
            {formState.inventory && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

                <Field label="Track Quantity">
                  <input
                    type="checkbox"
                    checked={formState.inventory.tracked}
                    onChange={(e) => dispatch({ type: "SET_INVENTORY", field: "tracked", value: e.target.checked })}
                  />
                </Field>

                {formState.inventory.tracked && (
                  <>
                    <Field label="Location" required>
                      <select
                        value={formState.inventory.locationId}
                        onChange={(e) => {
                          const selectedLocationId = e.target.value;
                          const inventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
                          const level = inventoryLevels.find(l => l.locationId === selectedLocationId);

                          // Recalculate total from SAVED inventory levels only (discard unsaved changes)
                          const correctTotal = inventoryLevels.reduce((sum, l) => sum + (l.quantity ?? 0), 0);

                          dispatch({
                            type: "UPDATE_INVENTORY_LOCATION",
                            locationId: selectedLocationId,
                            quantity: level?.quantity ?? 0,
                            totalQuantity: correctTotal,
                          });
                        }}
                        style={inputStyle}
                      >
                        {locations.map((loc) => (
                          <option key={loc.id} value={loc.id}>{loc.name}</option>
                        ))}
                      </select>
                    </Field>

                    <Field
                      label={`Quantity at ${locations.find(l => l.id === formState.inventory.locationId)?.name ?? "this location"}`}
                      required
                    >
                      <input
                        type="number" min="0" step="1"
                        value={formState.inventory.quantity === 0 ? "" : formState.inventory.quantity}
                        onChange={(e) => {
                          const val = e.target.value;
                          const newQty = val === "" ? 0 : parseInt(val, 10) || 0;
                          if (isNaN(newQty)) return;
                          // Use localInventoryLevels if available
                          const inventoryLevels = localInventoryLevels ?? inventoryFetcher.data?.inventoryLevels ?? [];
                          const newTotal = inventoryLevels.reduce((sum, level) => {
                            if (level.locationId === formState.inventory.locationId) {
                              return sum + newQty;
                            }
                            return sum + level.quantity;
                          }, 0);
                          dispatch({
                            type: "UPDATE_QUANTITY_AND_TOTAL",
                            quantity: newQty,
                            totalQuantity: newTotal,
                          });
                        }}
                        style={inputStyle}
                      />
                    </Field>

                    <Field label="Total Stock (all locations)">
                      <input
                        type="text"
                        value={`${formState.inventory.totalQuantity} units`}
                        readOnly
                        style={{ ...inputStyle, background: "#f5f5f5", color: "#888", cursor: "not-allowed" }}
                      />
                    </Field>
                  </>
                )}

                <Field label="Allow Oversell">
                  <input
                    type="checkbox"
                    checked={formState.inventory.overselling}
                    onChange={(e) => dispatch({ type: "SET_INVENTORY", field: "overselling", value: e.target.checked })}
                  />
                </Field>

                <Field label="SKU">
                  <input
                    type="text"
                    value={formState.inventory.sku}
                    onChange={(e) => dispatch({ type: "SET_INVENTORY", field: "sku", value: e.target.value })}
                    style={inputStyle}
                  />
                </Field>

                <Field label="Barcode">
                  <input
                    type="text"
                    value={formState.inventory.barcode}
                    onChange={(e) => dispatch({ type: "SET_INVENTORY", field: "barcode", value: e.target.value })}
                    style={inputStyle}
                  />
                </Field>

              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

// Helper components & styles

function Field({ label, required, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label style={{ fontWeight: "500", fontSize: "14px" }}>
        {label}{required && <span style={{ color: "red" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

Field.propTypes = {
  label: PropTypes.string.isRequired,
  required: PropTypes.bool,
  children: PropTypes.node.isRequired,
};

function normalizePrice(value) {
  if (!value || value === "") return null;
  const num = parseFloat(value);
  return isNaN(num) ? null : num;
}

// Error Boundary 
export function ErrorBoundary() {
  const error = useRouteError();
  const message = error?.message ?? "Something went wrong.";

  return (
    <div style={{
      padding: "48px 24px",
      maxWidth: "480px",
      margin: "0 auto",
      fontFamily: "sans-serif",
      textAlign: "center",
    }}>
      <p style={{ fontSize: "48px", margin: "0 0 16px" }}>⚠️</p>
      <h2 style={{ margin: "0 0 8px", fontSize: "20px", fontWeight: "600" }}>
        Something went wrong
      </h2>
      <p style={{ color: "#666", margin: "0 0 24px", fontSize: "14px" }}>
        {message}
      </p>
      <a href="/app" style={{
        display: "inline-block",
        padding: "10px 24px",
        background: "#000",
        color: "#fff",
        borderRadius: "4px",
        textDecoration: "none",
        fontSize: "14px",
      }}>
        ← Back to Home
      </a>
    </div>
  );
}

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid #ccc",
  borderRadius: "4px",
  fontSize: "14px",
  maxWidth: "320px",
};