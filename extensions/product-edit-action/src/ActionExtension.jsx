import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect } from "preact/hooks";

// ─── Central config — APP_HANDLE must never be inlined ───────────────────────
//import { APP_HANDLE } from "../../../app/config.js";
import { APP_HANDLE } from "./config.js";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { close, data } = shopify;

  useEffect(() => {
    (async function navigateToEditPage() {
      const productId = data.selected[0].id;

      // Step 1 — Resolve the product handle from the product ID
      const res = await fetch("shopify:admin/api/graphql.json", {
        method: "POST",
        body: JSON.stringify({
          query: `query GetProductHandle($id: ID!) {
            product(id: $id) {
              handle
            }
          }`,
          variables: { id: productId },
        }),
      });

      if (!res.ok) {
        console.error("Failed to fetch product handle");
        close();
        return;
      }

      const { data: gqlData } = await res.json();
      const handle = gqlData?.product?.handle;

      if (!handle) {
        console.error("Product handle not found");
        close();
        return;
      }

      // Step 2 — Navigate to the edit page
      const editUrl = `/admin/apps/${APP_HANDLE}/app/products/${handle}/edit`;
      open(editUrl, "_top");

      // Step 3 — Close the action modal immediately
      close();
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show a brief loading state while navigating
  return (
    <s-admin-action>
      <s-stack direction="block">
        <s-text>Opening product editor…</s-text>
      </s-stack>
    </s-admin-action>
  );
}