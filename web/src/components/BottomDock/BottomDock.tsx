import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { BottomDockProps, DockItemConfig } from "./types";
import "./BottomDock.css";

export const BottomDock: React.FC<BottomDockProps> = ({
  items,
  activeId: controlledActiveId,
  defaultActiveId,
  onChange,
  showSearch = false,
  searchIcon,
  onSearchClick,
  searchAriaLabel = "Search",
  trailingAction,
  settings = {},
  className = "",
  style = {},
}) => {
  const initialId = controlledActiveId ?? defaultActiveId ?? items[0]?.id ?? "";
  const [internalActive, setInternalActive] = useState<string>(initialId);
  const active = controlledActiveId !== undefined ? controlledActiveId : internalActive;

  const [isDragging, setIsDragging] = useState(false);
  const [indicatorWidth, setIndicatorWidth] = useState(60);

  const indicatorRef = useRef<HTMLDivElement>(null);
  const jellySkinRef = useRef<HTMLDivElement>(null);
  const navTrackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const iconRefs = useRef<Record<string, HTMLSpanElement | null>>({});

  const currentActiveRef = useRef<string>(active);
  const isInitializedRef = useRef(false);
  const itemMetricsRef = useRef<Array<{ id: string; x: number; center: number; width: number }>>([]);
  const rafIdRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Merged Settings
  const {
    springK = 420,
    damping = 34,
    lensMagnification = 0.16,
    lensLift = 2.0,
  } = settings;

  const physicsRef = useRef({
    x: 0,
    vx: 0,
    targetX: 0,
    minX: 0,
    maxX: 0,
    width: 60,
    height: 44,
    scaleX: 1,
    vScaleX: 0,
    targetScaleX: 1,
    scaleY: 1,
    skewX: 0,
    vSkewX: 0,
    targetSkewX: 0,
    buff: 1,
    vBuff: 0,
    targetBuff: 1,
    stretchDir: 0,
    springK,
    damping,
  });

  const dragRef = useRef({
    active: false,
    hasMoved: false,
    pointerId: -1,
    startPointerX: 0,
    startPointerY: 0,
    currentPointerX: 0,
    currentPointerY: 0,
    startIndicatorX: 0,
  });

  const stepPhysicsRef = useRef<(time: number) => void>(() => {});
  const handleWindowPointerMoveRef = useRef<(e: PointerEvent) => void>(() => {});
  const handleWindowPointerUpRef = useRef<(e: PointerEvent) => void>(() => {});

  const removeWindowListeners = useCallback(() => {
    window.removeEventListener("pointermove", handleWindowPointerMoveRef.current);
    window.removeEventListener("pointerup", handleWindowPointerUpRef.current);
    window.removeEventListener("pointercancel", handleWindowPointerUpRef.current);
  }, []);

  const setPillActiveState = useCallback((isActive: boolean) => {
    if (indicatorRef.current) {
      if (isActive) {
        indicatorRef.current.classList.add("isGlass");
      } else {
        indicatorRef.current.classList.remove("isGlass");
      }
    }
  }, []);

  // Pre-calculate tab dimensions and snap points (seamlessly centered on each tab)
  const measureMetrics = useCallback(() => {
    const trackEl = navTrackRef.current;
    if (!trackEl || items.length === 0) return;
    const trackRect = trackEl.getBoundingClientRect();
    if (trackRect.width === 0) return;

    const trackH = trackRect.height;
    const indicatorH = Math.max(30, Math.round(trackH - 6));

    const metrics = items.map((item) => {
      const btn = itemRefs.current[item.id];
      if (!btn) return { id: item.id, x: 0, center: 0, width: 60 };
      const left = btn.offsetLeft;
      const width = btn.offsetWidth;
      const center = left + width / 2;
      const w = Math.max(28, width);
      const x = left;
      return { id: item.id, x, center, width: w };
    });

    itemMetricsRef.current = metrics;

    const first = metrics[0];
    const last = metrics[metrics.length - 1];
    if (first && last) {
      physicsRef.current.minX = first.x;
      physicsRef.current.maxX = last.x;
    }

    const currentMetric = metrics.find((m) => m.id === currentActiveRef.current) || metrics[0];
    if (currentMetric) {
      physicsRef.current.width = currentMetric.width;
      physicsRef.current.height = indicatorH;
      setIndicatorWidth(currentMetric.width);
      if (indicatorRef.current) {
        indicatorRef.current.style.width = `${currentMetric.width}px`;
      }
    }
  }, [items]);

  // 120 FPS Physics Engine: Spring Position & Non-linear Jelly Strain Simulation
  const stepPhysics = useCallback((time: number) => {
    if (!lastTimeRef.current) lastTimeRef.current = time;
    let dt = (time - lastTimeRef.current) / 1000;
    lastTimeRef.current = time;
    dt = Math.max(0.001, Math.min(dt, 0.032));

    const p = physicsRef.current;
    const d = dragRef.current;
    const isDraggingMovement = d.active && d.hasMoved;
    const isDraggingActive = d.active;

    let overdrag = 0;

    if (isDraggingMovement) {
      const deltaX = d.currentPointerX - d.startPointerX;
      const rawX = d.startIndicatorX + deltaX;

      // Rubber-band resistance at track boundaries
      if (rawX < p.minX) {
        overdrag = rawX - p.minX;
        p.targetX = p.minX + Math.sign(overdrag) * Math.pow(Math.abs(overdrag), 0.72) * 0.45;
      } else if (rawX > p.maxX) {
        overdrag = rawX - p.maxX;
        p.targetX = p.maxX + Math.sign(overdrag) * Math.pow(Math.abs(overdrag), 0.72) * 0.45;
      } else {
        p.targetX = rawX;
      }
    }

    // Position spring
    const activeSpringK = isDraggingMovement ? 600 : (p.springK || springK);
    const activeDamping = isDraggingMovement ? 42 : (p.damping || damping);
    const forceX = -activeSpringK * (p.x - p.targetX) - activeDamping * p.vx;
    p.vx += forceX * dt;
    p.x += p.vx * dt;

    // Jelly Stretch, Squash & Skew
    if (isDraggingMovement) {
      const strain = p.targetX - p.x;
      const pullSpeed = p.vx;
      const overdragTension = Math.abs(overdrag) * 0.008;
      const velocityStrain = Math.abs(pullSpeed) * 0.0002;

      const stretchDemand = 1.0 + Math.abs(strain) * 0.005 + overdragTension + velocityStrain;
      p.targetScaleX = Math.min(1.16, Math.max(0.93, stretchDemand));
      p.targetSkewX = Math.max(-3.5, Math.min(3.5, -(strain * 0.07 + pullSpeed * 0.002)));

      const kJelly = 30;
      const dJelly = 3.2;
      const forceJelly = -kJelly * (p.scaleX - p.targetScaleX) - dJelly * p.vScaleX;
      p.vScaleX += forceJelly * dt;
      p.scaleX += p.vScaleX * dt;

      p.scaleX = Math.max(0.88, Math.min(1.20, p.scaleX));
      p.scaleY = 1 / Math.pow(p.scaleX, 0.75);

      const kSkew = 30;
      const dSkew = 5.0;
      const forceSkew = -kSkew * (p.skewX - p.targetSkewX) - dSkew * p.vSkewX;
      p.vSkewX += forceSkew * dt;
      p.skewX += p.vSkewX * dt;
    } else {
      p.targetScaleX = 1.0;
      p.targetSkewX = 0;

      // Settle spring
      if (Math.abs(p.scaleX - 1.0) > 0.002 || Math.abs(p.vScaleX) > 0.01) {
        const kJelly = 110;
        const dJelly = 18;
        const forceJelly = -kJelly * (p.scaleX - 1.0) - dJelly * p.vScaleX;
        p.vScaleX += forceJelly * dt;
        p.scaleX += p.vScaleX * dt;
        p.scaleX = Math.max(0.92, Math.min(1.10, p.scaleX));
        p.scaleY = 1 / Math.pow(Math.max(0.5, p.scaleX), 0.75);
      } else {
        p.scaleX = 1.0;
        p.scaleY = 1.0;
        p.vScaleX = 0;
      }

      if (Math.abs(p.skewX) > 0.02 || Math.abs(p.vSkewX) > 0.01) {
        const kSkew = 70;
        const dSkew = 12.0;
        const forceSkew = -kSkew * p.skewX - dSkew * p.vSkewX;
        p.vSkewX += forceSkew * dt;
        p.skewX += p.vSkewX * dt;
      } else {
        p.skewX = 0;
        p.vSkewX = 0;
      }
    }

    // Buff inflation spring
    const targetBuff = isDraggingActive ? 1.48 : 1.0;
    const kBuff = isDraggingActive ? 140 : 160;
    const dBuff = isDraggingActive ? 16 : 24;
    const forceBuff = -kBuff * (p.buff - targetBuff) - dBuff * p.vBuff;
    p.vBuff += forceBuff * dt;
    p.buff += p.vBuff * dt;
    p.buff = Math.max(0.92, Math.min(1.75, p.buff));

    // Direction of stretch
    if (isDraggingMovement) {
      const strain = p.targetX - p.x;
      const targetDir = Math.abs(strain) > 1.0 ? Math.sign(strain) : (p.stretchDir || 1);
      p.stretchDir += (targetDir - p.stretchDir) * Math.min(1, dt * 20);
    } else {
      p.stretchDir += (0 - p.stretchDir) * Math.min(1, dt * 12);
    }

    // Direct GPU DOM mutation (preserve horizontal physics, lock vertical containment)
    const renderScaleX = p.scaleX;
    const renderScaleY = 1.0;

    const stretchExpansion = Math.max(0, p.scaleX - 1.0) * p.width;
    const stretchOffset = p.stretchDir * (stretchExpansion * 0.5);
    const renderX = p.x + stretchOffset;

    if (indicatorRef.current) {
      indicatorRef.current.style.transform = `translate3d(${renderX}px, 0, 0)`;
    }
    if (jellySkinRef.current) {
      jellySkinRef.current.style.transform = `scale(${renderScaleX}, ${renderScaleY}) skewX(${p.skewX}deg)`;
    }

    // Optical lens reaction activity factor
    const lensActivity = isDraggingActive
      ? 1.0
      : Math.min(1.0, Math.max(0, (p.buff - 1.0) / 0.20 + Math.abs(p.vx) / 60));

    // Real-time Optical Lens Reaction on Icons (calibrated for 5 tabs)
    const indicatorCenter = renderX + p.width / 2;
    const stepDist = itemMetricsRef.current.length > 1
      ? Math.abs(itemMetricsRef.current[1].center - itemMetricsRef.current[0].center)
      : (p.width || 60);
    const lensRadius = stepDist * 0.86;

    for (const m of itemMetricsRef.current) {
      const iconEl = iconRefs.current[m.id];
      if (!iconEl) continue;

      const dist = Math.abs(indicatorCenter - m.center);
      const proximity = Math.max(0, 1 - dist / lensRadius);
      const smooth = 0.5 * (1 - Math.cos(Math.PI * proximity)) * lensActivity;

      const iconScale = 1.0 + smooth * lensMagnification;
      const iconTranslateY = -smooth * lensLift;
      const glowAlpha = smooth * 0.45;

      iconEl.style.transform = `scale(${iconScale}) translateY(${iconTranslateY}px)`;
      iconEl.style.filter = smooth > 0.04
        ? `drop-shadow(0 2px 6px rgba(255, 255, 255, ${glowAlpha}))`
        : "none";
    }

    // Active item live highlight during drag
    if (isDraggingMovement) {
      let closestId = currentActiveRef.current;
      let minDistance = Infinity;

      for (const m of itemMetricsRef.current) {
        const dist = Math.abs(indicatorCenter - m.center);
        if (dist < minDistance) {
          minDistance = dist;
          closestId = m.id;
        }
      }

      if (closestId !== currentActiveRef.current) {
        const prevBtn = itemRefs.current[currentActiveRef.current];
        const nextBtn = itemRefs.current[closestId];
        if (prevBtn) prevBtn.classList.remove("active");
        if (nextBtn) nextBtn.classList.add("active");
        currentActiveRef.current = closestId;
      }
    }

    // Transition when settled near target
    if (!isDraggingActive && Math.abs(p.x - p.targetX) < 1.5 && Math.abs(p.vx) < 18) {
      setPillActiveState(false);
    }

    // Settle condition
    const isPosSettled = Math.abs(p.x - p.targetX) < 0.6 && Math.abs(p.vx) < 1.2;
    const isJellySettled =
      Math.abs(p.scaleX - 1.0) < 0.015 &&
      Math.abs(p.vScaleX) < 0.08 &&
      Math.abs(p.skewX) < 0.3;
    const isBuffSettled = Math.abs(p.buff - 1.0) < 0.025 && Math.abs(p.vBuff) < 0.15;

    const isSettled = !isDraggingActive && isPosSettled && isJellySettled && isBuffSettled;

    if (!isSettled) {
      rafIdRef.current = requestAnimationFrame((t) => stepPhysicsRef.current(t));
    } else {
      p.x = p.targetX;
      p.vx = 0;
      p.scaleX = 1;
      p.scaleY = 1;
      p.vScaleX = 0;
      p.skewX = 0;
      p.vSkewX = 0;
      p.buff = 1;
      p.vBuff = 0;
      p.stretchDir = 0;
      if (indicatorRef.current) {
        indicatorRef.current.style.transform = `translate3d(${p.targetX}px, 0, 0)`;
        indicatorRef.current.style.width = `${p.width}px`;
      }
      if (jellySkinRef.current) {
        jellySkinRef.current.style.transform = `scale(1, 1) skewX(0deg)`;
      }
      for (const m of itemMetricsRef.current) {
        const iconEl = iconRefs.current[m.id];
        if (iconEl) {
          iconEl.style.transform = "";
          iconEl.style.filter = "none";
        }
      }
      rafIdRef.current = null;
      if (!dragRef.current.active) {
        setPillActiveState(false);
      }
    }
  }, [damping, lensLift, lensMagnification, setPillActiveState, springK]);

  useEffect(() => {
    stepPhysicsRef.current = stepPhysics;
  }, [stepPhysics]);

  const startPhysics = useCallback(() => {
    if (rafIdRef.current === null) {
      lastTimeRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame((t) => stepPhysicsRef.current(t));
    }
  }, []);

  const snapToTarget = useCallback(
    (targetId: string, withImpulse = true) => {
      const btn = itemRefs.current[targetId];
      let targetX: number;
      let targetW: number;

      if (btn && btn.offsetWidth > 0) {
        const left = btn.offsetLeft;
        const width = btn.offsetWidth;
        targetW = Math.max(28, width);
        targetX = left;
      } else {
        const metric = itemMetricsRef.current.find((m) => m.id === targetId);
        if (!metric) return;
        targetX = metric.x;
        targetW = metric.width;
      }

      const oldX = physicsRef.current.x;
      const dist = targetX - oldX;
      const hopDistance = Math.abs(dist);

      physicsRef.current.targetX = targetX;
      physicsRef.current.width = targetW;
      if (indicatorRef.current) {
        indicatorRef.current.style.width = `${targetW}px`;
      }

      const stepDist = targetW || 60;
      const normalizedDist = Math.min(1, Math.max(0, (hopDistance - stepDist * 0.4) / (stepDist * 3)));
      physicsRef.current.springK = (springK || 420) - normalizedDist * 75;
      physicsRef.current.damping = (damping || 34) - normalizedDist * 4;

      if (withImpulse && hopDistance > 4) {
        setPillActiveState(true);
        physicsRef.current.buff = 1.0;
        physicsRef.current.vBuff = 0;

        physicsRef.current.scaleX = 1.0;
        physicsRef.current.scaleY = 1.0;
        physicsRef.current.vScaleX = Math.min(0.28, 0.12 + hopDistance * 0.0006);
        physicsRef.current.skewX = 0;
        physicsRef.current.vSkewX = 0;
        physicsRef.current.targetScaleX = 1.0;
        physicsRef.current.targetSkewX = 0;
        physicsRef.current.stretchDir = 0;
      }

      startPhysics();
    },
    [damping, setPillActiveState, springK, startPhysics]
  );

  const handleWindowPointerMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current.active) return;
    dragRef.current.currentPointerX = e.clientX;
    dragRef.current.currentPointerY = e.clientY;

    const dx = e.clientX - dragRef.current.startPointerX;
    if (!dragRef.current.hasMoved && Math.abs(dx) > 4) {
      dragRef.current.hasMoved = true;
      setIsDragging(true);
      setPillActiveState(true);
      physicsRef.current.vBuff = 3.5;
      startPhysics();
    }
  }, [setPillActiveState, startPhysics]);

  const handleWindowPointerUp = useCallback(() => {
    removeWindowListeners();

    if (!dragRef.current.active) return;
    const hadMoved = dragRef.current.hasMoved;
    dragRef.current.active = false;
    setIsDragging(false);

    if (hadMoved) {
      snapToTarget(currentActiveRef.current, true);
      if (controlledActiveId === undefined) {
        setInternalActive(currentActiveRef.current);
      }
      onChange?.(currentActiveRef.current);
    } else {
      if (rafIdRef.current === null) {
        setPillActiveState(false);
      }
    }
  }, [controlledActiveId, onChange, removeWindowListeners, setPillActiveState, snapToTarget]);

  useEffect(() => {
    handleWindowPointerMoveRef.current = handleWindowPointerMove;
    handleWindowPointerUpRef.current = handleWindowPointerUp;
  }, [handleWindowPointerMove, handleWindowPointerUp]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    measureMetrics();

    dragRef.current = {
      active: true,
      hasMoved: false,
      pointerId: e.pointerId,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      currentPointerX: e.clientX,
      currentPointerY: e.clientY,
      startIndicatorX: physicsRef.current.x,
    };

    setPillActiveState(true);

    window.addEventListener("pointermove", handleWindowPointerMoveRef.current);
    window.addEventListener("pointerup", handleWindowPointerUpRef.current);
    window.addEventListener("pointercancel", handleWindowPointerUpRef.current);
  };

  const handleItemClick = useCallback(
    (item: DockItemConfig) => {
      if (dragRef.current.hasMoved) return;
      item.onClick?.();

      if (item.id === currentActiveRef.current) {
        if (rafIdRef.current === null) {
          setPillActiveState(false);
        }
        return;
      }

      const oldBtn = itemRefs.current[currentActiveRef.current];
      const newBtn = itemRefs.current[item.id];
      if (oldBtn) oldBtn.classList.remove("active");
      if (newBtn) newBtn.classList.add("active");

      currentActiveRef.current = item.id;
      if (controlledActiveId === undefined) {
        setInternalActive(item.id);
      }
      onChange?.(item.id);

      setPillActiveState(true);
      snapToTarget(item.id, true);
    },
    [controlledActiveId, onChange, setPillActiveState, snapToTarget]
  );

  useEffect(() => {
    currentActiveRef.current = active;
  }, [active]);

  useEffect(() => {
    measureMetrics();
    const metric = itemMetricsRef.current.find((m) => m.id === active);
    if (metric && navTrackRef.current) {
      if (!isInitializedRef.current) {
        isInitializedRef.current = true;
        physicsRef.current.x = metric.x;
        physicsRef.current.targetX = metric.x;
        physicsRef.current.width = metric.width;
        if (indicatorRef.current) {
          indicatorRef.current.style.transform = `translate3d(${metric.x}px, 0, 0)`;
          indicatorRef.current.style.width = `${metric.width}px`;
        }
      } else {
        snapToTarget(active, false);
      }
    }
  }, [active, measureMetrics, snapToTarget]);

  useEffect(() => {
    const trackEl = navTrackRef.current;
    if (!trackEl) return;
    const handleResize = () => {
      measureMetrics();
      if (!isInitializedRef.current) {
        const metric = itemMetricsRef.current.find((m) => m.id === currentActiveRef.current);
        if (metric && metric.width > 0) {
          isInitializedRef.current = true;
          physicsRef.current.x = metric.x;
          physicsRef.current.targetX = metric.x;
          physicsRef.current.width = metric.width;
          if (indicatorRef.current) {
            indicatorRef.current.style.transform = `translate3d(${metric.x}px, 0, 0)`;
            indicatorRef.current.style.width = `${metric.width}px`;
          }
        }
      } else {
        snapToTarget(currentActiveRef.current, false);
      }
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(trackEl);
    window.addEventListener("resize", handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [measureMetrics, snapToTarget]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      removeWindowListeners();
    };
  }, [removeWindowListeners]);

  const hasTrailing = Boolean(trailingAction || showSearch);

  return (
    <nav className={`bottomDockRoot ${className}`} style={style} aria-label="Bottom dock navigation">
      <div className="bottomDockNavRow">
        <div className={`bottomDockPillWrapper ${!hasTrailing ? "fullWidth" : ""}`}>
          {/* Base Pill Surface without WebGL glass */}
          <div className="bottomDockBasePill" />

          <div
            ref={navTrackRef}
            className="bottomDockNavTrack"
            onPointerDown={handlePointerDown}
          >
            {/* Draggable Active Pill Indicator with Physics Jelly Deformation */}
            <div
              ref={indicatorRef}
              className={`bottomDockIndicator ${isDragging ? "isDragging" : ""}`}
              style={{
                width: `${indicatorWidth}px`,
              }}
            >
              <div ref={jellySkinRef} className="bottomDockJellySkin">
                <div className="bottomDockFlatSkin" />
                <div className="bottomDockMovingSkin" />
              </div>
            </div>

            {items.map((item) => {
              const isActive = active === item.id;
              const iconNode = typeof item.icon === "function"
                ? item.icon({ active: isActive, isDragging })
                : item.icon;

              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[item.id] = el;
                  }}
                  className={`bottomDockItem ${isActive ? "active" : ""}`}
                  onClick={() => handleItemClick(item)}
                  type="button"
                  aria-label={item.ariaLabel || item.label}
                  aria-current={isActive ? "page" : undefined}
                >
                  <span
                    ref={(el) => {
                      iconRefs.current[item.id] = el;
                    }}
                    className="bottomDockItemIcon"
                  >
                    {iconNode}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Trailing action slot or search button (if enabled) */}
        {trailingAction ? (
          trailingAction
        ) : showSearch ? (
          <div className="bottomDockSearchSurface">
            <button
              className="bottomDockSearchBtn"
              type="button"
              onClick={onSearchClick}
              aria-label={searchAriaLabel}
            >
              {searchIcon || (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              )}
            </button>
          </div>
        ) : null}
      </div>
    </nav>
  );
};

export default BottomDock;
