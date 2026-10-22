"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { WarehouseHistoryClient } from "./warehouse-history-client";
import { WarehouseIncomingClient } from "./warehouse-incoming-client";
import "./warehouse-management.css";

const tabs = [
  { id: "outgoing", label: "Xuất kho", description: "Lập phiếu xuất thủ công và nhập phiếu xuất từ Excel." },
  { id: "incoming", label: "Nhập kho", description: "Nhập hàng thủ công và quản lý các điều chỉnh tồn kho." },
  { id: "reconciliation", label: "Đối soát", description: "Đối chiếu tồn kho hệ thống với dữ liệu từ ERP." },
  { id: "receipt", label: "Receipt", description: "Tra cứu phiếu nhập kho." },
] as const;

type WarehouseTab = typeof tabs[number]["id"];

export function WarehouseManagementClient() {
  const [activeTab, setActiveTab] = useState<WarehouseTab>("outgoing");
  const [receiptOpened, setReceiptOpened] = useState(false);
  const id = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectTab(tab: WarehouseTab) {
    setActiveTab(tab);
    if (tab === "receipt") setReceiptOpened(true);
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight": nextIndex = (index + 1) % tabs.length; break;
      case "ArrowLeft": nextIndex = (index - 1 + tabs.length) % tabs.length; break;
      case "Home": nextIndex = 0; break;
      case "End": nextIndex = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectTab(tabs[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <section className="warehouse-management">
      <header className="warehouse-management-heading">
        <h1>Quản lý kho</h1>
        <p className="muted">Xuất kho, nhập kho, đối soát tồn kho và tra cứu receipt.</p>
      </header>

      <div aria-label="Quản lý kho" className="warehouse-management-tabs" role="tablist">
        {tabs.map((tab, index) => (
          <button
            aria-controls={`${id}-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            className="warehouse-management-tab"
            id={`${id}-tab-${tab.id}`}
            key={tab.id}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            ref={(element) => { tabRefs.current[index] = element; }}
            role="tab"
            tabIndex={activeTab === tab.id ? 0 : -1}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {tabs.map((tab) => (
        <div
          aria-labelledby={`${id}-tab-${tab.id}`}
          className="warehouse-management-panel"
          hidden={activeTab !== tab.id}
          id={`${id}-panel-${tab.id}`}
          key={tab.id}
          role="tabpanel"
          tabIndex={0}
        >
          {tab.id === "incoming" ? <WarehouseIncomingClient /> : tab.id === "receipt" ? (
            receiptOpened ? <WarehouseHistoryClient /> : null
          ) : (
            <section className="warehouse-management-placeholder">
              <span className="warehouse-management-status">Sắp triển khai</span>
              <h2>{tab.label}</h2>
              <p className="muted">{tab.description}</p>
            </section>
          )}
        </div>
      ))}
    </section>
  );
}
