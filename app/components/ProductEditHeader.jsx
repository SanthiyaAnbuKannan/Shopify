import PropTypes from "prop-types";

export default function ProductEditHeader({
  productTitle,
  handle,
  isDirty,
  isSaving,
  onSave,
  onDiscard,
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 24px",
      borderBottom: "1px solid #e0e0e0",
      background: "#fff",
      position: "sticky",
      top: 0,
      zIndex: 10,
    }}>
      
      {/* Product info */}
      <div>
        <h1 style={{ margin: 0, fontSize: "18px", fontWeight: "600" }}>
          {productTitle}
        </h1>
        <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#888" }}>
          Handle: {handle}
        </p>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        {/* Dirty indicator */}
        {isDirty && (
          <span style={{ fontSize: "12px", color: "#f90", marginRight: "8px" }}>
            ● Unsaved changes
          </span>
        )}

        {/* Discard button */}
        <button
          onClick={onDiscard}
          disabled={!isDirty || isSaving}
          style={{
            padding: "8px 16px",
            background: "none",
            border: "1px solid #ccc",
            borderRadius: "4px",
            cursor: isDirty && !isSaving ? "pointer" : "not-allowed",
            fontSize: "14px",
            color: isDirty ? "#000" : "#aaa",
          }}
        >
          Discard
        </button>

        {/* Save button */}
        <button
          onClick={onSave}
          disabled={!isDirty || isSaving}
          style={{
            padding: "8px 16px",
            background: isDirty && !isSaving ? "#000" : "#888",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            cursor: isDirty && !isSaving ? "pointer" : "not-allowed",
            fontSize: "14px",
          }}
        >
          {isSaving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

ProductEditHeader.propTypes = {
  productTitle: PropTypes.string.isRequired,
  handle: PropTypes.string.isRequired,
  isDirty: PropTypes.bool.isRequired,
  isSaving: PropTypes.bool.isRequired,
  onSave: PropTypes.func.isRequired,
  onDiscard: PropTypes.func.isRequired,
};