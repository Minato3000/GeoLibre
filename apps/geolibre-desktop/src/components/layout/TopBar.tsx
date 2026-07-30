import { Button } from "@geoint/ui";
import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TopBarProps {
  /** Whether the SideRail below this bar is collapsed to icon-only. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * Thin horizontal strip across the full window width, holding only the
 * hamburger/collapse toggle for the vertical `SideRail` beneath it. Split out
 * so the toggle sits in an actual top bar rather than at the top of the rail
 * itself (the rail's own menus stay exactly as they were, just minus their
 * former header row).
 */
export function TopBar({ collapsed, onToggleCollapsed }: TopBarProps) {
  const { t } = useTranslation();
  return (
    <header
      aria-label={t("shell.section.topBar")}
      className="flex h-9 w-full shrink-0 items-center border-b bg-card px-1"
    >
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        // Not run through t() yet, matching the rest of this session's new UI text.
        title={collapsed ? "Open menu" : "Close menu"}
        aria-label={collapsed ? "Open menu" : "Close menu"}
        aria-expanded={!collapsed}
        onClick={onToggleCollapsed}
      >
        {collapsed ? <Menu className="h-4 w-4" /> : <X className="h-4 w-4" />}
      </Button>
    </header>
  );
}
