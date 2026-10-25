import React from "react";
import { render, screen } from "@testing-library/react";
import {
  DashboardAssetGridSkeleton,
  DashboardHistorySkeleton,
} from "@/components/ui/Skeleton";

describe("dashboard skeletons", () => {
  it("renders asset placeholders shaped like the dashboard cards", () => {
    render(<DashboardAssetGridSkeleton count={4} />);

    expect(screen.getByTestId("dashboard-asset-grid-skeleton")).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("renders history rows that match the dashboard timeline layout", () => {
    render(<DashboardHistorySkeleton rows={3} />);

    expect(screen.getByTestId("dashboard-history-skeleton")).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });
});
