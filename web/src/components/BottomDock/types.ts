import React from "react";

export interface DockItemConfig {
  id: string;
  label: string;
  icon: React.ReactNode | ((state: { active: boolean; isDragging: boolean }) => React.ReactNode);
  ariaLabel?: string;
  onClick?: () => void;
}

export interface BottomDockSettings {
  /** Spring stiffness for horizontal movement across tabs (default: 400) */
  springK?: number;
  /** Spring damping for horizontal movement (default: 34) */
  damping?: number;
  /** Inflation multiplier for pill during active movement/flight (default: 1.18) */
  flightBuff?: number;
  /** Maximum optical magnification multiplier for icons under lens (default: 0.22) */
  lensMagnification?: number;
  /** Maximum upward elevation in pixels for icons under lens (default: 3.5) */
  lensLift?: number;
}

export interface BottomDockProps {
  /** Array of dock items to display */
  items: DockItemConfig[];
  /** Controlled active item ID */
  activeId?: string;
  /** Initial active item ID when uncontrolled (defaults to first item) */
  defaultActiveId?: string;
  /** Callback fired when the active tab changes */
  onChange?: (id: string) => void;
  /** Whether to show the search trailing action button (default: false for mobile navbar) */
  showSearch?: boolean;
  /** Custom icon for the search button */
  searchIcon?: React.ReactNode;
  /** Callback fired when the search button is clicked */
  onSearchClick?: () => void;
  /** Accessible label for search button */
  searchAriaLabel?: string;
  /** Optional custom trailing slot replacing or augmenting the search button */
  trailingAction?: React.ReactNode;
  /** Visual and physics customization settings */
  settings?: BottomDockSettings;
  /** Optional additional class name for dock */
  className?: string;
  /** Optional inline styles */
  style?: React.CSSProperties;
}
