import { authenticate } from "../shopify.server";

export async function loader({ request, params }) {
  let admin;
  try {
    const auth = await authenticate.admin(request);
    admin = auth.admin;
  } catch (e) {
    throw new Error("Unable to load inventory data right now. Please try again.");
  }

  if (!params.handle) {
    throw new Error("Handle is required to load product");
  }

  // Get product variant and inventory item
  const productRes = await admin.graphql(`
    query getInventoryData($handle: String!) {
      products(first: 1, query: $handle) {
        edges {
          node {
            id
            variants(first: 1) {
              edges {
                node {
                  id
                  sku
                  barcode
                  inventoryPolicy
                  inventoryItem {
                    id
                    tracked
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { handle: `handle:${params.handle}` } });

  const productData = await productRes.json();
  const variant = productData?.data?.products?.edges[0]?.node?.variants?.edges[0]?.node;

  if (!variant) {
    throw new Error("Product not found");
  }

  const inventoryItemId = variant.inventoryItem.id;

  // Get inventory levels for ALL locations
  const inventoryRes = await admin.graphql(`
    query getInventoryLevels($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        tracked
        inventoryLevels(first: 10) {
          edges {
            node {
              id
              quantities(names: ["available"]) {
                name
                quantity
              }
              location {
                id
                name
              }
            }
          }
        }
      }
    }
  `, { variables: { inventoryItemId } });

  const inventoryData = await inventoryRes.json();
  const inventoryItem = inventoryData?.data?.inventoryItem;

  // Get all shop locations for dropdown
  const locationsRes = await admin.graphql(`
    query getLocations {
      locations(first: 10) {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  `);

  const locationsData = await locationsRes.json();
  const locations = locationsData?.data?.locations?.edges?.map(e => e.node) ?? [];

  // Build per-location quantity map
  // Track which locations are ACTIVE for this product
  const inventoryLevelMap = {};
  const activeLevelLocationIds = new Set();

  inventoryItem?.inventoryLevels?.edges?.forEach(e => {
    const locationId = e.node.location.id;
    inventoryLevelMap[locationId] = e.node.quantities?.[0]?.quantity ?? 0;
    // Mark this location as active for this product
    activeLevelLocationIds.add(locationId);
  });

  const inventoryLevels = locations.map(loc => ({
    locationId: loc.id,
    locationName: loc.name,
    quantity: inventoryLevelMap[loc.id] ?? 0,
    active: activeLevelLocationIds.has(loc.id),
  }));

  // Compute aggregated total across all locations
  const totalQuantity = inventoryLevels.reduce((sum, level) => sum + level.quantity, 0);

  // First location as default selected
  const firstLevel = inventoryLevels[0];

  return {
    inventory: {
      inventoryItemId,
      variantId: variant.id,
      tracked: inventoryItem?.tracked ?? false,
      overselling: variant.inventoryPolicy === "CONTINUE",
      sku: variant.sku ?? "",
      barcode: variant.barcode ?? "",
      // Default to first location
      locationId: firstLevel?.locationId ?? "",
      quantity: firstLevel?.quantity ?? 0,
      totalQuantity,
    },
    // All per-location quantities for switching
    inventoryLevels,
    locations,
  };
}

export function shouldRevalidate({ formAction, defaultShouldRevalidate }) {
  // Don't revalidate inventory fetcher just because the edit action ran
  if (formAction && formAction.includes("/edit")) {
    return false;
  }
  return defaultShouldRevalidate;
}